/**
 * 空闲整理（改进点 8）：聊天停下来一阵子、且攒了几轮新发言时，把这段新对话提取成记忆碎片。
 *
 * 交班只在上下文用到阈值时才发生，短对话可能一辈子都等不到交班，聊过的事就留不下来。
 * 空闲整理补上这一块：不归档、不换会话、不发 QQ 消息，只往记忆层里写。
 *
 * 触发条件（全部满足才跑）：
 *   - 距离最后一次 QQ 入站和最后一次 turn/end 都超过 idleMinutes；
 *   - 上次整理之后至少新增 idleMinTurns 条用户发言；
 *   - 会话不忙（assessSessionWork）、不在交班中。
 * 全插件同一时间只跑一个整理调用。
 *
 * 水位线存在绑定记录里：`lastExtract = { sessionId, seq, at }`。交班读同一条水位线，
 * 在提示词里标出“线以上已经整理过”，同一段对话不会被提取两次。换了会话（交班之后）水位线自然失效。
 */
import { assessSessionWork } from './pending.js'
import { findHandoffMisses, MAX_PASSES } from './handoff-miss.js'

const ACTOR = 'qq:idle'
const MISS_ACTOR = 'qq:handoff-miss'

export class IdleConsolidator {
  /**
   * @param {object} opts
   * @param {any} opts.ctx
   * @param {ReturnType<import('../qq/config.js').resolveConfig>} opts.config
   * @param {any} opts.log
   * @param {import('./state.js').StateStore} opts.state
   * @param {import('./handoff.js').ConversationHandoff} opts.handoff
   * @param {import('./chat-memory.js').ChatMemory} opts.memory
   * @param {{approvalsFor?: (id:string) => any}} [opts.relay]
   * @param {() => number} [opts.now]
   */
  constructor({ ctx, config, log, state, handoff, memory, relay = null, signals = null, now = () => Date.now() }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.state = state
    this.handoff = handoff
    this.memory = memory
    this.relay = relay
    this.signals = signals
    this.now = now
    /** @type {Map<string, {lastInboundAt:number, lastTurnEndAt:number, pending:number}>} chatScope → 活动 */
    this.activity = new Map()
    this.running = null
    this.stats = { runs: 0, extracted: 0, skippedBusy: 0, skippedFrozen: 0, skippedFew: 0, handoffMisses: 0, failures: 0, lastAt: 0, lastScope: '', lastError: null }
  }

  get enabled() {
    return Number(this.config.conversation.idleMinutes) > 0
  }

  #touch(scope) {
    let a = this.activity.get(scope)
    if (!a) {
      a = { lastInboundAt: 0, lastTurnEndAt: 0, pending: 0 }
      this.activity.set(scope, a)
    }
    return a
  }

  /** 一条用户消息投进了这台会话（Bridge.promptSession 成功后回调） */
  noteUserPrompt(sessionId) {
    const chat = this.state.findBySession(String(sessionId ?? ''))
    if (!chat || chat.kind !== 'root') return
    const a = this.#touch(`${chat.chatType}:${chat.chatId}`)
    a.lastInboundAt = this.now()
    a.pending += 1
  }

  /** 常驻会话的一个回合结束了 */
  noteTurnEnd(sessionId) {
    const chat = this.state.findBySession(String(sessionId ?? ''))
    if (!chat || chat.kind !== 'root') return
    this.#touch(`${chat.chatType}:${chat.chatId}`).lastTurnEndAt = this.now()
  }

  /** 现在满足条件、该整理的会话（按空闲最久的排前面） */
  due() {
    if (!this.enabled) return []
    const idleMs = Number(this.config.conversation.idleMinutes) * 60_000
    const minTurns = Math.max(1, Number(this.config.conversation.idleMinTurns) || 1)
    const now = this.now()
    const out = []
    for (const [scope, a] of this.activity) {
      if (a.pending < minTurns) continue
      const last = Math.max(a.lastInboundAt, a.lastTurnEndAt)
      if (now - last < idleMs) continue
      out.push({ scope, idleFor: now - last })
    }
    return out.sort((x, y) => y.idleFor - x.idleFor).map((x) => x.scope)
  }

  /** 定时器调用：一次最多整理一个会话；上一个还没跑完就跳过。 */
  tick() {
    if (this.running) return this.running
    const [scope] = this.due()
    if (!scope) return null
    this.running = this.runOnce(scope).finally(() => {
      this.running = null
    })
    return this.running
  }

  /**
   * 整理一个会话。返回 { ok, reason?, added?, seq? }，测试和状态端点用。
   * 跳过时不清 pending：下次条件仍满足就再试。
   */
  async runOnce(scope) {
    const [chatType, ...rest] = String(scope).split(':')
    const chatId = rest.join(':')
    const a = this.#touch(scope)
    const record = this.state.get(chatType, chatId)
    const sessionId = String(record?.rootSessionId ?? '')
    if (!sessionId) return { ok: false, reason: 'no-session' }
    if (this.handoff?.isFrozen?.(chatType, chatId)) {
      this.stats.skippedFrozen += 1
      return { ok: false, reason: 'handoff-in-progress' }
    }
    const view = await assessSessionWork({ ctx: this.ctx, log: this.log }, sessionId, {
      approvals: this.relay?.approvalsFor?.(sessionId),
    })
    if (view.busy) {
      this.stats.skippedBusy += 1
      return { ok: false, reason: `busy:${view.reason}` }
    }

    this.stats.runs += 1
    this.stats.lastAt = this.now()
    this.stats.lastScope = scope
    try {
      const events = await this.handoff.readHistory(sessionId)
      const mark = record.lastExtract
      const sinceSeq = mark && mark.sessionId === sessionId ? Number(mark.seq) || 0 : 0
      const seqOf = (e, i) => Number(e?.seq) || i + 1
      const fresh = events.filter((e, i) => seqOf(e, i) > sinceSeq)
      const userTurns = fresh.filter((e) => e?.type === 'user/message').length
      const minTurns = Math.max(1, Number(this.config.conversation.idleMinTurns) || 1)
      if (userTurns < minTurns) {
        this.stats.skippedFew += 1
        a.pending = userTurns
        return { ok: false, reason: 'too-few-turns', userTurns }
      }
      const topSeq = events.reduce((m, e, i) => Math.max(m, seqOf(e, i)), sinceSeq)
      const out = await this.handoff.extractFragments({ sessionId, scope, events, sinceSeq })
      if (!out) {
        this.stats.failures += 1
        this.stats.lastError = '没有可用模型或整理输出无法解析'
        return { ok: false, reason: 'extract-failed' }
      }
      const absorbed = this.memory.absorb({
        scope,
        gen: Number(record.rootGeneration) || 1,
        sessionId,
        fragments: out.fragments,
        drop: out.drop,
        agingEveryGens: this.config.conversation.agingEveryGens,
        maxFragments: this.config.conversation.maxFragmentsPerChat,
        aging: false,
        actor: ACTOR,
      })
      const misses = this.#reviewHandoff({ scope, record, sessionId, fresh })
      // 重新取一次记录再写：整理期间别的路径可能改过这条绑定
      const latest = this.state.get(chatType, chatId)
      if (latest && latest.rootSessionId === sessionId) {
        latest.lastExtract = { sessionId, seq: topSeq, at: this.now() }
        this.state.set(chatType, chatId, latest)
      }
      if (misses > 0) this.log.info(`[idle] ${scope} 交班回看：补上 ${misses} 条交班漏掉的事`)
      a.pending = 0
      this.stats.extracted += absorbed.added
      this.stats.lastError = null
      this.log.info(`[idle] ${scope} 空闲整理：新增 ${absorbed.added} 条、合并 ${absorbed.dup + absorbed.merged} 条（水位线 ${sinceSeq} → ${topSeq}）`)
      return { ok: true, added: absorbed.added, seq: topSeq }
    } catch (err) {
      this.stats.failures += 1
      this.stats.lastError = String(err?.message ?? err)
      this.log.warn(`[idle] ${scope} 空闲整理失败: ${this.stats.lastError}`)
      return { ok: false, reason: 'error', error: this.stats.lastError }
    }
  }

  /**
   * 交班回看：新一代的前几次整理里，用户又把上一代说过的话交代了一遍、而记忆里没有 → 补成记忆，并发一条信号。
   * 返回补了几条。
   */
  #reviewHandoff({ scope, record, sessionId, fresh }) {
    const tail = record.handoffTail
    if (!tail || !Array.isArray(tail.lines)) return 0
    let added = 0
    try {
      if ((tail.passes ?? 0) < MAX_PASSES) {
        const userLines = this.handoff.foldEvents(fresh, 120000).lines.filter((l) => l.role === '用户').map((l) => l.text)
        const existing = this.memory.forScope(scope).map((f) => f.text)
        for (const miss of findHandoffMisses({ fresh: userLines, tail: tail.lines, existing })) {
          const out = this.memory.store.observe({
            scope: this.memory.scopeOf(scope), kind: 'fact', text: miss.text, actor: MISS_ACTOR, origin: 'model', confidence: 0.5,
            importanceDelta: 1, source: { sessionId, at: this.now(), quote: miss.quote },
          })
          if (out.action === 'new' || out.action === 'ask') added += 1
          this.signals?.emit({
            kind: 'handoff-miss', source: 'qq', scope: this.memory.scopeOf(scope), chatKey: scope, sessionId, at: this.now(),
            quote: miss.quote, confidence: 'low', memoryRevision: this.memory.revisionOf(scope),
          })
        }
        if (added > 0) this.memory.store.flush?.()
      }
    } catch (err) {
      this.log.warn(`[idle] ${scope} 交班回看失败: ${err?.message ?? err}`)
    }
    tail.passes = (tail.passes ?? 0) + 1
    if (tail.passes >= MAX_PASSES) delete record.handoffTail
    this.stats.handoffMisses += added
    return added
  }

  snapshot() {
    return {
      enabled: this.enabled,
      idleMinutes: Number(this.config.conversation.idleMinutes) || 0,
      idleMinTurns: Number(this.config.conversation.idleMinTurns) || 0,
      running: Boolean(this.running),
      waiting: [...this.activity].filter(([, a]) => a.pending > 0).map(([scope, a]) => ({ scope, pending: a.pending })),
      ...this.stats,
    }
  }
}

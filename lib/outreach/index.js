/**
 * 主动私聊主人（PLAN 第 45 条，docs/CONTRACTS.md 第 8.1 节）。蓝本：SurfCore purpose-engine（MIT），纯逻辑见 logic.js。
 *
 * - 只私聊、只发给配对的主人；群聊永远不主动开口。默认关，在控制台里打开。
 * - 闸门（预览里逐条列出）：总开关、主人已配对、有连接、不在安静时段、没超每日上限、到了下次时间、
 *   主人最近没说过话、常驻会话不忙/不在交班、记忆里有值得跟进的事。
 * - 下次发送时间落盘，每次检查重新算；重启后不补发（至少再等 minGap/2，在途的一轮记为 interrupted）。
 *   每天的次数在投递时就扣（模型回合已经花了钱）。
 * - 预览零副作用：真读记忆、真拼提示词，不发送、不写状态。
 * - 主人的回复（6 小时内）当作低置信度反馈：正面 → 这件事的重要度 +1；负面 → 划掉这件事并 7 天不再提；
 *   连续两次没回应 → 划掉。反馈只调权重，不当事实。
 */
import path from 'node:path'
import { isPlainObject, loadJsonOrQuarantine, writeJsonAtomic } from '../core/fs-atomic.js'
import { dayKey, randomGap, classifyReply, pickTopic, buildOutreachPrompt, pushRecent } from './logic.js'
import { resolveOutreachConfig, inQuietHours } from './config.js'

const VERSION = 1
const ACTOR = 'qq:outreach'
const DECLINE_DAYS = 7
const UNANSWERED_LIMIT = 2
const SAVE_DEBOUNCE_MS = 300

const emptyState = () => ({
  nextAt: 0, day: '', sentToday: 0, lastSentAt: 0, recent: [], pending: null, unanswered: {}, declined: {}, inFlight: null,
})

export function createOutreach(options) {
  return new Outreach(options)
}

export class Outreach {
  /**
   * @param {object} opts
   * @param {string} opts.dir $DSH_HOME/shall
   * @param {object} [opts.config] 配置文件里的 `outreach`
   * @param {import('../memory/index.js').MemoryStore} opts.memory
   * @param {{ owner: () => string | null }} opts.owner
   * @param {() => boolean} opts.isConnected
   * @param {(ownerQq: string) => Promise<{ busy: boolean, reason?: string }>} opts.isBusy
   * @param {(input: { ownerQq: string, text: string }) => Promise<void>} opts.deliver
   */
  constructor({ dir, config = {}, memory, owner, isConnected, isBusy, deliver, log = null, now = () => Date.now(), rand = Math.random }) {
    if (!dir) throw new Error('Outreach 需要 dir')
    this.file = path.join(dir, 'outreach.json')
    this.dir = dir
    this.rawConfig = config
    this.memory = memory
    this.owner = owner
    this.isConnected = isConnected
    this.isBusy = isBusy
    this.deliver = deliver
    this.log = log
    this.now = now
    this.rand = rand
    this.timer = null
    this.dirty = false
    this.ticking = false
    this.ownerLastMsgAt = 0
    this.stats = { sent: 0, refused: 0, skipped: 0, failures: 0, interrupted: 0, lastError: null, lastReason: '' }
    this.overrides = {}
    this.state = emptyState()
    this.#load()
  }

  #load() {
    // 读不懂的 outreach.json 改名留档（控制台覆盖项在里面），再按全新状态开始
    const parsed = loadJsonOrQuarantine(this.file, { log: this.log, fallback: null, validate: isPlainObject })
    if (parsed) {
      this.overrides = isPlainObject(parsed.overrides) ? parsed.overrides : {}
      this.state = { ...emptyState(), ...(isPlainObject(parsed.state) ? parsed.state : {}) }
    }
    // 重启：在途的一轮记为 interrupted，不补发；下次时间已过的重新排，至少再等 minGap/2
    const config = this.config()
    if (this.state.inFlight) {
      this.stats.interrupted += 1
      this.state.inFlight = null
    }
    if (!this.state.nextAt || this.state.nextAt <= this.now()) {
      this.state.nextAt = this.now() + Math.round(config.minGapMs / 2 + (config.minGapMs / 2) * this.rand())
    }
    this.#touch()
  }

  /** 实际生效的配置：默认值 ← 配置文件 ← 控制台覆盖 */
  config() {
    return resolveOutreachConfig(this.rawConfig, this.overrides)
  }

  #touch() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.dirty) this.#save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  #save() {
    this.dirty = false
    try {
      writeJsonAtomic(this.file, { version: VERSION, overrides: this.overrides, state: this.state })
    } catch (error) {
      this.log?.warn?.(`[outreach] 落盘失败：${error?.message ?? error}`)
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.#save()
  }

  /** 控制台：开关和调参。非法值回退默认并带回警告 */
  setOverrides(patch) {
    const before = this.config()
    const next = { ...this.overrides }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) delete next[key]
      else if (key === 'quietHours' && value && typeof value === 'object') next.quietHours = { ...(next.quietHours ?? {}), ...value }
      else next[key] = value
    }
    this.overrides = next
    const config = this.config()
    if (!before.enabled && config.enabled) {
      // 刚打开：不要马上发，先等一个随机间隔
      this.state.nextAt = this.now() + randomGap(config, this.rand)
    }
    this.#touch()
    return config
  }

  /** 控制台：清空进度（次数、下次时间、最近联系记录），不动开关和参数 */
  reset() {
    this.state = emptyState()
    this.state.nextAt = this.now() + randomGap(this.config(), this.rand)
    this.#touch()
  }

  /** 主人说话了（私聊里，任何一句）：记时间，并当作对上一次主动联系的反馈 */
  noteOwnerMessage(text, at = this.now()) {
    this.ownerLastMsgAt = at
    const pending = this.state.pending
    if (!pending) return null
    const config = this.config()
    if (at - pending.at > config.replyWindowMs) {
      return null
    }
    const kind = classifyReply(text)
    this.state.pending = null
    for (const id of pending.ids) {
      delete this.state.unanswered[id]
      try {
        if (kind === 'negative') {
          this.memory.complete([id], { actor: ACTOR, reason: '主人说不用/没空' })
          this.state.declined[id] = at + DECLINE_DAYS * 24 * 3600 * 1000
        } else if (kind === 'positive') {
          const entry = this.memory.get(id)
          if (entry) this.memory.observe({ scope: entry.scope, kind: entry.kind, text: entry.text, actor: ACTOR, origin: 'model', importanceDelta: 1 })
        }
      } catch (error) {
        this.log?.warn?.(`[outreach] 记反馈失败: ${error?.message ?? error}`)
      }
    }
    this.#touch()
    return kind
  }

  /** 从记忆里取候选话题的原料：主人聊天片里还 active 的 intent / promise */
  #candidates() {
    try {
      return this.memory.list({ scope: 'owner:chat', status: 'active' })
    } catch {
      return []
    }
  }

  /**
   * 逐条算闸门。预览和真发共用同一份逻辑，所以预览看到的就是真发时会遇到的。
   * @returns {Promise<{ ok: boolean, gates: Array<{ name: string, ok: boolean, detail: string }>, topic: object|null, prompt: string }>}
   */
  async evaluate() {
    const config = this.config()
    const now = this.now()
    const ownerQq = this.owner.owner?.() ?? null
    const gates = []
    const gate = (name, ok, detail) => gates.push({ name, ok: Boolean(ok), detail })

    gate('enabled', config.enabled, config.enabled ? '总开关已打开' : '总开关关着（在控制台里打开）')
    gate('owner', Boolean(ownerQq), ownerQq ? '已配对主人' : '还没有配对主人')
    gate('connection', this.isConnected(), this.isConnected() ? 'QQ 连接在线' : '当前没有 QQ 连接')
    const quiet = inQuietHours(config.quietHours, now)
    gate('quiet-hours', !quiet, quiet ? `现在在安静时段 ${config.quietHours.start}–${config.quietHours.end}` : '不在安静时段')
    const sentToday = this.state.day === dayKey(now) ? this.state.sentToday : 0
    gate('daily-cap', sentToday < config.maxPerDay, `今天已发 ${sentToday} / ${config.maxPerDay}`)
    gate('schedule', now >= this.state.nextAt, now >= this.state.nextAt ? '到点了' : `还没到下次时间（${Math.ceil((this.state.nextAt - now) / 60000)} 分钟后）`)
    const sinceOwner = Math.max(0, now - this.ownerLastMsgAt)
    const ownerActive = this.ownerLastMsgAt > 0 && sinceOwner < config.ownerQuietMs
    gate('owner-active', !ownerActive, ownerActive ? `主人 ${Math.ceil(sinceOwner / 60000)} 分钟前刚说过话` : '主人最近没说话')
    let busy = { busy: false }
    if (ownerQq) {
      try {
        busy = (await this.isBusy(ownerQq)) ?? { busy: false }
      } catch (error) {
        busy = { busy: true, reason: `查不到会话状态：${error?.message ?? error}` }
      }
    }
    gate('busy', !busy.busy, busy.busy ? `常驻会话忙：${busy.reason ?? ''}` : '常驻会话空闲')
    const topic = pickTopic(this.#candidates(), this.state, { now, cooldownDays: config.topicCooldownDays, rand: this.rand })
    gate('topic', Boolean(topic), topic ? `想聊：${topic.text}` : '记忆里没有值得跟进的事')
    return {
      ok: gates.every((g) => g.ok),
      gates,
      topic,
      prompt: topic ? buildOutreachPrompt(topic, { now }) : '',
    }
  }

  /** 零副作用的预览：不发送、不写状态 */
  async preview() {
    return this.evaluate()
  }

  /** 定时器调用。返回这一次的结果，测试和状态页用 */
  async tick() {
    if (this.ticking) return { skipped: 'busy' }
    this.ticking = true
    try {
      const config = this.config()
      if (!config.enabled) return { skipped: 'off' }
      const now = this.now()
      if (this.state.day !== dayKey(now)) {
        this.state.day = dayKey(now)
        this.state.sentToday = 0
        this.#touch()
      }
      const ev = await this.evaluate()
      if (!ev.ok) {
        const failed = ev.gates.find((g) => !g.ok)
        this.stats.skipped += 1
        this.stats.lastReason = failed?.name ?? ''
        // 到点了但没有可聊的事：隔一阵再看，不要每分钟都去读一遍记忆
        if (failed?.name === 'topic') {
          this.state.nextAt = now + config.idleRecheckMs
          this.#touch()
        }
        return { skipped: failed?.name ?? 'unknown' }
      }
      return await this.#send(ev, config, now)
    } finally {
      this.ticking = false
    }
  }

  async #send(ev, config, now) {
    const ownerQq = this.owner.owner()
    // 上一次联系还没等到回应：记一次“没回应”，连续两次就划掉那件事
    const previous = this.state.pending
    if (previous) {
      for (const id of previous.ids) {
        const n = (this.state.unanswered[id] ?? 0) + 1
        this.state.unanswered[id] = n
        if (n >= UNANSWERED_LIMIT) {
          try {
            this.memory.complete([id], { actor: ACTOR, reason: '连续两次没回应' })
          } catch (error) {
            this.log?.warn?.(`[outreach] ${error?.message ?? error}`)
          }
          delete this.state.unanswered[id]
        }
      }
    }
    // 每天的次数在投递时就扣；下次时间先落盘再发，发到一半进程没了也不会补发
    this.state.sentToday += 1
    this.state.lastSentAt = now
    this.state.nextAt = now + randomGap(config, this.rand)
    this.state.recent = pushRecent(this.state.recent, ev.topic, now)
    this.state.pending = { at: now, ids: [ev.topic.id] }
    this.state.inFlight = { at: now, topicId: ev.topic.id }
    this.#touch()
    this.flush()
    try {
      await this.deliver({ ownerQq, text: ev.prompt })
      this.stats.sent += 1
      this.stats.lastError = null
      this.log?.info?.(`[outreach] 已让常驻会话考虑主动联系主人：${ev.topic.text}`)
      return { sent: true, topic: ev.topic }
    } catch (error) {
      this.stats.failures += 1
      this.stats.lastError = error?.message ?? String(error)
      this.log?.warn?.(`[outreach] 投递失败: ${this.stats.lastError}`)
      return { sent: false, error: this.stats.lastError }
    } finally {
      this.state.inFlight = null
      this.#touch()
    }
  }

  snapshot() {
    const config = this.config()
    const now = this.now()
    return {
      enabled: config.enabled,
      config: { ...config, warnings: undefined },
      warnings: config.warnings,
      ownerPaired: Boolean(this.owner.owner?.()),
      nextAt: this.state.nextAt,
      sentToday: this.state.day === dayKey(now) ? this.state.sentToday : 0,
      lastSentAt: this.state.lastSentAt,
      recent: this.state.recent.slice(-10).reverse(),
      awaitingReply: Boolean(this.state.pending),
      ...this.stats,
    }
  }

  dispose() {
    this.flush()
  }
}

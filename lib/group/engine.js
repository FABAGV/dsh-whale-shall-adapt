/**
 * 群聊回复决策引擎（docs/CONTRACTS.md 第 8 节，PLAN 第 29–37、43 条）。
 *
 * 五层，前四层不调模型：
 *   ① 硬规则   必须回（被叫到）/ 必须不回（潜水档、命令、只 @ 了别人、静默时段、已收尾、被忽略的人……）
 *   ② 在场状态 点名之后一段时间里，被回复过的人接着说可以不再 @
 *   ③ 等时机   没被叫到的消息先等群里安静一会儿；新消息替换触发点；同一个群同一时间只排一次
 *   ④ 预算     精力（发言扣、按时间恢复）、每小时上限、冷却、对话疲劳；被叫到时跳过
 *   ⑤ 判断     只在“活跃”档、没被叫到时：便宜模型打分，通过才回
 *
 * “盯群”档不走第 ⑤ 层：等时机之后把还没给常驻会话看过的群消息整批交给它，由主模型自己决定接不接。
 * 两次看群之间至少隔 watch.minIntervalMs、每小时最多 watch.perHour 次；常驻会话还在回上一轮时不叠着送，等它回完再送。
 *
 * 引擎自己不碰 QQ：调用方（lib/qq/plugin.js）把每条群消息交给 `onInbound`，
 * 同步拿到“现在就回 / 不回 / 先等等”，等的那种到时间后通过 `onDecision` 回调通知。
 * 时间和定时器都可以注入，测试用假时钟。
 */
import { inQuietHours, settingsForGroup } from './config.js'
import { classifyClosing } from './closure.js'
import { thresholdFor } from './judge.js'
import { InterjectFeedback } from './feedback.js'

const RING_MAX = 60
const TEXT_CLIP = 300
const DECISIONS_MAX = 20
const HOUR_MS = 3600 * 1000
/** 送进常驻会话的一轮这么久还没有结束的消息，就当它丢了（不让盯群一直等下去） */
const TURN_STUCK_MS = 3 * 60 * 1000
/** 插话被嫌弃/被撤回之后，把这个群“不喜欢 bot 主动搭话”记进群记忆需要的负反馈次数 */
const REJECT_NOTE_AT = 2
const IGNORE_TEXT = '别主动搭话：这个人不想被 bot 主动搭话（他自己 @ bot 时照常回）'
export const GROUP_REJECT_NOTE = '这个群不喜欢 bot 主动搭话，没被叫到时别插嘴'

const oneLine = (text, max = TEXT_CLIP) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export class GroupEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config resolveGroupConfig 的结果
   * @param {import('./settings.js').GroupSettings|null} [opts.settings]
   * @param {Function|null} [opts.judge] createJudge 的返回值
   * @param {import('../memory/index.js').MemoryStore|null} [opts.memory]
   * @param {{ emit: Function }|null} [opts.signals] 进程内信号总线
   * @param {() => string} [opts.botName]
   */
  constructor({ config, settings = null, judge = null, memory = null, signals = null, log = null, botName = () => 'bot', now = () => Date.now(), timers = null } = {}) {
    this.config = config
    this.settings = settings
    this.judge = judge
    this.memory = memory
    this.signals = signals
    this.log = log
    this.botName = botName
    this.now = now
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }
    this.chats = new Map()
    this.listeners = new Set()
    this.feedback = new InterjectFeedback({ now, onResult: (chatKey, result, detail) => this.#onFeedback(chatKey, result, detail) })
    this.sweepTimer = null
    this.disposed = false
  }

  /** 定时扫插话反馈窗口。tests 不需要启动它，直接调 feedback.sweep() */
  start(intervalMs = 30000) {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.feedback.sweep(), intervalMs)
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
  }

  onDecision(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 这个群实际生效的设置 */
  settingsFor(groupId) {
    return settingsForGroup(this.config, groupId, this.settings?.get(groupId) ?? null)
  }

  #chat(chatKey) {
    let chat = this.chats.get(chatKey)
    if (!chat) {
      const groupId = chatKey.replace(/^group:/, '')
      const st = this.settingsFor(groupId)
      chat = {
        chatKey, groupId, ring: [], seq: 0, delivered: 0,
        energy: st.energy.initial, energyAt: this.now(),
        presence: null, lastBotAt: 0, botReplies: [], pending: null, judging: false, rearm: false,
        closedUntil: 0, senderCalls: new Map(), botCalls: [], decisions: [],
        replyStreak: { count: 0, lastAt: 0 }, silentStreak: 0, lastCaller: '', mutedAt: 0,
        lastDecisionAnchor: '', pendingInterject: null,
        looks: [], lastLookAt: 0, turnOpen: false, turnAt: 0, lookAfterTurn: false,
      }
      this.chats.set(chatKey, chat)
    }
    return chat
  }

  #energyNow(chat, st) {
    const at = this.now()
    const gained = ((at - chat.energyAt) / 1000) * st.energy.recoverPerSec
    chat.energy = Math.min(st.energy.initial, chat.energy + Math.max(0, gained))
    chat.energyAt = at
    return chat.energy
  }

  #record(chat, entry) {
    chat.decisions.push({ at: this.now(), ...entry })
    if (chat.decisions.length > DECISIONS_MAX) chat.decisions.shift()
    return entry
  }

  #presenceOn(chat, st) {
    const p = chat.presence
    if (!p) return false
    if (this.now() > p.until || p.left <= 0 || st.present.minutes <= 0) {
      chat.presence = null
      return false
    }
    return true
  }

  /** 被忽略的人：群成员记忆里有“别主动搭话”的条目 */
  isIgnored(groupId, senderId) {
    if (!this.memory || !senderId) return false
    try {
      return this.memory
        .list({ scope: `member:${groupId}:${senderId}`, kind: 'avoid', status: 'active' })
        .some((entry) => entry.text.startsWith('别主动搭话'))
    } catch {
      return false
    }
  }

  /** 把一个人记成“主动搭话时绕开”（他 @ bot 时照常回） */
  ignoreSender(groupId, senderId, reason = '') {
    if (!this.memory || !/^\d{5,12}$/.test(String(senderId ?? ''))) return null
    return this.memory.observe({
      scope: `member:${groupId}:${senderId}`, kind: 'avoid', text: reason ? `${IGNORE_TEXT}（${oneLine(reason, 40)}）` : IGNORE_TEXT,
      actor: 'qq:group-engine', origin: 'model', confidence: 0.5, importanceDelta: 1,
    })
  }

  /**
   * 每条群消息进来调一次。
   * @param {object} m { chatKey:'group:123', messageId, senderId, senderName, at, text, addressed, mentionsOthers, isCommand, fromBot, replyToMessageId }
   * @returns {{ respond: boolean, wait: boolean, mode: 'called'|'present'|'active'|'', reason: string, closing?: object, anchorMessageId: string }}
   */
  onInbound(m) {
    const chat = this.#chat(m.chatKey)
    const st = this.settingsFor(chat.groupId)
    const at = Number(m.at) || this.now()
    const text = oneLine(m.text)
    // 同一条消息可能判两次（插件取回引用原文后发现它是在回复 bot，带着“叫到了”再判一次）：不重复入账
    const prior = m.messageId ? chat.ring.find((e) => e.messageId === String(m.messageId) && !e.isBot) : null
    let entry = prior
    if (!entry) {
      chat.seq += 1
      entry = {
        seq: chat.seq, messageId: String(m.messageId ?? ''), senderId: String(m.senderId ?? ''), senderName: String(m.senderName ?? ''), text, at, isBot: false,
        fromBot: Boolean(m.fromBot), command: Boolean(m.isCommand),
      }
      chat.ring.push(entry)
      if (chat.ring.length > RING_MAX) chat.ring.shift()
      this.feedback.noteInbound(m.chatKey, { senderId: m.senderId, text: m.text, addressed: m.addressed, replyToMessageId: m.replyToMessageId })
    }

    const skip = (reason, extra = {}) => {
      if (!(st.mode === 'mention' && reason === 'not-called')) this.#record(chat, { respond: false, mode: st.mode, reason, anchorMessageId: entry.messageId, senderId: entry.senderId, ...extra })
      return { respond: false, wait: false, mode: '', reason, anchorMessageId: entry.messageId }
    }

    // ① 硬规则
    if (st.mode === 'silent') return skip('mode-silent')
    const closing = classifyClosing(m.text)
    if (m.addressed) {
      if (m.fromBot) {
        chat.botCalls = chat.botCalls.filter((t) => at - t < st.botLoop.windowMs)
        if (chat.botCalls.length >= st.botLoop.maxCalls) return skip('bot-loop')
        chat.botCalls.push(at)
      }
      const calls = (chat.senderCalls.get(entry.senderId) ?? []).filter((t) => at - t < st.budget.perSenderWindowMs)
      if (calls.length >= st.budget.perSenderCalls) return skip('sender-rate')
      calls.push(at)
      chat.senderCalls.set(entry.senderId, calls)
      this.#cancelPending(chat)
      chat.lastCaller = entry.senderId
      chat.calledSeq = entry.seq
      if (st.mode === 'present' || st.mode === 'active') this.#openPresence(chat, st, entry.senderId)
      chat.turnOpen = true
      chat.turnAt = at
      // 这条直接交给了常驻会话，盯群看下一眼时不再带
      entry.called = true
      this.#record(chat, { respond: true, mode: 'called', reason: `called:${m.addressed}`, anchorMessageId: entry.messageId, senderId: entry.senderId })
      return { respond: true, wait: false, mode: 'called', reason: `called:${m.addressed}`, closing, anchorMessageId: entry.messageId }
    }
    if (st.mode === 'mention') return skip('not-called')
    if (m.fromBot) return skip('from-bot')
    if (m.isCommand) return skip('command')
    if (m.mentionsOthers) return skip('mentions-others')
    if (inQuietHours(st.quietHours, at)) return skip('quiet-hours')
    if (chat.mutedAt) return skip('muted')
    if (this.isIgnored(chat.groupId, entry.senderId)) return skip('sender-ignored')
    if (chat.closedUntil > at) return skip('closed')

    // ② 在场状态
    const present = this.#presenceOn(chat, st)
    if (present) chat.presence.left -= 1
    if (closing.canClose && present) {
      chat.closedUntil = at + st.closureMs
      chat.presence = null
      this.#cancelPending(chat)
      return skip(`closing:${closing.kind}`)
    }
    if (closing.canClose && (st.mode === 'active' || st.mode === 'watch')) return skip(`closing:${closing.kind}`)
    if (st.mode === 'present' && !(present && chat.presence.senders.has(entry.senderId))) return skip('not-present')

    // ③ 等时机：替换触发点，不叠加
    this.#schedule(chat, st, entry)
    return { respond: false, wait: true, mode: st.mode, reason: 'waiting', anchorMessageId: entry.messageId }
  }

  #openPresence(chat, st, senderId) {
    const prev = chat.presence
    chat.presence = {
      until: this.now() + st.present.minutes * 60000,
      left: st.present.messages,
      senders: new Set([...(prev?.senders ?? []), senderId]),
    }
  }

  #cancelPending(chat) {
    if (chat.pending?.timer) this.timers.clear(chat.pending.timer)
    chat.pending = null
  }

  #schedule(chat, st, entry) {
    const first = chat.pending?.firstAt ?? this.now()
    if (chat.pending?.timer) this.timers.clear(chat.pending.timer)
    const wait = Math.max(0, Math.min(st.timing.quietMs, st.timing.maxWaitMs - (this.now() - first)))
    const timer = this.timers.set(() => void this.#fire(chat.chatKey), wait)
    if (typeof timer?.unref === 'function') timer.unref()
    chat.pending = { timer, firstAt: first, anchor: entry }
  }

  #emit(decision) {
    for (const fn of this.listeners) {
      try {
        fn(decision)
      } catch (error) {
        this.log?.warn?.(`[group] 决定监听器出错：${error?.message ?? error}`)
      }
    }
  }

  /** 对话疲劳：连续主动插话的条数超过 afterReplies 之后，门槛每多一条升高 step */
  #fatigue(chat, st) {
    const streak = chat.replyStreak
    if (!streak.count || this.now() - streak.lastAt > st.fatigue.resetMs) return 0
    return Math.max(0, streak.count - st.fatigue.afterReplies + 1) * st.fatigue.step
  }

  /** 插话被接住/被嫌弃的历史，加上群记忆里的“不喜欢”，调整判断阈值 */
  #appetiteAdjust(chat) {
    let adjust = 0
    const stats = this.settings?.interjectStats(chat.groupId)
    if (stats && stats.total >= 5) {
      if (stats.rejected / stats.total >= 0.3) adjust += 1.5
      else if (stats.engaged / stats.total >= 0.5) adjust -= 0.5
    }
    if (this.#hasRejectNote(chat.groupId)) adjust += 1
    return adjust
  }

  #hasRejectNote(groupId) {
    try {
      return Boolean(this.memory?.list({ scope: `chat:group:${groupId}`, status: 'active' }).some((e) => e.text === GROUP_REJECT_NOTE))
    } catch {
      return false
    }
  }

  #memoryLines(groupId) {
    try {
      return (this.memory?.list({ scope: `chat:group:${groupId}`, status: 'active' }) ?? [])
        .filter((e) => e.kind !== 'boundary' && e.kind !== 'slang')
        .slice(0, 5)
        .map((e) => e.text)
    } catch {
      return []
    }
  }

  async #fire(chatKey) {
    const chat = this.chats.get(chatKey)
    if (!chat?.pending || this.disposed) return
    if (chat.judging) {
      chat.rearm = true
      return
    }
    const st = this.settingsFor(chat.groupId)
    const anchor = chat.pending.anchor
    chat.pending = null
    const base = { chatKey, mode: st.mode, anchorMessageId: anchor.messageId, senderId: anchor.senderId }
    const decide = (respond, reason, extra = {}) => {
      const decision = { ...base, respond, reason, ...extra }
      this.#record(chat, decision)
      if (respond) chat.expectInterject = true
      this.#emit(decision)
      return decision
    }
    const drop = (reason, extra = {}) => {
      this.#record(chat, { ...base, respond: false, reason, ...extra })
    }
    const at = this.now()

    // ④ 预算
    if (chat.closedUntil > at) return decide(false, 'closed')
    if (chat.mutedAt) return decide(false, 'muted')
    if (st.mode === 'watch') return this.#look(chat, st, anchor, decide)
    const energy = this.#energyNow(chat, st)
    if (chat.lastBotAt && at - chat.lastBotAt < st.budget.cooldownMs) return decide(false, 'cooldown')
    chat.botReplies = chat.botReplies.filter((t) => at - t < HOUR_MS)
    if (chat.botReplies.length >= st.budget.perHour) return decide(false, 'hour-limit')
    if (st.mode === 'active' && energy < st.energy.minToSpeak) return decide(false, 'energy-low', { energy: Math.round(energy) })

    // 在场档不调模型：被回复过的人接着说，预算过了就回
    if (st.mode === 'present') return decide(true, 'present-follow-up')

    // ⑤ 判断（只在活跃档）
    if (!this.judge) return decide(false, 'no-judge')
    const threshold = thresholdFor(st.eagerness, this.#fatigue(chat, st) + this.#appetiteAdjust(chat))
    chat.judging = true
    let result
    try {
      result = await this.judge({
        botName: this.botName(),
        groupName: this.settings?.get(chat.groupId)?.name ?? '',
        recent: chat.ring.slice(-15),
        trigger: anchor,
        memoryLines: this.#memoryLines(chat.groupId),
        appetite: this.settings?.interjectStats(chat.groupId) ?? null,
        threshold,
      })
    } catch (error) {
      result = { respond: false, score: 0, threshold, reason: '', error: error?.message ?? String(error) }
    } finally {
      chat.judging = false
    }
    if (this.disposed) return
    const rearm = chat.rearm
    chat.rearm = false
    const detail = { score: result.score, threshold: result.threshold, judgeReason: result.reason, ...(result.error ? { error: result.error } : {}) }
    let out
    if (chat.pending || (chat.calledSeq ?? 0) > anchor.seq) {
      drop('superseded', detail)
      out = null
    } else if (result.error) {
      out = decide(false, 'judge-failed', detail)
    } else if (result.respond) {
      out = decide(true, 'judged-yes', { ...detail, target: result.target })
    } else {
      out = decide(false, 'judged-no', detail)
    }
    if (rearm && chat.pending) void this.#fire(chatKey)
    return out
  }

  /**
   * 盯群档看一眼：把还没给常驻会话看过的群消息整批交出去，由主模型决定接不接。
   * 常驻会话还在回上一轮时先不送（回完再看）；离上次看群不到 watch.minIntervalMs 就推迟到那时。
   */
  #look(chat, st, anchor, decide) {
    const at = this.now()
    chat.botReplies = chat.botReplies.filter((t) => at - t < HOUR_MS)
    if (chat.botReplies.length >= st.budget.perHour) return decide(false, 'hour-limit')
    chat.looks = chat.looks.filter((t) => at - t < HOUR_MS)
    if (chat.looks.length >= st.watch.perHour) return decide(false, 'watch-limit')
    if (chat.turnOpen && at - chat.turnAt < TURN_STUCK_MS) {
      chat.lookAfterTurn = true
      return null
    }
    const wait = chat.lastLookAt + st.watch.minIntervalMs - at
    if (wait > 0) {
      this.#arm(chat, anchor, wait)
      return null
    }
    const { batch, skipped } = this.#unseen(chat, st)
    if (batch.length === 0) return null
    chat.lastLookAt = at
    chat.looks.push(at)
    chat.turnOpen = true
    chat.turnAt = at
    chat.expectInterject = true
    const decision = { chatKey: chat.chatKey, mode: 'watch', anchorMessageId: batch.at(-1).messageId, senderId: '', respond: true, reason: 'watch-look', count: batch.length }
    this.#record(chat, decision)
    this.#emit({ ...decision, batch, skipped })
    return decision
  }

  /** 到点再判一次（盯群档推迟看群用）；之后来的新消息照常替换掉它 */
  #arm(chat, anchor, delayMs) {
    if (chat.pending?.timer) this.timers.clear(chat.pending.timer)
    const timer = this.timers.set(() => void this.#fire(chat.chatKey), delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
    chat.pending = { timer, firstAt: this.now(), anchor }
  }

  /** 还没给常驻会话看过的群消息（不含 bot 自己的），按条数和字数留最新的；取完把水位线推到最后一条 */
  #unseen(chat, st) {
    const cutoff = this.now() - st.context.maxAgeMs
    const unseen = chat.ring.filter((e) => !e.isBot && e.seq > chat.delivered)
    if (unseen.length === 0) return { batch: [], skipped: 0 }
    chat.delivered = Math.max(chat.delivered, unseen.at(-1).seq)
    // 别的 bot 说的、发给别的 bot 的命令不算群友在聊；叫到它的那条已经单独交过了
    const fresh = unseen.filter((e) => !e.fromBot && !e.command && !e.called)
    const recent = fresh.filter((e) => e.at >= cutoff).slice(-st.watch.messages)
    const batch = []
    const ignored = new Map()
    let total = 0
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const e = recent[i]
      const cost = e.text.length + 30
      if (batch.length > 0 && total + cost > st.watch.chars) break
      if (!ignored.has(e.senderId)) ignored.set(e.senderId, this.isIgnored(chat.groupId, e.senderId))
      // 不想被主动搭话的人照样带上（别人在跟他聊），只是标出来
      batch.unshift({ ...e, ignored: ignored.get(e.senderId) })
      total += cost
    }
    return { batch, skipped: fresh.length - batch.length }
  }

  /**
   * bot 在这个群发了一条消息（扣精力、记入最近消息、续在场、开始观察插话反馈）。
   * @param {object} r { chatKey, chars, text, at, messageId }
   */
  noteBotReply(r) {
    const chat = this.#chat(r.chatKey)
    const st = this.settingsFor(chat.groupId)
    const at = Number(r.at) || this.now()
    const chars = Math.max(0, Number(r.chars) || String(r.text ?? '').length)
    const cost = (st.energy.base + chars * st.energy.perChar) * (1.5 - st.eagerness)
    chat.energy = Math.max(st.energy.floor, this.#energyNow(chat, st) - cost)
    chat.lastBotAt = at
    chat.silentStreak = 0
    chat.seq += 1
    chat.ring.push({ seq: chat.seq, messageId: String(r.messageId ?? ''), senderId: '', senderName: this.botName(), text: oneLine(r.text), at, isBot: true })
    if (chat.ring.length > RING_MAX) chat.ring.shift()
    if (chat.expectInterject) {
      chat.expectInterject = false
      chat.botReplies.push(at)
      const streak = chat.replyStreak
      streak.count = this.now() - streak.lastAt > st.fatigue.resetMs ? 1 : streak.count + 1
      streak.lastAt = at
      this.feedback.start(r.chatKey, { messageId: r.messageId, at })
    } else {
      chat.replyStreak = { count: 0, lastAt: 0 }
    }
    if ((st.mode === 'present' || st.mode === 'active') && chat.presence) {
      chat.presence.until = this.now() + st.present.minutes * 60000
      chat.presence.left = st.present.messages
    }
  }

  /** 一个回合结束：说了话还是选择不说（连续没开口会在下一次提示里提醒）。盯群档在这时补看回合期间攒下的消息 */
  noteTurnOutcome(chatKey, { spoke }) {
    const chat = this.#chat(chatKey)
    chat.silentStreak = spoke ? 0 : chat.silentStreak + 1
    if (!spoke) chat.expectInterject = false
    chat.turnOpen = false
    if (!chat.lookAfterTurn) return
    chat.lookAfterTurn = false
    const st = this.settingsFor(chat.groupId)
    const last = chat.ring.filter((e) => !e.isBot).at(-1)
    if (st.mode !== 'watch' || chat.pending || !last || last.seq <= chat.delivered) return
    this.#arm(chat, last, Math.max(st.timing.quietMs, chat.lastLookAt + st.watch.minIntervalMs - this.now()))
  }

  /** 连续 K 轮没开口时的提醒；给出之后计数清零。盯群档不提醒：那里大多数时候本来就该不说话 */
  reminderFor(chatKey) {
    const chat = this.chats.get(chatKey)
    if (!chat) return ''
    const st = this.settingsFor(chat.groupId)
    if (st.mode === 'watch') {
      chat.silentStreak = 0
      return ''
    }
    if (!st.silentReminderAfter || chat.silentStreak < st.silentReminderAfter) return ''
    const n = chat.silentStreak
    chat.silentStreak = 0
    return `（提醒：你已经连续 ${n} 次选择不说话了。“可以不说”是为了不打扰人，不是永远不说；该接的话请接。）`
  }

  /**
   * 被叫到或要插话时，带上群里最近的几条作为本轮背景（只作背景，不进记忆）。
   * 已经带过的不重复带：用 delivered 水位线。
   */
  contextFor(chatKey, { excludeMessageId = '', excludeMessageIds = [] } = {}) {
    const chat = this.chats.get(chatKey)
    if (!chat) return ''
    const st = this.settingsFor(chat.groupId)
    const excluded = new Set([excludeMessageId, ...excludeMessageIds].filter(Boolean).map(String))
    const anchors = chat.ring.filter((e) => excluded.has(e.messageId))
    const upTo = anchors.length ? Math.max(...anchors.map((e) => e.seq)) : chat.seq
    const cutoff = this.now() - st.context.maxAgeMs
    const items = chat.ring
      .filter((e) => !e.isBot && e.seq > chat.delivered && e.seq <= upTo && !excluded.has(e.messageId) && e.at >= cutoff)
      .slice(-st.context.messages)
    const lines = []
    let total = 0
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const line = `${items[i].senderName || items[i].senderId || '?'}: ${oneLine(items[i].text, 120)}`
      if (total + line.length > st.context.chars) break
      lines.unshift(line)
      total += line.length
    }
    chat.delivered = Math.max(chat.delivered, upTo)
    return lines.length ? `【群里刚才在聊（插件附上的背景，不是对你说的）】\n${lines.join('\n')}` : ''
  }

  /** 这个 QQ 号最近在群里说过话吗（模型用 <at id/> 时校验，防止 @ 到胡编的号） */
  hasRecentSender(chatKey, qq, windowMs = 30 * 60 * 1000) {
    const chat = this.chats.get(chatKey)
    if (!chat) return false
    const cutoff = this.now() - windowMs
    return chat.ring.some((e) => !e.isBot && e.senderId === String(qq) && e.at >= cutoff)
  }

  /** 这条消息是不是最近的（模型用 <quote id/> 时校验） */
  hasMessage(chatKey, messageId) {
    return Boolean(this.entryOf(chatKey, messageId))
  }

  entryOf(chatKey, messageId) {
    const id = String(messageId ?? '')
    if (!id) return null
    return this.chats.get(chatKey)?.ring.find((e) => e.messageId === id) ?? null
  }

  /** 最近 windowMs 里有几个不同的人说过话（多人在聊时回复要 @ 提问的人） */
  recentSenderCount(chatKey, windowMs = 2 * 60 * 1000) {
    const chat = this.chats.get(chatKey)
    if (!chat) return 0
    const cutoff = this.now() - windowMs
    return new Set(chat.ring.filter((e) => !e.isBot && e.at >= cutoff).map((e) => e.senderId)).size
  }

  /** 群里有人撤回了一条消息 */
  noteRecall(chatKey, messageId, { operatorIsBot = false } = {}) {
    return this.feedback.noteRecall(chatKey, messageId, { operatorIsBot })
  }

  /** bot 被禁言 / 解除禁言 */
  noteBan(chatKey, banned) {
    const chat = this.#chat(chatKey)
    if (banned) {
      this.#cancelPending(chat)
      this.feedback.noteMuted(chatKey)
    } else {
      chat.mutedAt = 0
    }
  }

  #onFeedback(chatKey, result, detail) {
    const chat = this.chats.get(chatKey)
    const groupId = chat?.groupId ?? chatKey.replace(/^group:/, '')
    const stored = result === 'engaged' ? 'engaged' : result === 'silence' ? 'silence' : 'rejected'
    this.settings?.recordInterject(groupId, stored, this.now())
    if (result === 'muted' && chat) chat.mutedAt = this.now()
    const kinds = { engaged: 'interject-engaged', rejected: 'interject-rejected', recalled: 'bot-recalled', muted: 'bot-muted', silence: 'interject-silence' }
    try {
      this.signals?.emit({ kind: kinds[result], source: 'qq', scope: `chat:group:${groupId}`, chatKey, at: this.now(), quote: detail?.quote, confidence: 'low' })
    } catch (error) {
      this.log?.warn?.(`[group] 信号总线出错：${error?.message ?? error}`)
    }
    if (stored === 'rejected' && this.memory && (this.settings?.interjectStats(groupId).rejected ?? 0) >= REJECT_NOTE_AT) {
      try {
        this.memory.observe({
          scope: `chat:group:${groupId}`, kind: 'preference', text: GROUP_REJECT_NOTE, actor: 'qq:feedback',
          origin: 'model', confidence: 0.4, importanceDelta: 1,
        })
      } catch (error) {
        this.log?.warn?.(`[group] 写群记忆失败：${error?.message ?? error}`)
      }
    }
  }

  /** 状态页数据：每个群的档位、在场、精力、最近的决定和理由、插话被接住率 */
  snapshot(chatKey = null) {
    const one = (chat) => {
      const st = this.settingsFor(chat.groupId)
      return {
        chatKey: chat.chatKey,
        groupId: chat.groupId,
        mode: st.mode,
        present: this.#presenceOn(chat, st),
        presentUntil: chat.presence?.until ?? 0,
        energy: Math.round(this.#energyNow(chat, st)),
        lastBotAt: chat.lastBotAt,
        interjectsLastHour: chat.botReplies.filter((t) => this.now() - t < HOUR_MS).length,
        looksLastHour: chat.looks.filter((t) => this.now() - t < HOUR_MS).length,
        lastLookAt: chat.lastLookAt,
        turnOpen: chat.turnOpen,
        closedUntil: chat.closedUntil > this.now() ? chat.closedUntil : 0,
        muted: Boolean(chat.mutedAt),
        pending: Boolean(chat.pending),
        silentStreak: chat.silentStreak,
        interjects: this.settings?.interjectStats(chat.groupId) ?? { total: 0, engaged: 0, rejected: 0, silence: 0 },
        decisions: chat.decisions.slice().reverse(),
      }
    }
    if (chatKey) {
      const chat = this.chats.get(chatKey)
      return chat ? one(chat) : null
    }
    return [...this.chats.values()].map(one)
  }

  dispose() {
    this.disposed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const chat of this.chats.values()) this.#cancelPending(chat)
    this.feedback.clear()
    this.listeners.clear()
  }
}

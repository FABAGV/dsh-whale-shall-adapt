/**
 * 入站合并（UX 第 26 条，借鉴消息防抖 debounce 插件的思路，用“静默 N 毫秒”这种规则代替它的 BERT 模型）。
 *
 * 同一个人在同一个聊天里连发的几句话（“如果明天不下雨”“我们去爬山吧”），安静下来再合成一条交给常驻会话，
 * 免得被当成两件事回两次。私聊和群聊都用。
 *
 * 只合并“要交给会话处理”的普通文本消息。带引用、带合并转发、戳一戳的不合并，而且会先把已经攒下的放行，保持先后顺序。
 * 群里换了一个人说话，上一个人攒下的也立刻放行。
 */

const STRENGTH = { at: 4, reply: 3, name: 2, poke: 1, '': 0 }

const keyOf = (decision) => `${decision.message.chatType}:${decision.message.chatId}`

/** 这条能不能进合并队列 */
export function mergeable(decision) {
  if (!decision?.message || decision.addressedBy === 'poke') return false
  if (decision.expandForward || decision.quote) return false
  if (decision.message.segments?.some((s) => s.kind === 'reply' || s.kind === 'forward')) return false
  return typeof decision.text === 'string' && decision.text.length > 0
}

/** 把攒下的几条合成一条：正文按行拼接，以最后一条为锚点，叫法取最强的 */
export function combine(items) {
  if (items.length === 1) return items[0]
  const last = items[items.length - 1]
  const addressedBy = items.map((d) => d.addressedBy ?? '').sort((a, b) => (STRENGTH[b] ?? 0) - (STRENGTH[a] ?? 0))[0]
  return {
    ...last,
    text: items.map((d) => d.text).join('\n'),
    addressedBy,
    merged: items.length,
    mergedMessageIds: items.map((d) => d.message.messageId).filter(Boolean),
    group: last.group ? { ...last.group, closing: last.group.closing } : last.group,
  }
}

export class InboundMerger {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs 安静这么久才放行；0 = 不合并（直接放行）
   * @param {(decision: object) => void} opts.onFlush
   */
  constructor({ windowMs, onFlush, timers = null }) {
    this.windowMs = Math.max(0, Number(windowMs) || 0)
    this.onFlush = onFlush
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }
    /** chatKey → { senderId, items, timer } */
    this.pending = new Map()
    this.stats = { received: 0, merged: 0, flushes: 0 }
  }

  push(decision) {
    this.stats.received += 1
    if (this.windowMs === 0) return this.#emit([decision])
    const key = keyOf(decision)
    const sender = String(decision.message.senderId ?? '')
    const current = this.pending.get(key)
    if (current && (current.senderId !== sender || !mergeable(decision))) this.flush(key)
    if (!mergeable(decision)) return this.#emit([decision])
    let entry = this.pending.get(key)
    if (!entry) {
      entry = { senderId: sender, items: [], timer: null }
      this.pending.set(key, entry)
    }
    entry.items.push(decision)
    if (entry.timer) this.timers.clear(entry.timer)
    entry.timer = this.timers.set(() => this.flush(key), this.windowMs)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()
  }

  /** 放行某个聊天攒下的；不传 key 就全放行 */
  flush(key = null) {
    const keys = key ? [key] : [...this.pending.keys()]
    for (const k of keys) {
      const entry = this.pending.get(k)
      if (!entry) continue
      this.pending.delete(k)
      if (entry.timer) this.timers.clear(entry.timer)
      this.#emit(entry.items)
    }
  }

  #emit(items) {
    if (items.length === 0) return
    this.stats.flushes += 1
    if (items.length > 1) this.stats.merged += items.length - 1
    this.onFlush(combine(items))
  }

  /** 卸载：不放行，直接丢弃（进程在退出，没有地方可投） */
  dispose() {
    for (const entry of this.pending.values()) if (entry.timer) this.timers.clear(entry.timer)
    this.pending.clear()
  }

  snapshot() {
    return { windowMs: this.windowMs, waiting: this.pending.size, ...this.stats }
  }
}

/**
 * 进程内信号总线（docs/CONTRACTS.md 第 7 节）。
 *
 * QQ 侧只采集事件、不下结论：被纠正、工具反复失败、主人在 GUI 里接手、交班漏项、插话被接住/被嫌弃……
 * 判定和落账的一方订阅它。事件在内存里留最近 200 条，控制台和测试看得到。
 * 订阅者出错不能影响发出者，也不能影响其他订阅者。
 */

export const SIGNAL_KINDS = Object.freeze([
  'correction', 'tool-fail', 'gui-takeover', 'handoff-miss', 'not-like', 'followup',
  'interject-engaged', 'interject-rejected', 'bot-recalled', 'bot-muted', 'interject-silence',
])

const RECENT_MAX = 200

export function createSignals({ log = null } = {}) {
  const listeners = new Set()
  const recent = []
  return {
    /** @param {{ kind: string, source?: string, scope?: string, chatKey?: string, sessionId?: string, seq?: number, at?: number, quote?: string, confidence?: 'high'|'low' }} event */
    emit(event) {
      if (!event || !SIGNAL_KINDS.includes(event.kind)) return false
      const entry = { source: 'qq', at: Date.now(), confidence: 'low', ...event }
      recent.push(entry)
      if (recent.length > RECENT_MAX) recent.shift()
      for (const fn of listeners) {
        try {
          fn(entry)
        } catch (error) {
          log?.warn?.(`[signals] 订阅者出错：${error?.message ?? error}`)
        }
      }
      return true
    },
    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    recent(limit = 50) {
      return recent.slice(-limit).reverse()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

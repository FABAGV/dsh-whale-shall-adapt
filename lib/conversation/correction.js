/**
 * 信号的判定与落账（PLAN 第 12、13 条的落地，保守版）。
 *
 * 规则判纠正的准确度不高，所以这里不自动改任何已有记忆的权重，只做两件事：
 *   1. 按聊天范围记账（被纠正几次、被 GUI 接手几次、工具连续失败几次、被追问几次），控制台看得到；
 *   2. 用户明确纠正了一句（句首是“不对 / 别这样 / 我说的是……”）时，在该聊天范围里记一条**候选**的 avoid：
 *      “被纠正过：<用户原话>”。候选记忆不注入，等用户在控制台里确认（转正）或删掉；同一个聊天 10 分钟内最多记一条。
 * 只写该聊天自己的范围（chat:* 或主人私聊的 owner:chat），绝不写 owner / owner:work。
 */

const ACTOR = 'qq:correction'
const NOTE_COOLDOWN_MS = 10 * 60 * 1000
const NOTE_MAX = 80

const WRITABLE = (scope) => /^chat:(group|private):\d+$/.test(scope) || scope === 'owner:chat'

export class CorrectionLedger {
  /**
   * @param {object} opts
   * @param {{ on: Function }} opts.signals
   * @param {import('../memory/index.js').MemoryStore|null} [opts.store]
   */
  constructor({ signals, store = null, log = null, now = () => Date.now() }) {
    this.signals = signals
    this.store = store
    this.log = log
    this.now = now
    /** scope → { correction, followup, 'gui-takeover', 'tool-fail', 'handoff-miss', lastAt } */
    this.byScope = new Map()
    this.noteAt = new Map()
    this.stats = { received: 0, notes: 0, ignored: 0 }
    this.off = null
  }

  start() {
    if (this.off || !this.signals) return this
    this.off = this.signals.on((event) => {
      try {
        this.handle(event)
      } catch (error) {
        this.log?.warn?.(`[correction] 处理信号出错: ${error?.message ?? error}`)
      }
    })
    return this
  }

  stop() {
    this.off?.()
    this.off = null
  }

  handle(event) {
    if (!event || event.source !== 'qq') return
    this.stats.received += 1
    const scope = String(event.scope ?? '')
    if (!WRITABLE(scope)) {
      this.stats.ignored += 1
      return
    }
    const row = this.byScope.get(scope) ?? { lastAt: 0 }
    row[event.kind] = (row[event.kind] ?? 0) + 1
    row.lastAt = event.at ?? this.now()
    this.byScope.set(scope, row)

    if (event.kind !== 'correction' || !this.store || !event.quote) return
    const last = this.noteAt.get(scope) ?? 0
    if (this.now() - last < NOTE_COOLDOWN_MS) return
    this.noteAt.set(scope, this.now())
    const out = this.store.observe({
      scope, kind: 'avoid', text: `被纠正过：${String(event.quote).slice(0, NOTE_MAX)}`, actor: ACTOR, origin: 'model',
      confidence: 0.3, status: 'candidate', source: { sessionId: event.sessionId, at: event.at, quote: event.quote },
    })
    if (out.action === 'new' || out.action === 'ask') {
      this.stats.notes += 1
      this.store.flush?.()
    }
  }

  snapshot() {
    return {
      ...this.stats,
      scopes: [...this.byScope].map(([scope, row]) => ({ scope, ...row })).sort((a, b) => b.lastAt - a.lastAt).slice(0, 50),
    }
  }
}

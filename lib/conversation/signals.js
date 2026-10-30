/**
 * 常驻会话里的负反馈信号（PLAN 第 12 条）：只采集，不下结论。
 *
 * 相关调研的结论是规则判“用户在纠正我”的折外 F1 只有 0.46 左右，LLM 复盘不比规则好还不可复现，
 * 所以这里只记原始事件，按可信度分两档：
 *   高  gui-takeover   用户在 DSH 里自己接手了这台 QQ 会话（回合不是插件发起的）——精确信号
 *   高  tool-fail      同一个工具连续失败 ≥ 2 次
 *   低  correction     用户的话以“不对 / 别这样 / 我说的是……”这类明确的纠正开头
 *   低  followup       用户的话是“什么意思 / 没懂 / 再说一遍”这类追问
 *   低  not-like       用户说 bot “不像你 / 你怎么变了 / 太官方”（短句），记成这个聊天绑定的人格的反馈候选
 * 事件走进程内信号总线（lib/core/signals.js）。每条带：范围、会话、序号、时间、脱敏后的原话（≤ 120 字）、
 * 当时的记忆版本号（让判定的一方知道当时注入的是哪一版）。QQ 里的信号只对应该聊天自己的范围，绝不对应主人的 owner / owner:work。
 */
import { redact } from '../core/redact.js'
import { userMessageFromEvent, toolResultCallId } from './relay.js'
import { userWords } from './handoff-miss.js'

const QUOTE_MAX = 120
/** 同一个会话里“被 GUI 接手”最多每 5 分钟报一次 */
const TAKEOVER_COOLDOWN_MS = 5 * 60 * 1000
/** 同一个工具连续失败：第 2 次报一次，之后每多 3 次再报一次 */
const FAIL_FIRST = 2
const FAIL_EVERY = 3
const CALLS_MAX = 300

/** 明确的纠正：只认句首，宁漏勿错 */
const CORRECTION = /^(不对|不是的|不是这样|不是这个意思|不是这样的|你搞错了|你弄错了|错了|别这样|不要这样|别这么|我说的是|我的意思是|我刚才说的是|我不是这个意思)/
/** 人格反馈：说 bot 不像它平时的样子。要求是短句，免得长段话里碰巧带了这几个字 */
const NOT_LIKE = /(不像你|不太像你|不像以前|你怎么变了|你变了|太官方|太客服|太正式|不是你的风格|不是你平时|跟以前不一样)/
const NOT_LIKE_MAX_CHARS = 30
const FOLLOWUP = /^(什么意思|没懂|没看懂|没听懂|再说一遍|能再说|你再说一遍|说人话)/

const clip = (text, max = QUOTE_MAX) => redact(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max)

export function classifyUserWords(words) {
  if (words.length <= NOT_LIKE_MAX_CHARS && NOT_LIKE.test(words)) return 'not-like'
  if (CORRECTION.test(words)) return 'correction'
  if (FOLLOWUP.test(words)) return 'followup'
  return ''
}

export class SignalCollector {
  /**
   * @param {object} opts
   * @param {{ emit: Function }} opts.signals
   * @param {{ chatForSession: Function, isPluginRequest: Function }} opts.bridge
   * @param {import('./chat-memory.js').ChatMemory} [opts.memory] 取范围和记忆版本号
   */
  constructor({ signals, bridge, memory = null, log = null, now = () => Date.now() }) {
    this.signals = signals
    this.bridge = bridge
    this.memory = memory
    this.log = log
    this.now = now
    /** callId → 工具名 */
    this.calls = new Map()
    /** `${sessionId}|${工具名}` → 连续失败次数 */
    this.fails = new Map()
    /** sessionId → 上次报 gui-takeover 的时间 */
    this.takeoverAt = new Map()
    /** sessionId → 最近一条 assistant 正文（纠正的上下文） */
    this.lastAssistant = new Map()
    this.stats = { emitted: 0, correction: 0, followup: 0, 'not-like': 0, takeover: 0, toolFail: 0 }
  }

  #emit(kind, chat, sessionId, event, confidence, extra = {}) {
    const chatKey = `${chat.chatType}:${chat.chatId}`
    let scope = `chat:${chatKey}`
    let memoryRevision
    try {
      if (this.memory) {
        scope = this.memory.scopeOf(chatKey)
        memoryRevision = this.memory.revisionOf(chatKey)
      }
    } catch {
      /* 取不到版本号不影响采集 */
    }
    this.stats.emitted += 1
    this.signals?.emit({ kind, source: 'qq', scope, chatKey, sessionId, seq: event?.seq, at: this.now(), confidence, memoryRevision, ...extra })
  }

  /** 订阅 session/event 的回调 */
  onEvent(session, event) {
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return
    const chat = this.bridge.chatForSession(sessionId)
    // 只管常驻对接会话；子代理、归档的旧会话不采
    if (!chat || chat.kind !== 'root') return
    switch (event?.type) {
      case 'tool/call': {
        const callId = String(event.data?.callId ?? '')
        if (callId) {
          this.calls.set(callId, String(event.data?.name ?? ''))
          if (this.calls.size > CALLS_MAX) this.calls.delete(this.calls.keys().next().value)
        }
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const callId = toolResultCallId(message)
        const name = this.calls.get(callId) ?? ''
        if (!name) break
        const key = `${sessionId}|${name}`
        if (message?.isError === true) {
          const n = (this.fails.get(key) ?? 0) + 1
          this.fails.set(key, n)
          if (n === FAIL_FIRST || (n > FAIL_FIRST && (n - FAIL_FIRST) % FAIL_EVERY === 0)) {
            this.stats.toolFail += 1
            this.#emit('tool-fail', chat, sessionId, event, 'high', { quote: clip(`${name} 连续失败 ${n} 次`) })
          }
        } else {
          this.fails.delete(key)
        }
        break
      }
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''
        if (text) this.lastAssistant.set(sessionId, text)
        break
      }
      case 'user/message': {
        const message = userMessageFromEvent(event)
        const source = message?.source
        if (source?.kind !== 'user') break
        const rpcId = typeof source.rpcId === 'string' ? source.rpcId : ''
        if (!(rpcId && this.bridge.isPluginRequest?.(sessionId, rpcId) === true)) {
          const last = this.takeoverAt.get(sessionId) ?? 0
          if (this.now() - last >= TAKEOVER_COOLDOWN_MS) {
            this.takeoverAt.set(sessionId, this.now())
            this.stats.takeover += 1
            this.#emit('gui-takeover', chat, sessionId, event, 'high')
          }
          break
        }
        const content = Array.isArray(message?.content) ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
        const words = userWords(content)
        const kind = classifyUserWords(words)
        if (kind) {
          this.stats[kind] += 1
          this.#emit(kind, chat, sessionId, event, 'low', { quote: clip(words), prevAssistant: clip(this.lastAssistant.get(sessionId) ?? '') })
        }
        break
      }
      default:
        break
    }
  }

  forget(sessionId) {
    for (const key of [...this.fails.keys()]) if (key.startsWith(`${sessionId}|`)) this.fails.delete(key)
    this.takeoverAt.delete(sessionId)
    this.lastAssistant.delete(sessionId)
  }

  snapshot() {
    return { ...this.stats, tracked: this.calls.size }
  }
}

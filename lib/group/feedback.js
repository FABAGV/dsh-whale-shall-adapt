/**
 * 主动插话的事后反馈（PLAN 第 37、44 条）。
 *
 * bot 没被叫到、自己插了一句话之后，盯着接下来一小段时间发生了什么：
 *   engaged   被接住：有人回复了这条、@ 了 bot、叫了它的名字
 *   rejected  被嫌弃：有人说“闭嘴 / 没问你”之类，或这条消息被别人撤回
 *   silence   冷场或被晾着：窗口内群里没人理它（一条消息都没有，或者聊的都是别的），只记着，权重最低
 * 另有 bot 被禁言（muted），算很强的负反馈。
 *
 * 规则判得不准（相关调研里规则判纠正的 F1 只有 0.46 左右），所以这里宁可漏判：
 * “嫌弃”只认明确的话，而且要出现在 bot 插话之后的前几条消息里、并且是对 bot 说的（回复了它、@ 了它、叫了它的名字，或紧跟在它后面一条）。
 * 结果只拿来调插话倾向的权重，不当事实。
 */

/** 观察窗口 */
export const FEEDBACK_WINDOW_MS = 5 * 60 * 1000
/** 嫌弃的话要出现在插话之后的前几条消息里才算 */
const REJECT_WITHIN_MESSAGES = 3

const REJECT = /(闭嘴|别插嘴|别说话|少说两句|没问你|没叫你|谁问你|谁让你说|没人问你|不要你说|你好吵|太吵了|别吵|滚|bot.{0,3}(闭嘴|别说|烦))/i

export class InterjectFeedback {
  /**
   * @param {object} opts
   * @param {(chatKey: string, result: 'engaged'|'rejected'|'silence'|'muted'|'recalled', detail: object) => void} opts.onResult
   */
  constructor({ onResult, now = () => Date.now(), windowMs = FEEDBACK_WINDOW_MS } = {}) {
    this.onResult = onResult
    this.now = now
    this.windowMs = windowMs
    /** chatKey → 正在观察的那一次插话 */
    this.watching = new Map()
  }

  /** bot 刚主动插了一句。messageId 是发出去的那条（可能拿不到） */
  start(chatKey, { messageId = '', at = this.now(), anchorSenderId = '' } = {}) {
    // 上一次还没出结果就又插话了：上一次按“没有明确反馈”收掉，不记
    this.watching.set(chatKey, { messageId: String(messageId ?? ''), at, anchorSenderId, seen: 0, rejectedBy: new Set() })
  }

  /**
   * 群里来了一条消息。
   * @param {object} m { senderId, text, addressed, replyToMessageId }
   */
  noteInbound(chatKey, m) {
    const w = this.watching.get(chatKey)
    if (!w) return
    const at = this.now()
    if (at - w.at > this.windowMs) {
      this.watching.delete(chatKey)
      this.onResult?.(chatKey, 'silence', { reason: 'ignored' })
      return
    }
    w.seen += 1
    const toBot = Boolean(m.addressed) || (w.messageId && String(m.replyToMessageId ?? '') === w.messageId)
    const rejecting = REJECT.test(String(m.text ?? ''))
    if (rejecting && (toBot || w.seen <= REJECT_WITHIN_MESSAGES)) {
      this.watching.delete(chatKey)
      this.onResult?.(chatKey, 'rejected', { senderId: m.senderId, quote: String(m.text ?? '').slice(0, 80) })
      return
    }
    if (toBot && !rejecting) {
      this.watching.delete(chatKey)
      this.onResult?.(chatKey, 'engaged', { senderId: m.senderId })
    }
  }

  /** 有消息被撤回。operatorIsBot=true 表示是 bot 自己撤的，不算反馈 */
  noteRecall(chatKey, messageId, { operatorIsBot = false } = {}) {
    const w = this.watching.get(chatKey)
    if (operatorIsBot || !w || !w.messageId || String(messageId) !== w.messageId) return false
    this.watching.delete(chatKey)
    this.onResult?.(chatKey, 'recalled', { messageId: String(messageId) })
    return true
  }

  /** bot 被禁言 */
  noteMuted(chatKey) {
    this.watching.delete(chatKey)
    this.onResult?.(chatKey, 'muted', {})
  }

  /** 定时扫：窗口过了还没有任何结果 = 冷场 */
  sweep() {
    const at = this.now()
    for (const [chatKey, w] of this.watching) {
      if (at - w.at <= this.windowMs) continue
      this.watching.delete(chatKey)
      this.onResult?.(chatKey, 'silence', { reason: w.seen === 0 ? 'no-messages' : 'ignored' })
    }
  }

  clear() {
    this.watching.clear()
  }
}

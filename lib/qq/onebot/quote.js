/**
 * 引用解析（UX 第 25 条）：QQ 里“回复某条消息”只带一个 reply 段（被引用消息的 id），
 * 模型看到的只有“[引用]”两个字，不知道用户在接哪句话。这里用 get_msg 取回原文，
 * 渲染成 `[引用 发送者: 原文]` 接在正文前面；引用的是 bot 自己说的话时，发送者后面标“(你)”。
 */
import { normalizeSegments, plainText, displayName } from './normalize.js'

/** 引用原文最多保留多少字：只是给模型接上下文，不需要整段 */
export const QUOTE_MAX_CHARS = 200
const GET_MSG_TIMEOUT_MS = 3000

/** 这条消息引用了哪条消息；没有引用返回 '' */
export function quotedMessageId(message) {
  const seg = (message?.segments ?? []).find((s) => s.kind === 'reply')
  return seg?.messageId ? String(seg.messageId) : ''
}

/**
 * 取回被引用的那条消息。取不到（连接断了、消息太旧、协议端不支持）返回 `{ ok:false }`，不抛。
 * @param {{ call: Function } | null} conn
 * @param {object} message 归一化后的消息
 * @param {{ isOwnMessage?: (id:string) => boolean }} [opts]
 */
export async function resolveQuote(conn, message, { isOwnMessage } = {}) {
  const id = quotedMessageId(message)
  if (!id) return null
  const ownById = typeof isOwnMessage === 'function' && isOwnMessage(id)
  if (!conn || typeof conn.call !== 'function') return { ok: false, messageId: id, fromSelf: ownById }
  try {
    const data = await conn.call('get_msg', { message_id: Number(id) || id }, { timeoutMs: GET_MSG_TIMEOUT_MS })
    const senderId = String(data?.sender?.user_id ?? data?.user_id ?? '')
    const selfId = String(message.selfId ?? '')
    const segments = normalizeSegments(data?.message ?? data?.raw_message ?? '')
    const text = plainText({ segments, selfId }).replace(/^\[引用\]\s*/, '')
    return {
      ok: true,
      messageId: id,
      senderId,
      senderName: displayName(data?.sender, senderId),
      text,
      fromSelf: ownById || (Boolean(selfId) && senderId === selfId),
    }
  } catch {
    return { ok: false, messageId: id, fromSelf: ownById }
  }
}

/** 渲染成给模型看的一行 */
export function formatQuote(quote) {
  if (!quote) return ''
  if (!quote.ok) {
    return quote.fromSelf ? '[引用 你之前说的一条消息，原文取不到]' : '[引用了一条消息，原文取不到]'
  }
  const flat = String(quote.text ?? '').replace(/\s+/g, ' ').trim()
  const body = flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS - 1)}…` : flat
  const who = quote.fromSelf ? `${quote.senderName || '你'}(你)` : quote.senderName || quote.senderId || '某人'
  return `[引用 ${who}: ${body || '（没有文字）'}]`
}

/** 把正文里 plainText 留下的“[引用]”占位换成解析好的那一行 */
export function withQuote(text, quoteLine) {
  const rest = String(text ?? '').replace(/^\s*\[引用\]\s*/, '').trim()
  if (!quoteLine) return rest || String(text ?? '')
  return rest ? `${quoteLine}\n${rest}` : quoteLine
}

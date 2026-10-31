/**
 * 消息里的媒体（图片 / 语音 / 视频）→ 给会话的一段说明。
 *
 * 两件事：
 *   1. **地址**：OneBot 事件里 image/record/video 段本来就带 `url`（NapCat 给的 CDN 地址）。
 *      以前 `plainText()` 只输出 `[图片]`，模型看不到地址，也没法在回复里引用；
 *      这里把地址补进投递给会话的正文。**只展示，不抓取**（抓取仍走 `get_image`，见 image.js）。
 *   2. **语音转写**：NapCat 有 `fetch_ptt_text`（QQ 自带的语音转文字），按 message_id 取回文字。
 *      取不到就只给地址，不影响消息投递。
 *
 * ⚠️ 地址是外部数据：只当文本放进提示词，不拼进任何请求、不当路径用。
 */
const VOICE_CACHE_TTL_MS = 10 * 60 * 1000
const VOICE_CACHE_MAX = 200
const URL_MAX = 1000

/** @type {Map<string, { at: number, text: string }>} */
const voiceCache = new Map()

const withTimeout = (promise, ms) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('语音转写超时')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function trimVoiceCache() {
  if (voiceCache.size <= VOICE_CACHE_MAX) return
  for (const key of voiceCache.keys()) {
    voiceCache.delete(key)
    if (voiceCache.size <= VOICE_CACHE_MAX) break
  }
}

/** 测试用：清掉转写缓存 */
export function resetVoiceCache() {
  voiceCache.clear()
}

/** 语音消息（只认有 messageId 的，转写按 message_id 取） */
export function voiceSegments(message) {
  return (message?.segments ?? []).filter((s) => s.kind === 'record')
}

function shortenUrl(url) {
  const s = String(url ?? '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return ''
  return s.length > URL_MAX ? `${s.slice(0, URL_MAX)}…` : s
}

/**
 * 把一条消息里的媒体整理成给会话的一段文字。没有可用信息时返回空串。
 *
 * @param {object} message 归一化后的消息
 * @param {{ urls?: boolean, transcript?: string }} [options]
 *   urls：是否带地址（默认带）；transcript：语音转写结果（没有就只给地址）
 * @returns {string}
 */
export function mediaBlock(message, { urls = true, transcript = '' } = {}) {
  const segments = (message?.segments ?? []).filter(
    (s) => s.kind === 'image' || s.kind === 'video' || s.kind === 'record',
  )
  if (segments.length === 0) return ''
  const lines = []
  let index = 0
  for (const seg of segments) {
    index += 1
    const url = urls ? shortenUrl(seg.url) : ''
    const voice = seg.kind === 'record' && transcript ? `　转写：「${transcript}」` : ''
    if (!url && !voice) continue
    const label = seg.kind === 'image' ? '图片' : seg.kind === 'record' ? '语音' : '视频'
    lines.push(`- ${label} ${index}${url ? `：${url}` : ''}${voice}`)
  }
  if (lines.length === 0) return ''
  return `[媒体]\n${lines.join('\n')}`
}

/**
 * 语音转文字：调 NapCat 的 `fetch_ptt_text`（QQ 自带的转写），按 message_id 缓存。
 * 失败、超时、没开、没有语音都返回空串 —— 调用方只当“没有转写”。
 *
 * @param {{ call: (action: string, params: object) => Promise<any> }|null} conn
 * @param {object} message
 * @param {{ enabled?: boolean, timeoutMs?: number, maxChars?: number }} [options]
 * @returns {Promise<string>}
 */
export async function loadVoiceText(conn, message, options = {}) {
  const { enabled = true, timeoutMs = 4000, maxChars = 500 } = options
  if (!enabled) return ''
  if (voiceSegments(message).length === 0) return ''
  if (!conn || typeof conn.call !== 'function') return ''
  const messageId = String(message?.messageId ?? '')
  if (!messageId) return ''

  const hit = voiceCache.get(messageId)
  if (hit && Date.now() - hit.at < VOICE_CACHE_TTL_MS) return hit.text

  let text = ''
  try {
    const result = await withTimeout(conn.call('fetch_ptt_text', { message_id: messageId }), timeoutMs)
    // NapCat 返回 { text }；兼容极少数实现把结果包在 data 里
    text = String(result?.text ?? result?.data?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars)
  } catch {
    text = ''
  }
  voiceCache.set(messageId, { at: Date.now(), text })
  trimVoiceCache()
  return text
}

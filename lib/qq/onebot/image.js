/**
 * QQ 消息里的图片 → 随消息一起交给常驻会话的模型看（UX 第 40 条）。
 *
 * 做法：不自己调视觉模型，也不自己下载图片 URL。图片由 NapCat 经 OneBot 的 `get_image` 取回（本机，不出站），
 * 校验魔数和大小之后，以 `{ type: 'image', mediaType, data(base64) }` 放进 `sessions.prompt` 的 content——
 * 这是宿主 prompt 接口本来就接受的形状，宿主会把它存成附件并核对当前会话的模型是否支持看图
 * （`dsh-api-session-controller` 的 `prompt()`：不支持时抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`，由 bridge 退回纯文字）。
 *
 * 安全：
 *   - 不信事件里的 URL 和路径，只用 `get_image` 返回的内容；读本地文件时只认图片魔数，类型以魔数为准，不看扩展名；
 *   - 每条消息最多 maxImages 张，单张不超过 maxBytes；
 *   - 取不到、太大、不是图片都只是少一张图，不影响文字消息的投递。
 */
import fs from 'node:fs'
import path from 'node:path'

export const IMAGE_DEFAULTS = Object.freeze({ maxImages: 3, maxBytes: 4 * 1024 * 1024, timeoutMs: 5000 })

/** 魔数 → 媒体类型。认不出就不是我们要的图片。 */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return ''
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return ''
}

/** 消息里的图片段（有 file 标识才取得回来） */
export function imageSegments(message) {
  return (message?.segments ?? []).filter((s) => s.kind === 'image' && s.file)
}

const withTimeout = (promise, ms) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('取图超时')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {{ call: (action: string, params: object) => Promise<any> }|null} conn OneBot 连接
 * @param {object} message 归一化后的消息
 * @param {{ maxImages?: number, maxBytes?: number, timeoutMs?: number, readFile?: Function }} [options]
 * @returns {Promise<{ images: Array<{ mediaType: string, data: string, name: string }>, skipped: number }>}
 */
export async function loadImages(conn, message, options = {}) {
  const { maxImages, maxBytes, timeoutMs } = { ...IMAGE_DEFAULTS, ...options }
  const readFile = options.readFile ?? ((file) => fs.promises.readFile(file))
  const segments = imageSegments(message)
  const images = []
  let skipped = Math.max(0, segments.length - maxImages)
  if (!conn || typeof conn.call !== 'function') return { images, skipped: segments.length }
  for (const segment of segments.slice(0, maxImages)) {
    try {
      const data = await withTimeout(conn.call('get_image', { file: segment.file }), timeoutMs)
      let bytes = null
      if (typeof data?.base64 === 'string' && data.base64) bytes = Buffer.from(data.base64, 'base64')
      else if (typeof data?.file === 'string' && path.isAbsolute(data.file)) bytes = await readFile(data.file)
      if (!bytes || bytes.length === 0 || bytes.length > maxBytes) {
        skipped += 1
        continue
      }
      const mediaType = sniffImageType(bytes)
      if (!mediaType) {
        skipped += 1
        continue
      }
      images.push({ mediaType, data: Buffer.from(bytes).toString('base64'), name: `qq-${images.length + 1}.${mediaType.split('/')[1]}` })
    } catch {
      skipped += 1
    }
  }
  return { images, skipped }
}

/** 给模型的一句说明：附了几张、有几张没取到 */
export function imageNote({ attached, skipped, unsupported = false }) {
  if (unsupported) return '（这条消息带图片，但当前模型不支持看图，你看不到。如实告诉对方，不要猜图里是什么。）'
  if (attached > 0 && skipped > 0) return `（随消息附了 ${attached} 张图，另有 ${skipped} 张没取到。）`
  if (attached > 0) return `（随消息附了 ${attached} 张图。）`
  if (skipped > 0) return `（这条消息带 ${skipped} 张图，但没能取回来，你看不到。如实告诉对方，不要猜图里是什么。）`
  return ''
}

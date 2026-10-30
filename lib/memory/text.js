/**
 * 记忆层用的纯文本工具：判重、相似度、token 估算。都不碰磁盘。
 *
 * 相似度用字符 3-gram 的 Jaccard：中文没有词边界，"还差参考文献" 与 "参考文献还没弄"
 * 编辑距离很大，3-gram 重合度却高。归一化只用于判等和相似度，渲染一律用原文。
 */

const PUNCT = /[\s，。、；：？！,.;:?!"'“”‘’()（）[\]【】《》<>~～—\-_/\\|`*#]/g

export function normText(text) {
  return String(text ?? '').toLowerCase().replace(PUNCT, '')
}

export function shingles(norm) {
  const s = String(norm ?? '')
  const out = new Set()
  if (s.length <= 3) {
    if (s.length > 0) out.add(s)
    return out
  }
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
  return out
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : shingles(normText(a))
  const B = b instanceof Set ? b : shingles(normText(b))
  if (A.size === 0 || B.size === 0) return 0
  const [small, large] = A.size <= B.size ? [A, B] : [B, A]
  let inter = 0
  for (const g of small) if (large.has(g)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 与画像侧注入预算同一口径：中日韩字符 1 个 ≈ 1 token，其余 4 个字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk += 1
  return cjk + Math.ceil((s.length - cjk) / 4)
}

/** FNV-1a 32 位指纹：只用来判断“这句话是不是被要求忘掉过”，不保留原文。 */
export function fingerprint(text) {
  const s = normText(text)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 压成一行并截断：去掉换行、Markdown 标题和代码围栏。 */
export function oneLine(text, max) {
  const s = String(text ?? '')
    .replace(/```+/g, ' ')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max) : s
}

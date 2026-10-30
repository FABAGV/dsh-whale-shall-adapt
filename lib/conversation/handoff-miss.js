/**
 * 交班回看（PLAN 第 17 条）：新一代会话里，用户把上一代说过的话又交代了一遍，说明交接漏了。
 *
 * 规则预筛，不多调一次模型：
 *   - 新用户发言和上一代最后几条用户原话的 3-gram 相似度 ≥ 0.4（用户在重复交代；换个说法重复时只有 0.4 多，0.5 会漏掉）；
 *   - 并且和这个聊天里所有现存记忆的相似度都 < 0.3（记忆和交接束里都没有这件事）。
 * 命中的补成记忆，并发一条 handoff-miss 信号。只在新一代的前几次空闲整理里看（passes < MAX_PASSES）。
 *
 * 规则判得不准，所以补进去的置信度只有 0.5，来源是模型，用户在控制台里照样可以判“不对”。
 */
import { jaccard, normText, shingles } from '../memory/text.js'

/** 交班时留下上一代最后几条用户原话 */
export const TAIL_LINES = 15
/** 新一代前几次空闲整理里才回看 */
export const MAX_PASSES = 3
const SIMILAR_TO_PREVIOUS = 0.4
const SIMILAR_TO_MEMORY = 0.3
const MIN_CHARS = 8
const LINE_MAX = 120
const MEMORY_TEXT_MAX = 60
const MAX_MISSES = 2

const HEADER = /^\[来自 QQ[^\]\n]*\]\s*\n?/

/** 去掉插件给每条消息加的来源标注、群背景和梗百科附注，只留用户说的话 */
export function userWords(text) {
  let body = String(text ?? '').replace(HEADER, '')
  body = body.replace(/^【群里刚才在聊[^\n]*\n(?:[^\n]*\n)*?\n/, '')
  body = body.split('\n[附：梗百科')[0]
  return body.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX)
}

/**
 * 交班时调用：从被整理的对话里取出最后几条用户原话。
 * @param {Array<{ role: string, text: string }>} lines foldEvents 的结果
 */
export function userTailOf(lines, n = TAIL_LINES) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => l?.role === '用户')
    .map((l) => userWords(l.text))
    .filter((t) => t.length >= MIN_CHARS)
    .slice(-n)
}

/**
 * @param {object} input
 * @param {string[]} input.fresh 新一代里新增的用户发言（原文，含来源标注也行）
 * @param {string[]} input.tail 上一代最后几条用户原话
 * @param {string[]} input.existing 这个聊天现有的记忆文本
 * @returns {Array<{ text: string, quote: string, similarity: number }>}
 */
export function findHandoffMisses({ fresh, tail, existing }) {
  const tailSets = (tail ?? []).map((t) => shingles(normText(t)))
  const memorySets = (existing ?? []).map((t) => shingles(normText(t)))
  if (tailSets.length === 0) return []
  const out = []
  const seen = new Set()
  for (const raw of fresh ?? []) {
    const line = userWords(raw)
    if (line.length < MIN_CHARS || seen.has(line)) continue
    const set = shingles(normText(line))
    const similarity = Math.max(0, ...tailSets.map((t) => jaccard(set, t)))
    if (similarity < SIMILAR_TO_PREVIOUS) continue
    if (memorySets.some((m) => jaccard(set, m) >= SIMILAR_TO_MEMORY)) continue
    seen.add(line)
    out.push({ text: line.slice(0, MEMORY_TEXT_MAX), quote: line, similarity: Math.round(similarity * 100) / 100 })
    if (out.length >= MAX_MISSES) break
  }
  return out
}

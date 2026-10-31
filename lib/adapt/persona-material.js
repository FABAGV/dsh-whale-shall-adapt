/**
 * 模仿群友的素材：从语料里切出「场景」（别人刚说了什么 → 他怎么接），按他的真实发言算统计。
 *
 * 场景给生成用的模型读，模型挑几段最像他的；存进版本、随人格一起注入的是语料里的原话，不是模型改写的。
 * 统计是本地实算的：一条消息多长、标点怎么用、哪些词他比别人常说、出现在多少比例的消息里。
 * 写进生成提示词，模型照真实比例写，不会把一个口头禅写成"每句都带"。
 */
import { memberIdOf } from './qq-corpus.js'
import { redact } from '../core/redact.js'

const OTHER_NAMES = ['甲', '乙', '丙', '丁', '戊']
const MAX_EXCERPTS = 12
const MAX_EXCERPT_LINES = 6
const MAX_LINE_CHARS = 200
const MAX_NAME_CHARS = 40
/** 同一个人两条消息隔得比这短、中间没有别人说话，算一次连着说 */
const BURST_GAP_MS = 3 * 60 * 1000
const PUNCT = /[，。！？、；：,.!?;:～~…]/
const EMOJI = /\p{Extended_Pictographic}|\[[^\]\s]{1,8}\]/u
const WORD_RUN = /[\p{L}\p{N}]+/gu

const charCount = (text) => Array.from(String(text ?? '').replace(/\s+/g, '')).length
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : 0)
const oneLine = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 他的发言切成场景：前面最多 contextLines 条别人的话（gapMs 之内）+ 他连着说的最多 burstLines 条。
 * 从最新的往回取，条数或字数用完为止；返回时按时间升序，编号从 1 开始。
 * 别人的名字在每个场景里各自换成甲乙丙，文字过一遍脱敏。
 * @param {object[]} records `readChatRecords()` 的结果（时间升序）
 * @returns {Array<{n:number, ts:number, lines:Array<{who:'self'|'other', name:string, text:string}>}>}
 */
export function memberScenes(records, memberId, { maxScenes = 200, maxChars = 30000, contextLines = 2, burstLines = 3, gapMs = 10 * 60 * 1000 } = {}) {
  const scenes = []
  const seen = new Set()
  let chars = 0
  let index = records.length - 1
  while (index >= 0 && scenes.length < maxScenes) {
    if (memberIdOf(records[index]) !== memberId) {
      index -= 1
      continue
    }
    let start = index
    while (start > 0 && memberIdOf(records[start - 1]) === memberId && records[start].ts - records[start - 1].ts <= BURST_GAP_MS) start -= 1
    const own = records.slice(start, Math.min(index + 1, start + burstLines))
    const context = []
    for (let back = start - 1; back >= 0 && context.length < contextLines; back -= 1) {
      const record = records[back]
      if (memberIdOf(record) === memberId || records[start].ts - record.ts > gapMs) break
      context.unshift(record)
    }
    index = start - 1
    const key = own.map((r) => r.text).join('\n')
    if (seen.has(key)) continue
    seen.add(key)
    const names = new Map()
    const nameOf = (record) => {
      const id = memberIdOf(record) || '?'
      if (!names.has(id)) names.set(id, OTHER_NAMES[names.size] ?? '别人')
      return names.get(id)
    }
    const lines = [
      ...context.map((r) => ({ who: 'other', name: nameOf(r), text: oneLine(redact(r.text), 120) })),
      ...own.map((r) => ({ who: 'self', name: '', text: oneLine(redact(r.text), MAX_LINE_CHARS) })),
    ].filter((line) => line.text)
    if (!lines.some((line) => line.who === 'self')) continue
    const cost = lines.reduce((sum, line) => sum + line.text.length + 4, 0)
    if (chars + cost > maxChars && scenes.length > 0) break
    chars += cost
    scenes.push({ ts: own[0].ts, lines })
  }
  return scenes.reverse().map((scene, i) => ({ n: i + 1, ...scene }))
}

function gramsOf(text) {
  const out = new Set()
  for (const run of String(text ?? '').toLowerCase().match(WORD_RUN) ?? []) {
    const chars = Array.from(run)
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= chars.length; i += 1) {
        const gram = chars.slice(i, i + n).join('')
        if (!/^\d+$/.test(gram)) out.add(gram)
      }
    }
  }
  return out
}

function countGrams(texts) {
  const counts = new Map()
  for (const text of texts) for (const gram of gramsOf(text)) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  return counts
}

/** 他比别人明显常说的词：至少 3 条、至少 3% 的消息里有，而且比例是别人的两倍以上（或者自己就占了两成以上） */
function distinctivePhrases(own, others, max) {
  const ownCounts = countGrams(own)
  const otherCounts = countGrams(others)
  const candidates = []
  for (const [gram, count] of ownCounts) {
    const ownShare = count / own.length
    if (count < 3 || ownShare < 0.03) continue
    const otherShare = others.length ? (otherCounts.get(gram) ?? 0) / others.length : 0
    if (ownShare < 0.2 && ownShare / Math.max(otherShare, 0.01) < 2) continue
    candidates.push({ text: gram, count, share: ownShare })
  }
  // 短词几乎总是出现在某个长词里时，留长的那个（"哈哈"和"哈哈哈"只留后者）
  candidates.sort((a, b) => b.text.length - a.text.length || b.count - a.count)
  const kept = []
  for (const c of candidates) {
    if (kept.some((k) => k.text.includes(c.text) && k.count >= c.count * 0.8)) continue
    kept.push(c)
  }
  return kept
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((c) => ({ text: redact(c.text), count: c.count, share: ratio(c.count, own.length) }))
}

/** 原样说过好几次的短句（"笑死""6""草"这种） */
function repeatedLines(texts, max) {
  const counts = new Map()
  for (const text of texts) {
    const key = text.replace(/\s+/g, ' ').trim().replace(/[，。！？、；：,.!?;:～~…]+$/u, '').toLowerCase()
    if (!key || charCount(key) > 12) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([text, count]) => ({ text: redact(text), count }))
}

/**
 * 按他的真实发言算的统计。没有他的发言时返回 null。
 * @param {object[]} records `readChatRecords()` 的结果（时间升序）
 */
export function memberStats(records, memberId, { maxPhrases = 8, maxRepeats = 6 } = {}) {
  const own = []
  const others = []
  for (let i = 0; i < records.length; i += 1) {
    if (memberIdOf(records[i]) === memberId) own.push({ record: records[i], next: records[i + 1] ?? null })
    else others.push(String(records[i].text ?? ''))
  }
  if (own.length === 0) return null
  const texts = own.map(({ record }) => String(record.text ?? ''))
  const lengths = texts.map(charCount).sort((a, b) => a - b)
  const share = (test) => ratio(texts.filter(test).length, texts.length)
  const bursts = own.filter(({ record, next }) => next && memberIdOf(next) === memberId && next.ts - record.ts <= 60_000).length
  return {
    messages: own.length,
    medianChars: lengths[Math.floor((lengths.length - 1) / 2)],
    shortShare: share((t) => charCount(t) <= 5),
    longShare: share((t) => charCount(t) >= 30),
    questionShare: share((t) => /[？?]/.test(t)),
    exclaimShare: share((t) => /[！!]/.test(t)),
    periodShare: share((t) => /。\s*$/.test(t) || /(^|[^.])\.\s*$/.test(t)),
    ellipsisShare: share((t) => /…|\.{3}/.test(t)),
    tildeShare: share((t) => /[～~]/.test(t)),
    noPunctShare: share((t) => !PUNCT.test(t)),
    emojiShare: share((t) => EMOJI.test(t)),
    burstShare: ratio(bursts, own.length),
    phrases: distinctivePhrases(texts, others.slice(-8000), maxPhrases),
    repeats: repeatedLines(texts, maxRepeats),
  }
}

const pct = (x) => (x > 0 && x < 0.01 ? '不到 1%' : `${Math.round(x * 100)}%`)

/** 统计写成几行中文（生成提示词和控制台都用这一份） */
export function describeStats(stats) {
  if (!stats || !stats.messages) return ''
  const lines = [
    `一条消息的长度：中位数 ${stats.medianChars} 个字；5 个字以内的占 ${pct(stats.shortShare)}，30 个字以上的占 ${pct(stats.longShare)}`,
    `标点：带问号的占 ${pct(stats.questionShare)}，带感叹号的占 ${pct(stats.exclaimShare)}，句末用句号的占 ${pct(stats.periodShare)}，` +
      `带省略号的占 ${pct(stats.ellipsisShare)}，带波浪号的占 ${pct(stats.tildeShare)}；一个标点都没有的占 ${pct(stats.noPunctShare)}`,
    `表情：带 emoji 或表情的占 ${pct(stats.emojiShare)}`,
    `连发：说完紧接着自己又发一条（一分钟内）的占 ${pct(stats.burstShare)}`,
  ]
  if (stats.phrases?.length) lines.push(`比别人更常说的词（括号里是出现在他多少比例的消息里）：${stats.phrases.map((p) => `${p.text}（${pct(p.share)}）`).join('、')}`)
  if (stats.repeats?.length) lines.push(`原样说过好几次的话：${stats.repeats.map((r) => `「${r.text}」${r.count} 次`).join('、')}`)
  return `按他最近 ${stats.messages} 条发言实算：\n${lines.map((line) => `- ${line}`).join('\n')}`
}

/** 原话片段：只留形状对的，限条数、限长度；至少要有一句是他自己说的 */
export function cleanExcerpts(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const raw of list) {
    if (out.length >= MAX_EXCERPTS) break
    const lines = (Array.isArray(raw?.lines) ? raw.lines : [])
      .slice(0, MAX_EXCERPT_LINES)
      .map((line) => ({ who: line?.who === 'self' ? 'self' : 'other', name: line?.who === 'self' ? '' : oneLine(line?.name, MAX_NAME_CHARS), text: oneLine(line?.text, MAX_LINE_CHARS) }))
      .filter((line) => line.text)
    if (lines.some((line) => line.who === 'self')) out.push({ lines })
  }
  return out
}

function hashOf(text) {
  let h = 2166136261
  for (const ch of text) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 打乱成固定的顺序：不按时间、不按"最像"排（排得太整齐模型会学成套路），同一组片段每次结果一样 */
function scramble(list) {
  return [...list].sort((a, b) => hashOf(JSON.stringify(a)) - hashOf(JSON.stringify(b)))
}

/** 模型没挑或挑的编号都不对时，本地挑：有人接话、自己说了点东西的场景，按时间均匀取 */
function pickScenesLocally(scenes, count) {
  const good = scenes.filter((s) => s.lines.some((l) => l.who === 'other') && s.lines.some((l) => l.who === 'self' && charCount(l.text) >= 2))
  const pool = good.length >= count ? good : scenes
  if (pool.length <= count) return pool
  const step = pool.length / count
  return Array.from({ length: count }, (_, i) => pool[Math.floor(i * step + step / 2)])
}

/** 模型挑的场景编号 → 原话片段（原文照搬）。编号无效或重复的丢掉，一个都不对就本地挑。 */
export function scenesToExcerpts(scenes, picks = [], { max = 10 } = {}) {
  const byNumber = new Map(scenes.map((scene) => [scene.n, scene]))
  const chosen = []
  for (const raw of Array.isArray(picks) ? picks : []) {
    const scene = byNumber.get(Number(raw))
    if (scene && !chosen.includes(scene)) chosen.push(scene)
    if (chosen.length >= max) break
  }
  const list = chosen.length > 0 ? chosen : pickScenesLocally(scenes, Math.min(8, max))
  return scramble(cleanExcerpts(list.map((scene) => ({ lines: scene.lines }))))
}

/** 片段写成文本：一段一个场景，空行隔开，每行「名字: 说的话」。注入和控制台编辑框都用这个格式 */
export function excerptsToText(excerpts, selfName) {
  return cleanExcerpts(excerpts)
    .map((excerpt) => excerpt.lines.map((line) => `${line.who === 'self' ? selfName || '我' : line.name || '别人'}: ${line.text}`).join('\n'))
    .join('\n\n')
}

/** 控制台编辑框里的文本 → 片段。名字是他自己（或写"我"）的算他说的；没写名字的行也算他说的 */
export function parseExcerptText(text, selfName = '') {
  const out = []
  for (const block of String(text ?? '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = []
    for (const raw of block.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const match = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(line)
      if (!match || /^\d+$/.test(match[1].trim())) {
        lines.push({ who: 'self', name: '', text: line })
        continue
      }
      const name = match[1].trim()
      const self = name === '我' || (selfName && name === selfName)
      lines.push({ who: self ? 'self' : 'other', name: self ? '' : name, text: match[2] })
    }
    if (lines.length) out.push({ lines })
  }
  return cleanExcerpts(out)
}

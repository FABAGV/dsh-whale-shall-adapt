/**
 * 画像 → 统一记忆层的单向镜像（阶段 1 的过渡层）。
 *
 * 画像侧的注入和处置暂时还读写自己的 state.json；这里把每一版画像、工作笔记和用户打过的标记
 * 同步进记忆层，让记忆层先拿到完整数据。等注入改成直接读记忆层之后，这个文件和 state 里的旧字段一起删掉。
 *
 * 对应关系（docs/CONTRACTS.md 4.5）：
 *   A 稳定特质 → owner / trait        B 行不通的做法 → owner:work / avoid
 *   C 有效的做法 → owner:work / works  D 证据不足 → owner / uncertain（候选）
 *   工作笔记 → owner:work / note
 *   置顶 → judge pin    封印 → judge wrong    删除 → 条目已经不在画像里，按撤回处理
 *
 * 幂等：链接表存在画像 state 的 `memoryMirror` 里，同一版画像重复同步不会产生新记录。
 * 标记是用户在设置页或控制台按的按钮，所以以 'dsh-settings' 的身份裁决。
 */
import { fingerprint } from '../memory/text.js'

const ACTOR = 'profile'
const USER_ACTOR = 'dsh-settings'
const CATEGORY = {
  A: { scope: 'owner', kind: 'trait' },
  B: { scope: 'owner:work', kind: 'avoid' },
  C: { scope: 'owner:work', kind: 'works' },
  D: { scope: 'owner', kind: 'uncertain', status: 'candidate' },
}
const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 }

export function emptyMirror() {
  return { version: 1, entries: {}, notes: {}, marks: {} }
}

function mirrorOf(state) {
  const m = state.memoryMirror
  if (!m || typeof m !== 'object' || m.version !== 1) state.memoryMirror = emptyMirror()
  for (const key of ['entries', 'notes', 'marks']) {
    if (!state.memoryMirror[key] || typeof state.memoryMirror[key] !== 'object') state.memoryMirror[key] = {}
  }
  return state.memoryMirror
}

const sourcesOf = (entry) =>
  (Array.isArray(entry.evidence) ? entry.evidence : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .slice(0, 5)
    .map((quote) => ({ sessionId: '', quote }))

function observeEntry(memory, entry) {
  const spec = CATEGORY[entry.category]
  if (!spec || !entry.claim) return null
  const sources = sourcesOf(entry)
  const first = memory.observe({
    scope: spec.scope,
    kind: spec.kind,
    text: entry.claim,
    actor: ACTOR,
    status: spec.status,
    confidence: CONFIDENCE[entry.confidence] ?? 0.6,
    source: sources[0],
  })
  if (!first.id || first.action === 'rejected') return null
  for (const source of sources.slice(1)) memory.observe({ scope: spec.scope, kind: spec.kind, text: entry.claim, actor: ACTOR, mergeWith: first.id, source })
  return first.id
}

/**
 * 把 state 里的画像、工作笔记、标记同步进记忆层。返回这次的改动计数（测试和日志用）。
 * @param {{ memory: import('../memory/index.js').MemoryStore, state: object }} opts
 */
export function syncProfileToMemory({ memory, state }) {
  const stats = { added: 0, updated: 0, retracted: 0, notes: 0, marks: 0 }
  if (!memory || !state) return stats
  const mirror = mirrorOf(state)
  const linkedIds = () => new Set([...Object.values(mirror.entries).map((l) => l.id), ...Object.values(mirror.notes)])

  // 1. 画像条目
  const entries = Array.isArray(state.profile?.entries) ? state.profile.entries : []
  const seen = new Set()
  for (const entry of entries) {
    if (!entry?.id || !CATEGORY[entry.category]) continue
    seen.add(entry.id)
    const link = mirror.entries[entry.id]
    if (link && link.claim === entry.claim && link.category === entry.category && memory.get(link.id)) continue
    if (link && memory.get(link.id)) {
      const spec = CATEGORY[entry.category]
      const out = memory.observe({ scope: spec.scope, kind: spec.kind, text: entry.claim, actor: ACTOR, status: spec.status, supersedes: [link.id] })
      if (out.id) {
        mirror.entries[entry.id] = { id: out.id, claim: entry.claim, category: entry.category }
        stats.updated += 1
      }
      continue
    }
    const id = observeEntry(memory, entry)
    if (id) {
      mirror.entries[entry.id] = { id, claim: entry.claim, category: entry.category }
      stats.added += 1
    }
  }
  for (const [entryId, link] of Object.entries(mirror.entries)) {
    if (seen.has(entryId)) continue
    delete mirror.entries[entryId]
    if (!linkedIds().has(link.id)) stats.retracted += memory.retract([link.id], { actor: ACTOR, reason: '画像这一版不再有这条' })
  }

  // 2. 工作笔记
  const notes = Array.isArray(state.workingNotes) ? state.workingNotes : []
  const noteKeys = new Set()
  for (const note of notes) {
    const text = String(note?.text ?? '').trim()
    if (!text) continue
    const key = fingerprint(text)
    noteKeys.add(key)
    if (mirror.notes[key] && memory.get(mirror.notes[key])) continue
    const out = memory.observe({ scope: 'owner:work', kind: 'note', text, actor: ACTOR })
    if (out.id && out.action !== 'rejected') {
      mirror.notes[key] = out.id
      stats.notes += 1
    }
  }
  for (const [key, id] of Object.entries(mirror.notes)) {
    if (noteKeys.has(key)) continue
    delete mirror.notes[key]
    if (!linkedIds().has(id)) memory.retract([id], { actor: ACTOR, reason: '工作笔记被裁掉' })
  }

  // 3. 用户标记：置顶 → pin，封印 → 不对；标记撤销时对应撤销
  const marks = Array.isArray(state.entryMarks) ? state.entryMarks : []
  const current = new Map()
  for (const mark of marks) {
    if (!mark?.key || (mark.status !== 'pinned' && mark.status !== 'sealed')) continue
    current.set(mark.key, mark)
  }
  const findMemory = (mark) => {
    const byEntry = mark.fromId && mirror.entries[mark.fromId]?.id
    if (byEntry && memory.get(byEntry)) return byEntry
    const claim = mark.entry?.claim
    if (!claim) return null
    const linked = Object.values(mirror.entries).find((l) => l.claim === claim)
    if (linked && memory.get(linked.id)) return linked.id
    const id = observeEntry(memory, { ...mark.entry, category: mark.entry.category ?? 'A' })
    return id
  }
  for (const [key, mark] of current) {
    const done = mirror.marks[key]
    if (done && done.status === mark.status && memory.get(done.id)) continue
    const id = findMemory(mark)
    if (!id) continue
    memory.judge(id, mark.status === 'pinned' ? 'pin' : 'wrong', { actor: USER_ACTOR })
    mirror.marks[key] = { id, status: mark.status }
    stats.marks += 1
  }
  for (const [key, done] of Object.entries(mirror.marks)) {
    if (current.has(key)) continue
    delete mirror.marks[key]
    if (!memory.get(done.id)) continue
    memory.judge(done.id, done.status === 'pinned' ? 'unpin' : 'restore', { actor: USER_ACTOR })
    // 为了打标记才补记的结论（画像里已经没有它）：标记撤掉后就成了孤儿，撤回成候选。
    if (!linkedIds().has(done.id)) stats.retracted += memory.retract([done.id], { actor: ACTOR, reason: '标记撤销，画像里也没有这条' })
    stats.marks += 1
  }
  return stats
}

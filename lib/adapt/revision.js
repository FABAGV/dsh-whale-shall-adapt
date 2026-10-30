/**
 * “复制出去的画像之后又改了几处”（设置页画像卡片上的修订提示）。
 *
 * 以前这件事在浏览器里做：条目 id 每版都变，只能拿文本相似度去猜“这条是不是同一条”，
 * 再配一套阈值和一个 1500 行的标定工具。现在画像条目就是记忆层里的记录，id 稳定，
 * 改写时新记录带着 \`supersedes\` 指向旧记录，所以直接按 id 比，不用猜。
 *
 * 复制时服务端自己存下当时的条目（id、分类、正文），之后每次 getState 现算差异。
 */

/** 快照里条目 id 的格式。旧快照（id 是 A1、n3 这类每版重来的）认不出，要重新复制一次。 */
export const SNAPSHOT_FORMAT = 'memory-ids-v1'

const MEMORY_ID = /^m\d{6}$/

/** 复制时存什么：id、分类、正文，够比较就行。 */
export function snapshotEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.id && entry.claim)
    .map((entry) => ({ id: String(entry.id), category: entry.category, claim: String(entry.claim) }))
}

/**
 * @param {{text:string|null, at:number|null, profileVersion:number|null, entries:Array|null, algorithmVersion?:string}|null} snapshot
 * @param {Array<{id:string, claim:string, supersedes?:string[]}>} currentEntries
 * @returns {{status:string, count:number, added:Array, removed:Array, modified:Array, baselineAt:number|null, baselineProfileVersion:number|null}}
 */
export function computeRevision(snapshot, currentEntries) {
  const current = Array.isArray(currentEntries) ? currentEntries : []
  const out = {
    status: 'clean',
    count: 0,
    added: [],
    removed: [],
    modified: [],
    baselineAt: Number.isFinite(snapshot?.at) ? snapshot.at : null,
    baselineProfileVersion: Number.isFinite(snapshot?.profileVersion) ? snapshot.profileVersion : null,
  }
  const baseline = Array.isArray(snapshot?.entries) ? snapshot.entries : null
  if (!snapshot || snapshot.text === null || snapshot.text === undefined || !baseline || baseline.length === 0) {
    return { ...out, status: 'no-baseline' }
  }
  if (snapshot.algorithmVersion !== SNAPSHOT_FORMAT || !baseline.every((entry) => MEMORY_ID.test(String(entry?.id ?? '')))) {
    return { ...out, status: 'stale-baseline' }
  }
  if (current.length === 0) return { ...out, status: 'empty-current' }

  const before = new Map(baseline.map((entry) => [entry.id, entry]))
  const now = new Map(current.map((entry) => [entry.id, entry]))
  const removed = baseline.filter((entry) => !now.has(entry.id))
  const added = current.filter((entry) => !before.has(entry.id))

  // 同 id 改了正文
  for (const entry of current) {
    const old = before.get(entry.id)
    if (old && old.claim !== entry.claim) out.modified.push({ before: old, after: entry })
  }
  // 改写：新记录 supersedes 旧记录，算一处修改，不算“删一条、加一条”
  const replaced = new Set()
  for (const entry of added) {
    const target = (Array.isArray(entry.supersedes) ? entry.supersedes : []).find((id) => before.has(id) && !now.has(id) && !replaced.has(id))
    if (target) {
      replaced.add(target)
      out.modified.push({ before: before.get(target), after: entry })
    } else {
      out.added.push(entry)
    }
  }
  out.removed = removed.filter((entry) => !replaced.has(entry.id))
  out.count = out.added.length + out.removed.length + out.modified.length
  out.status = out.count > 0 ? 'dirty' : 'clean'
  return out
}

/**
 * 画像和统一记忆层之间的那一层：画像的条目就存在记忆层里，`state.profile` 只是从记忆层重建出来的视图。
 *
 * 对应关系（docs/CONTRACTS.md 4.5）：
 *   A 稳定特质 → owner / trait        B 行不通的做法 → owner:work / avoid
 *   C 有效的做法 → owner:work / works  D 证据不足 → owner / uncertain（候选）
 *   工作笔记 → owner:work / note
 *
 * 设置页的三个按钮映射到用户裁决（4.6）：置顶 → pin，封印 → 不对（wrong），删除 → 这一版先拿掉（dismiss，下一版还有依据就回来）；
 * “恢复 / 取消置顶” → restore / unpin。按钮是用户按的，所以以 'dsh-settings' 的身份裁决。
 */
import { PROFILE_HEADER, groupByCategory, renderGroups, estimateTokens, markText } from './profile.js'

const ACTOR = 'profile'
const USER_ACTOR = 'dsh-settings'

export const CATEGORY = {
  A: { scope: 'owner', kind: 'trait' },
  B: { scope: 'owner:work', kind: 'avoid' },
  C: { scope: 'owner:work', kind: 'works' },
  D: { scope: 'owner', kind: 'uncertain', status: 'candidate' },
}
const KIND_CATEGORY = { trait: 'A', avoid: 'B', works: 'C', uncertain: 'D' }
const PROFILE_KINDS = Object.keys(KIND_CATEGORY)
export const PROFILE_SCOPES = ['owner', 'owner:work']
/** 注入时额外读的范围：`shared` 是「所有人可见」的书架（跨会话的学问、做法），主人侧也要看得到。 */
export const INJECT_SCOPES = [...PROFILE_SCOPES, 'shared']
const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 }

/** 注入的取舍规则：A 保底 30%，B+C 合计不超过 50%，D 和笔记不注入，置顶豁免预算，两个新生试用位。 */
export const INJECT_POLICY = Object.freeze({
  reserve: { trait: 0.3 },
  cap: { 'avoid+works': 0.5 },
  exclude: ['uncertain', 'note'],
  pinnedExempt: true,
  trialSlots: 2,
})
/** 标注行（“本次注入 N/M 条…”）的预留 token：先扣掉上界，整段才不会超预算。 */
const ANNOTATION_RESERVE = 40

const confidenceLabel = (n) => (n >= 0.8 ? 'high' : n >= 0.45 ? 'medium' : 'low')

const quotesOf = (entry) =>
  (Array.isArray(entry?.evidence) ? entry.evidence : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .slice(0, 5)
    .map((quote) => ({ sessionId: '', quote }))

/** 记忆层的记录 → 画像条目（设置页、生成提示词、历史归档都用这个形状）。 */
export function entryOf(record) {
  const quotes = (record.sources ?? []).map((s) => s.quote).filter(Boolean)
  return {
    id: record.id,
    category: KIND_CATEGORY[record.kind],
    claim: record.text,
    evidence: quotes,
    confidence: confidenceLabel(record.confidence),
    evidenceQuoteCount: quotes.length,
    firstSeenAt: record.createdAt,
    lastSeenAt: record.ledger?.lastSeenAt ?? record.updatedAt,
    timesSeen: record.ledger?.refs ?? 1,
    pinned: Boolean(record.pinned),
    origin: record.origin,
    supersedes: record.supersedes ?? [],
  }
}

const isProfileRecord = (e) => PROFILE_KINDS.includes(e.kind)
  && (e.status === 'active' || (e.kind === 'uncertain' && e.status === 'candidate'))

/** 当前画像的条目：A、B、C 取 active，D 取 active 和候选。按分类、再按记忆层的定序键排。 */
export function profileEntries(memory) {
  const records = PROFILE_SCOPES.flatMap((scope) => memory.list({ scope, kind: PROFILE_KINDS }))
    .filter(isProfileRecord)
  const { groups } = groupByCategory(records.map(entryOf))
  return ['A', 'B', 'C', 'D'].flatMap((c) => groups[c])
}

/** 记忆层里有没有画像条目（含被撤回、被否定的：有过就不再导入旧画像）。 */
export function hasProfileMemory(memory) {
  return PROFILE_SCOPES.some((scope) => memory.list({ scope, kind: PROFILE_KINDS }).length > 0)
}

function observeEntry(memory, entry, extra = {}) {
  const spec = CATEGORY[entry?.category]
  if (!spec || !entry.claim) return null
  return memory.observe({
    scope: spec.scope,
    kind: spec.kind,
    text: entry.claim,
    actor: ACTOR,
    status: spec.status,
    confidence: CONFIDENCE[entry.confidence] ?? 0.6,
    sources: quotesOf(entry),
    ...extra,
  })
}

/**
 * 把一次生成的结果写进记忆层。previous 是生成前的视图（id 都是记忆 id），next 是 normalizeProfile 的输出。
 *   - 同 id 同文同类 → 记一次 seen；
 *   - 同 id 改了文或类 → 新写一条并推翻旧的（跨片时旧的撤回成候选）；
 *   - 新 id → 新写一条；和用户判过“不对”的近乎原样时被记忆层挡掉；
 *   - previous 有、next 没有 → 撤回成候选（置顶的、用户说过或确认过的不动）。partial 时不撤回。
 */
export function applyGeneration(memory, previous, next, { partial = false } = {}) {
  const stats = { added: 0, updated: 0, unchanged: 0, retracted: 0, rejected: 0 }
  const prevById = new Map((previous ?? []).filter((e) => e?.id).map((e) => [e.id, e]))
  const kept = new Set()
  const seen = []
  for (const entry of next ?? []) {
    const old = prevById.get(entry?.id)
    if (old && memory.get(old.id)) {
      kept.add(old.id)
      if (old.claim === entry.claim && old.category === entry.category) {
        seen.push(old.id)
        stats.unchanged += 1
        continue
      }
      const out = observeEntry(memory, entry, { supersedes: [old.id] })
      if (!out?.id || out.action === 'rejected') {
        stats.rejected += 1
        continue
      }
      if (out.id !== old.id) memory.retract([old.id], { actor: ACTOR, reason: `改写为 ${out.id}` })
      stats.updated += 1
      continue
    }
    const out = observeEntry(memory, entry)
    if (!out?.id || out.action === 'rejected') stats.rejected += 1
    else if (out.action === 'new' || out.action === 'ask' || out.action === 'conflict') stats.added += 1
    else stats.unchanged += 1
  }
  if (seen.length) memory.recordUsage(seen, 'seen')
  if (!partial) {
    const gone = [...prevById.keys()].filter((id) => !kept.has(id))
    stats.retracted = memory.retract(gone, { actor: ACTOR, reason: '这一版画像不再有这条' })
  }
  return stats
}

/** 工作笔记写进 owner:work / note。返回新增条数。 */
export function addWorkingNotes(memory, notes) {
  let added = 0
  for (const raw of Array.isArray(notes) ? notes : []) {
    const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim()
    if (text.length < 4 || text.length > 300) continue
    const out = memory.observe({ scope: 'owner:work', kind: 'note', text, actor: ACTOR })
    if (out.action === 'new') added += 1
  }
  return added
}

export function workingNotes(memory) {
  return memory.list({ scope: 'owner:work', kind: 'note', status: 'active' })
    .map((e) => ({ id: e.id, text: e.text, at: e.createdAt }))
}

/**
 * 旧版 state.json 里的画像、工作笔记、置顶 / 封印一次性导入记忆层（记忆层里还没有画像时才做）。
 * 返回导入的条数；导入后调用方删掉 state 里的旧字段。
 */
export function importLegacyProfile(memory, state) {
  if (!state || hasProfileMemory(memory)) return 0
  let imported = 0
  for (const entry of Array.isArray(state.profile?.entries) ? state.profile.entries : []) {
    const out = observeEntry(memory, entry)
    if (out?.id && out.action !== 'rejected') imported += 1
  }
  addWorkingNotes(memory, state.workingNotes)
  const byText = new Map(profileEntries(memory).map((e) => [markText(e.claim), e.id]))
  for (const mark of Array.isArray(state.entryMarks) ? state.entryMarks : []) {
    if (mark?.status !== 'pinned' && mark?.status !== 'sealed') continue
    let id = byText.get(markText(mark.entry?.claim ?? mark.key))
    if (!id && mark.entry?.claim) id = observeEntry(memory, { category: 'A', ...mark.entry })?.id
    if (id) memory.judge(id, mark.status === 'pinned' ? 'pin' : 'wrong', { actor: USER_ACTOR })
  }
  return imported
}

/**
 * 把护栏换成生成器认得的标记清单形状（`buildProfilePrompt` / `normalizeProfile` 的 entryMarks）：
 * 不对 → sealed（提示词里禁止 + 落画像时按规范化正文再剔一次），过时了 → deleted（只作参考），置顶 → pinned（不许改写）。
 */
export function guardMarks(memory) {
  const g = promptGuards(memory)
  const mark = (status, claim, extra = {}) => ({ key: markText(claim), status, entry: { claim }, ...extra })
  return [
    ...g.rejected.map((claim) => mark('sealed', claim)),
    ...g.outdated.map((o) => mark('deleted', o.claim, { deleteCount: o.count })),
    ...g.pinned.map((claim) => mark('pinned', claim)),
  ]
}

/** 生成提示词里的护栏：用户判过“不对”的（不许再产出）、说过“过时了”的（不禁止）、置顶的、留下的边界。 */
export function promptGuards(memory) {
  const guards = memory.promptGuards('owner')
  const outdated = PROFILE_SCOPES.flatMap((scope) => memory.list({ scope, kind: PROFILE_KINDS, status: 'historical' }))
    .filter((e) => ['outdated', 'dismiss'].includes(lastVerdict(e)))
    .map((e) => ({ claim: e.text, count: (e.history ?? []).filter((h) => h.action === 'dismiss' || h.action === 'outdated').length }))
  const pinned = profileEntries(memory).filter((e) => e.pinned).map((e) => e.claim)
  return { rejected: guards.rejected, boundaries: guards.boundaries, outdated, pinned }
}

// ── 注入 ────────────────────────────────────────────────────────────────

/**
 * 选出并渲染注入文本。内容没变（各范围的版本号和预算都一样）时返回上一次的同一个对象，
 * 文本也是同一个字符串实例：系统提示段每一步都会求值，文本一变宿主就会多插一条 system 节点。
 */
export function createProfileInjector(memory) {
  let cacheKey = null
  let cached = null
  return function plan(budgetTokens, scopes = INJECT_SCOPES) {
    const budget = Math.max(0, Number(budgetTokens) || 0)
    const key = `${budget}|${scopes.map((s) => `${s}@${memory.revision(s)}`).join('|')}`
    if (key === cacheKey) return cached
    const draw = (inner) => {
      const selection = memory.select(scopes, Math.max(0, inner), INJECT_POLICY)
      const picked = selection.picked.map(entryOf)
      const { groups } = groupByCategory(picked)
      const byCategory = { A: groups.A.length, B: groups.B.length, C: groups.C.length }
      const omitted = selection.total - picked.length
      const annotation = omitted > 0
        ? `（本次注入 ${picked.length}/${selection.total} 条；A 类 ${byCategory.A} 条、B 类 ${byCategory.B} 条、C 类 ${byCategory.C} 条；其余按重要度省略）`
        : ''
      const pinnedKeys = new Set(picked.filter((e) => e.pinned).map((e) => markText(e.claim)))
      const text = picked.length ? renderGroups(groups, annotation, { pinnedKeys }) : ''
      return { selection, picked, byCategory, omitted, annotation, text }
    }
    // 记忆层按正文估算，渲染还要加标题、分类行和每行的“- ”：超了就按超出的量收紧再选，最多三次。
    let inner = budget - estimateTokens(`${PROFILE_HEADER}\n\n`) - ANNOTATION_RESERVE
    let drawn = draw(inner)
    for (let i = 0; i < 3 && budget > 0 && estimateTokens(drawn.text) > budget; i += 1) {
      inner -= estimateTokens(drawn.text) - budget + 8
      drawn = draw(inner)
    }
    const { selection, picked, byCategory, annotation, text } = drawn
    const injectedIds = picked.map((e) => e.id)
    const all = profileEntries(memory)
    const injectedSet = new Set(injectedIds)
    const omittedByCategory = { A: 0, B: 0, C: 0, D: 0 }
    for (const e of all) if (!injectedSet.has(e.id)) omittedByCategory[e.category] += 1
    cacheKey = key
    cached = {
      key: selection.key,
      text,
      annotation,
      budgetTokens: budget,
      totalEntries: all.length,
      injectedEntries: picked.length,
      omittedEntries: all.length - picked.length,
      injectedByCategory: byCategory,
      omittedByCategory,
      pinnedEntries: picked.filter((e) => e.pinned).length,
      injectedIds,
      trialIds: [],
      estimatedTokens: estimateTokens(text),
      overBudget: estimateTokens(text) > budget,
    }
    return cached
  }
}

/** 这一版注入真的进了系统提示：记账（同一个选取键只记一次）。只在注入路径调，设置页预览不调。 */
export function recordInjected(memory, plan) {
  if (plan?.injectedIds?.length) memory.recordUsage(plan.injectedIds, 'injected', { key: plan.key })
}

// ── 设置页的处置按钮 ────────────────────────────────────────────────────

const STATUS_VERDICT = { pinned: 'pin', sealed: 'wrong', deleted: 'dismiss' }
const lastVerdict = (record) => [...(record.history ?? [])].reverse()
  .find((h) => ['outdated', 'dismiss', 'wrong', 'restore'].includes(h.action))?.action

function findTarget(memory, input) {
  for (const id of [input.key, input.id]) {
    if (typeof id === 'string' && id && memory.get(id)) return memory.get(id)
  }
  const wanted = markText(typeof input.claim === 'string' ? input.claim : '')
  if (!wanted) return null
  const hit = profileEntries(memory).find((e) => markText(e.claim) === wanted)
  return hit ? memory.get(hit.id) : null
}

function viewStatus(record) {
  if (record.pinned) return 'pinned'
  if (record.status === 'rejected') return 'sealed'
  if (record.status === 'historical' && ['outdated', 'dismiss'].includes(lastVerdict(record))) return 'deleted'
  return null
}

/** 设置页“置顶 / 垃圾桶 / 已过时”三个区的数据（形状沿用设置页的标记清单）。 */
export function markViews(memory) {
  return PROFILE_SCOPES.flatMap((scope) => memory.list({ scope, kind: PROFILE_KINDS }))
    .map((record) => ({ record, status: viewStatus(record) }))
    .filter((x) => x.status)
    .map(({ record, status }) => ({
      key: record.id,
      status,
      entry: entryOf(record),
      fromId: record.id,
      firstAt: record.createdAt,
      lastAt: record.updatedAt,
      deleteCount: status === 'deleted' ? (record.history ?? []).filter((h) => h.action === 'dismiss' || h.action === 'outdated').length : 0,
      present: status === 'pinned' && record.status === 'active',
      presentId: status === 'pinned' && record.status === 'active' ? record.id : null,
    }))
}

/** 置顶 / 封印（不对）/ 删除（这一版先拿掉）。 */
export function markEntry(memory, input = {}, { maxPinned = 10 } = {}) {
  const verdict = STATUS_VERDICT[input.status]
  if (!verdict) return { ok: false, error: `不认识的处置：${input.status}` }
  const target = findTarget(memory, input)
  if (!target || !PROFILE_KINDS.includes(target.kind)) {
    return { ok: false, error: '找不到要处置的条目：id/claim 在当前画像里没有，key 也不在标记清单里' }
  }
  const previousStatus = viewStatus(target)
  if (verdict === 'pin' && !target.pinned) {
    const count = markViews(memory).filter((m) => m.status === 'pinned').length
    if (count >= maxPinned) return { ok: false, error: `置顶最多 ${maxPinned} 条（现在 ${count} 条）：先取消一个置顶，再置顶这一条。` }
  }
  const r = memory.judge(target.id, verdict, { actor: USER_ACTOR })
  if (!r.ok) return { ok: false, error: r.error }
  const views = markViews(memory)
  return {
    ok: true,
    status: input.status,
    key: target.id,
    previousStatus,
    marks: views.length,
    pinned: views.filter((m) => m.status === 'pinned').length,
  }
}

/** 撤销处置：取消置顶，或把“不对 / 拿掉 / 过时了”的恢复成 active。 */
export function clearMark(memory, key) {
  const target = typeof key === 'string' && key ? memory.get(key) : null
  const status = target ? viewStatus(target) : null
  if (!status) return { ok: false, error: '这条标记已经不存在了（可能刚被撤过）' }
  const r = memory.judge(target.id, status === 'pinned' ? 'unpin' : 'restore', { actor: USER_ACTOR })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, key: target.id, previousStatus: status, restored: status !== 'pinned' }
}

/** 设置页“已注入 N 次 / 从未注入”的数据：每条累计注入次数（按渲染键去重）。 */
export function ledgerView(memory, plan) {
  const counts = {}
  for (const scope of PROFILE_SCOPES) {
    for (const e of memory.list({ scope, kind: PROFILE_KINDS })) counts[e.id] = e.ledger?.injected ?? 0
  }
  return { version: null, ids: plan?.injectedIds ?? [], counts, lastAt: null }
}

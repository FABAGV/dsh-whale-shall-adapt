/**
 * 统一记忆层。画像条目、QQ 碎片、人格记忆、群成员记忆、群黑话都存成同一种记录（docs/CONTRACTS.md 第 4 节）。
 *
 * 两条不变式：
 *   - `select()` 的排序最后按 id 兜底，`render()` 不掺时间戳等活值：同样的记忆集合必须渲染出逐字节相同的文本，
 *     否则宿主每一步都会在历史里追加一条新的 system / 快照消息。
 *   - `revision(scope)` 只在会影响渲染结果的变化时 +1；账本（注入、召回次数）变化不算。
 *
 * 用户对记忆的处置是“裁决”（`judge`），不是封印：对 / 不对（可附正确说法）/ 过时了 / 别记这个（可留一条边界）/ 别提。
 * 相似度分不开“换了说法”和“另一件事”，所以被判“不对”的结论不靠文本匹配硬挡：近乎原样的复述直接丢弃，
 * 有点像的进候选并标出冲突，真正的同义改写交给生成提示词里的“已被否定”清单（`promptGuards`）。
 * 用户说过或确认过的记忆（origin 为 user / user-confirmed）不会被生成器撤回、降级、推翻或老化删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { redact } from '../core/redact.js'
import { normText, shingles, jaccard, estimateTokens, oneLine, fingerprint } from './text.js'

export const MEMORY_VERSION = 2
export const KINDS = new Set([
  'trait', 'avoid', 'works', 'uncertain',
  'fact', 'intent', 'constraint', 'preference', 'promise',
  'relation', 'style', 'note', 'slang', 'boundary',
])
export const ORIGINS = new Set(['user', 'user-confirmed', 'model', 'import'])
export const VERDICTS = new Set(['confirm', 'wrong', 'outdated', 'forget', 'quiet', 'unquiet', 'pin', 'unpin', 'restore', 'move'])
export const JUDGE_ACTORS = new Set(['console', 'dsh-settings'])
const SCOPE = /^(owner(:work|:chat)?|chat:(group|private):\d{1,12}|member:\d{1,12}:\d{1,12}|persona:[A-Za-z0-9_-]{1,64})$/
const USAGE = new Set(['injected', 'recalled', 'corrected', 'seen'])
const NEVER_INJECTED = new Set(['boundary'])
const MAX_TEXT = 200
const MAX_QUOTE = 120
const MAX_SOURCES = 5
const MAX_HISTORY = 10
const MAX_IMPORTANCE = 9

const DEFAULTS = {
  // conflict：新观察和被判“不对”的结论像到什么程度就进候选。实测改写 0.42、只差关键内容的另一条结论 0.35。
  similarity: { merge: 0.82, ask: 0.3, conflict: 0.4 },
  aging: { everyGens: 10, staleGens: 5, dropGens: 10, maxPerScope: 500 },
}

export function isValidScope(scope) {
  return SCOPE.test(String(scope ?? ''))
}

/** 同一个人的几片记忆互相挡“已被否定”的结论：主人的三片是一家，其余各自一家。 */
export function familyOf(scope) {
  return String(scope).startsWith('owner') ? 'owner' : String(scope)
}

/** 边界记忆挂在哪：主人的边界挂在共用的 owner 上，其余挂在本范围。 */
export function boundaryScopeOf(scope) {
  return familyOf(scope)
}

/** QQ 侧的写入方（交班、空闲整理、成员提取、冷启动）都以 `qq` 开头。主人范围里它们只能写 owner:chat。 */
const isQqActor = (actor) => String(actor ?? '').startsWith('qq')
const isUserOrigin = (e) => e.origin === 'user' || e.origin === 'user-confirmed'
const isProtected = (e) => e.pinned || isUserOrigin(e)

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : lo))

/** 定序键：pinned → importance → refs → lastSeenAt → id。最后一项保证同分时顺序也确定。 */
export function compareMemories(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  if (b.importance !== a.importance) return b.importance - a.importance
  if (b.ledger.refs !== a.ledger.refs) return b.ledger.refs - a.ledger.refs
  if (b.ledger.lastSeenAt !== a.ledger.lastSeenAt) return b.ledger.lastSeenAt - a.ledger.lastSeenAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const KIND_LABEL = {
  trait: '特质', avoid: '别这样做', works: '有效做法', uncertain: '待确认',
  fact: '事实', intent: '在做', constraint: '约束', preference: '偏好', promise: '约定',
  relation: '关系', style: '风格', note: '笔记', slang: '黑话', boundary: '边界',
}

export function createMemory(options = {}) {
  return new MemoryStore(options)
}

export class MemoryStore {
  constructor({ dir, log = null, config = {}, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('MemoryStore 需要 dir')
    this.dir = dir
    this.file = path.join(dir, 'memory.json')
    this.backupFile = path.join(dir, 'memory.json.bak')
    this.log = log
    this.now = now
    this.cfg = {
      similarity: { ...DEFAULTS.similarity, ...(config.similarity ?? {}) },
      aging: { ...DEFAULTS.aging, ...(config.aging ?? {}) },
    }
    this.listeners = new Set()
    this.saveTimer = null
    this.data = this.#load()
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────

  #empty() {
    return { version: MEMORY_VERSION, seq: 0, entries: [], revisions: {}, blockedScopes: [], forgotten: {} }
  }

  #load() {
    for (const candidate of [this.file, this.backupFile]) {
      if (!fs.existsSync(candidate)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (!parsed || !Array.isArray(parsed.entries)) throw new Error('缺少 entries')
        return {
          ...this.#empty(),
          ...parsed,
          revisions: parsed.revisions && typeof parsed.revisions === 'object' ? parsed.revisions : {},
          blockedScopes: Array.isArray(parsed.blockedScopes) ? parsed.blockedScopes : [],
          forgotten: parsed.forgotten && typeof parsed.forgotten === 'object' ? parsed.forgotten : {},
        }
      } catch (error) {
        this.log?.warn?.(`[memory] ${path.basename(candidate)} 读不懂，跳过：${error?.message ?? error}`)
      }
    }
    return this.#empty()
  }

  #scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 100)
    this.saveTimer.unref?.()
  }

  /** 立即落盘：写临时文件 → 旧文件挪成 .bak → 临时文件改名为正式文件。 */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      if (fs.existsSync(this.file)) fs.renameSync(this.file, this.backupFile)
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.log?.warn?.(`[memory] 落盘失败：${error?.message ?? error}`)
    }
  }

  dispose() {
    if (this.saveTimer) this.flush()
    this.listeners.clear()
  }

  // ── 内部工具 ──────────────────────────────────────────────────────────

  #changed(scopes) {
    for (const scope of new Set(scopes)) {
      this.data.revisions[scope] = (this.data.revisions[scope] ?? 0) + 1
      for (const fn of this.listeners) {
        try {
          fn({ scope, revision: this.data.revisions[scope] })
        } catch (error) {
          this.log?.warn?.(`[memory] onChange 监听器出错：${error?.message ?? error}`)
        }
      }
    }
    this.#scheduleSave()
  }

  #history(entry, item) {
    entry.history = [...(entry.history ?? []), { at: this.now(), ...item }].slice(-MAX_HISTORY)
    entry.updatedAt = this.now()
  }

  #source(raw) {
    if (!raw) return null
    return {
      sessionId: String(raw.sessionId ?? ''),
      at: Number(raw.at) || this.now(),
      quote: oneLine(redact(String(raw.quote ?? '')), MAX_QUOTE),
    }
  }

  #addSource(entry, source) {
    if (!source) return
    entry.sources = [...entry.sources, source].slice(-MAX_SOURCES)
  }

  #byId(id) {
    return this.data.entries.find((e) => e.id === id) ?? null
  }

  #inScope(scope) {
    return this.data.entries.filter((e) => e.scope === scope)
  }

  #inFamily(scope) {
    const family = familyOf(scope)
    return this.data.entries.filter((e) => familyOf(e.scope) === family)
  }

  #create({ scope, kind, text, status = 'active', origin = 'model', importance = 0, confidence = 0.5,
    source = null, validUntil = null, gen = 0, refs = 1, actor, action = 'created', reason }) {
    const now = this.now()
    this.data.seq += 1
    const entry = {
      id: `m${String(this.data.seq).padStart(6, '0')}`,
      scope,
      kind,
      text,
      status,
      origin,
      pinned: false,
      quiet: false,
      importance: clamp(importance, 0, MAX_IMPORTANCE),
      confidence: clamp(confidence, 0, 1),
      sources: source ? [source] : [],
      supersedes: [],
      rejects: [],
      conflictsWith: null,
      validUntil: Number(validUntil) > 0 ? Number(validUntil) : null,
      ledger: { refs, injected: 0, recalled: 0, corrected: 0, seen: 0, lastSeenAt: now, lastSeenGen: gen, lastInjectedKey: '' },
      history: [],
      createdAt: now,
      updatedAt: now,
    }
    this.#history(entry, { actor, action, reason })
    this.data.entries.push(entry)
    return entry
  }

  // ── 写入 ──────────────────────────────────────────────────────────────

  /** 写入一条观察。规则见 docs/CONTRACTS.md 4.2。 */
  observe(input = {}) {
    const { scope, kind, actor } = input
    if (!isValidScope(scope)) return { action: 'dropped', reason: `scope 不合法：${scope}` }
    if (!KINDS.has(kind)) return { action: 'dropped', reason: `kind 不合法：${kind}` }
    if (!actor) return { action: 'dropped', reason: '缺少 actor' }
    if (scope.startsWith('owner') && isQqActor(actor) && scope !== 'owner:chat') {
      return { action: 'dropped', reason: 'QQ 来源在主人记忆里只能写 owner:chat' }
    }
    if (this.data.blockedScopes.includes(scope)) return { action: 'dropped', reason: '这个范围已被“忘掉我”屏蔽' }
    const text = oneLine(redact(String(input.text ?? '')), MAX_TEXT)
    if (!text) return { action: 'dropped', reason: '正文为空' }
    const family = familyOf(scope)
    if ((this.data.forgotten[family] ?? []).includes(fingerprint(text))) {
      return { action: 'dropped', reason: '用户要求忘掉过这句话' }
    }

    const origin = ORIGINS.has(input.origin) && (input.origin !== 'user' || JUDGE_ACTORS.has(actor) || String(actor).startsWith('user'))
      ? input.origin
      : 'model'
    const now = this.now()
    const gen = Number(input.gen) || 0
    const delta = clamp(input.importanceDelta ?? 0, 0, 2)
    const source = this.#source(input.source)
    const grams = shingles(normText(text))
    const sim = this.cfg.similarity

    // 被用户判“不对”的结论：近乎原样的复述直接丢弃；有点像的进候选并标出冲突，等用户看。
    let conflict = null
    let conflictSim = 0
    for (const e of this.#inFamily(scope)) {
      if (e.status !== 'rejected' && e.kind !== 'boundary') continue
      const sv = jaccard(grams, e.text)
      if (sv >= sim.merge) return { action: 'rejected', id: e.id, similarity: sv }
      if (e.status === 'rejected' && sv >= sim.conflict && sv > conflictSim) {
        conflict = e
        conflictSim = sv
      }
    }

    const pool = this.#inScope(scope).filter((e) => e.status !== 'rejected')
    const bump = (e, action, similarity) => {
      e.ledger.refs += 1
      e.ledger.lastSeenAt = now
      e.ledger.lastSeenGen = gen
      e.importance = clamp(e.importance + delta, 0, MAX_IMPORTANCE)
      this.#addSource(e, source)
      this.#history(e, { actor, action, delta })
      this.#changed([scope])
      return similarity === undefined ? { action, id: e.id } : { action, id: e.id, similarity }
    }
    if (input.mergeWith) {
      const target = pool.find((e) => e.id === input.mergeWith)
      if (target) return bump(target, 'merged')
    }
    let best = null
    let bestSim = 0
    for (const e of pool) {
      const sv = jaccard(grams, e.text)
      if (sv > bestSim) {
        best = e
        bestSim = sv
      }
    }
    if (best && bestSim >= sim.merge) return bump(best, 'dup', bestSim)

    // ask 区间：可能是同一件事换了说法，也可能是只差一个关键内容的另一件事（实测中文改写只有 0.0–0.45，
    // 不同结论也能到 0.35）。两条都留着，新的一条继承旧那条的计数和重要度，交给生成器下次用 mergeWith 合并。
    const asking = Boolean(best) && bestSim >= sim.ask
    const entry = this.#create({
      scope,
      kind,
      text,
      status: conflict || input.status === 'candidate' ? 'candidate' : 'active',
      origin,
      importance: (input.importance ?? delta) + (asking ? best.importance : 0),
      confidence: input.confidence ?? 0.5,
      source,
      validUntil: input.validUntil,
      gen,
      refs: asking ? best.ledger.refs + 1 : 1,
      actor,
      action: asking ? 'restated' : 'created',
      reason: asking ? best.id : undefined,
    })
    if (conflict) entry.conflictsWith = conflict.id
    for (const oldId of Array.isArray(input.supersedes) ? input.supersedes : []) {
      const old = pool.find((e) => e.id === oldId)
      if (!old || (isProtected(old) && !JUDGE_ACTORS.has(actor))) continue
      entry.supersedes.push(old.id)
      if (old.status === 'active') old.status = 'historical'
      this.#history(old, { actor, action: 'superseded', reason: entry.id })
    }
    this.#changed([scope])
    if (conflict) return { action: 'conflict', id: entry.id, conflictsWith: conflict.id, similarity: conflictSim }
    return asking ? { action: 'ask', id: entry.id, similarity: bestSim } : { action: 'new', id: entry.id }
  }

  // ── 用户裁决（只有控制台和设置页能做）───────────────────────────────

  /**
   * verdict:
   *   confirm   对：转为 active，来源记为用户确认；带 text 时同时改写正文
   *   wrong     不对：转为 rejected（不注入，但留着挡近乎原样的复述）；带 text 时新建一条用户写的正确说法
   *   outdated  过时了：转为 historical（不注入，召回时标“以前”）；带 text 时新建一条推翻它的新说法
   *   forget    别记这个：删除，只留文本指纹挡原样复述；带 boundary 时留一条边界给生成器看
   *   quiet / unquiet  别提 / 可以提：记着但不注入
   *   pin / unpin      置顶 / 取消置顶
   *   restore   恢复：rejected / historical 回到 active
   *   move      挪到主人的另一片（owner / owner:work / owner:chat），只能在同一家里挪
   */
  judge(id, verdict, { actor, text, boundary, scope } = {}) {
    if (!JUDGE_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能处置记忆（actor=${actor}）`)
    if (!VERDICTS.has(verdict)) return { ok: false, error: `不认识的裁决：${verdict}` }
    const e = this.#byId(id)
    if (!e) return { ok: false, error: '找不到这条记忆' }
    const touched = [e.scope]
    const userText = text === undefined ? '' : oneLine(redact(String(text)), MAX_TEXT)
    const out = { ok: true, id }
    switch (verdict) {
      case 'confirm':
        e.status = 'active'
        e.confidence = 1
        e.conflictsWith = null
        if (userText) {
          e.text = userText
          e.origin = 'user'
        } else if (!isUserOrigin(e)) {
          e.origin = 'user-confirmed'
        }
        break
      case 'wrong':
        e.status = 'rejected'
        e.pinned = false
        e.ledger.corrected += 1
        if (userText) {
          const fixed = this.#create({ scope: e.scope, kind: e.kind, text: userText, origin: 'user', importance: Math.max(e.importance, 1), confidence: 1, actor, action: 'corrected', reason: e.id })
          fixed.rejects.push(e.id)
          out.correctionId = fixed.id
        }
        break
      case 'outdated':
        e.status = 'historical'
        e.pinned = false
        if (userText) {
          const next = this.#create({ scope: e.scope, kind: e.kind, text: userText, origin: 'user', importance: e.importance, confidence: 1, actor, action: 'updated', reason: e.id })
          next.supersedes.push(e.id)
          out.replacementId = next.id
        }
        break
      case 'forget': {
        const family = familyOf(e.scope)
        const prints = new Set(this.data.forgotten[family] ?? [])
        prints.add(fingerprint(e.text))
        this.data.forgotten[family] = [...prints].slice(-2000)
        this.data.entries = this.data.entries.filter((x) => x !== e)
        const rule = boundary === undefined ? '' : oneLine(redact(String(boundary)), MAX_TEXT)
        if (rule) {
          const where = boundaryScopeOf(e.scope)
          out.boundaryId = this.#create({ scope: where, kind: 'boundary', text: rule, origin: 'user', confidence: 1, actor, action: 'created' }).id
          touched.push(where)
        }
        this.#changed(touched)
        return out
      }
      case 'quiet':
        e.quiet = true
        break
      case 'unquiet':
        e.quiet = false
        break
      case 'pin':
        e.pinned = true
        e.status = 'active'
        break
      case 'unpin':
        e.pinned = false
        break
      case 'restore':
        if (e.status === 'rejected' || e.status === 'historical' || e.status === 'candidate') e.status = 'active'
        break
      case 'move':
        if (!isValidScope(scope) || familyOf(scope) !== familyOf(e.scope)) return { ok: false, error: '只能在同一个人的几片记忆之间挪' }
        touched.push(scope)
        e.scope = scope
        break
    }
    this.#history(e, { actor, action: verdict })
    this.#changed(touched)
    return out
  }

  // ── 查询 ──────────────────────────────────────────────────────────────

  list(query = {}) {
    const statuses = query.status === undefined ? null : new Set([].concat(query.status))
    const kinds = query.kind === undefined ? null : new Set([].concat(query.kind))
    const ids = query.ids === undefined ? null : new Set(query.ids)
    return this.data.entries
      .filter((e) => (query.scope === undefined || e.scope === query.scope)
        && (query.scopePrefix === undefined || e.scope.startsWith(query.scopePrefix))
        && (!statuses || statuses.has(e.status))
        && (!kinds || kinds.has(e.kind))
        && (!ids || ids.has(e.id)))
      .sort(compareMemories)
      .map((e) => structuredClone(e))
  }

  get(id) {
    const e = this.#byId(id)
    return e ? structuredClone(e) : null
  }

  revision(scope) {
    return this.data.revisions[scope] ?? 0
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 给生成器（画像、交班、成员提取）看的护栏：用户判过“不对”的结论和用户留下的边界。
   * 生成提示词里列出它们，要求“一条都不许再产出”；这是挡同义改写的那道防线。
   */
  promptGuards(scope) {
    const family = this.#inFamily(scope)
    return {
      rejected: family.filter((e) => e.status === 'rejected').sort(compareMemories).map((e) => e.text),
      boundaries: family.filter((e) => e.kind === 'boundary' && e.status === 'active').sort(compareMemories).map((e) => e.text),
    }
  }

  // ── 选取与渲染 ────────────────────────────────────────────────────────

  /**
   * 选出要注入的记忆：只选 active、不是“别提”、不是边界的；排序见 compareMemories；预算按估算 token。
   * policy.reserve：某类至少占的预算比例；policy.cap：几类合计不超过的比例；policy.exclude：不注入的类；
   * policy.pinnedExempt：置顶的不占预算；policy.trialSlots：给“从没注入过且引文 ≥2”的新条目留的位子。
   */
  select(scopes, budgetTokens, policy = {}) {
    const scopeList = [...new Set([].concat(scopes ?? []))].sort()
    const exclude = new Set([...(policy.exclude ?? []), ...NEVER_INJECTED])
    const pool = this.data.entries
      .filter((e) => scopeList.includes(e.scope) && e.status === 'active' && !e.quiet && !exclude.has(e.kind))
      .sort(compareMemories)
    const budget = Math.max(0, Number(budgetTokens) || 0)
    const revisions = Object.fromEntries(scopeList.map((s) => [s, this.revision(s)]))
    const key = scopeList.map((s) => `${s}@${revisions[s]}`).join('|')
    if (budget === 0 || pool.length === 0) return { picked: [], usedTokens: 0, total: pool.length, revisions, key }

    const caps = Object.entries(policy.cap ?? {}).map(([kinds, ratio]) => ({
      kinds: new Set(kinds.split('+')),
      limit: budget * Number(ratio),
      used: 0,
    }))
    const picked = new Set()
    let used = 0
    const cost = (e) => estimateTokens(e.text)
    const take = (e, { exempt = false } = {}) => {
      if (picked.has(e)) return true
      const c = cost(e)
      if (!exempt && used + c > budget) return false
      const blocking = caps.filter((cap) => cap.kinds.has(e.kind))
      if (!exempt && blocking.some((cap) => cap.used + c > cap.limit)) return false
      picked.add(e)
      if (!exempt) used += c
      for (const cap of blocking) cap.used += c
      return true
    }

    if (policy.pinnedExempt) for (const e of pool) if (e.pinned) take(e, { exempt: true })
    let trials = Math.max(0, Number(policy.trialSlots) || 0)
    for (const e of pool) {
      if (trials === 0) break
      if (e.ledger.injected === 0 && e.sources.length >= 2 && !picked.has(e) && take(e)) trials -= 1
    }
    for (const [kind, ratio] of Object.entries(policy.reserve ?? {})) {
      const limit = budget * Number(ratio)
      let reserved = 0
      for (const e of pool) {
        if (e.kind !== kind || picked.has(e)) continue
        if (reserved + cost(e) > limit) break
        if (take(e)) reserved += cost(e)
      }
    }
    const hasRules = caps.length > 0 || Object.keys(policy.reserve ?? {}).length > 0
    for (const e of pool) {
      if (picked.has(e)) continue
      if (used + cost(e) > budget) {
        if (hasRules) continue
        break
      }
      take(e)
    }
    return {
      picked: pool.filter((e) => picked.has(e)).map((e) => structuredClone(e)),
      usedTokens: used,
      total: pool.length,
      revisions,
      key,
    }
  }

  /** 渲染注入文本。不带任何活值，同样的选取结果逐字节相同；没有选中就返回空串（宿主会丢掉空段）。 */
  render(selection, { title = '', intro = '' } = {}) {
    const picked = selection?.picked ?? []
    if (picked.length === 0) return ''
    const head = [title, intro].filter(Boolean)
    const lines = picked.map((e) => `- ${e.pinned ? '📌' : ''}[${KIND_LABEL[e.kind] ?? e.kind}] ${e.text}`)
    return [...head, ...(head.length ? [''] : []), ...lines].join('\n')
  }

  // ── 生成器的撤回与降级（不碰用户说过或确认过的）───────────────────────

  /** 生成器这一版不再支持它：转为候选，可逆。置顶的和用户来源的不动。 */
  retract(ids, { actor, reason = '' } = {}) {
    const touched = []
    for (const id of [].concat(ids ?? [])) {
      const e = this.#byId(id)
      if (!e || isProtected(e) || e.status !== 'active') continue
      e.status = 'candidate'
      this.#history(e, { actor, action: 'retracted', reason })
      touched.push(e.scope)
    }
    if (touched.length) this.#changed(touched)
    return touched.length
  }

  /** 重要度 −1（原 QQ 交班里模型给的 drop）。置顶的和用户来源的不动。 */
  demote(ids, { actor, reason = '' } = {}) {
    const touched = []
    for (const id of [].concat(ids ?? [])) {
      const e = this.#byId(id)
      if (!e || isProtected(e) || e.importance === 0) continue
      e.importance -= 1
      this.#history(e, { actor, action: 'demoted', delta: -1, reason })
      touched.push(e.scope)
    }
    if (touched.length) this.#changed(touched)
    return touched.length
  }

  // ── 记账（不改 revision：账本不影响渲染）─────────────────────────────

  /**
   * injected 必须带 meta.key（select() 返回的 key）：同一个 key 对同一条只记一次，
   * 因为系统提示段每一步都会重新求值。corrected 由信号判定方记（低置信度，只调权重）。
   */
  recordUsage(ids, event, meta = {}) {
    if (!USAGE.has(event)) throw new Error(`不认识的记账事件：${event}`)
    let n = 0
    for (const id of [].concat(ids ?? [])) {
      const e = this.#byId(id)
      if (!e) continue
      if (event === 'injected') {
        const key = String(meta.key ?? '')
        if (key && e.ledger.lastInjectedKey === key) continue
        e.ledger.lastInjectedKey = key
      }
      e.ledger[event] += 1
      if (event === 'seen') {
        e.ledger.lastSeenAt = this.now()
        if (meta.gen !== undefined) e.ledger.lastSeenGen = Number(meta.gen) || 0
      }
      if (event === 'corrected') this.#history(e, { actor: meta.actor ?? 'signals', action: 'corrected', reason: meta.reason })
      n += 1
    }
    if (n) this.#scheduleSave()
    return n
  }

  // ── 召回 ──────────────────────────────────────────────────────────────

  /** 关键词 + 3-gram 检索。active、candidate、historical 都能召回，historical 带 `historical: true`。 */
  recall(query, scopes, limit = 5) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const scopeSet = new Set([].concat(scopes ?? []))
    const qNorm = normText(q)
    const grams = shingles(qNorm)
    return this.data.entries
      .filter((e) => scopeSet.has(e.scope) && !e.quiet && e.kind !== 'boundary'
        && (e.status === 'active' || e.status === 'candidate' || e.status === 'historical'))
      .map((e) => ({ e, score: jaccard(grams, e.text) + (qNorm.length >= 2 && normText(e.text).includes(qNorm) ? 0.5 : 0) }))
      .filter((x) => x.score >= 0.1)
      .sort((a, b) => b.score - a.score || compareMemories(a.e, b.e))
      .slice(0, Math.max(1, Number(limit) || 5))
      .map((x) => ({ ...structuredClone(x.e), score: Math.round(x.score * 100) / 100, historical: x.e.status === 'historical' }))
  }

  // ── 老化 ──────────────────────────────────────────────────────────────

  /**
   * - 过期（validUntil 已过）的 active 转为 historical；
   * - 每 everyGens 代：staleGens 代没再提到的重要度 −1；重要度 0、只提到过一次、dropGens 代没提到的删掉；
   * - 超过 maxPerScope 时从排序末尾删。
   * 置顶的、用户来源的、rejected（要留着挡复述）和边界永远不删、不降级。
   */
  age(scope, { gen = 0, now = this.now() } = {}) {
    const a = this.cfg.aging
    let decayed = 0
    let expired = 0
    const pool = this.#inScope(scope)
    for (const e of pool) {
      if (e.status === 'active' && e.validUntil && e.validUntil <= now && !e.pinned) {
        e.status = 'historical'
        this.#history(e, { actor: 'aging', action: 'expired' })
        expired += 1
      }
    }
    const keep = (e) => isProtected(e) || e.status === 'rejected' || e.kind === 'boundary'
    const every = Math.max(1, Number(a.everyGens) || 10)
    const remove = new Set()
    if (gen > 0 && gen % every === 0) {
      for (const e of pool) {
        if (keep(e)) continue
        if (e.ledger.lastSeenGen <= gen - a.staleGens && e.importance > 0) {
          e.importance -= 1
          this.#history(e, { actor: 'aging', action: 'decayed', delta: -1 })
          decayed += 1
        }
        if (e.importance === 0 && e.ledger.refs <= 1 && e.ledger.lastSeenGen <= gen - a.dropGens) remove.add(e)
      }
    }
    const max = Math.max(1, Number(a.maxPerScope) || 500)
    const survivors = pool.filter((e) => !remove.has(e)).sort(compareMemories)
    let excess = survivors.length - max
    for (let i = survivors.length - 1; excess > 0 && i >= 0; i -= 1) {
      if (keep(survivors[i])) continue
      remove.add(survivors[i])
      excess -= 1
    }
    if (remove.size) this.data.entries = this.data.entries.filter((e) => !remove.has(e))
    if (decayed || expired || remove.size) this.#changed([scope])
    return { decayed, expired, dropped: remove.size }
  }

  // ── 批量（“忘掉我”、导出）────────────────────────────────────────────

  /** 删除一个范围（或前缀）下的全部记忆。block=true 时还会屏蔽这个范围，之后的写入一律丢弃。 */
  purge(query = {}, actor) {
    if (!JUDGE_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能批量删除记忆（actor=${actor}）`)
    if (query.scope === undefined && query.scopePrefix === undefined) throw new Error('purge 必须给出 scope 或 scopePrefix')
    const match = (e) => (query.scope === undefined || e.scope === query.scope)
      && (query.scopePrefix === undefined || e.scope.startsWith(query.scopePrefix))
    const scopes = this.data.entries.filter(match).map((e) => e.scope)
    this.data.entries = this.data.entries.filter((e) => !match(e))
    if (query.block && query.scope && !this.data.blockedScopes.includes(query.scope)) {
      this.data.blockedScopes.push(query.scope)
    }
    if (scopes.length) this.#changed(scopes)
    else this.#scheduleSave()
    return scopes.length
  }

  unblock(scope, actor) {
    if (!JUDGE_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能解除屏蔽（actor=${actor}）`)
    this.data.blockedScopes = this.data.blockedScopes.filter((s) => s !== scope)
    this.#scheduleSave()
  }

  export(query = {}) {
    return { version: MEMORY_VERSION, exportedAt: this.now(), entries: this.list(query) }
  }
}

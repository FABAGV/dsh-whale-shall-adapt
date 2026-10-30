/**
 * 统一记忆层。画像条目、QQ 碎片、人格记忆、群成员记忆都存成同一种记录（docs/CONTRACTS.md 第 4 节）。
 *
 * 两条不变式：
 *   - `select()` 的排序最后按 id 兜底，`render()` 不掺时间戳等活值：同样的记忆集合必须渲染出逐字节相同的文本，
 *     否则宿主每一步都会在历史里追加一条新的 system / 快照消息。
 *   - `revision(scope)` 只在会影响渲染结果的变化时 +1；账本（注入、召回次数）变化不算。
 */
import fs from 'node:fs'
import path from 'node:path'
import { redact } from '../core/redact.js'
import { normText, shingles, jaccard, estimateTokens, oneLine } from './text.js'

export const MEMORY_VERSION = 1
export const KINDS = new Set([
  'trait', 'avoid', 'works', 'uncertain',
  'fact', 'intent', 'constraint', 'preference', 'promise',
  'relation', 'style', 'note',
])
export const MARK_ACTORS = new Set(['console', 'dsh-settings'])
const SCOPE = /^(owner|chat:(group|private):\d{1,12}|member:\d{1,12}:\d{1,12}|persona:[A-Za-z0-9_-]{1,64})$/
const USAGE = new Set(['injected', 'recalled', 'corrected', 'seen'])
const MAX_TEXT = 200
const MAX_QUOTE = 120
const MAX_SOURCES = 5
const MAX_HISTORY = 10
const MAX_IMPORTANCE = 9

const DEFAULTS = {
  similarity: { merge: 0.82, ask: 0.3, seal: 0.6 },
  aging: { everyGens: 10, staleGens: 5, dropGens: 10, maxPerScope: 500 },
}

export function isValidScope(scope) {
  return SCOPE.test(String(scope ?? ''))
}

/** QQ 侧的写入方（交班、空闲整理、成员提取、冷启动）都以 `qq` 开头，它们永远不能写 owner。 */
const isQqActor = (actor) => String(actor ?? '').startsWith('qq')

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
  relation: '关系', style: '风格', note: '笔记',
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
    return { version: MEMORY_VERSION, seq: 0, entries: [], revisions: {}, blockedScopes: [] }
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

  // ── 写入 ──────────────────────────────────────────────────────────────

  /** 写入一条观察。规则见 docs/CONTRACTS.md 4.2。 */
  observe(input = {}) {
    const { scope, kind, actor } = input
    if (!isValidScope(scope)) return { action: 'dropped', reason: `scope 不合法：${scope}` }
    if (!KINDS.has(kind)) return { action: 'dropped', reason: `kind 不合法：${kind}` }
    if (!actor) return { action: 'dropped', reason: '缺少 actor' }
    if (scope === 'owner' && isQqActor(actor)) return { action: 'dropped', reason: 'QQ 来源不能写 owner' }
    if (this.data.blockedScopes.includes(scope)) return { action: 'dropped', reason: '这个范围已被“忘掉我”屏蔽' }
    const text = oneLine(redact(String(input.text ?? '')), MAX_TEXT)
    if (!text) return { action: 'dropped', reason: '正文为空' }

    const now = this.now()
    const gen = Number(input.gen) || 0
    const delta = clamp(input.importanceDelta ?? 0, 0, 2)
    const source = this.#source(input.source)
    const grams = shingles(normText(text))
    const pool = this.#inScope(scope)
    const sim = this.cfg.similarity

    for (const e of pool) {
      if (e.status === 'sealed' && jaccard(grams, e.text) >= sim.seal) return { action: 'sealed', id: e.id }
    }

    const bump = (e, action, similarity) => {
      e.ledger.refs += 1
      e.ledger.lastSeenAt = now
      e.ledger.lastSeenGen = gen
      e.importance = clamp(e.importance + delta, 0, MAX_IMPORTANCE)
      if (e.status === 'deleted') e.status = input.status === 'candidate' ? 'candidate' : 'active'
      this.#addSource(e, source)
      this.#history(e, { actor, action, delta })
      this.#changed([scope])
      return similarity === undefined ? { action, id: e.id } : { action, id: e.id, similarity }
    }

    if (input.mergeWith) {
      const target = pool.find((e) => e.id === input.mergeWith && e.status !== 'sealed')
      if (target) return bump(target, 'merged')
    }

    let best = null
    let bestSim = 0
    for (const e of pool) {
      if (e.status === 'sealed') continue
      const s = jaccard(grams, e.text)
      if (s > bestSim) {
        best = e
        bestSim = s
      }
    }
    if (best && bestSim >= sim.merge) return bump(best, 'dup', bestSim)

    // 相似度落在 ask 区间：可能是同一件事换了说法，也可能是只差一个关键参数的另一件事（实测中文改写只有 0.1–0.45，
    // 不同结论也能到 0.35）。两条都留着，新的一条继承旧那条的计数和重要度，交给生成器下次用 mergeWith 明确合并。
    const asking = Boolean(best) && bestSim >= sim.ask
    this.data.seq += 1
    const entry = {
      id: `m${String(this.data.seq).padStart(6, '0')}`,
      scope,
      kind,
      text,
      status: input.status === 'candidate' ? 'candidate' : 'active',
      pinned: false,
      importance: clamp((input.importance ?? delta) + (asking ? best.importance : 0), 0, MAX_IMPORTANCE),
      confidence: clamp(input.confidence ?? 0.5, 0, 1),
      sources: source ? [source] : [],
      supersedes: [],
      validUntil: Number(input.validUntil) > 0 ? Number(input.validUntil) : null,
      ledger: { refs: asking ? best.ledger.refs + 1 : 1, injected: 0, recalled: 0, corrected: 0, seen: 0, lastSeenAt: now, lastSeenGen: gen, deletedCount: 0 },
      history: [],
      createdAt: now,
      updatedAt: now,
    }
    for (const oldId of Array.isArray(input.supersedes) ? input.supersedes : []) {
      const old = pool.find((e) => e.id === oldId)
      if (!old || old.pinned) continue
      entry.supersedes.push(old.id)
      if (old.status === 'active') old.status = 'candidate'
      this.#history(old, { actor, action: 'superseded', reason: entry.id })
    }
    this.#history(entry, asking ? { actor, action: 'restated', reason: best.id } : { actor, action: 'created' })
    this.data.entries.push(entry)
    this.#changed([scope])
    return asking ? { action: 'ask', id: entry.id, similarity: bestSim } : { action: 'new', id: entry.id }
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

  // ── 选取与渲染 ────────────────────────────────────────────────────────

  /**
   * 选出要注入的记忆。只选 active；排序见 compareMemories；预算按估算 token。
   * policy.reserve：某类至少占的预算比例（先保底装）；policy.cap：几类合计不超过的比例；
   * policy.exclude：不注入的类；policy.pinnedExempt：置顶的不占预算；
   * policy.trialSlots：给“从没注入过且引文 ≥2”的新条目留的位子。
   */
  select(scopes, budgetTokens, policy = {}) {
    const scopeList = [...new Set([].concat(scopes ?? []))].sort()
    const exclude = new Set(policy.exclude ?? [])
    const pool = this.data.entries
      .filter((e) => scopeList.includes(e.scope) && e.status === 'active' && !exclude.has(e.kind))
      .sort(compareMemories)
    const budget = Math.max(0, Number(budgetTokens) || 0)
    const revisions = Object.fromEntries(scopeList.map((s) => [s, this.revision(s)]))
    const key = scopeList.map((s) => `${s}@${revisions[s]}`).join('|')
    const empty = { picked: [], usedTokens: 0, total: pool.length, revisions, key }
    if (budget === 0 || pool.length === 0) return empty

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
    const trials = Math.max(0, Number(policy.trialSlots) || 0)
    if (trials > 0) {
      let left = trials
      for (const e of pool) {
        if (left === 0) break
        if (e.ledger.injected === 0 && e.sources.length >= 2 && !picked.has(e) && take(e)) left -= 1
      }
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
    const lines = picked.map((e) => `- ${e.pinned ? '📌' : ''}[${KIND_LABEL[e.kind] ?? e.kind}] ${e.text}`)
    return [title, intro, '', ...lines].filter((line, i) => line !== '' || i === 2).join('\n').replace(/^\n+/, '')
  }

  // ── 处置（只有控制台和设置页能做）───────────────────────────────────

  mark(id, action, actor) {
    if (!MARK_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能处置记忆（actor=${actor}）`)
    const e = this.#byId(id)
    if (!e) return { ok: false, error: '找不到这条记忆' }
    switch (action) {
      case 'pin':
        e.pinned = true
        if (e.status !== 'active') e.status = 'active'
        break
      case 'unpin':
        e.pinned = false
        break
      case 'seal':
        e.status = 'sealed'
        e.pinned = false
        break
      case 'unseal':
        if (e.status === 'sealed') e.status = 'active'
        break
      case 'delete':
        e.status = 'deleted'
        e.pinned = false
        e.ledger.deletedCount += 1
        break
      default:
        return { ok: false, error: `不认识的动作：${action}` }
    }
    this.#history(e, { actor, action })
    this.#changed([e.scope])
    return { ok: true, id }
  }

  /** 生成器这一版不再支持它：转为候选，可逆，不算用户删除。置顶的不动。 */
  retract(ids, { actor, reason = '' } = {}) {
    const touched = []
    for (const id of [].concat(ids ?? [])) {
      const e = this.#byId(id)
      if (!e || e.pinned || e.status !== 'active') continue
      e.status = 'candidate'
      this.#history(e, { actor, action: 'retracted', reason })
      touched.push(e.scope)
    }
    if (touched.length) this.#changed(touched)
    return touched.length
  }

  /** 重要度 −1（原 QQ 交班里模型给的 drop）。置顶的不动。 */
  demote(ids, { actor, reason = '' } = {}) {
    const touched = []
    for (const id of [].concat(ids ?? [])) {
      const e = this.#byId(id)
      if (!e || e.pinned || e.importance === 0) continue
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
   * 因为系统提示段每一步都会重新求值。
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

  recall(query, scopes, limit = 5) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const scopeSet = new Set([].concat(scopes ?? []))
    const qNorm = normText(q)
    const grams = shingles(qNorm)
    return this.data.entries
      .filter((e) => scopeSet.has(e.scope) && (e.status === 'active' || e.status === 'candidate'))
      .map((e) => {
        const textNorm = normText(e.text)
        const score = jaccard(grams, e.text) + (qNorm.length >= 2 && textNorm.includes(qNorm) ? 0.5 : 0)
        return { e, score }
      })
      .filter((x) => x.score >= 0.1)
      .sort((a, b) => b.score - a.score || compareMemories(a.e, b.e))
      .slice(0, Math.max(1, Number(limit) || 5))
      .map((x) => ({ ...structuredClone(x.e), score: Math.round(x.score * 100) / 100 }))
  }

  // ── 老化 ──────────────────────────────────────────────────────────────

  /**
   * - 过期（validUntil 已过）的 active 降为 candidate；
   * - 每 everyGens 代：staleGens 代没再提到的重要度 −1；重要度 0、只提到过一次、dropGens 代没提到的删掉；
   * - 超过 maxPerScope 时，从排序最末尾删。置顶和封印的永远不删（封印要留着挡重复）。
   */
  age(scope, { gen = 0, now = this.now() } = {}) {
    const a = this.cfg.aging
    let decayed = 0
    let expired = 0
    let dropped = 0
    const pool = this.#inScope(scope)
    for (const e of pool) {
      if (e.status === 'active' && e.validUntil && e.validUntil <= now && !e.pinned) {
        e.status = 'candidate'
        this.#history(e, { actor: 'aging', action: 'expired' })
        expired += 1
      }
    }
    const keep = (e) => e.pinned || e.status === 'sealed'
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
    if (remove.size) {
      this.data.entries = this.data.entries.filter((e) => !remove.has(e))
      dropped = remove.size
    }
    if (decayed || expired || dropped) this.#changed([scope])
    return { decayed, expired, dropped }
  }

  // ── 批量（“忘掉我”、导出）────────────────────────────────────────────

  /** 删除匹配的记忆。query.block=true 时还会屏蔽这个范围，之后的写入一律丢弃。 */
  forget(query = {}, actor) {
    if (!MARK_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能批量删除记忆（actor=${actor}）`)
    if (query.scope === undefined && query.scopePrefix === undefined) throw new Error('forget 必须给出 scope 或 scopePrefix')
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
    if (!MARK_ACTORS.has(actor)) throw new Error(`只有控制台或设置页能解除屏蔽（actor=${actor}）`)
    this.data.blockedScopes = this.data.blockedScopes.filter((s) => s !== scope)
    this.#scheduleSave()
  }

  export(query = {}) {
    return { version: MEMORY_VERSION, exportedAt: this.now(), entries: this.list(query) }
  }
}

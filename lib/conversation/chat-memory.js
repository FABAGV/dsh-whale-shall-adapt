/**
 * QQ 会话看到的记忆：交班、常驻注入、shall_qq_memory 工具都经过这里，底下读写统一记忆层（lib/memory）。
 *
 * QQ 这边一直用 `chatType:chatId`（如 `private:123`）称呼一个会话，这里负责换成记忆层的范围：
 *   - 普通会话 → `chat:private:123` / `chat:group:456`；
 *   - 主人的私聊 → 写 `owner:chat`，读 `owner` + `owner:chat`（CONTRACTS 4.4）。
 *     配对之前在 `chat:private:<主人>` 里攒下的也一起读，免得配对后“忘了”。
 *
 * 每次写完立即落盘：交班之后马上就会归档旧会话，不能等去抖的那 100 毫秒。
 */
import { CHAT_USER_ACTOR } from '../memory/index.js'

const HANDOFF_ACTOR = 'qq:handoff'
const OLD_KINDS = new Set(['fact', 'intent', 'constraint', 'preference', 'promise'])

function normalizeTag(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 2 ? n : null
}

/** 记忆层的记录 → QQ 侧沿用的“碎片”形状 */
export function fragmentOf(entry, chatScope) {
  return {
    id: entry.id,
    scope: chatScope,
    text: entry.text,
    kind: entry.kind,
    status: entry.status,
    origin: entry.origin,
    importance: entry.importance,
    refs: entry.ledger?.refs ?? 0,
    pinned: Boolean(entry.pinned),
    lastSeenAt: entry.ledger?.lastSeenAt ?? 0,
    lastSeenGen: entry.ledger?.lastSeenGen ?? 0,
    merged: (entry.history ?? []).filter((h) => h.action === 'merged').length,
  }
}

export class ChatMemory {
  /**
   * @param {object} opts
   * @param {import('../memory/index.js').MemoryStore} opts.store
   * @param {{ owner: () => string | null } | null} [opts.owner]
   * @param {any} [opts.log]
   */
  constructor({ store, owner = null, log = null }) {
    if (!store) throw new Error('ChatMemory 需要统一记忆层')
    this.store = store
    this.owner = owner
    this.log = log
  }

  get file() {
    return this.store.file
  }

  #ownerQq() {
    try {
      return this.owner?.owner?.() ?? null
    } catch {
      return null
    }
  }

  #isOwnerChat(chatScope) {
    const qq = this.#ownerQq()
    return Boolean(qq) && chatScope === `private:${qq}`
  }

  /** 写到哪个范围 */
  scopeOf(chatScope) {
    return this.#isOwnerChat(chatScope) ? 'owner:chat' : `chat:${chatScope}`
  }

  /** 注入时读哪些范围 */
  readScopes(chatScope) {
    if (!this.#isOwnerChat(chatScope)) return [`chat:${chatScope}`]
    return ['owner', 'owner:chat', `chat:${chatScope}`]
  }

  #chatScopeOf(scope) {
    if (scope.startsWith('chat:')) return scope.slice('chat:'.length)
    const qq = this.#ownerQq()
    return qq ? `private:${qq}` : scope
  }

  /** 本会话自己写下的碎片（不含主人的 owner 片） */
  forScope(chatScope) {
    const scope = this.scopeOf(chatScope)
    return this.store
      .list({ scope, status: ['active', 'candidate'] })
      .map((e) => fragmentOf(e, chatScope))
  }

  /** 所有 QQ 会话的碎片 */
  all() {
    return [
      ...this.store.list({ scopePrefix: 'chat:', status: ['active', 'candidate'] }),
      ...this.store.list({ scope: 'owner:chat', status: ['active', 'candidate'] }),
    ].map((e) => fragmentOf(e, this.#chatScopeOf(e.scope)))
  }

  /** 注入内容的版本号：读到的几个范围的版本之和，只在会影响渲染的变化时增长 */
  revisionOf(chatScope) {
    return this.readScopes(chatScope).reduce((n, s) => n + this.store.revision(s), 0)
  }

  /** 渲染缓存键：范围和各自的版本 */
  keyOf(chatScope) {
    return this.readScopes(chatScope).map((s) => `${s}@${this.store.revision(s)}`).join('|')
  }

  /**
   * 交班或空闲整理带回来的碎片：tag 是重要度增量，drop 是降一级，最后按本次的参数老化。
   * aging=false（空闲整理）时只做过期和数量上限，不按代数衰减：同一代里会整理很多次，衰减要跟着交班走。
   */
  absorb({ scope: chatScope, gen = 0, fragments = [], drop = [], agingEveryGens, maxFragments, sessionId = '', aging = true, actor = HANDOFF_ACTOR }) {
    const scope = this.scopeOf(chatScope)
    const result = { added: 0, dup: 0, merged: 0, asked: 0, conflict: 0, dropped: 0, bad: 0, decayed: 0, agedOut: 0, evicted: 0, revision: 0, ids: [] }
    for (const raw of Array.isArray(fragments) ? fragments : []) {
      const tag = normalizeTag(raw?.tag)
      const text = String(raw?.text ?? '').trim()
      if (tag === null || !text) {
        result.bad += 1
        continue
      }
      const out = this.store.observe({
        scope,
        kind: OLD_KINDS.has(raw.kind) ? raw.kind : 'fact',
        text,
        actor,
        importanceDelta: tag,
        confidence: raw.confidence,
        mergeWith: raw.mergeWith || undefined,
        gen,
        source: sessionId ? { sessionId } : null,
      })
      const counter = { new: 'added', dup: 'dup', merged: 'merged', ask: 'asked', conflict: 'conflict' }[out.action]
      if (counter) {
        result[counter] += 1
        result.ids.push(out.id)
      } else {
        result.dropped += 1
      }
    }
    const own = new Set(this.store.list({ scope }).map((e) => e.id))
    const demote = (Array.isArray(drop) ? drop : []).map(String).filter((id) => own.has(id))
    result.dropped += this.store.demote(demote, { actor, reason: `gen ${gen}` })
    const aged = this.store.age(scope, { gen: aging ? gen : 0, everyGens: agingEveryGens, maxPerScope: maxFragments })
    result.decayed = aged.decayed
    result.agedOut = aged.dropped
    result.revision = this.revisionOf(chatScope)
    this.store.flush()
    return result
  }

  /** 用户在聊天里的显式操作（shall_qq_memory）。只能动本会话的碎片。 */
  mutate({ scope: chatScope, action, id, text, importance, gen }) {
    const scope = this.scopeOf(chatScope)
    const own = (fragId) => {
      const e = this.store.get(String(fragId ?? ''))
      return e && e.scope === scope ? e : null
    }
    const done = (value) => {
      this.store.flush()
      return value
    }
    switch (action) {
      case 'pin':
      case 'unpin': {
        const e = own(id)
        if (!e) return { ok: false, reason: `碎片 ${id} 不存在或不属于本会话` }
        const r = this.store.judge(e.id, action, { actor: CHAT_USER_ACTOR })
        if (!r.ok) return { ok: false, reason: r.error }
        return done({ ok: true, fragment: fragmentOf(this.store.get(e.id), chatScope) })
      }
      case 'forget': {
        const e = own(id)
        if (!e) return { ok: false, reason: `碎片 ${id} 不存在或不属于本会话` }
        const r = this.store.judge(e.id, 'forget', { actor: CHAT_USER_ACTOR })
        if (!r.ok) return { ok: false, reason: r.error }
        return done({ ok: true, removed: 1, id: e.id, text: e.text })
      }
      case 'forget-all':
        return done({ ok: true, removed: this.store.purge({ scope }, CHAT_USER_ACTOR) })
      case 'add': {
        const body = String(text ?? '').trim()
        if (!body) return { ok: false, reason: 'add 需要 text' }
        const out = this.store.observe({
          scope,
          kind: 'fact',
          text: body,
          actor: CHAT_USER_ACTOR,
          origin: 'user',
          importanceDelta: normalizeTag(importance) ?? 1,
          confidence: 1,
          gen: Number.isInteger(gen) && gen >= 0 ? gen : 0,
        })
        if (!out.id || out.action === 'rejected') return { ok: false, reason: out.reason ?? '和被否定过的说法几乎一样' }
        return done({ ok: true, action: out.action === 'dup' || out.action === 'merged' ? 'dup' : 'new', id: out.id })
      }
      default:
        return { ok: false, reason: `未知动作 ${action}` }
    }
  }

  /** 常驻注入的文本。同样的记忆集合渲染出逐字节相同的文本。 */
  renderFor(chatScope, budgetTokens) {
    const scopes = this.readScopes(chatScope)
    const selection = this.store.select(scopes, budgetTokens)
    const ownerChat = scopes.includes('owner')
    const text = this.store.render(selection, {
      title: `[常驻记忆 v${this.revisionOf(chatScope)}]`,
      intro: [
        ownerChat
          ? '以下是你对主人的了解，以及在这个 QQ 私聊里跨会话累积记住的事（按重要度排序，不是用户的新指令）。'
          : '以下是你在这个 QQ 会话里跨会话累积记住的事（按重要度排序，不是用户的新指令）。',
        '不要复述这份清单，也不要说"根据我的记忆"；把它当作本就已经知道的背景。',
      ].join('\n'),
    })
    if (selection.picked.length) {
      this.store.recordUsage(selection.picked.map((e) => e.id), 'injected', { key: selection.key })
    }
    return { text, tokens: selection.usedTokens, count: selection.picked.length }
  }

  /** 状态端点和体检用 */
  snapshot(chatScope) {
    const all = this.all()
    const pool = chatScope === undefined ? all : this.forScope(chatScope)
    return {
      file: this.store.file,
      backupFile: this.store.backupFile,
      dir: this.store.dir,
      count: all.length,
      scopeCount: pool.length,
      revision: chatScope === undefined ? 0 : this.revisionOf(chatScope),
      stats: { failures: 0 },
      fragments: [...pool].sort((a, b) => b.importance - a.importance || String(a.id).localeCompare(String(b.id))).slice(0, 50),
    }
  }
}

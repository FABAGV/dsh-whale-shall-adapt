/**
 * 会话绑定表：哪个 DSH 会话属于哪个 QQ 聊天（docs/CONTRACTS.md 第 5、6 节）。
 *
 * 插件自己建的常驻会话一律登记在这里，权限分类先查它，查不到才退回看工作区目录名。
 * 交班换下来的旧会话也留着（标 current:false）：你在 GUI 里打开归档的旧会话、它派出的子代理，
 * 仍然要被认成 QQ 会话。否定结果不缓存：会话后来被登记，下一次查询就能读到。
 */
import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1
const MAX_DEPTH = 8

export function createBindings(options) {
  return new Bindings(options)
}

export class Bindings {
  /**
   * @param {object} opts
   * @param {string} opts.dir 状态目录（$DSH_HOME/shall/qq）
   */
  constructor({ dir, log = null, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('Bindings 需要 dir')
    this.dir = dir
    this.file = path.join(dir, 'bindings.json')
    this.log = log
    this.now = now
    this.listeners = new Set()
    this.sessions = new Map()
    this.#load()
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [id, rec] of Object.entries(parsed?.sessions ?? {})) {
        if (rec && (rec.chatType === 'group' || rec.chatType === 'private') && rec.chatId) this.sessions.set(id, rec)
      }
    } catch (error) {
      this.log?.warn?.(`[bindings] bindings.json 读不懂，按空表开始：${error?.message ?? error}`)
    }
  }

  #save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, sessions: Object.fromEntries(this.sessions) }, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.log?.warn?.(`[bindings] 落盘失败：${error?.message ?? error}`)
    }
  }

  #emit(sessionId) {
    for (const fn of this.listeners) {
      try {
        fn(sessionId)
      } catch (error) {
        this.log?.warn?.(`[bindings] onChange 监听器出错：${error?.message ?? error}`)
      }
    }
  }

  /** 登记一个聊天的当前常驻会话。同一个聊天之前的当前会话转为退役（仍然认得）。 */
  bind(chatType, chatId, sessionId, { generation } = {}) {
    if (!sessionId || (chatType !== 'group' && chatType !== 'private') || !chatId) return null
    const chatKey = `${chatType}:${chatId}`
    const now = this.now()
    const changed = [sessionId]
    for (const [id, rec] of this.sessions) {
      if (id !== sessionId && rec.chatKey === chatKey && rec.current) {
        rec.current = false
        rec.retiredAt = now
        changed.push(id)
      }
    }
    const prev = this.sessions.get(sessionId)
    const rec = {
      chatType,
      chatId: String(chatId),
      chatKey,
      generation: Number(generation ?? prev?.generation ?? 1) || 1,
      current: true,
      boundAt: prev?.boundAt ?? now,
      retiredAt: null,
    }
    this.sessions.set(sessionId, rec)
    this.#save()
    for (const id of changed) this.#emit(id)
    return { ...rec }
  }

  /** 这个聊天现在没有当前会话了（建会话失败、交班中断）：当前那台转为退役，仍然认得。 */
  retireCurrent(chatType, chatId) {
    const chatKey = `${chatType}:${chatId}`
    const changed = []
    for (const [id, rec] of this.sessions) {
      if (rec.chatKey === chatKey && rec.current) {
        rec.current = false
        rec.retiredAt = this.now()
        changed.push(id)
      }
    }
    if (changed.length) {
      this.#save()
      for (const id of changed) this.#emit(id)
    }
    return changed.length
  }

  /** 从 QQ 侧的旧状态补登记（升级前建的会话、交班历史里的旧会话）。已登记的不动。 */
  seed(chats) {
    let added = 0
    for (const chat of chats ?? []) {
      const { chatType, chatId } = chat
      if ((chatType !== 'group' && chatType !== 'private') || !chatId) continue
      const chatKey = `${chatType}:${chatId}`
      const older = new Set()
      for (const h of Array.isArray(chat.handoffHistory) ? chat.handoffHistory : []) {
        if (h?.from) older.add(String(h.from))
        if (h?.to) older.add(String(h.to))
      }
      if (chat.rootSessionId) older.delete(chat.rootSessionId)
      for (const id of older) {
        if (this.sessions.has(id)) continue
        this.sessions.set(id, { chatType, chatId: String(chatId), chatKey, generation: 1, current: false, boundAt: this.now(), retiredAt: this.now() })
        added += 1
      }
      if (chat.rootSessionId && !this.sessions.has(chat.rootSessionId)) {
        this.sessions.set(chat.rootSessionId, {
          chatType, chatId: String(chatId), chatKey, generation: Number(chat.rootGeneration) || 1, current: true, boundAt: this.now(), retiredAt: null,
        })
        added += 1
      }
    }
    if (added) this.#save()
    return added
  }

  /** 会话本身登记过就返回它的聊天，没有返回 null（同步，不缓存否定结果）。 */
  chatOf(sessionId) {
    const rec = sessionId ? this.sessions.get(String(sessionId)) : null
    return rec ? { ...rec } : null
  }

  /**
   * 带子代理的解析：先看这个会话，再沿 parentSession 往上找，最多 8 层。
   * @param {{id?:string, parentSession?:string}} header
   * @param {(id:string)=>object|undefined} [lookupHeader] 父会话的会话头
   * @returns {object|null} 找到就是聊天记录（子代理带 viaParent:true），找不到返回 null
   */
  resolve(header, lookupHeader) {
    let current = header ?? {}
    const seen = new Set()
    for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
      const hit = this.chatOf(current.id)
      if (hit) return depth === 0 ? hit : { ...hit, viaParent: true }
      const parentId = current.parentSession
      if (!parentId || seen.has(parentId) || typeof lookupHeader !== 'function') return null
      seen.add(parentId)
      current = lookupHeader(parentId) ?? { id: parentId }
    }
    return null
  }

  list() {
    return [...this.sessions].map(([sessionId, rec]) => ({ sessionId, ...rec }))
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

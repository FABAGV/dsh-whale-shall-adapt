/**
 * 梗百科：本群黑话 → 本地词库，查到就给出一段附加背景（docs/CONTRACTS.md 第 11 节）。
 *
 * 词库是 astrbot_plugin_memewiki 格式的 SQLite（表 memes(title, slug, tags, usage, origin, other, summary)），
 * 内容来自 cnmeme.wiki，不随本插件分发，由用户在控制台导入到 `$DSH_HOME/shall/meme/memes.db`。
 * 查询逻辑照搬 memewiki v1.7.0（MIT，Copyright (c) 2026 in1t1a1）的 `_local_match` / `_entry_text`。
 *
 * 只读打开，每次查询开连接、用完就关：一直攥着句柄会让 Windows 上替换词库文件失败。
 * 本文件不写盘、不联网；检索存档与联网同步在后续的 lib/meme/sync.js。
 */
import fs from 'node:fs'
import { extractQuery, normalizeQuery, worthLookup } from './rules.js'

const USAGE_MAX = 600
const ORIGIN_MAX = 450
const OTHER_MAX = 400
const ENTRY_MAX = 900

let sqlitePromise = null
/** node:sqlite 在 Node 22.5 以后才有；宿主的 Node 太老时如实报告不可用，不抛。 */
function loadSqlite() {
  sqlitePromise ??= import('node:sqlite').then((m) => m.DatabaseSync).catch(() => null)
  return sqlitePromise
}

const clip = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 群黑话在记忆层里存成一行“名称：含义”。 */
export function parseSlang(text) {
  const m = /^\s*([^：:]{1,20})\s*[：:]\s*(.+)$/.exec(String(text ?? ''))
  return m ? { title: m[1].trim(), meaning: m[2].trim() } : null
}

export function formatSlang(title, meaning) {
  return `${String(title).trim()}：${String(meaning).trim()}`
}

/** 给模型看的词条文本：用法在前，出处标“仅用于理解”，整段不超过 900 字。 */
export function entryText(data) {
  const lines = [`【梗百科】${data.title}`]
  if (data.tags?.length) lines.push(`标签：${data.tags.join('、')}`)
  if (data.custom) {
    lines.push(`【含义】\n${clip(data.usage, USAGE_MAX)}`)
    lines.push(`（本群黑话）`)
  } else {
    if (data.usage) lines.push(`【怎么用 / 怎么接】\n${clip(data.usage, USAGE_MAX)}`)
    if (data.origin) lines.push(`【出处（仅用于理解，别照搬）】\n${clip(data.origin, ORIGIN_MAX)}`)
    if (data.other) lines.push(clip(data.other, OTHER_MAX))
    if (data.slug) lines.push(`cnmeme.wiki/词条/${data.slug}`)
  }
  return clip(lines.join('\n'), ENTRY_MAX)
}

export function createMemeBase(options = {}) {
  return new MemeBase(options)
}

export class MemeBase {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath 词库文件；不存在时只查本群黑话
   * @param {import('../memory/index.js').MemoryStore} [opts.memory] 本群黑话来自记忆层
   */
  constructor({ dbPath, memory = null, log = null, maxChars = 10 } = {}) {
    this.dbPath = dbPath
    this.memory = memory
    this.log = log
    this.maxChars = maxChars
    this.warned = new Set()
  }

  #warnOnce(key, message) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log?.warn?.(`[meme] ${message}`)
  }

  /** 词库现在能不能用：{ ok, reason?, count? }。 */
  async status() {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return { ok: false, reason: '还没导入词库' }
    const Db = await loadSqlite()
    if (!Db) return { ok: false, reason: '当前 Node 没有 node:sqlite（需要 22.5 或更新）' }
    try {
      const db = new Db(this.dbPath, { readOnly: true })
      try {
        return { ok: true, count: Number(db.prepare('SELECT count(*) AS c FROM memes').get().c) }
      } finally {
        db.close()
      }
    } catch (error) {
      return { ok: false, reason: `词库打不开：${error?.message ?? error}` }
    }
  }

  #slang(chatKey, query) {
    if (!this.memory || !String(chatKey ?? '').startsWith('chat:group:')) return null
    let best = null
    for (const e of this.memory.list({ scope: chatKey, kind: 'slang', status: 'active' })) {
      const s = parseSlang(e.text)
      if (!s) continue
      if (s.title === query) return { ...s, id: e.id }
      if (s.title.length >= 2 && query.includes(s.title) && (!best || s.title.length > best.title.length)) best = { ...s, id: e.id }
    }
    return best
  }

  /** 只认完整梗名：先精确匹配，再找消息里包含的最长标题（“你是什么”不会命中“你是什么冠军”）。 */
  async #dbLookup(query) {
    if (!this.dbPath || !fs.existsSync(this.dbPath)) return null
    const Db = await loadSqlite()
    if (!Db) {
      this.#warnOnce('sqlite', '当前 Node 没有 node:sqlite，词库查不了，只查本群黑话')
      return null
    }
    let db
    try {
      db = new Db(this.dbPath, { readOnly: true })
      const exact = db.prepare('SELECT * FROM memes WHERE title = ?').get(query)
      if (exact) return exact
      return db.prepare('SELECT * FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1').get(query) ?? null
    } catch (error) {
      this.#warnOnce('open', `词库打不开，当作没收录：${error?.message ?? error}`)
      return null
    } finally {
      db?.close()
    }
  }

  /** 查一个词：本群黑话优先，再查词库。查不到返回 null。 */
  async lookup(term, { chatKey } = {}) {
    const query = normalizeQuery(term)
    if (!query) return null
    const slang = this.#slang(chatKey, query)
    if (slang) {
      return { title: slang.title, usage: slang.meaning, custom: true, memoryId: slang.id, tags: [], origin: '', other: '', slug: '' }
    }
    const row = await this.#dbLookup(query)
    if (!row) return null
    return {
      title: row.title,
      slug: row.slug ?? '',
      tags: String(row.tags ?? '').split(/[、,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 8),
      usage: row.usage || row.summary || '',
      origin: row.origin ?? '',
      other: row.other ?? '',
      custom: false,
    }
  }

  /**
   * 一条 QQ 消息要不要带梗百科背景。返回：
   *   { query, entry, text }        查到了：text 就是要附在消息后面的背景
   *   { query, verdict }            没查到：verdict 是 rules.worthLookup 的三态（null = 交给模型闸门）
   *   null                          这条消息里没有像梗的词
   */
  async prelookup(message, { chatKey, names = [] } = {}) {
    const raw = String(message ?? '')
    const query = extractQuery(raw, { names })
    if (!query) return null
    const entry = await this.lookup(query, { chatKey })
    if (entry) return { query: normalizeQuery(query), entry, text: entryText(entry) }
    return { query: normalizeQuery(query), verdict: worthLookup(raw, query, { maxChars: this.maxChars }) }
  }
}

/**
 * 梗百科：本群黑话 → 本地词库，查到就给出一段附加背景（docs/CONTRACTS.md 第 11 节）。
 *
 * 词库是 astrbot_plugin_memewiki 格式的 SQLite（表 memes(title, slug, tags, usage, origin, other, summary)），
 * 内容来自 cnmeme.wiki，不随本插件分发，由用户在控制台导入到 `$DSH_HOME/shall/meme/memes.db`。
 * 查询逻辑照搬 memewiki v1.7.0（MIT，Copyright (c) 2026 in1t1a1）的 `_local_match` / `_entry_text`。
 *
 * 只读打开，每次查询开连接、用完就关：一直攥着句柄会让 Windows 上替换词库文件失败。
 * 本文件自己不联网：联网查词与同步在 sync.js，检索存档在 archive.js，模型闸门在 gate.js，三者都由用户在控制台打开联网后才起作用。
 * 查词顺序：本群黑话 → 词库 → 检索存档 → （联网打开时）联网。
 */
import fs from 'node:fs'
import { isPlainObject, loadJsonOrQuarantine, writeJsonAtomic } from '../core/fs-atomic.js'
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
  constructor({ dbPath, memory = null, log = null, maxChars = 10, online = null, archive = null, settingsFile = '' } = {}) {
    this.dbPath = dbPath
    this.memory = memory
    this.log = log
    this.maxChars = maxChars
    /** @type {import('./sync.js').MemeOnline|null} */
    this.online = online
    /** @type {import('./archive.js').MemeArchive|null} */
    this.archive = archive
    this.settingsFile = settingsFile
    /** 模型闸门（qq 插件有了便宜模型之后装上）：(query, raw) → { lookup, term } */
    this.gate = null
    this.warned = new Set()
    this.settings = { online: false }
    this.#loadSettings()
  }

  #loadSettings() {
    if (!this.settingsFile) return
    // 读不懂的设置文件改名留档，按默认（联网关）
    const parsed = loadJsonOrQuarantine(this.settingsFile, { log: this.log, fallback: null, validate: isPlainObject })
    if (parsed) this.settings = { online: parsed.online === true }
  }

  getSettings() {
    return { ...this.settings }
  }

  /** 控制台：联网开关。默认关；联网只发往 cnmeme.wiki 的公开只读接口 */
  setSettings(patch) {
    if (patch && typeof patch.online === 'boolean') this.settings.online = patch.online
    try {
      if (this.settingsFile) writeJsonAtomic(this.settingsFile, this.settings)
    } catch (error) {
      this.log?.warn?.(`[meme] 设置落盘失败：${error?.message ?? error}`)
    }
    return this.getSettings()
  }

  /** 控制台梗百科页的总览 */
  async overview() {
    return {
      dbPath: this.dbPath,
      db: await this.status(),
      settings: this.getSettings(),
      archive: this.archive?.stats() ?? null,
      sync: this.online?.status() ?? null,
    }
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

  /** 词库/存档里的一行 → 词条 */
  #entryOf(row) {
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
   * 查一个词：本群黑话 → 词库 → 检索存档 → （online=true 且用户打开了联网时）联网。查不到返回 null。
   * 联网出错不存档：别把“请求失败”存成“没有这个梗”。
   */
  async lookup(term, { chatKey, online = false } = {}) {
    const query = normalizeQuery(term)
    if (!query) return null
    const slang = this.#slang(chatKey, query)
    if (slang) {
      return { title: slang.title, usage: slang.meaning, custom: true, memoryId: slang.id, tags: [], origin: '', other: '', slug: '' }
    }
    const row = await this.#dbLookup(query)
    if (row) return this.#entryOf(row)
    const archived = this.archive?.get(query)
    if (archived?.status === 'ok') return this.#entryOf(archived.row)
    if (archived?.status === 'miss') return null
    if (online && this.online && this.settings.online) {
      try {
        const fetched = await this.online.lookup(query)
        this.archive?.put(query, fetched)
        return fetched ? this.#entryOf(fetched) : null
      } catch (error) {
        this.#warnOnce('online', `联网查词失败，这次当作没有：${error?.message ?? error}`)
      }
    }
    return null
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
    const verdict = worthLookup(raw, query, { maxChars: this.maxChars })
    // 联网打开时：明确在问的词直接查；说不准的先过模型闸门
    if (verdict !== false && this.online && this.settings.online) {
      let term = query
      if (verdict === null && this.gate) {
        const gated = await this.gate(normalizeQuery(query), raw)
        if (!gated.lookup) return { query: normalizeQuery(query), verdict: false }
        term = gated.term || query
      }
      const fetched = await this.lookup(term, { chatKey, online: true })
      if (fetched) return { query: normalizeQuery(term), entry: fetched, text: entryText(fetched) }
    }
    return { query: normalizeQuery(query), verdict }
  }
}

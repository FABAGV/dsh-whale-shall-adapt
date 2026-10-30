/**
 * 梗百科的联网部分：本插件里**唯一**会往外发请求的文件（docs/CONTRACTS.md 第 11 节）。默认关，用户在控制台里打开。
 *
 * 数据来自 cnmeme.wiki 的公开只读接口（内容版权归该站和原作者，不随本插件分发）：
 *   GET /api/v1/public/memes?limit=30&offset=N   → { items: [{ slug, title, summary, tags, updated_at }], has_more }
 *   GET /api/v1/public/memes/{slug}              → { item: { …, content_html } }
 * 思路和 HTML 拆段规则来自 astrbot_plugin_memewiki v1.7.0（MIT，Copyright (c) 2026 in1t1a1）的 scripts/sync_memes.py、pack_data.py。
 *
 * 两个入口：
 *   lookup(term)  查一个词：slug 就是小写的标题，直接取详情，404 = 没有。查完存进检索存档（archive.js）。
 *   sync()        增量同步到本地词库：按更新时间倒序翻列表，遇到整页都没变就停；只抓新增和变更的详情。
 * 都限速（默认 0.35 秒一次），遇到 429 按 Retry-After 退避（最多等 60 秒）。同步在后台跑，可以随时停。
 */
import fs from 'node:fs'
import path from 'node:path'

export const API_BASE = 'https://cnmeme.wiki/api/v1/public/memes'
const UA = 'dsh-whale-shall-adapt-meme/0.1 (+personal use; rate limited)'
const PAGE_LIMIT = 30
const DEFAULT_SLEEP_MS = 350
const MAX_RETRY = 3
const MAX_WAIT_S = 60
const REQUEST_TIMEOUT_MS = 12000

let sqlitePromise = null
function loadSqlite() {
  sqlitePromise ??= import('node:sqlite').then((m) => m.DatabaseSync).catch(() => null)
  return sqlitePromise
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

export function htmlToText(raw) {
  const s = String(raw ?? '')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<\/h2>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/p>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 按小节标题拆成“怎么用 / 出处 / 其他” */
export function splitSections(text) {
  const usage = []
  const origin = []
  const other = []
  for (const part of `\n${text ?? ''}`.split(/\n##\s*/)) {
    const body = part.trim()
    if (!body) continue
    const nl = body.indexOf('\n')
    const head = (nl < 0 ? body : body.slice(0, nl)).trim()
    const rest = nl < 0 ? '' : body.slice(nl + 1).trim()
    if (['用法', '怎么用', '如何用', '例句', '接梗'].some((k) => head.includes(k))) usage.push(rest || head)
    else if (['来源', '出处', '背景', '起源', '介绍'].some((k) => head.includes(k))) origin.push(rest || head)
    else other.push(rest ? `${head}\n${rest}`.trim() : head)
  }
  return { usage: usage.join('\n').trim(), origin: origin.join('\n').trim(), other: other.join('\n').trim() }
}

/** 接口里的一条详情 → 词库里的一行（和 memewiki 的 memes 表同一形状） */
export function rowFromItem(item, listItem = {}) {
  const title = String(item?.title ?? listItem.title ?? '').trim()
  const slug = String(item?.slug ?? listItem.slug ?? '').trim()
  if (!title || !slug) return null
  const summary = String(item?.summary ?? listItem.summary ?? '')
  const body = htmlToText(item?.content_html) || summary
  const sec = splitSections(body)
  const tags = Array.isArray(item?.tags) ? item.tags : Array.isArray(listItem.tags) ? listItem.tags : []
  return { title, slug, tags: tags.map(String).join('、'), usage: sec.usage, origin: sec.origin, other: sec.other, summary }
}

const sleepMs = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

export class MemeOnline {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath 本地词库（没有就新建）
   * @param {typeof fetch} [opts.fetchImpl] 测试时换成假的
   */
  constructor({ dbPath, fetchImpl = globalThis.fetch, base = API_BASE, sleep = sleepMs, sleepBetweenMs = DEFAULT_SLEEP_MS, log = null, now = () => Date.now() }) {
    this.dbPath = dbPath
    this.fetchImpl = fetchImpl
    this.base = base
    this.sleep = sleep
    this.sleepBetweenMs = sleepBetweenMs
    this.log = log
    this.now = now
    this.job = null
    this.controller = null
    this.stats = { requests: 0, rateLimited: 0, failures: 0, lookups: 0 }
  }

  /** 一次 GET。404 → { status: 404 }；429 按 Retry-After 退避重试；别的错误 → null */
  async #get(url, signal) {
    if (typeof this.fetchImpl !== 'function') return null
    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
      if (signal?.aborted) return null
      try {
        this.stats.requests += 1
        const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
        const merged = signal && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
        const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: merged })
        if (res.status === 429) {
          this.stats.rateLimited += 1
          const wait = Math.min(MAX_WAIT_S, Math.max(1, Number(res.headers?.get?.('retry-after')) || 5))
          this.log?.warn?.(`[meme] cnmeme.wiki 限流，等 ${wait} 秒`)
          await this.sleep(wait * 1000, signal)
          continue
        }
        if (res.status === 404) return { status: 404, json: null }
        if (!res.ok) {
          this.stats.failures += 1
          return null
        }
        return { status: 200, json: await res.json() }
      } catch (error) {
        this.stats.failures += 1
        this.log?.warn?.(`[meme] 请求失败：${error?.message ?? error}`)
        await this.sleep(1000 * (attempt + 1), signal)
      }
    }
    return null
  }

  /** 查一个词（slug 是小写的标题）。查到返回一行，没有返回 null；请求出错抛错，好让调用方不要把“出错”存成“没有”。 */
  async lookup(term) {
    const slug = String(term ?? '').trim().toLowerCase()
    if (!slug || slug.length > 40) return null
    this.stats.lookups += 1
    const res = await this.#get(`${this.base}/${encodeURIComponent(slug)}`)
    if (!res) throw new Error('联网查询失败')
    if (res.status === 404) return null
    return rowFromItem(res.json?.item)
  }

  status() {
    return { job: this.job ? { ...this.job } : null, ...this.stats }
  }

  stop() {
    this.controller?.abort()
  }

  /**
   * 增量同步到本地词库（后台跑，同一时间只有一个）。
   * @param {{ incremental?: boolean, limit?: number }} [opts] limit: 本次最多抓多少条详情，0 = 不限
   * @returns {Promise<object>} 结束时的 job 记录
   */
  async sync({ incremental = true, limit = 0 } = {}) {
    if (this.job?.running) return this.job
    const Db = await loadSqlite()
    if (!Db) {
      this.job = { running: false, error: '当前 Node 没有 node:sqlite（需要 22.5 或更新）', finishedAt: this.now() }
      return this.job
    }
    this.controller = new AbortController()
    const signal = this.controller.signal
    const job = { running: true, startedAt: this.now(), phase: 'list', pages: 0, listed: 0, changed: 0, fetched: 0, failed: 0, stoppedEarly: false, error: null, finishedAt: 0 }
    this.job = job
    let db = null
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
      db = new Db(this.dbPath)
      db.exec('CREATE TABLE IF NOT EXISTS memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT)')
      db.exec('CREATE TABLE IF NOT EXISTS meme_sync (slug TEXT PRIMARY KEY, updated_at TEXT)')
      const seen = new Map(db.prepare('SELECT slug, updated_at FROM meme_sync').all().map((r) => [r.slug, r.updated_at]))
      const upsert = db.prepare('INSERT OR REPLACE INTO memes (title, slug, tags, usage, origin, other, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const mark = db.prepare('INSERT OR REPLACE INTO meme_sync (slug, updated_at) VALUES (?, ?)')

      // 1) 翻列表，挑出新增和变更的
      const todo = []
      for (let offset = 0; !signal.aborted; offset += PAGE_LIMIT) {
        const res = await this.#get(`${this.base}?limit=${PAGE_LIMIT}&offset=${offset}`, signal)
        if (!res || res.status !== 200 || !Array.isArray(res.json?.items)) {
          job.error = '翻列表中断，本次结果作废，已有词库不动'
          return job
        }
        const batch = res.json.items.filter((x) => x?.slug && x?.title)
        job.pages += 1
        job.listed += batch.length
        const changed = batch.filter((x) => seen.get(String(x.slug)) !== String(x.updated_at ?? ''))
        todo.push(...changed)
        job.changed = todo.length
        if (incremental && batch.length >= PAGE_LIMIT && changed.length === 0) {
          job.stoppedEarly = true
          break
        }
        if (!res.json.has_more || batch.length === 0) break
        await this.sleep(this.sleepBetweenMs, signal)
      }

      // 2) 抓详情并写库（每 50 条一个事务）
      job.phase = 'detail'
      const queue = limit > 0 ? todo.slice(0, limit) : todo
      let pending = 0
      db.exec('BEGIN')
      try {
        for (const item of queue) {
          if (signal.aborted) break
          const res = await this.#get(`${this.base}/${encodeURIComponent(String(item.slug))}`, signal)
          const row = res?.status === 200 ? rowFromItem(res.json?.item, item) : null
          if (!row) {
            job.failed += 1
          } else {
            upsert.run(row.title, row.slug, row.tags, row.usage, row.origin, row.other, row.summary)
            mark.run(String(item.slug), String(item.updated_at ?? ''))
            job.fetched += 1
            pending += 1
          }
          if (pending >= 50) {
            db.exec('COMMIT')
            db.exec('BEGIN')
            pending = 0
          }
          await this.sleep(this.sleepBetweenMs, signal)
        }
      } finally {
        db.exec('COMMIT')
      }
      if (signal.aborted) job.error = '已手动停止（已抓的词条保留，下次接着来）'
    } catch (error) {
      job.error = `同步出错：${error?.message ?? error}`
      this.log?.warn?.(`[meme] ${job.error}`)
    } finally {
      try {
        db?.close()
      } catch {
        /* 已关闭 */
      }
      job.running = false
      job.phase = 'done'
      job.finishedAt = this.now()
      this.controller = null
    }
    return job
  }
}

/**
 * 检索存档：联网查过的词存在本地，同一个词不重复发请求（PLAN 第 46 条；思路来自 memewiki 的 search_archive.db）。
 *
 * 查到的存 90 天，没查到的（负缓存）存 3 天；最多留 2000 条，满了先丢最旧的。
 * 只存联网（cnmeme.wiki）查到的结果。模型自己的说法、群友说的“XX 就是……”不进这里：
 * 这份存档对所有群通用，被人带偏就是所有群一起错；群里的说法只能存成该群自己的黑话（记忆层的 slang）。
 */
import { isPlainObject, loadJsonOrQuarantine, writeJsonAtomic } from '../core/fs-atomic.js'

const DAY = 24 * 3600 * 1000
const SAVE_DEBOUNCE_MS = 500

const keyOf = (term) => String(term ?? '').trim().toLowerCase()

export class MemeArchive {
  constructor({ file, ttlDays = 90, missTtlDays = 3, max = 2000, now = () => Date.now(), log = null }) {
    this.file = file
    this.ttlMs = ttlDays * DAY
    this.missTtlMs = missTtlDays * DAY
    this.max = max
    this.now = now
    this.log = log
    this.entries = new Map()
    this.timer = null
    this.dirty = false
    this.hits = 0
    this.#load()
  }

  #load() {
    if (!this.file) return
    // 读不懂的存档改名留档再按空的开始
    const parsed = loadJsonOrQuarantine(this.file, { log: this.log, fallback: null, validate: isPlainObject })
    for (const [key, value] of Object.entries(isPlainObject(parsed?.entries) ? parsed.entries : {})) {
      if (value && (value.status === 'ok' || value.status === 'miss') && Number.isFinite(value.at)) this.entries.set(key, value)
    }
  }

  #save() {
    this.dirty = false
    try {
      writeJsonAtomic(this.file, { version: 1, entries: Object.fromEntries(this.entries) }, { space: 0 })
    } catch (error) {
      this.log?.warn?.(`[meme] 检索存档落盘失败：${error?.message ?? error}`)
    }
  }

  #touch() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.dirty) this.#save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 没存过、或存的已过期 → null；否则 { status: 'ok', row } 或 { status: 'miss' } */
  get(term) {
    const key = keyOf(term)
    const entry = this.entries.get(key)
    if (!entry) return null
    const age = this.now() - entry.at
    if (age > (entry.status === 'ok' ? this.ttlMs : this.missTtlMs)) {
      this.entries.delete(key)
      this.#touch()
      return null
    }
    this.hits += 1
    return entry.status === 'ok' ? { status: 'ok', row: entry.row, ageMs: age } : { status: 'miss', ageMs: age }
  }

  /** row 为 null 表示联网也没有（负缓存） */
  put(term, row) {
    const key = keyOf(term)
    if (!key) return
    this.entries.set(key, row ? { status: 'ok', at: this.now(), row } : { status: 'miss', at: this.now() })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value)
    this.#touch()
  }

  clear() {
    const n = this.entries.size
    this.entries.clear()
    this.#touch()
    return n
  }

  stats() {
    const values = [...this.entries.values()]
    return { total: values.length, ok: values.filter((e) => e.status === 'ok').length, miss: values.filter((e) => e.status === 'miss').length, hits: this.hits }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.#save()
  }
}

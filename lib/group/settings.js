/**
 * 群的运行时设置：`$DSH_HOME/shall/groups.json`。
 *
 * 配置文件管全局默认值和“这个群怎么设”的模板；控制台里点的东西（接入哪个群、改档位）写在这里，
 * 不改用户的配置文件。准入的规则是：配置里的 `qq.scope.groups`（含 `*`）∪ 这里 `admitted: true` 的群，
 * 黑名单永远优先。
 *
 * 没接入的群只记“见过”：群号、群名、最后一次、条数，不记任何内容。控制台据此列出“被拉进了这些群，要不要接”。
 */
import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1
const SAVE_DEBOUNCE_MS = 400
/** 每个群留多少条“主动插话结果”（插话被接住率用） */
export const INTERJECT_HISTORY_MAX = 20
/** “见过的群”最多留多少个，防止被拉进大量群时无限增长 */
const SEEN_MAX = 200

export function createGroupSettings(options) {
  return new GroupSettings(options)
}

const validGroupId = (id) => /^\d{1,12}$/.test(String(id ?? ''))

export class GroupSettings {
  constructor({ dir, log = null, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('GroupSettings 需要 dir')
    this.dir = dir
    this.file = path.join(dir, 'groups.json')
    this.log = log
    this.now = now
    this.groups = new Map()
    this.listeners = new Set()
    this.timer = null
    this.dirty = false
    this.#load()
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [id, rec] of Object.entries(parsed?.groups ?? {})) {
        if (validGroupId(id) && rec && typeof rec === 'object') this.groups.set(id, rec)
      }
    } catch (error) {
      this.log?.warn?.(`[group] groups.json 读不懂，按空表开始：${error?.message ?? error}`)
    }
  }

  #save() {
    this.dirty = false
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, groups: Object.fromEntries(this.groups) }, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      this.log?.warn?.(`[group] groups.json 落盘失败：${error?.message ?? error}`)
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

  #emit(groupId) {
    for (const fn of this.listeners) {
      try {
        fn(groupId)
      } catch (error) {
        this.log?.warn?.(`[group] 设置监听器出错：${error?.message ?? error}`)
      }
    }
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  #record(groupId, create = true) {
    const id = String(groupId)
    let rec = this.groups.get(id)
    if (!rec && create) {
      rec = { firstSeenAt: this.now(), lastSeenAt: this.now(), seenCount: 0 }
      this.groups.set(id, rec)
    }
    return rec ?? null
  }

  /** 这个群是不是被控制台打开过 */
  isAdmitted(groupId) {
    return this.groups.get(String(groupId))?.admitted === true
  }

  /** 控制台打开或关闭一个群 */
  setAdmitted(groupId, admitted) {
    if (!validGroupId(groupId)) throw new Error('群号需要是纯数字')
    const rec = this.#record(groupId)
    rec.admitted = Boolean(admitted)
    rec.admittedAt = admitted ? this.now() : rec.admittedAt
    this.#touch()
    this.#emit(String(groupId))
    return this.get(groupId)
  }

  /** 控制台改这个群的设置（档位、积极度……）。传 null 的字段表示恢复成默认 */
  setSettings(groupId, patch) {
    if (!validGroupId(groupId)) throw new Error('群号需要是纯数字')
    const rec = this.#record(groupId)
    const next = { ...(rec.settings ?? {}) }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = value
    }
    rec.settings = next
    this.#touch()
    this.#emit(String(groupId))
    return this.get(groupId)
  }

  /** 见到这个群的一条消息（没接入的群也记，只记数不记内容） */
  noteSeen(groupId, name = '') {
    if (!validGroupId(groupId)) return
    const id = String(groupId)
    const isNew = !this.groups.has(id)
    if (isNew && this.groups.size >= SEEN_MAX) {
      const oldest = [...this.groups.entries()].filter(([, r]) => !r.admitted).sort((a, b) => (a[1].lastSeenAt ?? 0) - (b[1].lastSeenAt ?? 0))[0]
      if (oldest) this.groups.delete(oldest[0])
    }
    const rec = this.#record(id)
    rec.lastSeenAt = this.now()
    rec.seenCount = (rec.seenCount ?? 0) + 1
    if (name && typeof name === 'string') rec.name = name.slice(0, 60)
    this.#touch()
    if (isNew) this.#emit(id)
  }

  /** 记一次主动插话的结果：'engaged' | 'rejected' | 'silence' */
  recordInterject(groupId, result, at = this.now()) {
    if (!validGroupId(groupId) || !['engaged', 'rejected', 'silence'].includes(result)) return
    const rec = this.#record(groupId)
    const list = Array.isArray(rec.interjects) ? rec.interjects : []
    list.push({ result, at })
    rec.interjects = list.slice(-INTERJECT_HISTORY_MAX)
    this.#touch()
  }

  /** 插话被接住率：最近 N 次里有多少次被接住 */
  interjectStats(groupId) {
    const list = this.groups.get(String(groupId))?.interjects ?? []
    const count = (kind) => list.filter((item) => item.result === kind).length
    return { total: list.length, engaged: count('engaged'), rejected: count('rejected'), silence: count('silence') }
  }

  /** 后台任务的进度（群成员整理、群概况跑到哪了）。patch 里的 null 表示删掉那一项 */
  patchState(groupId, patch) {
    if (!validGroupId(groupId)) return null
    const rec = this.#record(groupId)
    const next = { ...(rec.state ?? {}) }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = value
    }
    rec.state = next
    this.#touch()
    return JSON.parse(JSON.stringify(next))
  }

  stateOf(groupId) {
    return JSON.parse(JSON.stringify(this.groups.get(String(groupId))?.state ?? {}))
  }

  get(groupId) {
    const rec = this.groups.get(String(groupId))
    return rec ? JSON.parse(JSON.stringify(rec)) : null
  }

  /** 全部见过的群，最近见到的在前 */
  list() {
    return [...this.groups.entries()]
      .map(([groupId, rec]) => ({ groupId, ...JSON.parse(JSON.stringify(rec)) }))
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }

  /** 忘掉这个群的运行时记录（接入状态和设置一并清掉） */
  forget(groupId) {
    const had = this.groups.delete(String(groupId))
    if (had) {
      this.#touch()
      this.#emit(String(groupId))
    }
    return had
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.#save()
  }

  dispose() {
    this.flush()
    this.listeners.clear()
  }
}

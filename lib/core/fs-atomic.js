/**
 * 落盘的两件基本功：原子写 + 坏文件留档。
 *
 * 原子写：先写到同目录的临时文件、fsync、再 rename 覆盖正式文件。rename 在同一分区上
 * 是原子的，进程在任何一步被杀，正式文件要么是旧的完整版本、要么是新的完整版本。
 *
 * ⚠️ 临时文件名**必须带 pid + 随机串**。同一台机器上可能同时跑着两个宿主进程、
 * 共用同一个 `DSH_HOME`（桌面端 + CLI/QQ 宿主），固定叫 `${file}.tmp` 时一个进程会把
 * 另一个进程**写到一半**的临时文件 rename 成正式文件。同进程里两次写盘交错
 * （定时器 + 控制台请求）也一样，所以光带 pid 不够，还要随机串。
 *
 * ⚠️ 不 fsync 就 rename，断电后可能留下"文件名是新的、内容是空的"——NTFS / ext4
 * 都只保证元数据顺序，不保证数据先落盘。
 *
 * 坏文件留档：解析失败 / 结构不对时，**不能**按空的开始然后在下一次写盘时把它覆盖掉
 * ——那是用户数据，盖掉就回不来了。改名成 `${file}.corrupt-<时间戳>` 留着，再按空的开始。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Windows 上目标文件正被别的进程（杀毒 / 索引 / 另一个宿主）打开时 rename 会短暂 EPERM。 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 4

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 拿不到 SharedArrayBuffer 就不等，直接重试 */
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(error?.code)) throw error
      sleepSync(20 * attempt)
    }
  }
}

/** 临时文件名：`${file}.${pid}.${随机}.tmp`。导出给测试用。 */
export function tempNameFor(file) {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * 原子写一个文件。父目录不存在会建。失败时清掉临时文件再把错误抛出去
 * （要不要吞由调用方决定，各个 store 的 warn 文案不一样）。
 *
 * `backup`：给了就在发布新文件之前把旧的正式文件 rename 成它（memory.json → memory.json.bak 那种轮换）。
 * 两次 rename 之间崩溃时正式文件暂时不存在，读的一方要回落到 backup。
 *
 * @param {string} file
 * @param {string|Buffer|Uint8Array} data
 * @param {{backup?: string}} [opts]
 */
export function writeFileAtomic(file, data, { backup = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tempNameFor(file)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, data, typeof data === 'string' ? 'utf8' : undefined)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    if (backup && fs.existsSync(file)) renameWithRetry(file, backup)
    renameWithRetry(tmp, file)
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 已经在出错路径上 */
      }
    }
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件删不掉只是留一点垃圾 */
    }
    throw error
  }
}

/**
 * 原子写 JSON。
 *
 * @param {string} file
 * @param {any} value
 * @param {{space?: number|string, backup?: string}} [opts] 缩进默认 2，传 0 写成一行（大文件省空间）；backup 见 writeFileAtomic
 */
export function writeJsonAtomic(file, value, { space = 2, backup = null } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, space || undefined), { backup })
}

/**
 * 把坏文件改名留档：`${file}.corrupt-<ISO 时间戳>`（冒号换成短横，Windows 文件名不能带冒号）。
 * 同一毫秒里留档两次会撞名，撞了就加序号。挪不动返回 null。
 *
 * @returns {string|null} 留档后的路径
 */
export function quarantineFile(file, { log = null, reason = '' } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let kept = `${file}.corrupt-${stamp}`
  for (let n = 1; fs.existsSync(kept); n++) kept = `${file}.corrupt-${stamp}-${n}`
  try {
    renameWithRetry(file, kept)
    log?.warn?.(`[fs] ${path.basename(file)} ${reason || '读不懂'}，已留档为 ${path.basename(kept)}，按空的开始`)
    return kept
  } catch (error) {
    log?.warn?.(`[fs] ${path.basename(file)} ${reason || '读不懂'}，留档也失败（${error?.message ?? error}），下一次写盘会覆盖它`)
    return null
  }
}

/**
 * 读一个 JSON 文件，带上读到的状态，给需要区分"不存在"和"坏了"的调用方用。
 *
 * - `missing`：文件不存在 → fallback
 * - `ok`：解析成功且 validate 通过 → 解析结果
 * - `quarantined`：解析失败 / validate 不通过 → 已改名留档（`kept`），返回 fallback
 * - `corrupt`：同上但 `quarantine: false`，文件原地没动
 * - `unreadable`：文件在但读不出来（EACCES / EBUSY）→ fallback，**不**留档：文件本身可能是好的
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {object} [opts.log]
 * @param {any|(() => any)} [opts.fallback] 函数时每次调用拿新对象，免得多个 store 共用一个默认值
 * @param {(parsed: any) => boolean} [opts.validate]
 * @param {boolean} [opts.quarantine] 默认 true；false 时坏文件原地不动（调用方自己决定怎么留档）
 * @returns {{status: 'missing'|'ok'|'quarantined'|'corrupt'|'unreadable', value: any, kept?: string|null, error?: Error}}
 */
export function readJsonFile(file, { log = null, fallback = null, validate = null, quarantine = true } = {}) {
  const fresh = () => (typeof fallback === 'function' ? fallback() : fallback)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', value: fresh() }
    log?.warn?.(`[fs] ${path.basename(file)} 读不出来（${error?.message ?? error}），这次按空的开始`)
    return { status: 'unreadable', value: fresh(), error }
  }
  let parsed
  let reason = ''
  let failure = null
  try {
    parsed = JSON.parse(text)
    if (validate && !validate(parsed)) reason = '结构不对'
  } catch (error) {
    failure = error
    reason = `解析失败（${error?.message ?? error}）`
  }
  if (!reason) return { status: 'ok', value: parsed }
  const error = failure ?? new Error(reason)
  if (!quarantine) return { status: 'corrupt', value: fresh(), error }
  return { status: 'quarantined', value: fresh(), kept: quarantineFile(file, { log, reason }), error }
}

/**
 * 读 JSON，坏了就留档。只要值的简化版本。
 *
 * @returns {any} 解析结果或 fallback
 */
export function loadJsonOrQuarantine(file, opts = {}) {
  return readJsonFile(file, opts).value
}

/** validate 常用：是一个普通对象（不是数组 / null）。 */
export const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * 单实例锁：同一份数据目录同一时间只让一个进程写（PLAN 第 4 条）。
 *
 * 桌面端和命令行 profile 可能各自加载这个插件，两个进程都往同一个 memory.json 写，后写的会盖掉先写的。
 * 这里不做合并（两边的记忆 id 会撞），而是让后来的进程退成**只读**：照常能读、能在内存里改，但不落盘，并告诉用户。
 *
 * 做法：独占创建锁文件 { pid, at }；持有者每 20 秒刷新一次修改时间。别人发现锁文件时：
 *   - 持有者 pid 是自己（同一进程重新加载插件）→ 接手；
 *   - 持有者进程已经不在了，或锁文件超过 90 秒没刷新 → 接手；
 *   - 否则拿不到，退成只读。
 */
import fs from 'node:fs'
import path from 'node:path'

const HEARTBEAT_MS = 20_000
const STALE_MS = 90_000

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * @param {string} file 锁文件路径
 * @returns {{ held: boolean, holderPid: number|null, release: () => void }}
 */
export function acquireInstanceLock(file, { pid = process.pid, now = () => Date.now(), isAlive = processAlive, staleMs = STALE_MS, heartbeatMs = HEARTBEAT_MS, log = null } = {}) {
  const body = () => JSON.stringify({ pid, at: now() })
  const tryCreate = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body(), { flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      log?.warn?.(`[lock] 建锁文件失败，按拿不到处理：${error?.message ?? error}`)
      return null
    }
  }
  const readHolder = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const stat = fs.statSync(file)
      return { pid: Number(parsed?.pid) || 0, age: now() - stat.mtimeMs }
    } catch {
      return { pid: 0, age: Infinity }
    }
  }

  let created = tryCreate()
  let holderPid = null
  if (created === false) {
    const holder = readHolder()
    holderPid = holder.pid || null
    if (holder.pid === pid || !isAlive(holder.pid) || holder.age > staleMs) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* 别人刚好删了 */
      }
      created = tryCreate()
      if (created) holderPid = null
    }
  }
  const held = created === true
  let timer = null
  if (held && heartbeatMs > 0) {
    timer = setInterval(() => {
      try {
        const t = new Date()
        fs.utimesSync(file, t, t)
      } catch {
        /* 锁文件被删了就不刷新了 */
      }
    }, heartbeatMs)
    timer.unref?.()
  }
  return {
    held,
    holderPid,
    release() {
      if (timer) clearInterval(timer)
      timer = null
      if (!held) return
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Number(current?.pid) === pid) fs.rmSync(file, { force: true })
      } catch {
        /* 已经没了 */
      }
    },
  }
}

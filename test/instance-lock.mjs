/**
 * 单实例锁（lib/core/instance-lock.js）和记忆库的只读降级。运行：node test/instance-lock.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireInstanceLock } from '../lib/core/instance-lock.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-lock-'))
const noBeat = { heartbeatMs: 0 }

console.log('A. 锁')
{
  const file = path.join(tmp, 'a', 'x.lock')
  const first = acquireInstanceLock(file, { pid: 1001, isAlive: () => true, ...noBeat })
  check('第一个拿到', first.held && first.holderPid === null && fs.existsSync(file))
  const second = acquireInstanceLock(file, { pid: 1002, isAlive: () => true, ...noBeat })
  check('持有者还活着：第二个拿不到，知道是谁占着', !second.held && second.holderPid === 1001)
  second.release()
  check('没拿到的释放不会删别人的锁', fs.existsSync(file))
  const same = acquireInstanceLock(file, { pid: 1001, isAlive: () => true, ...noBeat })
  check('同一个进程重新加载插件：接手', same.held)
  const dead = acquireInstanceLock(file, { pid: 1003, isAlive: (pid) => pid !== 1001, ...noBeat })
  check('持有者进程已经不在：接手', dead.held)
  first.release()
  check('旧持有者的 release 不会删掉新持有者的锁', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).pid === 1003)
  dead.release()
  check('持有者 release 之后锁文件没了', !fs.existsSync(file))

  const stale = path.join(tmp, 'stale.lock')
  fs.writeFileSync(stale, JSON.stringify({ pid: 9999, at: 1 }))
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(stale, old, old)
  const taken = acquireInstanceLock(stale, { pid: 1004, isAlive: () => true, ...noBeat })
  check('锁文件超过 90 秒没刷新：哪怕进程“还活着”也接手（可能是 pid 被复用）', taken.held)
  taken.release()

  const broken = path.join(tmp, 'broken.lock')
  fs.writeFileSync(broken, '不是 JSON')
  const fromBroken = acquireInstanceLock(broken, { pid: 1005, isAlive: () => true, ...noBeat })
  check('锁文件内容坏了：当作没人占', fromBroken.held)
  fromBroken.release()

  const beat = path.join(tmp, 'beat.lock')
  const beating = acquireInstanceLock(beat, { pid: 1006, heartbeatMs: 30, isAlive: () => true })
  const before = fs.statSync(beat).mtimeMs
  await new Promise((r) => setTimeout(r, 120))
  check('持有者定时刷新修改时间', fs.statSync(beat).mtimeMs > before)
  beating.release()
  check('process.kill(pid, 0) 判断存活：自己的 pid 活着，不存在的 pid 死了', acquireInstanceLock(path.join(tmp, 'live.lock'), { ...noBeat }).held)
}

console.log('B. 记忆库')
{
  const dir = path.join(tmp, 'memory')
  const a = createMemory({ dir, lock: { pid: 2001, isAlive: () => true, heartbeatMs: 0 } })
  check('第一个进程：可写', !a.readOnly)
  a.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短的回答', actor: 'console', origin: 'user', confidence: 1 })
  a.flush()
  const b = createMemory({ dir, lock: { pid: 2002, isAlive: () => true, heartbeatMs: 0 } })
  check('第二个进程：只读，知道谁占着', b.readOnly && b.lock.holderPid === 2001)
  check('只读也能读到已有的记忆', b.list({ scope: 'owner' }).length === 1)
  b.observe({ scope: 'owner', kind: 'trait', text: '这条改动不该落盘', actor: 'console', origin: 'user', confidence: 1 })
  b.flush()
  b.dispose()
  const reread = createMemory({ dir })
  check('只读进程的改动没有落盘（没有盖掉先写的）', reread.list({ scope: 'owner' }).length === 1 && !reread.list({ scope: 'owner' }).some((e) => e.text.includes('不该落盘')))
  reread.dispose()
  a.observe({ scope: 'owner', kind: 'trait', text: '第一个进程之后写的', actor: 'console', origin: 'user', confidence: 1 })
  a.dispose()
  const after = createMemory({ dir })
  check('持有者的改动照常落盘', after.list({ scope: 'owner' }).length === 2)
  after.dispose()
  const c = createMemory({ dir, lock: { pid: 2003, isAlive: () => true, heartbeatMs: 0 } })
  check('持有者 dispose 之后，别的进程能拿到锁', !c.readOnly)
  c.dispose()
  check('不开锁（默认）：和以前一样，没有锁文件', !createMemory({ dir: path.join(tmp, 'nolock') }).lock)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

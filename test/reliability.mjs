/**
 * 可靠性小项的回归：日志轮转、SQLite 打不开时退回 json、群成员任务的失败退避。
 * 纯本地临时目录，不碰真实 ~/.dsh、不调用真实模型。运行：node test/reliability.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendLogLine, LOG_MAX_BYTES } from '../lib/core/log.js'
import { createMemory } from '../lib/memory/index.js'
import { setSqliteLoader } from '../lib/memory/sqlite-store.js'
import { GroupMemoryJobs } from '../lib/conversation/members.js'
import { resolveConfig } from '../lib/qq/config.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-reliable-'))
const warns = []
const log = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(String(m)) }

console.log('A. 日志轮转')
{
  const file = path.join(tmp, 'logs', 'plugin.log')
  appendLogLine(file, 'x'.repeat(120), { maxBytes: 300 })
  appendLogLine(file, 'y'.repeat(120), { maxBytes: 300 })
  check('还没到上限：不轮转', !fs.existsSync(`${file}.1`) && fs.statSync(file).size > 200)
  appendLogLine(file, 'z'.repeat(120), { maxBytes: 300 })
  check('超过上限：旧内容挪成 .1', fs.existsSync(`${file}.1`))
  const rotated = fs.readFileSync(`${file}.1`, 'utf8')
  check('.1 里是旧内容', rotated.includes('xxx') && rotated.includes('yyy'))
  check('新文件只留最新一行', fs.readFileSync(file, 'utf8').trim().startsWith('zzz'))
  check('轮转后再写不会继续撑大 .1', (appendLogLine(file, 'w'), fs.readFileSync(`${file}.1`, 'utf8').includes('xxx')))
  check('默认上限是 2 MB', LOG_MAX_BYTES === 2 * 1024 * 1024)

  const deep = path.join(tmp, 'a', 'b', 'c', 'x.log')
  appendLogLine(deep, 'hello')
  check('目录不存在会自动建', fs.existsSync(deep))
}

console.log('B. SQLite 不可用时退回 json')
{
  setSqliteLoader(() => null)
  const dir = path.join(tmp, 'mem-sqlite')
  const memory = createMemory({ dir, store: 'sqlite', log })
  check('不抛错、改用 json', memory.storeKind === 'json' && memory.db === null)
  check('日志里说明了原因', warns.some((w) => w.includes('SQLite 打不开')))
  const out = memory.observe({ scope: 'owner', kind: 'fact', text: '退回 json 也能写', actor: 'test' })
  check('退回后照样能写记忆', out.action === 'new' || out.action === 'dup', out.action)
  memory.dispose()

  setSqliteLoader(null) // 恢复真实加载器
  const real = createMemory({ dir: path.join(tmp, 'mem-real'), store: 'sqlite', log })
  check('本机 Node 有 node:sqlite：用 sqlite', real.storeKind === 'sqlite' && real.db !== null)
  real.dispose()
}

console.log('C. dispose 之后拒绝写入')
{
  const memory = createMemory({ dir: path.join(tmp, 'mem-dispose'), log })
  memory.dispose()
  check('dispose 后 readOnly', memory.readOnly === true)
  const before = memory.list({}).length
  memory.observe({ scope: 'owner', kind: 'fact', text: '卸载之后不该写进去', actor: 'test' })
  check('卸载后的写入被拒', memory.list({}).length === before)
}

console.log('D. 群成员任务：失败退避')
{
  const clock = { now: 1_800_000_000_000 }
  const MIN = 60_000
  const groupState = {}
  let modelCalls = 0
  let modelFails = true
  const jobs = new GroupMemoryJobs({
    corpus: {
      listChats: () => [{ chatType: 'group', chatId: '123' }],
      // 至少 minMessages 条同一人的发言，pickMembers 才会挑出人、真的调模型
      search: () => [1, 2, 3].map((n) => ({
        kind: 'message', ts: clock.now - n * 1000, senderId: '10001', senderName: '小明', text: `第 ${n} 句`,
      })),
    },
    memory: { observe: () => ({ action: 'new' }), flush() {} },
    groupSettings: {
      stateOf: (id) => groupState[id] ?? {},
      patchState: (id, patch) => {
        groupState[id] = { ...(groupState[id] ?? {}), ...patch }
      },
    },
    model: {
      run: async () => {
        modelCalls += 1
        if (modelFails) throw new Error('模型炸了')
        return JSON.stringify({ members: [] })
      },
    },
    qqConfig: () => resolveConfig({ scope: { groups: ['123'] } }),
    settingsFor: () => ({
      members: { enabled: true, everyHours: 6, minMessages: 3, maxPerRun: 20, days: 3 },
      coldStart: { enabled: false, days: 7, minMessages: 200 },
    }),
    owner: null,
    log,
    now: () => clock.now,
  })

  check('一开始就到期', jobs.due().length === 1 && jobs.due()[0].job === 'members')
  const bad = await jobs.runMembers('123')
  check('模型失败：返回失败', bad.ok === false && bad.reason === 'model-failed')
  check('失败后立刻不再到期（退避中）', jobs.due().length === 0)
  clock.now += 4 * MIN
  check('4 分钟时仍在退避', jobs.due().length === 0)
  clock.now += 2 * MIN
  check('6 分钟后允许重试', jobs.due().length === 1)

  // 第二次失败：退避翻倍到 10 分钟
  await jobs.runMembers('123')
  clock.now += 6 * MIN
  check('第二次失败后，6 分钟还不够（10 分钟才重试）', jobs.due().length === 0)
  clock.now += 5 * MIN
  check('11 分钟后到期', jobs.due().length === 1)

  modelFails = false
  const good = await jobs.runMembers('123')
  check('成功一次', good.ok === true)
  check('成功后清零：按正常的 everyHours 排期', jobs.backoff.size === 0)
  check('失败时每次只花一次模型调用', modelCalls === 3, String(modelCalls))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

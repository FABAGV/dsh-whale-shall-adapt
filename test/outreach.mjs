/**
 * 主动私聊主人（lib/outreach/）：配置、纯逻辑、闸门、预览零副作用、不补发、反馈。
 * 假时钟、假投递，真的记忆层（临时目录）。运行：node test/outreach.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveOutreachConfig, OUTREACH_DEFAULTS } from '../lib/outreach/config.js'
import { classifyReply, pickTopic, buildOutreachPrompt, dayKey, randomGap, topicText } from '../lib/outreach/logic.js'
import { createOutreach } from '../lib/outreach/index.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = { info() {}, warn() {}, debug() {}, error() {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-outreach-'))
const HOUR = 3600 * 1000
const MIN = 60 * 1000

console.log('A. 配置')
{
  const c = resolveOutreachConfig({})
  check('默认关', c.enabled === false)
  check('防刷屏默认值照 SurfCore', c.quietHours.start === '23:30' && c.quietHours.end === '08:30' && c.maxPerDay === 4 && c.minGapMs === 2.5 * HOUR && c.maxGapMs === 5 * HOUR && c.ownerQuietMs === 30 * MIN)
  check('默认值是冻结的', Object.isFrozen(OUTREACH_DEFAULTS) && Object.isFrozen(OUTREACH_DEFAULTS.quietHours))
  const bad = resolveOutreachConfig({ maxPerDay: 99, minGapMs: 1000, quietHours: { start: '25:00' }, enabled: 'yes' })
  check('非法值回退并警告', bad.maxPerDay === 4 && bad.minGapMs === 2.5 * HOUR && bad.quietHours.start === '23:30' && bad.warnings.length >= 3)
  check('enabled 只认布尔 true', bad.enabled === false && resolveOutreachConfig({ enabled: true }).enabled === true)
  const inverted = resolveOutreachConfig({ minGapMs: 6 * HOUR, maxGapMs: 3 * HOUR })
  check('上限小于下限：上限提到下限', inverted.maxGapMs === inverted.minGapMs)
  const over = resolveOutreachConfig({ enabled: false }, { enabled: true, maxPerDay: 2 })
  check('控制台覆盖优先于配置文件', over.enabled === true && over.maxPerDay === 2)
}

console.log('B. 纯逻辑')
{
  check('“不想”是负面（先判否定）', classifyReply('不想') === 'negative' && classifyReply('不用了，没空') === 'negative' && classifyReply('算了吧') === 'negative')
  check('正面', classifyReply('好的，一起') === 'positive' && classifyReply('哈哈可以') === 'positive' && classifyReply('嗯') === 'positive')
  check('中性', classifyReply('今天天气不错') === 'neutral' && classifyReply('') === 'neutral')
  check('话题文本去掉“待续：”', topicText({ text: '待续：问集合时间' }) === '问集合时间' && topicText({ text: '周五交报告' }) === '周五交报告')
  const now = 1_800_000_000_000
  const entries = [
    { id: 'a', kind: 'intent', text: '待续：问集合时间', importance: 1, confidence: 0.5 },
    { id: 'b', kind: 'promise', text: '周五之前发报告给张老师', importance: 2, confidence: 0.8 },
    { id: 'c', kind: 'fact', text: '主人住在上海', importance: 5, confidence: 1 },
  ]
  const state = { recent: [], declined: {} }
  const seen = new Set()
  for (let i = 0; i < 40; i += 1) seen.add(pickTopic(entries, state, { now, cooldownDays: 3, rand: () => (i + 0.5) / 40 })?.id)
  check('只从 intent / promise 里挑，不挑 fact', seen.has('a') && seen.has('b') && !seen.has('c'))
  check('重要的权重大', pickTopic(entries, state, { now, cooldownDays: 3, rand: () => 0.99 }).id === 'b')
  check('最近提过的 3 天内不再提', pickTopic(entries, { recent: [{ id: 'a', text: '问集合时间', at: now - HOUR }, { id: 'b', text: 'x', at: now - HOUR }], declined: {} }, { now, cooldownDays: 3, rand: () => 0.1 }) === null)
  check('过了冷却又能提', pickTopic(entries, { recent: [{ id: 'a', text: '问集合时间', at: now - 4 * 24 * HOUR }], declined: {} }, { now, cooldownDays: 3, rand: () => 0.1 }) !== null)
  check('文字几乎一样的也算提过（换了 id 也挡）', pickTopic([entries[0]], { recent: [{ id: 'zzz', text: '问集合时间', at: now - HOUR }], declined: {} }, { now, cooldownDays: 3, rand: () => 0.1 }) === null)
  check('被拒绝的话题期间内不挑', pickTopic([entries[0]], { recent: [], declined: { a: now + HOUR } }, { now, cooldownDays: 3, rand: () => 0.1 }) === null)
  check('没有候选返回 null', pickTopic([], state, { now, cooldownDays: 3, rand: () => 0.1 }) === null)
  const prompt = buildOutreachPrompt({ text: '问集合时间' }, { now: new Date(2026, 9, 30, 15, 7).getTime() })
  check('提示说明是它自己想联系、给出话题和当前时间、允许 <refuse/>', prompt.includes('15:07') && prompt.includes('问集合时间') && prompt.includes('<refuse/>') && prompt.includes('不是主人找你'))
  check('间隔在上下限之间', [0, 0.5, 0.999].every((r) => { const g = randomGap(OUTREACH_DEFAULTS, () => r); return g >= 2.5 * HOUR && g <= 5 * HOUR }))
  check('日期键按本地日期', dayKey(new Date(2026, 9, 30, 23, 59).getTime()) === '2026-10-30' && dayKey(new Date(2026, 9, 31, 0, 1).getTime()) === '2026-10-31')
}

console.log('C. 闸门、预览、发送')
{
  const dir = tmp()
  const clock = { t: new Date(2026, 9, 30, 14, 0).getTime() }
  const now = () => clock.t
  const memory = createMemory({ dir: path.join(dir, 'memory'), now })
  const ownerBox = { qq: '42' }
  const owner = { owner: () => ownerBox.qq }
  let connected = true
  let busy = { busy: false }
  const delivered = []
  let deliverError = null
  const make = (config = {}, rand = () => 0.5) => createOutreach({
    dir, config, memory, owner, log, now, rand,
    isConnected: () => connected,
    isBusy: async () => busy,
    deliver: async (input) => { if (deliverError) throw deliverError; delivered.push(input) },
  })
  let o = make()
  const gateOf = async (name) => (await o.evaluate()).gates.find((g) => g.name === name)

  check('默认关：tick 什么都不做', (await o.tick()).skipped === 'off' && delivered.length === 0)
  o.setOverrides({ enabled: true })
  check('刚打开不会马上发：下次时间在 2.5–5 小时之后', o.state.nextAt - clock.t >= 2.5 * HOUR && o.state.nextAt - clock.t <= 5 * HOUR)
  memory.observe({ scope: 'owner:chat', kind: 'intent', text: '待续：问问周末爬山的集合时间', actor: 'qq:memo', origin: 'model', importanceDelta: 1 })
  const before = JSON.stringify(o.state)
  const preview = await o.preview()
  check('预览逐条列出闸门，没到点所以不通过', preview.gates.length === 9 && !preview.ok && !(await gateOf('schedule')).ok)
  check('预览里能看到会想聊什么、会发什么提示', preview.topic?.text === '问问周末爬山的集合时间' && preview.prompt.includes('问问周末爬山的集合时间'))
  check('预览零副作用：状态不变、没投递', JSON.stringify(o.state) === before && delivered.length === 0)

  clock.t = o.state.nextAt + 1000
  clock.t = new Date(2026, 9, 30, 23, 45).getTime()
  o.state.nextAt = clock.t - 1000
  check('闸门：安静时段 23:45 不发', !(await gateOf('quiet-hours')).ok && (await o.tick()).skipped === 'quiet-hours')
  clock.t = new Date(2026, 9, 31, 7, 0).getTime()
  check('闸门：安静时段 07:00 不发（跨午夜）', !(await gateOf('quiet-hours')).ok)
  clock.t = new Date(2026, 9, 31, 10, 0).getTime()
  o.state.nextAt = clock.t - 1000

  ownerBox.qq = null
  check('闸门：没配对主人不发', !(await gateOf('owner')).ok && (await o.tick()).skipped === 'owner')
  ownerBox.qq = '42'
  connected = false
  check('闸门：没有连接不发', (await o.tick()).skipped === 'connection')
  connected = true
  o.noteOwnerMessage('在吗', clock.t - 10 * MIN)
  check('闸门：主人 10 分钟前说过话不发', (await o.tick()).skipped === 'owner-active')
  o.ownerLastMsgAt = clock.t - 40 * MIN
  check('主人 40 分钟前说的：不拦', (await gateOf('owner-active')).ok)
  busy = { busy: true, reason: '有工具在跑' }
  check('闸门：常驻会话忙不发', (await o.tick()).skipped === 'busy' && delivered.length === 0)
  busy = { busy: false }

  const r = await o.tick()
  check('全部通过：发了一次，投递给主人，提示里有话题', r.sent === true && delivered.length === 1 && delivered[0].ownerQq === '42' && delivered[0].text.includes('问问周末爬山的集合时间'))
  check('今天的次数在投递时就扣', o.snapshot().sentToday === 1)
  check('下次时间重新排在 2.5–5 小时之后', o.state.nextAt - clock.t >= 2.5 * HOUR && o.state.nextAt - clock.t <= 5 * HOUR)
  check('记着在等主人回应', o.snapshot().awaitingReply === true && o.snapshot().recent[0].text === '问问周末爬山的集合时间')
  check('紧接着再 tick：没到时间不发', (await o.tick()).skipped === 'schedule' && delivered.length === 1)
  o.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'outreach.json'), 'utf8'))
  check('进度落盘（下次时间、次数、开关）', saved.state.nextAt === o.state.nextAt && saved.state.sentToday === 1 && saved.overrides.enabled === true)

  // 重启不补发
  clock.t += 10 * HOUR
  clock.t = new Date(2026, 9, 31, 20, 0).getTime()
  const restarted = make({}, () => 0)
  check('重启：下次时间已过，重新排，至少再等一半间隔', restarted.state.nextAt - clock.t >= 1.25 * HOUR)
  check('重启后第一次 tick 不会补发', (await restarted.tick()).skipped === 'schedule' && delivered.length === 1)
  restarted.state.inFlight = { at: clock.t, topicId: 'x' }
  restarted.flush()
  const again = make()
  check('上次发到一半进程没了：记为 interrupted，不补发', again.snapshot().interrupted === 1 && again.state.inFlight === null)
  again.dispose(); restarted.dispose()

  // 每天上限与跨天清零
  o = make({ maxPerDay: 1 })
  o.setOverrides({ enabled: true })
  o.state.day = dayKey(clock.t)
  o.state.sentToday = 1
  o.state.nextAt = clock.t - 1000
  check('闸门：每日上限', (await o.tick()).skipped === 'daily-cap')
  clock.t += 24 * HOUR
  o.state.nextAt = clock.t - 1000
  check('第二天次数清零', o.snapshot().sentToday === 0 && (await o.evaluate()).gates.find((g) => g.name === 'daily-cap').ok)

  // 没有话题：隔一阵再看
  memory.purge({ scope: 'owner:chat' }, 'console')
  o.state.recent = []
  o.state.nextAt = clock.t - 1000
  const none = await o.tick()
  check('记忆里没有值得跟进的事：不发，也不去凑数', none.skipped === 'topic' && delivered.length === 1)
  check('没话题时隔 1 小时再看', o.state.nextAt - clock.t === OUTREACH_DEFAULTS.idleRecheckMs)

  // 投递失败
  memory.observe({ scope: 'owner:chat', kind: 'promise', text: '答应周日发菜谱', actor: 'qq:memo', origin: 'model' })
  o.state.nextAt = clock.t - 1000
  deliverError = new Error('会话建不起来')
  const failed = await o.tick()
  check('投递失败：记错误，但次数已经扣了（模型回合要花钱），不会连环重试', failed.sent === false && o.snapshot().failures === 1 && o.snapshot().sentToday === 1 && o.state.inFlight === null)
  deliverError = null
  o.dispose()
  memory.dispose()
}

console.log('D. 主人的回复当反馈')
{
  const dir = tmp()
  const clock = { t: new Date(2026, 9, 30, 14, 0).getTime() }
  const now = () => clock.t
  const memory = createMemory({ dir: path.join(dir, 'memory'), now })
  const delivered = []
  const o = createOutreach({
    dir, config: { enabled: true, minGapMs: 10 * MIN, maxGapMs: 10 * MIN, maxPerDay: 24, ownerQuietMs: 0 }, memory, owner: { owner: () => '42' }, log, now, rand: () => 0.5,
    isConnected: () => true, isBusy: async () => ({ busy: false }), deliver: async (i) => { delivered.push(i) },
  })
  const add = (text, kind = 'intent') => memory.observe({ scope: 'owner:chat', kind, text, actor: 'qq:memo', origin: 'model', importanceDelta: 1 })
  const topicEntry = add('待续：问周末爬山的事')
  o.state.nextAt = 0
  await o.tick()
  check('第一次联系', delivered.length === 1)
  check('负面回复：这件事被划掉（变成历史），7 天内不再提', o.noteOwnerMessage('不用了，没空', clock.t + 5 * MIN) === 'negative' && memory.get(topicEntry.id).status === 'historical' && o.state.declined[topicEntry.id] > clock.t + 6 * 24 * HOUR)

  const second = add('答应周日发菜谱', 'promise')
  clock.t += 20 * MIN
  o.state.nextAt = 0
  await o.tick()
  const importanceBefore = memory.get(second.id).importance
  check('正面回复：这件事的重要度 +1', o.noteOwnerMessage('好的，周日见', clock.t + MIN) === 'positive' && memory.get(second.id).importance === importanceBefore + 1, `${importanceBefore} → ${memory.get(second.id).importance}`)
  check('回应过了就不再记“没回应”', o.state.pending === null && Object.keys(o.state.unanswered).length === 0)

  const third = add('待续：问装修的进度')
  clock.t += 20 * MIN
  o.state.nextAt = 0
  o.state.recent = []
  memory.complete([second.id], { actor: 'console' })
  await o.tick()
  check('超过 6 小时才回的话，不算对这次的回应', o.noteOwnerMessage('好的', clock.t + 7 * HOUR) === null && o.state.pending !== null)
  clock.t += 20 * MIN
  o.state.nextAt = 0
  o.state.recent = []
  await o.tick()
  check('第一次联系没回应：记一次', o.state.unanswered[third.id] === 1)
  clock.t += 20 * MIN
  o.state.nextAt = 0
  o.state.recent = []
  await o.tick()
  check('连续两次没回应：划掉这件事', memory.get(third.id).status === 'historical')

  const neutralTopic = add('待续：问新书的事')
  clock.t += 20 * MIN
  o.state.nextAt = 0
  o.state.recent = []
  await o.tick()
  check('中性回复：不改记忆，只清掉“在等回应”', o.noteOwnerMessage('今天挺忙的', clock.t + MIN) === 'neutral' && memory.get(neutralTopic.id).status === 'active' && o.state.pending === null)
  check('没有在等回应时，主人说话不会误改任何东西', o.noteOwnerMessage('不用了', clock.t + 2 * MIN) === null)
  o.dispose()
  memory.dispose()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

/**
 * 控制台里 QQ 侧的接口（lib/ui/console-routes-qq.js）：群聊、主动私聊、梗百科联网、统一记忆页、信号。
 * 直接调 createConsoleApi 的路由表，不起 HTTP 服务。运行：node test/console-qq-api.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConsoleApi } from '../lib/ui/console-api.js'
import { createQqStatus } from '../lib/index.js'
import { createMemory } from '../lib/memory/index.js'
import { createGroupSettings } from '../lib/group/settings.js'
import { resolveGroupConfig } from '../lib/group/config.js'
import { GroupEngine } from '../lib/group/engine.js'
import { resolveConfig } from '../lib/qq/config.js'
import { createOutreach } from '../lib/outreach/index.js'
import { createMemeBase } from '../lib/meme/index.js'
import { MemeOnline } from '../lib/meme/sync.js'
import { MemeArchive } from '../lib/meme/archive.js'
import { createSignals } from '../lib/core/signals.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-console-qq-'))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const call = (api, method, url, body) => {
  const [p, q] = url.split('?')
  return api.handle({ method, path: p, query: new URLSearchParams(q ?? ''), body, signal: undefined })
}

const dir = tmp()
const memory = createMemory({ dir: path.join(dir, 'memory') })
const groupSettings = createGroupSettings({ dir })
const qqConfig = resolveConfig({ scope: { groups: ['555'], friends: [], blockedGroups: ['777'] } })
const engine = new GroupEngine({ config: qqConfig.group, settings: groupSettings, memory, log })
const purged = []
const corpus = { purgeMember: (...args) => { purged.push(args); return 7 } }
const judge = Object.assign(async () => ({}), { status: () => ({ using: 'configured', provider: 'deepseek-account', model: 'deepseek-flash', note: '' }) })
const qqStatus = createQqStatus()
const signals = createSignals()
const meme = createMemeBase({ dbPath: path.join(dir, 'meme', 'memes.db'), memory, settingsFile: path.join(dir, 'meme', 'settings.json'), log })

const bare = createConsoleApi({ jobs: { list: () => [] }, config: {}, memory, meme, owner: { owner: () => '42', isOwner: () => false }, qqStatus, signals, log })

console.log('A. QQ 通道没起来时')
{
  for (const [method, url] of [['GET', '/group'], ['GET', '/outreach'], ['POST', '/outreach/preview']]) {
    const r = await call(bare, method, url)
    check(`${method} ${url}：503 并说明原因`, r.status === 503 && r.json.ok === false && r.json.error.length > 0)
  }
  check('信号接口没有服务也能答', (await call(bare, 'GET', '/signals')).json.recent.length === 0)
}

qqStatus.provide('group', { engine, settings: groupSettings, judge, corpus, qqConfig })
const outreach = createOutreach({
  dir, config: {}, memory, owner: { owner: () => '42' }, log, rand: () => 0.5,
  isConnected: () => true, isBusy: async () => ({ busy: false }), deliver: async () => {},
})
qqStatus.provide('outreach', outreach)

console.log('B. 群聊页')
{
  groupSettings.noteSeen('888', '陌生群')
  groupSettings.noteSeen('888')
  groupSettings.noteSeen('777')
  engine.onInbound({ chatKey: 'group:555', messageId: '1', senderId: '10', senderName: '甲', at: Date.now(), text: '聊聊', addressed: 'at' })
  const r = await call(bare, 'GET', '/group')
  const rows = Object.fromEntries(r.json.groups.map((g) => [g.groupId, g]))
  check('列出配置里的群、见过的群，在范围内的排前面', r.json.groups[0].groupId === '555' && Boolean(rows['888']) && Boolean(rows['777']))
  check('配置里写了的群：inScope、viaConfig；没接入的群：不在范围', rows['555'].inScope && rows['555'].viaConfig && !rows['888'].inScope && !rows['888'].viaConfig)
  check('黑名单里的群标出来，哪怕有人打开也不在范围', rows['777'].blocked && !rows['777'].inScope)
  check('见过的群带名字和条数，不带任何内容', rows['888'].name === '陌生群' && rows['888'].seenCount === 2 && !JSON.stringify(rows['888']).includes('聊聊'))
  check('带每个群的引擎状态（最近的决定）和插话统计', rows['555'].engine.decisions.length === 1 && rows['555'].engine.decisions[0].reason === 'called:at' && rows['555'].interjects.total === 0)
  check('默认档位、五档说明（含盯群）、判断模型状态（provider 默认留空 = 跟宿主）', r.json.defaultMode === 'active' && r.json.modes.length === 5 && r.json.modes.some((m) => m.id === 'watch') && r.json.judge.status.model === 'deepseek-flash' && r.json.judge.config.provider === '' && r.json.judge.config.model === 'deepseek-flash')
  check('群设置里带盯群节奏', rows['555'].settings.watch?.minIntervalMs === 30000 && rows['555'].settings.watch?.perHour === 40)

  let a = await call(bare, 'PUT', '/group/888/admit', { admitted: true })
  check('逐个群打开', a.json.ok && groupSettings.isAdmitted('888') && (await call(bare, 'GET', '/group')).json.groups.find((g) => g.groupId === '888').inScope)
  check('参数不对：400', (await call(bare, 'PUT', '/group/888/admit', { admitted: 'yes' })).status === 400)
  a = await call(bare, 'PUT', '/group/888/admit', { admitted: false })
  check('再关上', a.json.ok && !groupSettings.isAdmitted('888'))

  let s = await call(bare, 'PUT', '/group/555/settings', { mode: 'active', eagerness: 0.8, reply: { quote: false } })
  check('改档位、积极度、是否引用回复', s.json.ok && engine.settingsFor('555').mode === 'active' && engine.settingsFor('555').eagerness === 0.8 && engine.settingsFor('555').reply.quote === false)
  s = await call(bare, 'PUT', '/group/555/settings', { reply: { maxChars: 200 } })
  check('只改一项不会丢掉别的覆盖', engine.settingsFor('555').reply.quote === false && engine.settingsFor('555').reply.maxChars === 200 && engine.settingsFor('555').mode === 'active')
  check('档位写错：400', (await call(bare, 'PUT', '/group/555/settings', { mode: 'chatty' })).status === 400)
  check('不在白名单里的项不能改：400', (await call(bare, 'PUT', '/group/555/settings', { judge: { model: 'x' } })).status === 400)
  check('值超范围：400', (await call(bare, 'PUT', '/group/555/settings', { eagerness: 3 })).status === 400 && (await call(bare, 'PUT', '/group/555/settings', { 'quietHours': { start: '25:61' } })).status === 400)
  s = await call(bare, 'PUT', '/group/555/settings', { eagerness: null, 'members': { enabled: false } })
  check('null = 恢复默认；可以按群关成员记忆', engine.settingsFor('555').eagerness === 0.5 && engine.settingsFor('555').members.enabled === false)
  s = await call(bare, 'PUT', '/group/555/settings', { quietHours: { start: '23:00', end: '07:00' } })
  check('静默时段', engine.settingsFor('555').quietHours.start === '23:00')

  memory.observe({ scope: 'member:555:10001', kind: 'preference', text: '喜欢摄影', actor: 'qq:members', origin: 'model' })
  memory.observe({ scope: 'member:555:10002', kind: 'fact', text: '住在上海', actor: 'qq:members', origin: 'model' })
  const f = await call(bare, 'POST', '/group/555/forget-member', { memberId: '10001', deleteMessages: true })
  check('“忘掉我”：删这个人的成员记忆、可选删原话', f.json.removedMemories === 1 && f.json.removedMessages === 7 && purged[0].join() === 'group,555,10001' && memory.list({ scope: 'member:555:10001' }).length === 0)
  check('别人的不受影响', memory.list({ scope: 'member:555:10002' }).length === 1)
  const blocked = memory.observe({ scope: 'member:555:10001', kind: 'fact', text: '又来写一条', actor: 'qq:members', origin: 'model' })
  check('之后这个人的记忆写不进去', blocked.action === 'dropped')
  check('memberId 不是号：400', (await call(bare, 'POST', '/group/555/forget-member', { memberId: 'abc' })).status === 400)
  const keep = await call(bare, 'POST', '/group/555/forget-member', { memberId: '10002' })
  check('不勾删原话时不动语料库', keep.json.removedMessages === null && purged.length === 1)
  check('忘掉一个群的运行时记录', (await call(bare, 'DELETE', '/group/888')).json.removed === true && groupSettings.get('888') === null)
}

console.log('C. 主动私聊页')
{
  let r = await call(bare, 'GET', '/outreach')
  check('默认关，已配对', r.json.enabled === false && r.json.ownerPaired === true && r.json.config.maxPerDay === 4)
  r = await call(bare, 'PUT', '/outreach', { enabled: true, maxPerDay: 2, quietHours: { start: '22:00' }, bogus: 1 })
  check('打开并调参，不认识的字段忽略', r.json.enabled === true && r.json.config.maxPerDay === 2 && r.json.config.quietHours.start === '22:00' && r.json.config.quietHours.end === '08:30')
  check('enabled 不是布尔：400', (await call(bare, 'PUT', '/outreach', { enabled: 'yes' })).status === 400)
  r = await call(bare, 'PUT', '/outreach', { maxPerDay: 999 })
  check('非法值回退并带警告', r.json.config.maxPerDay === 4 && r.json.warnings.length > 0)
  const before = JSON.stringify(outreach.state)
  r = await call(bare, 'POST', '/outreach/preview')
  check('预览：逐条闸门，零副作用', r.json.gates.length === 9 && JSON.stringify(outreach.state) === before)
  r = await call(bare, 'POST', '/outreach/reset')
  check('重置进度', r.json.ok && r.json.sentToday === 0)
}

console.log('D. 梗百科页')
{
  let r = await call(bare, 'GET', '/meme')
  check('总览：词库状态、联网开关（默认关）', r.json.settings.online === false && r.json.db.ok === false && r.json.status.ok === false)
  check('联网关着也没有同步服务时：503', (await call(bare, 'POST', '/meme/sync')).status === 503)
  r = await call(bare, 'PUT', '/meme/settings', { online: true })
  check('打开联网', r.json.settings.online === true && meme.getSettings().online === true)
  check('参数不对：400', (await call(bare, 'PUT', '/meme/settings', { online: 'yes' })).status === 400)

  const items = Array.from({ length: 5 }, (_, i) => ({ slug: `梗${i}`, title: `梗${i}`, summary: 's', tags: [], updated_at: `2026-10-1${i}T00:00:00Z`, content_html: '<h2>用法</h2>\n<p>调侃</p>' }))
  const fetchImpl = async (url) => {
    const u = new URL(url)
    const rest = decodeURIComponent(u.pathname.replace('/api/v1/public/memes', '').replace(/^\//, ''))
    if (!rest) return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ items, has_more: false }) }
    const item = items.find((x) => x.slug === rest)
    return item ? { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ item }) } : { status: 404, ok: false, headers: { get: () => null } }
  }
  const online = new MemeOnline({ dbPath: meme.dbPath, fetchImpl, sleep: async () => {} })
  const archive = new MemeArchive({ file: path.join(dir, 'meme', 'archive.json') })
  const wired = createMemeBase({ dbPath: meme.dbPath, memory, online, archive, settingsFile: path.join(dir, 'meme', 'settings.json'), log })
  const memeApi = createConsoleApi({ jobs: { list: () => [] }, config: {}, memory, meme: wired, qqStatus, signals, log })
  r = await call(memeApi, 'POST', '/meme/sync', { full: true })
  check('开始同步：立刻返回任务状态', r.json.ok && r.json.job !== undefined)
  for (let i = 0; i < 100 && wired.online.status().job?.running; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  const done = wired.online.status().job
  check('同步在后台跑完：抓了 5 条', done.running === false && done.fetched === 5 && done.error === null)
  r = await call(memeApi, 'GET', '/meme')
  check('总览里能看到词库条数和同步结果', r.json.db.ok === true && r.json.db.count === 5 && r.json.sync.job.fetched === 5)
  archive.put('某个梗', null)
  check('清空检索存档', (await call(memeApi, 'DELETE', '/meme/archive')).json.removed === 1)
  check('停止同步：没在跑也不报错', (await call(memeApi, 'DELETE', '/meme/sync')).json.ok === true)
}

console.log('E. 统一记忆页')
{
  memory.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短回答', actor: 'console', origin: 'user', confidence: 1 })
  memory.observe({ scope: 'chat:group:555', kind: 'preference', text: '这个群不喜欢 bot 主动搭话', actor: 'qq:feedback', origin: 'model', status: 'candidate' })
  memory.observe({ scope: 'chat:private:42', kind: 'fact', text: '周五交报告给张老师', actor: 'qq:idle', origin: 'model', source: { sessionId: 's1', at: 1, quote: '周五之前要交报告' } })
  let r = await call(bare, 'GET', '/memory/scopes')
  const scopes = Object.fromEntries(r.json.scopes.map((s) => [s.scope, s]))
  check('按范围列出条数和状态', scopes.owner.total === 1 && scopes['chat:group:555'].candidate === 1 && scopes['chat:private:42'].active === 1)
  r = await call(bare, 'GET', '/memory?scope=chat:private:42')
  check('某个范围的记忆：带来源原话和账本', r.json.total === 1 && r.json.entries[0].sources[0].quote === '周五之前要交报告' && r.json.entries[0].ledger.injected === 0)
  r = await call(bare, 'GET', '/memory?status=candidate')
  check('按状态筛', r.json.entries.length === 1 && r.json.entries[0].scope === 'chat:group:555')
  r = await call(bare, 'GET', `/memory?q=${encodeURIComponent('报告')}`)
  check('按关键字搜', r.json.entries.length === 1)
  const id = (await call(bare, 'GET', '/memory?scope=chat:private:42')).json.entries[0].id
  let j = await call(bare, 'POST', `/memory/${id}/judge`, { verdict: 'wrong' })
  check('裁决：不对 → 变成 rejected', j.json.ok && j.json.entry.status === 'rejected')
  check('不认识的裁决：400', (await call(bare, 'POST', `/memory/${id}/judge`, { verdict: 'nuke' })).status === 400)
  check('不存在的记忆：409', (await call(bare, 'POST', '/memory/m999999/judge', { verdict: 'pin' })).status === 409)
  check('清空范围要确认词', (await call(bare, 'POST', '/memory/purge', { scope: 'chat:private:42' })).status === 400)
  const p = await call(bare, 'POST', '/memory/purge', { scope: 'chat:private:42', confirm: '忘掉', block: true })
  check('清空并屏蔽', p.json.removed >= 1 && memory.list({ scope: 'chat:private:42' }).length === 0)
}

console.log('F. 信号')
{
  signals.emit({ kind: 'correction', scope: 'chat:private:42', quote: '不对' })
  signals.emit({ kind: 'gui-takeover', scope: 'chat:private:42' })
  const r = await call(bare, 'GET', '/signals')
  check('最近的信号，新的在前', r.json.recent.length === 2 && r.json.recent[0].kind === 'gui-takeover')
}

outreach.dispose(); groupSettings.dispose(); memory.dispose(); meme.archive?.flush?.()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

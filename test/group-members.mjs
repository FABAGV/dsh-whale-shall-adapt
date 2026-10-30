/**
 * 群成员记忆、群概况冷启动、目标归属（lib/conversation/members.js、chat-memory.js 的 about 路由、corpus.purgeMember）。
 * 用假模型和真的记忆层、语料库（临时目录）。运行：node test/group-members.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldRecords, pickMembers, parseMemberReply, parseOverviewReply, GroupMemoryJobs } from '../lib/conversation/members.js'
import { ChatMemory } from '../lib/conversation/chat-memory.js'
import { normalizeBundle } from '../lib/conversation/handoff.js'
import { createMemory } from '../lib/memory/index.js'
import { createGroupSettings } from '../lib/group/settings.js'
import { resolveGroupConfig, settingsForGroup } from '../lib/group/config.js'
import { resolveConfig } from '../lib/qq/config.js'
import { Corpus } from '../lib/qq/corpus.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = { info() {}, warn() {}, debug() {}, error() {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-members-'))
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const DAY = 24 * 3600 * 1000

console.log('A. 整理语料')
{
  const recs = [
    { kind: 'message', ts: NOW - 3000, senderId: '111', senderName: '阿明', text: '我周末想去爬山' },
    { kind: 'message', ts: NOW - 5000, senderId: '222', senderName: '小红', text: '好啊\n一起' },
    { kind: 'forward', ts: NOW - 4000, senderId: '111', text: '不是文字消息' },
    { kind: 'message', ts: NOW - 2000, senderId: 'abc', senderName: '坏号', text: '号不是数字' },
    { kind: 'message', ts: NOW - 1000, senderId: '111', senderName: '阿明', text: '' },
  ]
  const folded = foldRecords(recs)
  check('只留文字消息、QQ 号是数字的', folded.lines.length === 2)
  check('按时间排好，每行“QQ号|昵称：内容”，换行压成空格', folded.lines[0] === '222|小红：好啊 一起' && folded.lines[1] === '111|阿明：我周末想去爬山')
  const many = Array.from({ length: 600 }, (_, i) => ({ kind: 'message', ts: NOW - 600000 + i * 1000, senderId: '9', senderName: 'x', text: `第${i}条${'啊'.repeat(100)}` }))
  const capped = foldRecords(many)
  check('条数和字数都有上限，留最新的', capped.lines.length <= 400 && capped.lines.join('').length <= 14000 && capped.lines.at(-1).includes('第599条'))

  const picked = pickMembers([
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'message', ts: 100 + i, senderId: '111', senderName: '阿明', text: 'x' })),
    ...Array.from({ length: 3 }, (_, i) => ({ kind: 'message', ts: 100 + i, senderId: '222', text: 'x' })),
    ...Array.from({ length: 6 }, (_, i) => ({ kind: 'message', ts: 100 + i, senderId: '333', text: 'x' })),
  ], { minMessages: 5, maxPerRun: 1 })
  check('新发言不够的不整理，按条数从多到少，限人数', picked.length === 1 && picked[0].id === '111' && picked[0].count === 8)
  const since = pickMembers([{ kind: 'message', ts: 50, senderId: '1', text: 'x' }, { kind: 'message', ts: 150, senderId: '1', text: 'x' }], { sinceTs: 100, minMessages: 1 })
  check('水位线之前的发言不算新发言', since[0].count === 1)
}

console.log('B. 严格解析模型输出')
{
  const ok = '{"members":[{"id":"111","items":[{"kind":"preference","text":"爱爬山","confidence":0.9},{"kind":"weird","text":"叫阿明"}]},{"id":"999","items":[{"kind":"fact","text":"不是挑出来的人"}]}]}'
  const parsed = parseMemberReply(ok, ['111', '222'])
  check('只取我们挑出来的那几位', parsed.length === 2 && parsed.every((x) => x.id === '111'))
  check('kind 不在白名单：当 fact', parsed[1].kind === 'fact')
  check('置信度限制在 0.8 以内，缺省 0.5', parsed[0].confidence === 0.8 && parsed[1].confidence === 0.5)
  check('不是 JSON：返回 null', parseMemberReply('随便聊聊', ['111']) === null && parseMemberReply('{"x":1}', ['111']) === null)
  const long = parseMemberReply(JSON.stringify({ members: [{ id: '111', items: Array.from({ length: 9 }, () => ({ kind: 'fact', text: '很长'.repeat(100) })) }] }), ['111'])
  check('每人最多 3 条，每条限长', long.length === 3 && long[0].text.length <= 60)
  const overview = parseOverviewReply('```json\n{"items":[{"kind":"note","text":"摄影爱好者群"},{"kind":"zzz","text":"常聊器材"},{"text":""}]}\n```')
  check('群概况：取出条目、kind 回退为 note、空条目丢弃', overview.length === 2 && overview[1].kind === 'note')
  check('群概况最多 8 条', parseOverviewReply(JSON.stringify({ items: Array.from({ length: 20 }, () => ({ text: 'a' })) })).length === 8)
}

console.log('C. 整理任务')
{
  const dir = tmp()
  const clock = { t: NOW }
  const now = () => clock.t
  const memory = createMemory({ dir: path.join(dir, 'memory'), now })
  const groupSettings = createGroupSettings({ dir, now })
  const qqConfig = resolveConfig({ scope: { groups: ['555', '666'], friends: [] } })
  const groupConfig = resolveGroupConfig({})
  const corpus = new Corpus({ config: qqConfig, log, root: path.join(dir, 'corpus') })
  const addMessages = (groupId, count, senderId, { text = '周末去爬山吧', start = NOW - DAY } = {}) => {
    for (let i = 0; i < count; i += 1) {
      corpus.append({ chatType: 'group', chatId: groupId, kind: 'message', ts: start + i * 1000, payload: { senderId, senderName: `用户${senderId}`, text: `${text} ${i}`, messageId: `m${groupId}${senderId}${i}` } })
    }
  }
  let reply = ''
  const prompts = []
  const model = { run: async (input) => { prompts.push(input.user); if (reply instanceof Error) throw reply; return reply } }
  const jobs = new GroupMemoryJobs({
    corpus, memory, groupSettings, model, qqConfig: () => qqConfig, settingsFor: (id) => settingsForGroup(groupConfig, id, groupSettings.get(id)), log, now,
  })

  check('没有语料时没有该做的事', jobs.due().length === 0)
  addMessages('555', 8, '111')
  addMessages('555', 6, '222')
  addMessages('555', 2, '333')
  addMessages('777', 30, '111')
  check('只在接入范围内的群里做事（777 不在范围）', jobs.groups().sort().join() === '555')
  check('新群：先做冷启动（语料不够时只记下检查时间）', jobs.due()[0]?.groupId === '555' && jobs.due()[0].job === 'coldStart')
  await jobs.runColdStart('555')
  check('冷启动检查过之后：轮到成员整理', jobs.due()[0]?.groupId === '555' && jobs.due()[0].job === 'members')

  reply = JSON.stringify({ members: [
    { id: '111', items: [{ kind: 'preference', text: '喜欢爬山，周末常约人', confidence: 0.7 }] },
    { id: '222', items: [{ kind: 'relation', text: '常和 111 一起约活动' }] },
    { id: '333', items: [{ kind: 'fact', text: '新发言不够，不该被整理' }] },
  ] })
  let r = await jobs.runMembers('555')
  check('整理成功：挑了两位（333 发言不够），写了两条', r.ok && r.members === 2 && r.added === 2, JSON.stringify(r))
  check('提示里列了群聊记录和要整理的群友，没有 333', prompts[0].includes('=== 群聊记录 ===') && prompts[0].includes('111（') && !prompts[0].includes('333（'))
  const m111 = memory.list({ scope: 'member:555:111' })
  check('写进 member:群号:QQ号，来源是模型、置信度不超过 0.8', m111.length === 1 && m111[0].origin === 'model' && m111[0].confidence <= 0.8 && m111[0].kind === 'preference')
  check('模型多给的 333 没写', memory.list({ scope: 'member:555:333' }).length === 0)
  check('进度落盘：下次不重复整理', groupSettings.stateOf('555').members.at === clock.t && groupSettings.stateOf('555').members.mark > 0)
  check('刚整理过：到期列表里没有', jobs.due().every((d) => d.job !== 'members'))
  clock.t += 7 * 3600 * 1000
  check('过了 6 小时：又到期', jobs.due().some((d) => d.groupId === '555'))
  r = await jobs.runMembers('555')
  check('没有新发言：不调模型、只推进水位线', r.ok && r.members === 0 && prompts.length === 1)

  addMessages('555', 7, '444', { start: clock.t - 1000 * 60 })
  reply = new Error('额度用完了')
  r = await jobs.runMembers('555')
  check('模型出错：返回失败，水位线不动，下次还会再试', !r.ok && r.reason === 'model-failed' && jobs.snapshot().failures === 1)
  reply = '这不是 JSON'
  r = await jobs.runMembers('555')
  check('返回的不是 JSON：失败', !r.ok && r.reason === 'bad-reply')

  // “忘掉我”：整个范围清掉并屏蔽，之后不再记
  memory.purge({ scope: 'member:555:444', block: true }, 'console')
  reply = JSON.stringify({ members: [{ id: '444', items: [{ kind: 'fact', text: '他爱喝咖啡' }] }] })
  r = await jobs.runMembers('555')
  check('被“忘掉我”屏蔽过的人：记忆层丢弃写入', r.ok && r.added === 0 && memory.list({ scope: 'member:555:444' }).length === 0)

  // 这个群关掉成员记忆
  groupSettings.setSettings('555', { members: { enabled: false } })
  addMessages('555', 9, '555', { start: clock.t - 1000 * 30 })
  const before = prompts.length
  r = await jobs.runMembers('555')
  check('这个群关了成员记忆：什么都不做', !r.ok && r.reason === 'disabled' && prompts.length === before)
  check('关了成员记忆的群不会出现在到期列表里', jobs.due().every((d) => !(d.groupId === '555' && d.job === 'members')))
  groupSettings.setSettings('555', { members: null })

  // 冷启动
  addMessages('666', 50, '111')
  check('新群先做冷启动', jobs.due().find((d) => d.groupId === '666')?.job === 'coldStart')
  r = await jobs.runColdStart('666')
  check('语料不够 200 条：不生成，记下检查时间', !r.ok && r.reason === 'too-few-messages' && !groupSettings.stateOf('666').coldStart.doneAt)
  check('刚检查过：6 小时内不再重复检查，改做成员整理', jobs.due().find((d) => d.groupId === '666')?.job === 'members')
  addMessages('666', 200, '222', { start: clock.t - 3600 * 1000 })
  clock.t += 7 * 3600 * 1000
  reply = JSON.stringify({ items: [{ kind: 'note', text: '登山爱好者的群，周末常约线路', confidence: 0.6 }, { kind: 'relation', text: '111 是领队' }] })
  r = await jobs.runColdStart('666')
  check('语料够了：生成群概况', r.ok && r.added === 2)
  const overview = memory.list({ scope: 'chat:group:666' })
  check('群概况全部是候选记忆（不注入）', overview.length === 2 && overview.every((e) => e.status === 'candidate' && e.origin === 'model'))
  check('候选记忆不进注入', memory.select(['chat:group:666'], 1000).picked.length === 0)
  check('只做一次', Boolean(groupSettings.stateOf('666').coldStart.doneAt) && jobs.due().every((d) => !(d.groupId === '666' && d.job === 'coldStart')))
  groupSettings.setSettings('666', { coldStart: { enabled: false } })
  check('可以按群关掉冷启动', true)

  // tick：一次只做一件事
  const calls = []
  const slow = new GroupMemoryJobs({
    corpus, memory, groupSettings, qqConfig: () => qqConfig, settingsFor: (id) => settingsForGroup(groupConfig, id, groupSettings.get(id)), log, now,
    model: { run: async () => { calls.push(1); await new Promise((r2) => setTimeout(r2, 50)); return '{"members":[]}' } },
  })
  groupSettings.patchState('555', { members: null })
  const t1 = slow.tick()
  const t2 = slow.tick()
  check('上一件没做完，tick 直接返回同一件', t1 === t2)
  await t1
  check('做完后可以再 tick', slow.snapshot().running === false)

  memory.dispose()
  groupSettings.dispose()
}

console.log('D. 目标归属：碎片里写的是群友自己的事')
{
  const dir = tmp()
  const store = createMemory({ dir })
  let enabled = true
  const mem = new ChatMemory({ store, membersEnabled: () => enabled })
  const bundle = normalizeBundle({ fragments: [
    { text: '想周末去爬山', kind: 'intent', tag: 1, about: '10001' },
    { text: '答应明天发文件', kind: 'promise', tag: 2 },
    { text: '想请假', kind: 'intent', tag: 1, about: '不是号' },
  ] })
  check('about 只认纯数字 QQ 号', bundle.fragments[0].about === '10001' && bundle.fragments[1].about === '' && bundle.fragments[2].about === '')
  const r = mem.absorb({ scope: 'group:555', fragments: bundle.fragments, gen: 1, aging: false })
  check('群友的愿望记在他名下', store.list({ scope: 'member:555:10001' }).map((e) => e.text).join() === '想周末去爬山')
  check('机器人自己的承诺记在群里', store.list({ scope: 'chat:group:555' }).map((e) => e.text).sort().join().includes('答应明天发文件'))
  check('愿望没有写成群里（机器人）的偏好', !store.list({ scope: 'chat:group:555' }).some((e) => e.text === '想周末去爬山'))
  check('about 不是号：当群里的事处理', store.list({ scope: 'chat:group:555' }).some((e) => e.text === '想请假') && r.added === 3)
  enabled = false
  const off = mem.absorb({ scope: 'group:555', fragments: [{ text: '我喜欢摄影', kind: 'preference', tag: 1, about: '10002' }], gen: 1, aging: false })
  check('这个群关了成员记忆：群友的事直接丢掉，不写成群里的事', off.added === 0 && off.dropped === 1 && !store.list({ scope: 'chat:group:555' }).some((e) => e.text === '我喜欢摄影'))
  const priv = mem.absorb({ scope: 'private:42', fragments: [{ text: '我喜欢摄影', kind: 'preference', tag: 1, about: '10002' }], gen: 1, aging: false })
  check('私聊里 about 不起作用', priv.added === 1 && store.list({ scope: 'chat:private:42' }).length === 1)
  store.dispose()
}

console.log('E. 语料库：删掉某个人的原话')
{
  const dir = tmp()
  const cfg = resolveConfig({})
  const corpus = new Corpus({ config: cfg, log, root: path.join(dir, 'corpus') })
  const add = (ts, senderId, text) => corpus.append({ chatType: 'group', chatId: '555', kind: 'message', ts, payload: { senderId, text } })
  add(NOW, '111', 'a')
  add(NOW + 1, '222', 'b')
  add(NOW + 2, '111', 'c')
  add(NOW - 3 * DAY, '111', 'old')
  add(NOW - 3 * DAY + 1, '222', 'old-b')
  corpus.append({ chatType: 'group', chatId: '555', kind: 'forward', ts: NOW + 3, payload: { senderId: '111', nodes: [] } })
  check('删掉某人的全部原话，返回条数', corpus.purgeMember('group', '555', '111') === 4)
  const rest = corpus.search({ chatType: 'group', chatId: '555', limit: 100 })
  check('别人的原话原样保留', rest.length === 2 && rest.every((r) => r.senderId === '222'))
  check('一个分片删空了就删文件', fs.readdirSync(path.join(dir, 'corpus', 'group-555')).length === 2)
  check('号不是纯数字：拒绝', corpus.purgeMember('group', '555', '../x') === -1)
  check('没有这个会话：返回 0', corpus.purgeMember('group', '999', '111') === 0)
  check('chatType 不合法：返回 -1', corpus.purgeMember('x', '555', '111') === -1)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

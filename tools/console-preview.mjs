/**
 * 在合成数据上启动控制台，用来看界面、调样式。不碰 ~/.dsh，不调用真实模型。
 *
 * 用法：node tools/console-preview.mjs [端口，默认 6799]
 * 会打印一个一次性登录链接（60 秒内有效）和登录密钥文件的位置；Ctrl+C 退出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorld, agentFor, QQ_GROUP } from '../test/fixtures/console-world.mjs'
import { createMemory } from '../lib/memory/index.js'
import { createGroupSettings } from '../lib/group/settings.js'
import { GroupEngine } from '../lib/group/engine.js'
import { resolveConfig } from '../lib/qq/config.js'
import { createOutreach } from '../lib/outreach/index.js'
import { createMemeBase } from '../lib/meme/index.js'
import { MemeArchive } from '../lib/meme/archive.js'
import { MemeOnline } from '../lib/meme/sync.js'
import { createOwner } from '../lib/qq/owner.js'
import { createSignals } from '../lib/core/signals.js'
import { createQqStatus } from '../lib/index.js'

delete process.env.DSH_SHALL_CONSOLE
const port = Number(process.argv[2]) || 6799
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-console-preview-'))
// QQ 侧的合成服务：群聊、主动私聊、梗百科、记忆页都要有东西可看（全是假数据，不连任何服务）
const shall = path.join(home, 'shall')
const memory = createMemory({ dir: path.join(shall, 'memory') })
const owner = createOwner({ dir: shall })
{
  const { code } = owner.issueCode()
  owner.tryPair('10042', code)
}
const groupSettings = createGroupSettings({ dir: shall })
const qqConfig = resolveConfig({ scope: { groups: [String(QQ_GROUP), '30004'], friends: [] } })
const engine = new GroupEngine({ config: qqConfig.group, settings: groupSettings, memory, botName: () => '小鲸' })
const signals = createSignals()
const qqStatus = createQqStatus()
const judge = Object.assign(async () => ({}), {
  status: () => ({
    using: 'fallback', provider: 'host', model: 'default', note: 'deepseek-account/deepseek-flash 不可用（账号没登录），改用宿主默认模型 host/default；5 分钟后再试 deepseek-account/deepseek-flash', lastError: '',
    target: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'host-provider' },
    candidates: ['deepseek-account/deepseek-flash', 'deepseek-official/deepseek-flash', 'host/default'],
  }),
})
qqStatus.provide('group', { engine, settings: groupSettings, judge, corpus: { purgeMember: () => 0 }, qqConfig })
groupSettings.noteSeen('30077', '摄影交流群')
groupSettings.noteSeen('30077')
groupSettings.setSettings(String(QQ_GROUP), { mode: 'present' })
for (const [i, text] of ['今天天气不错', '有人去爬山吗', '我也想去'].entries()) {
  engine.onInbound({ chatKey: `group:${QQ_GROUP}`, messageId: String(100 + i), senderId: '10001', senderName: '小明', at: Date.now(), text, addressed: i === 0 ? 'at' : '', mentionsOthers: false, isCommand: false, fromBot: false })
}
for (const result of ['engaged', 'engaged', 'rejected', 'silence']) groupSettings.recordInterject(String(QQ_GROUP), result)
memory.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短直接的回答，不要客套', actor: 'console', origin: 'user', confidence: 1 })
memory.observe({ scope: 'owner:work', kind: 'works', text: '改配置前先备份原文件', actor: 'profile', origin: 'model', confidence: 0.8, importanceDelta: 2 })
memory.observe({ scope: 'owner:chat', kind: 'intent', text: '待续：问问周末爬山的集合时间', actor: 'qq:memo', origin: 'model', confidence: 0.5, validUntil: Date.now() + 2 * 86400000 })
memory.observe({ scope: `chat:group:${QQ_GROUP}`, kind: 'note', text: '登山爱好者的群，周末常约线路', actor: 'qq:coldstart', origin: 'model', status: 'candidate', confidence: 0.6, source: { sessionId: 's', at: Date.now(), quote: '周末有人去香山吗' } })
memory.observe({ scope: `member:${QQ_GROUP}:10001`, kind: 'preference', text: '喜欢摄影，常聊器材', actor: 'qq:members', origin: 'model', confidence: 0.7 })
const outreach = createOutreach({ dir: shall, config: {}, memory, owner, rand: () => 0.5, isConnected: () => true, isBusy: async () => ({ busy: false }), deliver: async () => {} })
qqStatus.provide('outreach', outreach)
const meme = createMemeBase({
  dbPath: path.join(shall, 'meme', 'memes.db'), memory, settingsFile: path.join(shall, 'meme', 'settings.json'),
  online: new MemeOnline({ dbPath: path.join(shall, 'meme', 'memes.db'), fetchImpl: async () => ({ status: 500, ok: false, headers: { get: () => null } }) }),
  archive: new MemeArchive({ file: path.join(shall, 'meme', 'search_archive.json') }),
})
signals.emit({ kind: 'correction', scope: 'chat:private:42', chatKey: 'private:42', quote: '不对，我说的是周三' })

const world = await buildWorld({ home, consolePort: port, shared: { memory, meme, owner, qqStatus, signals, groupSettings } })
const { service, headers } = world
await world.waitFor(() => service.getState().lastSignals != null)

// 画像、权限拒绝、人格、技能各来一点数据，让每一页都有东西可看。
await service.regenerateNow()
const entries = service.getState().profile?.entries ?? []
if (entries[1]) service.pinEntry(entries[1].id, entries[1].claim)
const guard = world.guards[0]
for (const [name, args] of [['bash', { command: 'cat /etc/passwd' }], ['read', { file_path: 'C:/Windows/win.ini' }], ['web_fetch', { url: 'http://127.0.0.1:6710/api/overview' }]]) {
  guard?.({ agent: agentFor(headers.group), name, arguments: args })
}
service.updatePrivacy({ chats: { 'private:42': { tier: 'safe', note: '我自己的小号' } } }, 'console')

const personas = service.host.personas
const created = personas.create({
  name: '小明风格',
  kind: 'member',
  source: { chatType: 'group', chatId: QQ_GROUP, memberId: '10001', memberName: '小明', days: 30 },
  consent: true,
})
if (created.ok) {
  const id = created.persona.id
  const generated = service.host.workbench.startGenerate(id)
  if (generated.ok) await world.waitFor(() => service.host.jobs.get(generated.job.id)?.status !== 'running')
  personas.addFeedback(id, { version: 1, message: '电脑开不了机怎么办', reply: '哈哈哈！先清缓存！', note: '他不怎么用感叹号', rating: 'bad' })
  personas.update(id, { enabled: true, bindings: [{ kind: 'chat', key: `group:${QQ_GROUP}` }] })
}
personas.create({ name: '温柔学姐', kind: 'description', description: '说话温柔，爱用"呀""呢"，会先安慰再给建议。' })

const mined = service.host.workbench.startMining()
if (mined.ok) await world.waitFor(() => service.host.jobs.get(mined.job.id)?.status !== 'running')

const ticket = service.issueConsoleTicket()
console.log(`\n控制台：${world.consoleUrl}`)
console.log(`一次性登录链接（60 秒内有效）：${ticket.url}`)
console.log(`登录密钥文件：${world.keyFile}`)
console.log(`合成数据目录：${home}`)
console.log('Ctrl+C 退出。')

const keepAlive = setInterval(() => {}, 1 << 30)
process.on('SIGINT', () => {
  clearInterval(keepAlive)
  world.close()
  process.exit(0)
})

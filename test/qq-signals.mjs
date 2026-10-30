/**
 * 负反馈信号的采集与落账、交班回看（lib/conversation/signals.js、correction.js、handoff-miss.js、idle.js 的回看）。
 * 假会话事件、假时钟，不调真实模型。运行：node test/qq-signals.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSignals, SIGNAL_KINDS } from '../lib/core/signals.js'
import { SignalCollector, classifyUserWords } from '../lib/conversation/signals.js'
import { CorrectionLedger } from '../lib/conversation/correction.js'
import { userWords, userTailOf, findHandoffMisses } from '../lib/conversation/handoff-miss.js'
import { StateStore } from '../lib/conversation/state.js'
import { ChatMemory } from '../lib/conversation/chat-memory.js'
import { ConversationHandoff } from '../lib/conversation/handoff.js'
import { IdleConsolidator } from '../lib/conversation/idle.js'
import { createMemory } from '../lib/memory/index.js'
import { resolveConfig } from '../lib/qq/config.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = { info() {}, warn() {}, debug() {}, error() {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-signals-'))

console.log('A. 信号总线')
{
  const bus = createSignals()
  const got = []
  const off = bus.on((e) => got.push(e))
  bus.on(() => { throw new Error('订阅者出错') })
  check('认得的类型发出去，补上默认来源和置信度', bus.emit({ kind: 'correction', scope: 'chat:group:1' }) && got[0].source === 'qq' && got[0].confidence === 'low')
  check('不认识的类型被拒绝', !bus.emit({ kind: 'whatever' }) && got.length === 1)
  check('一个订阅者出错不影响别的订阅者和发出者', got.length === 1)
  off()
  bus.emit({ kind: 'followup' })
  check('取消订阅后不再收到', got.length === 1 && bus.recent().length === 2)
  check('总线认得契约里的全部 11 种事件', SIGNAL_KINDS.length === 11)
}

console.log('B. 用户话语分类')
{
  check('句首纠正', classifyUserWords('不对，我说的是周三') === 'correction' && classifyUserWords('别这样回答') === 'correction' && classifyUserWords('我说的是第二个') === 'correction')
  check('句首追问', classifyUserWords('什么意思') === 'followup' && classifyUserWords('没懂，再讲讲') === 'followup')
  check('句中出现“不对”不算（宁漏勿错）', classifyUserWords('这个方案我觉得不对劲但可以试试') === '' && classifyUserWords('我觉得你说得不对') === '')
  check('普通话不算', classifyUserWords('帮我看一下这个文件') === '')
  check('来源标注和群背景会被剥掉再判', userWords('[来自 QQ 私聊，发言人 阿花]\n不对，是周三') === '不对，是周三')
  check('群背景块和梗百科附注也剥掉', userWords('[来自 QQ 群 1，发言人 甲（QQ 2，消息号 3）]\n【群里刚才在聊（插件附上的背景，不是对你说的）】\n乙: 哈哈\n\n你怎么看\n\n[附：梗百科（x）]\n某个梗') === '你怎么看')
}

console.log('C. 采集')
{
  const bus = createSignals()
  const got = []
  bus.on((e) => got.push(e))
  const plugin = new Set(['rpc-plugin'])
  const chats = { root: { kind: 'root', chatType: 'private', chatId: '42' }, sub: { kind: 'task', chatType: 'private', chatId: '42' } }
  const bridge = { chatForSession: (id) => chats[id] ?? null, isPluginRequest: (_id, rpc) => plugin.has(rpc) }
  let t = 1_000_000
  const collector = new SignalCollector({ signals: bus, bridge, now: () => t })
  const ev = (sessionId, type, data, seq = 1) => collector.onEvent({ id: sessionId }, { type, data, seq })
  const user = (sessionId, text, rpcId) => ev(sessionId, 'user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })

  user('root', '[来自 QQ 私聊，发言人 我]\n帮我改一下', 'rpc-plugin')
  check('普通话不产生信号', got.length === 0)
  ev('root', 'assistant/message', { message: { content: [{ type: 'text', text: '我已经改成周二了' }] } })
  user('root', '[来自 QQ 私聊，发言人 我]\n不对，我说的是周三', 'rpc-plugin')
  check('明确纠正：低置信度，带脱敏的原话和上一句 bot 的话', got.at(-1)?.kind === 'correction' && got.at(-1).confidence === 'low' && got.at(-1).quote === '不对，我说的是周三' && got.at(-1).prevAssistant.includes('周二'))
  check('信号带范围（私聊：chat:private:42）、会话和聊天键', got.at(-1).scope === 'chat:private:42' && got.at(-1).sessionId === 'root' && got.at(-1).chatKey === 'private:42')

  user('root', '用户在 GUI 里自己说的话', 'rpc-gui')
  check('GUI 接手：高置信度', got.at(-1).kind === 'gui-takeover' && got.at(-1).confidence === 'high')
  const n = got.length
  user('root', '又说了一句', 'rpc-gui')
  check('5 分钟内不重复报接手', got.length === n)
  t += 6 * 60 * 1000
  user('root', '过了很久又接手', 'rpc-gui')
  check('过了冷却又报', got.length === n + 1)

  ev('root', 'tool/call', { callId: 'c1', name: 'bash' })
  ev('root', 'tool/result', { message: { toolCallId: 'c1', isError: true } })
  check('工具失败一次不报', got.at(-1).kind === 'gui-takeover')
  ev('root', 'tool/call', { callId: 'c2', name: 'bash' })
  ev('root', 'tool/result', { message: { toolCallId: 'c2', isError: true } })
  check('同一个工具连续失败两次：报 tool-fail', got.at(-1).kind === 'tool-fail' && got.at(-1).confidence === 'high' && got.at(-1).quote.includes('bash'))
  ev('root', 'tool/call', { callId: 'c3', name: 'bash' })
  ev('root', 'tool/result', { message: { toolCallId: 'c3', isError: false } })
  ev('root', 'tool/call', { callId: 'c4', name: 'bash' })
  ev('root', 'tool/result', { message: { toolCallId: 'c4', isError: true } })
  check('中间成功过就重新数', got.at(-1).kind === 'tool-fail' && got.filter((e) => e.kind === 'tool-fail').length === 1)

  const before = got.length
  user('sub', '不对', 'rpc-plugin')
  ev('ghost', 'tool/call', { callId: 'x', name: 'bash' })
  check('子代理、不认识的会话不采集', got.length === before)
  user('root', '我的 token 是 sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD，不对', 'rpc-plugin')
  check('纠正句首才算；句中带密钥的话不产生信号', got.length === before)
  user('root', '不对，key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'rpc-plugin')
  check('带密钥的原话经过脱敏再进信号', got.at(-1).kind === 'correction' && !got.at(-1).quote.includes('abcdefghijklmnopqrstuvwxyz0123456789'))
  check('采集统计', collector.snapshot().correction === 2 && collector.snapshot().takeover === 2 && collector.snapshot().toolFail === 1)
}

console.log('D. 落账')
{
  const dir = tmp()
  const store = createMemory({ dir })
  const bus = createSignals()
  let t = 5_000_000
  const ledger = new CorrectionLedger({ signals: bus, store, now: () => t }).start()
  bus.emit({ kind: 'correction', scope: 'chat:private:42', quote: '不对，我说的是周三', sessionId: 's1', at: t })
  const cands = store.list({ scope: 'chat:private:42' })
  check('明确纠正：记一条候选 avoid（不注入）', cands.length === 1 && cands[0].status === 'candidate' && cands[0].kind === 'avoid' && cands[0].text.startsWith('被纠正过：') && cands[0].origin === 'model')
  check('候选记忆不进注入', store.select(['chat:private:42'], 1000).picked.length === 0)
  bus.emit({ kind: 'correction', scope: 'chat:private:42', quote: '别这样回答', sessionId: 's1', at: t })
  check('10 分钟内同一个聊天最多记一条', store.list({ scope: 'chat:private:42' }).length === 1)
  t += 11 * 60 * 1000
  bus.emit({ kind: 'correction', scope: 'chat:private:42', quote: '别这样回答', sessionId: 's1', at: t })
  check('过了冷却再记', store.list({ scope: 'chat:private:42' }).length === 2)
  bus.emit({ kind: 'gui-takeover', scope: 'chat:group:7', at: t })
  bus.emit({ kind: 'tool-fail', scope: 'chat:group:7', at: t })
  check('接手和工具失败只记账，不写记忆', store.list({ scope: 'chat:group:7' }).length === 0 && ledger.snapshot().scopes.find((s) => s.scope === 'chat:group:7')['gui-takeover'] === 1)
  bus.emit({ kind: 'correction', scope: 'owner', quote: '不对', at: t })
  bus.emit({ kind: 'correction', scope: 'owner:work', quote: '不对', at: t })
  check('绝不写主人的 owner / owner:work 片', store.list({ scope: 'owner' }).length === 0 && store.list({ scope: 'owner:work' }).length === 0 && ledger.snapshot().ignored === 2)
  bus.emit({ kind: 'correction', scope: 'owner:chat', quote: '不对，是周三', at: t })
  check('主人私聊的 owner:chat 可以', store.list({ scope: 'owner:chat' }).length === 1)
  ledger.stop()
  bus.emit({ kind: 'correction', scope: 'chat:private:99', quote: '不对', at: t })
  check('停止后不再处理', store.list({ scope: 'chat:private:99' }).length === 0)
  store.dispose()
}

console.log('E. 交班回看：规则预筛')
{
  const tail = userTailOf([
    { role: '用户', text: '[来自 QQ 私聊，发言人 我]\n以后回复都用中文，不要夹英文单词' },
    { role: '我', text: '好的' },
    { role: '用户', text: '[来自 QQ 私聊，发言人 我]\n嗯' },
    { role: '用户', text: '[来自 QQ 私聊，发言人 我]\n周五之前要把报告交给张老师' },
  ])
  check('留下上一代的用户原话（去标注、太短的不要）', tail.length === 2 && tail[0].startsWith('以后回复都用中文'))
  const misses = findHandoffMisses({
    fresh: ['[来自 QQ 私聊，发言人 我]\n我再说一遍，以后回复都用中文，别夹英文单词', '[来自 QQ 私聊，发言人 我]\n帮我查一下天气', '[来自 QQ 私聊，发言人 我]\n周五之前要把报告交给张老师'],
    tail,
    existing: ['周五前把报告交给张老师'],
  })
  check('用户重复交代、且记忆里没有：算漏项', misses.length === 1 && misses[0].text.includes('以后回复都用中文'))
  check('记忆里已经有的不算（周五的报告）', !misses.some((m) => m.text.includes('报告')))
  check('和上一代无关的新话不算', !misses.some((m) => m.text.includes('天气')))
  check('没有上一代原话时什么都不找', findHandoffMisses({ fresh: ['以后回复都用中文'], tail: [], existing: [] }).length === 0)
}

console.log('F. 交班回看：接进空闲整理')
{
  const base = tmp()
  let clock = 1_800_000_000_000
  const now = () => clock
  const events = []
  let seq = 0
  const say = (role, text) => events.push({ type: role === 'user' ? 'user/message' : 'assistant/message', seq: ++seq, data: { message: { content: [{ type: 'text', text }] } } })
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, options: { provider: 'fake', model: 'fake' } }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return { readSession: async () => ({ events: events.slice() }) }
      if (name === 'agents') return { get: (id) => (id === 's2' ? agent : undefined) }
      if (name === 'llm') {
        return { async *stream() { yield { type: 'text-delta', index: 0, text: JSON.stringify({ fragments: [], drop: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
      }
      return undefined
    },
  }
  const config = resolveConfig({})
  const state = new StateStore({ dir: path.join(base, 'qq'), log })
  state.set('private', '5', {
    chatType: 'private', chatId: '5', rootSessionId: 's2', rootGeneration: 2, lastHandoff: null,
    handoffTail: { gen: 2, at: clock, passes: 0, lines: ['以后回复都用中文，不要夹英文单词', '下周三去上海出差，订周二晚上的高铁'] },
  })
  const store = createMemory({ dir: path.join(base, 'memory') })
  const memory = new ChatMemory({ store })
  const handoff = new ConversationHandoff({ ctx, config, log, bridge: {}, state, memory, relay: {}, gate: {}, resolver: {}, notify: () => {} })
  const bus = createSignals()
  const got = []
  bus.on((e) => got.push(e))
  const idle = new IdleConsolidator({ ctx, config, log, state, handoff, memory, signals: bus, now })
  for (const text of ['我再说一遍，以后回复都用中文，不要夹英文单词', '帮我看一眼这个文件', '谢谢']) {
    say('user', `[来自 QQ 私聊，发言人 我]\n${text}`)
    idle.noteUserPrompt('s2')
    say('assistant', '好的')
  }
  idle.noteTurnEnd('s2')
  clock += 21 * 60_000
  const r = await idle.runOnce('private:5')
  check('空闲整理跑成功', r.ok, JSON.stringify(r))
  const facts = store.list({ scope: 'chat:private:5' })
  check('漏项补成了记忆（模型来源、置信度 0.5、带原话出处）', facts.length === 1 && facts[0].text.includes('以后回复都用中文') && facts[0].origin === 'model' && facts[0].confidence === 0.5 && facts[0].sources?.[0]?.quote)
  check('同时发了 handoff-miss 信号', got.length === 1 && got[0].kind === 'handoff-miss' && got[0].scope === 'chat:private:5')
  check('回看只算一次，passes 记 1', state.get('private', '5').handoffTail.passes === 1)
  for (let i = 0; i < 3; i += 1) {
    say('user', `[来自 QQ 私聊，发言人 我]\n随便聊聊第${i}句话`)
    say('user', `[来自 QQ 私聊，发言人 我]\n再聊聊第${i}句`)
    say('user', `[来自 QQ 私聊，发言人 我]\n又聊第${i}句`)
    idle.noteUserPrompt('s2'); idle.noteUserPrompt('s2'); idle.noteUserPrompt('s2')
    clock += 21 * 60_000
    await idle.runOnce('private:5')
  }
  check('回看只在新一代的前几次整理里做，之后清掉', state.get('private', '5').handoffTail === undefined)
  check('统计里记了补了几条', idle.snapshot().handoffMisses === 1)
  store.dispose()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

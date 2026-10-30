/**
 * 空闲整理（lib/conversation/idle.js）：假时钟、假宿主，不碰真实 ~/.dsh、不调用真实模型。
 * 运行：node test/qq-idle.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qq-idle-'))
const log = { info() {}, warn() {}, debug() {}, error() {} }
let clock = 1_800_000_000_000
const now = () => clock
const MIN = 60_000

// ── 假宿主：会话历史、agent 状态、llm ───────────────────────────────────
const events = []
let seq = 0
const say = (role, text) => events.push({
  type: role === 'user' ? 'user/message' : 'assistant/message',
  seq: ++seq,
  data: { message: { content: [{ type: 'text', text }] } },
})
const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, options: { provider: 'fake', model: 'fake' } }
const llmCalls = []
let llmReply = () => ({ fragments: [], drop: [] })
const ctx = {
  get(name) {
    if (name === 'sessionQuery') return { readSession: async () => ({ events: events.slice() }) }
    if (name === 'agents') return { get: (id) => (id === 's1' ? agent : undefined) }
    if (name === 'llm') {
      return {
        async *stream(options) {
          llmCalls.push(options.messages[0].content[0].text)
          yield { type: 'text-delta', index: 0, text: JSON.stringify(llmReply()) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    return undefined
  },
}

const config = resolveConfig({})
const state = new StateStore({ dir: path.join(tmp, 'qq'), log })
state.set('private', '5', { chatType: 'private', chatId: '5', rootSessionId: 's1', rootGeneration: 1, lastHandoff: null })
const store = createMemory({ dir: path.join(tmp, 'memory') })
const memory = new ChatMemory({ store })
const handoff = new ConversationHandoff({ ctx, config, log, bridge: {}, state, memory, relay: {}, gate: {}, resolver: {}, notify: () => {} })
const idle = new IdleConsolidator({ ctx, config, log, state, handoff, memory, now })

console.log('A. 配置')
check('默认开启：20 分钟、3 轮', idle.enabled && config.conversation.idleMinutes === 20 && config.conversation.idleMinTurns === 3)
check('非法值回退', resolveConfig({ conversation: { idleMinutes: -1, idleMinTurns: 0 } }).conversation.idleMinutes === 20)
check('0 = 关闭', new IdleConsolidator({ ctx, config: resolveConfig({ conversation: { idleMinutes: 0 } }), log, state, handoff, memory }).enabled === false)

console.log('B. 触发条件')
{
  say('user', '我下周三要去上海出差')
  idle.noteUserPrompt('s1')
  say('assistant', '好的，记下了')
  idle.noteTurnEnd('s1')
  check('只有 1 轮：不到期', idle.due().length === 0)
  say('user', '帮我订周二晚上的高铁票')
  idle.noteUserPrompt('s1')
  say('user', '座位要靠窗')
  idle.noteUserPrompt('s1')
  idle.noteTurnEnd('s1')
  check('够 3 轮但刚说完：不到期', idle.due().length === 0)
  clock += 19 * MIN
  check('19 分钟：不到期', idle.due().length === 0)
  clock += 2 * MIN
  check('21 分钟：到期', idle.due().join() === 'private:5')
  idle.noteUserPrompt('ghost')
  check('不认识的会话不计数', idle.due().length === 1)
}

console.log('C. 跳过')
{
  agent.status = 'running'
  const busy = await idle.runOnce('private:5')
  check('会话忙时不跑', busy.ok === false && busy.reason.startsWith('busy') && llmCalls.length === 0)
  agent.status = 'idle'
  handoff.frozen.set('private:5', { at: clock, gen: 1 })
  const frozen = await idle.runOnce('private:5')
  check('交班中不跑', frozen.reason === 'handoff-in-progress' && llmCalls.length === 0)
  handoff.frozen.delete('private:5')
  check('跳过后仍然到期（下次再试）', idle.due().length === 1)
}

console.log('D. 整理一次')
{
  llmReply = () => ({ fragments: [
    { text: '下周三去上海出差，要订周二晚上的高铁票', tag: 2, kind: 'intent' },
    { text: '坐高铁喜欢靠窗的座位', tag: 1, kind: 'preference' },
  ], drop: [] })
  const run = await idle.tick()
  check('整理成功，新增 2 条', run?.ok === true && run.added === 2, JSON.stringify(run))
  check('提示词用的是只要碎片的那份', llmCalls.length === 1 && llmCalls[0].includes('记忆整理者') && !llmCalls[0].includes('交班的整理者'))
  check('碎片写进本聊天的记忆', memory.forScope('private:5').length === 2)
  check('来源记成空闲整理', store.list({ scope: 'chat:private:5' }).every((e) => e.history[0]?.actor === 'qq:idle'))
  const mark = state.get('private', '5').lastExtract
  check('水位线推进到最新事件，并记下会话', mark?.sessionId === 's1' && mark.seq === seq, JSON.stringify(mark))
  check('整理完不再到期', idle.due().length === 0)
  check('状态端点能看到', idle.snapshot().runs === 1 && idle.snapshot().extracted === 2)
}

console.log('E. 只整理水位线之后')
{
  say('user', '车次改成 G7 吧')
  idle.noteUserPrompt('s1')
  say('user', '另外帮我查一下酒店')
  idle.noteUserPrompt('s1')
  say('user', '预算一晚 500 以内')
  idle.noteUserPrompt('s1')
  clock += 25 * MIN
  llmReply = () => ({ fragments: [{ text: '上海酒店预算一晚 500 以内', tag: 1, kind: 'constraint' }], drop: [] })
  const run = await idle.tick()
  const prompt = llmCalls.at(-1)
  check('第二次只把新对话给模型', run?.ok === true && prompt.includes('G7') && !prompt.includes('下周三要去上海出差'))
  check('已有碎片作为清单给模型（可以合并）', prompt.includes('靠窗'))
  check('新增 1 条，共 3 条', memory.forScope('private:5').length === 3)
  check('水位线继续推进', state.get('private', '5').lastExtract.seq === seq)
}

console.log('F. 新对话不够多 / 换了会话')
{
  say('user', '好的谢谢')
  idle.noteUserPrompt('s1')
  idle.noteUserPrompt('s1')
  idle.noteUserPrompt('s1')
  clock += 25 * MIN
  const few = await idle.runOnce('private:5')
  check('计数到了但历史里真正的新发言不足 3 条：不调用模型', few.reason === 'too-few-turns' && llmCalls.length === 2)
  check('计数按历史校正，不会反复到期', idle.due().length === 0)
  const record = state.get('private', '5')
  record.rootSessionId = 's2'
  state.set('private', '5', record)
  const gone = await idle.runOnce('private:5')
  check('交班换了会话：读不到新会话就记失败，不改水位线', gone.ok === false && state.get('private', '5').lastExtract.sessionId === 's1')
}

console.log('G. 一次只跑一个')
{
  const record = state.get('private', '5')
  record.rootSessionId = 's1'
  state.set('private', '5', record)
  for (let i = 0; i < 3; i += 1) {
    say('user', `第 ${i} 件新事情：买${['伞', '充电宝', '耳机'][i]}`)
    idle.noteUserPrompt('s1')
  }
  clock += 25 * MIN
  llmReply = () => ({ fragments: [], drop: [] })
  const first = idle.tick()
  const second = idle.tick()
  check('上一个还没跑完时 tick 返回同一个任务', first === second && first !== null)
  await first
  check('只调用了一次模型', llmCalls.length === 3)
  check('模型说没有值得记的：不算失败，水位线照样推进', state.get('private', '5').lastExtract.seq === seq)
}

store.dispose()
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

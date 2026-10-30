/**
 * 回复这一头的流程：分条、输出过滤（沉默、备忘、@、引用）、入站合并、备忘进记忆。
 * 全部用假会话事件和假时钟，不连任何服务。运行：node test/qq-reply-flow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProgressRelay, splitChunks } from '../lib/conversation/relay.js'
import { parseReply } from '../lib/conversation/reply-tags.js'
import { InboundMerger, mergeable, combine } from '../lib/qq/merge.js'
import { ChatMemory, MEMO_PREFIX } from '../lib/conversation/chat-memory.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = { info() {}, warn() {}, debug() {}, error() {} }
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r))
}

console.log('A. 分条')
{
  check('短文本不分', splitChunks('你好', 100).length === 1)
  const para = `${'甲'.repeat(60)}\n\n${'乙'.repeat(60)}`
  const byPara = splitChunks(para, 100)
  check('优先在段落处断开', byPara.length === 2 && byPara[0] === '甲'.repeat(60) && byPara[1] === '乙'.repeat(60))
  const bySentence = splitChunks(`${'甲'.repeat(60)}。${'乙'.repeat(60)}。`, 100)
  check('其次在句末断开', bySentence.length === 2 && bySentence[0].endsWith('。'))
  const hard = splitChunks('字'.repeat(250), 100)
  check('找不到断点才硬切，每条不超上限', hard.length === 3 && hard.every((c) => c.length <= 100) && hard.join('') === '字'.repeat(250))
  check('分出的条不为空', splitChunks(`\n\n${'a'.repeat(300)}\n\n`, 100).every(Boolean))
  check('默认上限 1200', splitChunks('x'.repeat(1300)).length === 2)
}

console.log('B. 合并连发')
{
  const timers = []
  let t = 0
  const fakeTimers = {
    set: (fn, ms) => { const id = timers.length + 1; timers.push({ id, at: t + ms, fn }); return id },
    clear: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
  }
  const advance = (ms) => {
    t += ms
    for (const timer of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  const out = []
  const merger = new InboundMerger({ windowMs: 1000, onFlush: (d) => out.push(d), timers: fakeTimers })
  const dec = (text, extra = {}, senderId = '1', chatId = '10') => ({
    intent: 'chat', text, addressedBy: extra.addressedBy ?? '',
    message: { chatType: 'group', chatId, senderId, messageId: `m${Math.random()}`, segments: [], ...extra.message }, ...extra.top,
  })
  merger.push(dec('如果明天不下雨'))
  advance(600)
  merger.push(dec('我们去爬山吧'))
  advance(600)
  check('第二句来了就重新计时，还没放行', out.length === 0)
  advance(500)
  check('安静够了：合成一条放行', out.length === 1 && out[0].text === '如果明天不下雨\n我们去爬山吧' && out[0].merged === 2)
  check('合并后记着被合并的消息号', out[0].mergedMessageIds.length === 2)

  out.length = 0
  merger.push(dec('甲说一句', {}, '1'))
  merger.push(dec('乙插进来', {}, '2'))
  check('换了个人说话：上一个人攒下的立刻放行', out.length === 1 && out[0].text === '甲说一句')
  advance(1100)
  check('乙的随后放行', out.length === 2 && out[1].text === '乙插进来')

  out.length = 0
  merger.push(dec('带引用的', { message: { segments: [{ kind: 'reply', messageId: '9' }] } }))
  check('带引用的不合并，直接放行', out.length === 1 && !mergeable(dec('x', { message: { segments: [{ kind: 'reply' }] } })))
  out.length = 0
  merger.push(dec('先说一句'))
  merger.push(dec('戳', { addressedBy: 'poke' }))
  check('戳一戳不合并，而且先把攒下的放行，保持顺序', out.length === 2 && out[0].text === '先说一句' && out[1].addressedBy === 'poke')
  out.length = 0
  merger.push(dec('群 A 的话', {}, '1', '10'))
  merger.push(dec('群 B 的话', {}, '1', '20'))
  advance(1100)
  check('不同聊天各合各的', out.length === 2)

  out.length = 0
  merger.push(dec('小鲸', { addressedBy: 'name' }))
  merger.push(dec('帮我看一下', { addressedBy: 'at' }))
  advance(1100)
  check('合并后叫法取最强的', out[0].addressedBy === 'at')
  check('合并后锚点是最后一条', out[0].message.messageId !== undefined && combine([dec('a'), dec('b')]).text === 'a\nb')

  const direct = []
  const off = new InboundMerger({ windowMs: 0, onFlush: (d) => direct.push(d), timers: fakeTimers })
  off.push(dec('立即'))
  check('窗口为 0：不合并，直接放行', direct.length === 1)
  merger.push(dec('将被丢弃'))
  merger.dispose()
  advance(5000)
  check('卸载后不再放行', out.length === 1 && merger.snapshot().waiting === 0)
}

console.log('C. 输出过滤：沉默、备忘、@、引用')
{
  const sent = []
  const sentOpts = []
  const sleeps = []
  const outcomes = []
  const notes = []
  const handlers = []
  const chats = { g1: { chatType: 'group', chatId: '555' }, p1: { chatType: 'private', chatId: '42' } }
  const bridge = { chatForSession: (id) => chats[id] ?? null, isPluginRequest: () => true }
  const relay = new ProgressRelay({
    bridge, log, flushIntervalMs: 5,
    send: async (chatType, chatId, text, opts) => { sent.push(`${chatType}:${chatId}:${text}`); sentOpts.push(opts); return { message_id: sent.length } },
    outputFilter: ({ chat, text }) => {
      const parsed = parseReply(text, { validQq: (qq) => qq === '10001', validMessage: (id) => id === '777' })
      if (parsed.memo) notes.push({ chat: chat.chatId, memo: parsed.memo })
      return parsed
    },
    onTurnOutcome: (o) => outcomes.push({ chat: o.chat.chatId, spoke: o.spoke }),
    chunkPlan: (chat) => (chat.chatType === 'group' ? { maxChars: 50, delayFor: (text) => text.length * 10 } : null),
    sleep: async (ms) => { sleeps.push(ms) },
  })
  relay.attach({ on: (name, fn) => { handlers.push([name, fn]); return () => {} } })
  const emit = (sessionId, type, data) => handlers.find(([n]) => n === 'session/event')[1]({ id: sessionId }, { type, data })
  const turn = async (sessionId, texts) => {
    emit(sessionId, 'turn/start', { turn: 1 })
    emit(sessionId, 'user/message', { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: 'r' } })
    for (const text of texts) emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    emit(sessionId, 'turn/end', { reason: { kind: 'completed' } })
    await settle()
  }
  const reset = () => { sent.length = 0; sentOpts.length = 0; sleeps.length = 0; outcomes.length = 0; notes.length = 0 }

  await turn('g1', ['<refuse/>\n【备忘】\n【目的】没人叫我\n【状态】跳过'])
  check('<refuse/>：群里什么都不发，也不补“这一轮结束了”', sent.length === 0)
  check('沉默的回合 spoke=false', outcomes.at(-1).spoke === false && relay.snapshot().silentTurns === 1)
  check('沉默的回合备忘也会交给过滤器', notes.at(-1).memo.status === 'skip')

  reset()
  await turn('g1', ['好的，已经改完了。\n【备忘】\n【目的】改配置\n【状态】待续\n【待续】问他要不要升级'])
  check('正常回复：备忘被剥掉再发', sent.join('|') === 'group:555:好的，已经改完了。')
  check('带待续的备忘交给了过滤器', notes.at(-1).memo.pending[0] === '问他要不要升级' && outcomes.at(-1).spoke === true)
  check('第一条带 first 标记', sentOpts[0].first === true)

  reset()
  await turn('g1', ['<quote id="777"/><at id="10001"/>这个我来说', '再补一句'])
  check('<quote/> 和 <at/> 变成发送选项，只加在第一条', sentOpts[0].replyTo === '777' && sentOpts[0].at.join() === '10001')
  check('同一回合的后续消息不再带 first', sent.length >= 1)

  reset()
  await turn('g1', ['长'.repeat(120)])
  check('群里超过字数上限：分条', sent.length === 3, String(sent.length))
  check('分条之间按打字速度留间隔', sleeps.length === 2 && sleeps[0] === 500)
  check('只有第一条带 first / replyTo 位', sentOpts[0].first === true && sentOpts[1].first === false && sentOpts[2].first === false)

  reset()
  await turn('p1', ['<refuse/>'])
  check('私聊里模型也可以选择不说', sent.length === 0)

  reset()
  await turn('p1', [])
  check('私聊里没有任何正文：仍然补一句“这一轮结束了”（防止以为它死了）', sent.length === 1 && sent[0].includes('这一轮结束了'))
  reset()
  await turn('g1', [])
  check('群里没有正文：不补那句', sent.length === 0)

  reset()
  await turn('p1', ['你好呀\n【备忘】\n【状态】完成'])
  check('私聊里备忘同样被剥掉', sent.join('|') === 'private:42:你好呀' && notes.at(-1).memo.status === 'done')

  reset()
  emit('g1', 'turn/start', { turn: 2 })
  emit('g1', 'user/message', { role: 'user', content: [], source: { kind: 'user', rpcId: 'r2' } })
  emit('g1', 'assistant/message', { message: { content: [{ type: 'text', text: '<refuse/>' }] } })
  emit('g1', 'assistant/message', { message: { content: [{ type: 'text', text: '后面的正文' }] } })
  emit('g1', 'turn/end', { reason: { kind: 'completed' } })
  await settle()
  check('沉默之后同一回合的正文也不发', sent.length === 0)
  reset()
  await turn('g1', ['下一回合恢复正常'])
  check('下一回合恢复', sent.length === 1)
  relay.dispose()
}

console.log('D. 备忘进记忆')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-memo-'))
  const store = createMemory({ dir })
  const mem = new ChatMemory({ store })
  const sc = 'group:555'
  let r = mem.noteMemo({ scope: sc, memo: { purpose: '帮他改配置', status: 'pending', pending: ['问他要不要升级依赖', '确认测试有没有跑过'] }, sessionId: 's1' })
  check('待续存成两条 intent', r.added === 2)
  const open = store.list({ scope: 'chat:group:555', kind: 'intent', status: 'active' })
  check('文本带“待续：”前缀、来源是模型、置信度低、有过期时间', open.length === 2 && open.every((e) => e.text.startsWith(MEMO_PREFIX) && e.origin === 'model' && e.confidence <= 0.5 && e.validUntil > Date.now()))
  check('过期是 3 天后', open.every((e) => Math.abs(e.validUntil - Date.now() - 3 * 24 * 3600 * 1000) < 5000))
  r = mem.noteMemo({ scope: sc, memo: { purpose: '帮他改配置', status: 'pending', pending: ['问他要不要升级依赖'] } })
  check('同一件事再记一次不重复', store.list({ scope: 'chat:group:555', kind: 'intent', status: 'active' }).length === 2)
  r = mem.noteMemo({ scope: sc, memo: { purpose: '确认测试有没有跑过，结果告诉他', status: 'done', pending: [] } })
  check('完成：划掉目的相近的那一条，别的不动', r.closed === 1 && store.list({ scope: 'chat:group:555', kind: 'intent', status: 'active' }).length === 1)
  check('划掉的变成历史，不是删除', store.list({ scope: 'chat:group:555', kind: 'intent', status: 'historical' }).length === 1)
  r = mem.noteMemo({ scope: sc, memo: { purpose: '随便', status: 'skip', pending: ['不该记'] } })
  check('跳过：什么都不记', r.added === 0 && r.closed === 0)
  r = mem.noteMemo({ scope: sc, memo: null })
  check('没有备忘：不抛', r.added === 0)
  const rendered = mem.renderFor(sc, 1000).text
  check('注入文本里出现待续，并有说明', rendered.includes('待续：问他要不要升级依赖') && rendered.includes('标着“待续：”'))
  const pinned = store.observe({ scope: 'chat:group:555', kind: 'intent', text: `${MEMO_PREFIX}用户钉住的事`, actor: 'console', origin: 'user', confidence: 1 })
  store.judge(pinned.id, 'pin', { actor: 'console' })
  mem.noteMemo({ scope: sc, memo: { purpose: '用户钉住的事', status: 'done', pending: [] } })
  check('用户钉住/用户来源的待续，模型说完成也划不掉', store.get(pinned.id).status === 'active')
  store.dispose()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

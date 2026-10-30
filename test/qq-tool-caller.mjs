/**
 * QQ 工具自己检查调用方（PLAN 改进点 2，docs/CONTRACTS.md 第 6 节）。
 * 调用方 { 你自己的会话, QQ 群会话, 它的子代理, 交班换下来的旧会话, 没有会话头 } × 目标 { 本聊天, 别的聊天, 不传 }。
 * 运行：node test/qq-tool-caller.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerQqTools } from '../lib/qq/tools.js'
import { resolveConfig } from '../lib/qq/config.js'
import { createBindings } from '../lib/conversation/bindings.js'
import { createMemory } from '../lib/memory/index.js'
import { ChatMemory } from '../lib/conversation/chat-memory.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
async function rejects(fn) {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qq-caller-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }

const bindings = createBindings({ dir: tmp })
bindings.bind('group', '100', 'g100-old')
bindings.bind('group', '100', 'g100', { generation: 2 })
bindings.bind('private', '200', 'p200')
const headers = { 'g100-kid': { id: 'g100-kid', parentSession: 'g100', origin: 'subagent' } }
const chatOfCaller = (header) => bindings.resolve(header, (id) => headers[id])

const sent = []
const searched = []
const memory = new ChatMemory({ store: createMemory({ dir: tmp }) })
const registered = new Map()
registerQqTools({
  ctx: { get: (n) => (n === 'tools' ? { register(d) { registered.set(d.name, d); return () => {} }, guard() { return () => {} } } : undefined) },
  config: resolveConfig({}),
  log: silent,
  send: async (chatType, chatId, text) => sent.push({ chatType, chatId, text }),
  listChats: () => [
    { chatType: 'group', chatId: '100', chatName: 'A 群', workspacePath: 'D:\\qq\\a' },
    { chatType: 'private', chatId: '200', chatName: '小明', workspacePath: 'D:\\qq\\b' },
  ],
  corpus: { search: (q) => { searched.push(q); return [] } },
  memory,
  memoryGeneration: () => ({ value: 0 }),
  chatOfCaller,
})
const as = (id) => ({ agent: { session: { header: headers[id] ?? { id } } } })
const OWNER = as('my-own-session')
const send = registered.get('shall_qq_send')
const chats = registered.get('shall_qq_chats')
const history = registered.get('shall_qq_history')
const mem = registered.get('shall_qq_memory')

console.log('A. 没有会话头')
check('send 拒绝', await rejects(() => send.execute({ chat_type: 'group', chat_id: '100', text: 'hi' }, {})))
check('chats 拒绝', await rejects(() => chats.execute({}, {})))
check('history 拒绝', await rejects(() => history.execute({}, {})))
check('memory 拒绝', await rejects(() => mem.execute({ chat_type: 'group', chat_id: '100' }, {})))

console.log('B. 你自己的会话：不限')
await send.execute({ chat_type: 'private', chat_id: '200', text: '主人发的' }, OWNER)
check('能往任意聊天发', sent.at(-1)?.chatId === '200')
check('能列出全部聊天', (await chats.execute({}, OWNER)).chats.length === 2)
await history.execute({}, OWNER)
check('不传 chat_id 时可以跨聊天检索', searched.at(-1).chatId === undefined)
check('send 不给 chat_id 报错', await rejects(() => send.execute({ text: 'x' }, OWNER)))

console.log('C. QQ 群会话：只能作用于自己的群')
await send.execute({ text: '不传就发回本群' }, as('g100'))
check('不传 chat_id 默认发回自己所在的群', sent.at(-1)?.chatType === 'group' && sent.at(-1)?.chatId === '100')
check('往别的聊天发被拒', await rejects(() => send.execute({ chat_type: 'private', chat_id: '200', text: '越界' }, as('g100'))))
check('chat_type 对、chat_id 不对也被拒', await rejects(() => send.execute({ chat_type: 'group', chat_id: '999', text: '越界' }, as('g100'))))
const listed = await chats.execute({}, as('g100'))
check('只列出自己所在的聊天', listed.chats.length === 1 && listed.chats[0].chatId === '100')
await history.execute({}, as('g100'))
check('检索语料自动限定在本群', searched.at(-1).chatType === 'group' && searched.at(-1).chatId === '100')
check('检索别的聊天被拒', await rejects(() => history.execute({ chat_type: 'private', chat_id: '200' }, as('g100'))))
check('改别的聊天的记忆被拒', await rejects(() => mem.execute({ chat_type: 'private', chat_id: '200', forget: 'all' }, as('g100'))))
check('看自己群的记忆可以', (await mem.execute({}, as('g100'))).scope === 'group:100')

console.log('D. 子代理、旧会话')
check('QQ 群会话派出的子代理同样被限定', await rejects(() => send.execute({ chat_type: 'private', chat_id: '200', text: '越界' }, as('g100-kid'))))
await send.execute({ text: '子代理发回本群' }, as('g100-kid'))
check('子代理不传 chat_id 默认发回父会话的群', sent.at(-1)?.chatId === '100')
check('交班换下来的旧会话仍然被限定', await rejects(() => send.execute({ chat_type: 'private', chat_id: '200', text: '越界' }, as('g100-old'))))

console.log('E. QQ 私聊会话')
check('只能发回这个私聊', await rejects(() => send.execute({ chat_type: 'group', chat_id: '100', text: '越界' }, as('p200'))))
await send.execute({ text: '回私聊' }, as('p200'))
check('不传默认发回这个私聊', sent.at(-1)?.chatType === 'private' && sent.at(-1)?.chatId === '200')

console.log('F. 按需群总结 shall_qq_summary')
{
  const rowsFor = new Map()
  const queries = []
  const NOW = Date.now()
  const registeredF = new Map()
  registerQqTools({
    ctx: { get: (n) => (n === 'tools' ? { register(d) { registeredF.set(d.name, d); return () => {} }, guard() { return () => {} } } : undefined) },
    config: resolveConfig({ scope: { groups: ['100'], friends: [] } }),
    log: silent,
    send: async () => {},
    listChats: () => [],
    corpus: {
      search: (q) => {
        queries.push(q)
        return rowsFor.get(q.chatId) ?? []
      },
    },
    chatOfCaller,
  })
  const summary = registeredF.get('shall_qq_summary')
  rowsFor.set('100', [
    { kind: 'message', ts: NOW - 60_000, senderName: '乙', senderId: '2', text: '后一条' },
    { kind: 'forward', ts: NOW - 120_000, senderName: '丙', senderId: '3', nodes: [{}, {}] },
    { kind: 'message', ts: NOW - 180_000, senderName: '甲', senderId: '1', text: '前一条\n带换行' },
    { kind: 'message', ts: NOW - 190_000, senderName: '甲', senderId: '1', text: '' },
  ])
  check('工具注册了', Boolean(summary))
  check('没有会话头：拒绝', await rejects(() => summary.execute({ chat_id: '100' }, {})))
  const own = await summary.execute({}, as('g100'))
  check('群会话不传 chat_id：默认总结自己所在的群', own.chatId === '100' && queries.at(-1).chatType === 'group' && queries.at(-1).chatId === '100')
  check('记录按时间从早到晚、换行压成一行、合并转发只写条数、空消息不要', own.count === 3 && own.transcript.split('\n')[0].endsWith('甲: 前一条 带换行') && own.transcript.includes('[合并转发 2 条]') && own.transcript.split('\n')[2].endsWith('乙: 后一条'))
  check('默认看最近 6 小时', Math.abs((Date.now() - queries.at(-1).since) - 6 * 3600_000) < 5000)
  await summary.execute({ hours: 1000 }, as('g100'))
  check('小时数最多 72', Math.abs((Date.now() - queries.at(-1).since) - 72 * 3600_000) < 5000)
  check('群会话总结别的群被拒', await rejects(() => summary.execute({ chat_id: '999' }, as('g100'))))
  check('私聊会话不能用它总结别的群', await rejects(() => summary.execute({ chat_id: '100' }, as('p200'))))
  check('你自己的会话必须给群号', await rejects(() => summary.execute({}, OWNER)))
  check('你自己的会话可以总结范围内的群', (await summary.execute({ chat_id: '100' }, OWNER)).chatId === '100')
  check('不在接入范围的群：即使是你自己的会话也拒绝', await rejects(() => summary.execute({ chat_id: '555' }, OWNER)))
  rowsFor.set('100', Array.from({ length: 300 }, (_, i) => ({ kind: 'message', ts: NOW - (300 - i) * 1000, senderName: '甲', senderId: '1', text: `第${i}条${'啊'.repeat(150)}` })).reverse())
  const big = await summary.execute({ max_messages: 400 }, as('g100'))
  check('总字数有上限，留最新的并标明省略', big.truncated === true && big.transcript.length <= 12000 && big.transcript.includes('第299条'))
  const rendered = summary.output.render({}, big)[0].text
  check('渲染给模型的文本带说明', rendered.includes('最近 6 小时') && rendered.includes('更早的已省略'))
  check('没有记录也能渲染', summary.output.render({}, { count: 0, hours: 6, chatId: '100', transcript: '' })[0].text.includes('没有记录'))
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

/**
 * 梗百科接进 QQ 侧：shall_meme_lookup 工具、群黑话只查调用方所在的群、仅聊天等级放行、前台约定写了用法。
 * 运行：node test/meme-wiring.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerQqTools } from '../lib/qq/tools.js'
import { resolveConfig } from '../lib/qq/config.js'
import { createMemeBase, formatSlang } from '../lib/meme/index.js'
import { createMemory } from '../lib/memory/index.js'
import { createBindings } from '../lib/conversation/bindings.js'
import { PrivacyPolicy } from '../lib/privacy/policy.js'
import { FRONTDESK_TEXT } from '../lib/conversation/frontdesk.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-meme-wiring-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }

const memory = createMemory({ dir: path.join(tmp, 'memory') })
memory.observe({ scope: 'chat:group:42', kind: 'slang', text: formatSlang('老地方', '学校东门那家麻辣烫'), actor: 'console', origin: 'user' })
const meme = createMemeBase({ dbPath: path.join(tmp, 'none.db'), memory })
const bindings = createBindings({ dir: path.join(tmp, 'qq') })
bindings.bind('group', '42', 'sess-42')
bindings.bind('group', '7', 'sess-7')

const registered = new Map()
const ctx = {
  get: (name) => (name === 'tools'
    ? { register(def) { registered.set(def.name, def); return () => {} }, guard() { return () => {} } }
    : undefined),
}
registerQqTools({
  ctx,
  config: resolveConfig({}),
  log: silent,
  send: async () => {},
  listChats: () => [],
  meme,
  chatOfCaller: (header) => bindings.resolve(header),
})
const tool = registered.get('shall_meme_lookup')
const exec = (sessionId) => ({ agent: { session: { header: { id: sessionId } } } })

console.log('A. 工具')
check('注册了 shall_meme_lookup', Boolean(tool))
const own = await tool.execute({ term: '老地方' }, exec('sess-42'))
check('在群 42 的会话里查得到本群黑话', own.found && own.custom && own.text.includes('东门'), JSON.stringify(own))
const other = await tool.execute({ term: '老地方' }, exec('sess-7'))
check('别的群的会话查不到群 42 的黑话', other.found === false && other.text.includes('没有'))
const unknown = await tool.execute({ term: '老地方' }, exec('不认识的会话'))
check('认不出调用方时不查任何群的黑话', unknown.found === false)
let threw = false
try {
  await tool.execute({ term: '  ' }, exec('sess-42'))
} catch {
  threw = true
}
check('空词报错', threw)
check('没有 meme 时不注册', (() => {
  const reg = new Map()
  registerQqTools({ ctx: { get: () => ({ register(d) { reg.set(d.name, d); return () => {} }, guard() { return () => {} } }) }, config: resolveConfig({}), log: silent, send: async () => {}, listChats: () => [] })
  return !reg.has('shall_meme_lookup')
})())

console.log('B. 权限')
const policy = new PrivacyPolicy({ dir: path.join(tmp, 'policy'), config: {}, log: silent })
policy.setBindings(bindings)
const header = { id: 'sess-42', cwd: 'D:\\anywhere' }
check('QQ 群会话是“仅聊天”等级', policy.ruleFor(header).tier === 'chat', policy.ruleFor(header).tier)
check('仅聊天等级放行 shall_meme_lookup', policy.guard({ name: 'shall_meme_lookup', arguments: { term: '老地方' }, agent: { session: { header } } }) === undefined)
check('仅聊天等级照样拦 bash', typeof policy.guard({ name: 'bash', arguments: { command: 'dir' }, agent: { session: { header } } }) === 'string')

console.log('C. 前台约定')
check('写了先查 shall_meme_lookup', FRONTDESK_TEXT.includes('`shall_meme_lookup`'))
check('说明了消息后面的附加背景不是用户的话', FRONTDESK_TEXT.includes('[附：梗百科]'))

memory.dispose()
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

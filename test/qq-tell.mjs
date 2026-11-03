/**
 * `shall_qq_tell`：跨会话捎话的权限与正文形状。
 *
 * 规则：
 *   - 任何会话（群的、私聊的、群会话派出来的子代理）都能用这个工具给**别的** QQ 会话捎话；
 *   - 目标必须在 qq.scope / 控制台群接入的范围内（由 tools.guard 统一挡，和 shall_qq_send 同一份判据）；
 *   - 不能发给自己所在的会话；
 *   - 正文由插件加一行来源标注：`（来自 群 100 的群会话）` / `（来自 主人对接会话）`；
 *   - 目标没有常驻会话时返回 delivered:false + 原因，不抛错；
 *   - 不传 tell 依赖时不注册这个工具。
 *
 * 运行：node test/qq-tell.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerQqTools } from '../lib/qq/tools.js'
import { resolveConfig } from '../lib/qq/config.js'
import { createBindings } from '../lib/conversation/bindings.js'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qq-tell-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }
const OWNER = '3511618235'

const bindings = createBindings({ dir: tmp })
bindings.bind('private', OWNER, 'p-owner')
bindings.bind('group', '100', 'g100')
bindings.bind('group', '200', 'g200')
const headers = {
  // 父会话自己的 header 也要在：子代理的归属是靠 parentSession 往上找出来的
  g100: { id: 'g100' },
  'g100-kid': { id: 'g100-kid', parentSession: 'g100', origin: 'subagent' },
  desk: { id: 'desk', cwd: path.join(tmp, 'workspace') },
}
const chatOfCaller = (header) => bindings.resolve(header, (id) => headers[id])

/** 记录每次投递（chatType/chatId/正文），并按 noSession 决定目标有没有常驻会话 */
const deliveries = []
const noSession = new Set()
let tellResult = { ok: true }

const registered = new Map()
let guardFn = null
registerQqTools({
  ctx: {
    get: (n) =>
      n === 'tools'
        ? {
            register(def) {
              registered.set(def.name, def)
              return () => {}
            },
            guard(fn) {
              guardFn = fn
              return () => {}
            },
          }
        : undefined,
  },
  config: resolveConfig({ scope: { groups: ['100', '200'], friends: [OWNER] } }),
  log: silent,
  send: async () => {},
  listChats: () => [],
  owner: { owner: () => OWNER, isOwner: (id) => String(id) === OWNER },
  chatOfCaller,
  tell: async ({ chatType, chatId, text }) => {
    deliveries.push({ chatType, chatId, text })
    if (noSession.has(`${chatType}:${chatId}`)) return { ok: false, sessionId: '', error: '那个会话还没有常驻会话' }
    return tellResult
  },
})

const tool = registered.get('shall_qq_tell')
const as = (header) => ({ agent: { session: { header } } })

console.log('A. 工具注册与门控覆盖')
{
  check('注册了 shall_qq_tell', Boolean(tool))
  check('门控挂上了', typeof guardFn === 'function')
  const denial = guardFn({
    name: 'shall_qq_tell',
    arguments: { chat_type: 'group', chat_id: '999', text: 'x' },
    agent: { session: { header: { id: 'g100' } } },
  })
  check('范围外的目标被门控拒掉', typeof denial === 'string' && denial.includes('不在 QQ 通道'), String(denial))
  const okDenial = guardFn({
    name: 'shall_qq_tell',
    arguments: { chat_type: 'group', chat_id: '200', text: 'x' },
    agent: { session: { header: { id: 'g100' } } },
  })
  check('范围内的目标放行', okDenial === undefined, String(okDenial))
}

console.log('B. 群会话 → 主人私聊')
{
  deliveries.length = 0
  const out = await tool.execute({ chat_type: 'private', chat_id: OWNER, text: '我这边没事' }, as({ id: 'g100' }))
  check('投出去了', out.delivered === true, JSON.stringify(out))
  check('目标是主人私聊', deliveries[0]?.chatType === 'private' && deliveries[0]?.chatId === OWNER)
  check('正文带来源标注', deliveries[0]?.text.startsWith('（来自 群 100 的群会话）'), deliveries[0]?.text)
  check('正文保留了原话', deliveries[0]?.text.endsWith('我这边没事'), deliveries[0]?.text)
  check('渲染里带上私聊号', tool.output.render(null, out)[0].text.includes(`私聊 ${OWNER}`), tool.output.render(null, out)[0].text)
}

console.log('C. 群会话 → 别的群')
{
  deliveries.length = 0
  const out = await tool.execute({ chat_type: 'group', chat_id: '200', text: '你们那边咋样' }, as({ id: 'g100' }))
  check('投出去了', out.delivered === true, JSON.stringify(out))
  check('目标是群 200', deliveries[0]?.chatType === 'group' && deliveries[0]?.chatId === '200')
  check('来源标注是群 100', deliveries[0]?.text.startsWith('（来自 群 100 的群会话）'), deliveries[0]?.text)
}

console.log('D. 主人私聊 → 群')
{
  deliveries.length = 0
  const out = await tool.execute({ chat_type: 'group', chat_id: '100', text: '去群里看看' }, as({ id: 'p-owner' }))
  check('投出去了', out.delivered === true, JSON.stringify(out))
  check('来源标注是主人对接会话', deliveries[0]?.text.startsWith('（来自 主人对接会话）'), deliveries[0]?.text)
}

console.log('E. 群会话派出的子代理也有发送权限')
{
  deliveries.length = 0
  const out = await tool.execute({ chat_type: 'group', chat_id: '200', text: '子代理替你说话' }, as(headers['g100-kid']))
  check('子代理能发', out.delivered === true, JSON.stringify(out))
  check('来源按父会话算（群 100）', deliveries[0]?.text.startsWith('（来自 群 100 的群会话）'), deliveries[0]?.text)
}

console.log('F. 给自己所在的会话捎话：拒绝')
{
  deliveries.length = 0
  check('群里发给自己', await rejects(() => tool.execute({ chat_type: 'group', chat_id: '100', text: '自己对自己说' }, as({ id: 'g100' }))))
  check('私聊里发给自己', await rejects(() => tool.execute({ chat_type: 'private', chat_id: OWNER, text: '自己对自己说' }, as({ id: 'p-owner' }))))
  check('没有发生投递', deliveries.length === 0, JSON.stringify(deliveries))
}

console.log('G. 目标没有常驻会话：如实返回没投出去')
{
  noSession.add('group:200')
  deliveries.length = 0
  const out = await tool.execute({ chat_type: 'group', chat_id: '200', text: '喂' }, as({ id: 'g100' }))
  check('delivered 是 false', out.delivered === false, JSON.stringify(out))
  check('带回了原因', String(out.error).includes('常驻会话'), out.error)
  check('渲染说没捎过去', tool.output.render(null, out)[0].text.includes('没捎过去'), tool.output.render(null, out)[0].text)
  noSession.clear()
}

console.log('H. 投递失败时也一样如实返回')
{
  deliveries.length = 0
  tellResult = { ok: false, sessionId: 'x', error: 'session-retired: 已退役' }
  const out = await tool.execute({ chat_type: 'group', chat_id: '200', text: '喂' }, as({ id: 'g100' }))
  check('delivered 是 false', out.delivered === false, JSON.stringify(out))
  check('原因原样带回', String(out.error).includes('session-retired'), out.error)
  tellResult = { ok: true }
}

console.log('I. 必填参数')
{
  check('空正文直接抛错', await rejects(() => tool.execute({ chat_type: 'group', chat_id: '200', text: '  ' }, as({ id: 'g100' }))))
  check('缺 chat_id 直接抛错', await rejects(() => tool.execute({ chat_type: 'group', text: '喂' }, as({ id: 'g100' }))))
}

console.log('J. 不给 tell 依赖时不注册')
{
  const only = new Map()
  registerQqTools({
    ctx: {
      get: (n) =>
        n === 'tools'
          ? {
              register(def) {
                only.set(def.name, def)
                return () => {}
              },
              guard() {
                return () => {}
              },
            }
          : undefined,
    },
    config: resolveConfig({}),
    log: silent,
    send: async () => {},
    listChats: () => [],
    chatOfCaller,
  })
  check('没有 tell 就没有 shall_qq_tell', !only.has('shall_qq_tell'))
  check('别的工具照常注册', only.has('shall_qq_send'))
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

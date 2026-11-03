/**
 * `shall_qq_handoff` 的权限矩阵：谁能给谁交班。
 *
 * 规则（docs/CONTRACTS.md 第 6 节）：
 *   - 主人的私聊 / 主人自己的 DSH 会话 = 控制台，可以点名任何在范围内的会话；
 *   - 群会话、别人的私聊只能给自己所在的聊天交班（而且必须是主人的私聊）；
 *   - 目标必须在 qq.scope / 控制台群接入的范围内；
 *   - 不传 chat_id 时按调用方自己的聊天解析（门控不能把它当成缺参数拒掉）。
 *
 * 运行：node test/qq-handoff-tool.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qq-handoff-tool-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }
const OWNER = '3511618235'

const bindings = createBindings({ dir: tmp })
bindings.bind('private', OWNER, 'p-owner')
bindings.bind('group', '100', 'g100')
bindings.bind('private', '200', 'p200')
const headers = {
  'g100-kid': { id: 'g100-kid', parentSession: 'g100', origin: 'subagent' },
  'p-owner-kid': { id: 'p-owner-kid', parentSession: 'p-owner', origin: 'subagent' },
  desk: { id: 'desk', cwd: path.join(tmp, 'workspace') },
  lost: { id: 'lost', cwd: path.join(tmp, 'qq-group-100') },
}
const chatOfCaller = (header) => bindings.resolve(header, (id) => headers[id])

const calls = []
let monitorReply = { ok: true }
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
  config: resolveConfig({ scope: { groups: ['100'], friends: ['200'] } }),
  log: silent,
  send: async () => {},
  listChats: () => [],
  owner: { owner: () => OWNER, isOwner: (id) => String(id) === OWNER },
  chatOfCaller,
  handoff: () => ({
    forceHandoff(chatType, chatId) {
      calls.push(`${chatType}:${chatId}`)
      return monitorReply
    },
  }),
})

const tool = registered.get('shall_qq_handoff')
const as = (header) => ({ agent: { session: { header } } })

console.log('A. 主人私聊：控制台，可以点名别的会话')
{
  let out = await tool.execute({}, as({ id: 'p-owner' }))
  check('不传参数：给自己交班', out.ok && calls.at(-1) === `private:${OWNER}`, JSON.stringify(out))
  check('“这一轮说完”措辞', out.when.includes('这一轮'), out.when)

  out = await tool.execute({ chat_type: 'group', chat_id: '100' }, as({ id: 'p-owner' }))
  check('点名群会话', out.ok && calls.at(-1) === 'group:100', JSON.stringify(out))
  check('“下一次说完”措辞', out.when.includes('下一次'), out.when)
  check('渲染里带上群号', tool.output.render(null, out)[0].text.includes('群 100'), tool.output.render(null, out)[0].text)

  out = await tool.execute({ chat_type: 'private', chat_id: '200' }, as({ id: 'p-owner' }))
  check('点名别的私聊', out.ok && calls.at(-1) === 'private:200')

  const before = calls.length
  out = await tool.execute({ chat_type: 'group', chat_id: '999' }, as({ id: 'p-owner' }))
  check('范围外的群被拒', out.ok === false && String(out.error).includes('不在 QQ 通道'), JSON.stringify(out))
  check('被拒时没有登记', calls.length === before)
}

console.log('B. 群会话：不能跨会话')
{
  let out = await tool.execute({}, as({ id: 'g100' }))
  check('不传参数：不能给自己交班（群不是主人的私聊）', out.ok === false && String(out.error).includes('只有主人'), JSON.stringify(out))
  check('没登记', calls.length === 3)

  check('点名主人私聊被拒（只能作用于自己所在的群）', await rejects(() => tool.execute({ chat_type: 'private', chat_id: OWNER }, as({ id: 'g100' }))))
  check('点名别的群被拒', await rejects(() => tool.execute({ chat_type: 'group', chat_id: '999' }, as({ id: 'g100' }))))
}

console.log('C. 别人的私聊：同样不能跨会话')
{
  const out = await tool.execute({}, as({ id: 'p200' }))
  check('不能给自己交班', out.ok === false && String(out.error).includes('只有主人'))
  check('点名主人私聊被拒', await rejects(() => tool.execute({ chat_type: 'private', chat_id: OWNER }, as({ id: 'p200' }))))
}

console.log('D. 主人自己的 DSH 会话：也是控制台')
{
  let out = await tool.execute({ chat_type: 'group', chat_id: '100' }, as(headers.desk))
  check('可以点名群会话', out.ok && calls.at(-1) === 'group:100', JSON.stringify(out))
  check('不给目标时无法确定聊天', await rejects(() => tool.execute({}, as(headers.desk))))
}

console.log('E. 绑定丢了也不能冒充主人会话')
{
  const out = await tool.execute({ chat_type: 'private', chat_id: OWNER }, as(headers.lost))
  check('工作区是 qq-group-* 的会话被当成 QQ 会话', out.ok === false && String(out.error).includes('只有主人'), JSON.stringify(out))
  check('子代理同样不能跨会话', await rejects(() => tool.execute({ chat_type: 'private', chat_id: OWNER }, as({ id: 'g100-kid', parentSession: 'g100', origin: 'subagent' }))))
  const kid = await tool.execute({}, as({ id: 'p-owner-kid', parentSession: 'p-owner', origin: 'subagent' }))
  check('主人私聊的子代理按私聊身份处理（不传参数给自己交班可以）', kid.ok === true && calls.at(-1) === `private:${OWNER}`, JSON.stringify(kid))
}

console.log('F. 监视器拒绝时把理由原样带回来')
{
  monitorReply = { ok: false, error: '这个会话还没建常驻会话（先随便说句话让它起一台）' }
  const out = await tool.execute({ chat_type: 'group', chat_id: '100' }, as({ id: 'p-owner' }))
  check('ok=false', out.ok === false)
  check('理由原样返回', String(out.error).includes('还没建常驻会话'), JSON.stringify(out))
  monitorReply = { ok: true }
}

console.log('G. 门控：不传 chat_id 时按调用方自己的聊天校验')
{
  check('显式越界：拒绝', typeof guardFn({ name: 'shall_qq_handoff', arguments: { chat_type: 'group', chat_id: '999' }, ...as({ id: 'p-owner' }) }) === 'string')
  check('显式在范围内：放行', guardFn({ name: 'shall_qq_handoff', arguments: { chat_type: 'group', chat_id: '100' }, ...as({ id: 'p-owner' }) }) === undefined)
  check('不传参数、主人私聊：放行', guardFn({ name: 'shall_qq_handoff', arguments: {}, ...as({ id: 'p-owner' }) }) === undefined)
  check('不传参数、群会话：放行（本群在范围内）', guardFn({ name: 'shall_qq_handoff', arguments: {}, ...as({ id: 'g100' }) }) === undefined)
  check('不传参数、没有会话头：拒绝', typeof guardFn({ name: 'shall_qq_handoff', arguments: {} }) === 'string')
  check('不传参数、没有会话头的主人会话：拒绝（判不了自己）', typeof guardFn({ name: 'shall_qq_handoff', arguments: {}, agent: { session: {} } }) === 'string')
  check('无关工具不拦', guardFn({ name: 'read', arguments: {} }) === undefined)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

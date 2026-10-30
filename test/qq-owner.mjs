/**
 * 主人身份绑定与新的准入规则（docs/CONTRACTS.md 4.8，PLAN 第 47 条、改进点 5，用户定的“群聊默认不接”）。
 * 运行：node test/qq-owner.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOwner } from '../lib/qq/owner.js'
import { inScope, resolveConfig } from '../lib/qq/config.js'
import { Pipeline, INTENT } from '../lib/qq/pipeline.js'
import { createConsoleApi } from '../lib/ui/console-api.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-owner-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }
let clock = 1_800_000_000_000
const now = () => clock

console.log('A. 配对码')
{
  const owner = createOwner({ dir: path.join(tmp, 'a'), now })
  check('一开始没配对', owner.owner() === null && owner.info().paired === false)
  check('没发过码时不认任何 6 位数字', owner.looksLikeCode('123456') === false)
  const { code } = owner.issueCode()
  check('码是 6 位数字', /^\d{6}$/.test(code))
  check('发过码后认得出 6 位数字', owner.looksLikeCode(` ${code} `) && !owner.looksLikeCode('12345') && !owner.looksLikeCode(`${code}x`))
  const wrong = code === '000000' ? '111111' : '000000'
  check('错码不配对', owner.tryPair('10001', wrong).reason === 'wrong' && owner.owner() === null)
  check('对的码配对成功', owner.tryPair('10001', code).ok && owner.owner() === '10001' && owner.isOwner('10001'))
  check('码只能用一次', owner.tryPair('10002', code).reason === 'no-code' && owner.owner() === '10001')
  const again = createOwner({ dir: path.join(tmp, 'a'), now })
  check('落盘后重载还认得主人', again.owner() === '10001')
  again.reset()
  check('解除配对', again.owner() === null && createOwner({ dir: path.join(tmp, 'a'), now }).owner() === null)
}
{
  const owner = createOwner({ dir: path.join(tmp, 'b'), now })
  const { code } = owner.issueCode()
  clock += 11 * 60 * 1000
  check('10 分钟后过期', owner.tryPair('10001', code).reason === 'expired' && owner.owner() === null)
  const second = owner.issueCode().code
  for (let i = 0; i < 5; i += 1) owner.tryPair('10001', second === '999999' ? '888888' : '999999')
  check('错 5 次后码作废', owner.tryPair('10001', second).reason === 'no-code')
}

console.log('B. 准入（默认一个都不接）')
{
  const owner = createOwner({ dir: path.join(tmp, 'c'), now })
  const empty = resolveConfig({})
  check('默认配置：群一个都不接', inScope(empty, 'group', '123') === false)
  check('默认配置：没配对时私聊一个都不接', inScope(empty, 'private', '10001', owner) === false)
  const code = owner.issueCode().code
  owner.tryPair('10001', code)
  check('配对之后主人的私聊放行', inScope(empty, 'private', '10001', owner) === true)
  check('别人的私聊仍然不接', inScope(empty, 'private', '20002', owner) === false)
  const listed = resolveConfig({ scope: { groups: ['123'], friends: ['20002'], blockedFriends: ['10001'] } })
  check('列出的群接、没列出的群不接', inScope(listed, 'group', '123') && !inScope(listed, 'group', '456'))
  check('列出的私聊接', inScope(listed, 'private', '20002', owner))
  check('黑名单优先于主人', inScope(listed, 'private', '10001', owner) === false)
  const all = resolveConfig({ scope: { groups: ['*'], friends: ['*'], blockedGroups: ['9'] } })
  check("写 '*' 就全部接，黑名单仍然生效", inScope(all, 'group', '456') && inScope(all, 'private', '30003') && !inScope(all, 'group', '9'))
}

console.log('C. 消息处理认出配对码')
{
  const owner = createOwner({ dir: path.join(tmp, 'd'), now })
  const pipeline = new Pipeline({ config: resolveConfig({}), log: silent, owner })
  const event = (type, text, id = '10001') => ({
    post_type: 'message', message_type: type, self_id: 1, user_id: Number(id), group_id: type === 'group' ? 555 : undefined,
    message_id: Math.floor(Math.random() * 1e9), time: Math.floor(clock / 1000),
    message: [{ type: 'text', data: { text } }], sender: { nickname: '主人' },
  })
  check('没配对时陌生私聊被挡在范围外', pipeline.handle(event('private', '在吗'), { selfId: '1' })?.intent === INTENT.IGNORE)
  const code = owner.issueCode().code
  const inGroup = pipeline.handle(event('group', code), { selfId: '1' })
  check('群里发配对码无效', inGroup?.intent !== INTENT.PAIR && owner.owner() === null)
  const paired = pipeline.handle(event('private', code), { selfId: '1' })
  check('私聊发配对码：返回 PAIR 并完成配对', paired?.intent === INTENT.PAIR && paired.pairing.ok && owner.owner() === '10001')
  check('配对后主人的私聊正常进来', pipeline.handle(event('private', '在吗'), { selfId: '1' })?.intent === INTENT.CHAT)
}

console.log('D. 控制台接口')
{
  const owner = createOwner({ dir: path.join(tmp, 'e'), now })
  const api = createConsoleApi({ service: {}, policy: {}, scanner: {}, personas: {}, skills: {}, workbench: {}, jobs: {}, config: {}, owner })
  const call = (method, p) => api.handle({ method, path: p, query: new URLSearchParams(), body: {} })
  check('GET /qq/owner 报出没配对', (await call('GET', '/qq/owner')).json.paired === false)
  const issued = await call('POST', '/qq/owner/code')
  check('POST /qq/owner/code 发一个码', /^\d{6}$/.test(issued.json.code) && (await call('GET', '/qq/owner')).json.codePending === true)
  owner.tryPair('10001', issued.json.code)
  check('配对后 GET 报出主人', (await call('GET', '/qq/owner')).json.qq === '10001')
  check('DELETE /qq/owner 解除配对', (await call('DELETE', '/qq/owner')).json.paired === false)
  const none = createConsoleApi({ service: {}, policy: {}, scanner: {}, personas: {}, skills: {}, workbench: {}, jobs: {}, config: {} })
  check('没有 QQ 通道时返回 503', (await none.handle({ method: 'GET', path: '/qq/owner', query: new URLSearchParams(), body: {} })).status === 503)
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

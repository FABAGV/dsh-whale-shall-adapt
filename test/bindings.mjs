/**
 * 会话绑定表（lib/conversation/bindings.js）以及权限分类先查它（docs/CONTRACTS.md 第 5 节）。
 * 运行：node test/bindings.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBindings } from '../lib/conversation/bindings.js'
import { StateStore } from '../lib/conversation/state.js'
import { PrivacyPolicy, classifySession } from '../lib/privacy/policy.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-bindings-'))
const silent = { info() {}, warn() {}, error() {}, debug() {} }

console.log('A. 绑定表')
{
  const b = createBindings({ dir: path.join(tmp, 'a') })
  const changed = []
  b.onChange((id) => changed.push(id))
  b.bind('group', '123', 's1')
  check('登记后能查到聊天', b.chatOf('s1')?.chatKey === 'group:123' && b.chatOf('s1').current === true)
  b.bind('group', '123', 's2', { generation: 2 })
  check('交班换新会话：旧的转为退役但仍认得', b.chatOf('s1')?.current === false && b.chatOf('s1').retiredAt > 0 && b.chatOf('s2')?.generation === 2)
  check('换代时新旧两台都发了变化通知', changed.includes('s1') && changed.includes('s2'))
  b.retireCurrent('group', '123')
  check('建会话失败时当前那台转为退役', b.chatOf('s2')?.current === false)
  check('没登记的会话返回 null', b.chatOf('nope') === null)
  check('参数不对不登记', b.bind('channel', '1', 'x') === null && b.bind('group', '', 'x') === null && b.bind('group', '1', '') === null)
  const again = createBindings({ dir: path.join(tmp, 'a') })
  check('落盘后重载还在', again.chatOf('s1')?.chatKey === 'group:123' && again.list().length === 2)
  fs.writeFileSync(path.join(tmp, 'a', 'bindings.json'), '{坏了', 'utf8')
  check('文件坏了按空表开始，不抛', createBindings({ dir: path.join(tmp, 'a'), log: silent }).list().length === 0)
}

console.log('B. 子代理沿父链')
{
  const b = createBindings({ dir: path.join(tmp, 'b') })
  b.bind('private', '42', 'root')
  const headers = { child: { id: 'child', parentSession: 'root' }, grandchild: { id: 'grandchild', parentSession: 'child' } }
  const lookup = (id) => headers[id]
  check('子代理找到父会话的聊天，标 viaParent', b.resolve(headers.child, lookup)?.viaParent === true)
  check('孙代理也找得到', b.resolve(headers.grandchild, lookup)?.chatKey === 'private:42')
  check('父链断了返回 null', b.resolve({ id: 'x', parentSession: 'missing' }, () => undefined) === null)
  check('父链成环不死循环', b.resolve({ id: 'a', parentSession: 'b' }, (id) => ({ id, parentSession: id === 'b' ? 'a' : 'b' })) === null)
}

console.log('C. 从旧状态补登记')
{
  const b = createBindings({ dir: path.join(tmp, 'c') })
  const n = b.seed([
    { chatType: 'group', chatId: '7', rootSessionId: 'g7-now', rootGeneration: 3, handoffHistory: [{ from: 'g7-old2', to: 'g7-now' }, { from: 'g7-old1', to: 'g7-old2' }] },
    { chatType: 'private', chatId: '9', rootSessionId: '' },
  ])
  check('当前会话和交班历史里的旧会话都补上了', n === 3 && b.chatOf('g7-now')?.current && b.chatOf('g7-old1')?.current === false)
  check('重复补登记不重复加', b.seed([{ chatType: 'group', chatId: '7', rootSessionId: 'g7-now' }]) === 0)
}

console.log('D. QQ 状态换会话时自动登记')
{
  const b = createBindings({ dir: path.join(tmp, 'd') })
  const state = new StateStore({ dir: path.join(tmp, 'd'), log: silent, bindings: b })
  state.set('group', '55', { chatType: 'group', chatId: '55', rootGeneration: 1 })
  state.setRootSession('group', '55', 'q1')
  check('setRootSession 登记', b.chatOf('q1')?.chatKey === 'group:55')
  state.recordHandoff('group', '55', { gen: 2, from: 'q1', to: 'q2' })
  state.setRootSession('group', '55', 'q2')
  check('交班后新会话是当前、代数更新，旧会话退役', b.chatOf('q2')?.current && b.chatOf('q2').generation === 2 && b.chatOf('q1').current === false)
  state.setRootSession('group', '55', '')
  check('清空绑定时当前会话退役', b.chatOf('q2')?.current === false)
}

console.log('E. 权限分类先查绑定表')
{
  const b = createBindings({ dir: path.join(tmp, 'e') })
  b.bind('group', '88', 'renamed')
  const header = { id: 'renamed', cwd: 'D:\\work\\改过名的目录' }
  check('目录被改名也认成 QQ 群', classifySession(header, undefined, b).kind === 'qq-group')
  check('没有绑定表时退回只看目录名（认成你自己的会话）', classifySession(header).kind === 'owner')
  check('目录名 qq-private-<号> 仍然能兜底', classifySession({ id: 'z', cwd: 'D:\\qq\\qq-private-1001' }, undefined, b).kind === 'qq-private')
  const child = classifySession({ id: 'kid', parentSession: 'renamed', origin: 'subagent' }, (id) => (id === 'renamed' ? header : undefined), b)
  check('QQ 会话派出的子代理按子代理分类，父类别是 QQ 群', child.kind === 'subagent' && child.parentKind === 'qq-group' && child.chatKey === 'group:88')

  const policy = new PrivacyPolicy({ dir: path.join(tmp, 'e-policy'), config: {}, log: silent })
  policy.setBindings(b)
  check('policy：绑定的会话拿 QQ 群的规则（不学习）', policy.ruleFor({ id: 'renamed', cwd: header.cwd }).kind === 'qq-group' && policy.canLearn({ id: 'renamed', cwd: header.cwd }) === false)
  const loose = { id: 'later', cwd: 'D:\\work\\普通目录' }
  check('policy：还没绑定时是你自己的会话', policy.ruleFor(loose).kind === 'owner')
  b.bind('private', '77', 'later')
  check('绑定一变规则缓存就清掉，下一次读到新分类', policy.ruleFor(loose).kind === 'qq-private')
  policy.ruleFor({ id: 'dir-only', cwd: 'D:\\qq\\qq-group-66' })
  check('只靠目录名认出来的 QQ 会话记一条审计', policy.recentAudit(10).some((a) => a.type === 'classify-by-dirname' && a.sessionId === 'dir-only'))
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

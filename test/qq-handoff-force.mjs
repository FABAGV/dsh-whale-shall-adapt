/**
 * 主动交班（ConversationHandoff.forceHandoff）：只登记意图，不是当场换。
 *
 * 覆盖三件事：
 *   - 没绑常驻会话的聊天不能登记（否则 turn/end 拿不到 sessionId）；
 *   - 正常会话登记成功，`isForced` 立即为真；
 *   - 正在交班（frozen）的会话拒绝登记，不让两次交班撞在一起。
 *
 * 运行：node test/qq-handoff-force.mjs
 */
import { ConversationHandoff } from '../lib/conversation/handoff.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const silent = { info() {}, debug() {}, warn() {}, error() {} }

/** 造一个监视器；state 里只认 private/3511618235 这台 */
function makeMonitor({ bound = true } = {}) {
  const chat = { kind: 'root', chatType: 'private', chatId: '3511618235', chatName: '测试' }
  return new ConversationHandoff({
    ctx: { get: () => undefined },
    config: { conversation: { handoffAtRatio: 0.25, minTokensBetweenHandoffs: 0, handoffInputChars: 120000 } },
    log: silent,
    bridge: { chatForSession: (id) => (id === 'session-1' ? chat : null) },
    state: {
      dir: process.cwd(),
      get: (type, id) =>
        bound && String(type) === 'private' && String(id) === '3511618235'
          ? { rootSessionId: 'session-1', rootGeneration: 3 }
          : null,
    },
    memory: { forScope: () => [] },
    relay: { approvalsFor: () => [] },
    gate: {},
    resolver: {},
    notify: async () => {},
  })
}

console.log('A. 没绑常驻会话')
{
  const h = makeMonitor({ bound: false })
  const out = h.forceHandoff('private', '3511618235')
  check('拒绝登记', out.ok === false, JSON.stringify(out))
  check('理由是还没建会话', String(out.error ?? '').includes('还没建常驻会话'))
  check('没有留下意图', h.isForced('private', '3511618235') === false)
}

console.log('B. 正常登记')
{
  const h = makeMonitor()
  const out = h.forceHandoff('private', '3511618235')
  check('登记成功', out.ok === true, JSON.stringify(out))
  check('意图已记下', h.isForced('private', '3511618235') === true)
  check('别的会话没被连累', h.isForced('private', '999999') === false)

  const again = h.forceHandoff('private', '3511618235')
  check('重复登记不报错（Set，幂等）', again.ok === true && h.isForced('private', '3511618235') === true)
}

console.log('C. 正在交班时拒绝')
{
  const h = makeMonitor()
  h.frozen.set('private:3511618235', { at: Date.now(), gen: 3 })
  const out = h.forceHandoff('private', '3511618235')
  check('拒绝登记', out.ok === false, JSON.stringify(out))
  check('理由是正在交班', String(out.error ?? '').includes('正在交班'))
  check('没有留下意图', h.isForced('private', '3511618235') === false)
}

console.log('D. 参数不全')
{
  const h = makeMonitor()
  check('缺 chatId 拒绝', h.forceHandoff('private', '')?.ok === false)
  check('缺 chatType 拒绝', h.forceHandoff('', '3511618235')?.ok === false)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

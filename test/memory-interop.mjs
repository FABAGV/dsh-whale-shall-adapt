/**
 * 记忆互通：读全开开关 + shared 碎片的直接生效。运行：node test/memory-interop.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import { ChatMemory } from '../lib/conversation/chat-memory.js'
import { readInterop, writeInterop } from '../lib/memory/interop.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-interop-'))
const log = { info: () => {}, warn: () => {} }

console.log('A. 开关文件')
{
  const dir = tmp()
  check('默认关', readInterop(dir).readAll === false)
  check('打开', writeInterop(dir, { readAll: true }).readAll === true && readInterop(dir).readAll === true)
  check('关掉', writeInterop(dir, { readAll: false }).readAll === false)
  check('文件在 memory 目录', fs.existsSync(path.join(dir, 'interop.json')))
  check('非法值当关', writeInterop(dir, { readAll: 'yes' }).readAll === false)
}

console.log('B. shared 碎片直接生效')
{
  const dir = tmp()
  const mem = createMemory({ dir, store: 'sqlite', log })
  const chat = new ChatMemory({ store: mem, log })
  const out = chat.absorb({
    scope: 'group:100000001',
    fragments: [
      { text: 'cloudflare 改 NS 一般要等一天才全生效', kind: 'fact', tag: 1, shared: true, area: 'domain:DNS' },
      { text: '这个群的人喜欢聊搬瓦工', kind: 'fact', tag: 1 },
    ],
  })
  check('两条都写进去了', out.added === 2, JSON.stringify(out))
  const shared = mem.list({ scope: 'shared' })
  check('shared 那条落进 shared 范围', shared.length === 1 && shared[0].area === 'domain:DNS')
  check('shared 直接 active（不是候选）', shared[0].status === 'active', shared[0]?.status)
  const own = mem.list({ scope: 'chat:group:100000001' })
  check('普通碎片还是本群范围', own.length === 1 && own[0].text.includes('搬瓦工'))
  mem.dispose()
}

console.log('C. 读全开')
{
  const dir = tmp()
  const mem = createMemory({ dir, store: 'sqlite', log })
  const chat = new ChatMemory({ store: mem, log })
  mem.observe({ scope: 'chat:group:111111', kind: 'fact', text: '另一个群在讨论显卡矿机', actor: 'qq:idle' })
  mem.observe({ scope: 'owner', kind: 'trait', text: '主人喜欢极简', actor: 'dsh:profile' })
  mem.flush()

  const before = chat.recallFor('group:100000001', '矿机')
  check('关着：别的群查不到', before.length === 0, JSON.stringify(before.map((x) => x.id)))

  writeInterop(dir, { readAll: true })
  const after = chat.recallFor('group:100000001', '矿机')
  check('开着：群会话能翻到别的群', after.length >= 1 && after[0].scope === 'chat:group:111111')
  const ownerHit = chat.recallFor('group:100000001', '极简')
  check('开着：群会话也能翻到主人那几片', ownerHit.some((e) => e.scope === 'owner'), JSON.stringify(ownerHit.map((e) => e.scope)))

  const ownerSide = chat.recallOwner('矿机')
  check('开着：主人侧会话同样能翻全部', ownerSide.some((e) => e.scope === 'chat:group:111111'))

  writeInterop(dir, { readAll: false })
  check('关回去：又只有本群', chat.recallFor('group:100000001', '矿机').length === 0)
  const ownerBack = chat.recallOwner('矿机')
  check('关回去：主人侧只剩默认范围', ownerBack.length === 0, JSON.stringify(ownerBack.map((e) => e.scope)))
  mem.dispose()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

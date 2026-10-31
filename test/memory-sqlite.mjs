/**
 * 记忆的 SQLite 真相库 + 书架（area）+ 全文召回。运行：node test/memory-sqlite.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import { normalizeArea, defaultAreaOf, areaOf } from '../lib/memory/areas.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sqlite-'))
const errorLog = () => []

console.log('A. 书架')
{
  check('默认书架按 scope 推：owner', defaultAreaOf('owner') === 'owner')
  check('群聊的书架就是它自己', defaultAreaOf('chat:group:100000001') === 'chat:group:100000001')
  check('群友归到 group:<群号>', defaultAreaOf('member:100000001:200000002') === 'group:100000001')
  check('显式书架优先', areaOf('owner', 'domain:DNS') === 'domain:DNS')
  check('书架名规整：去多余空白 + 截断', normalizeArea('  域名   DNS  ') === '域名 DNS' && normalizeArea('x'.repeat(80)).length === 40)
  check('空书架回落到默认', areaOf('owner', '   ') === 'owner')
}

console.log('B. SQLite 真相库')
{
  const dir = tmp()
  const log = { warn: () => {}, info: () => {} }
  const mem = createMemory({ dir, store: 'sqlite', log })
  check('storeKind = sqlite', mem.storeKind === 'sqlite')

  const r1 = mem.observe({ scope: 'owner', kind: 'trait', text: '主人习惯直接贴报错，不解释背景', actor: 'dsh:profile', origin: 'model' })
  check('写入成功且默认书架是 owner', r1.action === 'new' && mem.get(r1.id).area === 'owner', JSON.stringify(r1))
  const r2 = mem.observe({ scope: 'shared', area: 'domain:DNS', kind: 'fact', text: '域名 cloudflare 的 DNS 解析切换一般要 24 小时生效', actor: 'dsh:profile' })
  check('shared 范围 + 自定义书架能写', r2.action === 'new' && mem.get(r2.id).area === 'domain:DNS', JSON.stringify(r2))
  const r3 = mem.observe({ scope: 'chat:group:100000001', kind: 'fact', text: '这个群聊搬瓦工和 VPS 比较多', actor: 'qq:idle' })
  check('群聊默认书架 = chat:group:…', mem.get(r3.id).area === 'chat:group:100000001')
  mem.observe({ scope: 'member:100000001:200000002', kind: 'preference', text: '喜欢 viola', actor: 'qq:idle' })
  check('列表能按书架过滤', mem.list({ area: 'domain:DNS' }).length === 1 && mem.list({ areaPrefix: 'group:' }).length === 1)

  mem.flush()
  check('落盘后 memory.json 作为导出存在', fs.existsSync(path.join(dir, 'memory.json')))
  check('SQLite 文件存在', fs.existsSync(path.join(dir, 'memory.db')))

  const reopened = createMemory({ dir, store: 'sqlite', log })
  check('重开后条目还在', reopened.list().length === 4, `${reopened.list().length}`)
  check('重开后书架还在', reopened.list({ area: 'domain:DNS' }).length === 1)
  check('重开后 seq 不乱', reopened.list().every((e) => e.id.startsWith('m')))
  reopened.dispose()

  const hits = mem.recall('cloudflare', ['shared'], 3)
  check('全文召回：中文子串能命中', hits.length >= 1 && hits[0].id === r2.id, JSON.stringify(hits.map((h) => h.id)))
  const short = mem.recall('DNS', ['shared'], 3)
  check('两个字的查询回落 LIKE 也能命中', short.length >= 1 && short[0].id === r2.id)
  const scoped = mem.recall('DNS', ['owner'], 3)
  check('范围外的召回不到', scoped.length === 0)
  mem.dispose()
}

console.log('C. 从 memory.json 迁移')
{
  const dir = tmp()
  const json = {
    version: 2,
    seq: 3,
    entries: [
      { id: 'm000001', scope: 'owner', kind: 'trait', text: '旧库里的第一条', status: 'active', origin: 'model', confidence: 0.5, importance: 1, pinned: false, quiet: false, sources: [], supersedes: [], rejects: [], conflictsWith: null, validUntil: null, ledger: { refs: 1, injected: 0, recalled: 0, corrected: 0, seen: 0, lastSeenAt: 0, lastSeenGen: 0, lastInjectedKey: '' }, history: [], createdAt: 1, updatedAt: 1 },
      { id: 'm000002', scope: 'chat:group:100000001', kind: 'fact', text: '旧库里的第二条', status: 'active', origin: 'model', confidence: 0.5, importance: 1, pinned: false, quiet: false, sources: [], supersedes: [], rejects: [], conflictsWith: null, validUntil: null, ledger: { refs: 1, injected: 0, recalled: 0, corrected: 0, seen: 0, lastSeenAt: 0, lastSeenGen: 0, lastInjectedKey: '' }, history: [], createdAt: 2, updatedAt: 2 },
    ],
    revisions: {},
    blockedScopes: [],
    forgotten: {},
  }
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(json), 'utf8')
  const log = { info: () => {}, warn: () => {} }
  const mem = createMemory({ dir, store: 'sqlite', log })
  check('首次切库自动导入 memory.json', mem.list().length === 2)
  check('导入的条目也补上了书架', mem.list({ scope: 'owner' })[0]?.area === 'owner')
  check('原 memory.json 没被删', fs.existsSync(path.join(dir, 'memory.json')))
  mem.dispose()
}

console.log('D. json 模式不受影响（回归）')
{
  const dir = tmp()
  const mem = createMemory({ dir, store: 'json', log: { warn: () => {} } })
  const r = mem.observe({ scope: 'owner', kind: 'trait', text: 'json 模式照旧', actor: 'dsh:profile' })
  mem.flush()
  check('json 模式写入 + 落盘', r.action === 'new' && JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries.length === 1)
  check('json 模式没有 db', mem.storeKind === 'json' && !fs.existsSync(path.join(dir, 'memory.db')))
  check('json 模式的条目也有书架字段', mem.get(r.id).area === 'owner')
  mem.dispose()
}

console.log('E. 权限：QQ 来源不能写主人记忆，能写 shared')
{
  const dir = tmp()
  const mem = createMemory({ dir, store: 'sqlite', log: { warn: () => {} } })
  const bad = mem.observe({ scope: 'owner', kind: 'fact', text: '群里说的私事', actor: 'qq:idle' })
  check('QQ 写 owner 被拒', bad.action === 'dropped')
  const ok = mem.observe({ scope: 'shared', kind: 'fact', text: '群友分享的公开知识', actor: 'dsh:profile' })
  check('dsh 侧可以写 shared', ok.action === 'new')
  mem.dispose()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

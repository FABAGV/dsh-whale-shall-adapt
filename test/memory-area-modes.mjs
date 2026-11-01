/**
 * 书架注入方式（lib/memory/area-modes.js + MemoryStore.select/render）。
 *
 * 三档：full 完全注入（默认）/ index 只注入「书架 + 条数」/ off 不注入。
 * 运行：node test/memory-area-modes.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import { areaModesFile, readAreaModes, writeAreaModes } from '../lib/memory/area-modes.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-area-modes-'))
const log = { info() {}, warn: (m) => warns.push(String(m)), debug() {}, error() {} }
const warns = []

console.log('A. 存储')
{
  const dir = path.join(tmp, 'store')
  check('没有文件时全是默认（空表）', Object.keys(readAreaModes(dir, { log })).length === 0)
  writeAreaModes(dir, { 'domain:DNS': 'index', 空书架: 'off', 默认的: 'full', 坏的: 'whatever' })
  const back = readAreaModes(dir, { log })
  check('写进去的下次读得到', back['domain:DNS'] === 'index' && back['空书架'] === 'off')
  check('full 是默认值，不落盘', !('默认的' in back))
  check('非法值被丢掉', !('坏的' in back))
  const raw = JSON.parse(fs.readFileSync(areaModesFile(dir), 'utf8'))
  check('文件形状', raw.version === 1 && raw.modes['domain:DNS'] === 'index')

  fs.writeFileSync(areaModesFile(dir), '{坏掉的', 'utf8')
  const recovered = readAreaModes(dir, { log })
  check('坏文件：留档并当作全默认', Object.keys(recovered).length === 0)
  check('坏文件留了 .corrupt-*', fs.readdirSync(dir).some((f) => f.includes('.corrupt-')))
  check('留档时打了 warn', warns.some((w) => w.includes('area-modes.json')))
}

console.log('B. MemoryStore.areas()')
const dir = path.join(tmp, 'mem')
const mem = createMemory({ dir, log })
mem.observe({ scope: 'shared', area: 'domain:DNS', kind: 'fact', text: '内网 DNS 是 10.0.0.2', actor: 'user' })
mem.observe({ scope: 'shared', area: 'domain:DNS', kind: 'note', text: '改 NS 要等一天', actor: 'user' })
mem.observe({ scope: 'chat:group:1', area: 'group:1', kind: 'slang', text: '他们管加班叫搬砖', actor: 'qq:handoff' })
mem.observe({ scope: 'owner', area: 'owner', kind: 'trait', text: '不喜欢反复确认', actor: 'user' })
{
  const list = mem.areas()
  const dns = list.find((a) => a.area === 'domain:DNS')
  check('列出现在有记忆的书架', list.length >= 3 && Boolean(dns), list.map((a) => a.area).join(','))
  check('条数与范围对', dns.total === 2 && dns.scopes.join() === 'shared')
  check('默认模式是 full', dns.mode === 'full')
  check('按条数降序', list[0].total >= list.at(-1).total)
}

console.log('C. 三档注入')
{
  const all = () => mem.select(['shared', 'chat:group:1', 'owner'], 500)
  check('全开时两条 DNS 都在注入里', all().picked.filter((e) => e.area === 'domain:DNS').length === 2)

  const out = mem.setAreaMode('domain:DNS', 'index')
  check('设成 index 成功', out.ok === true && out.mode === 'index')
  const sel = all()
  check('index：正文不再进注入', !sel.picked.some((e) => e.area === 'domain:DNS'), sel.picked.map((e) => e.text).join('|'))
  check('index：只汇总一行（书架名 + 条数）', sel.index.length === 1 && sel.index[0].area === 'domain:DNS' && sel.index[0].count === 2)
  const text = mem.render(sel)
  check('渲染里有书架目录行', text.includes('书架「domain:DNS」2 条') && text.includes('shall_memory_recall'))
  check('别的书架照常注入', text.includes('搬砖') && text.includes('反复确认'))
  check('改了模式缓存键跟着变', sel.key.includes('domain:DNS:2'))

  mem.setAreaMode('group:1', 'off')
  const off = all()
  check('off：正文和目录都没有它', !off.picked.some((e) => e.area === 'group:1') && !off.index.some((s) => s.area === 'group:1'))
  check('off：但它仍在库里、仍能被检索', mem.list({ area: 'group:1' }).length === 1 && mem.recall('搬砖', ['chat:group:1'], 5).length === 1)

  mem.setAreaMode('domain:DNS', 'full')
  check('改回 full：正文回来了', all().picked.some((e) => e.area === 'domain:DNS') && all().index.length === 0)

  check('非法模式被拒', mem.setAreaMode('domain:DNS', 'half').ok === false)
  check('空书架名被拒', mem.setAreaMode('  ', 'index').ok === false)
}

console.log('D. 落盘与重开')
{
  mem.setAreaMode('owner', 'index')
  mem.flush()
  const reopened = createMemory({ dir, log })
  check('重开之后设置还在', reopened.areaMode('owner') === 'index')
  const sel = reopened.select(['owner'], 500)
  check('重开之后注入行为一致', sel.index.some((s) => s.area === 'owner'))
  reopened.dispose()
}

console.log('E. 只有目录时也注入')
{
  const only = createMemory({ dir: path.join(tmp, 'only'), log })
  only.observe({ scope: 'shared', area: '大书架', kind: 'fact', text: '一条很长的知识'.repeat(10), actor: 'user' })
  only.setAreaMode('大书架', 'index')
  const text = only.render(only.select(['shared'], 500))
  check('正文为空但目录仍在：文本非空', text.includes('书架「大书架」1 条'))
  only.setAreaMode('大书架', 'off')
  check('全 off 且没有选中：渲染空串', only.render(only.select(['shared'], 500)) === '')
  only.dispose()
}

mem.dispose()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

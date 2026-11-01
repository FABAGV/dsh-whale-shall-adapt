/**
 * 手写记忆种子（lib/adapt/memory-seeds.js）：幂等、坏 JSON 不抛、kind 回退。
 * 纯本地临时目录，不碰真实 ~/.dsh。运行：node test/memory-seeds.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMemorySeeds } from '../lib/adapt/memory-seeds.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-seeds-'))
const warns = []
const log = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(String(m)) }
const memory = createMemory({ dir: path.join(tmp, 'memory'), log })
const seedsFile = path.join(tmp, 'memory', 'seeds.json')

console.log('A. 没有文件')
{
  const out = applyMemorySeeds(memory, { log })
  check('文件不存在：安静跳过', out.applied === 0 && out.skipped === 0 && warns.length === 0)
}

console.log('B. 正常写入 + 幂等')
{
  fs.mkdirSync(path.dirname(seedsFile), { recursive: true })
  fs.writeFileSync(seedsFile, JSON.stringify({
    entries: [
      { scope: 'shared', area: 'domain:DNS', kind: 'note', text: '内网 DNS 是 10.0.0.2' },
      { scope: 'owner:work', kind: 'preference', text: '提交信息用中文' },
    ],
  }, null, 2), 'utf8')
  const first = applyMemorySeeds(memory, { log })
  check('第一次：写了 2 条', first.applied === 2 && first.skipped === 0, JSON.stringify(first))
  const shared = memory.list({ scope: 'shared' })
  check('shared 里有那条（正文已脱敏）', shared.some((e) => e.text.includes('内网 DNS 是')))
  check('来源记成用户本人', shared.find((e) => e.text.includes('DNS'))?.origin === 'user')
  check('area 落到对应书架', shared.find((e) => e.text.includes('DNS'))?.area === 'domain:DNS')

  const second = applyMemorySeeds(memory, { log })
  check('第二次（重启）：一条都不重复写', second.applied === 0 && second.skipped === 2, JSON.stringify(second))
  check('记忆总数没变', memory.list({ scope: 'shared' }).length === shared.length)
  check('带会被脱敏的内容也只写一次', memory.list({ scope: 'shared' }).filter((e) => e.text.includes('DNS')).length === 1)
}

console.log('C. 坏数据不炸')
{
  fs.writeFileSync(seedsFile, '{ 坏掉的 JSON', 'utf8')
  const out = applyMemorySeeds(memory, { log })
  check('坏 JSON：不抛、返回 0', out.applied === 0 && out.skipped === 0)
  check('记了一条 warn', warns.some((w) => w.includes('seeds.json')))

  fs.writeFileSync(seedsFile, JSON.stringify({
    entries: [
      { text: '   ' },                          // 空正文：跳过
      { scope: 'shared', text: '没有 kind 的条目' }, // kind 回退 note
      { scope: '不存在的范围', text: '非法 scope' }, // observe 拒掉
    ],
  }), 'utf8')
  const mixed = applyMemorySeeds(memory, { log })
  check('空正文 + 非法 scope 被跳过，只写 1 条', mixed.applied === 1 && mixed.skipped === 2, JSON.stringify(mixed))
  const fallback = memory.list({ scope: 'shared' }).find((e) => e.text === '没有 kind 的条目')
  check('kind 回退成 note', fallback?.kind === 'note', fallback?.kind)
  check('非法 scope 一条都没写进去', !memory.list({}).some((e) => e.text === '非法 scope'))
}

memory.dispose()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

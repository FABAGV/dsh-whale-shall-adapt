/**
 * 落盘基本功（lib/core/fs-atomic.js）：原子写、坏文件留档。
 * 纯本地临时目录，不碰真实 ~/.dsh。运行：node test/fs-atomic.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isPlainObject,
  loadJsonOrQuarantine,
  quarantineFile,
  readJsonFile,
  tempNameFor,
  writeFileAtomic,
  writeJsonAtomic,
} from '../lib/core/fs-atomic.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-fs-atomic-'))
const warns = []
const log = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(m) }
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

console.log('A. 原子写')
{
  const file = path.join(tmp, 'a', 'state.json')
  writeJsonAtomic(file, { hello: '世界', n: 1 })
  check('父目录不存在也会建', fs.existsSync(file))
  check('内容正确、带缩进', fs.readFileSync(file, 'utf8').includes('\n  "n": 1'))
  check('临时文件不残留', leftovers(path.dirname(file)).length === 0)
  writeFileAtomic(file, 'plain')
  check('覆盖写', fs.readFileSync(file, 'utf8') === 'plain')

  const name = tempNameFor(file)
  check('临时文件名带 pid 和随机串', name.includes(`.${process.pid}.`) && /\.(tmp)$/.test(name) && name !== tempNameFor(file))
}

console.log('B. backup 轮换')
{
  const file = path.join(tmp, 'b.json')
  writeJsonAtomic(file, { v: 1 })
  writeJsonAtomic(file, { v: 2 }, { backup: `${file}.bak` })
  check('新内容就位', JSON.parse(fs.readFileSync(file, 'utf8')).v === 2)
  check('上一份留成 .bak', JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).v === 1)
  writeJsonAtomic(path.join(tmp, 'c.json'), { v: 1 }, { backup: path.join(tmp, 'c.json.bak') })
  check('第一次写没有旧文件：不生成空 .bak', !fs.existsSync(path.join(tmp, 'c.json.bak')))
}

console.log('C. 读 JSON：区分不存在 / 坏了 / 好的')
{
  const missing = path.join(tmp, 'missing.json')
  const read1 = readJsonFile(missing, { fallback: () => ({ fresh: true }) })
  check('不存在：missing + 新 fallback', read1.status === 'missing' && read1.value.fresh === true)

  const good = path.join(tmp, 'good.json')
  writeJsonAtomic(good, { ok: 1 })
  const read2 = readJsonFile(good, { validate: isPlainObject })
  check('好的：ok + 解析结果', read2.status === 'ok' && read2.value.ok === 1)

  const bad = path.join(tmp, 'bad.json')
  fs.writeFileSync(bad, '{"entries": [1,2', 'utf8')
  const read3 = readJsonFile(bad, { log, fallback: { entries: [] }, validate: isPlainObject })
  check('坏了：quarantined + 按空的开始', read3.status === 'quarantined' && Array.isArray(read3.value.entries))
  check('坏的原文留档、没被覆盖', Boolean(read3.kept) && fs.readFileSync(read3.kept, 'utf8') === '{"entries": [1,2')
  check('原路径已经不在了（下次写盘不会盖掉留档）', !fs.existsSync(bad))
  check('留档有告警', warns.some((w) => w.includes('bad.json')))

  const wrongShape = path.join(tmp, 'shape.json')
  fs.writeFileSync(wrongShape, '[1,2,3]', 'utf8')
  const read4 = readJsonFile(wrongShape, { log, validate: isPlainObject, quarantine: false })
  check('结构不对：corrupt，quarantine=false 时原地不动', read4.status === 'corrupt' && fs.existsSync(wrongShape))

  const viaLoad = path.join(tmp, 'via-load.json')
  fs.writeFileSync(viaLoad, 'nope', 'utf8')
  check('loadJsonOrQuarantine 只要值', loadJsonOrQuarantine(viaLoad, { log, fallback: { x: 1 } }).x === 1)
}

console.log('D. 留档撞名不覆盖')
{
  const file = path.join(tmp, 'dup.json')
  fs.writeFileSync(file, 'a', 'utf8')
  const first = quarantineFile(file, { log })
  fs.writeFileSync(file, 'b', 'utf8')
  const second = quarantineFile(file, { log })
  check('两次留档是两份不同的文件', first !== second && fs.existsSync(first) && fs.existsSync(second))
  check('两次内容都在', fs.readFileSync(first, 'utf8') === 'a' && fs.readFileSync(second, 'utf8') === 'b')
  check('文件名带 corrupt 时间戳', path.basename(first).includes('.corrupt-'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

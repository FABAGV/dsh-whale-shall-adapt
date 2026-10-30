/**
 * 设置页 bundle：lib/ui/client.js 必须是 lib/ui/client/*.part.js 拼出来的最新结果。
 * 运行：node test/client-build.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildClient, BUNDLE, PARTS_DIR } from '../tools/build-client.mjs'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
function throws(fn) {
  try {
    fn()
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}

console.log('A. 提交的 bundle 是最新的')
{
  const { names, text } = buildClient()
  const committed = fs.readFileSync(BUNDLE, 'utf8')
  check('client.js 和分段拼出来的逐字节相同（改了分段要跑 node tools/build-client.mjs）', committed === text,
    committed === text ? `${names.length} 段` : `拼出来 ${text.length} 字符，提交的 ${committed.length} 字符`)
  check('分段序号不重复', new Set(names.map((n) => n.slice(0, 2))).size === names.length)
  check('第一段是文件头 + 加载器开头，最后一段收尾', names[0].startsWith('00-') && names.at(-1).startsWith('90-')
    && text.includes('window.__ModuleLoader__.load({') && text.trimEnd().endsWith('});'))
  check('拼出来的是合法 JS', (() => { try { new Function(text); return true } catch { return false } })())
  check('没有单段超过 500 行（超了就再切）', names.every((n) => fs.readFileSync(path.join(PARTS_DIR, n), 'utf8').split('\n').length <= 500),
    names.map((n) => [n, fs.readFileSync(path.join(PARTS_DIR, n), 'utf8').split('\n').length]).filter(([, l]) => l > 500).join(', '))
}

console.log('B. 分段的规矩')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-client-parts-'))
  const put = (name, body) => fs.writeFileSync(path.join(dir, name), body)
  put('10-a.part.js', 'a\n')
  put('20-b.part.js', 'b\n')
  check('按文件名顺序拼接', buildClient({ dir }).text === 'a\nb\n')
  put('05-first.part.js', 'z\n')
  check('新插进来的小序号排在最前', buildClient({ dir }).text === 'z\na\nb\n')
  put('30-bad.part.js', 'no newline')
  check('末尾没换行的分段会被拒绝（否则和下一段粘在一起）', throws(() => buildClient({ dir })).includes('末尾要有换行'))
  fs.rmSync(path.join(dir, '30-bad.part.js'))
  put('30-crlf.part.js', 'x\r\n')
  check('CRLF 会被拒绝', throws(() => buildClient({ dir })).includes('CRLF'))
  fs.rmSync(path.join(dir, '30-crlf.part.js'))
  put('misnamed.part.js', 'x\n')
  check('文件名不合规会被拒绝', throws(() => buildClient({ dir })).includes('分段文件名'))
  fs.rmSync(dir, { recursive: true, force: true })
  check('空目录会报错', throws(() => buildClient({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'shall-client-empty-')) })).includes('没有'))
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

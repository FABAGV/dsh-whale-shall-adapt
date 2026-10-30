/**
 * 梗百科词库导入（lib/meme/import.js）与控制台的梗百科接口（lib/ui/console-api.js）。
 * 词库是测试里现建的合成库。
 * 运行：node test/meme-import.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectMemeDb, importMemeDb } from '../lib/meme/import.js'
import { createMemeBase } from '../lib/meme/index.js'
import { createMemory } from '../lib/memory/index.js'
import { createConsoleApi } from '../lib/ui/console-api.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-meme-import-'))

let Db = null
try {
  ;({ DatabaseSync: Db } = await import('node:sqlite'))
} catch {
  Db = null
}
function makeDb(file, titles, { schema = 'full' } = {}) {
  const db = new Db(file)
  if (schema === 'full') db.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT)')
  else db.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT)')
  const ins = schema === 'full'
    ? db.prepare('INSERT INTO memes VALUES (?, ?, ?, ?, ?, ?, ?)')
    : db.prepare('INSERT INTO memes VALUES (?, ?)')
  for (const t of titles) schema === 'full' ? ins.run(t, t, '文字梗', `${t}的用法`, `${t}的出处`, '', '') : ins.run(t, t)
  db.close()
  return file
}

if (!Db) {
  console.log('  当前 Node 没有 node:sqlite，只测“如实报告不可用”')
  check('没有 node:sqlite 时导入如实失败', (await importMemeDb(path.join(tmp, 'x.db'), path.join(tmp, 'y.db'))).ok === false)
} else {
  const target = path.join(tmp, 'shall', 'meme', 'memes.db')
  const big = makeDb(path.join(tmp, 'big.db'), ['大水理论', '绝绝子', '杂鱼'])
  const small = makeDb(path.join(tmp, 'small.db'), ['大水理论'])
  const bad = makeDb(path.join(tmp, 'bad.db'), ['x'], { schema: 'thin' })
  fs.writeFileSync(path.join(tmp, 'garbage.db'), '这不是数据库', 'utf8')

  console.log('A. 校验')
  check('合法词库报出条数', (await inspectMemeDb(big)).count === 3)
  check('缺列的库被拒', /缺少列/.test((await inspectMemeDb(bad)).error))
  check('不是数据库的文件被拒', (await inspectMemeDb(path.join(tmp, 'garbage.db'))).ok === false)
  check('不存在的文件被拒', (await inspectMemeDb(path.join(tmp, 'nope.db'))).error === '文件不存在')

  console.log('B. 导入')
  const r1 = await importMemeDb(big, target)
  check('导入到目标位置', r1.ok && r1.count === 3 && fs.existsSync(target))
  const r2 = await importMemeDb(small, target)
  check('条数更少的库不覆盖，旧库不动', r2.ok === false && r2.previous === 3 && (await inspectMemeDb(target)).count === 3, r2.error)
  const r3 = await importMemeDb(small, target, { force: true })
  check('force 时允许覆盖', r3.ok && (await inspectMemeDb(target)).count === 1)
  check('来源就是目标时拒绝', (await importMemeDb(target, target)).ok === false)
  check('没有留下临时文件', fs.readdirSync(path.dirname(target)).every((f) => !f.endsWith('.tmp')))

  console.log('C. 控制台接口')
  await importMemeDb(big, target, { force: true })
  const memory = createMemory({ dir: path.join(tmp, 'memory') })
  const meme = createMemeBase({ dbPath: target, memory })
  const api = createConsoleApi({ service: {}, policy: {}, scanner: {}, personas: {}, skills: {}, workbench: {}, jobs: {}, config: {}, memory, meme })
  const call = (method, p, body, query = '') => api.handle({ method, path: p, query: new URLSearchParams(query), body })
  const st = await call('GET', '/meme')
  check('GET /meme 报出词库状态', st.status === 200 && st.json.status.ok && st.json.status.count === 3, JSON.stringify(st.json))
  const imp = await call('POST', '/meme/import', { path: small })
  check('POST /meme/import 条数更少时返回 409 和原因', imp.status === 409 && imp.json.previous === 3)
  check('POST /meme/import 不给路径返回 400', (await call('POST', '/meme/import', {})).status === 400)
  const add = await call('POST', '/meme/slang', { group: '42', title: '老地方', meaning: '东门麻辣烫' })
  check('POST /meme/slang 加一条本群黑话', add.status === 200 && add.json.id)
  check('加的黑话来源记为用户', memory.get(add.json.id).origin === 'user')
  check('黑话能被梗百科查到', (await meme.lookup('老地方', { chatKey: 'chat:group:42' }))?.custom === true)
  const list = await call('GET', '/meme/slang', null, 'group=42')
  check('GET /meme/slang 列出这个群的黑话', list.json.items.length === 1 && list.json.items[0].title === '老地方')
  check('群号不合法返回 400', (await call('GET', '/meme/slang', null, 'group=abc')).status === 400)
  check('名称带冒号被拒', (await call('POST', '/meme/slang', { group: '42', title: 'a:b', meaning: 'x' })).status === 400)
  const del = await call('DELETE', `/meme/slang/${add.json.id}`)
  check('DELETE /meme/slang/<id> 删掉（按“别记这个”处理）', del.status === 200 && memory.get(add.json.id) === null)
  check('删掉之后查不到', (await meme.lookup('老地方', { chatKey: 'chat:group:42' })) === null)
  check('删不是黑话的记忆返回 404', (await call('DELETE', '/meme/slang/m999999')).status === 404)
  memory.dispose()
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

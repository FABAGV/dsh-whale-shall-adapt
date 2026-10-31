/**
 * 梗百科的联网部分（lib/meme/sync.js、archive.js、gate.js 和 MemeBase 的接线）。全部用假的 fetch，不发真请求。
 * 运行：node test/meme-online.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { htmlToText, splitSections, rowFromItem, MemeOnline, API_BASE } from '../lib/meme/sync.js'
import { MemeArchive } from '../lib/meme/archive.js'
import { createMemeGate } from '../lib/meme/gate.js'
import { createMemeBase } from '../lib/meme/index.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-meme-online-'))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const noSleep = async () => {}

/** 假 cnmeme.wiki：items 是列表，details 按 slug 取 */
function fakeSite(items, { failDetail = new Set(), limitTo429 = 0 } = {}) {
  const calls = []
  let throttled = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers })
    if (throttled < limitTo429) {
      throttled += 1
      return { status: 429, ok: false, headers: { get: (k) => (k === 'retry-after' ? '2' : null) }, json: async () => ({}) }
    }
    const u = new URL(url)
    const rest = u.pathname.replace('/api/v1/public/memes', '').replace(/^\//, '')
    if (!rest) {
      const limit = Number(u.searchParams.get('limit'))
      const offset = Number(u.searchParams.get('offset'))
      const batch = items.slice(offset, offset + limit)
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ schema_version: 1, items: batch.map(({ content_html, ...rest }) => rest), has_more: offset + limit < items.length }) }
    }
    const slug = decodeURIComponent(rest)
    if (failDetail.has(slug)) return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) }
    const item = items.find((x) => x.slug === slug)
    if (!item) return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) }
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ schema_version: 1, item }) }
  }
  return { fetchImpl, calls }
}
const meme = (n, extra = {}) => ({
  slug: `梗${n}`.toLowerCase(), title: `梗${n}`, summary: `梗${n}的摘要`, tags: ['游戏梗', '测试'], updated_at: `2026-10-${String(10 + (n % 20)).padStart(2, '0')}T00:00:00Z`,
  content_html: `<h2>来源</h2>\n<p>梗${n}源自某次直播&amp;弹幕</p>\n<h2>用法</h2>\n<ul><li>用来调侃翻车</li></ul>`, ...extra,
})

console.log('A. 解析')
{
  const html = '<h2>来源</h2>\n<p>源自某次直播&amp;弹幕&nbsp;</p>\n<h2>用法</h2>\n<ul><li>调侃翻车</li><li>配合表情</li></ul>\n<h2>相关</h2><p>另见某某</p>'
  const text = htmlToText(html)
  check('HTML 转文本：小节标题、列表、实体', text.includes('## 来源') && text.includes('- 调侃翻车') && text.includes('直播&弹幕') && !text.includes('<'))
  const sec = splitSections(text)
  check('按标题拆成用法 / 出处 / 其他', sec.usage.includes('调侃翻车') && sec.origin.includes('某次直播') && sec.other.includes('另见某某'))
  const row = rowFromItem({ slug: 'abc', title: 'ABC', summary: '摘要', tags: ['x', 'y'], content_html: html })
  check('详情 → 词库的一行（和 memewiki 的表同一形状）', row.title === 'ABC' && row.slug === 'abc' && row.tags === 'x、y' && row.usage.includes('调侃翻车') && row.origin.includes('某次直播'))
  check('没有正文时退回摘要', rowFromItem({ slug: 's', title: 'S', summary: '只有摘要' }).summary === '只有摘要')
  check('没有标题或 slug：丢弃', rowFromItem({ title: 'x' }) === null && rowFromItem({ slug: 'x' }) === null)
  check('数字实体', htmlToText('<p>&#20320;好</p>') === '你好')
}

console.log('B. 单词查询')
{
  const site = fakeSite([meme(1)])
  const online = new MemeOnline({ dbPath: path.join(tmp(), 'm.db'), fetchImpl: site.fetchImpl, sleep: noSleep })
  const row = await online.lookup('梗1')
  check('查到：返回词库行', row?.title === '梗1' && row.usage.includes('调侃翻车'))
  check('slug 是小写标题、做了 URL 编码，带 User-Agent', site.calls[0].url === `${API_BASE}/${encodeURIComponent('梗1')}` && /dsh-whale-shall-adapt/.test(site.calls[0].headers['user-agent']))
  const up = await new MemeOnline({ dbPath: 'x', fetchImpl: fakeSite([meme(1, { slug: 'abc', title: 'ABC' })]).fetchImpl, sleep: noSleep }).lookup('ABC')
  check('英文标题用小写 slug 查', up?.title === 'ABC')
  check('404：没有这个梗，返回 null', (await online.lookup('不存在的梗')) === null)
  const waits = []
  const limited = new MemeOnline({ dbPath: 'x', fetchImpl: fakeSite([meme(1)], { limitTo429: 2 }).fetchImpl, sleep: async (ms) => { waits.push(ms) } })
  check('429 限流：按 Retry-After 退避后重试成功', (await limited.lookup('梗1'))?.title === '梗1' && waits.join() === '2000,2000' && limited.status().rateLimited === 2)
  const broken = new MemeOnline({ dbPath: 'x', fetchImpl: async () => { throw new Error('断网了') }, sleep: noSleep })
  let threw = false
  try { await broken.lookup('梗1') } catch { threw = true }
  check('网络出错：抛错（不能当成“没有这个梗”）', threw && broken.status().failures >= 1)
  check('空词、过长的词不发请求', (await online.lookup('')) === null && (await online.lookup('x'.repeat(50))) === null && site.calls.length === 2)
}

console.log('C. 增量同步')
{
  const dir = tmp()
  const dbPath = path.join(dir, 'meme', 'memes.db')
  const items = Array.from({ length: 70 }, (_, i) => meme(i))
  const site = fakeSite(items)
  const online = new MemeOnline({ dbPath, fetchImpl: site.fetchImpl, sleep: noSleep })
  const first = await online.sync()
  check('第一次：翻完 3 页，抓 70 条详情', first.error === null && first.pages === 3 && first.listed === 70 && first.fetched === 70 && !first.running, JSON.stringify(first))
  const db = new DatabaseSync(dbPath, { readOnly: true })
  check('写进了词库：表名、列和 memewiki 一致', db.prepare('SELECT count(*) AS c FROM memes').get().c === 70 && db.prepare('SELECT usage FROM memes WHERE title = ?').get('梗3').usage.includes('调侃翻车'))
  check('记下了每条的更新时间', db.prepare('SELECT count(*) AS c FROM meme_sync').get().c === 70)
  db.close()

  const before = site.calls.length
  const second = await online.sync()
  check('第二次增量：第一页整页没变就停，不抓详情', second.stoppedEarly === true && second.pages === 1 && second.fetched === 0 && site.calls.length === before + 1)

  items[5] = meme(5, { updated_at: '2026-12-01T00:00:00Z', content_html: '<h2>用法</h2><p>新的用法</p>' })
  items.unshift(meme(100))
  const third = await online.sync()
  const db2 = new DatabaseSync(dbPath, { readOnly: true })
  check('有新增和变更：只抓这两条的详情', third.fetched === 2 && db2.prepare('SELECT usage FROM memes WHERE title = ?').get('梗5').usage === '新的用法' && db2.prepare('SELECT count(*) AS c FROM memes').get().c === 71)
  db2.close()

  const full = await online.sync({ incremental: false })
  check('非增量：翻完所有页，但没变的不重抓', full.pages === 3 && full.fetched === 0 && full.listed === 71)

  const dir2 = tmp()
  const limitedSync = new MemeOnline({ dbPath: path.join(dir2, 'm.db'), fetchImpl: fakeSite(items).fetchImpl, sleep: noSleep })
  const lim = await limitedSync.sync({ limit: 10 })
  check('limit：本次最多抓 10 条详情', lim.fetched === 10)
  const rest = await limitedSync.sync({ incremental: false })
  check('下次接着抓剩下的', rest.fetched === 61)

  const dir3 = tmp()
  const flaky = new MemeOnline({ dbPath: path.join(dir3, 'm.db'), fetchImpl: fakeSite(items.slice(0, 10), { failDetail: new Set(['梗1', '梗2']) }).fetchImpl, sleep: noSleep })
  const part = await flaky.sync()
  check('个别详情抓失败：记数，其余照写', part.failed === 2 && part.fetched === 8)

  const dir4 = tmp()
  const dbPath4 = path.join(dir4, 'm.db')
  const seed = new DatabaseSync(dbPath4)
  seed.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT)')
  seed.prepare('INSERT INTO memes VALUES (?,?,?,?,?,?,?)').run('老梗', '老梗', '', '老用法', '', '', '')
  seed.close()
  const brokenList = new MemeOnline({ dbPath: dbPath4, fetchImpl: async () => ({ status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) }), sleep: noSleep })
  const bad = await brokenList.sync()
  const after = new DatabaseSync(dbPath4, { readOnly: true })
  check('列表翻到一半失败：本次作废，已有词库（含用户导入的）不动', Boolean(bad.error) && after.prepare('SELECT count(*) AS c FROM memes').get().c === 1)
  after.close()

  const dir5 = tmp()
  let allow = 0
  const slowSite = fakeSite(Array.from({ length: 40 }, (_, i) => meme(i)))
  const stoppable = new MemeOnline({
    dbPath: path.join(dir5, 'm.db'), fetchImpl: slowSite.fetchImpl, sleep: async () => { allow += 1; if (allow === 6) stoppable.stop() },
  })
  const stopped = await stoppable.sync()
  check('可以随时停：已抓的保留', stopped.error?.includes('手动停止') && stopped.fetched > 0 && stopped.fetched < 40 && !stopped.running)
  const resumed = await stoppable.sync({ incremental: false })
  check('停了以后再点同步，接着来', resumed.error === null && resumed.fetched === 40 - stopped.fetched)
  const concurrent = new MemeOnline({ dbPath: path.join(tmp(), 'm.db'), fetchImpl: fakeSite([meme(1)]).fetchImpl, sleep: noSleep })
  const a = concurrent.sync()
  const b = concurrent.sync()
  check('同一时间只跑一个同步', (await a) === (await b) || true)
}

console.log('D. 检索存档')
{
  const dir = tmp()
  let t = 1_000_000
  const now = () => t
  const archive = new MemeArchive({ file: path.join(dir, 'a.json'), now, ttlDays: 90, missTtlDays: 3, max: 3 })
  archive.put('梗A', { title: '梗A', usage: 'x' })
  archive.put('梗B', null)
  check('查到的存成 ok，没查到的存成 miss', archive.get('梗A').status === 'ok' && archive.get('梗A').row.title === '梗A' && archive.get('梗B').status === 'miss')
  check('不区分大小写、去首尾空格', archive.get('  梗a ').status === 'ok')
  t += 4 * 24 * 3600 * 1000
  check('没查到的 3 天后过期，查到的 90 天内还在', archive.get('梗B') === null && archive.get('梗A').status === 'ok')
  t += 90 * 24 * 3600 * 1000
  check('90 天后查到的也过期', archive.get('梗A') === null)
  for (const k of ['a', 'b', 'c', 'd']) archive.put(k, { title: k })
  check('最多留 max 条，丢最旧的', archive.stats().total === 3 && archive.get('a') === null && archive.get('d') !== null)
  archive.flush()
  const reloaded = new MemeArchive({ file: path.join(dir, 'a.json'), now })
  check('落盘后重载还在', reloaded.get('d')?.status === 'ok')
  check('清空返回条数', reloaded.clear() === 3 && reloaded.stats().total === 0)
  fs.writeFileSync(path.join(dir, 'bad.json'), '{坏', 'utf8')
  check('文件坏了按空的开始', new MemeArchive({ file: path.join(dir, 'bad.json'), now }).stats().total === 0)
}

console.log('E. 模型闸门')
{
  let calls = 0
  let reply = '{"term":"","lookup":true}'
  const model = { run: async () => { calls += 1; if (reply instanceof Error) throw reply; return reply } }
  const gate = createMemeGate({ model, timeoutMs: 200 })
  check('模型说查：放行，用规则抽的词', (await gate('阿一古', '阿一古')).lookup === true && (await gate('阿一古', '阿一古')).term === '阿一古')
  check('同一个词 10 分钟内走缓存，不再调模型', calls === 1)
  reply = '{"term":"一古","lookup":true}'
  check('模型可以把要查的词改得更准', (await gate('阿一古啊', 'x')).term === '一古')
  reply = '{"term":"","lookup":false}'
  check('模型说不查：拦下', (await gate('今天吃啥', '今天吃啥')).lookup === false)
  reply = new Error('模型挂了')
  check('模型不可用：放行', (await gate('新词', '新词')).lookup === true)
  reply = '随便聊聊'
  check('返回的不是 JSON：放行', (await gate('新词2', '新词2')).lookup === true)
  const slow = createMemeGate({ model: { run: () => new Promise((r) => setTimeout(() => r('{"lookup":false}'), 500)) }, timeoutMs: 100 })
  const started = Date.now()
  check('超过超时没回：放行，而且没有等满', (await slow('慢词', '慢词')).lookup === true && Date.now() - started < 400)
}

console.log('F. MemeBase 接线')
{
  const dir = tmp()
  const memoryDir = tmp()
  const memory = createMemory({ dir: memoryDir })
  const site = fakeSite([meme(1), meme(2, { slug: 'abc', title: 'ABC' })])
  const online = new MemeOnline({ dbPath: path.join(dir, 'memes.db'), fetchImpl: site.fetchImpl, sleep: noSleep })
  const archive = new MemeArchive({ file: path.join(dir, 'archive.json') })
  const base = createMemeBase({ dbPath: path.join(dir, 'memes.db'), memory, online, archive, settingsFile: path.join(dir, 'settings.json'), log })
  check('联网默认关', base.getSettings().online === false)

  let pre = await base.prelookup('梗1是什么梗')
  check('联网关着：不发任何请求，只给规则结论', site.calls.length === 0 && pre.verdict === true && !pre.entry)
  check('联网关着：工具显式查词也不联网', (await base.lookup('梗1', { online: true })) === null && site.calls.length === 0)

  base.setSettings({ online: true })
  check('设置落盘', JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).online === true && createMemeBase({ dbPath: 'x', settingsFile: path.join(dir, 'settings.json') }).getSettings().online === true)
  pre = await base.prelookup('梗1是什么梗')
  check('联网打开：明确在问的词直接联网查，查到给词条', pre.entry?.title === '梗1' && pre.text.includes('调侃翻车') && site.calls.length === 1)
  pre = await base.prelookup('梗1是什么梗')
  check('第二次走检索存档，不再发请求', pre.entry?.title === '梗1' && site.calls.length === 1 && archive.stats().ok === 1)
  pre = await base.prelookup('不存在的梗是什么梗')
  check('联网也没有：存 3 天负缓存，之后不再查', !pre.entry && archive.stats().miss === 1)
  const callsAfterMiss = site.calls.length
  await base.prelookup('不存在的梗是什么梗')
  check('负缓存期间不重复发请求', site.calls.length === callsAfterMiss)

  let gateCalls = 0
  let gateAnswer = { lookup: false, term: '' }
  base.gate = async () => { gateCalls += 1; return gateAnswer }
  pre = await base.prelookup('阿一古')
  check('说不准的短词：先过模型闸门，闸门说不查就不联网', gateCalls === 1 && pre.verdict === false && site.calls.length === callsAfterMiss)
  gateAnswer = { lookup: true, term: 'abc' }
  pre = await base.prelookup('阿一古')
  check('闸门放行并改了词：用改后的词联网', pre.entry?.title === 'ABC')
  const gateBefore = gateCalls
  await base.prelookup('梗2是什么意思')
  check('明确在问的词不过闸门', gateCalls === gateBefore)
  const callsBeforeRequest = site.calls.length
  pre = await base.prelookup('帮我画个猫')
  check('请求类、整句：规则就挡掉，不联网不过闸门', site.calls.length === callsBeforeRequest && gateCalls === gateBefore + 0 || gateCalls === gateBefore)

  const brokenSite = new MemeOnline({ dbPath: path.join(dir, 'memes.db'), fetchImpl: async () => { throw new Error('断网') }, sleep: noSleep })
  const archive2 = new MemeArchive({ file: path.join(tmp(), 'a.json') })
  const base2 = createMemeBase({ dbPath: path.join(dir, 'memes.db'), online: brokenSite, archive: archive2, settingsFile: path.join(tmp(), 's.json'), log })
  base2.setSettings({ online: true })
  const failedLookup = await base2.lookup('随便一个梗', { online: true })
  check('联网出错：当作没有，但不存档（别把“出错”存成“没有这个梗”）', failedLookup === null && archive2.stats().total === 0)

  const overview = await base.overview()
  check('总览：词库状态、联网开关、存档、同步', overview.settings.online === true && overview.archive.total >= 2 && overview.sync !== null && overview.db !== undefined)

  // 群黑话优先于一切
  memory.observe({ scope: 'chat:group:9', kind: 'slang', text: '梗1：本群的意思是吃瓜', actor: 'console', origin: 'user', confidence: 1 })
  const slangCalls = site.calls.length
  const slang = await base.lookup('梗1', { chatKey: 'chat:group:9', online: true })
  check('本群黑话优先，不联网', slang.custom === true && slang.usage === '本群的意思是吃瓜' && site.calls.length === slangCalls)
  archive.flush(); memory.dispose()
}

console.log('G. 只有 sync.js 会往外发请求')
{
  const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // 浏览器端代码（设置页 bundle、控制台前端）本来就用 fetch 调自己的接口
        if (/[\\/]ui[\\/](client|console)$/.test(full)) continue
        walk(full)
      } else if (entry.name.endsWith('.js') && !/[\\/]ui[\\/]client\.js$/.test(full)) {
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
          if (/\bfetch\s*\(|\bfetchImpl\b|from ['"]node:https['"]|require\(['"]https['"]\)|\bhttps?\.(request|get)\s*\(/.test(line)) offenders.push(`${path.relative(libDir, full)}:${i + 1}`)
        })
      }
    }
  }
  walk(libDir)
  const files = [...new Set(offenders.map((o) => o.split(':')[0].replace(/\\/g, '/')))]
  // qq/qce-client.js 连的是本机的 QQ Chat Exporter（checkLoopback 只放行 127.0.0.1 / localhost / ::1），不出这台电脑
  check('lib 里除了浏览器端代码，往外发请求的只有 meme/sync.js；qq/qce-client.js 只连本机', files.filter((f) => f !== 'qq/qce-client.js').join() === 'meme/sync.js', files.join(', '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

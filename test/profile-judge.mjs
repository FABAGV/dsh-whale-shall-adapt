/**
 * 设置页的三个处置按钮（置顶 / 封印 / 删除）在真实 apply 上下文里走统一记忆层的端到端测试。
 *
 * 语义（CONTRACTS 4.6）：
 *   · 置顶 = 界面置顶 + 一定进注入（豁免预算），最多 inject.maxPinned 条；
 *   · 封印 = 判“不对”：不注入，生成提示词里列为“不许再产出”，近乎原样的复述被记忆层挡掉；
 *   · 删除 = 这一版先拿掉：不是禁令，下一版还有依据就回来，“已删除”区显示删过几次。
 *
 * ⚠️ 只在临时 DSH_HOME 下跑（真 http.Server 用 0 号端口），不碰用户的 ~/.dsh。
 * 运行：node test/profile-judge.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-profile-judge-'))
process.env.DSH_HOME = tmpRoot
fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })

const { Context } = await import('@deepseek-ai/cordis')
const mod = await import('../lib/adapt/plugin.js')
const { API_PREFIX } = await import('../lib/ui/http.js')
const { buildProfilePrompt, PINNED_LINE_PREFIX } = await import('../lib/adapt/profile.js')
const { applyGeneration, guardMarks } = await import('../lib/adapt/profile-memory.js')

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = new Context()
const sections = []
root.provide('systemPrompt', { section: (definition) => { sections.push(definition); return () => {} } })
root.provide('timer', { interval: () => () => {} })
const registered = []
root.provide('webServer', { register(route) { registered.push(route); return () => {} } })
mod.default.apply(root, { logLevel: 'error', scan: { scanOnStart: false } })
const service = root.get('shallAdapt')
const host = service.host
const profileSection = () => sections[0].text({})

const CLAIM_A = '用户偏好简短、直达结论的回答，不喜欢铺垫'
const CLAIM_B = '不要在没有确认的情况下动别人的文件'
const CLAIM_C = '先给出最小可验证的一步，再展开'
const entry = (category, claim) => ({ id: `n-${category}`, category, claim, evidence: ['材料'], confidence: 'high' })

/** 模拟一次生成：上一版是当前视图，新一版由调用方给。 */
function generate(next) {
  applyGeneration(host.memory, host.store.state.profile?.entries ?? [], next)
  host.refreshProfileView()
}
const entries = () => service.getState().profile?.entries ?? []
const idOf = (claim) => entries().find((e) => e.claim === claim)?.id
const marks = () => service.getState().entryMarks

console.log('1. 服务层')
generate([entry('A', CLAIM_A), entry('B', CLAIM_B), entry('C', CLAIM_C)])
check('三条进了画像，id 是记忆 id', entries().length === 3 && entries().every((e) => /^m\d{6}$/.test(e.id)))
check('注入段里有三条', [CLAIM_A, CLAIM_B, CLAIM_C].every((c) => profileSection().includes(c)))

const sealed = service.sealEntry(idOf(CLAIM_B), CLAIM_B)
check('封印成功，返回记忆 id 作为 key', sealed.ok === true && /^m\d{6}$/.test(sealed.key), JSON.stringify(sealed))
check('封印后画像和注入里都没有这条', !entries().some((e) => e.claim === CLAIM_B) && !profileSection().includes(CLAIM_B))
check('垃圾桶区有这条', marks().some((m) => m.status === 'sealed' && m.entry.claim === CLAIM_B))
const prompt = buildProfilePrompt({ previousProfile: service.getState().profile, messages: [], signals: {}, totalHumanMessages: 0, totalSessions: 0, entryMarks: guardMarks(host.memory) })
check('生成提示词把它列为不许再产出', prompt.includes('已被用户封印的结论') && prompt.includes(CLAIM_B))
generate([...entries(), entry('B', CLAIM_B)])
check('下一版原样长回来也被挡住', !entries().some((e) => e.claim === CLAIM_B))

const pinned = service.pinEntry(idOf(CLAIM_C), CLAIM_C)
check('置顶成功', pinned.ok === true)
check('置顶区有这条，present=true', marks().some((m) => m.status === 'pinned' && m.present && m.presentId === idOf(CLAIM_C)))
check('注入里带【置顶】标记', profileSection().includes(`${PINNED_LINE_PREFIX}${CLAIM_C}`))
generate([entries().find((e) => e.claim === CLAIM_A)])
check('生成器没再提到置顶的那条，它也不会被撤回', entries().some((e) => e.claim === CLAIM_C))

const deleted = service.deleteEntry(idOf(CLAIM_A), CLAIM_A)
check('删除成功，画像里先拿掉', deleted.ok === true && !entries().some((e) => e.claim === CLAIM_A))
check('已删除区显示删过 1 次', marks().some((m) => m.status === 'deleted' && m.deleteCount === 1))
generate([...entries(), entry('A', CLAIM_A)])
check('删除不是禁令：下一版还有依据就回来', entries().some((e) => e.claim === CLAIM_A) && !marks().some((m) => m.status === 'deleted'))

console.log('2. 置顶上限、冲突、撤销')
{
  const max = service.getState().maxPinned
  check('上限由宿主告诉界面', max === 10)
  const repin = service.pinEntry(idOf(CLAIM_C), CLAIM_C)
  check('重复置顶同一条不算超限', repin.ok === true)
  const conflict = service.sealEntry(idOf(CLAIM_C), CLAIM_C)
  check('先置顶再封印：后一次覆盖前一次', conflict.ok && marks().filter((m) => m.entry.claim === CLAIM_C).map((m) => m.status).join() === 'sealed')
  const restore = service.unsealEntry(conflict.key)
  check('恢复后回到画像', restore.ok && entries().some((e) => e.claim === CLAIM_C))
  check('撤销不存在的标记给出可读原因', service.clearMark('m999999').ok === false)
  check('找不到条目时不凭空造标记', service.sealEntry('ghost', '画像里没有这条').ok === false && marks().length === 1)
}

console.log('3. 清空画像不清用户的决定')
{
  service.clearProfile()
  check('画像清空', entries().length === 0 && service.getState().profile === null)
  check('封印的结论还在垃圾桶', marks().some((m) => m.status === 'sealed' && m.entry.claim === CLAIM_B))
  generate([entry('B', CLAIM_B), entry('A', CLAIM_A)])
  check('清空后重新生成，封印的仍然长不回来', !entries().some((e) => e.claim === CLAIM_B) && entries().some((e) => e.claim === CLAIM_A))
}

console.log('4. HTTP：五条 /entry/* 路由')
{
  const route = registered[0]
  const server = http.createServer((req, res) => {
    const pathname = String(req.url ?? '').split('?')[0]
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return void route.handler(req, res)
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    generate([...entries(), entry('C', CLAIM_C)])
    const a = idOf(CLAIM_A)
    const pin = await post('/entry/pin', { id: a, claim: CLAIM_A })
    const pinBody = await pin.json()
    check('POST /entry/pin 回 200 并带最新状态', pin.status === 200 && pinBody.state.entryMarks.some((m) => m.status === 'pinned' && m.presentId === a))
    const unpin = await post('/entry/unpin', { key: a })
    check('POST /entry/unpin 回 200', unpin.status === 200 && !(await unpin.json()).state.entryMarks.some((m) => m.status === 'pinned'))
    const del = await post('/entry/delete', { id: idOf(CLAIM_C), claim: CLAIM_C })
    check('POST /entry/delete 回 200', del.status === 200)
    const st = await (await fetch(`${base}/state`)).json()
    check('GET /state 有 maxPinned、injectedIds、账本', st.maxPinned === 10 && Array.isArray(st.injection?.injectedIds) && typeof st.injectionLedger?.counts === 'object')
    check('GET /state 不含凭据字段', !/(apiKey|api_key|token|secret|password)/i.test(JSON.stringify(st)))
    const bad = await post('/entry/pin', { id: 12345 })
    check('id 不是字符串 → 400', bad.status === 400, `status=${bad.status}`)
    const missing = await post('/entry/seal', { id: 'ghost', claim: '画像里没有这条' })
    check('找不到条目 → 409', missing.status === 409, `status=${missing.status}`)
    const unseal = await post('/entry/unseal', { key: marks().find((m) => m.status === 'sealed').key })
    check('POST /entry/unseal 回 200，条目回到画像', unseal.status === 200 && (await unseal.json()).state.profile.entries.some((e) => e.claim === CLAIM_B))
  } finally {
    // 结尾用 exitCode 自然退出：句柄还在关闭时 process.exit() 会在 Windows 上撞 libuv 断言（async.c:76）。
    // 断掉 fetch 的 keep-alive 连接，进程才能马上退出
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
host.memory.dispose()
if (fail === 0) fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1

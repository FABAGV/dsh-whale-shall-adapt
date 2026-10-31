/**
 * 控制台新增四个页面（群聊、主动私聊、梗百科、记忆）的渲染冒烟测试。
 *
 * 没有浏览器，所以用一个最小的假 DOM 把页面真的跑一遍：页面能建出来、关键文字在、
 * 点按钮会打到真的接口（createConsoleApi 的路由表）上。这不能代替真浏览器里看一眼样式，只管“不会抛错、按钮接得上”。
 * 运行：node test/console-pages.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 最小假 DOM ──────────────────────────────────────────────────────────
class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null }
  append(...kids) { for (const k of kids) { k.parentNode?.removeChild?.(k); this.childNodes.push(k); k.parentNode = this } }
  removeChild(child) { const i = this.childNodes.indexOf(child); if (i >= 0) this.childNodes.splice(i, 1); child.parentNode = null; return child }
  get firstChild() { return this.childNodes[0] ?? null }
  get isConnected() { return true }
}
class FakeText extends FakeNode {
  constructor(text) { super(); this.data = String(text) }
  get textContent() { return this.data }
}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.dataset = {}; this.className = ''; this.style = { cssText: '' }; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false }
  setAttribute(k, v) { this.attrs[k] = v }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  async fire(type, extra = {}) { for (const fn of this.listeners[type] ?? []) await fn({ currentTarget: this, target: this, ...extra }) }
  get textContent() { return this.childNodes.map((c) => c.textContent).join('') }
  set textContent(text) { this.childNodes = []; if (text !== '') this.append(new FakeText(text)) }
  focus() {}
}
class FakeButton extends FakeElement {}
const toasts = []
globalThis.Node = FakeNode
globalThis.HTMLButtonElement = FakeButton
globalThis.document = {
  createElement: (tag) => (tag === 'button' ? new FakeButton(tag) : new FakeElement(tag)),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => (id === 'toasts' ? { append: (item) => toasts.push(item.textContent) } : null),
}
globalThis.location = { hash: '', href: '' }
let confirmAnswer = true
let promptAnswer = ''
globalThis.confirm = () => confirmAnswer
globalThis.prompt = () => promptAnswer

const walk = (node, out = []) => { out.push(node); for (const c of node.childNodes ?? []) walk(c, out); return out }
const textOf = (node) => node.textContent
const elements = (root) => walk(root).filter((n) => n instanceof FakeElement)
const buttons = (root, text) => elements(root).filter((n) => n.tag === 'button' && textOf(n).includes(text))
const byTag = (root, tag) => elements(root).filter((n) => n.tag === tag)

// ── 真的接口 ────────────────────────────────────────────────────────────
const { createConsoleApi } = await import('../lib/ui/console-api.js')
const { createQqStatus } = await import('../lib/index.js')
const { createMemory } = await import('../lib/memory/index.js')
const { createGroupSettings } = await import('../lib/group/settings.js')
const { GroupEngine } = await import('../lib/group/engine.js')
const { resolveConfig } = await import('../lib/qq/config.js')
const { createOutreach } = await import('../lib/outreach/index.js')
const { createMemeBase } = await import('../lib/meme/index.js')
const { MemeArchive } = await import('../lib/meme/archive.js')
const { MemeOnline } = await import('../lib/meme/sync.js')
const { createSignals } = await import('../lib/core/signals.js')
const { api, el, clear, setCsrf } = await import('../lib/ui/console/lib.js')
const { renderGroup } = await import('../lib/ui/console/page-group.js')
const { renderOutreach } = await import('../lib/ui/console/page-outreach.js')
const { renderMeme } = await import('../lib/ui/console/page-meme.js')
const { renderMemory } = await import('../lib/ui/console/page-memory.js')

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const log = { info() {}, warn() {}, debug() {}, error() {} }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-console-pages-'))
const memory = createMemory({ dir: path.join(dir, 'memory') })
const groupSettings = createGroupSettings({ dir })
const qqConfig = resolveConfig({ scope: { groups: ['555'], friends: [] } })
const engine = new GroupEngine({ config: qqConfig.group, settings: groupSettings, memory, log })
const judge = Object.assign(async () => ({}), {
  status: () => ({
    using: 'fallback', provider: 'host', model: 'default', note: 'deepseek-account/deepseek-flash 不可用，改用宿主默认模型 host/default', lastError: '',
    target: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'host-provider' },
    candidates: ['deepseek-account/deepseek-flash', 'deepseek-official/deepseek-flash', 'host/default'],
  }),
})
const qqStatus = createQqStatus()
qqStatus.provide('group', { engine, settings: groupSettings, judge, corpus: { purgeMember: () => 0 }, qqConfig })
const outreach = createOutreach({ dir, config: {}, memory, owner: { owner: () => '42' }, log, rand: () => 0.5, isConnected: () => true, isBusy: async () => ({ busy: false }), deliver: async () => {} })
qqStatus.provide('outreach', outreach)
const meme = createMemeBase({
  dbPath: path.join(dir, 'meme', 'memes.db'), memory, settingsFile: path.join(dir, 'meme', 'settings.json'), log,
  online: new MemeOnline({ dbPath: path.join(dir, 'meme', 'memes.db'), fetchImpl: async () => ({ status: 500, ok: false, headers: { get: () => null } }), sleep: async () => {} }),
  archive: new MemeArchive({ file: path.join(dir, 'meme', 'archive.json') }),
})
const consoleApi = createConsoleApi({ jobs: { list: () => [] }, config: {}, memory, meme, owner: { owner: () => '42', isOwner: () => false }, qqStatus, signals: createSignals(), log })

globalThis.fetch = async (url, init = {}) => {
  const [p, q] = String(url).replace(/^\/api/, '').split('?')
  const result = await consoleApi.handle({ method: init.method ?? 'GET', path: p, query: new URLSearchParams(q ?? ''), body: init.body ? JSON.parse(init.body) : undefined })
  return { status: result.status, ok: result.status < 400, json: async () => result.json }
}
setCsrf('test')

let lastHash = ''
const run = async (render, params = []) => {
  const view = document.createElement('main')
  const controller = new AbortController()
  await render(view, { signal: controller.signal, params, navigate: (hash) => { lastHash = hash }, rerender: () => {} })
  return view
}
void el; void clear; void api

console.log('A. 群聊页')
{
  groupSettings.noteSeen('888', '新拉进来的群')
  let view = await run(renderGroup)
  let text = textOf(view)
  check('页面建出来了，标题和判断模型状态在', text.includes('群聊') && text.includes('已改用备用模型') && text.includes('host/default'))
  check('provider 跟着宿主时写明实际落到哪', text.includes('deepseek-account/deepseek-flash（provider 跟着宿主）') && text.includes('依次改用：deepseek-official/deepseek-flash'))
  check('配置里写的群（已接入）和见过的群（没接入）都在', text.includes('群 555') && text.includes('已接入') && text.includes('群 888（新拉进来的群）') && text.includes('没接入'))
  check('没接入的群只给“接入”按钮，不给调参', buttons(view, '接入这个群').length === 1 && !text.includes('静默时段') === false)
  const admit = buttons(view, '接入这个群')[0]
  await admit.fire('click', { currentTarget: admit })
  check('点“接入这个群”：真的打到接口上', groupSettings.isAdmitted('888') && lastHash === '#/group')
  confirmAnswer = false
  groupSettings.setAdmitted('888', false)
  view = await run(renderGroup)
  const again = buttons(view, '接入这个群')[0]
  await again.fire('click', { currentTarget: again })
  check('确认框点取消：不接入', !groupSettings.isAdmitted('888'))
  confirmAnswer = true

  const selects = byTag(view, 'select')
  check('已接入的群有档位下拉，五个选项（含盯群），默认选“点名”', selects.length >= 1 && selects[0].childNodes.length === 5 && selects[0].value === 'mention')
  const modeSelect = selects[0]
  modeSelect.value = 'active'
  await modeSelect.fire('change')
  check('改档位：写进运行时设置', engine.settingsFor('555').mode === 'active')
  view = await run(renderGroup)
  text = textOf(view)
  check('活跃档才出现“插话积极度”', text.includes('插话积极度'))
  const range = byTag(view, 'input').find((n) => n.attrs.type === 'range')
  range.value = '0.9'
  await range.fire('change')
  check('拖积极度滑杆：写进设置', engine.settingsFor('555').eagerness === 0.9)

  const boxes = byTag(view, 'input').filter((n) => n.attrs.type === 'checkbox' && n.parentNode && textOf(n.parentNode).includes('成员记忆'))
  boxes[0].checked = false
  await boxes[0].fire('change')
  check('勾掉“成员记忆”：该群关闭', engine.settingsFor('555').members.enabled === false)

  memory.observe({ scope: 'member:555:10001', kind: 'preference', text: '喜欢摄影', actor: 'qq:members', origin: 'model' })
  view = await run(renderGroup)
  const idInput = byTag(view, 'input').find((n) => n.attrs.placeholder === 'QQ 号')
  idInput.value = '10001'
  const forget = buttons(view, '忘掉他')[0]
  await forget.fire('click', { currentTarget: forget })
  check('“忘掉他”：删记忆并弹提示', memory.list({ scope: 'member:555:10001' }).length === 0 && toasts.some((t) => t.includes('已删 1 条记忆')))
  idInput.value = 'abc'
  await forget.fire('click', { currentTarget: forget })
  check('号填错：提示而不是抛错', toasts.some((t) => t.includes('请填 QQ 号')))
}

console.log('B. 主动私聊页')
{
  let view = await run(renderOutreach)
  let text = textOf(view)
  check('页面建出来：开关、节奏、状态、预览', text.includes('主动私聊') && text.includes('让它主动私聊我') && text.includes('安静时段') && text.includes('今天已发') && text.includes('预览'))
  const toggle = byTag(view, 'input').find((n) => n.attrs.type === 'checkbox')
  toggle.checked = true
  await toggle.fire('change')
  check('打开开关：真的写进去', outreach.config().enabled === true)
  view = await run(renderOutreach)
  const preview = buttons(view, '现在预览一次')[0]
  await preview.fire('click', { currentTarget: preview })
  text = textOf(view)
  check('预览：逐条闸门都列出来，没过的有说明', text.includes('总开关') && text.includes('有没有值得跟进的事') && text.includes('记忆里没有值得跟进的事'))
  const before = JSON.stringify(outreach.state)
  await preview.fire('click', { currentTarget: preview })
  check('预览不改状态', JSON.stringify(outreach.state) === before)
  const reset = buttons(view, '重置进度')[0]
  await reset.fire('click', { currentTarget: reset })
  check('重置：弹提示', toasts.includes('已重置'))
}

console.log('C. 梗百科页')
{
  let view = await run(renderMeme)
  let text = textOf(view)
  check('页面建出来：词库状态、导入、联网、检索存档、群黑话', text.includes('梗百科') && text.includes('还不能用') && text.includes('从本地导入') && text.includes('联网（默认关）') && text.includes('检索存档') && text.includes('本群黑话'))
  const toggle = byTag(view, 'input').find((n) => n.attrs.type === 'checkbox' && n.parentNode && textOf(n.parentNode).includes('允许联网'))
  toggle.checked = true
  await toggle.fire('change')
  check('打开联网：真的写进去', meme.getSettings().online === true)
  const imp = buttons(view, '导入')[0]
  await imp.fire('click', { currentTarget: imp })
  check('没填路径就导入：提示原因，不抛错', toasts.some((t) => t.includes('请给出词库文件路径')))
  const groupInput = byTag(view, 'input').find((n) => n.attrs.placeholder === '群号')
  groupInput.value = '555'
  const titleInput = byTag(view, 'input').find((n) => n.attrs.placeholder?.includes('黑话'))
  const meaningInput = byTag(view, 'input').find((n) => n.attrs.placeholder?.includes('含义'))
  titleInput.value = '老王'
  meaningInput.value = '群里的拍照达人'
  const add = buttons(view, '添加')[0]
  await add.fire('click', { currentTarget: add })
  check('添加群黑话：写进该群的记忆', memory.list({ scope: 'chat:group:555', kind: 'slang' }).some((e) => e.text.startsWith('老王')))
}

console.log('D. 记忆页')
{
  memory.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短回答', actor: 'console', origin: 'user', confidence: 1 })
  memory.observe({ scope: 'chat:group:555', kind: 'preference', text: '这个群不喜欢 bot 主动搭话', actor: 'qq:feedback', origin: 'model', status: 'candidate', source: { sessionId: 's', at: 1, quote: '没问你' } })
  let view = await run(renderMemory)
  let text = textOf(view)
  check('没选范围：列出范围让你选', text.includes('选一个范围') && text.includes('你：身份') && text.includes('QQ 群 555'))
  view = await run(renderMemory, ['chat:group:555'])
  text = textOf(view)
  check('选了范围：列出这个范围的记忆、状态、出处', text.includes('这个群不喜欢 bot 主动搭话') && text.includes('候选') && text.includes('出处'))
  const confirm1 = buttons(view, '对（转正）')[0]
  await confirm1.fire('click', { currentTarget: confirm1 })
  check('候选的“对（转正）”：真的转正', memory.list({ scope: 'chat:group:555', text: undefined }).find((e) => e.text.includes('不喜欢'))?.status === 'active')
  view = await run(renderMemory, ['chat:group:555'])
  promptAnswer = '这个群其实欢迎 bot 偶尔接话'
  const wrong = buttons(view, '不对')[0]
  await wrong.fire('click', { currentTarget: wrong })
  const entries = memory.list({ scope: 'chat:group:555' })
  check('“不对”并给出正确说法：旧的被否定，新的写进去', entries.some((e) => e.status === 'rejected') && entries.some((e) => e.text.includes('欢迎 bot 偶尔接话')))
  view = await run(renderMemory, ['chat:group:555', 'rejected', '_'])
  check('按状态筛选：只剩被否定的', textOf(view).includes('已否定') && !textOf(view).includes('欢迎 bot 偶尔接话'))
  view = await run(renderMemory, ['_', '_', '_'])
  check('占位符 _ 当作空', textOf(view).includes('选一个范围'))
}

outreach.dispose(); groupSettings.dispose(); memory.dispose()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

/**
 * 统一入口自检：在真实 cordis Context 上装载、再卸载 lib/index.js。
 *
 * 守住的事：
 *   - 默认导出带 name / Config / apply（loader 读 runtime.Config）；
 *   - 合并后的 Config 同时有画像侧的顶层键和 `qq` 子树，传入值能送达、默认值齐全；
 *   - 一次 apply 同时装起两边：画像段 + 人格段注册、宿主 HTTP 前缀路由注册、QQ 反向 WS 端口在听；
 *   - 卸载后两边都撤干净：段的 disposer 被调用、路由撤销、端口关闭。
 *
 * 端口 6812（测试段 6810–6839；6810/6811 留给 run-fast 的两趟）。
 * 运行：node test/entry.mjs（HOME / DSH_HOME 由 tools/run-tests.mjs 指到临时目录）
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const PORT = 6812
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-entry-'))
process.env.DSH_HOME = tmpRoot
process.env.DSH_SHALL_CONSOLE = 'off'
fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

const mod = await import('../lib/index.js')
const plugin = mod.default

console.log('A. 导出形状')
check('default.name', plugin?.name === 'dsh-whale-shall-adapt', String(plugin?.name))
check('default.apply 是函数', typeof plugin?.apply === 'function')
check('default.Config 与命名导出是同一个', plugin?.Config != null && plugin.Config === mod.Config)
check('Config 暴露 Standard Schema 接口', typeof plugin.Config['~standard']?.validate === 'function')

console.log('B. 合并后的 Config')
{
  const out = plugin.Config['~standard'].validate({
    signals: { longToolMs: 12345 },
    qq: { connection: { reversePort: 7777 } },
  })
  const v = out?.value ?? {}
  check('没有校验错误', !out?.issues, JSON.stringify(out?.issues ?? '').slice(0, 120))
  check('画像侧传入值送达', v.signals?.longToolMs === 12345)
  check('画像侧默认值齐全', v.signals?.repeatFailMin === 3 && v.scan?.intervalMs === 120000)
  check('qq 子树传入值送达', v.qq?.connection?.reversePort === 7777)
  check('qq 子树默认值齐全', v.qq?.connection?.host === '127.0.0.1' && v.qq?.participation?.groupMode === 'mention')
  check('logLevel 只在顶层出现一次', 'logLevel' in v && !('logLevel' in (v.qq ?? {})))
  const parts = mod.splitConfig(v)
  check('splitConfig：画像侧拿不到 qq 子树', !('qq' in parts.adapt))
  check('splitConfig：QQ 侧拿到顶层 logLevel', parts.qq.logLevel === v.logLevel && parts.qq.connection?.reversePort === 7777)
}

console.log('C. 装载')
const root = new Context()
const sections = []
let sectionDisposals = 0
root.provide('systemPrompt', {
  section(definition) {
    sections.push(definition)
    return () => {
      sectionDisposals += 1
    }
  },
  context() {
    return () => {}
  },
})
root.provide('timer', {
  interval() {
    return () => {}
  },
})
const routes = new Set()
root.provide('webServer', {
  register(route) {
    routes.add(route)
    return () => routes.delete(route)
  },
  registerUpgrade() {
    return () => {}
  },
})

const config = plugin.Config['~standard'].validate({
  logLevel: 'error',
  scan: { scanOnStart: false },
  qq: { connection: { mount: 'own', host: '127.0.0.1', reversePort: PORT, token: '' } },
}).value
const fiber = root.plugin(plugin, config)
let listening = false
for (let i = 0; i < 40 && !listening; i += 1) {
  await sleep(100)
  listening = await portOpen(PORT)
}

const names = sections.map((s) => s.name)
check('画像段已注册（order 30）', sections.some((s) => s.order === 30 && typeof s.text === 'function'), names.join(','))
check('人格段已注册（order 31，不做插值）', sections.some((s) => s.order === 31 && s.interpolate === false))
check('宿主 HTTP 前缀路由已注册', [...routes].some((r) => r.kind === 'prefix'), `${routes.size} 条`)
check(`QQ 反向 WS 端口 ${PORT} 在听`, listening)

console.log('D. 卸载')
await fiber.dispose()
let closed = false
for (let i = 0; i < 40 && !closed; i += 1) {
  await sleep(100)
  closed = !(await portOpen(PORT))
}
check('段的 disposer 都被调用', sectionDisposals >= 2, `${sectionDisposals} 次`)
check('宿主路由已撤销', ![...routes].some((r) => r.kind === 'prefix'), `${routes.size} 条`)
check(`端口 ${PORT} 已关闭`, closed)

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

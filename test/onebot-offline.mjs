/**
 * OneBot 断线看门狗：lib/qq/onebot/server.js。
 * NapCat 断开后迟迟不连回来要告警，连回来时报中断时长，插件自己关停不算掉线。
 * 本地起一个随机端口，用 ws 客户端模拟 NapCat。运行：node test/onebot-offline.mjs
 */
import http from 'node:http'
import { WebSocket } from 'ws'
import { OneBotReverseServer, formatDuration } from '../lib/qq/onebot/server.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lines = { info: [], warn: [] }
const log = {
  info: (m) => lines.info.push(m),
  warn: (m) => lines.warn.push(m),
  debug() {},
  error() {},
}

const server = new OneBotReverseServer({
  path: '/onebot',
  getToken: () => 'tok',
  log,
  onEvent() {},
  offlineWarnAfterMs: 80,
  offlineRepeatMs: 150,
})
const httpServer = http.createServer()
httpServer.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head))
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const url = `ws://127.0.0.1:${httpServer.address().port}/onebot`

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer tok', 'x-self-id': '42' } })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
const waitFor = async (pred, ms = 1000) => {
  const end = Date.now() + ms
  while (!pred() && Date.now() < end) await sleep(10)
  return pred()
}

check('formatDuration：秒 / 分钟 / 小时', formatDuration(5_000) === '5 秒' && formatDuration(120_000) === '2 分钟' && formatDuration(3_900_000) === '1 小时 5 分钟')
check('从没连过：不算掉线，快照里 offlineSince 为空', server.snapshot().offlineSince === null)

let ws = await connect()
await waitFor(() => server.connections.size === 1)
check('第一次连上：日志不带中断时长', lines.info.some((m) => m.includes('NapCat 已连接') && !m.includes('中断了')))
check('快照记下最近连上的时刻', typeof server.snapshot().lastConnectedAt === 'number')

ws.close()
await waitFor(() => server.connections.size === 0)
check('最后一条连接断开：记下断开时刻', typeof server.snapshot().offlineSince === 'number')
check('刚断开还在重连窗口内：先不告警', lines.warn.length === 0)

await waitFor(() => lines.warn.length >= 1, 1000)
check('断开超过阈值仍没连回来：告警一次', lines.warn.length === 1 && lines.warn[0].includes('仍未重连'), lines.warn[0])
check('告警里点出 NapCat 登录这个常见原因', lines.warn[0]?.includes('Login Error'))

await waitFor(() => lines.warn.length >= 2, 1000)
check('一直连不回来：按间隔再提醒', lines.warn.length >= 2)

ws = await connect()
await waitFor(() => server.connections.size === 1)
check('连回来：日志报中断了多久', lines.info.some((m) => m.includes('中断了')))
check('连回来：offlineSince 清空', server.snapshot().offlineSince === null)
const warnsBefore = lines.warn.length
await sleep(250)
check('连回来之后不再告警', lines.warn.length === warnsBefore)

ws.on('error', () => {})
await server.closeAll()
await sleep(200)
check('插件自己关停：不记成掉线、不告警', server.snapshot().offlineSince === null && lines.warn.length === warnsBefore)

httpServer.closeAllConnections?.()
await new Promise((resolve) => httpServer.close(resolve))
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

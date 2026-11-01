/**
 * OneBot 握手鉴权（lib/qq/onebot/server.js）：
 *   - 没配 token 默认**拒绝**（以前是放行，本机任何进程都能连进来伪造主人私聊）；
 *   - `allowNoToken` 打开才放行；
 *   - token 不匹配要拒，匹配才收。
 * 本地随机端口 + ws 客户端模拟 NapCat。运行：node test/onebot-auth.mjs
 */
import http from 'node:http'
import { WebSocket } from 'ws'
import { OneBotReverseServer } from '../lib/qq/onebot/server.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const warns = []
const log = { info() {}, debug() {}, error() {}, warn: (m) => warns.push(String(m)) }

/** 起一个只在测试里用的服务端；返回 { url, server, close } */
async function start({ token, allowNoToken }) {
  const server = new OneBotReverseServer({
    path: '/',
    getToken: () => token,
    log,
    onEvent() {},
    allowNoToken,
  })
  const httpServer = http.createServer()
  httpServer.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${httpServer.address().port}/`
  return {
    server,
    url,
    async close() {
      await server.closeAll()
      httpServer.closeAllConnections?.()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}

/** 尝试连一次；连上了返回 true，被拒返回 false（不管是 401 还是直接断开） */
function tryConnect(url, token) {
  return new Promise((resolve) => {
    const headers = { 'x-self-id': '42' }
    if (token) headers.authorization = `Bearer ${token}`
    const ws = new WebSocket(url, { headers })
    const done = (ok) => {
      try {
        ws.close()
      } catch {
        /* 已经关了 */
      }
      resolve(ok)
    }
    ws.once('open', () => done(true))
    ws.once('error', () => done(false))
    ws.once('close', () => done(false))
  })
}

console.log('A. 没配 token：默认拒绝')
{
  const ctx = await start({ token: '', allowNoToken: false })
  const ok = await tryConnect(ctx.url)
  const snap = ctx.server.snapshot()
  check('不带 token 连不进来', ok === false)
  check('计进 rejectedNoToken', snap.rejectedNoToken === 1, String(snap.rejectedNoToken))
  check('日志说清怎么配', warns.some((w) => w.includes('SHALL_ONEBOT_TOKEN')), warns.join(' | '))
  check('快照里 active 为 0', snap.active === 0)
  await ctx.close()
}

console.log('B. 配了 token：错的不行、对的可以')
{
  const ctx = await start({ token: 'right-token', allowNoToken: false })
  check('不带 token：拒', (await tryConnect(ctx.url)) === false)
  check('错 token：拒', (await tryConnect(ctx.url, 'wrong-token')) === false)
  check('拒绝数计了两次', ctx.server.snapshot().rejectedAuth === 2, String(ctx.server.snapshot().rejectedAuth))
  check('日志里不出现 token 片段', !warns.some((w) => w.includes('wrong') || /token 不匹配.*[A-Za-z0-9]{4}…/.test(w)), warns.join(' | '))
  check('对 token：收', (await tryConnect(ctx.url, 'right-token')) === true)
  check('连接数 +1', ctx.server.snapshot().active === 1, String(ctx.server.snapshot().active))
  await ctx.close()
}

console.log('C. allowNoToken=true：放行但告警')
{
  const ctx = await start({ token: '', allowNoToken: true })
  check('不带 token 也能连', (await tryConnect(ctx.url)) === true)
  check('日志明确说本机谁都能接', warns.some((w) => w.includes('allowNoToken')), warns.join(' | '))
  await ctx.close()
}

console.log('D. 关停之后不再接受连接')
{
  const ctx = await start({ token: 't', allowNoToken: false })
  await ctx.close()
  check('关停后连不上', (await tryConnect(ctx.url, 't')) === false)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

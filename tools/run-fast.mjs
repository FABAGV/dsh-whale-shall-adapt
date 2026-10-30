// 快版编排器：一轮 = 起 test-entry + 起 mock-napcat，等汇总出现。
//
// 与 run-round.mjs 的差别只有**等待策略**（不改被测代码、不改断言）：
//   1. 不再死等 6 秒才起 mock —— 改为轮询"端口已被插件监听"，通常 1—2 秒就绪
//   2. 汇总轮询间隔 250ms（原 2000ms），最多白等 250ms 而不是 2000ms
//   3. 支持一次跑多趟（--rounds 0,1）：**并行**起，端口/项目目录/DSH_HOME/tag 各自独立
//
// 用法：
//   node run-fast.mjs --base-port 6730 --rounds 0,1 --tag fast
//   node run-fast.mjs --base-port 6730 --rounds 1 --tag only1
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

const BASE_PORT = Number(arg('base-port', '6730'))
const ROUNDS = String(arg('rounds', '0,1'))
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
const TAGPREFIX = arg('tag', 'fast')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENVDIR = arg('env-dir', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qq-fast-'))
const TIMEOUT_MS = Number(arg('timeout', '300000'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 端口是否已经有人监听（插件 own 模式自建服务端） */
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      try {
        sock.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
    }
    sock.setTimeout(400, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

const SUMMARY_RE = /全部通过：\d+\/\d+|通过，失败 \d+ 条/

async function runRound(conv, port) {
  const tag = `${TAGPREFIX}-conv${conv}`
  const OUT = path.join(ENVDIR, `${tag}.log`)
  const MOCKOUT = path.join(ENVDIR, `${tag}-mock.log`)
  const env = {
    ...process.env,
    ENTRY_PORT: String(port),
    ENTRY_ROOT: path.join(ENVDIR, `projects-${tag}`),
    DSH_HOME: path.join(ENVDIR, `dshhome-${tag}`),
    ENTRY_CONV: conv,
    HOME: path.join(ENVDIR, `home-${tag}`),
    USERPROFILE: path.join(ENVDIR, `home-${tag}`),
  }

  const fdOut = fs.openSync(OUT, 'w')
  const fdErr = fs.openSync(OUT, 'a')
  const test = spawn('node', ['tools/qq-entry.mjs'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fdOut, fdErr],
    windowsHide: true,
  })
  const t0 = Date.now()
  console.log(`[${tag}] test pid=${test.pid} port=${port} → ${OUT}`)

  let testExit = null
  test.on('exit', (code) => {
    testExit = code
  })

  // ① 等端口被插件真正监听起来（原版死等 6 秒，这里通常 1—2 秒）
  let ready = false
  const readyDeadline = Date.now() + 30000
  while (Date.now() < readyDeadline) {
    if (testExit !== null) break
    if (await portOpen(port)) {
      ready = true
      break
    }
    await sleep(120)
  }
  console.log(`[${tag}] 端口就绪=${ready}（${Date.now() - t0}ms）`)

  // ② mock 客户端（--once：跑完自己的脚本就退场）
  const mock = spawn('node', ['tools/mock-napcat.mjs', '--once', '--url', `ws://127.0.0.1:${port}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fs.openSync(MOCKOUT, 'w'), fs.openSync(MOCKOUT, 'a')],
    windowsHide: true,
  })
  mock.on('exit', (code) => console.log(`[${tag}] mock exited code=${code}`))

  // ③ 等汇总（原版 2 秒一轮，这里 250ms）
  let summary = false
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (SUMMARY_RE.test(fs.readFileSync(OUT, 'utf8'))) {
        summary = true
        break
      }
    } catch {
      /* 文件还没落地 */
    }
    if (testExit !== null) break
    await sleep(250)
  }
  await sleep(400)

  for (const proc of [mock, test]) {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }
  }
  try {
    fs.closeSync(fdOut)
    fs.closeSync(fdErr)
  } catch {
    /* 忽略 */
  }

  const text = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  const totals = [...text.matchAll(/^=========== (.+) ===========\n[\s\S]*?\n  (\d+)\/(\d+) 通过/gm)].map(
    (m) => `${m[1]} ${m[2]}/${m[3]}`,
  )
  const fails = [...text.matchAll(/^     - (.+)$/gm)].map((m) => m[1])
  const ok = (text.match(/✅ 全部通过：(\d+)\/(\d+)/) || [])[0] ?? ''
  console.log(`[${tag}] 汇总=${summary} 用时=${Math.round((Date.now() - t0) / 1000)}s ${ok}`)
  if (fails.length > 0) console.log(`[${tag}] 失败 ${fails.length} 条：\n  - ${fails.join('\n  - ')}`)
  return { tag, summary, ok, totals, fails, ms: Date.now() - t0 }
}

const results = await Promise.all(ROUNDS.map((conv, i) => runRound(conv, BASE_PORT + i)))
console.log('\n===== 汇总 =====')
for (const r of results) {
  console.log(`${r.tag}: ${r.ok || '(没有汇总)'} | ${r.totals.join(' / ')}`)
}
process.exitCode = results.some((r) => r.fails.length > 0 || !r.ok) ? 1 : 0

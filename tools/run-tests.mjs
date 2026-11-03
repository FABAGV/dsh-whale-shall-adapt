// 跑全部测试：test/*.mjs 逐个跑，再用 run-fast 跑 QQ 入口集成测试。
//
// 每个测试进程的 HOME / USERPROFILE / DSH_HOME 都指到新建的临时目录，
// 并设 DSH_SHALL_CONSOLE=off，保证不碰真实 ~/.dsh、不占 6710。
//
// 用法：
//   node tools/run-tests.mjs                 全部
//   node tools/run-tests.mjs --only privacy  只跑文件名含 privacy 的 test/*.mjs（不跑 QQ 集成测试）
//   node tools/run-tests.mjs --no-qq         不跑 QQ 集成测试
//   node tools/run-tests.mjs --qq-port 6810  QQ 集成测试的端口（默认 6810）
//   node tools/run-tests.mjs --timeout 120   单个测试文件的超时秒数（默认 120；QQ 集成至少 300）
//
// 退出码：0 全过；1 有失败；2 缺少宿主 peer 依赖（@deepseek-ai/cordis / schemastery），
// 这时不跑任何文件 —— 否则会看到十几个 ERR_MODULE_NOT_FOUND，和真正的失败混在一起。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const only = arg('only', '')
const noQq = argv.includes('--no-qq') || Boolean(only)
const qqPort = arg('qq-port', '6810')
const timeoutSec = Math.max(5, Number(arg('timeout', '120')) || 120)
const timeoutMs = timeoutSec * 1000

// 排障脚本（读写真实 $DSH_HOME、要真实语料当标尺），挪到 tools/diag/ 之后不再参与全量跑
const SKIP = new Set()

// ── 前置检查：宿主提供的两个 peer 依赖 ────────────────────────────────
const require = createRequire(import.meta.url)
const missing = []
for (const pkg of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  try {
    require.resolve(`${pkg}/package.json`)
  } catch {
    missing.push(pkg)
  }
}
if (missing.length > 0) {
  console.error(
    `缺少宿主提供的依赖：${missing.join('、')}\n` +
      '这些都是 DSH 运行时提供的 peer（不进仓库）。本机开发时二选一：\n' +
      '  1) npm install --no-save --no-package-lock @deepseek-ai/cordis@4 @deepseek-ai/schemastery@3\n' +
      '  2) 把它们从 DSH 安装目录联接（junction）到 node_modules/@deepseek-ai 下\n' +
      '（README「开发与测试」一节有完整说明）',
  )
  process.exit(2)
}

function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-test-'))
  return {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: path.join(home, '.dsh'),
      DSH_SHALL_CONSOLE: 'off',
    },
    home,
  }
}

/**
 * 跑一个子进程。
 *
 * ⚠️ 监听 `close` 而不是 `exit`：`exit` 可能在 stdout 还没读完时就触发，
 * 最后那行"结果：N 通过 / M 失败"会丢失，测试被误判成"没有结果行"。
 * ⚠️ 必须有超时：漏关一个句柄（曾经的 process.exit on Windows）就会一直挂着。
 */
function run(cmd, args, env, limitMs = timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, limitMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 'timeout' : code, out, timedOut })
    })
  })
}

/** 临时 HOME 用完就删；删不掉（Windows 文件占用）只留一点垃圾 */
function cleanupHome(home) {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* 删不掉就算了 */
  }
}

const files = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.mjs') && !SKIP.has(f) && (!only || f.includes(only)))
  .sort()

let failedFiles = 0
let pass = 0
let fail = 0
for (const f of files) {
  const { env, home } = isolatedEnv()
  const { code, out, timedOut } = await run(process.execPath, [path.join('test', f)], env)
  cleanupHome(home)
  const m = [...out.matchAll(/结果：(\d+) 通过 \/ (\d+) 失败/g)].pop()
  const p = m ? Number(m[1]) : 0
  const n = m ? Number(m[2]) : 0
  pass += p
  fail += n
  const bad = timedOut || code !== 0 || !m || n > 0
  if (bad) failedFiles += 1
  const head = timedOut ? `超时（>${timeoutSec}s，已终止）` : m ? `${p} 通过 / ${n} 失败` : '（没有结果行）'
  console.log(`${bad ? '✗' : '✓'} test/${f}  ${head}  exit=${code}`)
  if (bad) {
    const lines = out.split(/\r?\n/).filter((l) => /✗|FAIL|失败|Error|error/.test(l))
    console.log(lines.slice(0, 30).map((l) => `    ${l}`).join('\n'))
  }
}
console.log(`\ntest/*.mjs：${files.length} 个文件，${pass} 通过 / ${fail} 失败，${failedFiles} 个文件不过`)

let qqBad = false
if (!noQq) {
  // 集成测试一轮要起真实进程、跑假 NapCat、等超时重试，比单文件测试慢得多（Windows 上实测 150s+）。
  // 不能沿用单文件的 --timeout，否则会在全部通过前被 SIGKILL。
  const qqLimitMs = Math.max(timeoutMs, 300_000)
  const { env, home } = isolatedEnv()
  const { code, out, timedOut } = await run(
    process.execPath,
    ['tools/run-fast.mjs', '--base-port', qqPort, '--rounds', '1', '--tag', 'all'],
    env,
    qqLimitMs,
  )
  cleanupHome(home)
  const tail = out.split(/\r?\n/).filter((l) => /汇总|失败|全部通过|^\s+- /.test(l))
  console.log(`\nQQ 入口集成测试（tools/qq-entry.mjs）exit=${code}${timedOut ? `（超时 >${Math.round(qqLimitMs / 1000)}s）` : ''}`)
  console.log(tail.map((l) => `  ${l}`).join('\n'))
  qqBad = code !== 0
}

process.exitCode = failedFiles > 0 || qqBad ? 1 : 0

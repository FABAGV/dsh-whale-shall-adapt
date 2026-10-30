// 跑全部测试：test/*.mjs 逐个跑，再用 run-fast 并行跑 QQ 入口集成测试两趟。
//
// 每个测试进程的 HOME / USERPROFILE / DSH_HOME 都指到新建的临时目录，
// 并设 DSH_SHALL_CONSOLE=off，保证不碰真实 ~/.dsh、不占 6710。
//
// 用法：
//   node tools/run-tests.mjs                 全部
//   node tools/run-tests.mjs --only privacy  只跑文件名含 privacy 的 test/*.mjs（不跑 QQ 两趟）
//   node tools/run-tests.mjs --no-qq         不跑 QQ 两趟
//   node tools/run-tests.mjs --qq-port 6810  QQ 两趟的起始端口（默认 6810，S1 段）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

// parity 要真实会话日志当标尺；inspect-signals / verify-incremental 是排障脚本，会读写真实 $DSH_HOME。
const SKIP = new Set(['parity.mjs', 'inspect-signals.mjs', 'verify-incremental.mjs'])

function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-test-'))
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(home, '.dsh'),
    DSH_SHALL_CONSOLE: 'off',
  }
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

const files = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.mjs') && !SKIP.has(f) && (!only || f.includes(only)))
  .sort()

let failedFiles = 0
let pass = 0
let fail = 0
for (const f of files) {
  const { code, out } = await run(process.execPath, [path.join('test', f)], isolatedEnv())
  const m = [...out.matchAll(/结果：(\d+) 通过 \/ (\d+) 失败/g)].pop()
  const p = m ? Number(m[1]) : 0
  const n = m ? Number(m[2]) : 0
  pass += p
  fail += n
  const bad = code !== 0 || !m || n > 0
  if (bad) failedFiles += 1
  console.log(`${bad ? '✗' : '✓'} test/${f}  ${m ? `${p} 通过 / ${n} 失败` : '（没有结果行）'}  exit=${code}`)
  if (bad) {
    const lines = out.split(/\r?\n/).filter((l) => /✗|FAIL|失败|Error|error/.test(l))
    console.log(lines.slice(0, 30).map((l) => `    ${l}`).join('\n'))
  }
}
console.log(`\ntest/*.mjs：${files.length} 个文件，${pass} 通过 / ${fail} 失败，${failedFiles} 个文件不过`)

let qqBad = false
if (!noQq) {
  const { code, out } = await run(
    process.execPath,
    ['tools/run-fast.mjs', '--base-port', qqPort, '--rounds', '0,1', '--tag', 'all'],
    isolatedEnv(),
  )
  const tail = out.split(/\r?\n/).filter((l) => /汇总|失败|全部通过|^\s+- /.test(l))
  console.log(`\nQQ 入口集成测试（tools/qq-entry.mjs 两趟）exit=${code}`)
  console.log(tail.map((l) => `  ${l}`).join('\n'))
  qqBad = code !== 0
}

process.exitCode = failedFiles > 0 || qqBad ? 1 : 0

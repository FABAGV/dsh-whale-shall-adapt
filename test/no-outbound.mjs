/**
 * 出站请求的静态边界：lib/ 里除了两个白名单文件，任何地方都不许发网络请求。
 *
 * 为什么单独一个文件：selftest 里的同类检查只覆盖手工列出的 18 个宿主文件，
 * 新代码（QQ 侧、会话侧、群引擎、记忆、梗百科）根本不在名单里 —— 以后加一次 `fetch` 它不会报。
 * 这里改成**递归扫整个 lib/**，新增出站请求必须来白名单登记，README 里"唯一出站"那句才有依据。
 *
 * 运行：node test/no-outbound.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { QCE_DEFAULT_URL } from '../lib/qq/qce-client.js'
import { API_BASE as MEME_API_BASE } from '../lib/meme/sync.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const LIB = path.join(import.meta.dirname, '..', 'lib')

/**
 * 允许发出站请求的文件。每一项都要写清为什么、发到哪。
 * `ui/` 整个目录不扫：client.js / console/*.js 是**浏览器里**跑的页面代码，
 * 它们 fetch 的是本机自己的控制台接口；console-server.js 只被动监听 127.0.0.1。
 */
const ALLOW = new Map([
  ['meme/sync.js', '梗百科联网查词 / 同步：https://cnmeme.wiki 公开只读接口，默认关，用户手动打开才用'],
  ['qq/qce-client.js', 'QQ Chat Exporter 客户端：只连本机（默认 http://127.0.0.1:40653），用户手动导入人格素材才用'],
])

// 抓"发起请求"的几种写法；注释行与字符串里的说明不算
const PATTERNS = [
  /\bfetch\s*\(/,
  /\bthis\.fetchImpl\s*\(/,
  /\bfetchImpl\s*\(/,
  /\bhttp\.(request|get)\s*\(/,
  /\bhttps\.(request|get)\s*\(/,
  /\bnet\.connect\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  /\bnew\s+http\.Agent\s*\(/,
]

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // ui/client*、ui/console 是浏览器侧；node_modules 不扫
      if (entry.name === 'node_modules' || entry.name === 'console') continue
      walk(full, out)
    } else if (entry.name.endsWith('.js')) {
      const rel = path.relative(LIB, full).split(path.sep).join('/')
      if (rel.startsWith('ui/client')) continue
      out.push({ full, rel })
    }
  }
  return out
}

const hits = []
let scanned = 0
for (const { full, rel } of walk(LIB)) {
  scanned += 1
  if (ALLOW.has(rel)) continue
  const lines = fs.readFileSync(full, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    if (PATTERNS.some((re) => re.test(line))) hits.push(`${rel}:${index + 1}  ${line.trim().slice(0, 100)}`)
  })
}

check('lib/ 下（除白名单）没有任何出站请求的写法', hits.length === 0, hits.slice(0, 8).join(' | '))
check('确实扫到了文件（不是扫空了）', scanned > 50, `${scanned} 个文件`)
check('白名单里的文件都还在（名单没烂掉）', [...ALLOW.keys()].every((rel) => fs.existsSync(path.join(LIB, rel))))

console.log('B. 两个白名单出口的地址')
check('梗百科接口是 https 的固定地址', MEME_API_BASE.startsWith('https://'), MEME_API_BASE)
check('QQ Chat Exporter 默认只连本机回环地址',
  /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(QCE_DEFAULT_URL) || QCE_DEFAULT_URL.startsWith('http://127.0.0.1:'), QCE_DEFAULT_URL)

const qceSrc = fs.readFileSync(path.join(LIB, 'qq', 'qce-client.js'), 'utf8')
check('QCE 地址校验只接受 http(s)', /protocol !== 'http:'/.test(qceSrc) && /protocol !== 'https:'/.test(qceSrc))
check('QCE 会读安全文件里的 token（不裸奔）', /securityFile/.test(qceSrc))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

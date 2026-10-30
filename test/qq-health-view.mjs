/**
 * QQ 体检视图（lib/ui/qq-health.js）、快照登记对象（lib/index.js 的 createQqStatus）
 * 与控制台路由 GET /api/qq/health。纯本地。运行：node test/qq-health-view.mjs
 */
import { buildHealthView, minimalHealth, nextStepFor, humanDuration, humanBytes } from '../lib/ui/qq-health.js'
import { createQqStatus } from '../lib/index.js'
import { createConsoleApi } from '../lib/ui/console-api.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const healthy = {
  version: '0.3.0',
  now: 1_800_000_000_000,
  health: { verdict: 'ok', issues: [], ok: ['协议端已接入（123）'] },
  alive: { alive: true, because: ['连接 selfId=123 已打开'], evidence: { silentForMs: 1200, lastEventAt: 1, sinceTickMs: 300, eventSilenceMs: 90_000 } },
  config: { mode: 'reverse', mount: 'own', port: 6700, path: '/', authRequired: true, groupMode: 'mention', workspaceRoot: 'D:\\qq', handoffAtRatio: 0.25 },
  connection: { active: 1, selfIds: ['123'] },
  corpus: { chats: 2, bytes: 4096, retainDays: 30 },
  pipeline: { stats: { messages: 9, events: 20, duplicates: 1, outOfScope: 0 } },
  relay: { provenanceDecided: 4, skippedForeign: 0 },
  conversation: {
    chats: [{ chatName: '测试群', generation: 2, totalTokens: 31000.4, progressPercent: 12 }],
    idle: { enabled: true, idleMinutes: 20, idleMinTurns: 3, runs: 2, extracted: 5 },
  },
  logFile: 'C:\\x\\plugin.log',
  warnings: [],
}

console.log('A. 体检视图')
{
  const view = buildHealthView(healthy)
  check('一切正常', view.verdict.tone === 'ok' && view.verdict.title === '一切正常' && view.issues.length === 0)
  check('存活判据逐条带出', view.alive.alive && view.alive.because[0].includes('selfId=123'))
  check('静默时间写成人话', view.alive.silence === '最后事件 1 秒前' && view.alive.silenceLimit === '1.5 分钟', view.alive.silence)
  check('关键状态里有工作区、语料库、空闲整理', view.facts.some((f) => f.value === 'D:\\qq')
    && view.facts.some((f) => f.note.includes('4.0 KB')) && view.facts.some((f) => f.label === '空闲整理' && f.value === '已整理 2 次'))
  check('交班表：取整、百分比', view.chats[0].name === '测试群' && view.chats[0].totalTokens === 31000 && view.chats[0].progressPercent === 12)
  check('配置摘要和通过项', view.config.some((c) => c.value.includes('端口 6700')) && view.passed.length === 1)

  const bad = buildHealthView({ ...healthy, health: { verdict: 'attention', issues: ['tasks.workspaceRoot 未配置', '未配置 access token', '某种没见过的错误'], ok: [] } })
  check('有问题时给条数', bad.verdict.tone === 'warn' && bad.verdict.title === '有 3 项需要处理')
  check('认得的问题给下一步，认不出的不硬编', bad.issues[0].nextStep.includes('绝对路径') && bad.issues[1].nextStep.includes('SHALL_ONEBOT_TOKEN') && bad.issues[2].nextStep === '')

  const empty = buildHealthView({})
  check('空快照：状态还不完整，不假装健康', empty.verdict.title === '状态还不完整' && !JSON.stringify(empty).includes('undefined') && !JSON.stringify(empty).includes('NaN'))
  check('连接没初始化时如实写', empty.facts[0].value === '未初始化')
  const never = buildHealthView({ alive: { evidence: { silentForMs: 0 } } })
  check('从没收到事件写“尚未收到事件”，不写 0 毫秒前', never.alive.silence === '尚未收到事件')
  check('静默时间未知时写未知', buildHealthView({ alive: { evidence: { silentForMs: null } } }).alive.silence === '最后事件时间未知')
}

console.log('B. 下一步与格式化')
{
  check('webServer 未就绪指向 DSH', nextStepFor('连接层未初始化（webServer 服务未就绪）').includes('DSH 的 Web 服务'))
  check('交班异常指向日志', nextStepFor('交班流程异常：x').includes('plugin.log'))
  check('humanDuration', humanDuration(120) === '120 毫秒' && humanDuration(5_400_000) === '1.5 小时' && humanDuration(null) === '—')
  check('humanBytes', humanBytes(900) === '900 B' && humanBytes(3 * 1024 * 1024) === '3.0 MB')
}

console.log('C. OneBot 端口上的最小健康检查')
{
  const mini = minimalHealth(healthy)
  check('只有五项', Object.keys(mini).sort().join() === 'alive,connections,detail,ok,version')
  check('不带任何身份信息', !/123|D:|plugin\.log|测试群/.test(JSON.stringify(mini)))
  check('值对得上', mini.ok && mini.alive && mini.connections === 1)
}

console.log('D. 登记对象与控制台路由')
{
  const qqStatus = createQqStatus()
  const api = createConsoleApi({ service: {}, policy: {}, scanner: {}, personas: {}, skills: {}, workbench: {}, jobs: {}, config: {}, qqStatus })
  const none = await api.handle({ method: 'GET', path: '/qq/health', query: new URLSearchParams() })
  check('QQ 没启动：503', none.status === 503)
  const off = qqStatus.register(() => healthy)
  const got = await api.handle({ method: 'GET', path: '/qq/health', query: new URLSearchParams() })
  check('登记后返回体检视图', got.status === 200 && got.json.verdict.title === '一切正常' && Array.isArray(got.json.facts))
  off()
  check('取消登记后回到 null', qqStatus.snapshot() === null)
  const stale = qqStatus.register(() => 1)
  qqStatus.register(() => 2)
  stale()
  check('旧的取消函数不会撤掉新登记的', qqStatus.snapshot() === 2)
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

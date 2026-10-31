/**
 * 群聊回复决策的配置（docs/CONTRACTS.md 第 8 节）。
 *
 * 档位（用户已定，默认“点名”）：
 *   silent   潜水：只记录，不发言
 *   mention  点名：被叫到才回（@、回复 bot、叫名字/别名、戳一戳）
 *   present  在场：点名之后一段时间里，被回复过的人接着说可以不再 @
 *   active   活跃：没人叫也可能插话，由便宜模型判断，受精力约束
 *   watch    盯群：群里说的话攒一小批就交给常驻会话看，由主模型自己决定接不接（不经过便宜模型），受看群间隔和次数约束
 *
 * 每个群可以单独设置（`templates[群号]`，或控制台写进 groups.json 的运行时设置），不设就用这里的全局默认值。
 * 精力的初始值和速率照天使之心（angel_heart）的默认值，写成具名常量。
 */

export const GROUP_MODES = ['silent', 'mention', 'present', 'active', 'watch']

export const GROUP_DEFAULTS = Object.freeze({
  defaultMode: 'mention',
  /**
   * 活跃档的判断模型。provider 留空 = 跟宿主当前用的 provider（桌面端账号登录是 deepseek-account，
   * 填了 API key 是 deepseek-official），模型名照这里。不可用时退回宿主默认模型，并在状态里说明
   */
  judge: Object.freeze({ provider: '', model: 'deepseek-flash', timeoutMs: 15000 }),
  /** 在场档：点名之后保持在场多久、最多接几条 */
  present: Object.freeze({ minutes: 8, messages: 12 }),
  /** 等时机：群里安静这么久才判断；新消息会替换触发点；最长等这么久 */
  timing: Object.freeze({ quietMs: 4000, maxWaitMs: 20000 }),
  /** 精力：初始值、下限、每秒恢复、每次发言扣 base + 字数 × perChar；低于 minToSpeak 不主动插话 */
  energy: Object.freeze({ initial: 100, floor: -100, recoverPerSec: 0.6, base: 14, perChar: 0.12, minToSpeak: 20 }),
  /** 预算：每小时主动插话上限、两次主动插话的最短间隔、同一个人刷 bot 的限额 */
  budget: Object.freeze({ perHour: 8, cooldownMs: 45000, perSenderCalls: 6, perSenderWindowMs: 60000 }),
  /** 对话疲劳：连续主动聊了几条之后，插话门槛开始升高 */
  fatigue: Object.freeze({ afterReplies: 4, step: 0.5, resetMs: 10 * 60 * 1000 }),
  /**
   * 盯群档：两次"看一眼"至少隔多久、每小时最多看几次、一眼最多带几条 / 多少字。
   * 每看一眼就是常驻会话的一个回合（主模型），所以有上限；主动说话的次数另受 budget.perHour 约束
   */
  watch: Object.freeze({ minIntervalMs: 30000, perHour: 40, messages: 30, chars: 3000 }),
  /** 静默时段（本地时间 HH:MM）：这段时间不主动插话，被叫到照常回。两项都空 = 不设 */
  quietHours: Object.freeze({ start: '', end: '' }),
  /** 插话积极度 0–1：同时调整判断阈值和精力消耗 */
  eagerness: 0.5,
  /** 对话收尾后，这么久不靠概率或在场状态插话；被叫到照常回 */
  closureMs: 20 * 60 * 1000,
  /** 被叫到时带上群里最近 N 条（按条数和字数两道上限），只作本轮背景 */
  context: Object.freeze({ messages: 20, chars: 1500, maxAgeMs: 30 * 60 * 1000 }),
  /** 群里回复的形式 */
  reply: Object.freeze({ quote: true, maxChars: 400, typingMsPerChar: 40, typingMaxMs: 2500 }),
  /** 另一个 bot 连环 @ 本 bot 时的保护：这段时间内最多响应几次 */
  botLoop: Object.freeze({ windowMs: 10 * 60 * 1000, maxCalls: 2 }),
  /** 连续这么多轮没开口，下一次提示里追加一句提醒（防止“可以不说”退化成“永远不说”） */
  silentReminderAfter: 6,
  /**
   * 群成员记忆（默认开）：每位群友的称呼、关系、偏好、说话风格，只在该群可见。
   * 从语料库里提取，每个群每 everyHours 小时最多一次，每次最多处理 maxPerRun 位新发言不少于 minMessages 条的群友。
   */
  members: Object.freeze({ enabled: true, maxPerRun: 20, everyHours: 6, minMessages: 5, days: 14 }),
  /** 冷启动：第一次接入一个群时，若最近 days 天语料里至少有 minMessages 条，生成一份群概况（候选记忆，等你在控制台转正） */
  coldStart: Object.freeze({ enabled: true, minMessages: 200, days: 30 }),
  /** 按群覆盖：{ '123456': { mode: 'active', eagerness: 0.7, ... } } */
  templates: Object.freeze({}),
})

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

/** 深合并，数组和标量直接替换 */
function merge(base, extra) {
  if (!isObject(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function num(value, fallback, lo, hi, warnings, label) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < lo || n > hi) {
    warnings.push(`${label}="${value}" 非法（需要 ${lo}–${hi}），已回退为 ${fallback}`)
    return fallback
  }
  return n
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** 把一份（全局或单群的）设置整理成可用形状；非法值回退默认并记警告 */
export function normalizeSettings(raw, base, warnings, label) {
  const out = merge(base, raw)
  if (!GROUP_MODES.includes(out.mode ?? out.defaultMode)) {
    warnings.push(`${label}.mode="${out.mode ?? out.defaultMode}" 无法识别，已回退为 ${base.mode ?? base.defaultMode}`)
    if ('mode' in out) out.mode = base.mode
    else out.defaultMode = base.defaultMode
  }
  out.eagerness = clamp(num(out.eagerness, base.eagerness, 0, 1, warnings, `${label}.eagerness`), 0, 1)
  out.present.minutes = num(out.present.minutes, base.present.minutes, 0, 24 * 60, warnings, `${label}.present.minutes`)
  out.present.messages = num(out.present.messages, base.present.messages, 0, 500, warnings, `${label}.present.messages`)
  out.timing.quietMs = num(out.timing.quietMs, base.timing.quietMs, 0, 120000, warnings, `${label}.timing.quietMs`)
  out.timing.maxWaitMs = num(out.timing.maxWaitMs, base.timing.maxWaitMs, 0, 600000, warnings, `${label}.timing.maxWaitMs`)
  if (out.timing.maxWaitMs < out.timing.quietMs) out.timing.maxWaitMs = out.timing.quietMs
  out.budget.perHour = num(out.budget.perHour, base.budget.perHour, 0, 600, warnings, `${label}.budget.perHour`)
  out.budget.cooldownMs = num(out.budget.cooldownMs, base.budget.cooldownMs, 0, 3600000, warnings, `${label}.budget.cooldownMs`)
  out.reply.maxChars = num(out.reply.maxChars, base.reply.maxChars, 40, 4000, warnings, `${label}.reply.maxChars`)
  out.members.maxPerRun = num(out.members.maxPerRun, base.members.maxPerRun, 1, 100, warnings, `${label}.members.maxPerRun`)
  out.members.everyHours = num(out.members.everyHours, base.members.everyHours, 0.1, 24 * 30, warnings, `${label}.members.everyHours`)
  out.members.minMessages = num(out.members.minMessages, base.members.minMessages, 1, 1000, warnings, `${label}.members.minMessages`)
  out.members.days = num(out.members.days, base.members.days, 1, 90, warnings, `${label}.members.days`)
  out.coldStart.minMessages = num(out.coldStart.minMessages, base.coldStart.minMessages, 10, 100000, warnings, `${label}.coldStart.minMessages`)
  out.coldStart.days = num(out.coldStart.days, base.coldStart.days, 1, 90, warnings, `${label}.coldStart.days`)
  out.closureMs = num(out.closureMs, base.closureMs, 0, 24 * 3600000, warnings, `${label}.closureMs`)
  out.watch.minIntervalMs = num(out.watch.minIntervalMs, base.watch.minIntervalMs, 5000, 3600000, warnings, `${label}.watch.minIntervalMs`)
  out.watch.perHour = num(out.watch.perHour, base.watch.perHour, 1, 360, warnings, `${label}.watch.perHour`)
  out.watch.messages = num(out.watch.messages, base.watch.messages, 1, 60, warnings, `${label}.watch.messages`)
  out.watch.chars = num(out.watch.chars, base.watch.chars, 200, 12000, warnings, `${label}.watch.chars`)
  for (const key of ['start', 'end']) {
    const value = String(out.quietHours?.[key] ?? '')
    if (value && !HHMM.test(value)) {
      warnings.push(`${label}.quietHours.${key}="${value}" 不是 HH:MM，已忽略静默时段`)
      out.quietHours = { start: '', end: '' }
      break
    }
  }
  return out
}

/**
 * 解析全局 `group` 配置。
 * @returns {object} 全局设置 + `warnings`
 */
export function resolveGroupConfig(raw = {}) {
  const warnings = []
  const normalized = normalizeSettings(isObject(raw) ? raw : {}, JSON.parse(JSON.stringify(GROUP_DEFAULTS)), warnings, 'group')
  const templates = {}
  for (const [groupId, template] of Object.entries(isObject(raw?.templates) ? raw.templates : {})) {
    if (/^\d{1,12}$/.test(groupId) && isObject(template)) templates[groupId] = template
    else warnings.push(`group.templates 里的“${groupId}”不是群号或不是对象，已忽略`)
  }
  normalized.templates = templates
  return { ...normalized, warnings }
}

/**
 * 某个群实际生效的设置：全局默认 ← 配置里的模板 ← 控制台写下的运行时设置。
 * @param {object} config resolveGroupConfig 的结果
 * @param {string} groupId
 * @param {object} [runtime] groups.json 里这个群的设置
 */
export function settingsForGroup(config, groupId, runtime = null) {
  const warnings = []
  const { templates, warnings: _ignored, ...globals } = config
  const base = { ...globals, mode: globals.defaultMode }
  const withTemplate = normalizeSettings(config.templates?.[String(groupId)] ?? {}, base, warnings, `group.templates.${groupId}`)
  const overrides = {}
  if (runtime && isObject(runtime.settings)) Object.assign(overrides, runtime.settings)
  const merged = normalizeSettings(overrides, withTemplate, warnings, `群 ${groupId} 的运行时设置`)
  merged.warnings = warnings
  return merged
}

/** “HH:MM”形式的静默时段，现在是否落在里面（支持跨午夜，如 23:30–08:30） */
export function inQuietHours(quietHours, nowMs) {
  const start = HHMM.exec(String(quietHours?.start ?? ''))
  const end = HHMM.exec(String(quietHours?.end ?? ''))
  if (!start || !end) return false
  const date = new Date(nowMs)
  const minutes = date.getHours() * 60 + date.getMinutes()
  const from = Number(start[1]) * 60 + Number(start[2])
  const to = Number(end[1]) * 60 + Number(end[2])
  if (from === to) return false
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

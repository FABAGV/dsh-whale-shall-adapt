/**
 * 主动私聊主人的配置（docs/CONTRACTS.md 第 8.1 节，PLAN 第 45 条）。
 *
 * 蓝本是 SurfCore 的 purpose-engine（MIT）。这里只做“主动私聊主人”：只私聊、只发给配对的主人，群聊永远不主动开口。
 * 默认关，在控制台里打开。防刷屏的数值照搬：安静时段 23:30–08:30、每天最多 4 次、两次间隔 2.5–5 小时随机、
 * 主人 30 分钟内说过话不发、会话忙不发。
 */
import { inQuietHours } from '../group/config.js'

const HOUR = 3600 * 1000
const MIN = 60 * 1000

export const OUTREACH_DEFAULTS = Object.freeze({
  enabled: false,
  quietHours: Object.freeze({ start: '23:30', end: '08:30' }),
  maxPerDay: 4,
  minGapMs: 2.5 * HOUR,
  maxGapMs: 5 * HOUR,
  /** 主人最近这么久说过话就不打扰 */
  ownerQuietMs: 30 * MIN,
  /** 没有合适的话题时，隔多久再看一次 */
  idleRecheckMs: 1 * HOUR,
  /** 同一件事最近发过就不再提的天数 */
  topicCooldownDays: 3,
  /** 主人这么久之内的回复才算对这次主动联系的回应 */
  replyWindowMs: 6 * HOUR,
})

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

function num(value, fallback, lo, hi, warnings, label) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < lo || n > hi) {
    warnings.push(`${label}="${value}" 非法（需要 ${lo}–${hi}），已回退为 ${fallback}`)
    return fallback
  }
  return n
}

/**
 * 默认值 ← 配置文件里的 `outreach` ← 控制台写下的覆盖。非法值回退并记警告。
 * @returns {typeof OUTREACH_DEFAULTS & { warnings: string[] }}
 */
export function resolveOutreachConfig(raw = {}, overrides = {}) {
  const warnings = []
  const merged = { ...OUTREACH_DEFAULTS, ...(isObject(raw) ? raw : {}), ...(isObject(overrides) ? overrides : {}) }
  merged.quietHours = { ...OUTREACH_DEFAULTS.quietHours, ...(isObject(raw?.quietHours) ? raw.quietHours : {}), ...(isObject(overrides?.quietHours) ? overrides.quietHours : {}) }
  merged.enabled = merged.enabled === true
  for (const key of ['start', 'end']) {
    if (!HHMM.test(String(merged.quietHours[key] ?? ''))) {
      warnings.push(`outreach.quietHours.${key}="${merged.quietHours[key]}" 不是 HH:MM，已回退为 ${OUTREACH_DEFAULTS.quietHours[key]}`)
      merged.quietHours[key] = OUTREACH_DEFAULTS.quietHours[key]
    }
  }
  merged.maxPerDay = Math.floor(num(merged.maxPerDay, OUTREACH_DEFAULTS.maxPerDay, 0, 24, warnings, 'outreach.maxPerDay'))
  merged.minGapMs = num(merged.minGapMs, OUTREACH_DEFAULTS.minGapMs, 10 * MIN, 48 * HOUR, warnings, 'outreach.minGapMs')
  merged.maxGapMs = num(merged.maxGapMs, OUTREACH_DEFAULTS.maxGapMs, 10 * MIN, 72 * HOUR, warnings, 'outreach.maxGapMs')
  if (merged.maxGapMs < merged.minGapMs) {
    warnings.push('outreach.maxGapMs 小于 minGapMs，已把上限提到和下限一样')
    merged.maxGapMs = merged.minGapMs
  }
  merged.ownerQuietMs = num(merged.ownerQuietMs, OUTREACH_DEFAULTS.ownerQuietMs, 0, 24 * HOUR, warnings, 'outreach.ownerQuietMs')
  merged.idleRecheckMs = num(merged.idleRecheckMs, OUTREACH_DEFAULTS.idleRecheckMs, MIN, 48 * HOUR, warnings, 'outreach.idleRecheckMs')
  merged.topicCooldownDays = num(merged.topicCooldownDays, OUTREACH_DEFAULTS.topicCooldownDays, 0, 90, warnings, 'outreach.topicCooldownDays')
  merged.replyWindowMs = num(merged.replyWindowMs, OUTREACH_DEFAULTS.replyWindowMs, MIN, 72 * HOUR, warnings, 'outreach.replyWindowMs')
  return { ...merged, warnings }
}

export { inQuietHours }

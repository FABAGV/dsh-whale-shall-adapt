/**
 * 主动私聊主人的纯逻辑：不碰磁盘、不碰网络，时间和随机数都由调用方传进来（借鉴 SurfCore purpose-engine 的“纯逻辑与副作用分开”）。
 *
 * 目标不是凭空编出来的：只从统一记忆层里主人的“上次没说完的事”挑——owner:chat 片里状态为 active 的
 * intent（回合末尾备忘的“待续”）和 promise（约定）。没有合适的就不发，不靠定时问候凑数。
 */
import { jaccard } from '../memory/text.js'
import { MEMO_PREFIX } from '../conversation/chat-memory.js'

export const TOPIC_KINDS = new Set(['intent', 'promise'])
const RECENT_MAX = 20
const REPLY_NEGATIVE = /(不要|不用|别|没空|算了|不想|不需要|别烦|先不|以后再说|不必|不太想|没心情|烦)/
const REPLY_POSITIVE = /(好的|好呀|好啊|可以|行呀|行啊|没问题|一起|哈哈|想|来吧|要的|对对|是的|谢谢|收到|嗯嗯)/
const REPLY_POSITIVE_START = /^(好|行|嗯|ok|OK|对|要|来|哈)/

/** 本地日期 YYYY-MM-DD，每天的次数按它清零 */
export function dayKey(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 两次主动联系之间的随机间隔 */
export function randomGap(config, rand) {
  return Math.round(config.minGapMs + (config.maxGapMs - config.minGapMs) * Math.min(0.999999, Math.max(0, rand())))
}

/** 主人的回复是正面、负面还是中性（先判否定，所以“不想”不会被“想”误判成正面）。只当低置信度的信号用 */
export function classifyReply(text) {
  const body = String(text ?? '').trim()
  if (!body) return 'neutral'
  if (REPLY_NEGATIVE.test(body)) return 'negative'
  if (REPLY_POSITIVE.test(body) || REPLY_POSITIVE_START.test(body)) return 'positive'
  return 'neutral'
}

/** 话题显示用的文本：去掉“待续：”前缀 */
export function topicText(entry) {
  const text = String(entry?.text ?? '')
  return text.startsWith(MEMO_PREFIX) ? text.slice(MEMO_PREFIX.length) : text
}

/**
 * 从记忆里挑这次想聊的事。
 * @param {Array<{ id: string, text: string, kind: string, importance: number, confidence: number }>} entries owner:chat 片里 active 的条目
 * @param {{ recent: Array<{ id: string, text: string, at: number }>, declined: Record<string, number> }} state
 * @returns {{ id: string, text: string, kind: string } | null}
 */
export function pickTopic(entries, state, { now, cooldownDays, rand }) {
  const cooldown = cooldownDays * 24 * 3600 * 1000
  const recent = state.recent ?? []
  const pool = (entries ?? []).filter((e) => {
    if (!TOPIC_KINDS.has(e.kind)) return false
    if ((state.declined?.[e.id] ?? 0) > now) return false
    const text = topicText(e)
    return !recent.some((r) => now - r.at < cooldown && (r.id === e.id || jaccard(r.text, text) >= 0.6))
  })
  if (pool.length === 0) return null
  const weights = pool.map((e) => 1 + (Number(e.importance) || 0) + (Number(e.confidence) || 0))
  let roll = rand() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < pool.length; i += 1) {
    roll -= weights[i]
    if (roll <= 0) return { id: pool[i].id, text: topicText(pool[i]), kind: pool[i].kind }
  }
  const last = pool[pool.length - 1]
  return { id: last.id, text: topicText(last), kind: last.kind }
}

/** 交给常驻会话的提示：说明这是它自己想联系主人，先判断合不合适，不合适就 <refuse/> */
export function buildOutreachPrompt(topic, { now }) {
  const time = new Date(now)
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  return [
    `（插件提示：这是你自己想主动联系主人的一次，不是主人找你。现在是 ${hh}:${mm}。`,
    `你心里一直惦记着这件事：「${topic.text}」。`,
    '先想想此刻合不合适：主人像是在忙、刚说过不想被打扰、或这件事已经不重要了，就只回 <refuse/>。',
    '觉得可以，就自然、简短地说一两句，像朋友顺口问起；别客套，别说“我是来提醒你的”，别一次问好几件事。）',
  ].join('\n')
}

/** 记一次已发出的联系（最近 RECENT_MAX 条） */
export function pushRecent(recent, topic, at) {
  return [...(recent ?? []), { id: topic.id, text: topic.text, at }].slice(-RECENT_MAX)
}

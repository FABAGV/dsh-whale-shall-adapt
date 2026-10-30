/**
 * 人格从真实 QQ 对话里进化（PLAN 第 15 条）：用户在 QQ 里说“不像 / 你怎么变了 / 太官方”，
 * 记成这个聊天绑定的人格的一条**反馈候选**（评分 bad，备注里写明来源），等你在控制台“人格”页挑着用来微调。
 *
 * 只收集，不自动改人格：用户的话是低置信度信号（规则判得不准），而微调要你自己点。
 * 同一个聊天 10 分钟内最多记一条；这个聊天没有绑定启用中的人格就什么都不做。
 */

const COOLDOWN_MS = 10 * 60 * 1000
const NOTE_PREFIX = '【QQ 里被说不像】'

/**
 * @param {object} opts
 * @param {{ on: Function }} opts.signals 进程内信号总线
 * @param {{ personaFor: Function, addFeedback: Function }} opts.personas
 * @returns {{ stop: () => void, snapshot: () => object }}
 */
export function attachPersonaFeedback({ signals, personas, log = null, now = () => Date.now() }) {
  const lastAt = new Map()
  const stats = { received: 0, recorded: 0, noPersona: 0, throttled: 0 }
  const off = signals.on((event) => {
    if (event?.kind !== 'not-like' || !event.chatKey) return
    stats.received += 1
    try {
      const kind = String(event.chatKey).startsWith('group:') ? 'qq-group' : 'qq-private'
      const persona = personas.personaFor({ kind, chatKey: event.chatKey }, event.sessionId)
      if (!persona) {
        stats.noPersona += 1
        return
      }
      const key = `${persona.id}|${event.chatKey}`
      if (now() - (lastAt.get(key) ?? 0) < COOLDOWN_MS) {
        stats.throttled += 1
        return
      }
      lastAt.set(key, now())
      const result = personas.addFeedback(persona.id, {
        message: '',
        reply: event.prevAssistant ?? '',
        note: `${NOTE_PREFIX}${event.quote ?? ''}`,
        rating: 'bad',
      })
      if (result?.ok) stats.recorded += 1
    } catch (error) {
      log?.warn?.(`[persona-feedback] 记反馈出错: ${error?.message ?? error}`)
    }
  })
  return { stop: off, snapshot: () => ({ ...stats }) }
}

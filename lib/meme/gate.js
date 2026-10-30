/**
 * 梗百科的模型闸门（PLAN 第 46 条）：规则判不准的短词，交给便宜模型判一下“值不值得去联网查”。
 *
 * 只在联网查词打开时才用得上——本地词库查不到、又说不准是不是梗的词，联网查之前过一道闸，省请求、省被限流。
 * 提示词来自 memewiki（rules.js 的 GATE_PROMPT）。规则：
 *   - 1.2 秒内没回就放行（宁可多查一次，也不拖慢回复）；结果缓存 10 分钟；
 *   - 模型可以把要查的词改成它认为更准的那个（1–8 字），否则用规则抽出来的词。
 */
import { extractJson } from '../core/llm.js'
import { GATE_PROMPT } from './rules.js'

const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 200
const TERM_MAX = 8

/**
 * @param {{ run: (input: object) => Promise<string> }} model createCheapModel 的返回值
 * @returns {(query: string, raw: string) => Promise<{ lookup: boolean, term: string, reason: string }>}
 */
export function createMemeGate({ model, timeoutMs = 1200, now = () => Date.now() }) {
  const cache = new Map()
  async function gate(query, raw) {
    const key = String(query)
    const hit = cache.get(key)
    if (hit && hit.until > now()) return hit.value
    let value = { lookup: true, term: key, reason: 'timeout-or-error' }
    try {
      const text = await Promise.race([
        model.run({ system: GATE_PROMPT, user: `消息：${String(raw).slice(0, 200)}\n候选词：${key}`, maxTokens: 80, timeoutMs }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gate-timeout')), timeoutMs).unref?.()),
      ])
      const json = extractJson(text)
      if (json && typeof json.lookup === 'boolean') {
        const term = String(json.term ?? '').trim()
        value = { lookup: json.lookup, term: term && term.length <= TERM_MAX ? term : key, reason: 'model' }
      }
    } catch {
      /* 超时或模型不可用：放行 */
    }
    cache.set(key, { value, until: now() + CACHE_MS })
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return value
  }
  gate.size = () => cache.size
  return gate
}

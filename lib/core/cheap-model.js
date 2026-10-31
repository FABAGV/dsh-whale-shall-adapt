/**
 * 便宜模型的调用：群聊判断、群成员记忆、群概况、梗词判断这些窄任务共用。
 *
 * 用哪个模型：配置里的 provider/model（默认 provider 留空、model 是 deepseek-flash）。按这个顺序试：
 *   1. 配置的 provider；留空就用宿主在用的 provider：正在跑的会话实际在用的（桌面端账号登录是 deepseek-account），
 *      再是宿主默认模型选择里的。只看默认选择不够：它可能还写着 deepseek-official，而这台机器没有 API key
 *   2. 宿主注册了的其他 DeepSeek 线路（deepseek-*），模型名照配置。只认 deepseek-*：不去试注册了、但你没在用的别家线路
 *   3. 会话正在用的模型、宿主默认模型（可能是贵的模型，放最后）
 * 用不了的模型 5 分钟内不再试（全都用不了时直接报错，不再逐个试）；控制台从 status() 看到"改用了谁、为什么"。
 * 超时不算"不可用"：只说明这次慢了，也不在同一次调用里换个模型再等一遍。
 * 都不可用时抛错，由调用方决定怎么办（判断就当“不回”，整理就下次再试）。
 */
import { streamText, resolveDefaultModel } from './llm.js'

/** 用不了的模型隔多久再试 */
const RETRY_MS = 5 * 60 * 1000
const MAX_SESSIONS = 20
const DEEPSEEK_ROUTE = /^deepseek-[a-z0-9-]+$/

const label = (m) => `${m.provider}/${m.model}`
const short = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
const quietly = (fn) => {
  try {
    return fn()
  } catch {
    return undefined
  }
}
const isAbort = (error) =>
  error?.name === 'AbortError' || error?.name === 'TimeoutError' || /^LLM 调用被中止/.test(String(error?.message ?? ''))

/**
 * 宿主这边的模型：正在跑的会话实际在用的（在跑的、新的在前）、宿主默认模型选择、注册了的 DeepSeek 线路。
 * @returns {{ inUse: Array<{provider:string, model:string, source:'session'|'default'}>, routes: string[] }}
 */
export function hostChoices(root, llm = null) {
  const inUse = []
  const agents = quietly(() => (typeof root?.get === 'function' ? root.get('agents') : undefined))
  const list = quietly(() => (typeof agents?.list === 'function' ? agents.list() : [])) ?? []
  const ordered = [...list].reverse().sort((a, b) => Number(b?.status === 'running') - Number(a?.status === 'running'))
  for (const agent of ordered.slice(0, MAX_SESSIONS)) {
    const context = quietly(() => agent?.session?.requestContext?.())
    const header = quietly(() => agent?.session?.requestHeader?.()?.config)
    const pick = context?.provider && context?.model ? context : header?.provider && header?.model ? header : null
    if (pick) inUse.push({ provider: String(pick.provider), model: String(pick.model), source: 'session' })
  }
  const def = resolveDefaultModel(root)
  if (def) inUse.push({ ...def, source: 'default' })
  const service = llm ?? quietly(() => (typeof root?.get === 'function' ? root.get('llm') : undefined))
  const providers = quietly(() => (typeof service?.listProviders === 'function' ? service.listProviders() : [])) ?? []
  const routes = providers.map((p) => String(p?.id ?? '')).filter((id) => DEEPSEEK_ROUTE.test(id))
  return { inUse, routes }
}

/**
 * 这一次按什么顺序试哪些模型（见文件头）。
 * @param {{provider?:string, model?:string}} settings
 * @param {ReturnType<typeof hostChoices>} host
 * @returns {Array<{provider:string, model:string, source:'config'|'host-provider'|'route'|'session'|'default'}>}
 */
export function cheapCandidates(settings, host = { inUse: [], routes: [] }) {
  const provider = String(settings?.provider ?? '').trim()
  const model = String(settings?.model ?? '').trim()
  const inUse = host.inUse ?? []
  const list = []
  const seen = new Set()
  const add = (c) => {
    if (!c.provider || !c.model || seen.has(label(c))) return
    seen.add(label(c))
    list.push(c)
  }
  if (provider) add({ provider, model: model || inUse.find((h) => h.provider === provider)?.model || '', source: 'config' })
  else for (const h of inUse) add({ provider: h.provider, model: model || h.model, source: 'host-provider' })
  if (model) for (const route of host.routes ?? []) add({ provider: route, model, source: 'route' })
  for (const h of inUse) add({ ...h })
  return list
}

const FALLBACK_WHAT = { route: '另一条 DeepSeek 线路', session: '会话正在用的模型', default: '宿主默认模型' }

/**
 * @param {object} opts
 * @param {() => any} opts.llm 取 ctx.llm（服务可能晚于插件就绪）
 * @param {() => any} [opts.root] 取 cordis 上下文，用来查会话在用的模型和宿主默认模型
 * @param {() => { provider?: string, model?: string, timeoutMs?: number }} opts.config
 */
export function createCheapModel({ llm, root = () => null, config, log = null, now = () => Date.now(), call = streamText }) {
  const state = { using: 'configured', provider: '', model: '', note: '', lastError: '', calls: 0, failures: 0, timeouts: 0 }
  /** label → { until, error }：用不了的模型，到点之前不再试 */
  const broken = new Map()
  const candidates = () => cheapCandidates(config(), hostChoices(root(), quietly(llm)))

  function unavailable(message) {
    state.failures += 1
    state.lastError = message
    state.using = 'unavailable'
    log?.warn?.(`[model] 便宜模型不可用：${message}`)
    return new Error(`模型不可用：${message}`)
  }

  /**
   * @param {{ system?: string, user: string, maxTokens?: number, timeoutMs?: number }} input
   * @returns {Promise<string>} 模型回复的文本
   */
  async function run(input) {
    const settings = config()
    state.calls += 1
    const list = candidates()
    if (list.length === 0) throw unavailable('没配置 provider/model，宿主也没有在用的模型')
    const at = now()
    const order = list.filter((c) => !(broken.get(label(c))?.until > at))
    if (order.length === 0) {
      state.failures += 1
      state.using = 'unavailable'
      throw new Error(`模型不可用：${short(broken.get(label(list[0]))?.error)}（${RETRY_MS / 60000} 分钟内不再试）`)
    }
    let lastError = ''
    for (const c of order) {
      try {
        const out = await call(llm(), {
          provider: c.provider,
          model: c.model,
          system: input.system,
          messages: [{ role: 'user', text: input.user }],
          maxTokens: input.maxTokens ?? 800,
          timeoutMs: input.timeoutMs ?? settings.timeoutMs ?? 15000,
        })
        broken.delete(label(c))
        const first = list[0]
        state.provider = c.provider
        state.model = c.model
        state.using = c.source === 'config' || c.source === 'host-provider' ? 'configured' : 'fallback'
        if (label(c) === label(first)) {
          state.note = ''
        } else {
          const why = broken.get(label(first))?.error
          state.note = `${label(first)} 不可用${why ? `（${short(why)}）` : ''}，改用${FALLBACK_WHAT[c.source] ?? ''} ${label(c)}；${RETRY_MS / 60000} 分钟后再试 ${label(first)}`
        }
        return out.text
      } catch (error) {
        lastError = error?.message ?? String(error)
        if (isAbort(error)) {
          state.timeouts += 1
          state.lastError = `超时或被中止：${short(lastError)}`
          throw new Error(`模型超时：${lastError}`)
        }
        broken.set(label(c), { until: now() + RETRY_MS, error: lastError })
      }
    }
    throw unavailable(lastError)
  }

  /** 状态里带上这次会先试哪个模型（provider 留空时跟着宿主变）和完整的候选顺序。 */
  function status() {
    const list = quietly(candidates) ?? []
    return { ...state, target: list[0] ?? null, candidates: list.map(label) }
  }

  return { run, status }
}

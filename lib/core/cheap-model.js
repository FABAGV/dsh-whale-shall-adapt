/**
 * 便宜模型的调用：群聊判断、群成员记忆、群概况、梗词判断这些窄任务共用。
 *
 * 先用配置里的模型（默认 deepseek-official/deepseek-flash）；它不可用时退回宿主默认模型，
 * 并记下"改用了谁、为什么"，控制台据此说明。退回之后每隔几分钟再试一次配置的模型。
 * 两个都不可用时抛错，由调用方决定怎么办（判断就当“不回”，整理就下次再试）。
 */
import { streamText, resolveDefaultModel } from './llm.js'

/** 退回宿主默认模型之后，隔多久再试一次配置的模型 */
const FALLBACK_RETRY_MS = 5 * 60 * 1000

/**
 * @param {object} opts
 * @param {() => any} opts.llm 取 ctx.llm（服务可能晚于插件就绪）
 * @param {() => any} [opts.root] 取 cordis 上下文，用来查宿主默认模型
 * @param {() => { provider: string, model: string, timeoutMs?: number }} opts.config
 */
export function createCheapModel({ llm, root = () => null, config, log = null, now = () => Date.now(), call = streamText }) {
  const state = { using: 'configured', provider: '', model: '', note: '', lastError: '', fallbackSince: 0, calls: 0, failures: 0 }

  /**
   * @param {{ system?: string, user: string, maxTokens?: number, timeoutMs?: number }} input
   * @returns {Promise<string>} 模型回复的文本
   */
  async function run(input) {
    const settings = config()
    state.calls += 1
    const configured = { provider: settings.provider, model: settings.model }
    const tryFallbackOnly = state.using === 'fallback' && now() - state.fallbackSince < FALLBACK_RETRY_MS
    const order = tryFallbackOnly ? ['fallback'] : ['configured', 'fallback']
    let lastError = ''
    for (const which of order) {
      const model = which === 'configured' ? configured : resolveDefaultModel(root())
      if (!model?.provider || !model?.model) {
        lastError = which === 'configured' ? '没有配置模型' : '宿主没有默认模型'
        if (which === 'configured') state.fallbackSince = now()
        continue
      }
      try {
        const out = await call(llm(), {
          provider: model.provider,
          model: model.model,
          system: input.system,
          messages: [{ role: 'user', text: input.user }],
          maxTokens: input.maxTokens ?? 800,
          timeoutMs: input.timeoutMs ?? settings.timeoutMs ?? 15000,
        })
        state.provider = model.provider
        state.model = model.model
        if (which === 'fallback') {
          state.using = 'fallback'
          state.note = `配置的模型 ${configured.provider}/${configured.model} 不可用，改用宿主默认模型 ${model.provider}/${model.model}`
        } else {
          state.using = 'configured'
          state.note = ''
          state.fallbackSince = 0
        }
        return out.text
      } catch (error) {
        lastError = error?.message ?? String(error)
        if (which === 'configured') {
          state.fallbackSince = now()
          state.using = 'fallback'
        }
      }
    }
    state.failures += 1
    state.lastError = lastError
    state.using = 'unavailable'
    log?.warn?.(`[model] 便宜模型不可用：${lastError}`)
    throw new Error(`模型不可用：${lastError}`)
  }

  return { run, status: () => ({ ...state }) }
}

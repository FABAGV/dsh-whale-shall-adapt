/**
 * 人格与技能的后台活：选模型、读材料、调 LLM、把结果落进仓库。
 *
 * 所有入口都只由本机控制台（或定时器的自动整理）调用，不暴露给模型。
 */
import { extractJson, resolveDefaultModel, streamText } from '../core/llm.js'
import { corpusRoot, readChatRecords } from './qq-corpus.js'
import { buildGeneratePrompt, buildRefinePrompt, parsePersonaOutput, testChatSystem } from './persona.js'
import { describeStats, memberScenes, memberStats, scenesToExcerpts } from './persona-material.js'
import { buildMiningPrompt, sessionDigest, sessionStats } from './skills.js'
import { pullMemberHistory } from './persona-history.js'
import path from 'node:path'

const PERSONA_SYSTEM = '你是一位擅长观察说话风格、揣摩人的性格和心思的写作助手。你只按要求输出 JSON。'
const MINING_SYSTEM = '你在帮一位开发者整理可复用的工作方法。你只按要求输出 JSON。'
const IDLE_BEFORE_MINING_MS = 10 * 60 * 1000

export class Workbench {
  /**
   * @param {object} opts
   * @param {any} opts.root cordis 上下文（取 llm、默认模型）
   * @param {object} opts.config 插件配置（resolveConfig 的结果）
   * @param {string} opts.dshHome
   * @param {import('./persona.js').PersonaStore} opts.personas
   * @param {import('./skills.js').SkillStore} opts.skills
   * @param {import('../core/jobs.js').JobRunner} opts.jobs
   * @param {import('../privacy/policy.js').PrivacyPolicy} opts.policy
   * @param {import('./sessions.js').SessionScanner} opts.scanner
   * @param {object} [opts.log]
   */
  constructor({ root, config, dshHome, personas, skills, jobs, policy, scanner, log, qce = null }) {
    Object.assign(this, { root, config, dshHome, personas, skills, jobs, policy, scanner, log, qce })
  }

  /** 从 QQ Chat Exporter 导入的历史放在这里（和语料库同级） */
  importRoot() {
    return path.join(path.dirname(this.corpusRoot()), 'imported')
  }

  #llm() {
    const llm = typeof this.root?.get === 'function' ? this.root.get('llm') : undefined
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用（ctx.llm.stream 缺失）')
    return llm
  }

  /** 人格 / 技能各自可以单独指定模型；没配就跟画像生成用同一个，再没有就用 DSH 当前默认模型。 */
  pickModel(section) {
    const own = this.config[section] ?? {}
    const profile = this.config.profile ?? {}
    const provider = own.provider || profile.provider
    const model = own.model || profile.model
    if (provider && model) return { provider, model }
    const selection = resolveDefaultModel(this.root)
    return { provider: provider || selection?.provider || '', model: model || selection?.model || '' }
  }

  corpusRoot() {
    return corpusRoot(this.dshHome)
  }

  /** 模仿群友的素材：他的场景（别人说了什么 → 他怎么接）和本地统计。只读本机语料，不联网、不调模型 */
  #memberMaterial(source, days) {
    const records = readChatRecords(this.corpusRoot(), { chatType: source.chatType, chatId: source.chatId, days })
    const stats = memberStats(records, source.memberId)
    return {
      messages: stats?.messages ?? 0,
      scenes: memberScenes(records, source.memberId, { maxChars: this.config.persona.maxSampleChars }),
      statsText: describeStats(stats),
    }
  }

  /** 自己写第一版时，给模仿群友的人格配上原话片段（本地挑，不调模型）。按描述的人格返回 null */
  manualMaterial(personaId) {
    const persona = this.personas.get(personaId)
    if (persona?.kind !== 'member' || !persona.source) return null
    const material = this.#memberMaterial(persona.source, persona.source.days ?? this.config.persona.corpusDays)
    return { excerpts: scenesToExcerpts(material.scenes, []), statsText: material.statsText }
  }

  /** 生成首版（或重新生成）风格说明。立即返回任务；结果落成人格的一个新版本。 */
  startGenerate(personaId) {
    const persona = this.personas.get(personaId)
    if (!persona) return { ok: false, error: '找不到这个人格' }
    if (persona.kind !== 'member' && !persona.description.trim()) {
      return { ok: false, error: '没有性格描述，模型没法生成：先写几句描述，或者直接在「风格说明」里自己写' }
    }
    return this.jobs.start({ kind: 'persona-generate', key: `persona:${personaId}`, label: `生成人格「${persona.name}」` }, async ({ signal, progress }) => {
      let material = null
      let history = null
      if (persona.kind === 'member') {
        const source = persona.source
        const days = source.days ?? this.config.persona.corpusDays
        // 先从本机的 QQ Chat Exporter 拉这位群友的历史发言（拉不到就只用本地语料）
        if (this.config.persona.qceHistory !== false) {
          try {
            history = await pullMemberHistory({ qce: this.qce, importRoot: this.importRoot(), source, days: Math.max(days, this.config.persona.qceDays ?? 365), progress, signal })
          } catch (error) {
            history = { pulled: false, reason: String(error?.message ?? error) }
          }
          if (!history.pulled && !history.cached) this.log?.info?.(`[persona] 没从 QQ Chat Exporter 拉到历史，只用本地语料：${history.reason}`)
        }
        progress('读取 QQ 语料…')
        const readDays = history?.pulled || history?.cached ? Math.max(days, this.config.persona.qceDays ?? 365) : days
        material = this.#memberMaterial(source, readDays)
        if (material.messages < 5) {
          const hint = history && !history.pulled && !history.cached ? `（没能从 QQ Chat Exporter 拉历史：${history.reason}）` : ''
          throw new Error(`这位群友在语料里只有 ${material.messages} 条发言，太少了，模仿不出来${hint}`)
        }
      }
      progress('调用模型…')
      const model = this.pickModel('persona')
      const { text } = await streamText(this.#llm(), {
        ...model,
        system: PERSONA_SYSTEM,
        messages: [{ role: 'user', text: buildGeneratePrompt(persona, material ?? {}) }],
        maxTokens: this.config.persona.maxTokens,
        timeoutMs: this.config.persona.timeoutMs,
        signal,
      })
      const parsed = parsePersonaOutput(extractJson(text))
      if (!parsed) throw new Error('模型的输出里没有可用的风格说明')
      // 原话片段照搬语料原文：模型只给编号，编号不对就本地挑
      const excerpts = material ? scenesToExcerpts(material.scenes, parsed.pick) : []
      const saved = this.personas.addVersion(personaId, {
        spec: parsed.spec,
        analysis: parsed.analysis,
        excerpts,
        statsText: material?.statsText ?? '',
        origin: 'generate',
        model: `${model.provider}/${model.model}`,
      })
      if (!saved.ok) throw new Error(saved.error)
      return {
        version: saved.version,
        scenesUsed: material?.scenes.length ?? 0,
        excerpts: excerpts.length,
        history: history ? { pulled: history.pulled, cached: Boolean(history.cached), imported: history.imported ?? 0, reason: history.reason ?? '' } : null,
      }
    })
  }

  /** 按还没用过的试聊反馈修订当前版本。 */
  startRefine(personaId, feedbackIds) {
    const persona = this.personas.get(personaId)
    if (!persona) return { ok: false, error: '找不到这个人格' }
    const version = persona.versions.find(item => item.v === persona.activeVersion)
    if (!version) return { ok: false, error: '还没有版本：先生成一次' }
    const wanted = Array.isArray(feedbackIds) && feedbackIds.length > 0 ? new Set(feedbackIds) : null
    const feedback = persona.feedback.filter(item => (wanted ? wanted.has(item.id) : item.appliedIn === null))
    if (feedback.length === 0) return { ok: false, error: '没有还没用过的反馈：先在试聊里标出哪里不像' }
    return this.jobs.start({ kind: 'persona-refine', key: `persona:${personaId}`, label: `修订人格「${persona.name}」` }, async ({ signal, progress }) => {
      progress(`按 ${feedback.length} 条反馈修订…`)
      const model = this.pickModel('persona')
      const { text } = await streamText(this.#llm(), {
        ...model,
        system: PERSONA_SYSTEM,
        messages: [{ role: 'user', text: buildRefinePrompt(persona, version, feedback) }],
        maxTokens: this.config.persona.maxTokens,
        timeoutMs: this.config.persona.timeoutMs,
        signal,
      })
      const parsed = parsePersonaOutput(extractJson(text))
      if (!parsed) throw new Error('模型的输出里没有可用的风格说明')
      // 修订只改自白；原话片段、性格分析、统计沿用当前版本
      const saved = this.personas.addVersion(personaId, {
        spec: parsed.spec,
        excerpts: version.excerpts ?? [],
        analysis: version.analysis ?? '',
        statsText: version.statsText ?? '',
        changes: parsed.changes,
        origin: 'refine',
        basedOn: version.v,
        appliedFeedback: feedback.map(item => item.id),
        memorySuggestions: parsed.memory,
        model: `${model.provider}/${model.model}`,
      })
      if (!saved.ok) throw new Error(saved.error)
      return { version: saved.version, feedbackUsed: feedback.length, changes: parsed.changes }
    })
  }

  /**
   * 试聊一句。直接等模型回复（不进任何 DSH 会话，不留会话日志）。
   * @param {{version?:number, history?:Array<{role:'user'|'assistant', text:string}>, message:string}} input
   */
  async testChat(personaId, input, signal) {
    const persona = this.personas.get(personaId)
    if (!persona) return { ok: false, error: '找不到这个人格' }
    const versionNumber = Number.isFinite(input?.version) ? input.version : persona.activeVersion
    if (!persona.versions.some(item => item.v === versionNumber)) return { ok: false, error: '这个版本不存在' }
    const message = String(input?.message ?? '').trim().slice(0, 2000)
    if (!message) return { ok: false, error: '说点什么再发送' }
    const history = (Array.isArray(input?.history) ? input.history : [])
      .filter(item => (item?.role === 'user' || item?.role === 'assistant') && typeof item.text === 'string' && item.text.trim())
      .slice(-12)
      .map(item => ({ role: item.role, text: item.text.slice(0, 2000) }))
    const model = this.pickModel('persona')
    const started = Date.now()
    const { text } = await streamText(this.#llm(), {
      ...model,
      system: testChatSystem(persona, versionNumber),
      messages: [...history, { role: 'user', text: message }],
      maxTokens: 800,
      timeoutMs: Math.min(this.config.persona.timeoutMs, 90_000),
      signal,
    })
    return { ok: true, reply: text.trim(), version: versionNumber, elapsedMs: Date.now() - started }
  }

  /**
   * 可以拿来整理技能的会话：你自己的、允许学习的、有足够工具活动的、空闲超过 10 分钟的、
   * 上次整理之后又有变化的。
   */
  eligibleSessions(now = Date.now(), provided = null) {
    const minToolCalls = this.config.skills.minToolCalls
    const mined = this.skills.state.mining.mined
    const titles = new Map(this.scanner.sessionSummaries().map(item => [item.id, item.title]))
    const ownerAndLearnable = (id, header) => {
      const rule = this.policy.ruleFor({ ...header, id })
      return rule.kind === 'owner' && rule.learn
    }
    let sessions
    if (provided instanceof Map) {
      // 调用方给的是已经按"允许学习"过滤过的会话（定时扫描的结果）：这里只再收紧到你自己的会话。
      const headers = this.scanner.sessionHeaders()
      sessions = new Map([...provided].filter(([id]) => headers.has(id) && ownerAndLearnable(id, headers.get(id))))
    } else {
      sessions = this.scanner.bySession({ humanOnly: true, filter: ownerAndLearnable })
    }
    const out = []
    for (const [id, events] of sessions) {
      const stats = sessionStats(events)
      if (stats.userMessages === 0 || stats.toolCalls < minToolCalls) continue
      if (now - stats.lastAt < IDLE_BEFORE_MINING_MS) continue
      if (mined[id] && mined[id] >= stats.lastAt) continue
      out.push({ id, events, stats, title: titles.get(id) ?? '' })
    }
    return out.sort((a, b) => b.stats.lastAt - a.stats.lastAt)
  }

  /** 定时器调：到了间隔、攒够了新会话才自动整理一次。 */
  maybeAutoMine(now = Date.now(), sessions = null) {
    const cfg = this.config.skills
    if (!cfg.enabled || !cfg.autoMine) return { skipped: true, reason: '自动整理已关闭' }
    const last = this.skills.state.mining.lastRunAt
    if (last && now - last < cfg.minIntervalHours * 3600_000) return { skipped: true, reason: '还没到间隔' }
    if (this.jobs.running().some(job => job.key === 'skills-mine')) return { skipped: true, reason: '已经在整理' }
    const eligible = this.eligibleSessions(now, sessions)
    if (eligible.length < cfg.minNewSessions) return { skipped: true, reason: `新会话 ${eligible.length}/${cfg.minNewSessions}` }
    return this.startMining({ auto: true, eligible })
  }

  startMining({ auto = false, eligible } = {}) {
    if (!this.config.skills.enabled) return { ok: false, error: '技能整理已在插件配置里关闭' }
    const sessions = (eligible ?? this.eligibleSessions()).slice(0, this.config.skills.sessionsPerRun)
    if (sessions.length === 0) return { ok: false, error: '没有新的、工具活动足够多的会话可以整理（会话要空闲 10 分钟以上）' }
    this.skills.state.mining.lastRunAt = Date.now()
    this.skills.save()
    return this.jobs.start({ kind: 'skills-mine', key: 'skills-mine', label: auto ? '自动整理技能' : '整理技能' }, async ({ signal, progress }) => {
      progress(`整理 ${sessions.length} 个会话…`)
      const digests = sessions.map(item => ({ id: item.id, digest: sessionDigest(item.events, { title: item.title }) }))
      const model = this.pickModel('skills')
      try {
        const { text } = await streamText(this.#llm(), {
          ...model,
          system: MINING_SYSTEM,
          messages: [{ role: 'user', text: buildMiningPrompt(digests, this.skills.list().map(skill => ({ name: skill.name, description: skill.description }))) }],
          maxTokens: this.config.skills.maxTokens,
          timeoutMs: this.config.skills.timeoutMs,
          signal,
        })
        const parsed = extractJson(text)
        const proposals = Array.isArray(parsed?.skills) ? parsed.skills : null
        if (!proposals) throw new Error('模型的输出里没有 skills 数组')
        const outcome = this.skills.applyProposals(proposals, {
          minScore: this.config.skills.autoActivateScore,
          sessionIds: sessions.map(item => item.id),
          model: `${model.provider}/${model.model}`,
        })
        this.skills.markMined(Object.fromEntries(sessions.map(item => [item.id, item.stats.lastAt])))
        const report = { at: Date.now(), auto, sessions: sessions.length, proposals: proposals.length, ...outcome }
        this.skills.addReport(report)
        this.skills.state.mining.lastOkAt = Date.now()
        this.skills.state.mining.lastError = null
        this.skills.save()
        return report
      } catch (error) {
        this.skills.state.mining.lastError = String(error?.message ?? error)
        this.skills.save()
        throw error
      }
    })
  }
}

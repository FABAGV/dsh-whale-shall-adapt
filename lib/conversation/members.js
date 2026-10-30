/**
 * 群成员记忆与群概况冷启动（PLAN 第 14、16 条）。
 *
 * 群里没 @ bot 的消息只进语料库、不进会话，所以这些记忆从语料库里提取，和会话是否活跃无关：
 *   - 成员记忆：每位群友的称呼、关系、偏好、说话风格 → `member:<群号>:<QQ号>`，只在该群可见。
 *     默认开。每个群每 everyHours 小时最多一次，每次最多处理 maxPerRun 位新发言不少于 minMessages 条的人。
 *     被“忘掉我”屏蔽过的范围，记忆层会直接丢弃写入。
 *   - 群概况冷启动：第一次接入一个群、最近语料够多时，生成一份群概况，一律是候选记忆
 *     （不注入，等你在控制台转正或删掉）。每个群只做一次。
 *
 * 用的是便宜模型（lib/core/cheap-model.js）。模型的输出当不可信输入：只取固定字段、限长、QQ 号必须是我们挑出来的那几位。
 * 群友的愿望、计划、喜好记在他名下，不会写成 bot 自己的偏好（PLAN 第 44 条的目标归属）。
 */
import { extractJson } from '../core/llm.js'
import { inScope } from '../qq/config.js'

export const MEMBER_ACTOR = 'qq:members'
export const OVERVIEW_ACTOR = 'qq:coldstart'

const MEMBER_KINDS = new Set(['relation', 'preference', 'style', 'fact', 'intent'])
const OVERVIEW_KINDS = new Set(['note', 'fact', 'relation', 'style'])
const MAX_RECORDS = 3000
const MAX_LINES = 400
const MAX_CHARS = 14000
const MAX_ITEMS_PER_MEMBER = 3
const ITEM_MAX_CHARS = 60
const LINE_MAX_CHARS = 160
const TICK_RECHECK_MS = 6 * 3600 * 1000

export const MEMBER_INSTRUCTION = `你是一个 QQ 群的“记忆整理者”。上面是这个群最近的聊天记录，每行是“QQ号|昵称：内容”。
请为下面列出的几位群友，各记下最多 ${MAX_ITEMS_PER_MEMBER} 条以后聊天用得上的事：别人怎么称呼他、他和谁是什么关系、爱聊什么/忌讳什么、说话风格、近期在做的事。
规则：
1. 只写聊天里能直接看出来的，不要猜；看不出什么就给空数组。
2. 群友的愿望、计划、喜好记在他自己名下，不要写成机器人（你）的偏好。
3. 不记隐私：住址、电话、证件号、账号密码、精确位置、健康状况。
4. 每条 ≤ ${ITEM_MAX_CHARS} 字，kind 从 relation / preference / style / fact / intent 里选。
5. 只输出 JSON，不要 markdown 围栏，不要解释。
形状：{ "members": [ { "id": "QQ号", "items": [ { "kind": "preference", "text": "...", "confidence": 0.7 } ] } ] }`

export const OVERVIEW_INSTRUCTION = `你是一个 QQ 群的“记忆整理者”。上面是这个群最近的聊天记录，每行是“QQ号|昵称：内容”。
请写一份这个群的概况，最多 8 条，每条 ≤ ${ITEM_MAX_CHARS} 字：群的主题和气氛、常聊的话题、几位活跃群友的称呼和大致角色、群里的规矩和常用的梗、忌讳的话题。
规则：只写聊天里能直接看出来的，不要猜；不记隐私（住址、电话、证件号、账号、精确位置、健康状况）；kind 从 note / fact / relation / style 里选。
只输出 JSON，不要 markdown 围栏，不要解释。
形状：{ "items": [ { "kind": "note", "text": "...", "confidence": 0.6 } ] }`

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** 语料记录 → 按时间排好的发言行（只要文字消息），超出上限时留最新的 */
export function foldRecords(records) {
  const messages = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.kind === 'message' && typeof r.text === 'string' && r.text.trim() && /^\d{1,12}$/.test(String(r.senderId ?? '')))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .slice(-MAX_LINES)
  const lines = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const r = messages[i]
    const line = `${r.senderId}|${clip(r.senderName, 20) || r.senderId}：${clip(r.text, LINE_MAX_CHARS)}`
    if (total + line.length > MAX_CHARS) break
    lines.unshift(line)
    total += line.length
  }
  return { lines, messages }
}

/** 挑出这次要整理的群友：新发言不少于 minMessages 条，按条数从多到少，最多 maxPerRun 位 */
export function pickMembers(records, { sinceTs = 0, minMessages = 5, maxPerRun = 20 } = {}) {
  const counts = new Map()
  for (const r of records) {
    if (r?.kind !== 'message' || !r.text || !(r.ts > sinceTs)) continue
    const id = String(r.senderId ?? '')
    if (!/^\d{1,12}$/.test(id)) continue
    const entry = counts.get(id) ?? { id, count: 0, name: '' }
    entry.count += 1
    if (r.senderName) entry.name = clip(r.senderName, 20)
    counts.set(id, entry)
  }
  return [...counts.values()].filter((m) => m.count >= minMessages).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, maxPerRun)
}

const confidenceOf = (value) => (typeof value === 'number' && value >= 0 && value <= 1 ? Math.min(value, 0.8) : 0.5)

/** 严格取出成员记忆：QQ 号必须是我们挑出来的，kind 在白名单里，文本限长 */
export function parseMemberReply(text, allowedIds) {
  const json = extractJson(text)
  if (!json || !Array.isArray(json.members)) return null
  const allowed = new Set(allowedIds.map(String))
  const out = []
  for (const member of json.members) {
    const id = String(member?.id ?? '')
    if (!allowed.has(id) || !Array.isArray(member.items)) continue
    for (const item of member.items.slice(0, MAX_ITEMS_PER_MEMBER)) {
      const body = clip(item?.text, ITEM_MAX_CHARS)
      if (!body) continue
      out.push({ id, kind: MEMBER_KINDS.has(item?.kind) ? item.kind : 'fact', text: body, confidence: confidenceOf(item?.confidence) })
    }
  }
  return out
}

export function parseOverviewReply(text) {
  const json = extractJson(text)
  if (!json || !Array.isArray(json.items)) return null
  const out = []
  for (const item of json.items.slice(0, 8)) {
    const body = clip(item?.text, ITEM_MAX_CHARS)
    if (body) out.push({ kind: OVERVIEW_KINDS.has(item?.kind) ? item.kind : 'note', text: body, confidence: confidenceOf(item?.confidence) })
  }
  return out
}

export class GroupMemoryJobs {
  /**
   * @param {object} opts
   * @param {import('../qq/corpus.js').Corpus} opts.corpus
   * @param {import('../memory/index.js').MemoryStore} opts.memory
   * @param {import('../group/settings.js').GroupSettings} opts.groupSettings
   * @param {{ run: Function }} opts.model createCheapModel 的返回值
   * @param {() => object} opts.qqConfig resolveConfig 的结果（判断哪些群在范围内）
   * @param {(groupId: string) => object} opts.settingsFor 这个群实际生效的设置（members / coldStart 在里面）
   * @param {{ owner?: Function }} [opts.owner]
   */
  constructor({ corpus, memory, groupSettings, model, qqConfig, settingsFor, owner = null, log = null, now = () => Date.now() }) {
    this.corpus = corpus
    this.memory = memory
    this.groupSettings = groupSettings
    this.model = model
    this.qqConfig = qqConfig
    this.settingsFor = settingsFor
    this.owner = owner
    this.log = log
    this.now = now
    this.running = null
    this.stats = { runs: 0, memberItems: 0, overviewItems: 0, skipped: 0, failures: 0, lastAt: 0, lastGroup: '', lastError: null }
  }

  /** 在范围内、语料里有的群 */
  groups() {
    const config = this.qqConfig()
    return this.corpus
      .listChats()
      .filter((c) => c.chatType === 'group' && inScope(config, 'group', c.chatId, this.owner, this.groupSettings))
      .map((c) => c.chatId)
  }

  /** 现在该做哪件事：冷启动优先，其次成员整理 */
  due() {
    const now = this.now()
    const out = []
    for (const groupId of this.groups()) {
      const st = this.settingsFor(groupId)
      const state = this.groupSettings?.stateOf(groupId) ?? {}
      if (st.coldStart.enabled && !state.coldStart?.doneAt && now - (state.coldStart?.checkedAt ?? 0) >= TICK_RECHECK_MS) {
        out.push({ groupId, job: 'coldStart', since: state.coldStart?.checkedAt ?? 0 })
      } else if (st.members.enabled && now - (state.members?.at ?? 0) >= st.members.everyHours * 3600 * 1000) {
        out.push({ groupId, job: 'members', since: state.members?.at ?? 0 })
      }
    }
    return out.sort((a, b) => (a.job === b.job ? a.since - b.since : a.job === 'coldStart' ? -1 : 1))
  }

  /** 定时器调用：一次只做一件事；上一件没做完就跳过 */
  tick() {
    if (this.running) return this.running
    const [next] = this.due()
    if (!next) return null
    this.running = (next.job === 'coldStart' ? this.runColdStart(next.groupId) : this.runMembers(next.groupId)).finally(() => {
      this.running = null
    })
    return this.running
  }

  #records(groupId, days, limit = MAX_RECORDS) {
    const since = this.now() - days * 24 * 3600 * 1000
    return this.corpus.search({ chatType: 'group', chatId: groupId, since, limit }).reverse()
  }

  async runMembers(groupId) {
    const st = this.settingsFor(groupId)
    this.stats.lastGroup = groupId
    if (!st.members.enabled) return { ok: false, reason: 'disabled' }
    const state = this.groupSettings?.stateOf(groupId) ?? {}
    const mark = Number(state.members?.mark) || 0
    const records = this.#records(groupId, st.members.days)
    const picked = pickMembers(records, { sinceTs: mark, minMessages: st.members.minMessages, maxPerRun: st.members.maxPerRun })
    const newest = records.reduce((m, r) => Math.max(m, r.ts ?? 0), mark)
    if (picked.length === 0) {
      this.stats.skipped += 1
      this.groupSettings?.patchState(groupId, { members: { at: this.now(), mark: newest } })
      return { ok: true, members: 0, added: 0 }
    }
    const { lines } = foldRecords(records)
    const prompt = [
      '=== 群聊记录 ===',
      ...lines,
      '',
      '=== 要整理的群友 ===',
      ...picked.map((m) => `${m.id}（${m.name || '昵称未知'}，新发言 ${m.count} 条）`),
      '',
      MEMBER_INSTRUCTION,
    ].join('\n')
    this.stats.runs += 1
    this.stats.lastAt = this.now()
    let parsed = null
    try {
      parsed = parseMemberReply(await this.model.run({ user: prompt, maxTokens: 1500, timeoutMs: 60000 }), picked.map((m) => m.id))
    } catch (error) {
      this.stats.failures += 1
      this.stats.lastError = error?.message ?? String(error)
      this.log?.warn?.(`[members] ${groupId} 整理失败: ${this.stats.lastError}`)
      return { ok: false, reason: 'model-failed', error: this.stats.lastError }
    }
    if (!parsed) {
      this.stats.failures += 1
      this.stats.lastError = '返回的 JSON 不对'
      return { ok: false, reason: 'bad-reply' }
    }
    let added = 0
    for (const item of parsed) {
      const out = this.memory.observe({
        scope: `member:${groupId}:${item.id}`, kind: item.kind, text: item.text, actor: MEMBER_ACTOR, origin: 'model',
        confidence: item.confidence, importanceDelta: 1, source: { at: this.now() },
      })
      if (out.action === 'new' || out.action === 'ask') added += 1
    }
    this.memory.flush?.()
    this.stats.memberItems += added
    this.stats.lastError = null
    this.groupSettings?.patchState(groupId, { members: { at: this.now(), mark: newest } })
    this.log?.info?.(`[members] ${groupId} 群成员记忆：整理 ${picked.length} 位，新增 ${added} 条`)
    return { ok: true, members: picked.length, added }
  }

  /** 群概况：只做一次，全部是候选记忆 */
  async runColdStart(groupId) {
    const st = this.settingsFor(groupId)
    this.stats.lastGroup = groupId
    if (!st.coldStart.enabled) return { ok: false, reason: 'disabled' }
    const records = this.#records(groupId, st.coldStart.days)
    const messages = records.filter((r) => r?.kind === 'message' && r.text)
    if (messages.length < st.coldStart.minMessages) {
      this.groupSettings?.patchState(groupId, { coldStart: { checkedAt: this.now(), doneAt: 0, seen: messages.length } })
      this.stats.skipped += 1
      return { ok: false, reason: 'too-few-messages', messages: messages.length }
    }
    const { lines } = foldRecords(records)
    const prompt = ['=== 群聊记录 ===', ...lines, '', OVERVIEW_INSTRUCTION].join('\n')
    this.stats.runs += 1
    this.stats.lastAt = this.now()
    let parsed = null
    try {
      parsed = parseOverviewReply(await this.model.run({ user: prompt, maxTokens: 1200, timeoutMs: 60000 }))
    } catch (error) {
      this.stats.failures += 1
      this.stats.lastError = error?.message ?? String(error)
      this.log?.warn?.(`[coldstart] ${groupId} 群概况失败: ${this.stats.lastError}`)
      return { ok: false, reason: 'model-failed', error: this.stats.lastError }
    }
    if (!parsed) {
      this.stats.failures += 1
      this.stats.lastError = '返回的 JSON 不对'
      return { ok: false, reason: 'bad-reply' }
    }
    let added = 0
    for (const item of parsed) {
      const out = this.memory.observe({
        scope: `chat:group:${groupId}`, kind: item.kind, text: item.text, actor: OVERVIEW_ACTOR, origin: 'model',
        confidence: item.confidence, status: 'candidate', source: { at: this.now() },
      })
      if (out.action === 'new' || out.action === 'ask') added += 1
    }
    this.memory.flush?.()
    this.stats.overviewItems += added
    this.stats.lastError = null
    this.groupSettings?.patchState(groupId, { coldStart: { checkedAt: this.now(), doneAt: this.now(), added } })
    this.log?.info?.(`[coldstart] ${groupId} 群概况：${added} 条候选记忆（等你在控制台转正）`)
    return { ok: true, added }
  }

  snapshot() {
    return { running: Boolean(this.running), ...this.stats }
  }
}

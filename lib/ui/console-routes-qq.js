/**
 * 控制台里 QQ 侧的接口：群聊、主动私聊主人、统一记忆页、信号。
 * 由 console-api.js 的 `createConsoleApi` 注册进同一张路由表；只做参数校验和转发，逻辑都在各自的模块里。
 *
 * 运行时对象（群决策引擎、主动联系……）由 QQ 插件登记在 `deps.qqStatus` 的服务表里，没登记就说“QQ 通道没有启用”。
 */
import { GROUP_MODES, settingsForGroup, GROUP_DEFAULTS } from '../group/config.js'
import { inScope } from '../qq/config.js'
import { VERDICTS } from '../memory/index.js'
import { readInterop, writeInterop } from '../memory/interop.js'
import { importQceExport, removeImported } from '../qq/qce-import.js'
import { listCorpusChats } from '../adapt/qq-corpus.js'

const GROUP_ID = /^\d{1,12}$/
const HHMM = /^(?:([01]?\d|2[0-3]):([0-5]\d))?$/

const MODE_LABEL = {
  silent: '潜水（只记录）', mention: '点名（被叫到才回）', present: '在场（点名之后接着聊）',
  active: '活跃（没人叫也可能插话）', watch: '盯群（一直看着群，主模型自己决定接不接）',
}

/** 控制台允许改的群设置，以及每一项的校验 */
const SETTING_RULES = {
  mode: (v) => GROUP_MODES.includes(v),
  eagerness: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  'reply.quote': (v) => typeof v === 'boolean',
  'reply.maxChars': (v) => Number.isInteger(v) && v >= 40 && v <= 4000,
  'members.enabled': (v) => typeof v === 'boolean',
  'coldStart.enabled': (v) => typeof v === 'boolean',
  'present.minutes': (v) => typeof v === 'number' && v >= 0 && v <= 1440,
  'present.messages': (v) => Number.isInteger(v) && v >= 0 && v <= 500,
  'quietHours.start': (v) => typeof v === 'string' && HHMM.test(v),
  'quietHours.end': (v) => typeof v === 'string' && HHMM.test(v),
  'budget.perHour': (v) => Number.isInteger(v) && v >= 0 && v <= 600,
  'budget.cooldownMs': (v) => typeof v === 'number' && v >= 0 && v <= 3_600_000,
  'timing.quietMs': (v) => typeof v === 'number' && v >= 0 && v <= 120_000,
  'watch.minIntervalMs': (v) => typeof v === 'number' && v >= 5000 && v <= 3_600_000,
  'watch.perHour': (v) => Number.isInteger(v) && v >= 1 && v <= 360,
  'watch.messages': (v) => Number.isInteger(v) && v >= 1 && v <= 60,
  'watch.chars': (v) => Number.isInteger(v) && v >= 200 && v <= 12000,
  'watch.activeIntervalMs': (v) => typeof v === 'number' && v >= 1000 && v <= 3_600_000,
  'watch.conversationWindowMs': (v) => typeof v === 'number' && v >= 0 && v <= 21_600_000,
  'watch.relaxMs': (v) => typeof v === 'number' && v >= 0 && v <= 21_600_000,
  'watch.activePerHour': (v) => Number.isInteger(v) && v >= 1 && v <= 3600,
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

function flatten(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isObject(value)) flatten(value, path, out)
    else out[path] = value
  }
  return out
}

function setPath(object, path, value) {
  const keys = path.split('.')
  let node = object
  for (const key of keys.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {}
    node = node[key]
  }
  if (value === null) delete node[keys.at(-1)]
  else node[keys.at(-1)] = value
}

/** 覆盖里有没有真正的内容：null、空对象、空数组都不算（旧数据里可能残留 null） */
const hasValue = (value) => {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (isObject(value)) return Object.values(value).some(hasValue)
  return true
}
const hasOverrides = (settings) => isObject(settings) && Object.values(settings).some(hasValue)

export function registerQqRoutes({ route, ok, fail, fromResult, deps }) {
  const svc = (name) => deps.qqStatus?.service?.(name) ?? null
  const unavailable = () => fail(503, 'QQ 通道没有启用，或还没启动完成')
  const memory = deps.memory ?? null

  // ── 群聊（UX 第 38 条）──────────────────────────────────────────────
  route('GET', /^\/group$/, () => {
    const g = svc('group')
    if (!g) return unavailable()
    const cfg = g.qqConfig
    const rows = new Map()
    const row = (id) => {
      if (!rows.has(id)) rows.set(id, { groupId: id, name: '', seenCount: 0, lastSeenAt: 0 })
      return rows.get(id)
    }
    for (const rec of g.settings.list()) Object.assign(row(rec.groupId), { name: rec.name ?? '', seenCount: rec.seenCount ?? 0, lastSeenAt: rec.lastSeenAt ?? 0, admittedRuntime: rec.admitted === true, overrides: rec.settings ?? {} })
    for (const id of cfg.scope.groups.map(String)) if (GROUP_ID.test(id)) row(id)
    for (const snap of g.engine.snapshot()) row(snap.groupId)
    const star = cfg.scope.groups.map(String).includes('*')
    /** 只回控制台要展示的那几段设置，避免把内部字段带出去 */
    const shape = (e) => ({
      mode: e.mode, eagerness: e.eagerness, reply: e.reply, members: e.members,
      coldStart: e.coldStart, present: e.present, quietHours: e.quietHours, budget: e.budget, watch: e.watch,
    })
    const globalOverrides = g.settings.global?.() ?? {}
    const groups = [...rows.values()].map((r) => {
      const effective = settingsForGroup(g.engine.config, r.groupId, g.settings.get(r.groupId), globalOverrides)
      const snap = g.engine.snapshot(`group:${r.groupId}`)
      return {
        ...r,
        admittedRuntime: r.admittedRuntime === true,
        viaConfig: star || cfg.scope.groups.map(String).includes(r.groupId),
        blocked: cfg.scope.blockedGroups.map(String).includes(r.groupId),
        inScope: inScope(cfg, 'group', r.groupId, deps.owner ?? null, g.settings),
        overrides: r.overrides ?? {},
        /** 没有任何按群覆盖 = 跟随“所有群统一设置” */
        followsGlobal: !hasOverrides(r.overrides),
        settings: shape(effective),
        engine: snap ? { ...snap, decisions: snap.decisions.slice(0, 10) } : null,
        interjects: g.settings.interjectStats(r.groupId),
        memberMemories: memory ? memory.list({ scopePrefix: `member:${r.groupId}:` }).length : 0,
        candidates: memory ? memory.list({ scope: `chat:group:${r.groupId}`, status: 'candidate' }).length : 0,
        jobState: g.settings.stateOf(r.groupId),
      }
    }).sort((a, b) => Number(b.inScope) - Number(a.inScope) || b.lastSeenAt - a.lastSeenAt)
    return ok({
      defaultMode: g.engine.config.defaultMode,
      modes: GROUP_MODES.map((id) => ({ id, label: MODE_LABEL[id] })),
      judge: { config: g.engine.config.judge, status: g.judge.status() },
      memberJobs: svc('memberJobs')?.snapshot() ?? null,
      defaults: { eagerness: GROUP_DEFAULTS.eagerness },
      /** 所有群统一设置：没单独设置的群都跟随它 */
      global: {
        overrides: globalOverrides,
        settings: shape(settingsForGroup(g.engine.config, 'global', null, globalOverrides)),
        follows: groups.filter((x) => x.followsGlobal && x.inScope).length,
        overridden: groups.filter((x) => !x.followsGlobal).length,
      },
      groups,
    })
  })

  route('PUT', /^\/group\/(\d{1,12})\/admit$/, ({ match, body }) => {
    const g = svc('group')
    if (!g) return unavailable()
    if (typeof body?.admitted !== 'boolean') return fail(400, 'admitted 必须是布尔值')
    g.settings.setAdmitted(match[1], body.admitted)
    deps.log?.info?.(`[group] 控制台${body.admitted ? '打开' : '关闭'}了群 ${match[1]}`)
    return ok({ groupId: match[1], admitted: body.admitted })
  })

  route('PUT', /^\/group\/(\d{1,12})\/settings$/, ({ match, body }) => {
    const g = svc('group')
    if (!g) return unavailable()
    if (!isObject(body)) return fail(400, '需要一个设置对象')
    const flat = flatten(body)
    const next = JSON.parse(JSON.stringify(g.settings.get(match[1])?.settings ?? {}))
    for (const [path, value] of Object.entries(flat)) {
      const rule = SETTING_RULES[path]
      if (!rule) return fail(400, `不能改这一项：${path}`)
      if (value !== null && !rule(value)) return fail(400, `${path} 的值不合法`)
      setPath(next, path, value)
    }
    g.settings.replaceSettings(match[1], next)
    const effective = settingsForGroup(g.engine.config, match[1], g.settings.get(match[1]), g.settings.global?.() ?? {})
    return ok({ groupId: match[1], overrides: next, warnings: effective.warnings })
  })

  // “所有群统一设置”：没单独设置的群都跟随它
  route('PUT', /^\/group\/global-settings$/, ({ body }) => {
    const g = svc('group')
    if (!g) return unavailable()
    if (!isObject(body)) return fail(400, '需要一个设置对象')
    const flat = flatten(body)
    const next = JSON.parse(JSON.stringify(g.settings.global?.() ?? {}))
    for (const [path, value] of Object.entries(flat)) {
      const rule = SETTING_RULES[path]
      if (!rule) return fail(400, `不能改这一项：${path}`)
      if (value !== null && !rule(value)) return fail(400, `${path} 的值不合法`)
      setPath(next, path, value)
    }
    g.settings.replaceGlobal(next)
    const effective = settingsForGroup(g.engine.config, 'global', null, next)
    deps.log?.info?.('[group] 控制台更新了所有群的统一设置')
    return ok({ overrides: next, warnings: effective.warnings })
  })

  route('DELETE', /^\/group\/global-settings$/, () => {
    const g = svc('group')
    if (!g) return unavailable()
    g.settings.replaceGlobal({})
    deps.log?.info?.('[group] 控制台清空了所有群的统一设置')
    return ok({ overrides: {}, warnings: [] })
  })

  // 只清掉这个群的单独设置，改为跟随统一设置
  route('DELETE', /^\/group\/(\d{1,12})\/settings$/, ({ match }) => {
    const g = svc('group')
    if (!g) return unavailable()
    const cleared = g.settings.clearGroupSettings(match[1])
    if (!cleared) return fail(404, '没有这个群的设置记录')
    return ok({ groupId: match[1], overrides: {}, warnings: [] })
  })

  // 所有群都改成跟随统一设置
  route('POST', /^\/group\/apply-global$/, () => {
    const g = svc('group')
    if (!g) return unavailable()
    const cleared = g.settings.clearAllGroupSettings()
    deps.log?.info?.(`[group] 控制台把 ${cleared} 个群改回跟随统一设置`)
    return ok({ cleared })
  })

  // 把这个群的单独设置提为“所有群统一设置”（然后所有群都跟随）
  route('POST', /^\/group\/(\d{1,12})\/promote$/, ({ match }) => {
    const g = svc('group')
    if (!g) return unavailable()
    const overrides = g.settings.get(match[1])?.settings ?? {}
    // 跟随中的群没有单独覆盖：以前这里会拿 {} 去 replaceGlobal 把统一设置清空
    if (!hasOverrides(overrides)) return fail(400, '这个群没有单独设置（跟随统一设置），没有可提升的内容')
    g.settings.replaceGlobal(overrides)
    const cleared = g.settings.clearAllGroupSettings()
    deps.log?.info?.(`[group] 控制台把群 ${match[1]} 的设置提为所有群的统一设置`)
    return ok({ groupId: match[1], overrides, cleared })
  })

  route('DELETE', /^\/group\/(\d{1,12})$/, ({ match }) => ok({ removed: svc('group')?.settings.forget(match[1]) ?? false }))

  // “忘掉我”：删这个人在该群的成员记忆并屏蔽之后的写入，可选同时删他在语料库里的原话
  route('POST', /^\/group\/(\d{1,12})\/forget-member$/, ({ match, body }) => {
    const g = svc('group')
    if (!g || !memory) return unavailable()
    const memberId = String(body?.memberId ?? '')
    if (!GROUP_ID.test(memberId)) return fail(400, 'memberId 必须是 QQ 号')
    const removed = memory.purge({ scope: `member:${match[1]}:${memberId}`, block: true }, 'console')
    const messages = body?.deleteMessages === true ? g.corpus.purgeMember('group', match[1], memberId) : null
    deps.log?.info?.(`[group] 控制台对群 ${match[1]} 的成员 ${memberId} 执行了“忘掉我”：记忆 ${removed} 条${messages === null ? '' : `，原话 ${messages} 条`}`)
    return ok({ removedMemories: removed, removedMessages: messages })
  })

  // ── 主动私聊主人（PLAN 第 45 条）─────────────────────────────────────
  route('GET', /^\/outreach$/, () => {
    const o = svc('outreach')
    if (!o) return fail(503, '主动私聊没有启用（需要先配对主人，QQ 通道要在运行）')
    return ok({ ...o.snapshot() })
  })
  route('PUT', /^\/outreach$/, ({ body }) => {
    const o = svc('outreach')
    if (!o) return fail(503, '主动私聊没有启用')
    const allowed = ['enabled', 'maxPerDay', 'minGapMs', 'maxGapMs', 'ownerQuietMs', 'quietHours']
    const patch = {}
    for (const key of allowed) if (body && key in body) patch[key] = body[key]
    if ('enabled' in patch && typeof patch.enabled !== 'boolean') return fail(400, 'enabled 必须是布尔值')
    const config = o.setOverrides(patch)
    deps.log?.info?.(`[outreach] 控制台修改设置：${JSON.stringify(Object.keys(patch))}，现在${config.enabled ? '开着' : '关着'}`)
    return ok({ ...o.snapshot(), warnings: config.warnings })
  })
  route('POST', /^\/outreach\/preview$/, async () => {
    const o = svc('outreach')
    if (!o) return fail(503, '主动私聊没有启用')
    const p = await o.preview()
    return ok({ pass: p.ok, gates: p.gates, topic: p.topic, prompt: p.prompt })
  })
  route('POST', /^\/outreach\/reset$/, () => {
    const o = svc('outreach')
    if (!o) return fail(503, '主动私聊没有启用')
    o.reset()
    return ok({ ...o.snapshot() })
  })

  // ── 梗百科：联网、同步、存档 ─────────────────────────────────────────
  const meme = deps.meme ?? null
  route('PUT', /^\/meme\/settings$/, ({ body }) => {
    if (!meme) return fail(503, '梗百科没有启用')
    if (typeof body?.online !== 'boolean') return fail(400, 'online 必须是布尔值')
    const settings = meme.setSettings({ online: body.online })
    deps.log?.info?.(`[meme] 控制台${settings.online ? '打开' : '关闭'}了联网查词`)
    return ok({ settings })
  })
  route('POST', /^\/meme\/sync$/, async ({ body }) => {
    if (!meme?.online) return fail(503, '梗百科没有启用')
    if (meme.online.job?.running) return fail(409, '已经有一个同步在跑了', { job: meme.online.status().job })
    const limit = Number.isInteger(body?.limit) && body.limit >= 0 ? body.limit : 0
    void meme.online.sync({ incremental: body?.full !== true, limit })
    await new Promise((resolve) => setTimeout(resolve, 20))
    return ok({ job: meme.online.status().job })
  })
  route('DELETE', /^\/meme\/sync$/, () => {
    if (!meme?.online) return fail(503, '梗百科没有启用')
    meme.online.stop()
    return ok({ job: meme.online.status().job })
  })
  route('DELETE', /^\/meme\/archive$/, () => {
    if (!meme?.archive) return fail(503, '梗百科没有启用')
    return ok({ removed: meme.archive.clear() })
  })

  // ── 统一记忆页（PLAN 第 18 条）───────────────────────────────────────
  const view = (e) => ({
    id: e.id, scope: e.scope, area: e.area ?? '', kind: e.kind, text: e.text, status: e.status, origin: e.origin, pinned: e.pinned, quiet: e.quiet,
    importance: e.importance, confidence: e.confidence, validUntil: e.validUntil, createdAt: e.createdAt, updatedAt: e.updatedAt,
    ledger: { refs: e.ledger?.refs ?? 0, injected: e.ledger?.injected ?? 0, recalled: e.ledger?.recalled ?? 0, corrected: e.ledger?.corrected ?? 0 },
    sources: (e.sources ?? []).map((s) => ({ quote: s.quote ?? '', at: s.at ?? 0 })),
    history: (e.history ?? []).slice(-3),
  })
  route('GET', /^\/memory\/interop$/, () => {
    if (!memory) return fail(503, '记忆层没有启用')
    return ok(readInterop(memory.dir))
  })
  // 「读全开」：开了以后任何会话翻记忆时都能查到全部范围（注入不变，仍按会话切，免得挤爆预算）
  route('PUT', /^\/memory\/interop$/, ({ body }) => {
    if (!memory) return fail(503, '记忆层没有启用')
    if (!isObject(body)) return fail(400, '需要一个对象')
    const next = writeInterop(memory.dir, { readAll: body.readAll === true })
    deps.log?.info?.(`[memory] 读全开：${next.readAll ? '开（所有会话可翻全部）' : '关'}`)
    return ok(next)
  })
  route('GET', /^\/memory\/scopes$/, () => {
    if (!memory) return fail(503, '记忆层没有启用')
    const by = new Map()
    // 所有人都能看的「书架」范围即使还是空的也要列出来，不然控制台里根本看不见它存在
    by.set('shared', { scope: 'shared', total: 0, active: 0, candidate: 0, rejected: 0, historical: 0 })
    const areas = new Map()
    for (const e of memory.export({}).entries) {
      const row = by.get(e.scope) ?? { scope: e.scope, total: 0, active: 0, candidate: 0, rejected: 0, historical: 0 }
      row.total += 1
      row[e.status] = (row[e.status] ?? 0) + 1
      by.set(e.scope, row)
      const area = String(e.area ?? '')
      if (area) {
        const a = areas.get(area) ?? { area, total: 0, scopes: new Set() }
        a.total += 1
        a.scopes.add(e.scope)
        areas.set(area, a)
      }
    }
    return ok({
      scopes: [...by.values()].sort((a, b) => a.scope.localeCompare(b.scope)),
      areas: [...areas.values()]
        .map((a) => ({ area: a.area, total: a.total, scopes: [...a.scopes] }))
        .sort((a, b) => b.total - a.total || a.area.localeCompare(b.area)),
    })
  })
  route('GET', /^\/memory$/, ({ query }) => {
    if (!memory) return fail(503, '记忆层没有启用')
    const scope = String(query.get('scope') ?? '')
    const status = String(query.get('status') ?? '')
    const kind = String(query.get('kind') ?? '')
    const needle = String(query.get('q') ?? '').trim().toLowerCase()
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200))
    const filter = {}
    if (scope) filter.scope = scope
    if (status) filter.status = status
    if (kind) filter.kind = kind
    let entries = memory.export(filter).entries
    if (needle) entries = entries.filter((e) => e.text.toLowerCase().includes(needle))
    entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return ok({ total: entries.length, entries: entries.slice(0, limit).map(view) })
  })
  route('POST', /^\/memory\/(m\d{6})\/judge$/, ({ match, body }) => {
    if (!memory) return fail(503, '记忆层没有启用')
    const verdict = String(body?.verdict ?? '')
    if (!VERDICTS.has(verdict)) return fail(400, `不认识的裁决：${verdict}`)
    const options = { actor: 'console' }
    if (typeof body?.text === 'string') options.text = body.text
    if (typeof body?.boundary === 'string') options.boundary = body.boundary
    if (typeof body?.scope === 'string') options.scope = body.scope
    const result = memory.judge(match[1], verdict, options)
    return result?.ok ? ok({ entry: view(memory.get(match[1]) ?? { id: match[1] }) }) : fail(409, String(result?.error ?? '裁决没有生效'))
  })
  route('POST', /^\/memory\/purge$/, ({ body }) => {
    if (!memory) return fail(503, '记忆层没有启用')
    const scope = String(body?.scope ?? '')
    if (!scope) return fail(400, '需要 scope')
    if (body?.confirm !== '忘掉') return fail(400, '请在确认框里输入「忘掉」')
    const removed = memory.purge({ scope, block: body?.block === true }, 'console')
    deps.log?.info?.(`[memory] 控制台清空了范围 ${scope}（${removed} 条${body?.block === true ? '，并屏蔽之后的写入' : ''}）`)
    return ok({ removed })
  })

  // ── 信号 ────────────────────────────────────────────────────────────
  route('GET', /^\/signals$/, () => ok({ recent: deps.signals?.recent?.(60) ?? [], corrections: svc('corrections')?.snapshot() ?? null }))

  // ── 导入 QQ Chat Exporter 导出的聊天记录 ─────────────────────────────
  const importRoot = () => deps.importRoot ?? null
  route('GET', /^\/qq\/imported$/, () => {
    const root = importRoot()
    if (!root) return unavailable()
    const chats = listCorpusChats(deps.corpusRoot).filter((c) => (c.importedDays ?? 0) > 0)
    return ok({ root, chats })
  })
  route('POST', /^\/qq\/import$/, async ({ body }) => {
    const root = importRoot()
    if (!root) return unavailable()
    const source = String(body?.path ?? '').trim()
    if (!source) return fail(400, '请给出导出的 .json 文件或分块导出的目录')
    const chatId = String(body?.chatId ?? '').trim()
    if (chatId && !GROUP_ID.test(chatId)) return fail(400, '群号需要是纯数字')
    const result = await importQceExport({ source, importRoot: root, chatId, ownerQq: deps.owner?.owner?.() ?? '' })
    if (!result.ok) return fail(400, result.error)
    deps.log?.info?.(`[qq] 导入 QQ Chat Exporter 记录：${result.chatType}/${result.chatId} 新增 ${result.imported} 条，重复 ${result.duplicate} 条`)
    return ok(result)
  })
  route('DELETE', /^\/qq\/imported\/(group|private)\/(\d{1,12})$/, ({ match }) => {
    const root = importRoot()
    if (!root) return unavailable()
    return ok({ removed: removeImported(root, match[1], match[2]) })
  })
}

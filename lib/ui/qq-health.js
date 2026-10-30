/**
 * QQ 体检视图：把 QQ 侧的状态快照翻译成“结论 + 下一步”，给控制台的 QQ 页用（`GET /api/qq/health`）。
 *
 * 原先这是一张挂在 OneBot 端口上、不用登录就能看的整页 HTML；里面有工作区路径、群名、selfId。
 * 现在只在控制台登录后可见，页面由控制台前端渲染（守 CSP，不内联脚本），这里只产出结构化数据。
 * OneBot 端口上只留一个不含任何身份信息的最小健康检查（见 `minimalHealth`）。
 */

/** 毫秒 → 人话。负数/缺失一律显示"—"。 */
export function humanDuration(ms) {
  // null 必须单独拦：Number(null) === 0，会把“不知道”显示成“0 毫秒前”。
  if (ms === null || ms === undefined || ms === '') return '—'
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} 毫秒`
  // 90 秒这类阈值直接四舍五入成“2 分钟”会像是另一个数，所以留一位小数。
  if (value < 90_000) return `${Math.round(value / 1000)} 秒`
  if (value < 3_600_000) {
    return `${(value / 60_000).toFixed(1).replace(/\.0$/, '')} 分钟`
  }
  return `${(value / 3_600_000).toFixed(1)} 小时`
}

/** 字节 → 人话。 */
export function humanBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 针对 health.issues 的一条，给一句"该动哪里"。
 *
 * 不追求覆盖全部（issues 是宿主写的自由文本），只覆盖**首次接入最常撞的几类**；
 * 匹配不上时返回空串，页面就不显示建议 —— 不猜。
 * @param {string} issue
 * @returns {string}
 */
export function nextStepFor(issue) {
  const text = String(issue ?? '')
  // 顺序必须是“具体 → 笼统”：`连接` / `交班` 这种宽词会盖住更具体的原因
  // （`连接层未初始化` 不是 NapCat 没开，而是 DSH 的 webServer 没就绪）。
  if (text.includes('未初始化') || text.includes('webServer')) {
    return 'DSH 的 Web 服务还没就绪：重启 DSH，或确认当前 profile 里有 webServer 服务（不是协议端的问题）。'
  }
  if (text.includes('交班流程异常') || text.includes('归档失败')) {
    return '看日志里的 lastError 与 $DSH_HOME/shall/qq/plugin.log；归档失败通常是磁盘权限或会话仍有活动。'
  }
  if (text.includes('contextWindow') || text.includes('交班阈值')) {
    return '交班需要先跑完一个回合才能测出上下文窗口；如果一直测不到，确认宿主会话正常。'
  }
  if (text.includes('建过工作区但从未建成会话') || text.includes('派活链路')) {
    return '派活链路可能有问题：看状态端点 bridge.stats.lastError 与 plugin.log，确认 DSH 的 workspace/session 服务可用。'
  }
  if (text.includes('workspaceRoot')) {
    return '在 DSH 设置 → 插件 → dsh-whale-shall-adapt 里把 tasks.workspaceRoot 填成绝对路径（如 D:\\qq-projects），并确认该目录可写。'
  }
  if (text.includes('access token') || text.includes('token')) {
    return '在 DSH 凭据里添加 SHALL_ONEBOT_TOKEN，并让 NapCat 的 onebot11.json 里 token 与它一致；也可以直接在插件配置的 connection.token 里填。'
  }
  if (text.includes('协议端') || text.includes('NapCat') || text.includes('没有可用连接')) {
    return '确认 NapCat 已启动并扫码登录，且它的 websocketClients.url 指向本插件监听的地址与端口（默认 ws://127.0.0.1:6700）。'
  }
  if (text.includes('端口') || text.includes('EADDRINUSE')) {
    return '端口被别的进程占着：关掉残留的旧实例，或把 connection.reversePort 换一个端口，并同步改 NapCat 的 url。'
  }
  if (text.includes('桥接') || text.includes('DSH')) {
    return 'DSH 的 workspace / session 服务还没就绪：重启 DSH，或确认当前 profile 里有这些服务。'
  }
  if (text.includes('语料库')) {
    return '检查 $DSH_HOME/shall/qq/corpus 是否可写；磁盘满或权限不足都会让采集停摆。'
  }
  return ''
}


/** 取嵌套字段，缺了返回 undefined（老版本快照少一个字段时不能出错）。 */
function pick(object, path) {
  let current = object
  for (const key of String(path).split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

const obj = (value) => (value && typeof value === 'object' ? value : {})

/**
 * 控制台 QQ 页要显示的全部内容。所有文字在这里拼好，前端只负责摆放，不自己推断状态。
 * @param {object|null} snapshot QQ 侧的 statusSnapshot()
 */
export function buildHealthView(snapshot) {
  const data = obj(snapshot)
  const health = obj(data.health)
  const alive = obj(data.alive)
  const config = obj(data.config)
  const connection = data.connection && typeof data.connection === 'object' ? data.connection : null
  const corpus = obj(data.corpus)
  const conversation = obj(data.conversation)
  const pipeline = obj(data.pipeline)
  const relay = obj(data.relay)

  const issues = (Array.isArray(health.issues) ? health.issues : []).map((text) => ({ text: String(text), nextStep: nextStepFor(text) }))
  const passed = (Array.isArray(health.ok) ? health.ok : []).map(String)
  const healthy = health.verdict === 'ok'
  const verdict = healthy
    ? { tone: 'ok', title: '一切正常', note: '插件、连接、工作区与常驻会话都通过了检查。下面是可以核对的依据。' }
    : issues.length > 0
      ? { tone: 'warn', title: `有 ${issues.length} 项需要处理`, note: '先看下面「要处理的事」，每条都给了下一步。' }
      : { tone: 'warn', title: '状态还不完整', note: '插件可能还没完成启动，或只拿到了半份数据；稍后刷新一次再看。' }

  // 从没收到过事件时 silentForMs 是 0，直接显示会变成“最后事件 0 毫秒前”：看 lastEventAt 判断有没有事件
  const silentFor = humanDuration(pick(alive, 'evidence.silentForMs'))
  const lastEventAt = Number(pick(alive, 'evidence.lastEventAt'))
  const silentRaw = Number(pick(alive, 'evidence.silentForMs'))
  const hasEvent = (Number.isFinite(lastEventAt) && lastEventAt > 0) || (Number.isFinite(silentRaw) && silentRaw > 0)
  const silence = silentFor === '—' ? '最后事件时间未知' : hasEvent ? `最后事件 ${silentFor}前` : '尚未收到事件'
  const sinceTick = humanDuration(pick(alive, 'evidence.sinceTickMs'))

  const stats = obj(pipeline.stats)
  const facts = [
    { label: '协议端连接', value: connection ? `${connection.active ?? 0} 条` : '未初始化',
      note: connection?.selfIds?.length ? `bot 账号 ${connection.selfIds.join('、')}` : '' },
    { label: '工作区父目录', value: config.workspaceRoot || '（未配置）',
      note: config.workspaceRoot ? '每个 QQ 会话在其下建一个子目录' : '必填，否则会话无处落盘' },
    { label: '语料库', value: `${corpus.chats ?? 0} 个会话`, note: `${humanBytes(corpus.bytes)} · 保留 ${corpus.retainDays ?? '—'} 天` },
    { label: '常驻对话', value: '开启', note: `交班阈值 ${Math.round((Number(config.handoffAtRatio) || 0) * 100)}% 窗口` },
    { label: '收到消息', value: stats.messages ?? '—',
      note: `事件 ${stats.events ?? 0} · 去重 ${stats.duplicates ?? 0} · 越界 ${stats.outOfScope ?? 0}` },
    { label: '回传判定', value: relay.provenanceDecided ?? '—',
      note: `GUI 发起而跳过 ${relay.skippedForeign ?? 0} 次${relay.provenanceUnknown ? ` · 来源未定型 ${relay.provenanceUnknown} 次（异常，检查 user/message 是否送达）` : ''}` },
  ]

  const idle = obj(conversation.idle)
  if (conversation.idle) {
    facts.push({ label: '空闲整理', value: idle.enabled ? `已整理 ${idle.runs ?? 0} 次` : '关闭',
      note: idle.enabled ? `停 ${idle.idleMinutes} 分钟且新增 ≥ ${idle.idleMinTurns} 条发言时整理；累计新增 ${idle.extracted ?? 0} 条记忆` : '' })
  }

  const chats = (Array.isArray(conversation.chats) ? conversation.chats : []).slice(0, 20).map((row) => ({
    name: row.chatName || row.chatId || row.scope || '（未命名）',
    generation: row.generation ?? null,
    totalTokens: Number.isFinite(row.totalTokens) ? Math.round(row.totalTokens) : null,
    progressPercent: Number.isFinite(row.progressPercent) ? Math.min(100, Math.max(0, row.progressPercent)) : null,
  }))

  return {
    version: data.version ?? null,
    generatedAt: Number(data.now) || null,
    verdict,
    issues,
    passed,
    alive: {
      alive: alive.alive === true,
      because: (Array.isArray(alive.because) ? alive.because : []).map(String),
      silence,
      tick: sinceTick === '—' ? '计时器状态未知' : `计时器 ${sinceTick}前跑过`,
      silenceLimit: humanDuration(pick(alive, 'evidence.eventSilenceMs')),
    },
    facts,
    chats,
    config: [
      { label: '连接方式', value: `${config.mode ?? '—'} · 挂载 ${config.mount ?? '—'}${config.port ? ` · 端口 ${config.port}` : ''} · 路径 ${config.path ?? '—'}` },
      { label: '鉴权', value: config.authRequired ? '已配置 access token' : '未配置（不建议）' },
      { label: '群聊参与', value: config.groupMode ?? '—' },
      { label: '日志', value: data.logFile ?? '—' },
    ],
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
  }
}

/**
 * OneBot 端口上不用登录的那一点：只回答“插件在不在、通道通不通”。
 * 不带 chatId、群名、bot 账号、路径、配置，谁都可以看，看了也拿不到任何身份信息。
 */
export function minimalHealth(snapshot) {
  const data = obj(snapshot)
  return {
    ok: obj(data.health).verdict === 'ok',
    alive: obj(data.alive).alive === true,
    connections: Number(obj(data.connection).active) || 0,
    version: data.version ?? null,
    detail: '完整体检在 shall 控制台的「QQ」页（需要登录）',
  }
}

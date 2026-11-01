/**
 * 配置解析：把宿主传入的原始 config 与默认值深合并，并做基本校验。
 * 默认值对齐 qq-dsh-design/设计文档.md 第 7 节。
 */
import path from 'node:path'
import { resolveGroupConfig } from '../group/config.js'

/**
 * 完全限定路径判定 —— 与 DSH 内部 `fullyQualifiedWorkspacePath` 保持同一口径。
 * Windows 上 `\x` 与 `/x` 虽然 isAbsolute 为真，但根是 `\` 或 `/`，
 * DSH 同样视为不合格。
 */
function isFullyQualifiedPath(value) {
  const p = String(value ?? '')
  if (process.platform !== 'win32') return path.posix.isAbsolute(p)
  const root = path.win32.parse(p).root
  return path.win32.isAbsolute(p) && root !== '\\' && root !== '/'
}

export const DEFAULT_CONFIG = {
  /** 日志级别：debug | info | warn | error */
  logLevel: 'info',

  connection: {
    /**
     * 反向 WS 服务端的挂载方式：
     *   own — 插件自建 HTTP 服务端监听 reversePort（默认）。与 NapCat 现有配置对齐，
     *         不占用 DSH 的路由空间，也不受 DSH 端口变化影响。
     *   dsh — 挂在 DSH 的 webServer 上；此时 NapCat 必须指向 DSH 的端口。
     */
    mount: 'own',
    /** 自建服务端的监听地址。只绑本机，不要暴露到公网 */
    host: '127.0.0.1',
    /** 自建服务端的端口（NapCat 的 websocketClients.url 要与此一致） */
    reversePort: 6700,
    /** 反向 WS 的路径。NapCat 配的是 ws://127.0.0.1:6700，即根路径 */
    reversePath: '/',
    /** access token 在 ctx.credentials 里的 key */
    tokenRef: 'SHALL_ONEBOT_TOKEN',
    /** 兜底 token（仅当 credentials 里取不到时使用）。凭据和这里都为空时**拒绝所有连接** */
    token: '',
    /**
     * 没有任何 token 时是否仍允许接入。默认 false（fail-closed）：
     * 本机任何进程都能连 6700，连上来就能伪造"主人私聊"、读走 bot 收到的消息，
     * 所以不配置 token 时宁可连不上，也不默默放行。只在本机调试时才打开。
     */
    allowNoToken: false,
    /** 单次动作调用超时 */
    callTimeoutMs: 15000,
  },

  scope: {
    groups: [],
    friends: [],
    blockedGroups: [],
    blockedFriends: [],
  },

  participation: {
    /** always = 私聊全部处理（群聊的档位在 `group.defaultMode` 和各群的运行时设置里） */
    privateMode: 'always',
    /** 群里叫 bot 的名字：不带前缀全局生效，“群号:名字”只在那个群生效。叫到、@、回复 bot 的话都算点名 */
    aliases: [],
    /** 戳一戳 bot 时当成一句“（戳了戳你）”回应（同一会话 60 秒内只响应一次） */
    poke: true,
    /** 同一个人连发的话，安静这么多毫秒后合并成一条再处理。0 = 不合并 */
    mergeMs: 1200,
    /** 已知是别的 bot 的 QQ 号：它们说话不主动接，连环 @ 本 bot 时限次响应 */
    knownBots: [],
    /** 消息里的图片随消息一起交给常驻会话的模型看（模型不支持看图时自动退回纯文字） */
    images: true,
    maxImages: 3,
    maxImageBytes: 4 * 1024 * 1024,
    /** 把图片/语音/视频的地址一并写进交给会话的正文（只展示，不抓取） */
    mediaUrls: true,
    /** 语音用 QQ 自带的转写（NapCat 的 fetch_ptt_text），失败就只给地址 */
    voiceText: true,
  },

  tasks: {
    workspaceRoot: '',
    /** 任务前缀：命中后强制当任务（优先级高于 chatPrefix） */
    prefix: '',
    /** 闲聊前缀：命中后强制当闲聊，进常驻 root session */
    chatPrefix: '',
  },

  ingest: {
    forwardRecords: true,
    groupArchive: true,
  },

  /** 常驻对接会话 + 阈值交班 + 碎片记忆。 */
  conversation: {
    /**
     * 0.25 而不是 0.55。本 profile 实测：compaction-basic 的 auto 为 **true**
     * （`dsh-compaction-basic/lib/index.js:85` `auto: config.auto ?? true`），
     * `contextWindow=1000000`（`cordis.patch.yml:38`）、`thresholdRatio=0.8`、
     * `headroomTokens=65536` → **压缩触发点 = 800,000 token**。
     * 0.25 → 250,000 token 触发交班，距压缩点 55 万 token 安全边距。
     * 代价不对称：交班无损，触发早了只浪费一次 LLM 调用；触发晚了才是有损。
     */
    handoffAtRatio: 0.25,
    minTokensBetweenHandoffs: 20000,
    memoryBudgetTokens: 2000,
    injectMode: 'context',
    handoffRetainDays: 90,
    handoffInputChars: 120000,
    handoffMaxTokens: 4000,
    fragmentMergeJaccard: 0.82,
    /**
     * ⚠️ **0.30，偏离设计文档 §4 的 0.60 —— 有实测依据，见 README 的标定数据。**
     *
     * 实测（tools/tmp-jaccard2.mjs，8 组真实改写 + 4 组"只差一个参数"）：
     *   真实改写的字符 3-gram Jaccard 只有 **0.06—0.43**（如 `用户在做并购商誉减值的论文`
     *   vs `他那个并购商誉减值的毕业论文` = **0.206**）；
     *   而"只差一个关键参数"的两条反而更高：`不要动 R:\ 下的原始数据`
     *   vs `不要动 D:\ 下的原始数据` = **0.500**。
     *
     * 也就是说：**在这个区间里"高相似"根本不等于"同一条"**。
     * 若按 0.60，真正的改写一条都进不了"可能重复"档 → LLM 裁决永不触发 →
     * 记忆池被近义碎片灌满（设计文档 §6 #6 说的就是这个失效模式）。
     * 取 0.30 让改写进入 LLM 裁决档，而参数差异对（0.50）同样进去 ——
     * **由 LLM 判断，不由字符串判断**，这正是设计文档"③ 交给同一次 LLM 裁决"的本意。
     *
     * 另一半保障：无论这个值是多少，**"可能重复"档永不自动合并**（见 memory.js 的 observe）。
     * 所以调低它只会增加 LLM 裁决的机会，不会增加误合并的风险。
     */
    fragmentAskJaccard: 0.3,
    agingEveryGens: 10,
    /** 每个 QQ 会话的碎片数量上限。老化管不了"每代都新增好几条"，这个上限兜底 */
    maxFragmentsPerChat: 500,
    /** 空闲整理：聊天停下来这么多分钟、且新增至少 idleMinTurns 条用户发言时提取一次记忆。0 = 关闭 */
    idleMinutes: 20,
    idleMinTurns: 3,
  },

  corpus: {
    retainDays: 30,
  },

  /** 高级选项。为兼容早期扁平配置，解析后会同时投影出一层扁平别名 */
  advanced: {
    /** 去重窗口（毫秒） */
    dedupeWindowMs: 5 * 60 * 1000,
    /** 去重缓存上限 */
    dedupeMaxEntries: 4096,
    /** 进度回传的节流窗口（毫秒） */
    relayFlushMs: 2000,
    /** 状态文件目录，留空用 $DSH_HOME/shall/qq */
    stateDir: '',
  },
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** 深合并：数组整体替换，对象递归 */
function merge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v
  }
  return out
}

/**
 * @param {object} raw 宿主传入的 config
 * @returns {typeof DEFAULT_CONFIG & { warnings: string[] }}
 */
export function resolveConfig(raw = {}) {
  const merged = merge(DEFAULT_CONFIG, raw ?? {})
  const warnings = []

  if (!['own', 'dsh'].includes(merged.connection.mount)) {
    warnings.push(`connection.mount="${merged.connection.mount}" 无法识别，已回退为 own`)
    merged.connection.mount = 'own'
  }
  const port = Number(merged.connection.reversePort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`connection.reversePort="${merged.connection.reversePort}" 非法，已回退为 6700`)
    merged.connection.reversePort = 6700
  }
  // 单次动作调用的等待上限：非正/非有限数一律回退默认值。
  // ⚠️ `null` 会一路落到 `setTimeout(fn, null)` —— 那等于"立刻到点"，所有 OneBot 动作
  //    全废，而症状是"发什么都出不去"，看不出与这一项配置有关。
  //    与 reversePort 同一口径：宁可回退并警告。
  const callTimeout = Number(merged.connection.callTimeoutMs)
  if (!Number.isFinite(callTimeout) || callTimeout < 1000) {
    warnings.push(
      `connection.callTimeoutMs="${merged.connection.callTimeoutMs}" 非法（需要 ≥1000 的有限数），已回退为 15000`,
    )
    merged.connection.callTimeoutMs = 15000
  }
  if (!merged.connection.reversePath.startsWith('/')) {
    merged.connection.reversePath = `/${merged.connection.reversePath}`
  }
  const groupConfig = resolveGroupConfig(raw?.group)
  warnings.push(...groupConfig.warnings)
  merged.group = groupConfig
  const mergeMs = Number(merged.participation.mergeMs)
  if (!Number.isFinite(mergeMs) || mergeMs < 0 || mergeMs > 30000) {
    warnings.push(`participation.mergeMs="${merged.participation.mergeMs}" 非法（需要 0–30000），已回退为 1200`)
    merged.participation.mergeMs = 1200
  }
  if (!merged.tasks.workspaceRoot) {
    warnings.push('tasks.workspaceRoot 未配置：任务将无法落到工作区目录')
  } else if (!isFullyQualifiedPath(merged.tasks.workspaceRoot)) {
    // workspaceRegistry.create 第一行就 realpath，并拒绝非完全限定路径：
    //   TypeError: Workspace path is not fully qualified: '...'
    // 这里前置拦下，免得用户只看到一条英文 TypeError。
    warnings.push(
      `tasks.workspaceRoot="${merged.tasks.workspaceRoot}" 不是完全限定路径 —— ` +
        'DSH 会拒绝（Workspace path is not fully qualified）。请填绝对路径，例如 D:\\qq-projects',
    )
  }

  // 前缀统一成字符串，避免配置里写了 null/number 之后在 startsWith 上炸
  merged.tasks.prefix = String(merged.tasks.prefix ?? '')
  merged.tasks.chatPrefix = String(merged.tasks.chatPrefix ?? '')

  // ── conversation：保证"配错不会静默退化" ────────────────────────────
  // 上面的 merge() 已经把传入值深合并进默认值；这里再兜一次非对象的情况
  // （配置里写成 conversation: null / "yes" 时 merge 会整体替换掉默认值）
  const conv = isPlainObject(merged.conversation)
    ? merged.conversation
    : { ...DEFAULT_CONFIG.conversation }
  merged.conversation = conv

  // ① 比例范围 + "必须低于压缩阈值"的警告。
  //    宿主 compaction 的默认 thresholdRatio 是 0.8；本 profile 实测没被覆盖，
  //    换算成 1M 窗口就是 800,000 token 才压缩（见 schema.js 的字段说明）。
  const COMPACTION_THRESHOLD_RATIO = 0.8
  const ratio = Number(conv.handoffAtRatio)
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    warnings.push(`conversation.handoffAtRatio="${conv.handoffAtRatio}" 非法，已回退为 ${DEFAULT_CONFIG.conversation.handoffAtRatio}`)
    conv.handoffAtRatio = DEFAULT_CONFIG.conversation.handoffAtRatio
  } else if (ratio >= COMPACTION_THRESHOLD_RATIO) {
    warnings.push(
      `conversation.handoffAtRatio=${ratio} 不低于宿主 compaction 的默认阈值 ${COMPACTION_THRESHOLD_RATIO} —— ` +
        '压缩会先把历史摘要掉再交班，交班拿到的历史是残缺的。建议 ≤ 0.6。',
    )
  }

  // ② 两个 Jaccard 阈值的大小关系
  const mergeJ = Number(conv.fragmentMergeJaccard)
  const askJ = Number(conv.fragmentAskJaccard)
  if (!Number.isFinite(mergeJ) || !Number.isFinite(askJ) || askJ >= mergeJ) {
    warnings.push(
      `conversation.fragmentAskJaccard 必须小于 fragmentMergeJaccard，已回退为 ` +
        `${DEFAULT_CONFIG.conversation.fragmentAskJaccard} / ${DEFAULT_CONFIG.conversation.fragmentMergeJaccard}`,
    )
    conv.fragmentAskJaccard = DEFAULT_CONFIG.conversation.fragmentAskJaccard
    conv.fragmentMergeJaccard = DEFAULT_CONFIG.conversation.fragmentMergeJaccard
  }

  // ④ 交班一次要涨够 token 才有意义；否则新会话刚建好就会被再次判定为超阈值
  const minGap = Number(conv.minTokensBetweenHandoffs)
  if (!Number.isFinite(minGap) || minGap < 0) {
    warnings.push(`conversation.minTokensBetweenHandoffs="${conv.minTokensBetweenHandoffs}" 非法，已回退为 20000`)
    conv.minTokensBetweenHandoffs = DEFAULT_CONFIG.conversation.minTokensBetweenHandoffs
  }
  const budget = Number(conv.memoryBudgetTokens)
  if (!Number.isFinite(budget) || budget < 0) {
    warnings.push(`conversation.memoryBudgetTokens="${conv.memoryBudgetTokens}" 非法，已回退为 2000`)
    conv.memoryBudgetTokens = DEFAULT_CONFIG.conversation.memoryBudgetTokens
  }

  for (const [key, min] of [['idleMinutes', 0], ['idleMinTurns', 1]]) {
    const n = Number(conv[key])
    if (!Number.isFinite(n) || n < min) {
      warnings.push(`conversation.${key}="${conv[key]}" 非法，已回退为 ${DEFAULT_CONFIG.conversation[key]}`)
      conv[key] = DEFAULT_CONFIG.conversation[key]
    }
  }

  // 扁平别名：让 pipeline / state / relay 不必关心 advanced 这一层
  merged.dedupeWindowMs = merged.advanced.dedupeWindowMs
  merged.dedupeMaxEntries = merged.advanced.dedupeMaxEntries
  merged.relayFlushMs = merged.advanced.relayFlushMs
  merged.stateDir = merged.advanced.stateDir

  return { ...merged, warnings }
}

/** 判断某个会话是否在允许范围内 */
/**
 * 这个聊天在不在接入范围内（用户已定：默认一个都不接）。
 *   - 白名单为空 = 一个都不接；写 '*' = 全部接；黑名单优先。
 *   - 私聊：配对过的主人总是放行（owner 是 lib/qq/owner.js 的 OwnerBinding，可以不传）。
 */
export function inScope(config, chatType, chatId, owner = null, groupSettings = null) {
  const s = config.scope
  const id = String(chatId)
  const listed = (list) => list.map(String).some((x) => x === '*' || x === id)
  if (chatType === 'group') {
    if (s.blockedGroups.map(String).includes(id)) return false
    return listed(s.groups) || groupSettings?.isAdmitted?.(id) === true
  }
  if (s.blockedFriends.map(String).includes(id)) return false
  if (owner?.isOwner?.(id)) return true
  return listed(s.friends)
}

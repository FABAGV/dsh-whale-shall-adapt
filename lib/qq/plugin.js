/**
 * QQ 通道（OneBot 11）与常驻对接会话。
 *
 * ## 路由：一个 QQ 会话 = 一台常驻对接会话
 *
 *   QQ 消息 → 群里先过决策引擎（lib/group）→ 该 QQ 会话的常驻对接会话（惰性创建），**聊天和干活都在它里面**。
 *             同一个人连发的话先合并；图片随消息交给模型；上下文到阈值 → 交班换一台新会话（记忆继续用）。
 *
 * 不为单条任务另起会话 —— 用户的原话是
 * 「每次发一个新的消息我就看见工作区看见一个新的会话在那边猜用户要干什么」。
 *
 * 回传侧的判据见 `lib/conversation/relay.js` 顶部：**据 turn 的来源**（插件发的 prompt 带
 * `requestId`），不是"用户在不在电脑前" —— GUI 里用户自己发起的回合一个字都不推 QQ。
 *
 * 设计依据：本仓库 README 和 docs/CONTRACTS.md
 *           （架构取舍与判据契约写在 README 里，代码注释只补实现细节）
 *
 * 反向 WS 的挂载方式有两种，默认 'own'：
 *   own — 插件自建 HTTP 服务端监听 reversePort（默认 6700），与 NapCat 现有配置对齐
 *   dsh — 挂在 DSH 的 webServer 上（此时 NapCat 需指向 DSH 的端口）
 */
import http from 'node:http'
import { createLogger, defaultLogFile } from '../core/log.js'
import { resolveConfig, inScope } from './config.js'
import { Pipeline, INTENT } from './pipeline.js'
import { OneBotReverseServer } from './onebot/server.js'
import { StateStore } from '../conversation/state.js'
import { DshBridge } from '../conversation/bridge.js'
import { ProgressRelay } from '../conversation/relay.js'
import { registerQqTools } from './tools.js'
import path from 'node:path'
import { ChatMemory } from '../conversation/chat-memory.js'
import { createMemory } from '../memory/index.js'
import { registerResidentMemory, ScopeResolver, CONTEXT_NAME, CONTEXT_ORDER } from '../conversation/context.js'
import { registerFrontDesk, FRONTDESK_SECTION, FRONTDESK_ORDER } from '../conversation/frontdesk.js'
import { LivenessMonitor, describeAliveReason } from './alive.js'
import { ConversationHandoff, DeliveryGate } from '../conversation/handoff.js'
import { IdleConsolidator } from '../conversation/idle.js'
import { Corpus } from './corpus.js'
import { expandForward, formatForward } from './onebot/forward.js'
import { plainText } from './onebot/normalize.js'
import { resolveQuote, formatQuote, withQuote, quotedMessageId } from './onebot/quote.js'
import { Config } from './schema.legacy.js'
import { minimalHealth } from '../ui/qq-health.js'
import { GroupEngine } from '../group/engine.js'
import { createJudge } from '../group/judge.js'
import { createCheapModel } from '../core/cheap-model.js'
import { createMemeGate } from '../meme/gate.js'
import { GroupMemoryJobs } from '../conversation/members.js'
import { SignalCollector } from '../conversation/signals.js'
import { createOutreach } from '../outreach/index.js'
import { assessSessionWork } from '../conversation/pending.js'
import { CorrectionLedger } from '../conversation/correction.js'
import { closingHint } from '../group/closure.js'
import { InboundMerger } from './merge.js'
import { parseReply } from '../conversation/reply-tags.js'
import { loadImages, imageSegments, imageNote } from './onebot/image.js'
import { mediaBlock, loadVoiceText } from './onebot/media.js'

export { Config }

export const name = 'dsh-whale-shall-adapt'

const PLUGIN_VERSION = '0.1.3'
/** OneBot 端口上唯一的 HTTP 路由：不带任何身份信息的健康检查。完整体检在控制台的 QQ 页。 */
const HEALTH_PATH = '/shall/qq/health'

export default {
  name,

  // 关键：cordis 的 loader 读的是 `runtime.Config`，而 runtime 就是**这个默认导出对象**
  // （见 cordis `this.runtime?.Config?.["simplify"]` 与 `resolveConfig(runtime, config)`）。
  // 只做命名导出 `export { Config }` 是不够的 —— 那样 loader 采集不到，
  // 设置页就不会按 Schema 生成（表现为 Config provider 里 status = "absent"）。
  Config,

  /**
   * @param {import('@deepseek-ai/cordis').Context} root
   * @param {object} rawConfig
   */
  // shared.memory：统一记忆层。交班、常驻记忆和 shall_qq_memory 经 ChatMemory 读写它；单独装时自建一份。
  apply(root, rawConfig = {}, shared = {}) {
    const config = resolveConfig(rawConfig)
    // 桌面端插件的 stdout 归 Electron 管，出问题时看不到 —— 所以日志同时镜像到文件
    const log = createLogger('shall:qq', config.logLevel, defaultLogFile())
    log.info(`──────── apply() 开始  pid=${process.pid}  node=${process.version} ────────`)

    for (const w of config.warnings) log.warn(w)
    log.info(
      `启动中：mount=${config.connection.mount} ` +
        `path=${config.connection.reversePath} groupMode=${config.group.defaultMode} ` +
        `workspaceRoot=${config.tasks.workspaceRoot || '(未配置)'}`,
    )

    // 群聊回复决策：档位、在场、等时机、预算、便宜模型判断（lib/group/）。判断模型的服务用到时才取
    const groupSettings = shared.groupSettings ?? null
    const botNameNow = () => config.participation.aliases.find((a) => a && !/^\d{1,12}[:：]/.test(a)) ?? 'bot'
    // 群聊判断、群成员记忆、群概况共用一个便宜模型（默认 deepseek-flash，不可用时退回宿主默认模型）
    const createCheap = (overrides = {}) =>
      createCheapModel({
        llm: () => (typeof root.get === 'function' ? root.get('llm') : undefined),
        root: () => root,
        config: () => config.group.judge,
        log,
        ...overrides,
      })
    const cheapModel = createCheap()
    const groupJudge = createJudge({ config: () => config.group.judge, model: cheapModel, log })
    // 梗百科的模型闸门：联网查词打开后，说不准是不是梗的短词先过一道（1.2 秒没回就放行）。
    // 闸门到点放弃是正常操作，所以它独占一个便宜模型实例：共用会把每次超时的「不可用」
    // 写进群判断共用的状态，控制台的「活跃档的判断模型」跟着误报 unavailable（2026-10-31 实测）。
    if (shared.meme) shared.meme.gate = createMemeGate({ model: createCheap({ log: null }) })
    const groupEngine = new GroupEngine({
      config: config.group,
      settings: groupSettings,
      judge: groupJudge,
      memory: shared.memory ?? null,
      signals: shared.signals ?? null,
      log,
      botName: botNameNow,
    })
    groupEngine.start()
    const pipeline = new Pipeline({ config, log, owner: shared.owner ?? null, group: groupEngine, groupSettings })
    /** 每个群里最近一次交给常驻会话的那条消息：回复时默认引用它（chatKey → { messageId, senderId }） */
    const anchors = new Map()

    /** @type {NodeJS.Timeout | null} */
    let pruneTimer = null

    // 语料库不依赖 DSH 服务：即使工作区/会话服务不可用，投喂也应当能沉淀
    const corpusStore = new Corpus({ config, log })

    // 保留期清理：启动时跑一次，之后每 6 小时一次
    try {
      corpusStore.prune()
      // 定时那次自己也要兜住：prune 里读配置/算日期都可能抛，抛出来就是未捕获异常
      pruneTimer = setInterval(() => {
        try {
          corpusStore.prune()
        } catch (err) {
          log.warn(`[corpus] 定时清理异常: ${err?.message ?? err}`)
        }
      }, 6 * 60 * 60 * 1000)
      if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
    } catch (err) {
      log.warn(`[corpus] 启动清理失败: ${err?.message ?? err}`)
    }

    /** access token 运行时持有者：先用配置兜底，随后由 credentials 刷新覆盖 */
    const auth = {
      token: config.connection.token ?? '',
      source: config.connection.token ? 'config' : 'none',
      /**
       * 鉴权信息是否已解析完成。凭据解析是异步的，在此之前一律拒绝连接
       * （fail-closed），否则凭据-only 部署的首个连接会被放行。
       * 若配置里已有 token，则视为立即就绪。
       */
      ready: Boolean(config.connection.token),
      /** @type {null | (() => Promise<void>)} 由凭证注入后就绪 */
      refresh: null,
    }

    /** @type {OneBotReverseServer | null} */
    let server = null
    /** @type {http.Server | null} */
    let ownServer = null
    /**
     * 存活观测器（v3.1）。
     *
     * 它只回答一个问题："**现在跟它说话有用吗**"。判据与"为什么不瞎报活着"
     * 见 lib/alive.js 顶部 —— 那里是这件事的单一真源，改判据改那边。
     * 这里只负责把三样活值喂给它：连接层是否就绪、当前连接、以及 tick 计时器。
     */
    const liveness = new LivenessMonitor({
      serverReady: () => server !== null,
      connections: () => (server ? [...server.connections] : []),
      log,
    })
    /** 暴露给状态端点与 `shall_qq_alive` 用：两边同一个判据 */
    const liveProbe = () => liveness.probeAll()
    /**
     * @type {{bridge: DshBridge, relay: ProgressRelay, state: StateStore,
     *         memory: MemoryStore | null, handoff: ConversationHandoff | null, gate: DeliveryGate,
     *         resolver: ScopeResolver}} | null}
     */
    let dsh = null
    /** @type {Array<() => void>} */
    const readyWaiters = []

    const disposers = []

    // 控制台要用的运行时对象：群决策引擎、群的运行时设置、判断模型状态、语料库
    if (shared.qqStatus?.provide) {
      disposers.push(shared.qqStatus.provide('group', { engine: groupEngine, settings: groupSettings, judge: groupJudge, corpus: corpusStore, qqConfig: config }))
    }

    /** 交班冻结闸门：`consume` 与 `bridge` 都会问它"这个会话现在能不能收"。 */
    const gate = new DeliveryGate({ log })

    /** @type {MemoryStore | null} */
    let memoryStore = null
    /** @type {ConversationHandoff | null} */
    let handoff = null
    /** @type {IdleConsolidator|null} */
    let idle = null
    /** @type {GroupMemoryJobs|null} */
    let groupJobs = null
    /** @type {SignalCollector|null} */
    let collector = null
    /** @type {CorrectionLedger|null} */
    let corrections = null
    /** @type {import('../outreach/index.js').Outreach|null} */
    let outreach = null
    /** @type {ScopeResolver | null} */
    let scopeResolver = null

    // ── 语料沉淀 ──────────────────────────────────────────────────────
    const archive = (message, extra = {}) => {
      corpusStore.append({
        chatType: message.chatType,
        chatId: message.chatId,
        chatName: extra.chatName,
        kind: extra.kind ?? 'message',
        ts: message.ts || Date.now(),
        payload: {
          messageId: message.messageId,
          senderId: message.senderId,
          senderName: message.senderName,
          text: extra.text ?? '',
          segments: message.segments.map((s) => s.kind),
          ...extra.payload,
        },
      })
    }

    /** 展开合并转发；失败不抛，返回 null */
    const expandSafely = async (message) => {
      const conn = server?.pick()
      if (!conn) {
        log.warn('[forward] 没有可用连接，无法展开合并转发')
        return null
      }
      const seg = message.segments.find((s) => s.kind === 'forward')
      if (!seg?.id) return null
      try {
        const rec = await expandForward(conn, seg.id)
        log.info(`[forward] 展开 ${seg.id}：${rec.nodes.length} 个节点`)
        return rec
      } catch (err) {
        log.warn(`[forward] 展开失败 ${seg.id}: ${err?.message ?? err}`)
        return null
      }
    }

    // ── 出站：把文本发到 QQ ────────────────────────────────────────────
    /**
     * @param {{ first?: boolean, replyTo?: string, at?: string[] }} [opts]
     *   群里：默认引用触发它的那条消息（只加在这一回合的第一条）；
     *   模型用 <quote/>、<at/> 指定的优先。**不自动 @**：要 @ 谁由模型自己写。
     */
    const send = async (chatType, chatId, text, opts = {}) => {
      const conn = server?.pick()
      if (!conn) throw new Error('当前没有可用的 OneBot 连接')
      const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg'
      const idKey = chatType === 'group' ? 'group_id' : 'user_id'
      const message = []
      if (chatType === 'group') {
        const key = `group:${chatId}`
        const anchor = anchors.get(key)
        const wantsQuote = groupEngine.settingsFor(chatId).reply.quote
        const replyId = opts.replyTo || (opts.first && wantsQuote && anchor?.messageId ? anchor.messageId : '')
        if (replyId) message.push({ type: 'reply', data: { id: String(replyId) } })
        // 不自动 @ 人：群里回复只靠引用/上下文让人看出在回谁；模型要点名时自己写 <at id>
        const mentions = [...(opts.at ?? [])]
        for (const qq of mentions) message.push({ type: 'at', data: { qq: String(qq) } }, { type: 'text', data: { text: ' ' } })
      }
      // 发图：一条消息只放这一张图，不带文字、不引用、不 @
      if (opts.image) message.length = 0
      if (opts.image) message.push({ type: 'image', data: { file: String(opts.image) } })
      else message.push({ type: 'text', data: { text } })
      const data = await conn.call(action, { [idKey]: Number(chatId), message })
      if (data?.message_id !== undefined) pipeline.noteOwnMessage(data.message_id)
      return data
    }

    /** 等待 DSH 侧服务就绪（用于极早期到达的消息） */
    const awaitDsh = (timeoutMs = 10000) =>
      new Promise((resolve) => {
        if (dsh) return resolve(dsh)
        const timer = setTimeout(() => resolve(null), timeoutMs)
        readyWaiters.push(() => {
          clearTimeout(timer)
          resolve(dsh)
        })
      })

    // ── 意图消费 ──────────────────────────────────────────────────────
    /**
     * 把一条消息整理成要投递的正文，并顺手沉淀语料。
     * 合并转发要展开成结构化节点当语境；展开失败时明确告知，而不是装作读到了。
     */
    const prepareText = async (decision, message, chatName, mediaInfo = {}) => {
      const quoteLine = formatQuote(decision.quote ?? null)
      if (quoteLine) decision = { ...decision, text: withQuote(decision.text, quoteLine) }
      if (decision.expandForward) {
        const rec = await expandSafely(message)
        if (rec && rec.nodes.length > 0) {
          archive(message, {
            chatName,
            kind: 'forward',
            payload: { forwardId: rec.id, nodes: rec.nodes.map((n) => ({ s: n.senderName, t: n.ts, x: n.text })) },
          })
          return `${formatForward(rec)}\n\n【我的问题】\n${decision.text}`
        }
        return (
          `${decision.text}\n\n` +
          '（注：你转发的那段聊天记录我打不开，如果问题依赖它的内容，请直接把关键几条贴给我）'
        )
      }
      // 语料里只留转写、不留下载地址：地址带签名参数，天天变，存下来没用还污染语料
      const archived = mediaInfo.transcript ? `${decision.text}\n[语音转写] ${mediaInfo.transcript}` : decision.text
      if (!decision.alreadyArchived) archive(message, { chatName, text: archived })
      return decision.text
    }

    /**
     * 「交班冻结期」收到的话：**按到达顺序排队**，交班一结束立刻按同一顺序补投。
     *
     * 为什么必须有这个队列：交班那几百毫秒到几秒里，常驻会话正在被归档、映射还没切
     * （见 handoff.js 的阶段 4→6）。这期间往旧会话投递 = 静默丢消息（DeliveryGate 拦下），
     * 往新会话投递 = 它还没建出来。
     *
 * ⚠️ 不能把消息兜底成“另起一台任务会话”：那等于绕开常驻对接会话、让工作区里冒出一台新会话去猜用户要干什么。
 *    代价是这几条消息要多等一个交班的时间 —— 但它们不会丢，也不会另起会话。
     * @type {Array<{chatType:'private'|'group', chatId:string, chatName?:string, text:string, senderName?:string}>}
     */
    const frozenQueue = []

    /**
     * 队列长度告警阈值。
     *
     * ⚠️ 只告警、**不丢消息**：丢用户消息比占一点内存严重得多。正常情况下队列最多
     *    攒一个人打字的速度那几条；到这个量级说明某个会话长期卡在交班态，
     *    那才是要查的东西（下面是阈值告警，状态端点的 handoff 段是现场）。
     */
    const FROZEN_QUEUE_WARN = 200

    /** 按顺序补投冻结期攒下的消息（交班解冻后调用；失败只记账，不丢队列里的其他条） */
    const drainFrozenQueue = () => {
      if (frozenQueue.length === 0 || !dsh) return
      const pending = frozenQueue.splice(0, frozenQueue.length)
      /** 交班还没结束的会话：退回队列，等它自己的解冻回调来取 */
      const requeue = []
      let sent = 0
      for (const input of pending) {
        // ⚠️ 解冻回调是按 scope 触发的，但队列是**全局**的：另一个会话可能还在交班。
        //    那种消息必须重新排队 —— 否则它会投进已被 retire 的旧会话，被
        //    DeliveryGate 拒掉，再走 bridge 的兜底（清绑定 + 另建一台常驻会话），
        //    于是这条用户消息落进一台孤儿会话：它被处理了，回复却永远回不到 QQ。
        if (dsh.handoff?.isFrozen?.(input.chatType, input.chatId)) {
          requeue.push(input)
          continue
        }
        sent += 1
        void dsh.bridge
          .deliverChat({ ...input, by: 'bridge:frozen-drain' })
          .catch((err) => log.error(`[chat] 冻结期补投失败: ${err?.stack ?? err}`))
      }
      if (requeue.length > 0) {
        frozenQueue.push(...requeue)
        log.info(`[chat] 有 ${requeue.length} 条属于仍在交班的会话，留在队列里等它解冻`)
      }
      log.info(`[chat] 交班已结束，补投冻结期攒下的 ${sent} 条消息`)
    }

    /**
     * 梗百科预查：这条消息里有像梗的词、本群黑话或词库里查得到，就把词条作为附加背景接在消息后面，
     * 不进记忆、不进系统提示。查不到、出错或超过 1.5 秒都原样投递，不拖慢回复。
     */
    const MEME_DEADLINE_MS = 1500
    const withMeme = async (text, message) => {
      if (!shared.meme) return text
      try {
        const chatKey = `chat:${message.chatType}:${message.chatId}`
        const pre = await Promise.race([
          shared.meme.prelookup(plainText(message), { chatKey }),
          new Promise((resolve) => setTimeout(() => resolve(null), MEME_DEADLINE_MS).unref?.()),
        ])
        if (!pre?.text) return text
        log.info(`[meme] 预查命中并附上：${pre.entry.title}${pre.entry.custom ? '（本群黑话）' : ''}`)
        return `${text}

[附：梗百科（插件自动查到的背景，不是用户说的话）]
${pre.text}`
      } catch (err) {
        log.warn(`[meme] 预查失败，原样投递：${err?.message ?? err}`)
        return text
      }
    }

    /**
     * 一条消息的媒体说明：图片/语音/视频的地址（OneBot 段里本来就有），语音顺带 QQ 自带的转写。
     * 什么都没有、或两项都关掉时返回空串，正文保持原样。
     */
    const describeMedia = async (message) => {
      const segments = message?.segments ?? []
      const hasMedia = segments.some((s) => s.kind === 'image' || s.kind === 'video' || s.kind === 'record')
      if (!hasMedia) return { block: '', transcript: '' }
      let transcript = ''
      if (segments.some((s) => s.kind === 'record') && config.participation.voiceText !== false) {
        transcript = await loadVoiceText(server?.pick() ?? null, message, { timeoutMs: 4000 })
        if (transcript) log.info(`[media] 语音转写 ${message.chatType}/${message.chatId}：${transcript.slice(0, 30)}`)
      }
      const block = mediaBlock(message, { urls: config.participation.mediaUrls !== false, transcript })
      return { block, transcript }
    }

    /**
     * 盯群档和“插件觉得你可以接话”是**先记文本、后整批取用**：文本在引擎的环里，
     * 原始的 media 段早就没了。所以入站时把媒体信息和转写 promise 按 messageId 存一份，
     * 等这批消息真交给会话时再拼回去。不存的话，群里那些图/语音到了会话里只剩 [图片]。
     */
    const MEDIA_CACHE_MAX = 500
    const MEDIA_CACHE_TTL_MS = 30 * 60 * 1000
    const mediaCache = new Map()
    const rememberMedia = (message) => {
      const segments = (message?.segments ?? []).filter(
        (s) => s.kind === 'image' || s.kind === 'video' || s.kind === 'record',
      )
      const messageId = String(message?.messageId ?? '')
      if (!messageId || segments.length === 0) return
      const urls = config.participation.mediaUrls !== false
      const voice =
        segments.some((s) => s.kind === 'record') && config.participation.voiceText !== false
          ? loadVoiceText(server?.pick() ?? null, message, { timeoutMs: 4000 })
          : Promise.resolve('')
      voice.catch(() => {})
      if (mediaCache.size >= MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value)
      mediaCache.set(messageId, { at: Date.now(), segments, urls, voice })
    }
    const mediaFor = async (messageId) => {
      const key = String(messageId ?? '')
      const rec = mediaCache.get(key)
      if (!rec) return ''
      if (Date.now() - rec.at > MEDIA_CACHE_TTL_MS) {
        mediaCache.delete(key)
        return ''
      }
      return mediaBlock({ segments: rec.segments }, { urls: rec.urls, transcript: await rec.voice })
    }

    const consume = async (input) => {
      let decision = input
      if (quotedMessageId(decision.message) && decision.intent !== INTENT.IGNORE && decision.intent !== INTENT.PAIR) {
        const quote = await resolveQuote(server?.pick() ?? null, decision.message, {
          isOwnMessage: (id) => pipeline.isOwnMessage(id),
        })
        const missedReply = decision.intent === INTENT.INGEST && quote?.fromSelf && decision.message.chatType === 'group'
        decision = missedReply ? pipeline.decide(decision.message, { replyToBot: true, quote }) : { ...decision, quote }
      }
      const { intent, message } = decision
      const chatName = message.chatType === 'group' ? undefined : message.senderName

      if (intent === INTENT.INGEST) {
        // 投喂：进语料库。合并转发额外展开成结构化节点
        const segs = message.segments.map((s) => s.kind).join('+')
        if (decision.expandForward) {
          const rec = await expandSafely(message)
          if (rec) {
            archive(message, {
              chatName,
              kind: 'forward',
              payload: { forwardId: rec.id, nodes: rec.nodes.map((n) => ({ s: n.senderName, t: n.ts, x: n.text })) },
            })
            log.info(`[ingest] forward-record ${message.chatType}/${message.chatId} → 已展开 ${rec.nodes.length} 节点入库`)
          } else {
            log.warn(`[ingest] forward-record ${message.chatType}/${message.chatId} → 展开失败，未入库`)
          }
          return
        }
        archive(message, { chatName, text: plainText(message) })
        log.info(`[ingest] ${decision.reason} ${message.chatType}/${message.chatId} segments=${segs}`)
        return
      }

      if (intent === INTENT.IGNORE) return

      if (intent === INTENT.PAIR) {
        // 配对成功才回话：没配上时不回，避免让陌生人试出 bot 在线
        if (decision.pairing?.ok) await send('private', message.chatId, '配对成功，以后你就是主人。').catch(() => {})
        log.info(`[owner] 私聊 ${message.chatId} 发了配对码：${decision.reason}`)
        return
      }

      const isChat = intent === INTENT.CHAT
      if (!isChat && intent !== INTENT.TASK) return

      // 主人在私聊里说话：既是“最近说过话”（主动联系要避开），也是对上一次主动联系的反馈
      if (message.chatType === 'private' && shared.owner?.isOwner?.(message.senderId)) outreach?.noteOwnerMessage(plainText(message))

      // 任务与闲聊都要先把这段话沉淀下来（用户问的就是它）；媒体地址/转写附在正文后面
      const mediaInfo = await describeMedia(message)
      let base = await prepareText(decision, message, chatName, mediaInfo)
      if (mediaInfo.block) base = `${base}\n\n${mediaInfo.block}`
      let text = await withMeme(base, message)
      if (message.chatType === 'group') {
        // 被叫到时带上群里刚才的几条作背景；对方像在收尾、连续几次没开口时，各加一句提示
        const chatKey = `group:${message.chatId}`
        const parts = [
          groupEngine.contextFor(chatKey, { excludeMessageId: message.messageId, excludeMessageIds: decision.mergedMessageIds ?? [] }),
          text,
          closingHint(decision.group?.closing),
          groupEngine.reminderFor(chatKey),
        ]
        text = parts.filter(Boolean).join('\n\n')
        anchors.set(chatKey, { messageId: message.messageId, senderId: message.senderId })
      }

      const ready = await awaitDsh()
      if (!ready) {
        log.warn(`[${isChat ? 'chat' : 'task'}] DSH 服务未就绪，丢弃 from ${message.chatType}/${message.chatId}`)
        await send(message.chatType, message.chatId, '⚠️ DSH 侧的服务还没就绪，请稍后再试').catch(() => {})
        return
      }

      // ── 规则 1：只投常驻对接会话，不为单条消息新建会话 ─────────
      //
      // 一个 QQ 会话恒定只有一台会话，聊天和干活都在它里面。
      //
      // 唯一的例外窗口是"交班冻结期"：那期间会话正在换代，投进去等于静默丢，
      // 所以排队等交班结束再按原顺序补投 —— 仍然不新建会话。
      const frozen = Boolean(dsh?.handoff && dsh.handoff.isFrozen(message.chatType, message.chatId))
      if (frozen) {
        frozenQueue.push({
          chatType: message.chatType,
          chatId: message.chatId,
          chatName,
          text,
          senderName: message.senderName,
          senderId: message.senderId,
          messageId: message.messageId,
        })
        log.info(`[chat] ${decision.reason} 落在交班冻结期 → 排队（第 ${frozenQueue.length} 条），交班结束后补投`)
        if (frozenQueue.length === FROZEN_QUEUE_WARN) {
          log.warn(
            `[chat] 冻结期队列已达 ${FROZEN_QUEUE_WARN} 条 —— 可能有会话长期卡在交班态，` +
              `请查状态端点的 handoff 段（frozenScopes）`,
          )
        }
        return
      }

      // ⚠️ 兜底补投：队列只在 `onUnfreeze` 回调里被抽干，而那个回调可能失败
      //    （`handoff.#unfreeze` 失败时只 warn 一句），失败之后队列就**没有人再来取**了 ——
      //    那批消息会一直躺到进程重启。所以每条「不在冻结期」的消息进来时顺手 drain 一次：
      //    只要还有流量，积压就一定投得出去；drain 排在本条投递之前，先来的仍然先处理。
      if (frozenQueue.length > 0) drainFrozenQueue()

      // 图片：由 NapCat 取回（本机，不出站），随消息一起交给模型；模型不支持看图时 bridge 退回纯文字
      const wantsImages = config.participation.images !== false && imageSegments(message).length > 0
      let images = []
      let skippedImages = 0
      let knownUnsupported = false
      if (wantsImages) {
        const sessionId = dsh?.state?.get?.(message.chatType, message.chatId)?.rootSessionId
        if (sessionId && ready.bridge.imagesUnsupported(sessionId)) {
          knownUnsupported = true
          skippedImages = imageSegments(message).length
        } else {
          const loaded = await loadImages(server?.pick() ?? null, message, {
            maxImages: config.participation.maxImages,
            maxBytes: config.participation.maxImageBytes,
          })
          images = loaded.images
          skippedImages = loaded.skipped
        }
      }
      const totalImages = imageSegments(message).length

      // ── 投进常驻对接会话（惰性创建）───────────────────────────────
      try {
        const result = await ready.bridge.chat({
          chatType: message.chatType,
          chatId: message.chatId,
          chatName,
          text,
          senderName: message.senderName,
          senderId: message.senderId,
          messageId: message.messageId,
          images,
          imageNote: wantsImages
            ? (withImages) => imageNote({
                attached: withImages ? images.length : 0,
                skipped: withImages ? skippedImages : totalImages,
                unsupported: knownUnsupported || (!withImages && images.length > 0),
              })
            : null,
        })
        log.info(
          `[chat] ${decision.reason}${decision.routedBy ? `(分诊→${decision.routedBy})` : ''} → ` +
            `session=${result.sessionId}${result.rebuilt ? '（重建了常驻会话）' : ''}`,
        )
      } catch (err) {
        log.error(`[chat] 投递失败: ${err?.stack ?? err}`)
        await send(message.chatType, message.chatId, describeFailure(err)).catch(() => {})
      }
    }

    const runConsume = (decision) => {
      void Promise.resolve(consume(decision)).catch((err) => {
        log.error(`[consume] 失败: ${err?.stack ?? err}`)
      })
    }

    /** 同一个人连发的话，安静一会儿再合成一条交给常驻会话（UX 第 26 条） */
    const merger = new InboundMerger({ windowMs: config.participation.mergeMs, onFlush: runConsume })
    disposers.push(() => merger.dispose())

    /**
     * 没人叫它、但决策引擎判断可以接话（在场档的追问、活跃档过了判断）：
     * 把那条消息和群里刚才的几条一起交给常驻会话，并明说“是插件觉得你可以接话”，不想说就 <refuse/>。
     */
    /**
     * 盯群档看一眼：把群里这段时间新说的几条整批交给常驻会话，由它自己决定接不接。
     * 不默认引用、不默认 @（批里没有"触发它的那条"）；要接哪条由模型用 <quote id/> 指明。
     */
    const deliverWatchLook = (d) => {
      void deliverWatchLookAsync(d).catch((err) => log.error(`[watch] 投递失败: ${err?.stack ?? err}`))
    }
    const deliverWatchLookAsync = async (d) => {
      const batch = Array.isArray(d.batch) ? d.batch : []
      if (batch.length === 0) return
      const chatId = d.chatKey.replace(/^group:/, '')
      const people = new Set(batch.map((e) => e.senderId)).size
      const lines = []
      for (const e of batch) {
        const media = await mediaFor(e.messageId)
        const head = `${e.senderName || e.senderId || '?'}（QQ ${e.senderId}，消息号 ${e.messageId}）${e.ignored ? '［他不想被你主动搭话］' : ''}: ${e.text}`
        lines.push(media ? `${head}\n${media}` : head)
      }
      const message = {
        platform: 'qq', selfId: '', chatType: 'group', chatId, messageId: '', senderId: '', senderName: `群里 ${people} 个人`,
        ts: batch.at(-1).at, segments: [{ kind: 'text', text: batch.map((e) => e.text).join('\n') }], atBot: false, raw: null,
      }
      const head =
        `（插件提示：你在盯这个群，下面是群里新说的 ${batch.length} 条${d.skipped ? `（更早的 ${d.skipped} 条没带上）` : ''}，没有人叫你。` +
        '有话想接就接一句，用 <quote id="消息号"/> 指明接的是哪条；没必要说就只回 <refuse/>，大多数时候都该不说。）'
      runConsume({
        intent: INTENT.CHAT,
        reason: 'group-watch',
        message,
        text: `${head}\n${lines.join('\n')}`,
        addressedBy: '',
        alreadyArchived: true,
        group: { mode: 'watch', reason: d.reason, wait: false, closing: null },
      })
    }

    const deliverGroupDecision = (d) => {
      void deliverGroupDecisionAsync(d).catch((err) => log.error(`[group] 投递失败: ${err?.stack ?? err}`))
    }
    const deliverGroupDecisionAsync = async (d) => {
      if (!d?.respond) return
      if (d.mode === 'watch') return deliverWatchLook(d)
      const entry = groupEngine.entryOf(d.chatKey, d.anchorMessageId)
      if (!entry) return
      const chatId = d.chatKey.replace(/^group:/, '')
      const media = await mediaFor(entry.messageId)
      const why = d.mode === 'present' ? '你刚回答过他，他接着说' : '插件觉得这个话题你可以接'
      const message = {
        platform: 'qq', selfId: '', chatType: 'group', chatId, messageId: entry.messageId, senderId: entry.senderId,
        senderName: entry.senderName, ts: entry.at, segments: [{ kind: 'text', text: entry.text }], atBot: false, raw: null,
      }
      runConsume({
        intent: INTENT.CHAT,
        reason: `group-${d.mode}`,
        message,
        text: `（插件提示：这条没有人叫你，${why}。有话想说就说；没必要插嘴就只回 <refuse/>。）\n${entry.text}${media ? `\n${media}` : ''}`,
        addressedBy: '',
        alreadyArchived: true,
        group: { mode: d.mode, reason: d.reason, wait: false, closing: null },
      })
    }
    disposers.push(groupEngine.onDecision(deliverGroupDecision))
    disposers.push(() => groupEngine.dispose())

    const onEvent = (payload, conn) => {
      let decision
      try {
        decision = pipeline.handle(payload, conn)
      } catch (err) {
        log.error(`[pipeline] 处理事件失败: ${err?.stack ?? err}`)
        return
      }
      if (!decision || decision.intent === INTENT.IGNORE) return
      if (decision.message?.chatType === 'group') rememberMedia(decision.message)
      if (decision.intent === INTENT.CHAT || decision.intent === INTENT.TASK) merger.push(decision)
      else runConsume(decision)
    }

    // ── 状态快照 ──────────────────────────────────────────────────────
    /** 一眼看懂的体检结论：出问题时不用逐字段推 */
    const computeHealth = () => {
      const issues = []
      const ok = []

      if (shared.memory?.readOnly) issues.push(`记忆库被另一个进程占着（pid ${shared.memory.lock?.holderPid ?? '?'}），这个进程只读：记忆的改动不会保存。关掉另一个 DSH 再重启本进程`)
      if (!server) issues.push('连接层未初始化（webServer 服务未就绪）')
      else if (!server.getToken()) issues.push('未配置 access token —— 任何进程都能连入，不建议')
      else ok.push(`access token 已配置（来源：${auth.source}）`)

      // ── 存活判定：先说清"它现在是不是还活着、凭什么叫它活着" ──────────
      //
      // 这条必须在最前面：一个已断开的插件，后面所有"任务在跑""交班正常"
      // 的数字都是**没有意义**的（它们描述的是过去）。
      const live = liveProbe()
      if (!live.alive) {
        issues.push(`插件当前**不活着**：${live.because.join('；')}`)
      } else {
        ok.push(`插件活着：${live.because.join('；')}`)
      }

      if (!server || server.connections.size === 0) issues.push('当前没有协议端连接（NapCat 未接入或已断开）')
      else ok.push(`协议端已接入（${[...server.connections].map((c) => c.selfId || '未知').join(',')}）`)

      if (!config.tasks.workspaceRoot) issues.push('tasks.workspaceRoot 未配置 —— 任务无法落盘')
      else ok.push('工作区父目录已配置')

      if (!dsh) issues.push('DSH 桥接未就绪（workspace/session 服务未注入）')
      else {
        ok.push('DSH 桥接就绪')
        if (dsh.bridge.stats.failed > 0) {
          issues.push(`有 ${dsh.bridge.stats.failed} 次派活失败，最近一次：${dsh.bridge.stats.lastError ?? '未知'}`)
        }
        const created = dsh.bridge.stats.sessionsCreated
        if (created === 0 && dsh.bridge.stats.workspacesCreated > 0) {
          issues.push('建过工作区但从未建成会话 —— 派活链路可能有问题')
        }
        // ── 回传链路的"整轮静默"签名 ──────────────────────────────────
        //
        // 0.1.3 的线上故障：入站、agent 回复、turn/end 都正常，但
        // `relayed === 0` 且 `provenanceUnknown` 一直涨 —— 因为 `user/message`
        // 的形状读错，来源永远定型不了，每个回合都被当 GUI 回合丢掉。
        // 单看 skippedForeign 是看不出来的，必须把这两项合起来判。
        const relayStats = dsh.relay?.snapshot?.() ?? null
        if (relayStats && relayStats.relayed === 0 && relayStats.provenanceUnknown > 0) {
          issues.push(
            `QQ 回传一条都没发出去，却有 ${relayStats.provenanceUnknown} 个事件因回合来源未定型被跳过 —— ` +
              `几乎可以确定 user/message 没被判出来（检查宿主版本/事件形状，见日志里的 [relay] 告警）`,
          )
        }
      }

      if (corpusStore.disabled) issues.push('语料库不可用（目录不可写或已关闭采集）')
      else ok.push('语料库可用')

      // v3：交班与记忆的体检
      if (dsh) {
        const h = dsh.handoff?.snapshot()
        if (!h) {
          issues.push('常驻对话会话已开启，但交班监视器未就绪')
        } else {
          if (h.contextWindow > 0) {
            ok.push(
              `交班阈值 ${h.handoffAtRatio} × ${h.contextWindow} = ${Math.floor(h.contextWindow * h.handoffAtRatio)} token` +
                `（宿主压缩要到 ${h.compactionThresholdTokens} token 才动手，交班在先手）`,
            )
          } else {
            issues.push('还没有测量到 contextWindow —— 交班阈值算不出来，功能不会触发（等到第一个回合结束就会测）')
          }
          if (h.handoffAtRatio >= h.compactionThresholdRatio) {
            issues.push(
              `conversation.handoffAtRatio=${h.handoffAtRatio} 不低于宿主压缩阈值 ${h.compactionThresholdRatio}` +
                ' —— 压缩会先手把历史摘要掉',
            )
          }
          if (h.stats.failed > 0) issues.push(`有 ${h.stats.failed} 次交班流程异常，最近一次：${h.stats.lastError ?? '未知'}`)
          if (h.stats.archiveFailed > 0) {
            issues.push(`有 ${h.stats.archiveFailed} 次旧会话归档失败（交班仍完成，但旧会话会留在侧边栏）`)
          }
          if (h.stats.degraded > 0) {
            ok.push(`有 ${h.stats.degraded} 次交班走了降级路径（交接内容不完整，但记忆本身没丢）`)
          }
          if (h.stats.completed > 0) ok.push(`已完成 ${h.stats.completed} 次交班`)
          const frozen = h.frozenScopes ?? []
          if (frozen.length > 0) ok.push(`正在交班中：${frozen.join('、')}（这期间该会话的消息先排队，交班结束后按顺序补投）`)
        }
        const mem = dsh.memory?.snapshot()
        if (mem) {
          ok.push(`常驻记忆 ${mem.count} 条碎片（文件 ${mem.file}，可查可删：shall_qq_memory 工具）`)
          if (mem.stats.failures > 0) issues.push(`记忆落盘失败 ${mem.stats.failures} 次 —— 碎片可能没存住`)
        }
        const refused = dsh.gate?.snapshot?.().refused ?? 0
        if (refused > 0) {
          // 这是**好事**：说明守卫拦住了本该静默丢消息的投递
          ok.push(`投递守卫拦下 ${refused} 次"向已退役会话投递"（否则会静默丢消息）`)
        }
      }

      return { verdict: issues.length === 0 ? 'ok' : 'attention', issues, ok }
    }

    const statusSnapshot = () =>
      ({
          plugin: 'dsh-whale-shall-adapt',
          version: PLUGIN_VERSION,
          /**
           * 存活判定（v3.1）。
           *
           * 形状：`{alive, because[], reasons[], evidence{}, tasks{}}`
           *   - `alive`：必需判据**全过**才 true；任一条缺失即 false（绝不瞎报活着）
           *   - `because`：**凭什么**这么判 —— 活着时列出通过的判据与具体数值，
           *     不活着时逐条说明缺的是哪一条。一眼可核对，不用逐字段推
           *   - `evidence`：裸数值（静默多少毫秒、tick 多久前跑过、阈值是多少）
           *   - `tasks`：任务侧的独立结论；它**不参与** `alive`（理由见 lib/alive.js）
           */
          alive: liveProbe(),
          config: {
            mount: config.connection.mount,
            path: config.connection.reversePath,
            port: config.connection.mount === 'own' ? config.connection.reversePort : null,
            authRequired: Boolean(auth.token),
            groupMode: config.group.defaultMode,
            workspaceRoot: config.tasks.workspaceRoot,
            taskPrefix: config.tasks.prefix,
            chatPrefix: config.tasks.chatPrefix,
            /**
             * v3.1：**取消不再由关键词驱动**，所以这里没有 cancelPrefix。
             * 控制意图由常驻会话自己理解（它就在干那件事，说停就停下）；
             * "把这个任务停一下看看日志"不会被吃成停止命令。
             */
            handoffAtRatio: config.conversation.handoffAtRatio,
            memoryBudgetTokens: config.conversation.memoryBudgetTokens,
          },
          warnings: config.warnings,
          connection: server?.snapshot() ?? null,
          pipeline: pipeline.snapshot(),
          bridge: dsh?.bridge.snapshot() ?? null,
          relay: dsh?.relay.snapshot() ?? null,
          state: dsh?.state.snapshot() ?? null,
          corpus: corpusStore.snapshot(),
          /**
           * v3：**离交班还差多少**。
           *
           * 这是硬要求：没有它，用户永远不知道这个功能在工作 ——
           * 而 0.25 的阈值在 1M 窗口下也要 25 万 token 才触发。
           * 每个会话给出 `totalTokens / handoffThresholdTokens / ratio /
           * tokensToHandoff / progressPercent`，一眼可答"为什么还没触发"。
           */
          group: {
            mode: config.group.defaultMode,
            judge: groupJudge.status(),
            memberJobs: groupJobs?.snapshot() ?? null,
            outreach: outreach?.snapshot() ?? null,
            signals: { collector: collector?.snapshot() ?? null, corrections: corrections?.snapshot() ?? null },
            chats: groupEngine.snapshot(),
            merger: merger.snapshot(),
          },
          conversation: {
            ...(dsh?.handoff?.snapshot() ?? { enabled: true, note: 'handoff-not-ready' }),
            memory: memoryStore?.snapshot() ?? null,
            idle: idle?.snapshot() ?? null,
            gate: gate.snapshot(),
            context: { name: CONTEXT_NAME, order: CONTEXT_ORDER, injectMode: config.conversation.injectMode },
          },
          health: computeHealth(),
          /** 排障入口：桌面端 stdout 归 Electron 管，这份文件是唯一能看到内部日志的地方 */
          logFile: defaultLogFile(),
          now: Date.now(),
        })

    const statusBody = () => JSON.stringify(minimalHealth(statusSnapshot()), null, 2)
    if (shared.qqStatus) disposers.push(shared.qqStatus.register(statusSnapshot))

    /**
     * 健康检查：OneBot 端口不用登录，谁都能访问，所以只回答“在不在、通不通”，
     * 不带 chatId、群名、bot 账号、路径和配置（见 lib/ui/qq-health.js 的 minimalHealth）。
     */
    const writeStatus = (res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(statusBody())
    }

    const buildServer = () => {
      server = new OneBotReverseServer({
        path: config.connection.reversePath,
        getToken: () => auth.token,
        isAuthReady: () => auth.ready,
        // 此前没传，于是 connection.callTimeoutMs 是个空转的设置项（连接层恒 15000）
        callTimeoutMs: config.connection.callTimeoutMs,
        log,
        onEvent,
      })
      return server
    }

    // ── 连接层：自建服务端（默认）─────────────────────────────────────
    const startOwnServer = () => {
      buildServer()
      ownServer = http.createServer((req, res) => {
        // 只比 pathname：`?format=html|json` 是状态页自己的查询参数，
        // 直接拿 req.url 全串比较会让带 query 的链接 404。
        let requestPath = req.url ?? '/'
        try {
          requestPath = new URL(requestPath, 'http://localhost').pathname
        } catch {
          /* 畸形 URL 就按原串比较，交给下面的 404 */
        }
        if (requestPath === HEALTH_PATH) {
          writeStatus(res)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('shall: not found')
      })
      ownServer.on('upgrade', (req, socket, head) => {
        // 每次接入都顺手刷新一次凭据：让设置里改过的 token 尽快生效（不影响本次校验）
        if (auth.refresh) void auth.refresh()
        if (server.matches(req)) {
          server.handleUpgrade(req, socket, head)
          return
        }
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
      })

      // 端口被占用（常见于残留进程）时自动重试，而不是永久失败。
      // 注意：error 监听器只挂一次 —— 每次重试都加一个会导致监听器泄漏。
      let attempt = 0
      let retryTimer = null
      const maxAttempts = 20
      const retryDelayMs = 2000

      const bind = () => {
        ownServer.listen(config.connection.reversePort, config.connection.host, () => {
          log.info(
            `[server] 反向 WS 就绪：ws://${config.connection.host}:${config.connection.reversePort}${config.connection.reversePath}`,
          )
          log.info(
            `[server] 健康检查：http://${config.connection.host}:${config.connection.reversePort}${HEALTH_PATH}（完整体检在控制台的 QQ 页）`,
          )
        })
      }

      ownServer.on('error', (err) => {
        if (err?.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1
          log.warn(
            `[server] 端口 ${config.connection.reversePort} 被占用（第 ${attempt}/${maxAttempts} 次），` +
              `${retryDelayMs / 1000} 秒后重试…`,
          )
          retryTimer = setTimeout(bind, retryDelayMs)
          if (typeof retryTimer.unref === 'function') retryTimer.unref()
          return
        }
        if (err?.code === 'EADDRINUSE') {
          log.error(
            `[server] 端口 ${config.connection.reversePort} 持续被占用，已放弃（尝试 ${attempt} 次）。` +
              `NapCat 将连不上 —— 请释放该端口或改 connection.reversePort。`,
          )
          return
        }
        log.error(`[server] HTTP 服务端错误: ${err?.code ?? ''} ${err?.message ?? err}`)
      })

      bind()

      disposers.push(() => {
        if (retryTimer) clearTimeout(retryTimer)
        try {
          ownServer?.close()
        } catch {
          /* 已关闭 */
        }
      })
    }

    // ── 连接层：挂在 DSH webServer 上 ─────────────────────────────────
    const startOnDshWebServer = (ctx) => {
      buildServer()
      disposers.push(
        ctx.webServer.registerUpgrade({
          path: config.connection.reversePath,
          handler: (req, socket, head) => {
            if (server && server.matches(req)) server.handleUpgrade(req, socket, head)
            else socket.destroy()
          },
        }),
      )
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: HEALTH_PATH,
          handler: (req, res) => writeStatus(res),
        }),
      )
      log.info(`[server] 已挂在 DSH webServer 的 ${config.connection.reversePath} 上`)
      log.info(`[server] 注意：NapCat 需指向 DSH 的端口，而不是 ${config.connection.reversePort}`)
    }

    // ① 连接层：只需要 webServer（用来挂状态路由 / dsh 模式）
    root.inject(['webServer'], (ctx) => {
      if (config.connection.mount === 'own') {
        startOwnServer()
      } else {
        startOnDshWebServer(ctx)
      }

      // access token 的解析。
      //
      // 两个必须遵守的点（来自 credentials 服务契约）：
      //  1. resolve() 返回的是 `{ value, source }` **对象**，不是字符串 ——
      //     早期版本写成 String(resolve(...))，会把 token 变成 "[object Object]"，
      //     导致 NapCat 鉴权 401（真机上因为走的是 config 兜底才没暴露）。
      //  2. 契约明确要求「每次操作重新解析，不要跨操作缓存」，
      //     否则用户在设置里改了 token 必须重启才生效。
      //     upgrade 回调是同步的，所以这里用「每次接入时刷新 + 定时刷新」来逼近该语义。
      const refreshToken = async () => {
        try {
          const creds = typeof ctx.get === 'function' ? ctx.get('credentials') : null
          if (!creds || typeof creds.resolve !== 'function') {
            if (!auth.token) log.warn('[auth] credentials 不可用且未配置 token —— 将不校验来源')
            return
          }
          const resolved = await creds.resolve(config.connection.tokenRef)
          const value = resolved?.value
          if (value) {
            const changed = auth.token !== String(value)
            auth.token = String(value)
            auth.source = resolved.source ?? 'credentials'
            if (changed) {
              log.info(
                `[auth] access token 已更新（来源 ${auth.source}，凭据键 ${config.connection.tokenRef}）`,
              )
            }
          } else if (!config.connection.token) {
            if (auth.token) log.warn('[auth] 凭据已清空，且未配置兜底 token —— 改为不校验来源')
            auth.token = ''
            auth.source = 'none'
          }
        } catch (err) {
          log.warn(`[auth] 读取凭据失败，沿用现有值: ${err?.message ?? err}`)
        } finally {
          // 无论成功失败都标记就绪：失败时沿用配置值（可能为空=不校验），
          // 但不能让连接永久被 503 挡住。
          auth.ready = true
        }
      }

      auth.refresh = refreshToken
      void refreshToken()
      // 定时刷新：让用户在设置里改 token 后无需重启
      const tokenTimer = setInterval(() => void refreshToken(), 60_000)
      if (typeof tokenTimer.unref === 'function') tokenTimer.unref()
      disposers.push(() => clearInterval(tokenTimer))
    })

    // ② DSH 桥接：需要 workspace + session 服务
    root.inject(['workspaceRegistry', 'sessionController'], (ctx) => {
      const state = new StateStore({ log, dir: config.stateDir || undefined, bindings: shared.bindings ?? null })
      if (shared.bindings) {
        const seeded = shared.bindings.seed(state.entries().map(([key, chat]) => ({ ...chat, chatType: chat.chatType ?? key.split(':')[0], chatId: chat.chatId ?? key.split(':').slice(1).join(':') })))
        if (seeded > 0) log.info(`[bindings] 从旧状态补登记 ${seeded} 个会话`)
      }

      // ── 碎片记忆 + 交班 + 单点投递守卫 ──────────────────────────────
      // 单独装 QQ 侧（没有共享记忆层）时，在状态目录下自建一份
      const store = shared.memory ?? createMemory({
        log,
        dir: path.join(state.dir, 'memory'),
        config: { similarity: { merge: config.conversation.fragmentMergeJaccard, ask: config.conversation.fragmentAskJaccard } },
      })
      if (!shared.memory) disposers.push(() => store.dispose())
      memoryStore = new ChatMemory({
        store,
        owner: shared.owner ?? null,
        log,
        membersEnabled: (groupId) => groupEngine.settingsFor(groupId).members.enabled,
      })

      // 主动私聊主人（默认关，控制台里打开）：只跟进记忆里"上次没说完的事"，有一整套闸门防刷屏
      if (shared.owner) {
        outreach = createOutreach({
          dir: shared.home ?? path.dirname(state.dir),
          config: config.outreach ?? {},
          memory: store,
          owner: shared.owner,
          log,
          isConnected: () => Boolean(server?.pick()),
          isBusy: async (ownerQq) => {
            if (dsh?.handoff?.isFrozen?.('private', ownerQq)) return { busy: true, reason: '正在交班' }
            const sessionId = state.get('private', ownerQq)?.rootSessionId
            if (!sessionId) return { busy: false }
            const view = await assessSessionWork({ ctx, log }, sessionId, { approvals: dsh?.relay?.approvalsFor?.(sessionId) })
            return { busy: Boolean(view.busy), reason: view.reason }
          },
          deliver: ({ ownerQq, text }) => dsh.bridge.deliverChat({ chatType: 'private', chatId: ownerQq, chatName: ownerQq, text, senderName: '插件', by: 'outreach' }),
        })
        if (shared.qqStatus?.provide) disposers.push(shared.qqStatus.provide('outreach', outreach))
        const outreachTimer = setInterval(() => {
          void outreach?.tick().catch((err) => log.warn(`[outreach] 定时检查失败: ${err?.message ?? err}`))
        }, 60 * 1000)
        if (typeof outreachTimer.unref === 'function') outreachTimer.unref()
        disposers.push(() => clearInterval(outreachTimer))
        disposers.push(() => outreach?.dispose())
      }

      // 群成员记忆与群概况冷启动：从语料库里提取，每个群隔几小时最多一次，一次只做一件事
      if (groupSettings) {
        groupJobs = new GroupMemoryJobs({
          corpus: corpusStore,
          memory: store,
          groupSettings,
          model: cheapModel,
          qqConfig: () => config,
          settingsFor: (groupId) => groupEngine.settingsFor(groupId),
          owner: shared.owner ?? null,
          log,
        })
        if (shared.qqStatus?.provide) disposers.push(shared.qqStatus.provide('memberJobs', groupJobs))
        const jobsTimer = setInterval(() => {
          try {
            void groupJobs?.tick()
          } catch (err) {
            log.warn(`[members] 定时检查失败: ${err?.message ?? err}`)
          }
        }, 5 * 60 * 1000)
        if (typeof jobsTimer.unref === 'function') jobsTimer.unref()
        disposers.push(() => clearInterval(jobsTimer))
      }
      scopeResolver = new ScopeResolver({ state })

      const bridge = new DshBridge({
        ctx,
        config,
        log,
        state,
        gate,
        // 用户消息投递成功 → 告诉交班"交接文本已经和这句话同批交付了"（见 handoff.js）。
        // 用闭包读 `handoff`：它在本函数稍后才被构造。
        onUserPrompt: (sessionId) => {
          handoff?.noteUserDelivery(sessionId)
          idle?.noteUserPrompt(sessionId)
        },
      })
      const relay = new ProgressRelay({
        bridge,
        log,
        send,
        flushIntervalMs: config.relayFlushMs,
        // 模型的回复先过一遍：剥掉内部备忘（待续存进记忆）、转换 <refuse/> <at/> <quote/>
        outputFilter: ({ chat, sessionId, text }) => {
          const key = `${chat.chatType}:${chat.chatId}`
          const inGroup = chat.chatType === 'group'
          const parsed = parseReply(text, {
            validQq: (qq) => inGroup && groupEngine.hasRecentSender(key, qq),
            validMessage: (id) => inGroup && groupEngine.hasMessage(key, id),
          })
          if (parsed.memo) {
            try {
              memoryStore.noteMemo({ scope: key, memo: parsed.memo, sessionId })
            } catch (err) {
              log.warn(`[memo] 备忘写入记忆失败: ${err?.message ?? err}`)
            }
          }
          if (inGroup) for (const qq of parsed.ignore) groupEngine.ignoreSender(chat.chatId, qq, '模型选择不理他')
          return parsed
        },
        onSent: (chat, text, data) => {
          if (chat.chatType !== 'group') return
          groupEngine.noteBotReply({ chatKey: `group:${chat.chatId}`, chars: text.length, text, at: Date.now(), messageId: data?.message_id })
        },
        onTurnOutcome: ({ chat, spoke }) => {
          if (chat.chatType === 'group') groupEngine.noteTurnOutcome(`group:${chat.chatId}`, { spoke })
        },
        // 群里一条消息有字数上限，超长的分几条发，条与条之间按打字速度留间隔
        chunkPlan: (chat) => {
          if (chat.chatType !== 'group') return null
          const reply = groupEngine.settingsFor(chat.chatId).reply
          return { maxChars: reply.maxChars, delayFor: (text) => Math.min(reply.typingMaxMs, text.length * reply.typingMsPerChar) }
        },
      })
      // ── 交班监视器（挂在 relay 已经在订阅的同一个事件流上）──────────
      {
        handoff = new ConversationHandoff({
          ctx,
          config,
          log,
          bridge,
          state,
          memory: memoryStore,
          relay,
          gate,
          resolver: scopeResolver,
          // 交班走完（解冻）后，把冻结期攒下的消息按原顺序补投进新会话
          onUnfreeze: () => {
            try {
              drainFrozenQueue()
            } catch (err) {
              log.error(`[chat] 冻结期队列补投失败: ${err?.stack ?? err}`)
            }
          },
          notify: (chatType, chatId, text) => relay.notify(chatType, chatId, text),
        })
        // 只关心常驻会话的 turn/end
        disposers.push(
          ctx.on('session/event', (session, event) => {
            if (event?.type !== 'turn/end') return
            try {
              handoff.onTurnEnd(String(session?.id ?? ''), event?.data?.reason)
              idle?.noteTurnEnd(String(session?.id ?? ''))
            } catch (err) {
              log.error(`[handoff] onTurnEnd 失败: ${err?.stack ?? err}`)
            }
          }),
        )
        log.info('[handoff] 已订阅 session/event（只处理常驻会话的 turn/end）')

        // 负反馈信号：被 GUI 接手、工具连续失败、用户明确纠正/追问。只采集，判定和落账见 correction.js
        if (shared.signals) {
          collector = new SignalCollector({ signals: shared.signals, bridge, memory: memoryStore, log })
          disposers.push(
            ctx.on('session/event', (session, event) => {
              try {
                collector.onEvent(session, event)
              } catch (err) {
                log.warn(`[signals] 采集失败: ${err?.message ?? err}`)
              }
            }),
          )
          corrections = new CorrectionLedger({ signals: shared.signals, store, log }).start()
          if (shared.qqStatus?.provide) disposers.push(shared.qqStatus.provide('corrections', corrections))
          disposers.push(() => corrections?.stop())
        }

        // 启动时清一次过期交接束（之后每 6 小时一次）
        try {
          handoff.pruneLedgers()
        } catch (err) {
          log.warn(`[handoff] 启动清理交接束失败: ${err?.message ?? err}`)
        }
        const ledgerTimer = setInterval(() => {
          try {
            handoff?.pruneLedgers()
          } catch {
            /* 忽略 */
          }
        }, 6 * 60 * 60 * 1000)
        if (typeof ledgerTimer.unref === 'function') ledgerTimer.unref()
        disposers.push(() => clearInterval(ledgerTimer))

        // 空闲整理：每分钟看一次有没有停下来够久、又攒了几轮新发言的会话（一次只整理一个）
        idle = new IdleConsolidator({ ctx, config, log, state, handoff, memory: memoryStore, relay, signals: shared.signals ?? null })
        if (idle.enabled) {
          const idleTimer = setInterval(() => {
            try {
              void idle?.tick()
            } catch (err) {
              log.warn(`[idle] 定时检查失败: ${err?.message ?? err}`)
            }
          }, 60 * 1000)
          if (typeof idleTimer.unref === 'function') idleTimer.unref()
          disposers.push(() => clearInterval(idleTimer))
          log.info(`[idle] 空闲整理已开启：停下来 ${config.conversation.idleMinutes} 分钟且新增 ≥ ${config.conversation.idleMinTurns} 条发言时提取一次`)
        }

        // 崩溃恢复：上次交班"切换了映射但归档失败"的旧会话，补一次（幂等）
        for (const repair of state.pendingArchiveRepairs()) {
          void bridge
            .archiveSession(repair.sessionId)
            .then(() => {
              gate.retire(repair.sessionId, { why: 'handoff-repair', by: 'startup' })
              log.info(`[handoff] 已补归档上次未归档的旧会话 ${repair.sessionId}（${repair.key}）`)
            })
            .catch((err) => log.warn(`[handoff] 补归档 ${repair.sessionId} 失败: ${err?.message ?? err}`))
        }

        // 崩溃恢复：上次交班卡在"旧会话已归档、映射还没切"这一小段窗口里。
        //
        // 这是交班唯一会造成**静默丢消息**的残留：映射还指着已经归档的会话，
        // 而归档不报错、不通知（宿主在 pre-step 静默 reject）。所以这里必须
        // 主动把它判成"坏了"：退役那台会话 + 清掉绑定，让下一条消息惰性重建。
        for (const stale of state.pendingHandoffRecoveries()) {
          gate.retire(stale.sessionId, { why: 'handoff-interrupted', by: 'startup' })
          state.setRootSession(stale.chatType, stale.chatId, '')
          state.clearHandoffPending(stale.chatType, stale.chatId)
          log.warn(
            `[handoff] 上次交班没走完（${stale.key}：第 ${stale.gen} 代，旧会话 ${stale.sessionId} 已归档但映射没切）` +
              '—— 已清掉绑定，下一条消息会重建常驻会话',
          )
        }
      }

      // 让 DSH 的设置页按 Config Schema 自动生成本插件的表单
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : null
      if (settings && typeof settings.configure === 'function') {
        try {
          disposers.push(settings.configure({ auto: true }))
          log.info('[settings] 已注册自动设置页（依据 Config Schema 生成）')
        } catch (err) {
          log.warn(`[settings] 注册自动设置页失败: ${err?.message ?? err}`)
        }
      } else {
        log.info('[settings] settings 服务不可用，跳过自动设置页')
      }

      dsh = { bridge, relay, state, memory: memoryStore, handoff, idle, gate, resolver: scopeResolver }

      // 测试钩子：把投递守卫暴露给集成测试。
      //
      // 为什么必须这么做：真实语义下"往已退役会话投递**被拒绝**"与"**被静默吞掉**"
      // 在外部观察者看来完全一样（都不抛错、都没有返回值）—— 只靠端到端断言
      // 根本区分不出守卫到底有没有生效。所以测试必须能直接调它。
      // 只在有全局钩子时挂（测试进程），生产环境里 `globalThis.__dshqq_onGate` 不存在。
      if (typeof globalThis.__dshqq_onGate === 'function') {
        try {
          globalThis.__dshqq_onGate(gate)
        } catch {
          /* 钩子失败不影响插件 */
        }
      }

      // 测试钩子：把"投一条用户消息到常驻会话"的**真实入口**暴露出去。
      //
      // 为什么需要：受控假宿主会对同一发送者限频（retcode 1200），
      // 而交班断言需要在很短的墙钟时间里对同一个 QQ 号连发多条。
      // 直接调这条入口既能走完整真实代码路径（含 DeliveryGate），又不吃限流。
      if (typeof globalThis.__dshqq_onChat === 'function') {
        try {
          globalThis.__dshqq_onChat((input) => bridge.deliverChat({ ...input, by: 'test:direct-chat' }))
        } catch {
          /* 钩子失败不影响插件 */
        }
      }

      disposers.push(relay.attach(ctx))
      disposers.push(() => relay.dispose())

      // 给 agent 的 QQ 工具（tools 是可选服务：没有也不影响派活与回传）
      try {
        disposers.push(
          ...registerQqTools({
            ctx,
            config,
            log,
            send,
            corpus: corpusStore,
            meme: shared.meme ?? null,
            owner: shared.owner ?? null,
            groupSettings,
            // 工具里认调用方是哪个 QQ 聊天（梗百科的群黑话只查自己所在的群）
            chatOfCaller: (header) => {
              if (!header) return null
              const bound = shared.bindings?.resolve(header)
              if (bound) return bound
              const hit = header.id ? state.findBySession(header.id) : null
              return hit ? { chatType: hit.chatType, chatId: hit.chatId } : null
            },
            /**
             * 只列出 scope 允许的会话。
             *
             * ⚠️ 早先这里返回**全部**已接入会话（含工作区路径），而 agent 是被不可信
             *    QQ 文本驱动的 —— 它只要问一句就能枚举出别人所有会话的 chatId，
             *    再用那些 chatId 去调 shall_qq_history / shall_qq_memory。scope 配置了却挡不住
             *    枚举，等于没配。`scope.groups/friends` 为空数组（默认）时
             *    `inScope` 恒真 = 行为与从前完全一致。
             */
            listChats: () =>
              state
                .entries()
                .map(([key, v]) => ({
                  chatType: v.chatType ?? key.split(':')[0],
                  chatId: v.chatId ?? key.split(':').slice(1).join(':'),
                  chatName: v.chatName ?? '',
                  workspacePath: v.workspacePath ?? '',
                }))
                .filter((c) => inScope(config, c.chatType, c.chatId, shared.owner ?? null, groupSettings)),
            memory: memoryStore,
            // ── v3.1：存活检测与真实状态 ────────────────────────────────
            //
            // 为什么把 `liveProbe` 交给工具而不是让工具自己去取服务：
            // 它要综合**连接层 + 事件循环 + 任务侧**三样东西，而这三样分别属于
            // 本函数的闭包与 DSH 服务。收在一处（lib/alive.js 的判据）才能保证
            // 状态端点与工具说的是同一句话 —— 两边口径不一致比不报更糟。
            liveProbe,
            // 写碎片时要知道"现在是第几代"（老化判据用 lastSeenGen）。
            // 拿不到就给 0 = 享受最大宽限期，绝不误伤用户手动记住的东西。
            memoryGeneration: ({ chatType, chatId } = {}) => ({
              value: Number(state.get(chatType, chatId)?.rootGeneration ?? 0) || 0,
            }),
          }),
        )
      } catch (err) {
        log.warn(`[tools] 注册失败（不影响派活）: ${err?.message ?? err}`)
      }

      for (const w of readyWaiters.splice(0)) {
        try {
          w()
        } catch {
          /* 忽略 */
        }
      }
      log.info('[bridge] DSH 桥接就绪（workspace + 常驻对接会话）')
    })

    // ③ 常驻记忆注入（全局注册 + 按 ctx.agent.id 分流）
    //
    // 单独一个 inject 块：它需要 systemPrompt，但**不**需要 workspace/session
    // —— 拆开之后即使桥接还没就绪，注入注册也已经完成（注册本身不依赖会话存在）。
    {
      root.inject(['systemPrompt'], (ctx) => {
        if (!memoryStore || !scopeResolver) {
          log.warn('[context] 记忆仓库未就绪，跳过常驻记忆注入')
          return
        }
        const disposeMemory = registerResidentMemory({
          ctx,
          memory: memoryStore,
          log,
          scopeForSession: (sessionId) => scopeResolver.resolve(sessionId),
          policy: () => ({
            budgetTokens: config.conversation.memoryBudgetTokens,
            injectMode: config.conversation.injectMode,
          }),
        })
        disposers.push(disposeMemory)

        // ── 前台行为约定（先追问再派活 / 查真实状态 / 说停就停）──────────
        //
        // 注册成 `systemPrompt.section`：固定行为约定，不是每步重算的上下文快照。
        // 只对常驻会话生效（别的会话由 scopeForSession 返回空串筛掉）。
        const disposeFrontDesk = registerFrontDesk({
          ctx,
          log,
          scopeForSession: (sessionId) => scopeResolver.resolve(sessionId),
        })
        disposers.push(disposeFrontDesk)
      })
    }

    root.effect(() => () => {
      if (pruneTimer) clearInterval(pruneTimer)
      for (const d of disposers) {
        try {
          d()
        } catch (err) {
          log.warn(`[dispose] ${err?.message ?? err}`)
        }
      }
      disposers.length = 0
      // 存活观测器的计时器必须显式清掉：它虽然 unref 过，但留着会持续读到空连接
      try {
        liveness.dispose()
      } catch {
        /* 忽略 */
      }
      if (server) void server.closeAll().catch(() => {})
      dsh = null
      log.info('已卸载')
    })
  },
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 把派活失败翻译成用户能据以行动的一句话。
 *
 * 起因：真机上一次失败只回了「任务受理失败：…」加一句框架内部措辞（英文），
 * 定位它花掉了大量考古工作。失败必须自解释 —— 用户和下一个维护者都该一眼看懂。
 * @param {any} err
 */
function describeFailure(err) {
  const msg = String(err?.message ?? err ?? '未知错误')
  const code = err?.code ?? err?.retcode
  const head = code ? `❌ 任务受理失败 [${code}]` : '❌ 任务受理失败'

  if (msg.includes('session.create accepts')) {
    return `${head}\n插件参数有误：建会话时不能同时指定 workspaceId 与 cwd。这是插件 bug，请反馈。`
  }
  if (msg.includes('workspace/not-found')) {
    return `${head}\n工作区没找到，可能已被删除。删掉 qq-projects 下的对应目录后会重建。`
  }
  if (msg.includes('session/not-found')) {
    return `${head}\n会话已失效。再发一次这条消息即可重建。`
  }
  if (msg.includes('not fully qualified')) {
    return (
      `${head}\n工作区父目录必须是完全限定路径（如 D:\\qq-projects），当前值不是。` +
      '请在 设置 → 插件 → dsh-whale-shall-adapt 里改成绝对路径。'
    )
  }
  if (msg.includes('workspaceRoot')) {
    return `${head}\n插件还没配置 tasks.workspaceRoot（工作区父目录），任务无处落盘。请在 DSH 设置里补上。`
  }
  if (msg.includes('gateway/bad-request')) {
    return `${head}\n参数被 DSH 拒绝：${truncate(msg, 200)}（可能是插件版本与 DSH 不匹配，请反馈）`
  }
  if (msg.includes('OneBot') || msg.includes('连接')) {
    return `${head}\nQQ 连接不可用：${truncate(msg, 150)}`
  }
  return `${head}\n${truncate(msg, 300)}`
}

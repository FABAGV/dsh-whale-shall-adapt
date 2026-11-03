/**
 * 提供给 agent 的 QQ 工具。
 *
 * 设计约束（见设计文档第 5 节）：策略校验必须走工具门控，而不是只写在提示词里。
 * 这里用 `ctx.tools.guard` 注册一个单调守卫：越界的会话在**派发前**就被拒绝。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inScope } from './config.js'
import { describeAliveReason } from './alive.js'
import { qqChatOf } from '../privacy/policy.js'
import { entryText } from '../meme/index.js'
import { sniffImageType } from './onebot/image.js'

/** 表情包目录：放在这里的图任何 QQ 会话都能发 */
export function defaultStickerDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'shall', 'meme', 'stickers')
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const realOrNull = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const STICKER_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
const MAX_STICKERS_LISTED = 200

/** 表情包目录里能发的图（只给文件名，不给本机路径）。目录不存在就是空的。 */
export function listStickers(stickerDir = defaultStickerDir()) {
  let entries
  try {
    entries = fs.readdirSync(stickerDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && STICKER_EXT.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

/**
 * 要发的图在不在允许的范围里，按真实路径比（软链接、.. 都绕不过去）：
 * - `sticker`：表情包目录里的文件名（可以不带扩展名），不许带目录；
 * - `path`：本会话工作区里的文件，相对路径按工作区算。
 * 两个只能给一个。返回 { file, label }；label 是给模型看的名字，报错和返回值都不带本机绝对路径。
 */
export function resolveSendableImage({ sticker, path: rawPath } = {}, { cwd = '', stickerDir = defaultStickerDir() } = {}) {
  const name = String(sticker ?? '').trim()
  const given = String(rawPath ?? '').trim()
  if (name && given) throw new Error('sticker 和 path 只能给一个')
  if (!name && !given) throw new Error('给 sticker（表情包名）或 path（工作区里的图）')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name || given)) throw new Error('只能发本机文件，不能给网址')

  if (name) {
    if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error('sticker 只填表情包的名字，不带目录')
    const dir = realOrNull(stickerDir)
    if (!dir) throw new Error('还没有表情包（表情包目录是空的）')
    const tries = path.extname(name) ? [name] : STICKER_EXT.map((ext) => name + ext)
    for (const t of tries) {
      const real = realOrNull(path.join(dir, t))
      if (real && isInside(real, dir)) return { file: real, label: t }
    }
    throw new Error(`没有叫「${name}」的表情包，先用 shall_qq_stickers 看看有哪些`)
  }

  const root = cwd ? realOrNull(cwd) : null
  if (!root) throw new Error('本会话没有工作区，只能发表情包（用 sticker）')
  const real = realOrNull(path.isAbsolute(given) ? given : path.join(root, given))
  if (!real) throw new Error(`工作区里找不到这个文件：${given}`)
  if (!isInside(real, root)) throw new Error('path 只能指本会话工作区里的图')
  return { file: real, label: path.relative(root, real).split(path.sep).join('/') }
}

/**
 * 存活信息 → 工具输出的紧凑形状。
 *
 * ⚠️ 只送**给人看的那几句**（`because`），不把 evidence 里的一堆数字塞进
 * 模型上下文：模型要做的是"如实转述为什么"，不是复算阈值。
 * 数字留给状态端点（人排查用）。
 *
 * @param {() => any} liveProbe
 * @returns {{alive:boolean, because:string} | null}
 */
function readAlive(liveProbe) {
  if (typeof liveProbe !== 'function') return null
  try {
    const view = liveProbe()
    if (!view || typeof view.alive !== 'boolean') return null
    return {
      alive: view.alive,
      because: (Array.isArray(view.because) ? view.because : []).join('；'),
    }
  } catch (err) {
    // 查不到就说查不到，**不要**默认"活着"
    return { alive: false, because: `存活检测本身出错了，按不活着处理：${err?.message ?? err}` }
  }
}

/**
 * 调用方是谁、能作用于哪个聊天（PLAN 改进点 2，docs/CONTRACTS.md 第 6 节）。
 *
 * - 拿不到会话头：拒绝（宿主总会给 exec.agent；拿不到说明调用路径不对，宁严勿松）。
 * - QQ 会话（含交班换下来的旧会话、它派出的子代理）：只能作用于自己所在的聊天，不传 chat_id 就默认自己；
 *   传了别的聊天直接报错。这一层和 privacy 的工具等级叠加：即使控制台把这个 QQ 会话设成“完全”，
 *   它也不能往别的聊天发消息、查别的聊天的语料或记忆。
 * - 你自己的会话：不限，chat_id 必须自己给。
 *
 * @returns {{own: {chatType:string, chatId:string} | null}} own 为 null 表示调用方是你自己的会话
 */
function callerScope(exec, chatOfCaller) {
  const header = exec?.agent?.session?.header
  if (!header?.id) throw new Error('拿不到调用方会话，拒绝执行（QQ 工具只在会话里用）')
  const chat = typeof chatOfCaller === 'function' ? chatOfCaller(header) : null
  return { own: chat ? { chatType: chat.chatType, chatId: String(chat.chatId) } : null }
}

/** 解析工具参数里的目标聊天；QQ 会话越界时抛错。
 *  `cross` 只给已经自行验过身份的调用点用（目前只有 `shall_qq_handoff` 的主人私聊）：
 *  它允许点名**别的**聊天，其余工具仍然只能作用于调用方自己所在的聊天。 */
function targetChat(args, exec, chatOfCaller, { required = true, cross = false } = {}) {
  const { own } = callerScope(exec, chatOfCaller)
  const given = args?.chat_id !== undefined && args?.chat_id !== null && String(args.chat_id).trim() !== ''
  const chatType = args?.chat_type === 'group' ? 'group' : args?.chat_type === 'private' ? 'private' : own?.chatType ?? 'private'
  const chatId = given ? String(args.chat_id).trim() : own?.chatId ?? ''
  if (!cross && own && (chatType !== own.chatType || chatId !== own.chatId)) {
    throw new Error(`这个会话只能作用于它自己所在的 QQ 聊天（${own.chatType}/${own.chatId}），不能操作 ${chatType}/${chatId}`)
  }
  if (required && !chatId) throw new Error('必须给出 chat_id')
  return { chatType, chatId, own }
}

/** 存活信息 → 给人看的一行 */
function renderAlive(alive) {
  if (!alive) return ''
  return `${alive.alive ? '✅ 插件活着' : '❌ 插件不活着'}：${alive.because || '（没有判据）'}`
}

/**
 * @param {object} opts
 * @param {any} opts.ctx 已注入 tools 的 cordis 上下文
 * @param {ReturnType<import('./config.js').resolveConfig>} opts.config
 * @param {ReturnType<import('../core/log.js').createLogger>} opts.log
 * @param {(chatType:'private'|'group', chatId:string, text:string) => Promise<void>} opts.send
 * @param {() => Array<{chatType:string, chatId:string, chatName?:string, workspacePath?:string}>} opts.listChats
 * @param {import('../conversation/chat-memory.js').ChatMemory} [opts.memory]
 *   碎片仓库（给用户一个"你记了什么 / 删掉它"的入口）。
 * @param {() => {value:number}} [opts.memoryGeneration] 当前代数（写碎片时用）
 * @param {import('./corpus.js').Corpus} [opts.corpus]
 * @param {() => {alive:boolean, because:string[], reasons:string[], evidence:object}} [opts.liveProbe]
 *   存活判定（v3.1）。由 index.js 注入，**与状态端点用的是同一个判据函数**
 *   —— 两边口径不一致比不报更糟。
 * @param {{isAdmitted?:(groupId:string)=>boolean}|null} [opts.groupSettings]
 *   控制台的群接入记录（`shall/groups.json`）。门控和 `listChats` 用同一份，不传就只认 `qq.scope.groups`。
 * @param {(() => {forceHandoff?:(chatType:string, chatId:string)=>{ok:boolean,error?:string}, isFrozen?:(chatType:string,chatId:string)=>boolean}|null)} [opts.handoff]
 *   交班监视器的取用函数。传函数不传实例：监视器比工具晚创建，直接传会是 undefined。
 *   不给 or null 时不注册 `shall_qq_handoff`（单独装 QQ 侧时就是这样）。
 * @param {((input:{chatType:string, chatId:string, text:string}) => Promise<{ok:boolean, sessionId?:string, error?:string}>) | null} [opts.tell]
 *   把一句话投进**另一个** QQ 会话的常驻会话（`shall_qq_tell`）。不传就不注册那个工具。
 * @returns {Array<() => void>} disposers
 */
export function registerQqTools({
  ctx,
  config,
  log,
  send,
  listChats,
  memory,
  memoryGeneration,
  corpus,
  liveProbe,
  meme = null,
  chatOfCaller = null,
  owner = null,
  groupSettings = null,
  handoff = null,
  tell = null,
  stickerDir = defaultStickerDir(),
  maxImageBytes = config?.participation?.maxImageBytes ?? 4 * 1024 * 1024,
}) {
  const disposers = []
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    log.warn('[tools] tools 服务不可用，跳过 shall_qq_send 注册')
    return disposers
  }

  // ── shall_qq_send：主动把消息发到指定 QQ 会话 ─────────────────────────────
  disposers.push(
    tools.register({
      name: 'shall_qq_send',
      description:
        '把一条消息发送到指定的 QQ 会话。仅能发往已接入且允许范围内的会话。' +
        '参数 chat_type 为 private 或 group，chat_id 为 QQ 号或群号。',
      parameters: {
        type: 'object',
        properties: {
          chat_type: {
            type: 'string',
            enum: ['private', 'group'],
            description: '会话类型：private=私聊，group=群聊',
          },
          chat_id: { type: 'string', description: 'QQ 号（私聊）或群号（群聊）' },
          text: { type: 'string', description: '要发送的纯文本内容' },
        },
        required: ['chat_type', 'chat_id', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            delivered: { type: 'boolean' },
            chatType: { type: 'string' },
            chatId: { type: 'string' },
            chars: { type: 'number' },
          },
          required: ['delivered', 'chatType', 'chatId', 'chars'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          value?.delivered
            ? [{ type: 'text', text: `已发送到 ${value.chatType === 'group' ? '群' : '私聊'} ${value.chatId}（${value.chars} 字）` }]
            : [{ type: 'text', text: '发送失败' }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { chatType, chatId } = targetChat(args, exec, chatOfCaller)
        const text = String(args?.text ?? '')
        if (!chatId || !text) throw new Error('chat_id 与 text 均为必填')
        await send(chatType, chatId, text)
        log.info(`[tools] shall_qq_send → ${chatType}/${chatId} (${text.length} 字)`)
        return { delivered: true, chatType, chatId, chars: text.length }
      },
    }),
  )

  // ── shall_qq_send_image：发一张图（表情包） ──────────────────────────────
  disposers.push(
    tools.register({
      name: 'shall_qq_send_image',
      description:
        '往 QQ 会话发一张图，常用来发表情包（接梗、无语、晚安……）。一条消息只发一张图，不带文字；要说话另外用正常回复。' +
        '表情包用 sticker 填名字（先用 shall_qq_stickers 看有哪些）；本会话工作区里的图用 path（相对工作区）。只认 png / jpg / gif / webp。' +
        '别连着发好几张，别每句话都配图。',
      parameters: {
        type: 'object',
        properties: {
          chat_type: { type: 'string', enum: ['private', 'group'], description: '会话类型：private=私聊，group=群聊' },
          chat_id: { type: 'string', description: 'QQ 号（私聊）或群号（群聊）' },
          sticker: { type: 'string', description: '表情包名字（shall_qq_stickers 列出来的那些，扩展名可省）' },
          path: { type: 'string', description: '本会话工作区里的图片，相对工作区的路径' },
        },
        required: ['chat_type', 'chat_id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { delivered: { type: 'boolean' }, chatType: { type: 'string' }, chatId: { type: 'string' }, bytes: { type: 'number' }, image: { type: 'string' } },
          required: ['delivered', 'chatType', 'chatId', 'bytes', 'image'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          value?.delivered
            ? [{ type: 'text', text: `图已发到 ${value.chatType === 'group' ? '群' : '私聊'} ${value.chatId}（${value.image}）` }]
            : [{ type: 'text', text: '发送失败' }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { chatType, chatId } = targetChat(args, exec, chatOfCaller)
        const cwd = typeof exec?.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : ''
        const { file, label } = resolveSendableImage({ sticker: args?.sticker, path: args?.path }, { cwd, stickerDir })
        const stat = fs.statSync(file)
        if (!stat.isFile()) throw new Error('这不是一个文件')
        if (stat.size > maxImageBytes) throw new Error(`图片太大（${Math.round(stat.size / 1024)} KB，上限 ${Math.round(maxImageBytes / 1024)} KB）`)
        const bytes = fs.readFileSync(file)
        if (!sniffImageType(bytes)) throw new Error('这不是 png / jpg / gif / webp 图片')
        await send(chatType, chatId, '', { image: `base64://${bytes.toString('base64')}` })
        log.info(`[tools] shall_qq_send_image → ${chatType}/${chatId} (${label}, ${bytes.length} 字节)`)
        return { delivered: true, chatType, chatId, bytes: bytes.length, image: label }
      },
    }),
  )

  // ── shall_qq_stickers：有哪些表情包能发（只读，只给名字） ────────────────
  disposers.push(
    tools.register({
      name: 'shall_qq_stickers',
      description: '列出能用 shall_qq_send_image 发的表情包名字。名字通常就说明了用途（比如「无语」「晚安」）。',
      parameters: {
        type: 'object',
        properties: { filter: { type: 'string', description: '只看名字里带这几个字的（可选）' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { stickers: { type: 'array', items: { type: 'string' } }, total: { type: 'number' } },
          required: ['stickers', 'total'],
          additionalProperties: false,
        },
        render: (_args, value) =>
          value?.total
            ? [{ type: 'text', text: `${value.total} 个表情包：${value.stickers.join('、')}${value.total > value.stickers.length ? '……' : ''}` }]
            : [{ type: 'text', text: '还没有表情包' }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        callerScope(exec, chatOfCaller)
        const filter = String(args?.filter ?? '').trim()
        const all = listStickers(stickerDir).filter((n) => !filter || n.includes(filter))
        return { stickers: all.slice(0, MAX_STICKERS_LISTED), total: all.length }
      },
    }),
  )

  // ── shall_qq_chats：让 agent 知道有哪些会话可用 ──────────────────────
  disposers.push(
    tools.register({
      name: 'shall_qq_chats',
      description: '列出当前已接入 DSH 的 QQ 会话（每个会话对应一个工作区），用于确认可以往哪里发消息。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            chats: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chatType: { type: 'string' },
                  chatId: { type: 'string' },
                  chatName: { type: 'string' },
                  workspacePath: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
          },
          required: ['chats'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const chats = value?.chats ?? []
          if (chats.length === 0) return [{ type: 'text', text: '当前没有已接入的 QQ 会话。' }]
          const lines = chats.map(
            (c) => `· ${c.chatType === 'group' ? '群' : '私聊'} ${c.chatId}${c.chatName ? `（${c.chatName}）` : ''} → ${c.workspacePath ?? '(未建工作区)'}`,
          )
          return [{ type: 'text', text: `已接入 ${chats.length} 个 QQ 会话：\n${lines.join('\n')}` }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const { own } = callerScope(exec, chatOfCaller)
        const chats = listChats()
        return { chats: own ? chats.filter((c) => c.chatType === own.chatType && String(c.chatId) === own.chatId) : chats }
      },
    }),
  )

  // ── shall_qq_alive：这台机器现在到底还活着吗 ───────────────────────────────
  //
  // 为什么单独立一个工具：
  //   - 它是**唯一**会明确回答"离线"的工具；
  //   - 判据必须与状态端点**同源**（都用注入的 liveProbe），否则会出现
  //     "端点说离线、模型说在线"这种最难排查的分裂。
  if (typeof liveProbe === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_qq_alive',
        description:
          '检测本插件与 QQ 通道**现在**是否还活着，返回判定与依据（哪条连接、最近一次事件多久之前、' +
          '事件循环是否还在跑、常驻会话的 agent 是否还在）。' +
          '用于回答"你还在吗""怎么没反应了""是不是掉线了"，以及**回答任何进度问题之前的第一步**：' +
          '离线就别谈进度。判定为假时 `because` 会说明缺的是哪一条 —— 如实转述，不要自行改写结论。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              alive: { type: 'boolean' },
              because: { type: 'string' },
              reasons: { type: 'array', items: { type: 'string' } },
            },
            required: ['alive', 'because', 'reasons'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                `${value?.alive ? '✅ 活着' : '❌ 不活着'}：${value?.because || '（没有判据）'}`,
            },
          ],
        },
        isConcurrencySafe: () => true,
        async execute() {
          const view = liveProbe()
          const reasons = (Array.isArray(view?.reasons) ? view.reasons : []).map((r) => describeAliveReason(r) || String(r))
          log.info(`[tools] shall_qq_alive → ${view?.alive ? 'alive' : `down(${(view?.reasons ?? []).join(',')})`}`)
          return {
            alive: Boolean(view?.alive),
            because: (Array.isArray(view?.because) ? view.because : []).join('；'),
            reasons: (view?.reasons ?? []).map((r) => String(r)),
          }
        },
      }),
    )
    log.info('[tools] 已注册 shall_qq_alive（存活检测：与状态端点同源）')
  }

  // ── shall_qq_memory：常驻记忆的查看与治理 ──────────────────────────────────
  //
  // 碎片是**用户对话的提炼**，属于隐私资产（与 lib/corpus.js 同一个姿态）。
  // 所以必须给用户一个能看见、能删掉的入口 —— 不能只增不减。
  if (memory) {
    disposers.push(
      tools.register({
        name: 'shall_qq_memory',
        description:
          '查看 / 管理某个 QQ 会话的**常驻记忆**（跨会话累积记住的事）。' +
          '这些碎片会作为背景注入该会话，所以用户有权看到并删掉它们。' +
          '不带参数时列出该会话记住的前若干条；' +
          '传 forget 可以删掉一条（给 id）或清空全部（forget:"all"）；' +
          '传 pin / unpin 可以把一条钉住（钉住的永不被自动淘汰）。',
        parameters: {
          type: 'object',
          properties: {
            chat_type: { type: 'string', enum: ['private', 'group'], description: '会话类型' },
            chat_id: { type: 'string', description: 'QQ 号或群号' },
            forget: {
              type: 'string',
              description: '要删除的碎片 id（如 "f0003"），或 "all" 清空该会话的全部记忆。',
            },
            pin: { type: 'string', description: '要钉住的碎片 id（钉住后永不被老化或淘汰）。' },
            unpin: { type: 'string', description: '取消钉住。' },
            add: { type: 'string', description: '手动记住一条（用户明确说"记住这个"时用）。' },
            limit: { type: 'number', description: '最多列出多少条，默认 30，上限 100。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              scope: { type: 'string' },
              count: { type: 'number' },
              total: { type: 'number' },
              revision: { type: 'number' },
              file: { type: 'string' },
              changed: { type: 'string' },
              fragments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    text: { type: 'string' },
                    kind: { type: 'string' },
                    importance: { type: 'number' },
                    refs: { type: 'number' },
                    pinned: { type: 'boolean' },
                    generation: { type: 'number' },
                  },
                  additionalProperties: true,
                },
              },
            },
            required: ['scope', 'count', 'total', 'revision', 'file', 'changed', 'fragments'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const head = value?.changed ? `${value.changed}\n` : ''
            const list = value?.fragments ?? []
            if (list.length === 0) {
              return [{ type: 'text', text: `${head}这个会话还没有常驻记忆（文件：${value?.file ?? '未知'}）。` }]
            }
            const lines = list.map(
              (f) =>
                `· ${f.id} [${f.kind}/重要度${f.importance}/提到${f.refs}次${f.pinned ? '/📌已钉住' : ''}] ${f.text}`,
            )
            return [
              {
                type: 'text',
                text: `${head}这个会话记住了 ${value.total} 条（显示 ${list.length} 条）：\n${lines.join('\n')}`,
              },
            ]
          },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const { chatType, chatId } = targetChat(args, exec, chatOfCaller)
          const scope = `${chatType}:${chatId}`
          // 当前代数（老化宽限期用）。拿不到就给 0 = 享受最大宽限，绝不误伤
          const gen = Number(memoryGeneration?.({ chatType, chatId })?.value ?? 0) || 0
          let changed = ''

          if (args?.forget !== undefined && args.forget !== null && String(args.forget).trim() !== '') {
            const what = String(args.forget).trim()
            const result =
              what === 'all'
                ? await memory.mutate({ scope, action: 'forget-all' })
                : await memory.mutate({ scope, action: 'forget', id: what })
            changed = result?.ok
              ? what === 'all'
                ? `已清空这个会话的常驻记忆（删掉 ${result.removed} 条）。`
                : `已删除碎片 ${result.id}：${String(result.text ?? '').slice(0, 40)}`
              : `没有删除：${result?.reason ?? '未知原因'}`
            log.info(`[tools] shall_qq_memory forget ${scope} ${what} → ${changed}`)
          } else if (args?.pin) {
            const r = await memory.mutate({ scope, action: 'pin', id: String(args.pin) })
            changed = r?.ok ? `已钉住 ${r.fragment?.id}` : `没有钉住：${r?.reason ?? '未知原因'}`
          } else if (args?.unpin) {
            const r = await memory.mutate({ scope, action: 'unpin', id: String(args.unpin) })
            changed = r?.ok ? `已取消钉住 ${r.fragment?.id}` : `没有改动：${r?.reason ?? '未知原因'}`
          } else if (args?.add) {
            const r = await memory.mutate({
              scope,
              action: 'add',
              text: String(args.add),
              importance: 2,
              gen,
            })
            changed = r?.ok
              ? r.action === 'dup'
                ? `这条已经记过了（${r.id}），已把重要度提上去。`
                : `已记住（${r.id}）。`
              : `没有记住：${r?.reason ?? '未知原因'}`
          }

          const limit = Math.min(Math.max(Number(args?.limit ?? 30) || 30, 1), 100)
          const all = memory.forScope(scope)
          const sorted = [...all].sort((a, b) => {
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
            if ((b.importance ?? 0) !== (a.importance ?? 0)) return (b.importance ?? 0) - (a.importance ?? 0)
            if ((b.lastSeenAt ?? 0) !== (a.lastSeenAt ?? 0)) return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
            return String(a.id).localeCompare(String(b.id))
          })
          return {
            scope,
            count: Math.min(sorted.length, limit),
            total: all.length,
            revision: memory.revisionOf(scope),
            file: memory.file,
            changed,
            fragments: sorted.slice(0, limit).map((f) => ({
              id: f.id,
              text: f.text,
              kind: f.kind,
              importance: f.importance,
              refs: f.refs,
              pinned: Boolean(f.pinned),
              generation: f.lastSeenGen ?? 0,
            })),
          }
        },
      }),
    )
    log.info('[tools] 已注册 shall_qq_memory（常驻记忆可查可删）')
  }

  // ── shall_qq_history：检索已沉淀的聊天语境 ───────────────────────────────
  if (corpus) {
    disposers.push(
      tools.register({
        name: 'shall_qq_history',
        description:
          '检索已沉淀到本地语料库的 QQ 聊天内容（包括用户转发给 bot 的合并转发记录）。' +
          '用于回答"我之前/群里说过什么"这类问题。只读，且只覆盖已接入的会话。',
        parameters: {
          type: 'object',
          properties: {
            chat_type: { type: 'string', enum: ['private', 'group'], description: '限定会话类型' },
            chat_id: { type: 'string', description: '限定会话（QQ 号或群号）' },
            query: { type: 'string', description: '关键词，子串匹配' },
            since_hours: { type: 'number', description: '只看最近多少小时，默认 168（7 天）' },
            limit: { type: 'number', description: '最多返回多少条，默认 30，上限 200' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ts: { type: 'number' },
                    chatType: { type: 'string' },
                    chatId: { type: 'string' },
                    kind: { type: 'string' },
                    text: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
            required: ['count', 'records'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const recs = value?.records ?? []
            if (recs.length === 0) return [{ type: 'text', text: '语料库里没有匹配的记录。' }]
            const lines = recs.map((r) => {
              const when = new Date(r.ts).toISOString().slice(5, 16).replace('T', ' ')
              const who = r.senderName ? `${r.senderName}: ` : ''
              return `· ${when} [${r.chatType}/${r.chatId}] ${who}${r.text || `(${r.kind})`}`
            })
            return [{ type: 'text', text: `找到 ${recs.length} 条：\n${lines.join('\n')}` }]
          },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const sinceHours = Number(args?.since_hours ?? 168)
          const limit = Math.min(Number(args?.limit ?? 30), 200)
          const target = targetChat(args, exec, chatOfCaller, { required: false })
          const scoped = Boolean(target.own) || Boolean(target.chatId)
          const rows = corpus.search({
            chatType: scoped ? target.chatType : args?.chat_type ? String(args.chat_type) : undefined,
            chatId: scoped ? target.chatId : undefined,
            query: args?.query ? String(args.query) : undefined,
            since: Number.isFinite(sinceHours) ? Date.now() - sinceHours * 3600_000 : undefined,
            limit,
          })
          return {
            count: rows.length,
            records: rows.map((r) => ({
              ts: r.ts,
              chatType: r.chatType,
              chatId: r.chatId,
              kind: r.kind,
              senderName: r.senderName ?? '',
              text:
                r.kind === 'forward'
                  ? `[合并转发 ${r.nodes?.length ?? 0} 条] ` +
                    (r.nodes ?? []).slice(0, 20).map((n) => `${n.s}: ${n.x}`).join(' | ')
                  : String(r.text ?? ''),
            })),
          }
        },
      }),
    )
    log.info('[tools] 已注册 shall_qq_history（语料库检索）')

    // ── shall_qq_summary：按需群总结（UX 第 39 条）────────────────────────────
    // 只在有人叫 bot 总结时用，不定时推送。工具只负责把某个群最近一段时间的聊天按时间排好交给模型，
    // 总结由模型自己写；QQ 会话里只能总结自己所在的群。
    disposers.push(
      tools.register({
        name: 'shall_qq_summary',
        description:
          '取某个 QQ 群最近一段时间的聊天记录（按时间从早到晚），用来回答“总结一下群里刚才聊了什么”。' +
          '只在有人明确要总结时才用；拿到记录后由你自己写总结，别把原话大段照抄。默认看最近 6 小时，最多 72 小时。',
        parameters: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: '群号；在群会话里不传就是当前群' },
            hours: { type: 'number', description: '看最近多少小时，默认 6，最多 72' },
            max_messages: { type: 'number', description: '最多取多少条（取最新的），默认 150，最多 400' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              hours: { type: 'number' },
              chatId: { type: 'string' },
              truncated: { type: 'boolean' },
              transcript: { type: 'string' },
            },
            required: ['count', 'hours', 'chatId', 'truncated', 'transcript'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            if (!value?.count) return [{ type: 'text', text: `群 ${value?.chatId ?? ''} 最近 ${value?.hours ?? ''} 小时没有记录。` }]
            const head = `群 ${value.chatId} 最近 ${value.hours} 小时的聊天（${value.count} 条${value.truncated ? '，更早的已省略' : ''}）：`
            return [{ type: 'text', text: `${head}\n${value.transcript}` }]
          },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const target = targetChat({ ...args, chat_type: 'group' }, exec, chatOfCaller, { required: true })
          if (target.chatType !== 'group') throw new Error('群总结只能用在群聊')
          if (!inScope(config, 'group', target.chatId, owner, groupSettings)) throw new Error(`群 ${target.chatId} 不在 QQ 通道的允许范围内`)
          const hours = Math.min(72, Math.max(1, Number(args?.hours) || 6))
          const maxMessages = Math.min(400, Math.max(1, Number(args?.max_messages) || 150))
          const rows = corpus
            .search({ chatType: 'group', chatId: target.chatId, since: Date.now() - hours * 3600_000, limit: 400 })
            .filter((r) => (r.kind === 'message' || r.kind === 'forward') && (r.text || r.nodes?.length))
            .reverse()
          let truncated = rows.length > maxMessages
          const line = (r) => {
            const when = new Date(r.ts)
            const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
            const body = r.kind === 'forward' ? `[合并转发 ${r.nodes?.length ?? 0} 条]` : String(r.text).replace(/\s+/g, ' ').slice(0, 160)
            return `${hhmm} ${r.senderName || r.senderId || '?'}: ${body}`
          }
          let lines = rows.slice(-maxMessages).map(line)
          while (lines.join('\n').length > 12000 && lines.length > 1) {
            lines = lines.slice(1)
            truncated = true
          }
          return { count: lines.length, hours, chatId: target.chatId, truncated, transcript: lines.join('\n') }
        },
      }),
    )
    log.info('[tools] 已注册 shall_qq_summary（按需群总结）')
  }

  // ── shall_memory_recall：按关键词翻记忆（PLAN 第 10 条）────────────────────
  // 常驻注入只放一小组稳定的记忆；其余的靠这个工具翻。QQ 会话只翻自己看得到的范围，你自己的会话翻身份 + 干活两片。
  if (memory && typeof memory.recallFor === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_memory_recall',
        description:
          '按关键词翻你记住的事（包括已过时的，会标“以前”）。常驻注入的清单只是一小部分；想不起来某件事、' +
          '或用户问“我之前说过……吗”时先翻一下，别凭印象答。只翻你这个会话看得到的记忆。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或一句话描述' },
            limit: { type: 'number', description: '最多返回几条，默认 5，最多 10' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' }, status: { type: 'string' }, historical: { type: 'boolean' } },
                  additionalProperties: true,
                },
              },
            },
            required: ['count', 'items'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const items = value?.items ?? []
            if (items.length === 0) return [{ type: 'text', text: '没翻到相关的记忆。' }]
            return [{ type: 'text', text: items.map((m) => `- [${m.kind}]${m.historical ? '（以前）' : ''} ${m.text}`).join('\n') }]
          },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const { own } = callerScope(exec, chatOfCaller)
          const query = String(args?.query ?? '').trim()
          if (!query) throw new Error('需要 query')
          const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
          const rows = own ? memory.recallFor(`${own.chatType}:${own.chatId}`, query, limit) : memory.recallOwner(query, limit)
          return { count: rows.length, items: rows }
        },
      }),
    )
    log.info('[tools] 已注册 shall_memory_recall（按需翻记忆）')
  }

  // ── shall_meme_lookup：梗百科（本群黑话 → 本地词库）────────────────────────
  // 来源：astrbot_plugin_memewiki v1.7.0（MIT）。只读，不联网；群黑话只查调用方自己所在的群。
  if (meme && typeof meme.lookup === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_meme_lookup',
        description:
          '查一个网络梗、黑话、缩写、绰号是什么意思、怎么用、怎么接。拿不准某个词就先查，别硬猜、别编。' +
          '查到之后先照着【怎么用 / 怎么接】自然地用一句，别上来科普；只有对方明确问出处时才讲出处。查不到就说不知道。',
        parameters: {
          type: 'object',
          properties: { term: { type: 'string', description: '要查的词（1–12 字）' } },
          required: ['term'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { found: { type: 'boolean' }, title: { type: 'string' }, custom: { type: 'boolean' }, text: { type: 'string' } },
            required: ['found', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value?.text || '没查到这个词。' }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const term = String(args?.term ?? '').trim().slice(0, 12)
          if (!term) throw new Error('term 必填')
          const header = exec?.agent?.session?.header
          const chat = chatOfCaller?.(header)
          const chatKey = chat ? `chat:${chat.chatType}:${chat.chatId}` : undefined
          const entry = await meme.lookup(term, { chatKey, online: true })
          log.info(`[tools] shall_meme_lookup ${term} → ${entry ? entry.title : '没查到'}`)
          if (!entry) return { found: false, text: `梗百科里没有「${term}」。不知道就直说不知道，或者问对方是什么意思。` }
          return { found: true, title: entry.title, custom: Boolean(entry.custom), text: entryText(entry) }
        },
      }),
    )
    log.info('[tools] 已注册 shall_meme_lookup（梗百科）')
  }

  // ── shall_qq_handoff：主人点名要求换一台会话 ────────────────────────────
  //
  // 自动交班只看上下文到没到线；想让"聊长了才换"变成"我说了算"，就得有个入口。
  //
  // 权限（在派发前判，不靠提示词约束）：
  //   - 主人的私聊、主人自己的 DSH 会话是**控制台**：可以给自己换，也可以点名别的
  //     已接入会话（群或私聊），让它在下一次 turn/end 换一台。目标不必正在说话，
  //     工具只登记意图（意图有有效期，见 handoff.js 的 FORCED_TTL_MS）。
  //   - 群会话、别人的私聊**不能**跨会话交班：群里任何人都能驱动群会话，
  //     放开的话陌生人一句话就能让另一个会话归档重建、烧一次整理调用。
  //   - 目标必须在 qq.scope / 控制台群接入的允许范围内，并且已经建过常驻会话。
  if (typeof handoff === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_qq_handoff',
        description:
          '把 QQ 会话的常驻会话换一台（交班）：先整理成交接束和记忆碎片，再建一台干净会话接着聊。' +
          '在主人自己的私聊（或主人自己的 DSH 会话）里可以用 chat_type / chat_id 点名别的已接入会话，' +
          '让它在下一轮说完后换；不点名就是当前这个会话。别的会话里只能给自己所在的私聊交班（必须是主人的私聊）。',
        parameters: {
          type: 'object',
          properties: {
            chat_type: { type: 'string', enum: ['private', 'group'], description: '会话类型，不传就是自己所在的会话' },
            chat_id: { type: 'string', description: 'QQ 号或群号，不传就是自己所在的会话' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              scheduled: { type: 'boolean' },
              chatType: { type: 'string' },
              chatId: { type: 'string' },
              when: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['ok', 'scheduled', 'chatType', 'chatId', 'when'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value?.ok
                ? `已登记：${value.chatType === 'group' ? '群' : '私聊'} ${value.chatId} 在${value.when}就换一台。`
                : `没有换：${value?.error ?? '未知原因'}`,
            },
          ],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const ownerQq = owner?.owner?.()
          const header = exec?.agent?.session?.header
          const { own } = callerScope(exec, chatOfCaller)
          // 绑定表丢了的时候，工作区目录名仍然认得出这是 QQ 会话，不能当成"主人自己的会话"放行
          const callerLooksQq =
            Boolean(own) || Boolean(qqChatOf(header?.cwd)) || Boolean(header?.parentSession) || header?.origin === 'subagent'
          const callerIsOwnerPrivate = Boolean(
            own && ownerQq && own.chatType === 'private' && String(own.chatId) === String(ownerQq),
          )
          // 控制台 = 主人的私聊，或主人自己的 DSH 会话（不是 QQ 会话、也不是子代理）
          const callerIsControl = callerIsOwnerPrivate || (!own && !callerLooksQq)
          const { chatType, chatId } = targetChat(args, exec, chatOfCaller, { cross: callerIsControl })
          const targetIsOwnerPrivate = Boolean(
            ownerQq && chatType === 'private' && String(chatId) === String(ownerQq),
          )
          if (!callerIsControl && (callerLooksQq || !targetIsOwnerPrivate)) {
            return {
              ok: false, scheduled: false, chatType, chatId, when: '',
              error: '只有主人自己的私聊（或你自己的会话）能主动交班，并可以点名别的会话',
            }
          }
          if (!inScope(config, chatType, chatId, owner, groupSettings)) {
            return {
              ok: false, scheduled: false, chatType, chatId, when: '',
              error: `会话 ${chatType}/${chatId} 不在 QQ 通道的允许范围内`,
            }
          }
          const monitor = handoff()
          if (!monitor?.forceHandoff) {
            return { ok: false, scheduled: false, chatType, chatId, when: '', error: '交班监视器没启用' }
          }
          const out = monitor.forceHandoff(chatType, chatId)
          if (!out?.ok) {
            return { ok: false, scheduled: false, chatType, chatId, when: '', error: out?.error ?? '登记失败' }
          }
          const self = Boolean(own && chatType === own.chatType && chatId === own.chatId)
          log.info(
            `[tools] shall_qq_handoff ${chatType}:${chatId} 已登记` +
              `（调用方 ${own ? `${own.chatType}/${own.chatId}` : '非 QQ 会话'}），等它下一次 turn/end`,
          )
          return {
            ok: true,
            scheduled: true,
            chatType,
            chatId,
            when: self ? '这一轮回答说完' : '下一次说完话',
          }
        },
      }),
    )
  }

  // ── shall_qq_tell：给另一个 QQ 会话捎一句话 ────────────────────────────
  //
  // 每个 QQ 聊天各挂一台常驻会话，彼此之间没有通道。这里开一个**只走工具**的窄口：
  // 往目标会话投一句话，正文前面由插件标好来源，收信那边当成一条普通用户消息接着处理。
  //
  // 防环路靠机制而不是次数上限：一方的回复不会让对端自动再发一次 —— 想再发就必须再调一次这个工具，
  // 而每次调用都是一次有代价、日志里看得见的动作。
  if (typeof tell === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_qq_tell',
        description:
          '给另一个 QQ 会话（别的群，或者主人的私聊）捎一句话：内容会作为一条带来源标注的消息投进那个会话，' +
          '由那边的自己接着处理。必须写明 chat_type 和 chat_id（群号或 QQ 号）。' +
          '不能发给自己所在的会话；同一个目标别连着刷。',
        parameters: {
          type: 'object',
          properties: {
            chat_type: { type: 'string', enum: ['private', 'group'], description: '会话类型：private=私聊，group=群聊' },
            chat_id: { type: 'string', description: 'QQ 号（私聊）或群号（群聊）' },
            text: { type: 'string', description: '要捎过去的话' },
          },
          required: ['chat_type', 'chat_id', 'text'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              delivered: { type: 'boolean' },
              chatType: { type: 'string' },
              chatId: { type: 'string' },
              chars: { type: 'number' },
              error: { type: 'string' },
            },
            required: ['delivered', 'chatType', 'chatId', 'chars', 'error'],
            additionalProperties: false,
          },
          render: (_args, value) =>
            value?.delivered
              ? [{ type: 'text', text: `已捎到 ${value.chatType === 'group' ? '群' : '私聊'} ${value.chatId}（${value.chars} 字）` }]
              : [{ type: 'text', text: `没捎过去：${value?.error ?? '未知原因'}` }],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          // cross: true —— 这个工具存在的意义就是跨会话，所以不走"只能作用于自己"那条默认校验；
          // 目标在不在允许范围内由下面的 tools.guard 统一挡（和 shall_qq_send 用的是同一份判据）。
          const { chatType, chatId, own } = targetChat(args, exec, chatOfCaller, { cross: true })
          const text = String(args?.text ?? '').trim()
          if (!text) throw new Error('text 必填')
          if (own && chatType === own.chatType && chatId === own.chatId) {
            throw new Error('不能给自己所在的会话捎话（那会绕成一圈）')
          }
          const ownerQq = owner?.owner?.()
          const fromLabel = !own
            ? '主人对接会话'
            : own.chatType === 'group'
              ? `群 ${own.chatId} 的群会话`
              : ownerQq && String(own.chatId) === String(ownerQq)
                ? '主人对接会话'
                : `私聊 ${own.chatId} 的会话`
          const body = `（来自 ${fromLabel}）\n${text}`
          const out = await tell({ chatType, chatId, text: body })
          if (!out?.ok) {
            log.info(`[tools] shall_qq_tell → ${chatType}/${chatId} 没投出去：${out?.error ?? '未知原因'}`)
            return { delivered: false, chatType, chatId, chars: 0, error: String(out?.error ?? '未知原因') }
          }
          log.info(`[tools] shall_qq_tell → ${chatType}/${chatId}（来自 ${fromLabel}，${text.length} 字）`)
          return { delivered: true, chatType, chatId, chars: text.length, error: '' }
        },
      }),
    )
  }
  // ── 门控：越界会话在派发前拒绝 ──────────────────────────────────────
  //
  // 模型不能通过传参把消息发到、或把记忆改到别的 QQ 会话去 —— 这不是靠提示词约束的事，要在派发前拒掉。
  //
  // ⚠️ 早先这里是"两个工具名的白名单"，于是**凡是有写副作用的入口都漏了**：
  //    `shall_qq_memory` 能清掉别的会话的全部常驻记忆（forget:'all' 只按 scope 过滤，
  //    没有权限校验）。
  //    agent 是被**不可信 QQ 文本**驱动的，这条越权面必须收在派发前。
  //    现在改成"按**是不是写操作**判定"，而不是按工具名枚举 —— 新增工具不会再漏。
  //
  // 只读工具（shall_qq_alive / shall_qq_chats / shall_qq_history）仍然不在这里拦。跨会话**读**的收紧落在 `shall_qq_chats`
  // 的 scope 过滤上（见 index.js 的 listChats），它才是"能拿到别人 chatId"的入口。
  if (typeof tools.guard === 'function') {
    /** 写类工具：一律校验参数里的会话是否在 scope 内 */
    const guarded = new Set(['shall_qq_send', 'shall_qq_send_image', 'shall_qq_memory', 'shall_qq_handoff', 'shall_qq_tell'])
    disposers.push(
      tools.guard((execution) => {
        const name = String(execution?.name ?? '')
        const args = execution.arguments
        if (!guarded.has(name)) return undefined
        const given = args?.chat_id !== undefined && args?.chat_id !== null && String(args.chat_id).trim() !== ''
        // 不传 chat_id = 作用于调用方自己所在的聊天（shall_qq_memory / shall_qq_handoff 都支持）。
        // 不能在这里要求必填：那会把"看本群记忆""给自己交班"这种合法调用一起拒掉。
        const header = execution?.agent?.session?.header
        const ownChat = !given && header?.id && typeof chatOfCaller === 'function' ? chatOfCaller(header) : null
        const own = ownChat ? { chatType: ownChat.chatType, chatId: String(ownChat.chatId) } : null
        const chatType = args?.chat_type === 'group' ? 'group' : args?.chat_type === 'private' ? 'private' : own?.chatType ?? 'private'
        const chatId = given ? String(args.chat_id).trim() : own?.chatId ?? ''
        if (!chatId) return `${name} 缺少 chat_id`
        // 控制台里「接入」的群记在 groupSettings 里，不在 qq.scope.groups：两处都要认
        if (!inScope(config, chatType, chatId, owner, groupSettings)) {
          return `会话 ${chatType}/${chatId} 不在 QQ 通道的允许范围内（qq.scope 配置或控制台的群接入），已拒绝`
        }
        return undefined
      }),
    )
    const names = ['shall_qq_send', 'shall_qq_send_image', 'shall_qq_stickers', 'shall_qq_chats']
    if (corpus) names.push('shall_qq_history', 'shall_qq_summary')
    if (typeof liveProbe === 'function') names.push('shall_qq_alive')
    if (memory) names.push('shall_qq_memory')
    if (meme) names.push('shall_meme_lookup')
    if (memory) names.push('shall_memory_recall')
    if (typeof handoff === 'function') names.push('shall_qq_handoff')
    if (typeof tell === 'function') names.push('shall_qq_tell')
    log.info(
      `[tools] 已注册 ${names.join(' / ')}，门控覆盖写操作 ${[...guarded].join(' / ')}`,
    )
  } else {
    log.info('[tools] 已注册 QQ 工具（tools.guard 不可用，未挂门控）')
  }

  return disposers
}

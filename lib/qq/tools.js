/**
 * 提供给 agent 的 QQ 工具。
 *
 * 设计约束（见设计文档第 5 节）：策略校验必须走工具门控，而不是只写在提示词里。
 * 这里用 `ctx.tools.guard` 注册一个单调守卫：越界的会话在**派发前**就被拒绝。
 */
import { inScope } from './config.js'
import { describeAliveReason, describeTasks } from './alive.js'
import { entryText } from '../meme/index.js'

/**
 * 存活信息 → 工具输出的紧凑形状。
 *
 * ⚠️ 只送**给人看的那几句**（`because`），不把 evidence 里的一堆数字塞进
 * 模型上下文：模型要做的是"如实转述为什么"，不是复算阈值。
 * 数字留给状态端点（人排查用）。
 *
 * @param {() => any} liveProbe
 * @returns {{alive:boolean, because:string, tasks:string} | null}
 */
function readAlive(liveProbe) {
  if (typeof liveProbe !== 'function') return null
  try {
    const view = liveProbe()
    if (!view || typeof view.alive !== 'boolean') return null
    return {
      alive: view.alive,
      because: (Array.isArray(view.because) ? view.because : []).join('；'),
      tasks: describeTasks(view.tasks),
    }
  } catch (err) {
    // 查不到就说查不到，**不要**默认"活着"
    return { alive: false, because: `存活检测本身出错了，按不活着处理：${err?.message ?? err}`, tasks: '' }
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

/** 解析工具参数里的目标聊天；QQ 会话越界时抛错。 */
function targetChat(args, exec, chatOfCaller, { required = true } = {}) {
  const { own } = callerScope(exec, chatOfCaller)
  const given = args?.chat_id !== undefined && args?.chat_id !== null && String(args.chat_id).trim() !== ''
  const chatType = args?.chat_type === 'group' ? 'group' : args?.chat_type === 'private' ? 'private' : own?.chatType ?? 'private'
  const chatId = given ? String(args.chat_id).trim() : own?.chatId ?? ''
  if (own && (chatType !== own.chatType || chatId !== own.chatId)) {
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
 * @param {(query?:{chatType?:string, chatId?:string, limit?:number}) => Array<any>} [opts.listTasks]
 *   任务台账查询（来自 StateStore）
 * @param {import('../conversation/memory.js').MemoryStore} [opts.memory]
 *   碎片仓库（给用户一个"你记了什么 / 删掉它"的入口）。
 * @param {() => {value:number}} [opts.memoryGeneration] 当前代数（写碎片时用）
 * @param {import('./corpus.js').Corpus} [opts.corpus]
 * @param {() => {alive:boolean, because:string[], reasons:string[], evidence:object, tasks?:object}} [opts.liveProbe]
 *   存活判定（v3.1）。由 index.js 注入，**与状态端点用的是同一个判据函数**
 *   —— 两边口径不一致比不报更糟。
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
  // 为什么单独立一个工具（而不是只并进 shall_qq_tasks）：
  //   - 它是**唯一**会明确回答"离线"的工具，用户问"你还在吗"时不需要顺带拉一份台账；
  //   - 判据必须与状态端点**同源**（都用注入的 liveProbe），否则会出现
  //     "端点说离线、模型说在线"这种最难排查的分裂。
  if (typeof liveProbe === 'function') {
    disposers.push(
      tools.register({
        name: 'shall_qq_alive',
        description:
          '检测本插件与 QQ 通道**现在**是否还活着，返回判定与依据（哪条连接、最近一次事件多久之前、' +
          '事件循环是否还在跑、在跑的任务会话是否还在）。' +
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
              tasks: { type: 'string' },
            },
            required: ['alive', 'because', 'reasons', 'tasks'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                `${value?.alive ? '✅ 活着' : '❌ 不活着'}：${value?.because || '（没有判据）'}` +
                (value?.tasks ? `\n${value.tasks}` : ''),
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
            tasks: describeTasks(view?.tasks),
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
            revision: memory.revision,
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
          const entry = await meme.lookup(term, { chatKey })
          log.info(`[tools] shall_meme_lookup ${term} → ${entry ? entry.title : '没查到'}`)
          if (!entry) return { found: false, text: `梗百科里没有「${term}」。不知道就直说不知道，或者问对方是什么意思。` }
          return { found: true, title: entry.title, custom: Boolean(entry.custom), text: entryText(entry) }
        },
      }),
    )
    log.info('[tools] 已注册 shall_meme_lookup（梗百科）')
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
  // 只读工具（shall_qq_alive / shall_qq_chats / shall_qq_history / shall_qq_tasks）
  // 仍然不在这里拦：这与既有的行为约定一致（`tools/test-entry.mjs` 有一条
  // "门控不干预只读的 shall_qq_tasks" 断言）。跨会话**读**的收紧落在 `shall_qq_chats`
  // 的 scope 过滤上（见 index.js 的 listChats），它才是"能拿到别人 chatId"的入口。
  if (typeof tools.guard === 'function') {
    /** 写类工具：一律校验参数里的会话是否在 scope 内 */
    const guarded = new Set(['shall_qq_send', 'shall_qq_memory'])
    disposers.push(
      tools.guard((execution) => {
        const name = String(execution?.name ?? '')
        const args = execution.arguments
        if (!guarded.has(name)) return undefined
        const chatType = args?.chat_type === 'group' ? 'group' : 'private'
        const chatId = String(args?.chat_id ?? '')
        if (!chatId) return `${name} 缺少 chat_id`
        if (!inScope(config, chatType, chatId, owner)) {
          return `会话 ${chatType}/${chatId} 不在 QQ 通道的允许范围内（scope 配置），已拒绝`
        }
        return undefined
      }),
    )
    const names = ['shall_qq_send', 'shall_qq_chats']
    if (corpus) names.push('shall_qq_history')
    if (typeof liveProbe === 'function') names.push('shall_qq_alive')
    if (memory) names.push('shall_qq_memory')
    if (meme) names.push('shall_meme_lookup')
    log.info(
      `[tools] 已注册 ${names.join(' / ')}，门控覆盖写操作 ${[...guarded].join(' / ')}`,
    )
  } else {
    log.info('[tools] 已注册 QQ 工具（tools.guard 不可用，未挂门控）')
  }

  return disposers
}

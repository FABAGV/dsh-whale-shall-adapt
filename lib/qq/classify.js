/**
 * 消息定性：两条**只剩下来**的规则 —— 寻址门 + 用户显式前缀。
 *
 * 这里曾经有三类规则：寻址、显式前缀、以及"控制指令关键词"（`/cancel [N|all]`）。
 * 第三类已经删掉了，理由是**关键词会误判**：
 * "把这个任务停一下看看日志" 会被前缀匹配吃成停止命令 —— 而那正是用户
 * 想让它做的事（看日志），不是取消。控制意图交给常驻会话自己理解：它就在干那件事，说停就停。
 *
 * ## 寻址门（保留）：这不是控制词，是"这句话是不是对我说的"
 *
 * `participation.groupMode: mention` 下，**未被 @ 的群消息只入库、不进任何会话**。
 * 它判的不是"说什么"，而是"要不要理这一句"—— 与用户说了什么内容无关，
 * 所以它既无法被 LLM 语义判断替代（判断发生在进会话之前，会话还没看到它），
 * 也不能像关键词那样误伤任意一句话。
 *
 * ## 显式前缀（保留）：用户主动设的开关
 *
 * `tasks.prefix` / `tasks.chatPrefix` 是**用户显式配置**的（默认都是空字符串，
 * 留空即不启用）。留着的理由：它是用户自己按下的开关，语义明确、不会误判，
 * 而且是常驻会话不可用时的兜底分诊依据。
 *
 * ## 剩下的判断权交给常驻会话
 *
 * "这条到底是要我干活、还是闲聊、还是在问进度"不由规则决定：
 * 消息照原文进常驻会话，由它自己决定怎么做（规则在 frontdesk.js 的系统提示里）。
 * 分类结果只进日志和统计，不往正文里加任何标注。
 *
 * 本模块刻意不依赖 ctx / config / 日志，可以被单独 import 与测试。
 */

/** 分类结果 */
export const CLASSIFY = {
  /** 空消息或纯空白：不处理 */
  IGNORE: 'ignore',
  /** 闲聊：进该会话的常驻 root session */
  CHAT: 'chat',
  /** 任务：新建独立任务 session */
  TASK: 'task',
}

/** 短消息阈值（字符数，空白不计）。超过它的一律不判闲聊 */
export const SHORT_MESSAGE_MAX_CHARS = 20

/**
 * 整句匹配的寒暄/社交模式。
 * 这里刻意用**整句**匹配（normalize 去掉空白与句末标点后再比对），
 * 而不是 `^在` 这类前缀匹配 —— 否则"在 R:\x 建个目录"这种短任务会被误判成闲聊。
 */
const FULL_PATTERNS = [
  // 在吗 / 在不在
  /^(在|在吗|在么|在嘛|在不在|你在吗|你在么|有人吗|在的|在不在呀)$/,
  // 问候与道别
  /^(你好|您好|哈喽|哈啰|嗨|hi|hello|hey|早上好|早安|早|中午好|下午好|晚上好|晚安|拜拜|再见|bye|see you)$/i,
  // 致谢
  /^(谢谢|谢谢你|多谢|感谢|辛苦了|辛苦|thanks|thank you|thx|3q)$/i,
  // 收到/附和
  /^(好的|好嘞|好|嗯|嗯嗯|哦|噢|收到|了解|明白|ok|okay|okk)$/i,
  // 对 bot 自身的问题（典型的闲聊开场）
  /^(你是谁|你叫什么|你叫啥|你是什么|你会什么|你能做什么|你能干什么|你是做什么的|你几岁了|你叫什么名字)$/,
  // 测试性搭话
  /^(测试|测试一下|test|testing|ping)$/i,
  // 只有一个问号
  /^[?？]+$/,
]

/**
 * 询问进度类：短句 + 整句匹配才算闲聊。
 *
 * ⚠️ 判成闲聊**不等于**"随便答一句"。常驻会话收到这类话时的契约是
 * **先去查真实状态再答**（`shall_qq_alive`），见 frontdesk.js 的规则。
 */
const QUESTION_PATTERNS = [
  /^(现在)?(怎么样|如何|进展|进度|状态)$/,
  /^(好了吗|好了没|好了嘛|好了么|完成了吗|完成没|跑完了吗|跑完了没|弄好了吗|做完了吗|可以了吗)$/,
  /^(还要多久|多久好|啥时候好|什么时候好|到哪了)$/,
]

/**
 * 归一化：去首尾空白、句末标点与语气助词，便于整句匹配
 */
function normalize(text) {
  return String(text ?? '')
    .trim()
    .replace(/[?？!！。.,，、~～;；:：]+$/g, '')
    .trim()
    // 语气助词不影响"这句话是不是寒暄"：'现在怎么样了' / '你是谁啊' / '谢谢啦'
    .replace(/[了呢吧啊呀哦嘛哈嘞]+$/g, '')
    .trim()
}

/** 计字符数（空白不计，按码点计 —— 别把 emoji 算成两个） */
export function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/g, '')).length
}

/** 是否是寒暄/闲聊短句（不含长度判断，便于单测） */
export function looksLikeChitchat(text) {
  const t = normalize(text)
  if (!t) return false
  for (const re of FULL_PATTERNS) if (re.test(t)) return true
  for (const re of QUESTION_PATTERNS) if (re.test(t)) return true
  return false
}

/**
 * ── 寻址门 ────────────────────────────────────────────────────────────
 *
 * bot 该不该在这个会话里回应。**这是"要不要理"的规则，不是"理什么"的规则。**
 *
 * 契约（与 `config.js` 的 `participation` 同源）：
 *   - group + silent  → 永不回应（只入库）
 *   - group + mention → 只有被 @ 才回应
 *   - group + active  → 全部回应
 *   - private         → 只看 `privateMode`（always = 全部回应）
 *
 * @param {object} input
 * @param {'private'|'group'|string} input.chatType
 * @param {boolean} [input.atBot] 这条消息是否 @ 了 bot（群聊用；私聊恒为 false）
 * @param {string} [input.groupMode] `participation.groupMode`
 * @param {string} [input.privateMode] `participation.privateMode`
 * @returns {{respond:boolean, reason:string}}
 */
export function shouldRespond({
  chatType,
  atBot = false,
  groupMode = 'mention',
  privateMode = 'always',
} = {}) {
  if (chatType === 'group') {
    // 没有群决策引擎时的兜底：只有“被叫到”才回。present / active 的判断在 lib/group/engine.js
    if (groupMode === 'silent') return { respond: false, reason: 'group-not-mentioned' }
    return atBot ? { respond: true, reason: 'group-mentioned' } : { respond: false, reason: 'group-not-mentioned' }
  }
  if (privateMode !== 'always') return { respond: false, reason: 'private-disabled' }
  return { respond: true, reason: 'private' }
}

/**
 * 给一条消息定性。
 *
 * 规则顺序（前两段是用户显式指令，优先级最高）：
 *   1. 空/纯空白                        → ignore
 *   2. 命中 tasks.prefix（任务前缀）      → task（强制）
 *   3. 命中 tasks.chatPrefix（闲聊前缀）  → chat（强制）
 *   4. 带合并转发等附件                  → task（转发一段记录必然是"要它看"）
 *   5. 短消息 且 命中寒暄/提问模式        → chat
 *   6. 其余                              → task
 *
 * 第 2 步排在第 3 步前面：两个前缀同时命中只可能出现在互相嵌套的配置里
 * （如 chatPrefix="/" + taskPrefix="/task"），此时按更"主动"的解释走 ——
 * 与"不确定判成任务"的取舍一致。
 *
 * ⚠️ **这里不再有控制指令分支**：`/cancel 3` 现在和别的正文一样走分类
 * （默认落到 task 分支，再由常驻会话理解成取消意图）。
 *
 * @param {object} input
 * @param {string} input.text 去掉 @bot 残留后的正文
 * @param {string} [input.chatPrefix] 强制闲聊前缀
 * @param {string} [input.taskPrefix] 强制任务前缀（配置项 tasks.prefix）
 * @param {boolean} [input.hasForward] 是否带合并转发段
 * @returns {{kind:string, reason:string, text:string}} text 是去掉前缀后的正文
 */
export function classifyMessage({ text, chatPrefix = '', taskPrefix = '', hasForward = false } = {}) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return { kind: CLASSIFY.IGNORE, reason: 'empty', text: '' }

  const tp = String(taskPrefix ?? '')
  if (tp && trimmed.startsWith(tp)) {
    // 只发了前缀（"/task"）时保留原文，避免把空串投给 session
    return { kind: CLASSIFY.TASK, reason: 'task-prefix', text: trimmed.slice(tp.length).trim() || trimmed }
  }

  const cp = String(chatPrefix ?? '')
  if (cp && trimmed.startsWith(cp)) {
    return { kind: CLASSIFY.CHAT, reason: 'chat-prefix', text: trimmed.slice(cp.length).trim() || trimmed }
  }

  // 带附件的消息不可能是寒暄：转发记录 + 一句话就是在派活
  if (hasForward) return { kind: CLASSIFY.TASK, reason: 'forward-attachment', text: trimmed }

  if (countChars(trimmed) < SHORT_MESSAGE_MAX_CHARS && looksLikeChitchat(trimmed)) {
    return { kind: CLASSIFY.CHAT, reason: 'short-chitchat', text: trimmed }
  }

  return { kind: CLASSIFY.TASK, reason: 'default', text: trimmed }
}

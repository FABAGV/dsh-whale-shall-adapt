/**
 * 持久化状态：QQ 会话 ↔ DSH 工作区 / 常驻会话的绑定关系。
 *
 * 用普通 JSON 文件而不是 storageDomain：可读、可手工修、便于排障，
 * 且这份映射本身就是用户会想去检查的东西。
 *
 *   chats[chatKey] = { workspace*, rootSessionId, rootGeneration, lastHandoff, ... }
 *
 * 每个 QQ 会话只有一台常驻会话，干活也在它里面做；旧版的任务台账（tasks、taskSeq、taskIds）已删，
 * 载入旧文件时直接丢掉这几个字段。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 会话 id 的合法形状：`private` / `group` + 纯数字（长度上限 12，够 QQ 号与群号用）。
 *
 * 与 `onebot/normalize.js` 里准入那道判据**同一条**：目录名是从这两个字段拼出来的
 * （`bridge.projectPathFor` → `mkdirSync`），所以它们不只是"数据"，还是路径的一部分。
 */
function isLegalChat(chatType, chatId) {
  return (chatType === 'private' || chatType === 'group') && /^\d{1,12}$/.test(String(chatId ?? ''))
}

/** 是不是"普通对象"（排除 null / 数组 / 原始值）—— 用于"合法 JSON 但结构不对"的判定 */
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 给日志用的类型名（array / number / null……），比 `typeof` 更好读 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const STATE_VERSION = 3

export class StateStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 状态目录，默认 $DSH_HOME/shall/qq
   * @param {ReturnType<import('../core/log.js').createLogger>} opts.log
   */
  constructor({ dir, log, bindings = null }) {
    this.log = log
    /** 会话绑定表（lib/conversation/bindings.js）：常驻会话一换就登记，权限分类先查它。 */
    this.bindings = bindings
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    this.dir = dir || path.join(home, 'shall', 'qq')
    this.file = path.join(this.dir, 'state.json')
    /** @type {{version:number, chats:Record<string, any>, updatedAt:number}} */
    this.data = { version: STATE_VERSION, chats: {}, updatedAt: 0 }
    this.#load()
  }

  #load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      this.log.warn(`[state] 无法创建状态目录 ${this.dir}: ${err.message}`)
    }
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        // ⚠️ 判据必须是**形状判断**，不能停在真值判断上：
        //    `chats: []`（数组）与 `chats: 5` 都能骗过 `parsed.chats` 真值检查 ——
        //    前者会把字符串键挂到数组上、`JSON.stringify` 恒为 `[]`（绑定静默丢失），
        //    后者在 `set()` 时抛 TypeError。两者都属"合法 JSON、结构不对"。
        const chatsOk = isPlainRecord(parsed?.chats)
        if (chatsOk) {
          this.data = {
            version: STATE_VERSION,
            chats: parsed.chats,
            updatedAt: parsed.updatedAt ?? 0,
          }
          this.#dropIllegalBindings()
          this.#migrate()
          this.log.info(
            `[state] 已载入 ${Object.keys(this.data.chats).length} 条会话绑定 (${this.file})`,
          )
        } else {
          // ⚠️ 合法 JSON 但结构不对（`[]`、`{}`、被截断成合法前缀、手改坏了）：
          //    早先这里**一行日志都不打**就静默跳过，而下一次任何 `save()`
          //    （比如下一条 QQ 消息）都会把原文件覆盖成空台账 ——
          //    会话绑定、rootSessionId / rootGeneration / lastHandoff
          //    全部蒸发，且没有留档、无从取证。
          this.#quarantine(`结构不对（chats 字段是 ${typeName(parsed?.chats)}，不是对象）`)
        }
      }
    } catch (err) {
      this.log.warn(`[state] 载入失败（将重新开始）: ${err.message}`)
      this.#quarantine(`解析失败: ${err.message}`)
    }
  }

  /**
   * 把坏掉的状态文件改名留档，**先于**任何 `save()`。
   *
   * 与 `memory.js` 的 `.bak` 同一姿态：宁可多留一个文件，也不要静默把用户的
   * 会话绑定抹掉。留档失败只记日志，不阻断启动。
   */
  #quarantine(reason) {
    try {
      const bak = `${this.file}.corrupt-${Date.now()}`
      fs.renameSync(this.file, bak)
      this.log.warn(
        `[state] 状态文件已留档为 ${bak}（${reason}）—— 绑定不会自动恢复，请人工检查后再删`,
      )
    } catch (err) {
      this.log.warn(`[state] 坏文件留档失败（原文件可能被下次写入覆盖）: ${err?.message ?? err}`)
    }
  }

  /**
   * 丢掉 id 不合法的会话绑定（纯数字判据见 `isLegalChat`）。
   *
   * ⚠️ 为什么必须在**载入时**做，而不是只在入口拦：工作区目录名是从这两个字段拼出来的
   *    （`bridge.projectPathFor` → `fs.mkdirSync`）。如果 `state.json` 里已经带着
   *    `group:..\..\..\x` 这种 key（旧版本被注入过、或手改坏了），**升级并不会把它清掉** ——
   *    那条绑定照样能建出 workspaceRoot 之外的目录。这是"升级不治旧伤"的典型，
   *    所以载入即复检、就地丢弃，并留下一条能解释现场的日志。
   */
  #dropIllegalBindings() {
    let droppedChats = 0
    for (const key of Object.keys(this.data.chats)) {
      const [chatType, ...rest] = key.split(':')
      if (!isLegalChat(chatType, rest.join(':'))) {
        delete this.data.chats[key]
        droppedChats += 1
      }
    }
    if (droppedChats > 0) {
      this.log.warn(
        `[state] 丢弃 ${droppedChats} 条非法会话绑定` +
          `（chatId 不是纯数字 —— 它们不能用来拼工作区目录）`,
      )
    }
  }

  /**
   * v1 → v2 → v3 的迁移。
   *
   * v1 的 chats[key].sessionId 就是唯一的常驻会话，直接认成 rootSessionId。
   * v3 新增 `rootGeneration`（第几代会话）与 `lastHandoff`（上次交班台账），
   * 老绑定补默认值即可，**不丢任何东西**。
   */
  #migrate() {
    let migrated = 0
    let upgraded = 0
    for (const [key, chat] of Object.entries(this.data.chats)) {
      if (!chat || typeof chat !== 'object') continue
      if (chat.rootSessionId === undefined && chat.sessionId) {
        chat.rootSessionId = chat.sessionId
        migrated += 1
      }
      for (const legacy of ['taskIds', 'tasks', 'lastTaskAt']) delete chat[legacy]
      delete chat.sessionId
      // v2 → v3：代数是 1 起步（第 1 代就是最初那个常驻会话）
      if (!Number.isInteger(chat.rootGeneration) || chat.rootGeneration < 1) {
        chat.rootGeneration = 1
        upgraded += 1
      }
      if (chat.lastHandoff === undefined) chat.lastHandoff = null
      if (chat.handoffPending === undefined) chat.handoffPending = null
    }
    if (migrated > 0) {
      this.log.info(`[state] 已把 ${migrated} 条 v1 会话绑定迁移为 rootSessionId`)
      this.save()
    }
    if (upgraded > 0) {
      this.log.info(`[state] 已给 ${upgraded} 条会话绑定补上 rootGeneration=1（v3）`)
      this.save()
    }
  }

  /** 落盘。失败不抛出 —— 状态丢失不应打断任务执行 */
  save() {
    try {
      this.data.updatedAt = Date.now()
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      this.log.warn(`[state] 落盘失败: ${err.message}`)
    }
  }

  /** @param {'private'|'group'} chatType @param {string} chatId */
  static key(chatType, chatId) {
    return `${chatType}:${chatId}`
  }

  // ── 会话绑定 ─────────────────────────────────────────────────────────

  get(chatType, chatId) {
    return this.data.chats[StateStore.key(chatType, chatId)]
  }

  set(chatType, chatId, value) {
    this.data.chats[StateStore.key(chatType, chatId)] = value
    this.save()
  }

  remove(chatType, chatId) {
    delete this.data.chats[StateStore.key(chatType, chatId)]
    this.save()
  }

  entries() {
    return Object.entries(this.data.chats)
  }

  /** 记录/更新常驻会话 id */
  setRootSession(chatType, chatId, sessionId) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.rootSessionId = sessionId
    this.save()
    if (this.bindings) {
      if (sessionId) this.bindings.bind(chatType, chatId, sessionId, { generation: chat.rootGeneration })
      else this.bindings.retireCurrent(chatType, chatId)
    }
    return chat
  }

  // ── 交班台账 ─────────────────────────────────────────────────────────

  /**
   * 记一次交班。
   *
   * `from` 字段是特意留的：进程在"切换映射之后、归档之前"崩掉时，
   * 启动时可以靠它做一次幂等补归档（旧会话可能没归档成功，会留在侧边栏）。
   *
   * @param {'private'|'group'} chatType
   * @param {string} chatId
   * @param {object} entry
   */
  recordHandoff(chatType, chatId, entry) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.rootGeneration = Number(entry?.gen ?? (chat.rootGeneration ?? 1) + 1)
    chat.lastHandoff = { ...entry, at: Number(entry?.at ?? Date.now()) }
    // 交班走完了：把"进行中"的标记清掉（崩溃恢复只看它）
    chat.handoffPending = null
    // 只留最近 10 次，防止 chats 记录无限膨胀（完整交接束在 handoff/ 目录里）
    const history = Array.isArray(chat.handoffHistory) ? chat.handoffHistory : []
    history.unshift(chat.lastHandoff)
    chat.handoffHistory = history.slice(0, 10)
    if (this.bindings && chat.rootSessionId) this.bindings.bind(chatType, chatId, chat.rootSessionId, { generation: chat.rootGeneration })
    this.save()
    return chat
  }

  /**
   * 标记"这个会话正在交班：旧会话 `from` 已归档，映射还没切"。
   *
   * ## 为什么必须落盘（这是交班唯一会造成**静默丢消息**的残留）
   *
   * 交班的顺序是"先归档旧会话 → 建新会话 → 切映射"。进程若在**归档之后、
   * 切映射之前**挂掉，`state.json` 里的 `rootSessionId` 仍然指着那台
   * **已经归档**的会话。归档不报错、不通知，`ArchivedSessionGate` 只会在下一步
   * 静默 reject —— 于是用户下一条消息投进去之后**什么都不发生**，
   * 而且看不出任何异常（`lib/dsh/handoff.js` 的 DeliveryGate 注释里说的同一类故障）。
   *
   * 所以归档之后立刻把"我在交班、from 是谁"写一次盘，收尾时（`recordHandoff`）清掉；
   * 启动时若发现残留且映射还指着 `from`，就按"上次没走完"处理（见 `pendingHandoffRecoveries`）。
   */
  markHandoffPending(chatType, chatId, info) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.handoffPending = {
      from: String(info?.from ?? ''),
      gen: Number(info?.gen ?? 0),
      at: Number(info?.at ?? Date.now()),
    }
    this.save()
    return chat.handoffPending
  }

  /**
   * 上次没走完的交班（崩溃残留）：映射还指着已经归档的旧会话。
   *
   * 只报"可以确定已经坏了"的那些：`rootSessionId === handoffPending.from`。
   * 映射已经切到新会话、只是没来得及清标记的，不算（那种情况一切正常）。
   *
   * @returns {Array<{key:string, chatType:string, chatId:string, sessionId:string, gen:number, at:number}>}
   */
  pendingHandoffRecoveries() {
    const out = []
    for (const [key, chat] of Object.entries(this.data.chats)) {
      const pending = chat?.handoffPending
      if (!pending?.from) continue
      if (chat.rootSessionId !== pending.from) continue
      const [chatType, ...rest] = key.split(':')
      out.push({
        key,
        chatType,
        chatId: rest.join(':'),
        sessionId: String(pending.from),
        gen: Number(pending.gen ?? 0),
        at: Number(pending.at ?? 0),
      })
    }
    return out
  }

  /** 清掉交班进行中的标记（恢复动作做完之后调用） */
  clearHandoffPending(chatType, chatId) {
    const chat = this.get(chatType, chatId)
    if (!chat) return null
    chat.handoffPending = null
    this.save()
    return chat
  }

  /** 上次交班记下的、需要补归档的旧会话 id（没有则空数组） */
  pendingArchiveRepairs() {
    const out = []
    for (const [key, chat] of Object.entries(this.data.chats)) {
      if (!chat?.lastHandoff) continue
      const { from, archiveFailed } = chat.lastHandoff
      if (archiveFailed && from && from !== chat.rootSessionId) {
        out.push({ key, chatType: chat.chatType, chatId: chat.chatId, sessionId: from })
      }
    }
    return out
  }

  /** 反向查找：某个 session 属于哪个 QQ 会话（进度回传要用） */
  findBySession(sessionId) {
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (!value) continue
      if (value.rootSessionId === sessionId) {
        const [chatType, ...rest] = key.split(':')
        return { chatType, chatId: rest.join(':'), kind: 'root', sessionId, ...value }
      }
    }
    return null
  }

  snapshot() {
    return {
      file: this.file,
      dir: this.dir,
      count: Object.keys(this.data.chats).length,
      updatedAt: this.data.updatedAt,
      chats: this.data.chats,
    }
  }
}

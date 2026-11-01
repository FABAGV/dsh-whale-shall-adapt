/**
 * 宿主侧持久化。
 *
 * 落点与 dsh-qq / dsh-whale-widget 的约定一致：
 * `$DSH_HOME/<plugin>/`，其中 `DSH_HOME` 优先取环境变量，否则 `~/.dsh`。
 * 本插件的目录是 `$DSH_HOME/shall/adapt/`。
 *
 * ## 目录内容
 *
 *   state.json        用户数据 + 画像 + 上次生成水位（**UI 侧读写的唯一文件**）
 *   cursor.json       会话日志的帧偏移水位（每个文件已解压到第几字节）
 *   plain/<sha1>.jsonl 已解压的会话明文缓存（保证每帧只解一次）
 *   profile-history/  每次生成的画像快照，只增不删（便于回看"画像怎么变的"）
 *   plugin.log        日志镜像（桌面端 stdout 是 Electron 空管，看不到）
 *
 * ## 写盘的原子性
 *
 * `writeFileSync(tmp)` + `renameSync(tmp, target)`。rename 在同一分区上是原子的，
 * 所以进程在写一半时被杀不会留下半个 JSON —— 只会留下一个 tmp 文件。
 * （与 dsh-qq/lib/dsh/state.js:170-171 相同的做法。）
 *
 * ## 模式互斥是怎么落实的
 *
 * `mode` 只能是 `'auto'` 或 `'custom'`，**单字段枚举**而不是两个布尔量。
 * 用两个布尔量（`autoEnabled` / `customEnabled`）在结构上就允许"两个都 true"，
 * 需要靠每次读的时候额外断言去兜。单字段枚举让"同时开启"这种状态
 * **根本无法表示** —— 这是硬规则，用类型而不是用检查来保证。
 *
 * `effectiveText()` 是"当前生效画像文本"的**唯一**产出点：模式 1 给画像文本，
 * 模式 2 给用户手写文本，两者不会同时出现。
 *
 * 它有两个出口，**不要混用**：
 *   - `effective()`            全文。UI 预览、复制到模式 2、复制快照都用它。
 *   - `effectiveForInjection()` 注入系统提示用；模式 1 下画像部分按 token
 *     预算裁剪（超预算的条目只在**注入侧**省略，画像本身不删）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { appendLogLine } from '../core/log.js'
import { writeJsonAtomic } from '../core/fs-atomic.js'

export const STATE_VERSION = 1

/** 工作笔记上限：项目/工具类事实只存最近这些条，不参与画像槽位预算。 */
export const WORKING_NOTES_CAP = 50

/** 两个互斥的模式：自动画像（auto）和用户自己写的文本（custom）。 */
export const MODE = {
  /** 模式 1：自动画像（LLM 归纳，用户只读） */
  AUTO: 'auto',
  /** 模式 2：自定义（用户手写的系统提示词） */
  CUSTOM: 'custom',
}

/**
 * 解析 DSH 主目录。与 dsh-qq 完全相同：环境变量优先，否则 `~/.dsh`。
 * @returns {string}
 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 空白状态。
 * @returns {object}
 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    mode: MODE.AUTO,

    /** 模式 2 的文本（用户手写）。切到模式 1 时**不清空**，切回来还在。 */
    customText: '',

    /** 模式 1 的画像。`null` 表示还没生成过。 */
    profile: null,

    /** 模式 1 生效时附加在画像后面的补充说明（可为空）。 */
    autoExtraText: '',

    /** 一次性迁移标记：把旧画像里 3 条"本插件设计需求"移到工作笔记，只跑一次。 */
    workingNotesMigrated: false,

    /** 上次"复制画像文本"时的快照，用来告诉用户"你复制之后画像又变了"。 */
    copiedSnapshot: {
      /** 复制时的生效文本。`null` = 从没复制过。 */
      text: null,
      at: null,
      /** 复制时的画像版本号。 */
      profileVersion: null,
    },

    /** 上次成功生成画像时的水位，用于算"累计新增"。 */
    lastGeneration: {
      at: null,
      humanMessages: 0,
      sessions: 0,
      /**
       * 这一版材料的时间上界（最近一条真人发言的时间戳）。
       * 触发判据只数它之后的新增；缺省 0 = 还没生成过 / 旧 state，第一次按全量算。
       */
      materialCutoff: 0,
    },

    /** 最近一次四个信号的汇总（每次扫描后刷新）。 */
    lastSignals: null,

    /** 最近一次生成的状态，给 UI 显示"为什么没更新"。 */
    lastRun: {
      at: null,
      ok: null,
      reason: '',
      error: null,
      spuriousRate: null,
      diff: null,
      /**
       * 最近一次生成用的材料预算 `{ chars, kept, dropped, total }`（超上限被裁掉多少）。
       *
       * 这里给 `null` 只是**形状**占位（`/state` 是界面契约，字段位从一开始就得在，
       * 否则界面按 `lastRun.material.dropped` 读会炸）。真实值由
       * index.js 的 `runProfileGeneration()` 在成功与失败两条路径都写入 ——
       * 那一侧的原则是"静默省略最糟"：材料被裁过就必须看得见。
       */
      material: null,
    },

    /**
     * 连续多少轮生成是 0 变更（新增 + 删除 + 改写 = 0）。
     *
     * 只用于自动生成的**饱和守卫**：画像超过软上限、且连续两轮零变更时，
     * 再跑一次也不会改变任何东西，暂停自动生成；等用户删除/封印后由
     * markEntry/clearMark 清零再重试。手动“重新生成”（force）不受限。
     */
    zeroChangeStreak: 0,

    updatedAt: 0,
  }
}

/**
 * 合并工作笔记：按 text 去重、单条 4–300 字、最多 `WORKING_NOTES_CAP` 条。
 * 返回新增条数；已有笔记原样保留（不重排、不改写）。
 *
 * @param {object} state
 * @param {string[]} notes
 * @param {number} [now]
 * @returns {number}
 */
export function appendWorkingNotes(state, notes, now = Date.now()) {
  if (!state || typeof state !== 'object') return 0
  if (!Array.isArray(state.workingNotes)) state.workingNotes = []
  const seen = new Set()
  for (const note of state.workingNotes) {
    const text = typeof note === 'string' ? note : note?.text
    if (typeof text === 'string') seen.add(text)
  }
  let added = 0
  for (const raw of Array.isArray(notes) ? notes : []) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text.length < 4 || text.length > 300 || seen.has(text)) continue
    state.workingNotes.push({ text, at: now })
    seen.add(text)
    added += 1
  }
  if (state.workingNotes.length > WORKING_NOTES_CAP) {
    state.workingNotes = state.workingNotes.slice(-WORKING_NOTES_CAP)
  }
  return added
}

/**
 * 一次性迁移：把旧画像里**本插件设计需求**那几条移到工作笔记。
 *
 * 只匹配 3 条铁证（"模式 1/2 同时生效"、"画像文本无上限"、"画像归纳器"），
 * 不用宽泛的项目关键词 —— "改动本机配置/插件"、"更新工具链"这类是通用的
 * 安全纪律，误移会丢规则。迁移是可逆的：文本进了 workingNotes，没有删。
 *
 * @param {object} state
 * @param {number} [now]
 * @returns {number} 迁移条数
 */
export function migrateProjectEntries(state, now = Date.now()) {
  if (!state || state.workingNotesMigrated === true) return 0
  const entries = Array.isArray(state.profile?.entries) ? state.profile.entries : []
  if (entries.length === 0) {
    // 还没有画像（新装）就没有旧数据可迁：直接置位。否则首版画像生成后的下一次启动，
    // 提到"模式 1/2""画像文本"的新条目会被当成旧的设计需求移走。
    state.workingNotesMigrated = true
    return 0
  }
  const matched = entries.filter(
    entry => typeof entry?.claim === 'string' && /模式\s*[12]|画像文本|画像归纳器/.test(entry.claim),
  )
  if (matched.length > 0) {
    appendWorkingNotes(state, matched.map(entry => entry.claim), now)
    const removed = new Set(matched)
    state.profile.entries = entries.filter(entry => !removed.has(entry))
  }
  state.workingNotesMigrated = true
  return matched.length
}

/** 极简文件日志：桌面端 stdout 不可见，必须同时落盘。 */
export function createLogger(name, level, file) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 }
  const threshold = levels[level] ?? 20
  const write = (lvl, args) => {
    if ((levels[lvl] ?? 20) < threshold) return
    const line = `${new Date().toISOString()} [${lvl}] ${name}: ${args
      .map(value => (typeof value === 'string' ? value : safeStringify(value)))
      .join(' ')}`
    console[lvl === 'debug' ? 'log' : lvl]?.(line)
    // 和 QQ 侧共用一个写入口：同样超过 2 MB 轮转成 .1，写失败不影响功能
    if (file) appendLogLine(file, line)
  }
  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 状态仓库。
 */
export class StateStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 状态目录，默认 `$DSH_HOME/shall/adapt`
   * @param {ReturnType<typeof createLogger>} opts.log
   */
  constructor({ dir, log }) {
    this.log = log
    this.dir = dir || path.join(resolveDshHome(), 'shall')
    this.stateFile = path.join(this.dir, 'state.json')
    this.cursorFile = path.join(this.dir, 'cursor.json')
    this.plainDir = path.join(this.dir, 'plain')
    this.historyDir = path.join(this.dir, 'profile-history')
    this.logFile = path.join(this.dir, 'plugin.log')
    this.state = emptyState()
    this.cursor = { version: 1, files: {} }
    this.#ensureDirs()
    this.#loadState()
    this.#loadCursor()
  }

  #ensureDirs() {
    for (const dir of [this.dir, this.plainDir, this.historyDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (error) {
        this.log?.warn(`[state] 无法创建目录 ${dir}: ${error?.message ?? error}`)
      }
    }
  }

  #loadState() {
    if (!fs.existsSync(this.stateFile)) return
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch (error) {
      // 读不动 / 解析不出来（半个 JSON、被清空、被另一个进程占住）时**不能就这么算了**：
      // 下一次 saveState() 会把这份文件整个覆盖掉，用户的 customText 与画像就没了。
      // 先原样挪到同目录留档，用户还能人工把内容抢救回去。
      const kept = this.#quarantineStateFile()
      this.log?.warn(
        `[state] 载入失败（将重新开始）: ${error?.message ?? error}` +
          (kept ? `；原文件已留档为 ${kept}` : '；⚠️ 原文件留档失败，下一次写盘会覆盖它'),
      )
      return
    }
    try {
      if (!parsed || typeof parsed !== 'object') return
      const base = emptyState()
      this.state = {
        ...base,
        ...parsed,
        // 逐层兜底，避免半旧的文件留下 undefined 字段
        copiedSnapshot: { ...base.copiedSnapshot, ...(parsed.copiedSnapshot ?? {}) },
        lastGeneration: { ...base.lastGeneration, ...(parsed.lastGeneration ?? {}) },
        lastRun: { ...base.lastRun, ...(parsed.lastRun ?? {}) },
      }
      // 模式值兜底：非法值一律退回自动画像，绝不出现"两个都开"的状态
      if (this.state.mode !== MODE.AUTO && this.state.mode !== MODE.CUSTOM) {
        this.log?.warn(`[state] mode 取值非法（${parsed.mode}），已退回 ${MODE.AUTO}`)
        this.state.mode = MODE.AUTO
      }
      // 字段类型兜底：`effective()` 会对这两个字段调 `.trim()`，非字符串会让**每一次**
      // GET /state 变成 500（设置页显示"未连接宿主"），用户连看到状态、动手修的机会都没有。
      for (const field of ['customText', 'autoExtraText']) {
        if (typeof this.state[field] !== 'string') {
          this.log?.warn(`[state] ${field} 不是字符串（${typeof this.state[field]}），已按空文本处理`)
          this.state[field] = ''
        }
      }
      // 饱和守卫的计数器：旧 state 没有这个字段（base 会给 0），手改坏时兜成 0。
      if (!Number.isFinite(this.state.zeroChangeStreak) || this.state.zeroChangeStreak < 0) {
        this.state.zeroChangeStreak = 0
      }
      if (typeof this.state.workingNotesMigrated !== 'boolean') {
        this.state.workingNotesMigrated = false
      }
      this.log?.info(
        `[state] 已载入 mode=${this.state.mode} 画像条目=${
          this.state.profile?.entries?.length ?? 0
        } 自定义文本=${this.state.customText?.length ?? 0} 字`,
      )
    } catch (error) {
      this.log?.warn(`[state] 载入失败（将重新开始）: ${error?.message ?? error}`)
    }
  }

  /**
   * 把读不动的 `state.json` 原样挪到同目录留档，返回留档路径。
   *
   * 挪不动（权限 / 被占用）时返回 `null`：那种情况下只能靠日志告诉用户
   * "它将被下一次写盘覆盖"。**只对 state.json 做这件事** ——
   * `cursor.json` 是派生数据（坏了只是从零全量重扫），`plain/` 可以重新解压，
   * 都没有"用户数据被覆盖掉就回不来"的问题。
   *
   * @returns {string|null}
   */
  #quarantineStateFile() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const kept = `${this.stateFile}.corrupt-${stamp}`
    try {
      fs.renameSync(this.stateFile, kept)
      return kept
    } catch (error) {
      this.log?.warn(`[state] 留档失败: ${error?.message ?? error}`)
      return null
    }
  }

  #loadCursor() {
    try {
      if (!fs.existsSync(this.cursorFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.files) {
        /**
         * ⚠️ `rotor`（帧预算的轮转起点，见 `lib/sessions.js` 的"位置性饥饿"）必须
         * 一起读回来：它由 `scan()` 写在 `cursor` 上、由这里落盘，漏掉它就是
         * "写进去但读不回来" —— 轮转相位每次重启都归零，冷启动后要重新一轮轮前移
         * （正确性不受影响，因为 `rotateFrom()` 找不到那个 rel 时会退回表头，
         * 但"排在后面的文件"会重新挨饿）。
         */
        this.cursor = { version: parsed.version ?? 1, files: parsed.files, rotor: parsed.rotor ?? null }
        this.log?.info(`[cursor] 已载入 ${Object.keys(this.cursor.files).length} 个文件的帧水位`)
      }
    } catch (error) {
      this.log?.warn(`[cursor] 载入失败（将从零全量扫描）: ${error?.message ?? error}`)
    }
  }

  /**
   * 原子写：临时文件名带 pid + 随机串、写完 fsync 再 rename，统一走 core/fs-atomic.js。
   *
   * ⚠️ 临时文件名**必须**带 pid 和随机串。同一台机器上可能同时跑着两个宿主进程、共用同一个
   * `DSH_HOME`（桌面端 + CLI/QQ 宿主），固定叫 `${file}.tmp` 时两个进程会 rename
   * 到**对方正在写**的那个临时文件上：先 rename 的那个把对方那份**写到一半**的
   * 文件发布成了正式文件 —— 对方若在同一瞬间被中断（进程被杀 / 断电），
   * state.json 就永久停在半个 JSON 上；即使对方没被中断，后 rename 的那个也会
   * 拿到 ENOENT（`saveState` 只记一条 warn，这一次写盘静默丢失）。
   * 只带 pid 挡得住跨进程，挡不住同进程内两次写盘交错（定时器 + 控制台请求），所以还要随机串。
   */
  #writeJson(file, value) {
    writeJsonAtomic(file, value)
  }

  saveState() {
    try {
      this.state.updatedAt = Date.now()
      this.#writeJson(this.stateFile, this.state)
    } catch (error) {
      this.log?.warn(`[state] 保存失败: ${error?.message ?? error}`)
    }
  }

  saveCursor() {
    try {
      this.#writeJson(this.cursorFile, this.cursor)
    } catch (error) {
      this.log?.warn(`[cursor] 保存失败: ${error?.message ?? error}`)
    }
  }

  /**
   * 「当前生效画像文本」的**唯一**产出点。
   *
   * 硬规则：模式 1 与模式 2 不能同时开启 —— 由 `mode` 单字段枚举保证，
   * 这个函数是它唯一的读取出口。
   *
   * ⚠️ 这里是**全文**：UI 的 `getState().effectiveText`、复制快照
   * （`markCopied`）、以及「从模式 1 填入」都读它，所以它绝不能裁剪。
   * 注入系统提示请用 `effectiveForInjection()`。
   *
   * @returns {{mode:string, text:string, source:string}}
   */
  effective() {
    const mode = this.state.mode === MODE.CUSTOM ? MODE.CUSTOM : MODE.AUTO
    if (mode === MODE.CUSTOM) {
      const text = (this.state.customText ?? '').trim()
      return { mode, text, source: 'customText' }
    }
    // 动态 import 会破坏"每步求值必须同步且极快"的要求，
    // 所以渲染函数由 index.js 注册进来（见 setProfileRenderer）。
    const rendered = this.#renderProfile()
    const extra = (this.state.autoExtraText ?? '').trim()
    const text = [rendered, extra].filter(Boolean).join('\n\n').trim()
    return { mode, text, source: 'profile' }
  }

  /**
   * 「注入系统提示」用的生效文本。
   *
   * 与 `effective()` **只差一处**：模式 1 下画像部分按 token 预算裁剪
   * （渲染函数是 `setInjectionRenderer` 注册的那个）。
   * 模式 2 是用户手写的文本，按原样注入，不裁剪 —— 那是用户明确要注入的内容。
   *
   * 裁剪只发生在这里：`state.profile` 里仍是完整画像，`effective()` 仍是全文，
   * 所以 `state.json`、界面、复制、`diffProfiles()` 都不受影响。
   *
   * @returns {{mode:string, text:string, source:string}}
   */
  effectiveForInjection() {
    const mode = this.state.mode === MODE.CUSTOM ? MODE.CUSTOM : MODE.AUTO
    if (mode === MODE.CUSTOM) return this.effective()
    const rendered = this.#renderProfileForInjection()
    const extra = (this.state.autoExtraText ?? '').trim()
    const text = [rendered, extra].filter(Boolean).join('\n\n').trim()
    return { mode, text, source: 'profile' }
  }

  /** @type {null | ((profile:object|null)=>string)} */
  #profileRenderer = null

  /**
   * 注入专用的渲染函数（**带 token 预算**，由 `lib/index.js` 注册）。
   *
   * ⚠️ 与 `#profileRenderer` 分开是硬要求，不是洁癖：
   * `effective()` 的产出是「用户复制到模式 2 的**全文**」，
   * 它绝不能是被预算裁剪过的注入版 —— 两条路径共用一个渲染器时，
   * 用户一复制就会拿到残缺的画像，而界面上显示的还是完整的那份。
   */
  /** @type {null | ((profile:object|null)=>string)} */
  #injectionRenderer = null

  setProfileRenderer(fn) {
    this.#profileRenderer = fn
  }

  /**
   * 注册注入用的渲染函数（按预算裁剪）。
   *
   * 没有注册时注入侧**什么都不注入**（fail-closed）：宁可这一步没有画像，
   * 也不要退回"全量注入"那条无上限的老路（本函数存在的理由就是它）。
   */
  setInjectionRenderer(fn) {
    this.#injectionRenderer = fn
  }

  #renderProfile() {
    if (!this.#profileRenderer) return ''
    try {
      return this.#profileRenderer(this.state.profile)
    } catch (error) {
      // 画像形状不是渲染器预期的样子（外部改过 state.json、旧版本残留）时，
      // **绝不能让 effective() 抛**：`getState()` 读它，抛了就是每一次 GET /state 都 500,
      // 设置页只会显示"未连接宿主"，用户连看到状态、动手修的机会都没有。
      // 这里只把**生效文本**当作空；`state.profile` 原样留在状态里（GET /state 仍能看到）。
      this.log?.warn(`[state] 画像渲染失败（本次按空画像处理）: ${error?.message ?? error}`)
      return ''
    }
  }

  #renderProfileForInjection() {
    if (!this.#injectionRenderer) return ''
    return this.#injectionRenderer(this.state.profile)
  }

  /** 把画像快照写进 `profile-history/`，只增不删。 */
  archiveProfile(profile, diff) {
    try {
      const stamp = new Date(profile.generatedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-')
      const file = path.join(this.historyDir, `v${profile.version}-${stamp}.json`)
      this.#writeJson(file, { profile, diff })
      return file
    } catch (error) {
      this.log?.warn(`[state] 画像归档失败: ${error?.message ?? error}`)
      return null
    }
  }
}

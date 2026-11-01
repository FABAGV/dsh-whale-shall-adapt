/**
 * 反向 WebSocket 服务端：NapCat 作为客户端连进来。
 *
 * 之所以用反向 WS：用户不需要公网、不需要端口映射，装完即可用。
 * NapCat 侧配置见 <NapCat 安装目录>\napcat\config\onebot11.json
 * 每 5000ms 重连一次，所以插件随起随连，不需要 NapCat 重启。
 */
import { WebSocketServer } from 'ws'
import { createHash, timingSafeEqual } from 'node:crypto'
import { OneBotConnection } from './connection.js'

/**
 * 常量时间比较 token：先各自做一次 SHA-256 再比（长度不同也能安全比，不泄露长度）。
 * 直接 `a !== b` 会因为提前返回而暴露"前缀对了几位"。
 */
function tokensMatch(got, expected) {
  if (!got || !expected) return false
  const a = createHash('sha256').update(String(got)).digest()
  const b = createHash('sha256').update(String(expected)).digest()
  return timingSafeEqual(a, b)
}

/** 最后一条连接断开后，等这么久还没连回来才告警（NapCat 正常重连只要 5 秒） */
const OFFLINE_WARN_AFTER_MS = 60_000
/** 一直连不回来时，隔多久再提醒一次 */
const OFFLINE_REPEAT_MS = 30 * 60_000

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
}

/**
 * 解析 `Authorization: Bearer xxx` 之外，OneBot 反向上报还会带 `X-Self-ID` 与 `X-Client-Role`。
 * @param {import('node:http').IncomingMessage} req
 */
function readHandshake(req) {
  const auth = req.headers['authorization'] ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(String(auth))?.[1]?.trim() ?? ''
  return {
    token: bearer,
    selfId: String(req.headers['x-self-id'] ?? '').trim(),
    role: String(req.headers['x-client-role'] ?? '').trim() || 'Universal',
  }
}

export class OneBotReverseServer {
  /**
   * @param {object} opts
   * @param {string} opts.path
   * @param {() => string} opts.getToken 读取期望的 access token；返回空字符串表示不校验。
   *   用函数而非值，是因为 token 可能在插件启动后才从 DSH 凭据里异步载入。
   * @param {ReturnType<import('../../core/log.js').createLogger>} opts.log
   * @param {(payload: any, conn: OneBotConnection) => void} opts.onEvent
   * @param {number} [opts.callTimeoutMs] 单次动作调用的等待上限，透传给每条连接。
   *   不传则用 `OneBotConnection` 的默认值（15000）。
   */
  constructor({ path, getToken, isAuthReady, log, onEvent, callTimeoutMs, offlineWarnAfterMs, offlineRepeatMs, allowNoToken }) {
    this.path = path
    this.getToken = typeof getToken === 'function' ? getToken : () => ''
    /** 鉴权信息是否已解析完成；未就绪时一律拒绝（fail-closed） */
    this.isAuthReady = typeof isAuthReady === 'function' ? isAuthReady : () => true
    this.log = log
    this.onEvent = onEvent
    /**
     * ⚠️ 这个值必须由 `index.js` 从 `connection.callTimeoutMs` 传进来 ——
     *    早先没接线，于是设置页改它永远是无效的（连接层硬编码 15000）。
     */
    this.callTimeoutMs = callTimeoutMs
    /** 没有 token 时是否仍放行（默认否；配置 connection.allowNoToken 才打开） */
    this.allowNoToken = allowNoToken === true
    // 单条消息上限 8 MB：正常文本远小于它，挡掉的是恶意/失控的大包把内存打满
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
    /** @type {Set<OneBotConnection>} */
    this.connections = new Set()
    this.rejectedAuth = 0
    this.rejectedNotReady = 0
    /** 因为"根本没配 token"被拒的次数（和 token 不匹配分开计） */
    this.rejectedNoToken = 0
    this.rejectedPath = 0
    /** 因为握手带了 `Origin`（浏览器页面）而被拒的次数 */
    this.rejectedOrigin = 0
    this.totalAccepted = 0
    /**
     * 最后一条连接断开的时刻；有连接时为 null。
     * NapCat 重启后常卡在扫码登录（日志里是 `Login Error ... ErrCode: 3`），这时它不会连回来，
     * 插件这一侧只看得到"剩余连接数=0"这一行 info，没人会注意到。
     */
    this.offlineSince = null
    this.lastConnectedAt = null
    this.offlineWarnAfterMs = offlineWarnAfterMs ?? OFFLINE_WARN_AFTER_MS
    this.offlineRepeatMs = offlineRepeatMs ?? OFFLINE_REPEAT_MS
    this.offlineTimer = null
  }

  #armOfflineWatch(delayMs) {
    this.#clearOfflineWatch()
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null
      if (this.offlineSince === null || this.connections.size > 0) return
      this.log.warn(
        `[onebot] NapCat 已断开 ${formatDuration(Date.now() - this.offlineSince)} 仍未重连：` +
          'QQ 消息收不到也发不出。先看 NapCat 窗口/日志是否已登录（重启后常卡在扫码，日志里是 Login Error），' +
          '再看它的 websocketClients 地址和 token 是否与插件一致',
      )
      this.#armOfflineWatch(this.offlineRepeatMs)
    }, delayMs)
    if (typeof this.offlineTimer.unref === 'function') this.offlineTimer.unref()
  }

  #clearOfflineWatch() {
    if (this.offlineTimer) clearTimeout(this.offlineTimer)
    this.offlineTimer = null
  }

  /** 判断这条 upgrade 请求是不是我们要接的 */
  matches(req) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.pathname === this.path
    } catch {
      return false
    }
  }

  /**
   * 由 `ctx.webServer.registerUpgrade` 的回调直接调用。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    // ⚠️ 反向上报**不该带 `Origin`**：带它的基本都是浏览器页面发起的 WebSocket。
    //    浏览器页面能连本机端口，而这条通道的尽头是本机 agent（有文件/shell 能力），
    //    所以直接拒掉。NapCat 等 OneBot 实现作为普通 WS 客户端不会带这个头
    //    （`ws` 客户端默认也不加，只有显式传 origin 才有）。
    if (req.headers.origin) {
      this.rejectedOrigin += 1
      this.log.warn(`[onebot] 拒绝连接：握手带了 Origin=${req.headers.origin}（反向上报不该有）`)
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // 鉴权信息尚未解析完成时必须 fail-closed。
    // 背景：token 可能来自 DSH 凭据，而凭据解析是异步的 —— 若此时按「expected 为空
    // 即不校验」处理，凭据-only 部署的首个连接会被放行，形成 fail-open 窗口。
    // NapCat 每 5 秒重连一次，所以直接拒绝并让它重试是安全且无感的。
    if (!this.isAuthReady()) {
      this.rejectedNotReady += 1
      this.log.warn('[onebot] 拒绝连接：鉴权信息尚未就绪（凭据仍在解析），请稍后重试')
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const hs = readHandshake(req)
    const expected = this.getToken() ?? ''

    /**
     * 没有任何 token 时**拒绝**（除非用户在配置里显式打开 `connection.allowNoToken`）。
     *
     * 这条通道的尽头是本机 agent：连上来就能伪造"主人私聊"事件（user_id 填主人 QQ 即可套出
     * owner 画像、以主人身份派活），还能收走 bot 发出的所有消息。以前 `expected` 为空就放行，
     * 默认配置（token 留空）等于对本机任何进程敞开。
     */
    if (!expected) {
      if (this.allowNoToken) {
        this.log.warn('[onebot] 没有配置 access token，按配置放行（connection.allowNoToken=true）：本机任何进程都能接入')
      } else {
        this.rejectedNoToken += 1
        this.log.warn(
          '[onebot] 拒绝连接：没有配置 access token。在 DSH 凭据里设置 SHALL_ONEBOT_TOKEN（推荐），' +
            '或在插件配置里填 qq.connection.token，并让 NapCat 的 websocketClients 用同一个 token；' +
            '只在本机调试时才把 connection.allowNoToken 打开',
        )
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    } else if (!tokensMatch(hs.token, expected)) {
      this.rejectedAuth += 1
      // 不打印收到的 token（哪怕前几位）：日志会被复制粘贴到公开 issue 里
      this.log.warn(`[onebot] 拒绝连接：token 不匹配（${hs.token ? '收到的是另一个 token' : '没带 token'}）`)
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.totalAccepted += 1
      const conn = new OneBotConnection({
        socket: ws,
        log: this.log,
        selfId: hs.selfId,
        role: hs.role,
        // 来自 connection.callTimeoutMs；undefined 时由构造函数落入默认值
        callTimeoutMs: this.callTimeoutMs,
      })
      this.connections.add(conn)
      const gap = this.offlineSince !== null ? Date.now() - this.offlineSince : null
      this.offlineSince = null
      this.lastConnectedAt = Date.now()
      this.#clearOfflineWatch()
      this.log.info(
        `[onebot] NapCat 已连接 selfId=${hs.selfId || '未知'} role=${hs.role} 当前连接数=${this.connections.size}` +
          (gap !== null ? `（中断了 ${formatDuration(gap)}）` : ''),
      )

      conn.on('event', (payload) => {
        try {
          this.onEvent(payload, conn)
        } catch (err) {
          this.log.error(`[onebot] 事件处理抛错: ${err?.stack ?? err}`)
        }
      })

      conn.on('close', () => {
        // closeAll() 先清空集合再关连接：那是插件自己在停，不算掉线
        if (!this.connections.delete(conn)) return
        this.log.info(`[onebot] 连接断开，剩余连接数=${this.connections.size}`)
        if (this.connections.size === 0) {
          this.offlineSince = Date.now()
          this.#armOfflineWatch(this.offlineWarnAfterMs)
        }
      })

      conn.markReady()
    })
  }

  /** 取一条可用连接（优先 ready 且最近有事件的） */
  pick() {
    let best = null
    for (const conn of this.connections) {
      if (conn.closed) continue
      if (!best) {
        best = conn
        continue
      }
      if (conn.lastEventAt > best.lastEventAt) best = conn
    }
    return best
  }

  snapshot() {
    return {
      path: this.path,
      authRequired: Boolean(this.getToken()),
      accepted: this.totalAccepted,
      rejectedAuth: this.rejectedAuth,
      rejectedNotReady: this.rejectedNotReady,
      rejectedNoToken: this.rejectedNoToken,
      allowNoToken: this.allowNoToken,
      rejectedOrigin: this.rejectedOrigin,
      authReady: this.isAuthReady(),
      active: this.connections.size,
      offlineSince: this.offlineSince,
      lastConnectedAt: this.lastConnectedAt,
      connections: [...this.connections].map((c) => c.snapshot()),
      selfIds: [...new Set([...this.connections].map((c) => c.selfId).filter(Boolean))],
    }
  }

  async closeAll() {
    this.#clearOfflineWatch()
    const all = [...this.connections]
    this.connections.clear()
    for (const conn of all) {
      try {
        conn.close(1001, 'shall shutting down')
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((resolve) => this.wss.close(() => resolve()))
  }
}

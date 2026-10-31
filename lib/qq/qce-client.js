/**
 * 本机 QQ Chat Exporter（napcat-plugin-qce）的 HTTP 客户端：让插件自己把某个群、某个人的历史聊天导出来。
 *
 * 只连本机（127.0.0.1 / localhost / ::1），连别的地址直接拒绝：这不是出站请求，聊天记录不出这台电脑。
 * 访问令牌每次从 QCE 自己的 `~/.qq-chat-exporter/security.json`（accessToken）读，不缓存、不落盘、不打日志。
 *
 * 实测过的接口（QCE 5.5.77）：
 *   POST /api/messages/fetch  { peer, page, limit }                → data.messages[]（新 → 旧，msgTime 是秒）
 *   POST /api/messages/export { peer, format:'JSON', filter, options } → data.{ taskId, filePath, fileName, status }
 *        filter: { startTime, endTime }（毫秒）、includeUserUins: [QQ号]（只导这几个人说的话）
 *   GET  /api/tasks/<taskId>                                      → data.{ status: running|completed|failed|cancelled, progress, fileName }
 * 群聊 peer = { chatType: 2, peerUid: 群号 }。私聊要先把 QQ 号换成 uid，这里不支持。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const QCE_DEFAULT_URL = 'http://127.0.0.1:40653'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const REQUEST_TIMEOUT_MS = 15_000
const POLL_MS = 1500

export function defaultSecurityFile() {
  return path.join(os.homedir(), '.qq-chat-exporter', 'security.json')
}

/** 只认本机地址；不是本机返回错误信息 */
export function checkLoopback(baseUrl) {
  let url
  try {
    url = new URL(String(baseUrl ?? ''))
  } catch {
    return 'QQ Chat Exporter 的地址不是合法的 URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'QQ Chat Exporter 的地址只能是 http(s)'
  if (!LOOPBACK.has(url.hostname)) return `QQ Chat Exporter 只能连本机（127.0.0.1），不能连 ${url.hostname}`
  return ''
}

export class QceClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl] 默认 http://127.0.0.1:40653
   * @param {string} [opts.securityFile] 默认 ~/.qq-chat-exporter/security.json
   */
  constructor({ baseUrl = QCE_DEFAULT_URL, securityFile = '', fetchImpl = globalThis.fetch, sleep = null, now = () => Date.now(), log = null } = {}) {
    this.baseUrl = String(baseUrl || QCE_DEFAULT_URL).replace(/\/+$/, '')
    this.securityFile = securityFile || defaultSecurityFile()
    this.fetchImpl = fetchImpl
    this.sleep = sleep ?? ((ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }))
    this.now = now
    this.log = log
  }

  #token() {
    try {
      const token = JSON.parse(fs.readFileSync(this.securityFile, 'utf8'))?.accessToken
      return typeof token === 'string' ? token : ''
    } catch {
      return ''
    }
  }

  async #call(method, p, body, signal) {
    const problem = checkLoopback(this.baseUrl)
    if (problem) throw new Error(problem)
    const token = this.#token()
    if (!token) throw new Error(`读不到 QQ Chat Exporter 的访问令牌（${this.securityFile}）`)
    const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
    const merged = signal && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
    const res = await this.fetchImpl(`${this.baseUrl}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: merged,
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    if (res.status === 401 || res.status === 403) throw new Error('QQ Chat Exporter 拒绝了访问令牌（令牌过期？在它的网页里重新登录一次）')
    if (!res.ok || json?.success === false) throw new Error(`QQ Chat Exporter 返回 ${res.status}：${String(json?.error?.message ?? json?.message ?? json?.error ?? '').slice(0, 200)}`)
    return json?.data ?? json
  }

  /** 能不能用：令牌在、服务在 */
  async status() {
    const problem = checkLoopback(this.baseUrl)
    if (problem) return { ok: false, reason: problem }
    if (!this.#token()) return { ok: false, reason: `没装或没启动 QQ Chat Exporter（读不到 ${this.securityFile}）` }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/`, { signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(3000) : undefined })
      return res.status < 500 ? { ok: true } : { ok: false, reason: `QQ Chat Exporter 返回 ${res.status}` }
    } catch (error) {
      return { ok: false, reason: `连不上 QQ Chat Exporter（${this.baseUrl}）：${error?.cause?.code ?? error?.message ?? error}` }
    }
  }

  /**
   * 导出一个群的聊天记录（JSON），等它导完。
   * @param {object} opts
   * @param {string} opts.chatId 群号
   * @param {number} [opts.days] 最近多少天
   * @param {string[]} [opts.memberIds] 只导这几个人说的话
   * @param {number} [opts.timeoutMs] 最多等多久（默认 10 分钟）
   * @param {(text: string) => void} [opts.onProgress]
   * @returns {Promise<{ filePath: string, messageCount: number, taskId: string }>}
   */
  async exportGroup({ chatId, days = 90, memberIds = [], timeoutMs = 600_000, signal, onProgress } = {}) {
    if (!/^\d{1,12}$/.test(String(chatId ?? ''))) throw new Error('群号需要是纯数字')
    const ids = (memberIds ?? []).map(String).filter((id) => /^\d{5,12}$/.test(id))
    const endTime = this.now()
    const startTime = endTime - Math.max(1, Number(days) || 90) * 24 * 3600 * 1000
    const filter = { startTime, endTime }
    if (ids.length) filter.includeUserUins = ids
    const created = await this.#call('POST', '/api/messages/export', {
      peer: { chatType: 2, peerUid: String(chatId), guildId: '' },
      format: 'JSON',
      filter,
      options: { includeResourceLinks: false, includeSystemMessages: false },
    }, signal)
    const taskId = String(created?.taskId ?? created?.id ?? '')
    if (!taskId) throw new Error('QQ Chat Exporter 没有返回任务号')
    let filePath = String(created?.filePath ?? '')
    let fileName = String(created?.fileName ?? '')
    const deadline = this.now() + timeoutMs
    let task = created
    while (!['completed', 'failed', 'cancelled', 'error'].includes(String(task?.status ?? ''))) {
      if (signal?.aborted) throw new Error('已取消')
      if (this.now() > deadline) throw new Error(`QQ Chat Exporter 的导出任务 ${Math.round(timeoutMs / 60000)} 分钟还没做完，先不等了（任务还在它那边跑，做完可以在 QQ 页手动导入）`)
      await this.sleep(POLL_MS, signal)
      task = await this.#call('GET', `/api/tasks/${encodeURIComponent(taskId)}`, undefined, signal)
      if (task?.fileName) fileName = String(task.fileName)
      if (task?.filePath) filePath = String(task.filePath)
      if (Number.isFinite(Number(task?.progress))) onProgress?.(`QQ Chat Exporter 导出中：${Math.round(Number(task.progress))}%`)
    }
    if (task.status !== 'completed') throw new Error(`QQ Chat Exporter 的导出任务${task.status === 'cancelled' ? '被取消了' : '失败了'}：${String(task?.error ?? task?.message ?? '').slice(0, 200)}`)
    if (!filePath && fileName) filePath = path.join(path.dirname(this.securityFile), 'exports', path.basename(fileName))
    if (!filePath || !fs.existsSync(filePath)) throw new Error('QQ Chat Exporter 说导完了，但找不到导出的文件（它和 DSH 不在同一台电脑上？）')
    return { filePath, messageCount: Number(task?.messageCount ?? created?.messageCount) || 0, taskId }
  }
}

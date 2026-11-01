/**
 * 主人身份绑定（docs/CONTRACTS.md 4.8，PLAN 第 47 条、改进点 5）。
 *
 * DSH 用户就是配对过的那个 QQ 号。配对流程：控制台点“生成配对码”拿到 6 位数字（10 分钟内有效、只能用一次），
 * 主人用自己的 QQ 私聊 bot 发这 6 位数字，插件把发送者记进 `$DSH_HOME/shall/owner.json`。
 * 插件里所有“最高权限用户”的判断都只读这一个文件。群里发配对码无效（群里的人都看得到）。
 */
import path from 'node:path'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { isPlainObject, loadJsonOrQuarantine, writeJsonAtomic } from '../core/fs-atomic.js'

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

export function createOwner(options) {
  return new OwnerBinding(options)
}

export class OwnerBinding {
  constructor({ dir, log = null, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('OwnerBinding 需要 dir')
    this.dir = dir
    this.file = path.join(dir, 'owner.json')
    this.log = log
    this.now = now
    this.pending = null
    this.listeners = new Set()
    this.data = this.#load()
  }

  #load() {
    // 解除配对时写的是 `{}`，所以"是对象"就算结构正确；读不懂的改名留档，按未配对处理
    const parsed = loadJsonOrQuarantine(this.file, { log: this.log, fallback: null, validate: isPlainObject })
    return /^\d{5,12}$/.test(String(parsed?.qq ?? '')) ? { qq: String(parsed.qq), pairedAt: Number(parsed.pairedAt) || 0 } : null
  }

  #save() {
    writeJsonAtomic(this.file, this.data ?? {})
    for (const fn of this.listeners) {
      try {
        fn(this.owner())
      } catch {
        /* 监听器出错不影响配对 */
      }
    }
  }

  /** 配对的 QQ 号；没配对返回 null。 */
  owner() {
    return this.data ? this.data.qq : null
  }

  info() {
    return {
      paired: Boolean(this.data),
      qq: this.data?.qq ?? null,
      pairedAt: this.data?.pairedAt ?? null,
      codePending: Boolean(this.pending && this.pending.expiresAt > this.now()),
      codeExpiresAt: this.pending?.expiresAt ?? null,
    }
  }

  isOwner(qq) {
    return Boolean(this.data) && String(qq) === this.data.qq
  }

  /** 生成一个新配对码（旧的作废）。只给控制台用。 */
  issueCode() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pending = { code, expiresAt: this.now() + CODE_TTL_MS, attempts: 0 }
    return { code, expiresAt: this.pending.expiresAt }
  }

  /** 这条消息是不是在发配对码（私聊里只有 6 位数字）。 */
  looksLikeCode(text) {
    return Boolean(this.pending) && /^\s*\d{6}\s*$/.test(String(text ?? ''))
  }

  /**
   * 用配对码配对。返回 { ok, reason }。码用过、过期、错 5 次都会作废。
   * @param {string} qq 发送者 QQ 号
   * @param {string} text 消息正文
   */
  tryPair(qq, text) {
    const p = this.pending
    if (!p) return { ok: false, reason: 'no-code' }
    if (p.expiresAt <= this.now()) {
      this.pending = null
      return { ok: false, reason: 'expired' }
    }
    const given = Buffer.from(String(text ?? '').trim())
    const want = Buffer.from(p.code)
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      p.attempts += 1
      if (p.attempts >= MAX_ATTEMPTS) this.pending = null
      return { ok: false, reason: 'wrong' }
    }
    if (!/^\d{5,12}$/.test(String(qq))) return { ok: false, reason: 'bad-qq' }
    this.pending = null
    this.data = { qq: String(qq), pairedAt: this.now() }
    this.#save()
    this.log?.info?.(`[owner] 已和 QQ ${qq} 配对，之后它就是主人`)
    return { ok: true }
  }

  /** 解除配对（控制台）。owner:chat 记忆保留，重新配对后恢复可读。 */
  reset() {
    this.data = null
    this.pending = null
    this.#save()
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

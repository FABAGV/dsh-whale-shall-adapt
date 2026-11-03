/**
 * 出站节流：同一个聊天串行发送，条与条之间留间隔。
 *
 * ## 为什么需要它
 *
 * 一次回合里可能同时冒出好几条出站消息：
 *   - relay 分条（长回复切成几条）；
 *   - 模型在一轮里多次调用 `shall_qq_send` / `shall_qq_send_image`；
 *   - 交班、任务受理这类 `notify` 直接推；
 *   - 出错、配对成功的系统提示。
 *
 * 这些路径以前各自调用 `conn.call('send_*_msg')`，没有任何统一节流：模型并发调工具、
 * 或者一次 flush 里的几条分条，会在同一瞬间连发好几条。QQ 的风控对"短时间同账号高频发送"
 * 很敏感，真机上会表现为消息被吞、账号被限制。
 *
 * 所以把节流放在**最底层的写入口**：所有出站消息都从这里过，谁也绕不开。
 *
 * ## 语义
 *
 * | 约束 | 含义 |
 * |---|---|
 * | 同一个聊天中间隔 `gapMs` | 上一条**开始发送**之后至少这么久，才允许下一条开始 |
 * | 每条消息前随机等 0–`jitterMs` | 打散固定节奏，不总是精确的 1200ms |
 * | 全局间隔 `globalGapMs` | 同一个账号发到不同聊天之间也留一点缝 |
 * | 同一个聊天串行 | 保证顺序，避免并发调用把分条发乱 |
 *
 * `gapMs = 0` 时只保留串行与全局间隔，用于测试或明确要关掉的人。
 *
 * ⚠️ 间隔按"开始发送"计算，不是"上一条返回之后"。OneBot 的 `conn.call` 是本地往返，
 *    通常远小于间隔；按开始时间算可以避免"上一条卡住时下一条被无限推迟"。
 */

/** 默认 sleep：不 unref —— 发送还没完成时不能允许进程退出 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} [opts]
 * @param {number} [opts.gapMs] 同一个聊天两条消息之间的最小间隔（毫秒）
 * @param {number} [opts.jitterMs] 每条消息发送前额外随机等待的上限（毫秒）
 * @param {number} [opts.globalGapMs] 不同聊天之间的最小间隔（毫秒）
 * @param {() => number} [opts.now] 测试用时钟
 * @param {(ms: number) => Promise<void>} [opts.sleep] 测试用等待
 * @param {() => number} [opts.random] 测试用随机数
 */
export function createSendThrottle({
  gapMs = 0,
  jitterMs = 0,
  globalGapMs = 0,
  now = () => Date.now(),
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  const gap = nonNegative(gapMs)
  const jitter = nonNegative(jitterMs)
  const globalGap = nonNegative(globalGapMs)
  /** @type {Map<string, {tail: Promise<void>, nextAt: number, pending: number}>} */
  const queues = new Map()
  let globalNextAt = 0

  /**
   * 队列清空后**不能立刻删条目**：下一条消息还要靠 entry.nextAt 算间隔。
   * 只在表太大时清掉"没人排队、而且已经空闲超过一分钟"的旧聊天。
   */
  const MAX_IDLE_KEYS = 1024
  function prune(t) {
    if (queues.size <= MAX_IDLE_KEYS) return
    for (const [id, entry] of queues) {
      if (entry.pending === 0 && entry.nextAt + 60_000 < t) queues.delete(id)
    }
  }

  /**
   * 排队执行一次发送。
   *
   * @param {string} key 聊天标识（`group:123` / `private:456`）
   * @param {() => any} fn 真正发送的闭包
   * @returns {Promise<any>} fn 的结果；fn 抛错时原样抛出，不阻塞后面的发送
   */
  async function run(key, fn) {
    const id = String(key ?? '')
    let entry = queues.get(id)
    if (!entry) {
      prune(now())
      entry = { tail: Promise.resolve(), nextAt: 0, pending: 0 }
      queues.set(id, entry)
    }
    entry.pending += 1
    // 先占住队列位置：后面的调用一定排在我后面（同 key 串行）
    const prev = entry.tail
    let release = () => {}
    const mine = new Promise((resolve) => {
      release = resolve
    })
    entry.tail = mine
    await prev
    try {
      // 预约一个发送时刻：同聊间隔与全局间隔都要满足。
      // 这段是同步的（没有 await），并发调用不会抢到同一个时刻。
      const t = now()
      const pre = jitter > 0 ? Math.floor(random() * jitter) : 0
      const at = Math.max(t + pre, entry.nextAt, globalNextAt)
      entry.nextAt = at + gap
      globalNextAt = at + globalGap
      if (at > t) await sleep(at - t)
      return await fn()
    } finally {
      entry.pending -= 1
      release()
    }
  }

  return {
    run,
    /** 当前还在排队/发送中的聊天（排障 / 测试用） */
    get activeKeys() {
      return [...queues].filter(([, entry]) => entry.pending > 0).map(([id]) => id)
    },
  }
}

function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

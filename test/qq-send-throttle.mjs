/**
 * 出站节流（lib/qq/send-throttle.js）：同一个聊天串行 + 条间间隔 + 全局间隔。
 *
 * 时间用假时钟：`sleep(ms)` 只是登记一个虚拟计时器，由 `drain()` 按时间顺序推进，
 * 这样并发的等待也能按真实语义排好（直接 `now += ms` 会让并发测试算错）。
 *
 * 运行：node test/qq-send-throttle.mjs
 */
import { createSendThrottle } from '../lib/qq/send-throttle.js'
import { resolveConfig, DEFAULT_CONFIG } from '../lib/qq/config.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

function harness({ gapMs = 0, jitterMs = 0, globalGapMs = 0, random = () => 0 } = {}) {
  let now = 0
  const timers = []
  const events = []
  const sleep = (ms) =>
    new Promise((resolve) => {
      timers.push({ at: now + ms, resolve })
    })
  const throttle = createSendThrottle({ gapMs, jitterMs, globalGapMs, now: () => now, sleep, random })

  /**
   * 推进虚拟时钟，直到给定的 promise 全部结束。
   * 每次先把微任务跑完（setImmediate），再挑最近的一个计时器唤醒。
   */
  async function drain(promises) {
    const all = Promise.all(promises)
    let done = false
    all.then(
      () => {
        done = true
      },
      () => {
        done = true
      },
    )
    for (let i = 0; i < 10000 && !done; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (done) break
      if (timers.length === 0) continue
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      if (next.at > now) now = next.at
      next.resolve()
    }
    await all.catch(() => {})
  }

  const send = (key, tag, result) => throttle.run(key, async () => {
    events.push({ tag, t: now })
    return result
  })
  const at = (tag) => events.find((e) => e.tag === tag)?.t
  return { throttle, events, now: () => now, drain, send, at }
}

console.log('A. 同一个聊天：串行 + 条间间隔')
{
  const h = harness({ gapMs: 1200 })
  await h.drain([h.send('group:1', 'a'), h.send('group:1', 'b'), h.send('group:1', 'c')])
  check('按调用顺序发送', h.events.map((e) => e.tag).join('') === 'abc', JSON.stringify(h.events))
  check('第一条不等待', h.at('a') === 0)
  check('第二条隔 1200', h.at('b') - h.at('a') === 1200, String(h.at('b')))
  check('第三条隔 1200', h.at('c') - h.at('b') === 1200, String(h.at('c')))
}

console.log('B. 不同聊天：全局间隔')
{
  const h = harness({ gapMs: 0, globalGapMs: 300 })
  await h.drain([h.send('group:1', 'a'), h.send('private:2', 'b'), h.send('group:3', 'c')])
  check('全局间隔 300', h.at('b') - h.at('a') === 300 && h.at('c') - h.at('b') === 300, JSON.stringify(h.events))
}

console.log('C. 抖动：每条前面随机等一段')
{
  const h = harness({ gapMs: 0, jitterMs: 400, random: () => 0.5 })
  await h.drain([h.send('group:1', 'a'), h.send('group:1', 'b')])
  check('第一条也带 0–jitter 的随机等待', h.at('a') === 200, String(h.at('a')))
  check('第二条在前一条之后再等一次', h.at('b') === 400, String(h.at('b')))
}

console.log('D. 间隔比抖动大：以间隔为准')
{
  const h = harness({ gapMs: 1200, jitterMs: 400, random: () => 0.5 })
  await h.drain([h.send('group:1', 'a'), h.send('group:1', 'b')])
  check('两条之间至少 1200', h.at('b') - h.at('a') === 1200, `${h.at('a')} → ${h.at('b')}`)
}

console.log('E. 发送失败不堵住队列')
{
  const h = harness({ gapMs: 100 })
  const bad = h.throttle.run('group:1', async () => {
    throw new Error('发送失败')
  }).then(
    () => 'ok',
    () => 'rejected',
  )
  const ok = h.send('group:1', 'ok')
  await h.drain([bad, ok])
  check('失败原样抛给调用方', (await bad) === 'rejected')
  check('后面的消息照常发', h.events.length === 1 && h.events[0].tag === 'ok')
  check('排空后没有残留的排队记录', h.throttle.activeKeys.length === 0, JSON.stringify(h.throttle.activeKeys))
}

console.log('F. gap 为 0：只串行不等待')
{
  const h = harness({ gapMs: 0, jitterMs: 0 })
  await h.drain([h.send('group:1', 'a'), h.send('group:1', 'b')])
  check('两条都在同一时刻', h.at('a') === 0 && h.at('b') === 0)
  check('顺序不变', h.events.map((e) => e.tag).join('') === 'ab')
}

console.log('G. 排队清空后再来一条：间隔仍然生效')
{
  const h = harness({ gapMs: 1200 })
  await h.drain([h.send('group:1', 'a')])
  await h.drain([h.send('group:1', 'b')])
  check('第二条仍与第一条隔 1200', h.at('b') - h.at('a') === 1200, `${h.at('a')} → ${h.at('b')}`)
}

console.log('H. 配置项')
{
  const ok = resolveConfig({})
  check('默认值 1200 / 400 / 300', ok.advanced.sendGapMs === 1200 && ok.advanced.sendJitterMs === 400 && ok.advanced.sendGlobalGapMs === 300)
  const zero = resolveConfig({ advanced: { sendGapMs: 0, sendJitterMs: 0, sendGlobalGapMs: 0 } })
  check('可以显式关掉', zero.advanced.sendGapMs === 0 && zero.advanced.sendJitterMs === 0 && zero.advanced.sendGlobalGapMs === 0)
  const bad = resolveConfig({ advanced: { sendGapMs: -1, sendJitterMs: 99999, sendGlobalGapMs: 'x' } })
  check('非法值回退默认', bad.advanced.sendGapMs === 1200 && bad.advanced.sendJitterMs === 400 && bad.advanced.sendGlobalGapMs === 300)
  check('非法值有警告', bad.warnings.filter((w) => w.includes('send')).length >= 3, JSON.stringify(bad.warnings))
  const bogus = resolveConfig({ advanced: null })
  check('advanced 写成 null 也不炸', bogus.advanced.sendGapMs === DEFAULT_CONFIG.advanced.sendGapMs && bogus.relayFlushMs === DEFAULT_CONFIG.advanced.relayFlushMs)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

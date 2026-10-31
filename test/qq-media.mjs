/**
 * 消息里的媒体：地址 + 语音转写（lib/qq/onebot/media.js）。运行：node test/qq-media.mjs
 */
import { mediaBlock, loadVoiceText, voiceSegments, resetVoiceCache } from '../lib/qq/onebot/media.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const IMG = 'https://gchat.qpic.cn/gchatpic_new/1/2-3-ABC/0?term=2'
const VOICE = 'https://gchat.qpic.cn/voice/xyz.silk'
const msg = (segments) => ({ messageId: '1001', segments })

console.log('A. 媒体块')
{
  const block = mediaBlock(msg([{ kind: 'text', text: '看这个' }, { kind: 'image', file: 'a', url: IMG }]))
  check('图片带地址', block.includes('图片 1') && block.includes(IMG), block)
  check('带 [媒体] 标题', block.startsWith('[媒体]'))
  check('没有媒体段：空串', mediaBlock(msg([{ kind: 'text', text: '纯文字' }])) === '')
  check('没有 url 且没有转写：空串（不产生噪音）', mediaBlock(msg([{ kind: 'image', file: 'a' }])) === '')
  check('关掉 urls 但开了转写：只给转写',
    mediaBlock(msg([{ kind: 'image', file: 'a', url: IMG }, { kind: 'record', file: 'v', url: VOICE }]), { urls: false, transcript: '今天不播了' }) === '[媒体]\n- 语音 2　转写：「今天不播了」')
  const both = mediaBlock(msg([{ kind: 'image', file: 'a', url: IMG }, { kind: 'record', file: 'v', url: VOICE }]), { transcript: '喂喂' })
  check('图片 + 语音：两条都在', both.includes('图片 1') && both.includes('语音 2') && both.includes('转写：「喂喂」'))
  check('非 http 地址不放进正文', mediaBlock(msg([{ kind: 'image', file: 'a', url: 'file:///etc/passwd' }])) === '')
  const long = mediaBlock(msg([{ kind: 'image', file: 'a', url: `https://x.test/${'a'.repeat(2000)}` }]))
  check('超长地址截断', long.includes('…') && long.length < 1200)
  check('语音段识别', voiceSegments(msg([{ kind: 'record' }, { kind: 'image' }])).length === 1)
}

console.log('B. 语音转写')
{
  resetVoiceCache()
  let calls = 0
  const conn = {
    call: async (action, params) => {
      calls += 1
      if (action !== 'fetch_ptt_text') throw new Error(`不该调 ${action}`)
      if (params?.message_id !== '1001') throw new Error('message_id 传错')
      return { text: '  今天  不直播了  ' }
    },
  }
  const voiceMsg = msg([{ kind: 'record', file: 'v', url: VOICE }])
  const text = await loadVoiceText(conn, voiceMsg)
  check('取到转写并压成一行', text === '今天 不直播了', JSON.stringify(text))
  await loadVoiceText(conn, voiceMsg)
  check('同一条消息走缓存（不重复调 NapCat）', calls === 1, `calls=${calls}`)

  const wrapped = { call: async () => ({ data: { text: '包在 data 里' } }) }
  resetVoiceCache()
  check('结果包在 data 里也认', (await loadVoiceText(wrapped, msg([{ kind: 'record', file: 'v' }]))) === '包在 data 里')

  const failing = { call: async () => { throw new Error('NapCat 不支持') } }
  resetVoiceCache()
  check('调用失败：空串，不抛', (await loadVoiceText(failing, msg([{ kind: 'record', file: 'v' }]))) === '')
  resetVoiceCache()
  check('关掉开关：不调', (await loadVoiceText(conn, voiceMsg, { enabled: false })) === '')
  check('没有语音段：不调', (await loadVoiceText(conn, msg([{ kind: 'text', text: 'x' }]))) === '')
  check('没有连接：空串', (await loadVoiceText(null, voiceMsg)) === '')
  check('没有 messageId：不调', (await loadVoiceText(conn, { segments: [{ kind: 'record' }] })) === '')

  resetVoiceCache()
  let slow = 0
  const hanging = { call: () => { slow += 1; return new Promise(() => {}) } }
  const t0 = Date.now()
  const out = await loadVoiceText(hanging, msg([{ kind: 'record', file: 'v' }]), { timeoutMs: 60 })
  check('卡住：超时放弃，不阻塞投递', out === '' && Date.now() - t0 < 1000 && slow === 1)

  const long = { call: async () => ({ text: 'x'.repeat(2000) }) }
  resetVoiceCache()
  check('转写太长：截断', (await loadVoiceText(long, msg([{ kind: 'record', file: 'v' }]), { maxChars: 10 })).length === 10)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

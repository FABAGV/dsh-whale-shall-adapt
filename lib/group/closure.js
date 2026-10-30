/**
 * 对话收尾判断（PLAN 第 43 条，借鉴 SurfCore 的 conversation-closure.js，MIT）。
 *
 * 把对方最后一句话分成五类：道别、提问、求助、附和、有内容。
 *   - 提问、求助：不许收尾，一定要接；
 *   - 道别、附和：可以收尾，这轮不用回（被叫到时仍然回，只是提示里带一句“对方像是在收尾”）；
 *   - 有内容：照常。
 *
 * 全是零成本规则。规则判得不准（相关调研里规则判纠正的 F1 只有 0.46 左右），所以这里宁可判成“有内容”：
 * 误判成收尾，最坏是少回一句；误判成有内容，最坏是多回一句。
 */

export const CLOSURE_KIND = Object.freeze({
  FAREWELL: 'farewell',
  QUESTION: 'question',
  HELP: 'help',
  ACK: 'ack',
  CONTENT: 'content',
})

const FAREWELL = /(拜拜|再见|晚安|先下了|先撤了|溜了|回头聊|下次聊|明天聊|去睡了|睡了啊|我去忙|不聊了|88|886|byebye|bye|goodnight|gn\b|see you|cya)/i
const QUESTION = /([?？]|吗[^a-zA-Z0-9]*$|呢[^a-zA-Z0-9]*$|什么|怎么|为什么|为啥|是不是|能不能|可不可以|行不行|有没有|多少|哪(个|里|儿|些)|谁|几点|how |what |why |who |where )/i
const HELP = /(帮我|帮忙|帮个忙|求助|求教|请问|麻烦|救救|怎么办|能帮|可以帮|教教|教我|想问)/
const ACK = /^(?:嗯+|哦+|噢+|好+的?|好的|行|行吧|ok|okay|okk|k|可以|收到|了解|明白|懂了|是的|对|对的|对对|确实|没错|哈+|嘻+|笑死|绝了|牛|牛逼|厉害|666+|\+1|1|谢谢|谢了|多谢|感谢|thx|thanks|辛苦了|好哒|好滴|嗯嗯|知道了)+$/i
/** 附和只认很短的句子；长句多半有内容 */
const ACK_MAX_CHARS = 10
/** 只有表情符号 */
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200d\ufe0f]+$/u

function strip(text) {
  return String(text ?? '')
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/[\s!！。.，,~～…、;；:：'"“”‘’()（）]+/g, '')
    .trim()
}

/**
 * @param {string} text 对方最后一句话
 * @returns {{ kind: string, canClose: boolean }}
 */
export function classifyClosing(text) {
  const raw = String(text ?? '').trim()
  const bare = strip(raw)
  if (!bare || EMOJI_ONLY.test(bare)) return { kind: CLOSURE_KIND.ACK, canClose: true }
  if (HELP.test(raw)) return { kind: CLOSURE_KIND.HELP, canClose: false }
  if (QUESTION.test(raw)) return { kind: CLOSURE_KIND.QUESTION, canClose: false }
  if (bare.length <= 24 && FAREWELL.test(raw)) return { kind: CLOSURE_KIND.FAREWELL, canClose: true }
  if (bare.length <= ACK_MAX_CHARS && ACK.test(bare)) return { kind: CLOSURE_KIND.ACK, canClose: true }
  return { kind: CLOSURE_KIND.CONTENT, canClose: false }
}

/** 给被叫到的消息加在提示里的一句话；不是收尾时返回空串 */
export function closingHint(verdict) {
  if (!verdict?.canClose) return ''
  const what = verdict.kind === CLOSURE_KIND.FAREWELL ? '在道别' : '只是附和或道谢'
  return `（插件判断：对方像是${what}，没有新问题。可以简短回应一句，也可以这轮不说话。）`
}

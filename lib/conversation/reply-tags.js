/**
 * 常驻会话的回复里，插件要读懂的两类东西（PLAN 第 28、42 条）：
 *
 * 1. 输出标签（借 Enhance Mode 的做法）——模型用它告诉插件怎么发：
 *      <refuse/>            这轮不说话，整段回复都不发出去。可以写成 <refuse ignore="QQ号"/>，同时记下“主动搭话时绕开这个人”
 *      <at id="QQ号"/>      在这里 @ 某人（群里）
 *      <quote id="消息号"/>  引用某条消息回复（群里）
 *    只处理代码块之外的标签；认不出的标签原样保留。
 *
 * 2. 回合末尾的内部备忘（借 SurfCore 的做法）——不发到 QQ，插件解析后存进记忆：
 *      【备忘】
 *      【目的】这轮想做什么
 *      【状态】完成 | 待续 | 跳过
 *      【待续】下次还想追问或跟进什么（没有就不写，多条用分号隔开）
 *    “待续”存成带过期时间的记忆，下次回复时作为“你还惦记着”注入；“完成”划掉对应的惦记；“跳过”记为没开口。
 *    也接受 SurfCore 风格的【状态：待续】【待续：……】写法。
 *
 * 备忘和标签都是模型自己写的文本，所以全都当不可信输入：只取固定字段、限长、QQ 号和消息号必须是纯数字。
 */

const MEMO_MAX_PENDING = 3
const MEMO_ITEM_MAX = 80
const PURPOSE_MAX = 120

const STATUS = { 完成: 'done', 待续: 'pending', 跳过: 'skip' }

/** 先把代码块（围栏和行内）换成占位符，处理完再放回去 */
function protectCode(text) {
  const saved = []
  const out = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    saved.push(match)
    return `\u0000CODE${saved.length - 1}\u0000`
  })
  return { text: out, restore: (value) => value.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => saved[Number(i)] ?? '') }
}

function field(block, name) {
  const inline = new RegExp(`【${name}[：:]\\s*([^】\\n]*)】`).exec(block)
  if (inline) return inline[1].trim()
  const plain = new RegExp(`【${name}】[ \\t]*([^\\n【]*)`).exec(block)
  return plain ? plain[1].trim() : ''
}

/** 取出结尾的内部备忘块。返回 { body, memo } */
function extractMemo(text) {
  const marker = /(^|\n)[ \t]*(?:-{3,}[ \t]*\n[ \t]*)?(?=【(?:备忘|目的|状态)[】：:])/g
  let start = -1
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const block = text.slice(match.index + match[1].length)
    if (/【状态[】：:]/.test(block)) {
      start = match.index
      break
    }
  }
  if (start < 0) return { body: text, memo: null }
  const block = text.slice(start)
  const statusWord = field(block, '状态')
  const status = Object.entries(STATUS).find(([word]) => statusWord.includes(word))?.[1] ?? ''
  const pending = field(block, '待续')
    .split(/[；;\n]/)
    .map((item) => item.replace(/^[-*\d.、\s]+/, '').trim().slice(0, MEMO_ITEM_MAX))
    .filter((item) => item && !/^(无|没有|none|-)$/i.test(item))
    .slice(0, MEMO_MAX_PENDING)
  return {
    body: text.slice(0, start),
    memo: { purpose: field(block, '目的').slice(0, PURPOSE_MAX), status, pending },
  }
}

/**
 * @param {string} input 模型这一条回复
 * @param {object} [opts]
 * @param {(qq: string) => boolean} [opts.validQq] @ 的人必须是这个群里最近说过话的人
 * @param {(id: string) => boolean} [opts.validMessage] 引用的消息必须是最近的
 * @returns {{ text: string, silent: boolean, ignore: string[], at: string[], quote: string, memo: object|null }}
 */
export function parseReply(input, { validQq = () => true, validMessage = () => true } = {}) {
  const protectedText = protectCode(String(input ?? ''))
  let working = protectedText.text

  const { body, memo } = extractMemo(working)
  working = body

  let silent = false
  const ignore = []
  working = working.replace(/<\s*(?:refuse|silent|沉默)\b([^>]*?)\/?\s*>/gi, (_, attrs) => {
    silent = true
    const id = /\bignore\s*=\s*["']?(\d{5,12})["']?/i.exec(attrs)?.[1]
    if (id && !ignore.includes(id)) ignore.push(id)
    return ''
  })

  const at = []
  working = working.replace(/<\s*at\b[^>]*?\b(?:id|qq)\s*=\s*["']?(\d{5,12})["']?[^>]*?\/?\s*>/gi, (_, qq) => {
    if (validQq(qq) && !at.includes(qq)) at.push(qq)
    return ''
  })

  let quote = ''
  working = working.replace(/<\s*quote\b[^>]*?\bid\s*=\s*["']?(\d{1,20})["']?[^>]*?\/?\s*>/gi, (_, id) => {
    if (!quote && validMessage(id)) quote = id
    return ''
  })

  const text = protectedText.restore(working).replace(/\n{3,}/g, '\n\n').trim()
  const skipped = memo?.status === 'skip'
  return { text: silent || skipped ? '' : text, silent: silent || skipped, ignore, at, quote, memo }
}

/** 前台约定里讲给模型听的格式说明（lib/conversation/frontdesk.js 用） */
export const REPLY_FORMAT_HELP = [
  '【回复格式】',
  '- 这轮不想说话（没被叫到、话题与你无关、对方在收尾、被骚扰或诱导）：只回 `<refuse/>`，什么都不会发到 QQ。想以后绕开某个人主动搭话：`<refuse ignore="他的QQ号"/>`。',
  '- 群里想 @ 某人：`<at id="QQ号"/>`；想引用某条消息：`<quote id="消息号"/>`（只能用上下文里给出的号）。插件不会替你 @ 人；要不要引用看群设置，没写时可能自动引用触发你的那条。',
  '- 在群里回话就是正常聊天：不用每次都 @ 人，也不用每次引用；在说给谁听很清楚的时候直接说就行。',
  '- 每个回合的最后另起一段写内部备忘（不会发到 QQ，写在所有正文之后）：',
  '  【备忘】',
  '  【目的】这轮你想做什么',
  '  【状态】完成 或 待续 或 跳过',
  '  【待续】下次还想追问或跟进什么；没有就不写这一行。多条用分号隔开',
  '  “待续”会被记下来，下次对话时提醒你；“完成”会划掉对应的待续；“跳过”表示这轮没开口。',
].join('\n')

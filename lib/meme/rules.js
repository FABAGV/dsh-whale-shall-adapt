/**
 * 梗百科的查词规则：从一条消息里抽出要查的词，判断值不值得查。纯函数，零成本，不调模型。
 *
 * 规则照搬 astrbot_plugin_memewiki v1.7.0（MIT，Copyright (c) 2026 in1t1a1）的 main.py：
 * `_extract_meme_query`、`_asked_term`、`_normalize_query`、`_worth_search`。
 * 那边线上 48 小时实测：没有闸门时联网查询里只有 31% 是该查的梗，加了这套规则 + 模型闸门后精准率到 78.8%。
 */

const EDGE = ' \t\r\n，,。.！!？?:：；;、~～…"\'“”‘’「」『』（）()[]【】{}<>《》'

const ASK_TAIL = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/
const BARE = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/
const ASK_ABOUT = /(?<term>[^\s，,。！!？?、~～]{1,10}?)(?:到底|究竟)?(?:是)?(?:什么梗|啥梗|什么意思|啥意思|什么来头|什么来历|什么出处|怎么来的|哪儿来的|哪来的|咋来的|谁说的|怎么用|怎么接|怎么火的)/
const TERM_MISS = new Set(['这', '那', '它', '他', '她', '你', '我', '啥', '什么', '咋', '怎么', '为什么'])
const INTENT_WORDS = ['什么梗', '啥梗', '梗是啥', '什么来头', '什么来历', '什么出处', '啥意思', '什么意思', '黑话', '谐音', '缩写', '怎么来的', '谁说的', '怎么用', '怎么接', '啥是', '是啥']
const INTENT_MAX_CHARS = 6
const QUOTE_CHARS = '「」『』“”"\'《》【】'
const CHAT_PHRASES = new Set(['我是谁', '错了', '情绪', '接下一句', '你也学一个', '今天看什么', '到底多少了', '搜出来了吗', '来点贴吧评价', '都是同龄人', '你同事', '道德这么高', '这是谁的手臂', '比我能串', '宝宝你醒了', '中国人能不能飞', '你现在什么人格'])
const SENTENCE_WORDS = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/
const STOP_WORDS = new Set(['在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安', '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐'])
const PRONOUN_WORDS = ['自己', '你们', '我们', '他们', '她们', '咱们', '大家', '别人']
const REQUEST = /找.{0,4}本|本子|发个|发我|来点|来个|给我|帮我|点歌|搜一下|搜索|查一下|画个|画一|画好|生成|评价|锐评|自测|教你|让你学|学学|表情|图片|照片|视频|语音|文件|头像|发一|陪我|看看|做个|写个|发送/
const WORLD = /怎么打|几费|哪八张|多少级|几级|几几年|怎么玩|卡组|机制|战绩|比赛|多少分|赛区|怎么过|怎么配|值得抽|抽卡|版本答案|几分/
const CHAT_EXACT = new Set(['666', '6666', 'test', '测试', '不是', '是的', '好的', '好吧', '可以', '确定', '收到', '谢谢', '晚安', '早安', '嘿嘿', '嘻嘻', '哈哈', '在吗', '在不在', '草'])
const DEREF = /^(右边|左边|上面|下面|这个|那个|这里|那里|这是|那是)/
const SENT_Q = /怎么样|为什么|是不是|能不能|有没有|要不要|多少|了吗|了没|在哪|什么呀|咋办/

function stripEdges(text) {
  let s = String(text ?? '')
  while (s && EDGE.includes(s[0])) s = s.slice(1)
  while (s && EDGE.includes(s.at(-1))) s = s.slice(0, -1)
  return s
}

/** 去掉开头的 @某人 和 bot 的名字（唤醒词），再去掉首尾标点。 */
export function cleanText(text, { names = [] } = {}) {
  let t = String(text ?? '').trim().replace(/^(@\S+\s*)+/, '')
  for (const name of names) {
    if (name && t.startsWith(name)) {
      t = t.slice(name.length)
      break
    }
  }
  return stripEdges(t.trim())
}

/** 从消息里抽出要查的词：“X 是什么梗”抽 X，2–10 字的裸词原样返回；抽不出返回 null。 */
export function extractQuery(text, options = {}) {
  const t = cleanText(text, options)
  if (!t) return null
  const m = ASK_TAIL.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[\s，,。.！!？?]+|[\s，,。.！!？?]+$/g, '')
    head = head.replace(/^是+|是+$/g, '').replace(/^[\s，,。.！!？?]+|[\s，,。.！!？?]+$/g, '')
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (['这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面'].includes(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0] ?? '')) return null
    return head.length > 1 && head.length <= 12 ? head : null
  }
  return BARE.test(t) && !STOP_WORDS.has(t) ? t : null
}

/** “阿一古是什么意思” → “阿一古”；抠不出具体词就说明不是在问某个梗。 */
export function askedTerm(text) {
  const m = ASK_ABOUT.exec(String(text ?? ''))
  if (!m) return ''
  let term = m.groups.term.replace(/^(?:我想知道|想问一下|想问下|想问|问一下|问下|请问|那个|这个|这|那)/, '')
  term = term.replace(/^[ 的是「」『』“”"'《》]+|[ 的是「」『』“”"'《》]+$/g, '')
  if (term.length < 2 || term.length > 10) return ''
  if (TERM_MISS.has(term) || '这那你我他她它啥'.includes(term[0])) return ''
  return term
}

/** 把“杂鱼杂鱼”“666666”“已取餐已取餐”这类重复折叠成基词，便于命中缓存。 */
export function normalizeQuery(query) {
  const q = String(query ?? '').replace(/^[ ，,。.！!？?、~～]+|[ ，,。.！!？?、~～]+$/g, '')
  const n = q.length
  if (n >= 4) {
    for (let size = Math.min(4, Math.floor(n / 2)); size > 1; size -= 1) {
      if (n % size === 0 && q === q.slice(0, size).repeat(n / size)) return q.slice(0, size)
    }
  }
  return q
}

/**
 * 本地词库没收录时，这条值不值得往下查（联网或模型闸门）。三态：
 *   true  明确在问某个词 → 直接查
 *   false 结构上就不是词（请求、评价、游戏数值、指代、口头禅、整句）→ 不查
 *   null  短词但说不准是不是梗 → 交给模型闸门
 */
export function worthLookup(raw, query, { maxChars = 10 } = {}) {
  const text = String(raw ?? '').trim()
  const q = String(query ?? '').trim()
  if (INTENT_WORDS.some((k) => text.includes(k))) {
    if (text.length <= INTENT_MAX_CHARS || [...QUOTE_CHARS].some((c) => text.includes(c))) return true
    if (askedTerm(text)) return true
    return null
  }
  if (REQUEST.test(text) || REQUEST.test(q)) return false
  if (WORLD.test(text) || WORLD.test(q)) return false
  if (CHAT_EXACT.has(q) || CHAT_EXACT.has(text)) return false
  if (DEREF.test(q) && q.length <= 6) return false
  if (SENT_Q.test(q)) return false
  const max = Math.max(2, Math.min(Number(maxChars) || 10, 20))
  if (!q || q.length > max) return false
  if (CHAT_PHRASES.has(q)) return false
  if (SENTENCE_WORDS.test(q)) return false
  if (PRONOUN_WORDS.some((k) => q.includes(k))) return false
  if (q.length >= 3 && '我你他她它这那'.includes(q[0])) return false
  if (q.length >= 4 && '不没别请快都还就再又也'.includes(q[0])) return false
  return null
}

/** 给模型闸门用的提示词（同样来自 memewiki）。返回 JSON：{"term": "...", "lookup": true|false}。 */
export const GATE_PROMPT = [
  '你在给「梗百科」把关：判断这条群聊消息里有没有一个「值得查网络梗词典」的词。',
  '词典只收：网络梗、贴吧黑话、谐音梗、缩写、主播或群友的绰号、群内自造黑话。',
  '词典不收：日常闲聊与口头禅、让人做事（评价/找本子/发图/点歌/画画）、问对方情绪身份好感度、现实人物（明星/政客/球员/历史人物）、游戏卡牌数值与打法、指代不清（这个/右边/那个）。',
  '候选必须是一个具体的词/绰号/缩写（1-8 字）；整句话不算。',
  '拿不准一律不查；但 1-4 字的陌生专有词/绰号优先当作梗。',
  '只输出 JSON：{"term": "要查的词（不查就空）", "lookup": true 或 false}',
].join('\n')

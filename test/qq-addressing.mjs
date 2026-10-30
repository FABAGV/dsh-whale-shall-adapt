/**
 * 叫法扩展（UX 23）与引用解析（UX 25）：lib/qq/pipeline.js 的寻址、lib/qq/onebot/quote.js。
 * 纯本地，不连 NapCat。运行：node test/qq-addressing.mjs
 */
import { Pipeline, INTENT } from '../lib/qq/pipeline.js'
import { resolveConfig } from '../lib/qq/config.js'
import { resolveQuote, formatQuote, withQuote, quotedMessageId, QUOTE_MAX_CHARS } from '../lib/qq/onebot/quote.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const log = { info() {}, warn() {}, debug() {}, error() {} }
const SELF = '999'
const conn = { selfId: SELF }
let mid = 1000
const groupMsg = (groupId, segments, userId = 5) => ({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, self_id: Number(SELF),
  message_id: ++mid, time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: `用户${userId}` }, message: segments,
})
const text = (t) => ({ type: 'text', data: { text: t } })
const reply = (id) => ({ type: 'reply', data: { id: String(id) } })
const at = (qq) => ({ type: 'at', data: { qq: String(qq) } })
const poke = (extra = {}) => ({
  post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: Number(SELF), target_id: Number(SELF),
  user_id: 5, group_id: 123, time: Math.floor(Date.now() / 1000), ...extra,
})

const make = (participation = {}, group = {}) => new Pipeline({
  config: resolveConfig({ scope: { groups: ['*'], friends: ['*'] }, participation: { aliases: ['小鲸', '123:阿鲸'], ...participation }, group }),
  log,
})

console.log('A. 点名的几种叫法')
{
  const p = make()
  const plain = p.handle(groupMsg(123, [text('今天吃什么')]), conn)
  check('没叫：只入库', plain.intent === INTENT.INGEST && plain.addressedBy === '')
  const byAt = p.handle(groupMsg(123, [at(SELF), text(' 帮我看看')]), conn)
  check('@ bot：回应', byAt.intent === INTENT.CHAT && byAt.addressedBy === 'at')
  const byName = p.handle(groupMsg(123, [text('小鲸你觉得呢')]), conn)
  check('叫全局别名：回应', byName.intent === INTENT.CHAT && byName.addressedBy === 'name')
  const byGroupAlias = p.handle(groupMsg(123, [text('阿鲸在吗')]), conn)
  check('“群号:名字”在那个群生效', byGroupAlias.intent === INTENT.CHAT && byGroupAlias.addressedBy === 'name')
  const otherGroup = p.handle(groupMsg(456, [text('阿鲸在吗')]), conn)
  check('换个群不生效', otherGroup.intent === INTENT.INGEST)
  p.noteOwnMessage(77)
  const byReply = p.handle(groupMsg(123, [reply(77), text('这个不对')]), conn)
  check('回复 bot 发过的消息：回应', byReply.intent === INTENT.CHAT && byReply.addressedBy === 'reply')
  const replyOther = p.handle(groupMsg(123, [reply(78), text('哈哈')]), conn)
  check('回复别人的消息：不算点名', replyOther.intent === INTENT.INGEST)
  const late = p.decide(replyOther.message, { replyToBot: true })
  check('插件查到引用的是 bot 的旧消息后重判：回应', late.intent === INTENT.CHAT && late.addressedBy === 'reply')
  const silent = make({}, { defaultMode: 'silent' }).handle(groupMsg(123, [text('小鲸你好')]), conn)
  check('silent 档叫名字也不回应', silent.intent === INTENT.INGEST)
}

console.log('B. bot 发出的消息 id 只记最近的')
{
  const p = make()
  for (let i = 0; i < 600; i += 1) p.noteOwnMessage(i)
  check('超过 500 条丢最早的', !p.isOwnMessage(0) && p.isOwnMessage(599))
  p.noteOwnMessage('')
  check('空 id 不记', !p.isOwnMessage(''))
}

console.log('C. 戳一戳')
{
  const p = make()
  const first = p.handle(poke(), conn)
  check('戳 bot：当成一句话投给会话', first.intent === INTENT.CHAT && first.reason === 'poke' && first.text === '（戳了戳你）'
    && first.message.chatType === 'group' && first.message.chatId === '123')
  const again = p.handle(poke(), conn)
  check('60 秒内再戳：不刷屏', again.intent === INTENT.IGNORE && again.reason === 'poke-cooldown')
  const privatePoke = p.handle(poke({ group_id: undefined }), conn)
  check('私聊里戳也算，冷却按会话分开', privatePoke.intent === INTENT.CHAT && privatePoke.message.chatType === 'private')
  check('戳别人：照旧当通知忽略', p.handle(poke({ target_id: 42, group_id: 777 }), conn).intent === INTENT.IGNORE)
  check('关掉 poke：忽略', make({ poke: false }).handle(poke(), conn).intent === INTENT.IGNORE)
  const scoped = new Pipeline({ config: resolveConfig({ scope: { groups: ['111'] } }), log })
  check('不在范围内的群：忽略', scoped.handle(poke(), conn).intent === INTENT.IGNORE)
}

console.log('D. 引用解析')
{
  const message = { selfId: SELF, segments: [{ kind: 'reply', messageId: '77' }, { kind: 'text', text: '这个不对' }] }
  check('取出被引用的 id', quotedMessageId(message) === '77' && quotedMessageId({ segments: [] }) === '')
  const calls = []
  const fake = (data) => ({ async call(action, params) { calls.push([action, params]); return data } })
  const own = await resolveQuote(fake({ sender: { user_id: Number(SELF), nickname: '小鲸' }, message: [text('明天下午三点开会')] }), message)
  check('调 get_msg 取原文', calls[0]?.[0] === 'get_msg' && calls[0][1].message_id === 77)
  check('引用 bot 自己：标“(你)”', own.ok && own.fromSelf && formatQuote(own) === '[引用 小鲸(你): 明天下午三点开会]', formatQuote(own))
  const other = await resolveQuote(fake({ sender: { user_id: 5, card: '老王' }, message: [text('我觉得\n可以')] }), message)
  check('引用别人：发送者名字，换行压平', formatQuote(other) === '[引用 老王: 我觉得 可以]', formatQuote(other))
  const long = await resolveQuote(fake({ sender: { user_id: 5 }, message: [text('字'.repeat(500))] }), message)
  check(`原文截到 ${QUOTE_MAX_CHARS} 字`, formatQuote(long).length < QUOTE_MAX_CHARS + 20)
  const broken = await resolveQuote({ async call() { throw new Error('消息不存在') } }, message, { isOwnMessage: (id) => id === '77' })
  check('取不到原文：不抛，如实说取不到', broken.ok === false && formatQuote(broken).includes('取不到') && broken.fromSelf)
  check('没有连接：同样不抛', (await resolveQuote(null, message)).ok === false)
  check('没有引用：返回 null', (await resolveQuote(fake({}), { segments: [] })) === null)
  check('替换正文里的“[引用]”占位', withQuote('[引用]这个不对', '[引用 老王: 可以]') === '[引用 老王: 可以]\n这个不对')
  check('只有引用没有正文', withQuote('[引用]', '[引用 老王: 可以]') === '[引用 老王: 可以]')
  check('没有引用行时原样', withQuote('你好', '') === '你好')
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

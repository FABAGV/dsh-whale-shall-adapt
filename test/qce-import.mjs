/**
 * 导入 QQ Chat Exporter 的导出（lib/qq/qce-import.js）、本机客户端（lib/qq/qce-client.js）、模仿群友前拉历史（lib/adapt/persona-history.js）。
 * 全部是合成数据和一个本机假 QCE 服务（随机端口），不连真的 QCE。运行：node test/qce-import.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { importQceExport, toRecord, ownWords, chatFrom, removeImported } from '../lib/qq/qce-import.js'
import { QceClient, checkLoopback } from '../lib/qq/qce-client.js'
import { pullMemberHistory } from '../lib/adapt/persona-history.js'
import { readChatRecords, memberSamples, listCorpusChats } from '../lib/adapt/qq-corpus.js'
import { Corpus } from '../lib/qq/corpus.js'
import { resolveConfig } from '../lib/qq/config.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shall-qce-'))
const log = { info() {}, warn() {}, debug() {}, error() {} }
const T0 = Date.UTC(2026, 9, 1, 4, 0, 0)
const BOT = '10000'
const OWNER = '20000'

let seq = 0
const msg = (uin, text, extra = {}) => ({
  id: String(++seq), seq: String(seq), timestamp: T0 + seq * 60_000, time: '', type: 'type_1',
  sender: { uid: `u_${uin}`, uin, name: `名${uin}`, nickname: `昵${uin}`, ...(extra.groupCard ? { groupCard: extra.groupCard } : {}) },
  content: { text, html: '', elements: [{ type: 'text', data: { text } }, ...(extra.elements ?? [])], resources: [], mentions: [] },
  recalled: Boolean(extra.recalled), system: Boolean(extra.system),
})
const singleExport = (dir, name, chatInfo, messages) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify({ metadata: { name: 'QQChatExporter V5', version: '5.5.77' }, chatInfo, statistics: {}, messages, exportOptions: {} }))
  return file
}

console.log('A. 单条消息')
{
  const ctx = { chatType: 'group', chatId: '555', chatName: '测试群', botQq: BOT, ownerQq: OWNER }
  check('普通消息 → 语料记录，名字优先群名片', toRecord(msg('30001', '你好', { groupCard: '群名片' }), ctx).record?.senderName === '群名片')
  check('系统消息、撤回的、bot 自己说的都跳过', toRecord(msg('30001', 'x', { system: true }), ctx).skip === 'system' && toRecord(msg('30001', 'x', { recalled: true }), ctx).skip === 'recalled' && toRecord(msg(BOT, 'x'), ctx).skip === 'bot')
  check('没有 QQ 号的发言人跳过', toRecord(msg('', 'x'), ctx).skip === 'no-qq')
  check('私聊里只导主人说的话', toRecord(msg('30001', 'x'), { ...ctx, chatType: 'private' }).skip === 'not-owner' && toRecord(msg(OWNER, '我说的'), { ...ctx, chatType: 'private' }).record?.text === '我说的')
  const reply = msg('30001', '[回复 甲: 原文]\n我的回答', { elements: [{ type: 'reply', data: { messageId: '1' } }] })
  check('回复消息去掉 QCE 拼的「[回复 …]」那一行', ownWords(reply) === '我的回答')
  check('没有回复段的消息原样保留', ownWords(msg('3', '[回复 甲: x]\n不是回复')).startsWith('[回复'))
}

console.log('B. 认出是哪个聊天')
{
  check('群聊：文件名 group_<群号>_…', chatFrom({ type: 'group', name: 'x' }, 'C:\\exports\\group_875570087_20261031.json').chatId === '875570087')
  check('群聊：没有群号时报错，可以手动给', Boolean(chatFrom({ type: 'group' }, 'a.json').error) && chatFrom({ type: 'group' }, 'a.json', '123').chatId === '123')
  check('私聊：用 peerUin', chatFrom({ type: 'private', peerUin: '30001' }, 'friend_x.json').chatId === '30001')
  check('不认识的类型报错', Boolean(chatFrom({ type: 'temp' }, 'x.json').error))
}

console.log('C. 导入单文件 JSON')
{
  const dir = tmp()
  const importRoot = path.join(dir, 'shall', 'qq', 'imported')
  const messages = [msg('30001', '第一句'), msg('30002', '第二句'), msg(BOT, 'bot 说的'), msg('30001', 'sys', { system: true }), msg('30001', '撤回的', { recalled: true }), msg('30001', '第三句')]
  const file = singleExport(dir, 'group_555_20261001.json', { type: 'group', name: '测试群', selfUin: BOT }, messages)
  let r = await importQceExport({ source: file, importRoot })
  check('导入成功：从文件名认出群号', r.ok && r.chatType === 'group' && r.chatId === '555', JSON.stringify(r))
  check('条数：6 条里导 3 条，跳过的分原因记', r.total === 6 && r.imported === 3 && r.skipped.system === 1 && r.skipped.recalled === 1 && r.skipped.bot === 1)
  check('bot 自己（chatInfo.selfUin）说的话不导', !fs.readFileSync(path.join(importRoot, 'group-555', fs.readdirSync(path.join(importRoot, 'group-555'))[0]), 'utf8').includes('bot 说的'))
  r = await importQceExport({ source: file, importRoot })
  check('同一份再导一次：全是重复，不会多出来', r.ok && r.imported === 0 && r.duplicate === 3)
  check('不是 QCE 的 JSON：报错', !(await importQceExport({ source: singleExport(dir, 'x.json', null, []), importRoot })).ok)
  check('文件不存在：报错', (await importQceExport({ source: path.join(dir, 'nope.json'), importRoot })).error.includes('找不到'))
  check('私聊没配对主人：拒绝', (await importQceExport({ source: singleExport(dir, 'friend.json', { type: 'private', peerUin: '30001' }, [msg(OWNER, 'x')]), importRoot })).error.includes('配对主人'))
  const priv = await importQceExport({ source: singleExport(dir, 'friend2.json', { type: 'private', peerUin: '30001' }, [msg(OWNER, '主人说的'), msg('30001', '对方说的')]), importRoot, ownerQq: OWNER })
  check('私聊只导主人自己说的话', priv.ok && priv.imported === 1 && priv.skipped['not-owner'] === 1)

  // 读取：和语料库合在一起，不重复
  const corpusRoot = path.join(dir, 'shall', 'qq', 'corpus')
  const corpus = new Corpus({ config: resolveConfig({}), log, root: corpusRoot })
  corpus.append({ chatType: 'group', chatId: '555', kind: 'message', ts: messages[0].timestamp, payload: { senderId: '30001', senderName: '名30001', text: '第一句' } })
  corpus.append({ chatType: 'group', chatId: '555', kind: 'message', ts: T0 + 999 * 60_000, payload: { senderId: '30003', senderName: '新人', text: '接入之后说的' } })
  const found = corpus.search({ chatType: 'group', chatId: '555', limit: 100 })
  check('语料库检索把导入的历史也算上，同一条只出现一次', found.length === 4 && found.filter((x) => x.text === '第一句').length === 1, String(found.length))
  check('检索结果从新到旧', found[0].text === '接入之后说的')
  const records = readChatRecords(corpusRoot, { chatType: 'group', chatId: '555', days: 3650 })
  check('人格侧的读取也合在一起、去重', records.length === 4 && records.filter((x) => x.text === '第一句').length === 1)
  const listed = listCorpusChats(corpusRoot).find((c) => c.key === 'group:555')
  check('会话列表里能看到这个群（含导入的天数）', Boolean(listed) && listed.days >= 1)
  check('“忘掉我”也删导入历史里他的原话', corpus.purgeMember('group', '555', '30001') === 3 && !readChatRecords(corpusRoot, { chatType: 'group', chatId: '555', days: 3650 }).some((x) => x.senderId === '30001'))
  corpus.prune(T0 + 400 * 24 * 3600 * 1000)
  check('保留期清理不碰导入的历史', readChatRecords(corpusRoot, { chatType: 'group', chatId: '555', days: 3650 }).some((x) => x.senderId === '30002'))
  check('按聊天删掉导入的历史', removeImported(importRoot, 'group', '555') >= 1 && !fs.existsSync(path.join(importRoot, 'group-555')))
}

console.log('D. 分块导出')
{
  const dir = tmp()
  const out = path.join(dir, 'export_chunked_jsonl')
  fs.mkdirSync(path.join(out, 'chunks'), { recursive: true })
  const part1 = [msg('30001', 'a1'), msg('30002', 'a2')]
  const part2 = [msg('30001', 'b1'), msg('30001', 'b2', { system: true })]
  fs.writeFileSync(path.join(out, 'chunks', 'c1.jsonl'), part1.map((m) => JSON.stringify(m)).join('\n') + '\n{坏行\n')
  fs.writeFileSync(path.join(out, 'chunks', 'c2.jsonl'), part2.map((m) => JSON.stringify(m)).join('\n'))
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ chatInfo: { type: 'group', name: '大群' }, chunked: { chunksDir: 'chunks', chunks: [{ relativePath: 'chunks/c1.jsonl' }, { relativePath: 'chunks/c2.jsonl' }, { relativePath: '../../outside.jsonl' }] } }))
  const importRoot = path.join(dir, 'imported')
  const r = await importQceExport({ source: out, importRoot, chatId: '777' })
  check('分块导出：读 manifest 和每个 chunk，坏行跳过', r.ok && r.imported === 3 && r.total === 5, JSON.stringify(r))
  check('manifest 里指到目录外的 chunk 不读', !fs.existsSync(path.join(dir, 'outside.jsonl')) && r.ok)
  check('目录里没有 manifest：报错', (await importQceExport({ source: path.join(out, 'chunks'), importRoot, chatId: '777' })).error.includes('manifest'))
}

console.log('E. 本机客户端 + 拉历史')
{
  check('只连本机', checkLoopback('http://127.0.0.1:40653') === '' && checkLoopback('http://localhost:1') === '' && checkLoopback('http://192.168.1.2:40653').includes('只能连本机') && checkLoopback('ftp://127.0.0.1').length > 0)
  const dir = tmp()
  const qceHome = path.join(dir, '.qq-chat-exporter')
  fs.mkdirSync(path.join(qceHome, 'exports'), { recursive: true })
  const securityFile = path.join(qceHome, 'security.json')
  const seen = []
  let failExport = false
  const history = [msg('30001', '历史一'), msg('30001', '历史二'), msg('30001', '历史三'), msg('30001', '历史四'), msg('30001', '历史五'), msg('30001', '历史六')]
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { success: false })
    if (req.url === '/') return send(200, {})
    if (req.url === '/api/messages/export') {
      if (failExport) return send(500, { success: false, error: { message: 'boom' } })
      const b = JSON.parse(body)
      const only = b.filter?.includeUserUins ?? []
      const file = path.join(qceHome, 'exports', `group_${b.peer.peerUid}_x.json`)
      fs.writeFileSync(file, JSON.stringify({ chatInfo: { type: 'group', name: 'g', selfUin: BOT }, messages: history.filter((m) => !only.length || only.includes(m.sender.uin)) }))
      return send(200, { success: true, data: { taskId: 't1', fileName: path.basename(file), status: 'running', messageCount: history.length } })
    }
    if (req.url === '/api/tasks/t1') return send(200, { success: true, data: { id: 't1', status: 'completed', progress: 100, fileName: 'group_555_x.json' } })
    send(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const noSleep = async () => {}

  const missing = new QceClient({ baseUrl, securityFile, sleep: noSleep })
  check('没有 security.json：status 说没装或没开', (await missing.status()).reason.includes('没装或没启动'))
  fs.writeFileSync(securityFile, JSON.stringify({ accessToken: 'test-token' }))
  const qce = new QceClient({ baseUrl, securityFile, sleep: noSleep })
  check('有令牌、服务在：status ok', (await qce.status()).ok === true)
  const exported = await qce.exportGroup({ chatId: '555', days: 30, memberIds: ['30001'] })
  const req = seen.find((x) => x.url === '/api/messages/export')
  check('导出请求：群聊 peer、JSON、时间窗（毫秒）、按人过滤、带令牌', req.body.peer.chatType === 2 && req.body.peer.peerUid === '555' && req.body.format === 'JSON' && req.body.filter.includeUserUins[0] === '30001' && req.body.filter.endTime - req.body.filter.startTime === 30 * 86400000 && req.auth === 'Bearer test-token')
  check('等任务完成，拿到导出文件', fs.existsSync(exported.filePath))
  await check('群号不是数字：拒绝', await qce.exportGroup({ chatId: '../x' }).then(() => false, () => true))
  const remote = new QceClient({ baseUrl: 'http://10.0.0.1:40653', securityFile, sleep: noSleep })
  check('地址不是本机：不发请求就拒绝', await remote.exportGroup({ chatId: '555' }).then(() => false, (e) => e.message.includes('只能连本机')))

  const corpusRoot = path.join(dir, 'shall', 'qq', 'corpus')
  const importRoot = path.join(dir, 'shall', 'qq', 'imported')
  fs.mkdirSync(corpusRoot, { recursive: true })
  const source = { chatType: 'group', chatId: '555', memberId: '30001' }
  check('拉之前：本地语料里没有样本', memberSamples(readChatRecords(corpusRoot, { chatType: 'group', chatId: '555', days: 365 }), '30001').length === 0)
  let t = T0 + 30 * 86400000
  const pulled = await pullMemberHistory({ qce, importRoot, source, days: 365, now: () => t })
  check('拉历史：导入这位群友的 6 条发言', pulled.pulled && pulled.imported === 6, JSON.stringify(pulled))
  check('拉完之后：样本够了', memberSamples(readChatRecords(corpusRoot, { chatType: 'group', chatId: '555', days: 3650 }), '30001').length === 6)
  const before = seen.length
  const cached = await pullMemberHistory({ qce, importRoot, source, days: 365, now: () => t + 3600_000 })
  check('6 小时内不重复拉', cached.cached === true && seen.length === before)
  t += 7 * 3600_000
  failExport = true
  check('QCE 出错：抛出原因（生成人格那边接住、退回本地语料）', await pullMemberHistory({ qce, importRoot, source, days: 365, now: () => t }).then(() => false, (e) => e.message.includes('boom')))
  check('没开 QCE：跳过并说明', (await pullMemberHistory({ qce: null, importRoot, source, days: 30 })).reason.includes('没有开启'))
  check('合并转发里只有名字的人：没法按人导', (await pullMemberHistory({ qce, importRoot, source: { ...source, memberId: 'name:某人' }, days: 30 })).reason.includes('没有 QQ 号'))
  // 结尾用 exitCode 自然退出：句柄还在关闭时 process.exit() 会在 Windows 上撞 libuv 断言（async.c:76）。
  // 断掉 keep-alive 连接，进程才能马上退出
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

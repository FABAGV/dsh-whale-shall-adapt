/**
 * QQ 导出的聊天记录 → 语料（lib/adapt/chat-record-import.js）。
 * 覆盖：JSON / JSONL / 几种纯文本排版、去重、跳过规则、QQNT 备份与 HTML 的明确拒绝，
 * 最后走一遍 readChatRecords → memberStats/memberScenes，证明真的能拿来生成人格。
 * 运行：node test/chat-record-import.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importChatRecords, parsePlainText } from '../lib/adapt/chat-record-import.js'
import { readChatRecords, listMembers } from '../lib/adapt/qq-corpus.js'
import { memberScenes, memberStats, describeHabit } from '../lib/adapt/persona-material.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-chat-import-'))
const importRoot = path.join(tmp, 'imported')
const write = (name, content) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}
const GROUP = { chatType: 'group', chatId: '123456789', chatName: '测试群' }

console.log('A. JSON 数组')
{
  const file = write('a.json', JSON.stringify([
    { timestamp: Date.UTC(2026, 0, 5, 10, 0, 0), sender: { uin: 10001, groupCard: '小王' }, content: { text: '在吗' } },
    { timestamp: Date.UTC(2026, 0, 5, 10, 0, 30), sender: { uin: 20002, name: '小李' }, content: { text: '嗯？' } },
    { timestamp: Date.UTC(2026, 0, 5, 10, 1, 0), sender: { uin: '', name: '广告机' }, content: { text: '系统推广' }, system: true },
    { timestamp: Date.UTC(2026, 0, 5, 10, 2, 0), sender: { uin: 10001 }, content: { text: '' } },
  ]))
  const out = importChatRecords({ file, importRoot, ...GROUP })
  check('导入成功', out.ok === true && out.format === 'json', JSON.stringify(out))
  check('只导真正的人话', out.imported === 2 && out.total === 4)
  check('系统消息与空消息被跳过', (out.skipped.system ?? 0) === 1 && (out.skipped.empty ?? 0) === 1, JSON.stringify(out.skipped))
  check('按日期分片写到 imported/', fs.readdirSync(path.join(importRoot, 'group-123456789')).some((f) => f === '2026-01-05.jsonl'))
}

console.log('B. 重复导入去重')
{
  const file = write('a-again.json', JSON.stringify([
    { timestamp: Date.UTC(2026, 0, 5, 10, 0, 0), sender: { uin: 10001, groupCard: '小王' }, content: { text: '在吗' } },
    { timestamp: Date.UTC(2026, 0, 5, 10, 5, 0), sender: { uin: 10001, groupCard: '小王' }, content: { text: '我又来了' } },
  ]))
  const out = importChatRecords({ file, importRoot, ...GROUP })
  check('同一份再导：只加新的那条', out.imported === 1 && out.duplicate === 1, JSON.stringify({ imported: out.imported, duplicate: out.duplicate }))
}

console.log('C. JSONL')
{
  const lines = [
    { time: 1770000000000, senderId: 30003, senderName: '阿强', message: '谁有空' },
    { time: 1770000060000, senderId: 30003, senderName: '阿强', message: '算了 我自己来' },
  ].map((m) => JSON.stringify(m)).join('\n')
  const out = importChatRecords({ file: write('b.jsonl', lines), importRoot, ...GROUP })
  check('一行一条：都能导', out.ok === true && out.format === 'jsonl' && out.imported === 2, JSON.stringify(out))
}

console.log('D. 纯文本（QQ 自带导出的排版）')
{
  const text = [
    '2024-05-01 12:00:00 小王(10001)',
    '有人打球吗',
    '2024-05-01 12:00:30 小李(20002)',
    '?',
    '2024-05-01 12:01:00 小王(10001)',
    '笑死 你连球都没有',
    '这句是续行',
  ].join('\n')
  const out = importChatRecords({ file: write('c.txt', text), importRoot, ...GROUP })
  check('认出 txt 排版', out.ok === true && out.format === 'txt' && out.imported === 3, JSON.stringify(out))
  const records = readChatRecords(importRoot.replace(/imported$/, 'corpus'), { chatType: 'group', chatId: GROUP.chatId, days: 3650 })
  // 前面几段也写进了同一个聊天，这里只看这一段 txt 的内容
  const fromTxt = records.filter((r) => /打球|球都没有|续行/.test(r.text))
  const wang = fromTxt.filter((r) => r.senderId === '10001')
  check('读回来的人对上了（按 QQ 号）', wang.length === 2, `${wang.length}/${fromTxt.length}`)
  check('多行正文合成一条', wang.some((r) => r.text.includes('这句是续行')))
  check('时间按表头解析', new Date(wang[0].ts).getFullYear() === 2024)
}

console.log('E. 没有时间的纯文本')
{
  const base = Date.UTC(2026, 6, 1, 8, 0, 0)
  const { records, skipped } = parsePlainText('小王：早\n小李：早呀\n小王：今天不上班', GROUP, { fallbackTs: base })
  check('没有时间也能导', records.length === 3 && Object.keys(skipped).length === 0, JSON.stringify(skipped))
  check('时间按顺序每秒递增', records[0].ts === base && records[2].ts === base + 2000, records.map((r) => r.ts).join(','))
  check('认得出名字（没 QQ 号时用名字）', records[0].senderName === '小王' && records[0].senderId === '')
}

console.log('F. 明确拒绝的格式')
{
  const html = importChatRecords({ file: write('d.html', '<html></html>'), importRoot, ...GROUP })
  check('HTML 导出：说清怎么办', html.ok === false && html.error.includes('txt'), html.error)

  const fakeZip = path.join(tmp, 'e.bak')
  fs.writeFileSync(fakeZip, Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 7)]))
  const bak = importChatRecords({ file: fakeZip, importRoot, ...GROUP })
  check('QQNT 备份（zip）：认出来并说清需要密钥', bak.ok === false && bak.error.includes('密钥'), bak.error)

  const garbage = importChatRecords({ file: write('f.txt', '完全不是聊天记录\n随便两行'), importRoot, ...GROUP })
  check('认不出格式：报错而不是静默导 0 条', garbage.ok === false, garbage.error)
}

console.log('G. 参数校验')
{
  check('群号必须是数字', importChatRecords({ file: write('g.json', '[]'), importRoot, chatType: 'group', chatId: 'abc' }).ok === false)
  check('文件不存在', importChatRecords({ file: path.join(tmp, 'nope.json'), importRoot, ...GROUP }).ok === false)
}

console.log('H. 导进来的记录能直接生成人格素材')
{
  const records = readChatRecords(importRoot.replace(/imported$/, 'corpus'), { chatType: 'group', chatId: GROUP.chatId, days: 3650 })
  const members = listMembers(records)
  check('群成员能列出来', members.length >= 3, members.map((m) => m.memberId).join(','))
  const stats = memberStats(records, '10001')
  check('能算出说话统计', stats?.messages >= 2, String(stats?.messages))
  check('统计能写成人话（含口头常用）', describeHabit(stats).includes('一条消息通常'))
  const scenes = memberScenes(records, '10001', { maxChars: 5000 })
  check('能切出「别人说→他接」的场景', scenes.length >= 1 && scenes.some((s) => s.lines.some((l) => l.who === 'self')), String(scenes.length))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

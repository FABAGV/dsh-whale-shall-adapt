/**
 * 把「从别处导出来的聊天记录」转成插件自己的语料形状，好让人格生成直接用它。
 *
 * 为什么需要它：模仿群友的素材只有两个来源 —— 插件在线收到的语料，和 QQ Chat Exporter
 * （NapCat 插件）导出的 JSON。用户手上更常见的是 QQ 自带「导出消息记录」的 txt、别的工具
 * 导出的 JSON / JSONL，格式各不相同，之前只能干瞪眼。这里统一收口。
 *
 * 写到哪里：`$DSH_HOME/shall/qq/imported/<group|private>-<号>/<YYYY-MM-DD>.jsonl`，
 * 与 `lib/qq/qce-import.js` 同一个目录、同一种记录形状（`readChatRecords()` 会把它和语料库合并读）。
 * 这个目录不参与语料的 30 天清理，控制台里可以整聊删除。
 *
 * 支持的格式（自动识别）：
 *   1. JSON：一条消息一个对象的数组，或 `{ messages: [...] }` / `{ data: [...] }`
 *   2. JSONL：每行一条消息（QCE 的分块导出就是这种）
 *   3. 纯文本：QQ「导出消息记录」/ 聊天记录复制出来的常见排版：
 *        `2024-05-01 12:34:56 昵称(123456)` 下一行正文
 *        `[2024-05-01 12:34:56] 昵称(123456): 正文`
 *        `昵称(123456) 2024-05-01 12:34:56` 下一行正文
 *        只有 `昵称(123456)：正文`（没有时间）—— 时间按文件修改时间往前倒推，每秒一条
 *      没有表头的下一行算上一条的续行。
 *   4. 认出来是 QQNT 的备份（zip 里的 SQLCipher 数据库）或 HTML/MHT 导出时**明确拒绝**并说清原因。
 *
 * 隐私：不导系统消息、不导空消息；正文过一遍脱敏留给下游（`memberScenes` / `memberStats` 会做）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { recordKey } from '../qq/qce-import.js'

const TEXT_MAX = 2000
const NAME_MAX = 60
const QQ = /^\d{5,12}$/
const CHAT_ID = /^\d{1,12}$/
const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 一行表头：`2024-05-01 12:34:56 昵称(123456)`、`[2024-05-01 12:34] 昵称: 正文`、`昵称 2024/05/01 12:34 正文` */
const DATE_RE = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?/
const BRACKET_HEAD = /^\s*[\[【(（]/
const NAME_QQ = /([^\s:：()（）\[\]【】]{1,40})\s*[(（]\s*(\d{5,12})\s*[)）]/
const NAME_COLON = /^([^\s:：]{1,40})\s*[:：]\s*(.*)$/
const INVISIBLE = /^[\u200b\ufeff]+/

const stripBom = (text) => String(text ?? '').replace(/^\ufeff/, '')
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

function localDate(y, mo, d, h, mi, s) {
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0))
  const ts = date.getTime()
  return Number.isFinite(ts) ? ts : 0
}

/** 把各种形状的时间戳折成毫秒 */
function toTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒 / 毫秒 / 微秒都见过
    if (value >= 1e15) return Math.round(value / 1000)
    if (value >= 1e12) return Math.round(value)
    if (value >= 1e9) return Math.round(value * 1000)
    return 0
  }
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d{10}$/.test(text)) return Number(text) * 1000
  if (/^\d{13}$/.test(text)) return Number(text)
  const m = DATE_RE.exec(text)
  if (m) return localDate(m[1], m[2], m[3], m[4], m[5], m[6])
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 正文：字符串 / 分段数组 / {text} 都认 */
function bodyOf(message) {
  const raw = message?.content ?? message?.text ?? message?.message ?? message?.msg ?? message?.body
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((seg) => {
        if (typeof seg === 'string') return seg
        if (seg?.type === 'text') return String(seg?.data?.text ?? seg?.text ?? '')
        if (seg?.type === 'image' || seg?.type === 'face' || seg?.type === 'mface') return ''
        return String(seg?.data?.text ?? seg?.text ?? '')
      })
      .join('')
  }
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.elements)) return bodyOf({ content: raw.elements })
    return String(raw.text ?? '')
  }
  return ''
}

/**
 * 一条外部消息对象 → 语料记录。认不出的字段就跳过（宁可少导，也不要导进错的人名下）。
 * @returns {{record?: object, skip?: string}}
 */
export function normalizeMessage(message, ctx) {
  if (!message || typeof message !== 'object') return { skip: 'bad' }
  if (message.system || message.type === 'system' || message.type === 'event') return { skip: 'system' }
  if (message.recalled || message.revoked) return { skip: 'recalled' }
  const sender = message.sender ?? message.author ?? {}
  const senderIdRaw = message.senderId ?? message.qq ?? message.uin ?? message.userId ?? message.from ?? sender.uin ?? sender.qq ?? sender.id
  const senderId = String(senderIdRaw ?? '').trim()
  const senderName = String(
    message.senderName ?? message.nickname ?? message.name ?? sender.groupCard ?? sender.card ?? sender.name ?? sender.nickname ?? senderId,
  ).trim().slice(0, NAME_MAX)
  if (!QQ.test(senderId) && !senderName) return { skip: 'no-sender' }
  const ts = toTs(message.ts ?? message.timestamp ?? message.time ?? message.msgTime ?? message.sendTime ?? message.date)
  if (!ts) return { skip: 'no-time' }
  const text = bodyOf(message).replace(/\r/g, '').trim().slice(0, TEXT_MAX)
  if (!text) return { skip: 'empty' }
  return {
    record: {
      kind: 'message',
      ts,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      chatName: ctx.chatName,
      messageId: String(message.id ?? message.messageId ?? message.msgId ?? ''),
      senderId: QQ.test(senderId) ? senderId : '',
      senderName: senderName || senderId,
      text,
      segments: [],
      source: 'import',
    },
  }
}

/** 解析纯文本导出。没时间的条目按 `fallbackTs` 往前每秒一条倒推。 */
export function parsePlainText(text, ctx, { fallbackTs = Date.now() } = {}) {
  const lines = stripBom(text).replace(/\r/g, '').split('\n')
  const out = []
  const skipped = {}
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1)
  let current = null
  let derived = fallbackTs
  const push = () => {
    if (!current) return
    const body = current.text.join('\n').trim().slice(0, TEXT_MAX)
    if (!body) {
      skip('empty')
    } else if (!current.name && !current.id) {
      skip('no-sender')
    } else {
      out.push({
        kind: 'message',
        ts: current.ts,
        chatType: ctx.chatType,
        chatId: ctx.chatId,
        chatName: ctx.chatName,
        messageId: '',
        senderId: current.id,
        senderName: (current.name || current.id).slice(0, NAME_MAX),
        text: body,
        segments: [],
        source: 'import',
      })
    }
    current = null
  }

  for (const raw of lines) {
    const line = raw.replace(INVISIBLE, '')
    if (!line.trim()) {
      // 空行：QQ 复制出来的记录里，正文里的空行很少见；当成上一条结束
      push()
      continue
    }
    const dateMatch = DATE_RE.exec(line)
    const head = line.replace(BRACKET_HEAD, '')
    // 有表头时先剥掉时间部分，剩下的才可能是「名字(QQ) 正文」
    const rest = dateMatch
      ? head.slice(dateMatch.index + dateMatch[0].length).replace(/^[\s\]】:：]+/, '').trim()
      : head.trim()
    const nameQq = NAME_QQ.exec(rest)
    const nameColon = NAME_COLON.exec(rest)

    if (dateMatch) {
      push()
      let name = ''
      let id = ''
      let body = ''
      if (nameQq) {
        name = nameQq[1].trim()
        id = nameQq[2]
        body = rest.slice(nameQq.index + nameQq[0].length).replace(/^[\s:：]+/, '')
      } else if (nameColon) {
        name = nameColon[1].trim()
        body = nameColon[2]
      } else {
        body = rest
      }
      current = { ts: toTs(dateMatch[0]) || derived, name, id: QQ.test(id) ? id : '', text: body ? [body] : [] }
    } else if (nameQq && rest === line.trim()) {
      // `小王(10001)` 单独一行（QQ 自带导出的排版）：正文在下一行
      push()
      const after = rest.slice(nameQq.index + nameQq[0].length).replace(/^[\s:：]+/, '')
      current = { ts: derived, name: nameQq[1].trim(), id: nameQq[2], text: after ? [after] : [] }
    } else if (nameColon && (!current || current.name !== nameColon[1].trim())) {
      // `小王：正文` 连排：换了个名字就是新的一条，同一个名字继续算续行
      push()
      current = { ts: derived, name: nameColon[1].trim(), id: '', text: [nameColon[2]] }
    } else if (current) {
      current.text.push(line)
      continue
    } else {
      skip('no-header')
      continue
    }
    derived += 1000
  }
  push()
  return { records: out, skipped }
}

function parseJsonLike(text) {
  const body = stripBom(text).trim()
  if (!body) return null
  if (body.startsWith('[')) {
    try {
      const arr = JSON.parse(body)
      return Array.isArray(arr) ? { messages: arr } : null
    } catch {
      return null
    }
  }
  if (body.startsWith('{') && !body.includes('\n{')) {
    try {
      const obj = JSON.parse(body)
      const list = obj?.messages ?? obj?.data ?? obj?.list
      if (Array.isArray(list)) return { messages: list }
      if (Array.isArray(obj?.chatInfo?.messages)) return { messages: obj.chatInfo.messages }
      return null
    } catch {
      return null
    }
  }
  // JSONL
  const messages = []
  let any = false
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('# ') || t.startsWith('// ')) continue
    try {
      const value = JSON.parse(t)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        messages.push(value)
        any = true
      }
    } catch {
      /* 不是 JSON 的行就跳过 */
    }
  }
  return any ? { messages } : null
}

/** QQNT 备份 / HTML 导出：认出来就说清楚，不假装能转 */
export function detectUnsupported(file) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.mht') || lower.endsWith('.mhtml')) {
    return '这是 HTML / MHT 导出，暂不支持：请用 QQ 的「导出为 txt」或 QQ Chat Exporter 的 JSON 再导一次'
  }
  if (lower.endsWith('.bak') || lower.endsWith('.zip')) {
    return '这看起来是 QQNT 的备份包（zip 里是加密的 SQLite，需要 QQ 自己的密钥），不是能直接读的聊天记录：请在 QQ 里「导出消息记录 → txt」，或用 QQ Chat Exporter 导出 JSON'
  }
  return ''
}

/**
 * 把一个导出文件导入成语料。同一个人、同一秒、同样开头的正文算重复（和语料库 / QCE 导入同一判据）。
 *
 * @param {{file: string, importRoot: string, chatType: 'group'|'private', chatId: string, chatName?: string}} input
 * @returns {{ok: boolean, error?: string, format?: string, total?: number, imported?: number, duplicate?: number, skipped?: Record<string, number>, firstTs?: number, lastTs?: number, dir?: string}}
 */
export function importChatRecords({ file, importRoot, chatType, chatId, chatName = '' }) {
  if (!['group', 'private'].includes(chatType)) return { ok: false, error: '聊天类型只能是 group / private' }
  const id = String(chatId ?? '').trim()
  if (!CHAT_ID.test(id)) return { ok: false, error: '聊天号必须是 1–12 位数字' }
  if (!file || !fs.existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
  const unsupported = detectUnsupported(file)
  if (unsupported) {
    // .bak/.zip 有可能是真的 zip 聊天记录，先看一眼文件头再回绝
    if (/\.(bak|zip)$/i.test(file)) {
      const head = readHead(file, 4)
      if (head !== 'PK03') return { ok: false, error: unsupported }
    } else {
      return { ok: false, error: unsupported }
    }
  }

  const ctx = { chatType, chatId: id, chatName: String(chatName ?? '').slice(0, NAME_MAX) }
  const text = fs.readFileSync(file, 'utf8')
  let parsed = null
  let format = ''
  const json = parseJsonLike(text)
  if (json) {
    parsed = { records: [], skipped: {} }
    format = text.trim().startsWith('[') || (text.trim().startsWith('{') && !text.includes('\n{')) ? 'json' : 'jsonl'
    for (const message of json.messages) {
      const out = normalizeMessage(message, ctx)
      if (out.skip) parsed.skipped[out.skip] = (parsed.skipped[out.skip] ?? 0) + 1
      else parsed.records.push(out.record)
    }
  } else {
    format = 'txt'
    parsed = parsePlainText(text, ctx)
    if (parsed.records.length === 0) {
      return { ok: false, error: `没认出来这是哪种导出（试过 JSON / JSONL / txt 排版）：${file}` }
    }
  }

  const dir = path.join(importRoot, `${chatType}-${id}`)
  fs.mkdirSync(dir, { recursive: true })
  // 已有的键（含之前导过的）用来去重
  const known = new Set()
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!DAY.test(name)) continue
    let existing = ''
    try {
      existing = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue
      try {
        known.add(recordKey(JSON.parse(line)))
      } catch {
        /* 坏行就跳过 */
      }
    }
  }

  const byDay = new Map()
  let imported = 0
  let duplicate = 0
  let firstTs = 0
  let lastTs = 0
  parsed.records.sort((a, b) => a.ts - b.ts)
  for (const record of parsed.records) {
    const key = recordKey(record)
    if (known.has(key)) {
      duplicate += 1
      continue
    }
    known.add(key)
    const day = dayKey(record.ts)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(JSON.stringify(record))
    imported += 1
    firstTs = firstTs ? Math.min(firstTs, record.ts) : record.ts
    lastTs = Math.max(lastTs, record.ts)
  }
  for (const [day, lines] of byDay) fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  return {
    ok: true,
    format,
    total: parsed.records.length + Object.values(parsed.skipped).reduce((a, b) => a + b, 0),
    imported,
    duplicate,
    skipped: parsed.skipped,
    firstTs,
    lastTs,
    dir,
  }
}

function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    fs.readSync(fd, buf, 0, bytes, 0)
    fs.closeSync(fd)
    return buf.toString('latin1').replace(/[^\x20-\x7e]/g, '')
  } catch {
    return ''
  }
}

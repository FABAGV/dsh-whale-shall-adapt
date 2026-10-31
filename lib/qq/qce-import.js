/**
 * 导入 QQ Chat Exporter（napcat-plugin-qce）导出的聊天记录，让成员记忆、群概况、模仿群友、群总结用上 bot 接入之前的历史。
 *
 * 只读对方导出的文件，不碰对方的代码（它是 GPL-3.0，我们只解析数据格式）。支持两种导出：
 *   - 单文件 JSON：{ metadata, chatInfo, statistics, messages: [CleanMessage], exportOptions }
 *   - 分块 JSONL：目录里有 manifest.json（chatInfo、chunked.chunks[].relativePath），每个 chunk 一行一条 CleanMessage
 * CleanMessage 用到的字段：id、timestamp（毫秒）、sender{uin, name, groupCard, nickname}、content{text, elements}、recalled、system。
 *
 * 写到 `$DSH_HOME/shall/qq/imported/<group|private>-<号>/<YYYY-MM-DD>.jsonl`，和语料库同一种记录形状，但**不参与 30 天清理**；
 * 控制台可以按聊天整个删掉。同一份文件导两次不会重复（按 发言人 + 秒 + 正文 去重）。
 *
 * 过滤：系统消息、撤回的消息、没有 QQ 号的发言人、bot 自己说的话都不导；私聊只保留配对主人说的话（别人在私聊里说的不记）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/** 单文件 JSON 只能整个读进内存，再大就请用分块导出 */
export const MAX_SINGLE_JSON_BYTES = 512 * 1024 * 1024
const TEXT_MAX = 2000
const NAME_MAX = 60
const QQ = /^\d{5,12}$/
const CHAT_ID = /^\d{1,12}$/

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

/** 导入记录去重用的键：同一个人、同一秒、同样开头的正文就是同一条（和语料库里的同一条消息也撞得上） */
export function recordKey(record) {
  return `${record.senderId}|${Math.floor((Number(record.ts) || 0) / 1000)}|${String(record.text ?? '').slice(0, 40)}`
}

/** 去掉 QCE 在回复消息正文前拼的「[回复 某人: 原文]」那一行，只留这个人自己说的话 */
export function ownWords(message) {
  let text = String(message?.content?.text ?? '').replace(/\r/g, '')
  const isReply = (message?.content?.elements ?? []).some((e) => e?.type === 'reply')
  if (isReply && text.startsWith('[回复 ')) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  return text.trim().slice(0, TEXT_MAX)
}

/**
 * 一条 CleanMessage → 语料记录；该跳过的返回 { skip: 原因 }。
 * @param {object} message
 * @param {{ chatType: string, chatId: string, chatName: string, botQq?: string, ownerQq?: string }} ctx
 */
export function toRecord(message, ctx) {
  if (!message || typeof message !== 'object') return { skip: 'bad' }
  if (message.system) return { skip: 'system' }
  if (message.recalled) return { skip: 'recalled' }
  const senderId = String(message.sender?.uin ?? '')
  if (!QQ.test(senderId)) return { skip: 'no-qq' }
  if (ctx.botQq && senderId === ctx.botQq) return { skip: 'bot' }
  if (ctx.chatType === 'private' && senderId !== ctx.ownerQq) return { skip: 'not-owner' }
  const ts = Number(message.timestamp)
  if (!Number.isFinite(ts) || ts <= 0) return { skip: 'bad' }
  const text = ownWords(message)
  if (!text) return { skip: 'empty' }
  const sender = message.sender ?? {}
  const senderName = String(sender.groupCard || sender.name || sender.nickname || senderId).slice(0, NAME_MAX)
  return {
    record: {
      kind: 'message',
      ts,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      chatName: ctx.chatName,
      messageId: String(message.id ?? ''),
      senderId,
      senderName,
      text,
      segments: (message.content?.elements ?? []).map((e) => String(e?.type ?? '')).filter(Boolean).slice(0, 20),
      source: 'qce',
    },
  }
}

/** 从 chatInfo 和文件名推出是哪个聊天。QCE 的群聊 chatInfo 里不一定有群号，文件名是 group_<群号>_… */
export function chatFrom(chatInfo, fileName, given = '') {
  const type = String(chatInfo?.type ?? '')
  const chatType = type === 'group' ? 'group' : type === 'private' || type === 'friend' ? 'private' : ''
  if (!chatType) return { error: `不认识的聊天类型：${type || '（空）'}（只支持群聊和私聊）` }
  let chatId = String(given ?? '').trim()
  if (!chatId && CHAT_ID.test(String(chatInfo?.peerUin ?? ''))) chatId = String(chatInfo.peerUin)
  if (!chatId && CHAT_ID.test(String(chatInfo?.peerUid ?? ''))) chatId = String(chatInfo.peerUid)
  if (!chatId) chatId = /^group_(\d{1,12})_/.exec(path.basename(String(fileName ?? '')))?.[1] ?? ''
  if (!CHAT_ID.test(chatId)) return { error: chatType === 'group' ? '导出文件里找不到群号，请手动填群号' : '导出文件里找不到对方的 QQ 号，请手动填' }
  return { chatType, chatId, chatName: String(chatInfo?.name ?? '').slice(0, NAME_MAX), selfUin: String(chatInfo?.selfUin ?? '') }
}

/** 把一份导出的位置解析成 { kind: 'single'|'chunked', file|dir, manifest } */
function locate(source) {
  const p = path.resolve(String(source ?? '').trim())
  let stat
  try {
    stat = fs.statSync(p)
  } catch {
    return { error: `找不到：${p}` }
  }
  if (stat.isDirectory()) {
    const manifest = path.join(p, 'manifest.json')
    if (!fs.existsSync(manifest)) return { error: '这个目录里没有 manifest.json（分块导出才有它）；单文件导出请直接选 .json 文件' }
    return { kind: 'chunked', dir: p, file: manifest }
  }
  if (path.basename(p) === 'manifest.json') return { kind: 'chunked', dir: path.dirname(p), file: p }
  if (!/\.json$/i.test(p)) return { error: '只支持 QQ Chat Exporter 导出的 .json 文件或分块导出的目录' }
  if (stat.size > MAX_SINGLE_JSON_BYTES) return { error: `文件太大（${Math.round(stat.size / 1048576)} MB），请在 QQ Chat Exporter 里改用分块 JSONL 导出` }
  return { kind: 'single', file: p, bytes: stat.size }
}

/** 逐条吐出导出里的消息，不一次读进内存（分块导出时） */
async function* messagesOf(where, manifest) {
  if (where.kind === 'single') {
    for (const message of manifest.messages ?? []) yield message
    return
  }
  const chunks = Array.isArray(manifest?.chunked?.chunks) ? manifest.chunked.chunks : []
  for (const chunk of chunks) {
    const rel = String(chunk?.relativePath ?? path.join(manifest.chunked?.chunksDir ?? 'chunks', String(chunk?.fileName ?? '')))
    const file = path.resolve(where.dir, rel)
    // 只读 manifest 所在目录里面的文件
    if (!file.startsWith(path.resolve(where.dir) + path.sep) || !fs.existsSync(file)) continue
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line)
      } catch {
        yield null
      }
    }
  }
}

/** 已经导进来的记录的去重键（只读要写入的那几天） */
function existingKeys(dir, day, cache) {
  if (cache.has(day)) return cache.get(day)
  const keys = new Set()
  const file = path.join(dir, `${day}.jsonl`)
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        keys.add(recordKey(JSON.parse(line)))
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  cache.set(day, keys)
  return keys
}

/**
 * 导入一份导出。
 * @param {object} opts
 * @param {string} opts.source 导出的 .json 文件，或分块导出的目录 / manifest.json
 * @param {string} opts.importRoot `$DSH_HOME/shall/qq/imported`
 * @param {string} [opts.chatId] 导出里找不到群号时手动给
 * @param {string} [opts.botQq] bot 自己的 QQ 号：它说的话不导
 * @param {string} [opts.ownerQq] 配对的主人：私聊只导他说的话
 * @returns {Promise<{ ok: true, chatType, chatId, chatName, total, imported, duplicate, skipped: object, firstTs, lastTs } | { ok: false, error: string }>}
 */
export async function importQceExport({ source, importRoot, chatId: givenChatId = '', botQq = '', ownerQq = '' }) {
  const where = locate(source)
  if (where.error) return { ok: false, error: where.error }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(where.file, 'utf8'))
  } catch (error) {
    return { ok: false, error: `读不懂这个文件（不是 QQ Chat Exporter 的 JSON 导出？）：${error?.message ?? error}` }
  }
  if (!manifest?.chatInfo || (where.kind === 'single' && !Array.isArray(manifest.messages))) {
    return { ok: false, error: '不是 QQ Chat Exporter 的 JSON 导出（缺少 chatInfo / messages）' }
  }
  const chat = chatFrom(manifest.chatInfo, where.kind === 'single' ? where.file : where.dir, givenChatId)
  if (chat.error) return { ok: false, error: chat.error }
  if (chat.chatType === 'private' && !QQ.test(String(ownerQq ?? ''))) {
    return { ok: false, error: '私聊记录只导入主人自己说的话，请先在 QQ 页配对主人' }
  }
  // QCE 跑在 NapCat 里，导出用的是 bot 登录的号：chatInfo.selfUin 就是 bot 自己，它说的话不导
  const bot = QQ.test(botQq) ? botQq : QQ.test(chat.selfUin) ? chat.selfUin : ''
  const ctx = { chatType: chat.chatType, chatId: chat.chatId, chatName: chat.chatName, botQq: bot, ownerQq: String(ownerQq ?? '') }
  const dir = path.join(importRoot, `${chat.chatType}-${chat.chatId}`)
  fs.mkdirSync(dir, { recursive: true })

  const keyCache = new Map()
  const pending = new Map()
  const skipped = {}
  let total = 0
  let imported = 0
  let duplicate = 0
  let firstTs = 0
  let lastTs = 0
  const flush = () => {
    for (const [day, lines] of pending) if (lines.length) fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
    pending.clear()
  }
  for await (const message of messagesOf(where, manifest)) {
    total += 1
    const out = toRecord(message, ctx)
    if (out.skip) {
      skipped[out.skip] = (skipped[out.skip] ?? 0) + 1
      continue
    }
    const record = out.record
    const day = dayKey(record.ts)
    const keys = existingKeys(dir, day, keyCache)
    const key = recordKey(record)
    if (keys.has(key)) {
      duplicate += 1
      continue
    }
    keys.add(key)
    if (!pending.has(day)) pending.set(day, [])
    pending.get(day).push(JSON.stringify(record))
    imported += 1
    firstTs = firstTs ? Math.min(firstTs, record.ts) : record.ts
    lastTs = Math.max(lastTs, record.ts)
    if (imported % 5000 === 0) flush()
  }
  flush()
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* 目录不空就留着 */
  }
  return { ok: true, chatType: chat.chatType, chatId: chat.chatId, chatName: chat.chatName, total, imported, duplicate, skipped, firstTs, lastTs }
}

/** 删掉某个聊天导入的全部记录 */
export function removeImported(importRoot, chatType, chatId) {
  if (!['group', 'private'].includes(chatType) || !CHAT_ID.test(String(chatId))) return -1
  const dir = path.join(importRoot, `${chatType}-${chatId}`)
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir).length
  fs.rmSync(dir, { recursive: true, force: true })
  return files
}

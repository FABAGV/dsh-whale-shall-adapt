/**
 * 模仿群友之前，先用本机的 QQ Chat Exporter 把这个人在这个群里最近一段时间说过的话导出来、导进语料（lib/qq/qce-import.js），
 * 这样样本不只有 bot 接入之后、语料保留期之内的那一点，模仿得更准。
 *
 * 只导这个人的话（includeUserUins）：实测按人过滤的导出很快，整群全量导出很慢（活跃群几万条要好几分钟）。
 * 他接话时的“前文”在本地语料覆盖的那段时间里照样有。
 * 同一个人 6 小时内只拉一次（记在 importRoot/qce-pulls.json）。QQ Chat Exporter 没装、没开、连不上，都只是跳过，退回本地语料。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from '../core/fs-atomic.js'
import { importQceExport } from '../qq/qce-import.js'

export const PULL_MIN_INTERVAL_MS = 6 * 3600 * 1000

function readPulls(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/**
 * @param {object} opts
 * @param {import('../qq/qce-client.js').QceClient|null} opts.qce
 * @param {string} opts.importRoot `$DSH_HOME/shall/qq/imported`
 * @param {{ chatType: string, chatId: string, memberId: string }} opts.source 人格的来源（哪个群、哪位群友）
 * @param {number} opts.days 拉最近多少天
 * @returns {Promise<{ pulled: boolean, reason?: string, imported?: number, total?: number, cached?: boolean }>}
 */
export async function pullMemberHistory({ qce, importRoot, source, days, progress = () => {}, signal, now = () => Date.now(), minIntervalMs = PULL_MIN_INTERVAL_MS, timeoutMs }) {
  if (!qce) return { pulled: false, reason: '没有开启“从 QQ Chat Exporter 拉历史”' }
  if (source?.chatType !== 'group') return { pulled: false, reason: '只有群友人格会从 QQ Chat Exporter 拉历史' }
  const memberId = String(source.memberId ?? '')
  if (!/^\d{5,12}$/.test(memberId)) return { pulled: false, reason: '这位群友没有 QQ 号（只在合并转发里出现过），没法按人导出' }
  const key = `group:${source.chatId}:${memberId}`
  const metaFile = path.join(importRoot, 'qce-pulls.json')
  const pulls = readPulls(metaFile)
  const last = pulls[key]
  if (last && now() - Number(last.at) < minIntervalMs && Number(last.days) >= days) {
    return { pulled: false, cached: true, reason: `${Math.max(1, Math.round((now() - last.at) / 60000))} 分钟前刚拉过` }
  }
  const status = await qce.status()
  if (!status.ok) return { pulled: false, reason: status.reason }
  progress(`用 QQ Chat Exporter 导出这位群友最近 ${days} 天的发言…`)
  const exported = await qce.exportGroup({ chatId: source.chatId, days, memberIds: [memberId], signal, onProgress: progress, ...(timeoutMs ? { timeoutMs } : {}) })
  progress(`导入 ${exported.messageCount || ''} 条发言…`)
  const result = await importQceExport({ source: exported.filePath, importRoot, chatId: source.chatId })
  if (!result.ok) return { pulled: false, reason: result.error }
  pulls[key] = { at: now(), days, imported: result.imported, total: result.total }
  writeJsonAtomic(metaFile, pulls)
  return { pulled: true, imported: result.imported, total: result.total }
}

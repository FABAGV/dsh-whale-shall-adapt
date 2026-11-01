/**
 * 记忆书架的「种子」：启动时把 `seeds.json` 里还没有的条目写进统一记忆层。
 *
 * 为什么要有这个口子：给模型用的写记忆通道只有交班 / 空闲整理那条（得等它自己跑）
 * 和 `shall_qq_memory`（只能写本会话、不认 area）。用户想手动开一个新书架、往里灌几条
 * 规则时没有入口 —— 这个文件就是那个人口。
 *
 * 规则：
 *   - 文件在 `<memory.dir>/seeds.json`，形状：`{ "entries": [ { scope, area, kind, text } ] }`
 *   - 幂等：同一范围内已经有一模一样的文字就不再写（`observe` 自己也会去重，这里先筛一遍，免得白刷账本）。
 *     比对用的是**脱敏后**的文字（见下面的 `redact`），否则带 IP / 口令的种子每次重启都会重写一遍。
 *   - 出错只记 warn，绝不让启动失败（记忆少的代价远小于起不来）
 */
import fs from 'node:fs'
import path from 'node:path'
import { redact } from '../core/redact.js'
import { KINDS } from '../memory/index.js'

/** 写种子的人：origin 要能落成 user，`observe` 才把这条当用户自己的话 */
const SEEDS_ACTOR = 'user:seeds'
const SEEDS_FILE = 'seeds.json'

/**
 * @param {import('../memory/index.js').MemoryStore} memory
 * @param {{log?: any, file?: string}} [opts]
 * @returns {{applied: number, skipped: number}}
 */
export function applyMemorySeeds(memory, { log = null, file } = {}) {
  const empty = { applied: 0, skipped: 0 }
  if (!memory) return empty
  const target = file ?? path.join(String(memory.dir ?? ''), SEEDS_FILE)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.warn?.(`[memory] seeds.json 读不懂，这次跳过：${error?.message ?? error}`)
    return empty
  }
  const list = Array.isArray(parsed?.entries) ? parsed.entries : []
  if (list.length === 0) return empty

  let applied = 0
  let skipped = 0
  for (const raw of list) {
    const scope = String(raw?.scope ?? 'shared').trim()
    const area = String(raw?.area ?? '').trim()
    const kind = KINDS.has(raw?.kind) ? raw.kind : 'note'
    const text = redact(String(raw?.text ?? '')).trim()
    if (!text) {
      skipped += 1
      continue
    }
    let exists = false
    try {
      // ⚠️ 必须拿**脱敏后**的 text 去比：`observe` 落盘前会统一脱敏，直接用原文比对时，
      // 只要种子里有 IP / 口令之类被脱敏的内容，每次都"查不到"→ 每次重启重复写一条。
      exists = memory.list({ scope }).some((entry) => entry.text === text)
    } catch {
      /* 查重失败就老老实实往下写，observe 自己还会去重 */
    }
    if (exists) {
      skipped += 1
      continue
    }
    const out = memory.observe({ scope, area, kind, text, actor: SEEDS_ACTOR, origin: 'user', importanceDelta: 2, confidence: 1 })
    if (out?.id) applied += 1
    else {
      skipped += 1
      log?.warn?.(`[memory] 种子没写进去（${scope}）：${out?.reason ?? '未知原因'}`)
    }
  }
  if (applied > 0) {
    try {
      memory.flush()
    } catch (error) {
      log?.warn?.(`[memory] 种子落盘失败：${error?.message ?? error}`)
    }
  }
  return { applied, skipped }
}

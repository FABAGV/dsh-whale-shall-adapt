/**
 * 梗百科词库导入：把用户手上的 memewiki 格式 SQLite 词库复制到 `$DSH_HOME/shall/meme/memes.db`。
 *
 * 规矩照 astrbot_plugin_memewiki v1.7.0（MIT）的同步脚本：先校验，再写临时文件，最后替换；
 * 新库条数少于旧库时拒绝覆盖（防止拿一个残缺的库把好库冲掉），除非调用方明确 force。
 * 词库内容来自 cnmeme.wiki，不随本插件分发。
 */
import fs from 'node:fs'
import path from 'node:path'

const REQUIRED_COLUMNS = ['title', 'slug', 'tags', 'usage', 'origin']

async function openDb(file) {
  let Db
  try {
    ;({ DatabaseSync: Db } = await import('node:sqlite'))
  } catch {
    return { error: '当前 Node 没有 node:sqlite（需要 22.5 或更新）' }
  }
  try {
    return { db: new Db(file, { readOnly: true }) }
  } catch (error) {
    return { error: `打不开：${error?.message ?? error}` }
  }
}

/** 检查一个文件是不是能用的 memewiki 词库：{ ok, count?, error? } */
export async function inspectMemeDb(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' }
  const { db, error } = await openDb(file)
  if (!db) return { ok: false, error }
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('memes')").all().map((r) => r.name)
    const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c))
    if (cols.length === 0) return { ok: false, error: '里面没有 memes 表，不是 memewiki 的词库' }
    if (missing.length) return { ok: false, error: `memes 表缺少列：${missing.join('、')}` }
    const integrity = db.prepare('PRAGMA quick_check').get()
    const verdict = integrity ? Object.values(integrity)[0] : 'ok'
    if (verdict !== 'ok') return { ok: false, error: `文件损坏：${verdict}` }
    return { ok: true, count: Number(db.prepare('SELECT count(*) AS c FROM memes').get().c) }
  } catch (error) {
    return { ok: false, error: `读不出来：${error?.message ?? error}` }
  } finally {
    db.close()
  }
}

/**
 * 导入词库。
 * @param {string} source 用户给的词库文件
 * @param {string} target 目标路径（$DSH_HOME/shall/meme/memes.db）
 * @param {{ force?: boolean }} [options] force=true 时允许用条数更少的库覆盖
 * @returns {Promise<{ ok: boolean, count?: number, previous?: number, error?: string }>}
 */
export async function importMemeDb(source, target, { force = false } = {}) {
  const src = path.resolve(String(source ?? ''))
  const dst = path.resolve(String(target ?? ''))
  if (src === dst) return { ok: false, error: '来源就是目标文件' }
  const incoming = await inspectMemeDb(src)
  if (!incoming.ok) return { ok: false, error: incoming.error }
  if (incoming.count === 0) return { ok: false, error: '词库是空的' }
  const existing = fs.existsSync(dst) ? await inspectMemeDb(dst) : { ok: false }
  if (existing.ok && incoming.count < existing.count && !force) {
    return { ok: false, previous: existing.count, count: incoming.count, error: `新词库只有 ${incoming.count} 条，比现在的 ${existing.count} 条少，没有覆盖（确认要换就勾选“强制覆盖”）` }
  }
  const dir = path.dirname(dst)
  const tmp = path.join(dir, `memes.db.${process.pid}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(src, tmp)
    const check = await inspectMemeDb(tmp)
    if (!check.ok || check.count !== incoming.count) throw new Error(check.error ?? '复制后的条数对不上')
    fs.renameSync(tmp, dst)
    return { ok: true, count: incoming.count, previous: existing.ok ? existing.count : 0 }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件删不掉也不影响旧库 */
    }
    return { ok: false, error: `导入失败，旧词库没动：${error?.message ?? error}` }
  }
}

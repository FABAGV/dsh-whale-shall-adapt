/**
 * 记忆的 SQLite 真相库（P1）。
 *
 * 为什么不是「索引」而是真相源：用户要的是**一个库**，memory.json 退成导出/备份。
 * 表结构只把「要检索、要过滤」的字段单列，其余整条 JSON 放 `data` —— 这样加字段不用改表。
 *
 *   memories(id, scope, area, kind, status, text, importance, updated_at, data)
 *   memories_fts  FTS5 trigram（中文按子串搜）
 *   meta(key, value)  版本号、seq、blockedScopes、forgotten 这类整块状态
 *
 * 写入用「整表 upsert + 删掉没了的」，因为记忆量级很小（现在 156 条）；
 * 将来上万条再改成脏集合增量写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { areaOf } from './areas.js'

/**
 * ⚠️ node:sqlite **不能静态 import**：Node 20 没有它，22.5–22.12 要带 `--experimental-sqlite`
 * 才有。静态 import 在模块链接阶段就失败，整个插件都加载不起来 —— 哪怕配置是 `memory.store=json`、
 * 根本用不到 SQLite。改成用到时再同步加载，拿不到返回 null，`openMemoryDb` 抛错，
 * 由 `MemoryStore` 的"打不开就退回 json"分支接住。
 */
const require = createRequire(import.meta.url)

function defaultSqliteLoader() {
  try {
    const viaBuiltin = process.getBuiltinModule?.('node:sqlite')
    if (viaBuiltin?.DatabaseSync) return viaBuiltin.DatabaseSync
  } catch {
    /* 老 Node 没有 getBuiltinModule，走 require */
  }
  try {
    return require('node:sqlite').DatabaseSync ?? null
  } catch {
    return null
  }
}

let sqliteLoader = defaultSqliteLoader

/** 测试用：换掉 node:sqlite 的加载器（传 null 恢复默认）。加载器返回 DatabaseSync 构造器或 null。 */
export function setSqliteLoader(loader) {
  sqliteLoader = typeof loader === 'function' ? loader : defaultSqliteLoader
}

/** 当前 Node 能不能用 node:sqlite。 */
export function loadSqlite() {
  return sqliteLoader() ?? null
}

const SCHEMA = `
create table if not exists meta (
  key   text primary key,
  value text not null
);
create table if not exists memories (
  id          text primary key,
  scope       text not null,
  area        text not null default '',
  kind        text not null,
  status      text not null,
  text        text not null,
  importance  integer not null default 1,
  updated_at  integer not null default 0,
  data        text not null
);
create index if not exists memories_scope on memories(scope, status);
create index if not exists memories_area on memories(area, status);
create virtual table if not exists memories_fts using fts5(
  text, content='memories', content_rowid='rowid', tokenize='trigram'
);
create trigger if not exists memories_ai after insert on memories begin
  insert into memories_fts(rowid, text) values (new.rowid, new.text);
end;
create trigger if not exists memories_ad after delete on memories begin
  insert into memories_fts(memories_fts, rowid, text) values ('delete', old.rowid, old.text);
end;
create trigger if not exists memories_au after update on memories begin
  insert into memories_fts(memories_fts, rowid, text) values ('delete', old.rowid, old.text);
  insert into memories_fts(rowid, text) values (new.rowid, new.text);
end;
`

/** FTS5 的 MATCH 语法里这些字符要整句加引号，否则查询会抛语法错误。 */
function ftsQuote(query) {
  return `"${String(query).replace(/"/g, '""')}"`
}

export function openMemoryDb(file, { log = null } = {}) {
  const DatabaseSync = loadSqlite()
  if (!DatabaseSync) throw new Error('当前 Node 没有 node:sqlite（需要 22.13 或更新，或 22.5+ 带 --experimental-sqlite）')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)

  const selectAll = db.prepare('select data from memories')
  const selectMeta = db.prepare('select key, value from meta')
  const upsert = db.prepare(`
    insert into memories (id, scope, area, kind, status, text, importance, updated_at, data)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      scope = excluded.scope, area = excluded.area, kind = excluded.kind, status = excluded.status,
      text = excluded.text, importance = excluded.importance, updated_at = excluded.updated_at, data = excluded.data
  `)
  const deleteIds = db.prepare('delete from memories where id = ?')
  const upsertMeta = db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
  const searchFts = db.prepare(`
    select m.id as id, m.text as text, bm25(memories_fts) as rank
    from memories_fts join memories m on m.rowid = memories_fts.rowid
    where memories_fts match ? and m.scope in (select value from json_each(?)) and m.status in ('active','historical','candidate')
    order by rank limit ?
  `)
  const searchLike = db.prepare(`
    select id, text, 0 as rank from memories
    where text like ? and scope in (select value from json_each(?)) and status in ('active','historical','candidate')
    limit ?
  `)

  return {
    kind: 'sqlite',
    file,

    loadAll() {
      const entries = []
      for (const row of selectAll.all()) {
        try {
          entries.push(JSON.parse(row.data))
        } catch {
          // 坏了的一条跳过，不让整库打不开
        }
      }
      const meta = {}
      for (const row of selectMeta.all()) meta[row.key] = JSON.parse(row.value)
      return { entries, meta }
    },

    /** 整表同步：upsert 现有、删掉不在 entries 里的 */
    saveAll(entries, meta = {}) {
      const keep = new Set()
      db.exec('begin')
      try {
        for (const entry of entries) {
          const id = String(entry.id)
          keep.add(id)
          upsert.run(
            id,
            String(entry.scope ?? ''),
            String(entry.area ?? ''),
            String(entry.kind ?? 'note'),
            String(entry.status ?? 'active'),
            String(entry.text ?? ''),
            Number(entry.importance) || 0,
            Number(entry.updatedAt) || 0,
            JSON.stringify(entry),
          )
        }
        for (const row of db.prepare('select id from memories').all()) {
          if (!keep.has(row.id)) deleteIds.run(row.id)
        }
        for (const [key, value] of Object.entries(meta)) upsertMeta.run(key, JSON.stringify(value))
        db.exec('commit')
      } catch (error) {
        try {
          db.exec('rollback')
        } catch {
          /* 已经回滚过 */
        }
        log?.warn?.(`[memory] 写 SQLite 失败：${error?.message ?? error}`)
        throw error
      }
    },

    /**
     * 按范围过滤 + 全文检索。trigram 对 <3 字的查询无效，短词回落 LIKE。
     * @returns {Array<{id:string, text:string, rank:number}>}
     */
    search(query, scopes = [], limit = 5) {
      const q = String(query ?? '').trim()
      if (!q) return []
      const scopeJson = JSON.stringify((scopes ?? []).map(String))
      const n = Math.max(1, Number(limit) || 5)
      try {
        if (q.length >= 3) return searchFts.all(ftsQuote(q), scopeJson, n)
      } catch (error) {
        log?.warn?.(`[memory] 全文检索失败，回落 LIKE：${error?.message ?? error}`)
      }
      try {
        return searchLike.all(`%${q.replace(/[%_]/g, '')}%`, scopeJson, n)
      } catch (error) {
        log?.warn?.(`[memory] LIKE 检索失败：${error?.message ?? error}`)
        return []
      }
    },

    stats() {
      const byArea = db.prepare('select area, count(*) as n from memories group by area order by n desc').all()
      const total = db.prepare('select count(*) as n from memories').get()
      return { total: total?.n ?? 0, byArea }
    },

    close() {
      try {
        db.close()
      } catch {
        /* 已关 */
      }
    },
  }
}

/** 把 memory.json 倒进 SQLite（首次切库时用；已有数据不动）。 */
export function importJsonIntoDb(jsonFile, store, { log = null } = {}) {
  if (!fs.existsSync(jsonFile)) return { imported: 0, reason: 'no-json' }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  } catch (error) {
    log?.warn?.(`[memory] memory.json 读不懂，不导入：${error?.message ?? error}`)
    return { imported: 0, reason: 'bad-json' }
  }
  const entries = (Array.isArray(parsed?.entries) ? parsed.entries : []).map((entry) => ({
    ...entry,
    // 旧库没有 area：按 scope 补一个默认书架，别让迁移后的条目全落在空气里
    area: entry?.area || areaOf(entry?.scope, entry?.area),
  }))
  if (entries.length === 0) return { imported: 0, reason: 'empty' }
  store.saveAll(entries, {
    version: parsed.version ?? 2,
    seq: parsed.seq ?? entries.length,
    blockedScopes: parsed.blockedScopes ?? [],
    forgotten: parsed.forgotten ?? {},
    revisions: parsed.revisions ?? {},
  })
  log?.info?.(`[memory] 已把 memory.json 的 ${entries.length} 条导进 SQLite`)
  return { imported: entries.length, reason: 'ok' }
}

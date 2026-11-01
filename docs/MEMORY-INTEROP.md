# 记忆全面互通（P1 已实现，未部署）

> 状态：**P1 已写代码、测试通过，等用户验收后部署**；P2/P3 仍是设计。
> 用户 2026-11-01 拍板的方向：**所有记忆进一个库**；`scope` 管权限、`area` 管归置；
> 跨会话的学问放 `shared` 范围，**默认所有人可见**。
> 实际落地（与下面草案有出入的地方）：
> - SQLite 不再只是“索引”，而是**真相源**（`memory.db`），`memory.json` 退成每次落盘的导出备份；
> - 新增 `area`（书架）与 `shared` 范围；`memory.store: json | sqlite` 开关，默认 json（部署时切）；
> - 全文召回用 FTS5 trigram，`memory.recall()` 先全文、再用字符相似度补分；
> - 手写种子 `$DSH_HOME/shall/memory/seeds.json` 启动时补进记忆层（`lib/adapt/memory-seeds.js`，CONTRACTS §4.2.2）；
> - 代码：`lib/memory/sqlite-store.js`、`lib/memory/areas.js`、`lib/adapt/memory-seeds.js`、`test/memory-sqlite.mjs`（27 条）。
>
> 依据：`NEXT-STEPS.md` §4、`docs/CONTRACTS.md` §4（统一记忆层）、§5（隐私与可见范围）、§8（群聊）。
> 事实核对：宿主运行时 Node `v24.21.0` 自带 `node:sqlite`，FTS5 的 `unicode61` 与 `trigram` 两种分词都可用（本机实测，见 §7.1）。

## 1. 目标

一个大脑、多张嘴：

- QQ 群、QQ 私聊、DSH GUI 会话、任务会话**共用同一套记忆**，只是各自看到不同视图；
- 群里的重要消息可以触发**主动私信主人**（默认关，先只读预览）；
- 记忆的写入仍然经过“候选 → 用户裁决”，不因为互通就变成模型想写就写。

## 2. 非目标（这一版不做）

- 不做向量检索/嵌入模型：中文短句的语义召回交给现有 `memory.recall()` 的字符相似度 + 便宜模型裁决，索引只负责**关键词与关系**。
- 不替换 `memory.json`：它是真相源，索引随时可以从它重建。
- 不做跨实例同步（多台 DSH 共用一个记忆库）：单机单实例锁不变。
- 不动 `groups.json`、`outreach.json` 的现有语义。

## 3. 现状与缺口

现状（`CONTRACTS.md` §4）：

- `memory.json` 存所有记忆条目：`id / scope / kind / text / status / origin / confidence / ledger / supersedes`；
- 范围：`owner`、`owner:work`、`owner:chat`、`chat:<type>:<id>`、`member:<群号>:<QQ>`、`persona:<id>`；
- 读：`recall(query, scopes, limit)` 在给定范围内做字符级相似度；
- 注入：`owner/owner:work/persona` 进系统提示段，`owner:chat/chat/member` 进上下文快照（`shall:qq-memory`）；
- 写：`observe()` 去重合并 → 冲突进候选 → 用户裁决（`confirm/wrong/outdated/forget/quiet/pin/move/restore`）；
- 可见范围由 `privacy.scopesVisibleTo(header)` 一处决定（§4.4 的矩阵）。

缺口：

| 缺口 | 后果 |
|---|---|
| 只有字符相似度，没有全文索引 | “上次说的那个域名解析的事”这种词面不重合的想不起来；`recall` 只能扫全量条目 |
| 没有“原话”层 | 记忆是模型归纳过的结论，追不到是哪句原话来的，也没法核对 |
| 没有人物/关系 | 群友的称呼、别名、和谁熟，散在 `member:*` 的文本里 |
| GUI 会话不产记忆 | 桌面里聊出来的东西进不了 QQ 侧；反过来 QQ 的也进不了 GUI |
| 没有“群 → 主人”的注意力 | 群里重要的事只能等主人自己看，或者靠 `outreach` 的闲聊式跟进 |

## 4. 架构：真相源 + 可重建索引

```
       写（唯一入口 memory.observe / judge / move）
                     │
                     ▼
   $DSH_HOME/shall/memory/memory.json      ← 真相源（原子写 + .bak，现状不变）
                     │  同一次写入后同步更新
                     ▼
   $DSH_HOME/shall/memory/index.db        ← 派生索引（SQLite + FTS5），可删、可重建
        ├─ events        原话/片段（QQ 群、私聊、GUI 会话、工具摘要）
        ├─ memory_events 记忆 ↔ 原话 关联
        ├─ people / relations
        └─ events_fts    FTS5 trigram 虚表（中文按子串搜）
```

原则：

1. **索引可丢弃**：删掉 `index.db`，插件照常跑（`recall` 回落到现有的字符相似度），只是变慢、变笨。
2. **写入顺序**：先写 `memory.json`（真相源），成功后再写索引；索引写失败只记警告，不回滚真相源。
3. **重建命令**：控制台「记忆」页加一个「重建索引」按钮（`POST /api/memory/reindex`），从 `memory.json` + `qq/corpus/` + 会话 jsonl 重放。
4. **单写者**：索引写只发生在插件进程内（现有实例锁保证只有一个进程），不开多连接写。

## 5. 数据模型（草案）

```sql
-- 原话/片段：所有来源的可检索片段
create table events (
  id           integer primary key,
  at           integer not null,           -- 毫秒时间戳
  source       text    not null,           -- 'qq-group' | 'qq-private' | 'gui' | 'task' | 'tool' | 'memory-write'
  origin_session text,                     -- DSH sessionId（GUI/任务会话）或 QQ 会话绑定键
  scope        text    not null,           -- 与记忆同一套 scope，便于权限过滤
  kind         text    not null,           -- 'message' | 'extract' | 'tool-result' | 'note'
  speaker      text,                       -- QQ 号 / 'owner' / null
  text         text    not null,
  meta_json    text,                       -- 群号、消息 id、引用、token 数等
  redacted     integer not null default 0  -- 脱敏标记（脱敏后 text 只剩占位）
);
create index events_at on events(at);
create index events_scope on events(scope, at);
create index events_session on events(origin_session, at);

-- 记忆 ↔ 原话：一条记忆由哪些原话归纳出来（可追溯、可撤销）
create table memory_events (
  memory_id text not null,
  event_id  integer not null,
  role      text not null,                 -- 'evidence' | 'superseded'
  primary key (memory_id, event_id)
);

-- 人物与关系（群友的称呼、别名、和谁熟）
create table people (
  id       integer primary key,
  qq       text not null unique,
  name     text,
  aliases  text                            -- JSON 数组
);
create table relations (
  person_id integer not null,
  scope     text    not null,              -- 'group:<群号>' 等
  weight    real    not null default 0,
  meta_json text,
  primary key (person_id, scope)
);

-- 全文索引：trigram 适合中文子串（“域名解析”能命中“域名解析的事”）
create virtual table events_fts using fts5(
  text, content='events', content_rowid='id', tokenize='trigram'
);
```

说明：

- **不给每条消息都建索引**：只索引“值得以后搜回来”的片段——记忆的 evidence、用户明确说过的话、群里的长消息（超过阈值）、工具结果摘要。纯表情、“哈哈哈”这类不入索引，避免索引膨胀。
- `meta_json` 里存 token 数与来源，便于以后做“索引成本”统计。
- trigram 对 <3 字的查询无效（FTS5 限制），`recall` 里对 1–2 字的查询回落到 `LIKE '%x%'`。

## 6. 读互通

`shall_memory_recall` 改成三段：

1. **权限**：`privacy.scopesVisibleTo(header)` 得到可读 scope 列表（不变，§4.4 是硬规则）；
2. **索引优先**：`events` + `events_fts` 按 `scope in (...)` 过滤、按 `bm25()` 排序，取前 N 条原话；再把关联的 `memory_id` 对应的记忆条目取出来（只取 `status='active'` 或 `historical`，后者标注“以前”）；
3. **回落**：索引不可用、或查询 <3 字、或结果为空时，走现有 `memory.recall()`。

注入不变：`owner/owner:work/persona` 进系统提示段，`owner:chat/chat/member` 进上下文快照。索引只服务“按需翻”（recall 工具），**不参与常驻注入**——否则前缀缓存会碎，token 也会涨。

## 7. 写互通

### 7.1 来源

| 来源 | 写什么 | 谁写 | 开关 |
|---|---|---|---|
| QQ 群/私聊 | 现有 owner:chat / chat / member 碎片 | `qq:idle`（空闲整理）、交班提取 | 现状 |
| GUI 会话 | `owner`、`owner:work` 的候选 | 现有画像生成器（`lib/adapt/profile.js`） | 现状 |
| 任务会话 | 用户点头才写 | 控制台「记一条」或工具询问 | 新增，默认关 |
| 工具结果 | 摘要（可选） | 工具层 | 新增，默认关 |

重点：**写入仍然只经过 `memory.observe()`**，索引只是旁路。也就是说互通不改变“候选 → 用户裁决”的流程，只是让写进来的东西更好找。

### 7.2 写索引的时机

- `observe()` 成功（返回 new/merged）后，同步写 `events` + `memory_events`；
- `judge(forget)` 时**连同原话一起删**（换成文本指纹），保证“删干净”；
- `judge(wrong/outdated)` 保留原话（作为“已被否定”的证据），标注 `role='superseded'`；
- `move` 只改记忆的 scope，`events.scope` 跟着改，避免跨片泄露。

## 8. 隐私与边界

沿用 `CONTRACTS.md` §4.4，映射到索引查询：

| 会话 | 能读的 events.scope |
|---|---|
| DSH 主会话 | `owner`、`owner:work` |
| 子代理 | 默认无（`privacy.injectProfileIntoSubagents` 开才有 owner/owner:work） |
| 主人 QQ 私聊 | `owner`、`owner:chat`、`chat:private:<主人>` |
| 其他人私聊 | `chat:private:<对方>` |
| QQ 群 | `chat:group:<本群>`、`member:<本群>:*` |

硬规则（要写测试守住）：

1. 群内容不能跨群注入，也不能进主人的三片（群里说的话是给群里的人看的，§4.4 已有）；
2. 索引里的 `text` 是原话，比记忆条目更敏感——`forget` 必须同时清 `events`；
3. `source='gui'` 的片段默认只进 `owner/owner:work`，不进任何 QQ scope；
4. 重建索引时要按当前 `memory.json` 重新算 scope，不能沿用旧文件的 scope。

## 9. 群 → 主人主动私信（attention engine）

目标：群里出现“主人会关心”的事，bot 能主动私信主人，而不是等主人自己翻群。

打分：群消息片段 × 主人的关注点（`owner`、`owner:work` 的条目 + 最近 `owner:chat` 的近况），用**便宜模型**打 0–1 分（不是每次都用主模型）。

触发条件（全部满足才投递）：

- 分数 ≥ 阈值（默认 0.75，可在控制台调）；
- 主人最近 N 分钟没有主动找 bot（避免打扰正在聊的人）；
- 冷却：同一群 30 分钟内最多一次；全局每天 ≤ `outreach.triggered.maxPerDay`（默认 3）；
- 静默时段、群黑名单、`budget.perHour` 都照旧生效；
- **不硬发模板**：投递的是一条“你自己决定说不说”的提示给常驻会话，由它写正文；写不出来就不发。

落地顺序：

1. **P3-a 只读预览**：控制台「主动私信」页多一块“群消息触发（预览）”，列出最近 24 小时被打分 ≥ 阈值的消息和分数，**不发**；
2. **P3-b 灰度**：开关 `outreach.triggered.enabled` 默认 `false`，打开后先只对指定群生效（`outreach.triggered.groups`）；
3. **P3-c 放开**：观察 1 周无误报再调阈值。

## 10. 开关、迁移、灰度

```yaml
memory:
  interop:
    enabled: false        # 总开关；关 = 完全走现状，连 index.db 都不建
    read: true            # 索引参与 recall（enabled 时才生效）
    write: true           # 写记忆时同步写索引
    indexFile: ''         # 留空 = $DSH_HOME/shall/memory/index.db
outreach:
  triggered:
    enabled: false
    groups: []            # 空 = 不限制（enabled 时才生效）
    threshold: 0.75
    maxPerDay: 3
```

- 全部默认关；打开后如果 `index.db` 损坏，自动回落并记一条警告，不阻塞启动。
- 迁移：`memory.interop.enabled=true` 时不自动重建（避免大群第一次启动卡住），控制台点「重建索引」，或启动后后台跑一次（限速，每批 500 条）。
- 回滚：关开关 + 删 `index.db`，`memory.json` 不受影响。

## 11. 风险

| 风险 | 处理 |
|---|---|
| 索引与真相源不一致 | 索引只做加速，召回结果最终还要 `memory.get()` 校验一次；对不上就丢弃并记警告 |
| 原话落盘放大隐私面 | `forget` 连原话一起删；`index.db` 与 `memory.json` 同目录同权限；控制台“删干净”要覆盖两处 |
| 索引写入拖慢消息处理 | 索引写入在 `setImmediate` 里批量提交（≤50ms 一批），失败只警告，不阻塞 QQ 流水线 |
| FTS5 中文分词不准 | 用 `trigram`（实测可搜中文子串），<3 字回落 `LIKE` |
| 成本 | attention engine 用便宜模型；`recall` 不调模型 |
| 将来换存储 | 所有读都经过 `lib/memory/index.js` 一层封装，换 SQLite→别的只改这一层 |

## 12. 需要你拍板的 5 个决策

1. **互通范围**：所有会话全互通，还是按会话/群白名单？
   （我倾向：先全互通读、写按来源限制；白名单以后再加）
2. **群消息触发主动私信**：开不开、什么频率、哪些群可以触发？
   （我倾向：先只读预览 1 周，再对 1 个群灰度，默认每天 3 条）
3. **GUI 会话内容进不进 QQ 侧记忆**：双向、只读、还是只进 `owner:work`？
   （我倾向：只进 `owner`/`owner:work`，不进 QQ 任何 scope；QQ 侧只能读到主人三片）
4. **敏感内容**：隐私/工作内容允不允许进索引？保留多久、怎么删干净？
   （我倾向：脱敏后进索引，保留 30 天，`forget` 连原话一起删）
5. **索引文件位置**：`$DSH_HOME/shall/memory/index.db` 行不行？
   （我倾向：行，和 `memory.json` 同目录，备份/迁移语义一致）

## 13. 实施顺序

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| P1 | SQLite 骨架 + 从既有 `memory.json`/`corpus` 重建 + `recall` 走索引 + `test/memory-interop.mjs` | 关掉索引时行为与现在一致；打开后 `recall` 召回率对比有提升 |
| P2 | GUI/任务会话的写互通（候选流程不变）+ 隐私矩阵回归测试 | §8 的 4 条硬规则全绿 |
| P3 | attention engine 只读预览 → 单群灰度 → 放开 | 一周内误报 ≤ 1 次/天 |

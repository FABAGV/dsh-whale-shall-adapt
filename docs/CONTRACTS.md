# 模块契约

本文件定下模块之间的接口和不变式。代码与本文冲突时，先改本文再改代码。
设计背景见仓库外的 `R:\working zone\whale\PLAN-dsh-whale-shall-adapt.md`、`UX-群聊体验调研.md`、`progress\S2.md`、`progress\S3.md`。

## 1. 名字（已落地，提交 254d097）

| 东西 | 名字 |
|---|---|
| 包名 / 插件 id | `dsh-whale-shall-adapt` |
| 状态目录 | `$DSH_HOME/shall/`，下分 `adapt/`、`qq/`、`memory/` |
| 宿主 HTTP 前缀 | `/shall/api/`（设置页与控制台共用一张路由表，见第 7 节） |
| QQ 状态页 | `/shall/qq/status`（暂时还挂在 OneBot 端口上，阶段 1 移进控制台） |
| 桌面端凭据头 / 页面注入全局 | `x-shall-token` / `__DSH_SHALL__` |
| 工具 | `shall_qq_send`、`shall_qq_history`、`shall_qq_chats`、`shall_qq_alive`、`shall_qq_memory`（阶段 1 换成 `shall_memory`）、`shall_memory_recall`（阶段 1 新增） |
| 系统提示段 | `shall:frontdesk`(10)、`shall:profile`(30)、`shall:persona`(31)；上下文快照 `shall:qq-memory`(130) |
| 技能来源 / 技能名前缀 | `shall` / `shall-` |
| 凭据名 | `SHALL_ONEBOT_TOKEN` |
| 宿主服务名 | `shallAdapt` |
| 日志命名空间 | `shall:adapt`、`shall:qq`（阶段 1 合成一个 `shall`，写 `$DSH_HOME/shall/plugin.log`） |
| 测试用环境变量 | `DSH_SHALL_CONSOLE=off` |
| 测试端口 | 6810–6839（6700、6710 留给真实运行的 bot 和控制台） |

## 2. 状态目录

```
$DSH_HOME/shall/
├─ memory/memory.json        统一记忆（第 4 节）；写前备份为 memory.json.bak
├─ adapt/                    画像侧：state.json、cursor.json、plain/、profile-history/、privacy.json、audit.jsonl、
│                            personas.json、skills.json、console-key、plugin.log
└─ qq/                       QQ 侧：state.json（阶段 1 换成 bindings.json）、owner.json（配对）、handoff/、corpus/<type>-<号>/<日期>.jsonl、plugin.log
```

所有写文件都走 `lib/core` 的原子写（写临时文件再 rename）。`test/selftest.mjs` 第 13 节的写文件白名单照旧生效，新增写目标必须先加进白名单并写明理由。

## 3. 配置

现状（过渡态）：画像侧的键在顶层，QQ 侧整棵放在 `qq` 子树，`logLevel` 共用。`lib/index.js` 的 `splitConfig()` 负责切开。

目标形状（阶段 1 逐步迁过去，迁一块删一块旧键，不留兼容）：

```yaml
logLevel: info
qq:
  connection: { host, port: 6700, path, tokenRef: SHALL_ONEBOT_TOKEN, token, callTimeoutMs, mount }
  scope: { groups: [], friends: [], blockedGroups: [], blockedFriends: [] }
  participation: { privateMode: always }      # 群聊档位移到 group.*
  workspaceRoot: ''
  prefix: { task: '', chat: '' }
  ingest: { forwardRecords, groupArchive }
  corpus: { retainDays: 30 }
  dedupe: { windowMs, maxEntries }
  relayFlushMs: 2000
  conversation: { handoffAtRatio, minTokensBetweenHandoffs, handoffRetainDays, handoffInputChars, handoffMaxTokens,
                  idle: { enabled, minutes: 20, minTurns: 3 }, coldStart: { enabled, minMessages: 200, days: 30 } }
memory:
  injectBudgetTokens: { owner: 1500, chat: 2000 }
  similarity: { merge: 0.82, ask: 0.3, seal: 0.6 }
  aging: { everyGens: 10, staleGens: 5, dropGens: 10, maxPerScope: 500 }
  members: { enabled: true, maxPerRun: 20, everyHours: 6, disabledGroups: [] }
group:
  defaultMode: mention        # silent | mention | present | active
  judge: { provider: deepseek-official, model: deepseek-flash, timeoutMs: 15000 }
  templates: {}               # 按群覆盖
profile / persona / skills / scan / signals / privacy / console:  沿用旧画像侧的字段与默认值
```

**用户已定**：群聊准入默认不接。`qq.scope.groups` 为空 = 一个群都不接（不再是“全部群”）；私聊准入 = `qq.scope.friends` ∪ 配对的主人，两者都空时拒绝所有私聊。

## 4. 统一记忆层 `lib/memory/`

### 4.1 一条记忆

```js
{
  id: 'm000123',                 // 记忆层分配，调用方不能指定
  scope: 'owner' | 'chat:group:<号>' | 'chat:private:<号>' | 'member:<群号>:<QQ号>' | 'persona:<人格id>',
  kind: 'trait' | 'avoid' | 'works' | 'uncertain'                          // 原画像 A/B/C/D
      | 'fact' | 'intent' | 'constraint' | 'preference' | 'promise'        // 原 QQ 碎片
      | 'relation' | 'style' | 'note',
  text: '一行，≤200 字，已脱敏',
  status: 'active' | 'candidate' | 'sealed' | 'deleted',
  pinned: false,
  importance: 0,                 // 0–9
  confidence: 0.8,               // 0–1
  sources: [{ sessionId, at, quote }],     // 最多 5 条，quote ≤120 字，已脱敏
  supersedes: [],                // 它推翻的记忆 id；被推翻的那条转为 candidate
  validUntil: null,              // 毫秒时间戳；过期后 age() 把它降为 candidate
  ledger: { refs, injected, recalled, corrected, seen, lastSeenAt, lastSeenGen, deletedCount },
  history: [{ at, actor, action, delta?, reason? }],     // 最近 10 条
  createdAt, updatedAt,
}
```

### 4.2 接口

```js
const memory = createMemory({ dir, log, config: config.memory, now?: () => number })

memory.observe(input)  // → { action: 'new'|'dup'|'merged'|'ask'|'sealed'|'dropped', id?, similarity? }
//   input = { scope, kind, text, actor,
//             importanceDelta?: 0|1|2,      // 原 QQ tag，累加到重要度
//             importance?: number,          // 新建时的初值；和 importanceDelta 二选一
//             confidence?, status?: 'active'|'candidate',
//             source?: { sessionId, at, quote }, supersedes?: [id], mergeWith?: id, validUntil?, gen? }
//   规则：先脱敏；与同范围 sealed 记忆相似度 ≥ similarity.seal → 'sealed'（不写）；
//         mergeWith 指向同范围已有记忆 → 'merged'；相似度 ≥ merge → 'dup'（refs+1、重要度累加）；
//         ask ≤ 相似度 < merge → 'ask'（两条都留着：新的一条为 active，继承旧那条的 refs 与 importance）；否则 'new'。
memory.list(query)                 // query = { scope?, scopePrefix?, status?, kind?, ids? } → 记忆数组（拷贝）
memory.get(id)
memory.select(scopes, budgetTokens, policy?)   // → { picked, usedTokens, total, revision }
//   只选 active；排序 pinned → importance → refs → lastSeenAt → id（字节稳定的前提）；贪心截断。
//   policy = { reserve?: { [kind]: 比例 }, cap?: { 'kindA+kindB': 比例 }, exclude?: [kind], pinnedExempt?, trialSlots? }
memory.render(selection, { title })            // 同样输入逐字节相同；空选择返回 ''
memory.mark(id, action, actor)     // action: pin | unpin | seal | unseal | delete；actor 只能是 'console' | 'dsh-settings'
memory.retract(ids, { actor, reason })   // 生成器不再支持：转为 candidate，可逆，不计 deletedCount
memory.demote(ids, { actor, reason })    // 重要度 −1（原 QQ 交班的 drop）
memory.recordUsage(ids, event, meta?)    // event: injected | recalled | corrected | seen
//   injected 按 (scope, revision) 去重：同一版只记一次（section.text 每步都会被调用）
memory.recall(query, scopes, limit?)     // 关键词 + 3-gram 相似度检索 active 与 candidate
memory.age(scope, { gen, now? })         // 老化、过期、超额清理；返回 { decayed, expired, dropped }
memory.forget(query, actor)              // 批量删除（“忘掉我”）；actor 只能是控制台
memory.export(query)
memory.revision(scope)                   // 该范围内容真变了才 +1
memory.onChange(listener)                // listener({ scope, revision })；返回 disposer
memory.flush()                           // 立即落盘（测试和卸载时用）
```

### 4.2.1 相似度阈值（实测，提交前用 10 组句子量过）

字符 3-gram Jaccard 对中文改写不灵：真实改写只有 0.0–0.45，只差一个关键内容的不同结论也能到 0.35。所以：

- **merge 0.82**：只把几乎原样的重复判成同一条；
- **ask 0.3**：可能是换说法，也可能是另一件事，两条都留着，由生成器下次用 `mergeWith` 明确合并；
- **seal 0.6**：封印只挡近乎原样的复述。改写过的封印条目要靠提示词那道防线（生成提示里列出封印过的结论），这和旧画像侧“封印按文本精确匹配”相比只是放宽了一点，没有解决同义改写。

### 4.3 可见范围（硬规则，`test/memory-contract.mjs` 与隐私测试守住）

| 会话类别 | owner | 本聊天 chat | 本群 member | persona |
|---|---|---|---|---|
| 你自己的会话 | ✅ | — | — | 绑定了才有 |
| 你派出的子代理 | ❌（`privacy.injectProfileIntoSubagents` 可开） | — | — | ❌ |
| QQ 群会话 | ❌ | ✅ 只本群 | ✅ 只本群 | 绑定了才有 |
| QQ 私聊会话 | ❌ | ✅ 只本私聊 | — | 绑定了才有 |

- QQ 来源的写入只能落在 `chat:*` 和 `member:*`，`observe` 收到 QQ actor 写 `owner` 时直接拒绝（返回 `dropped`）。
- 计算可见范围的唯一入口是 `privacy.scopesVisibleTo(header)`（第 5 节）。

### 4.4 注入

- `owner` 与 `persona:*` 进系统提示段（`shall:profile`、`shall:persona`，`interpolate:false`），会话中途基本不变。
- `chat:*` 与 `member:*` 进上下文快照 `shall:qq-memory`（`systemPrompt.context`，order 130）。空闲整理会在会话中途改它们，用快照才不会让系统提示中途变化、作废前缀缓存。
- 段与快照的文本按 `(可见范围, 各范围 revision)` 缓存，命中时返回同一个字符串。

## 5. 会话分类与权限 `lib/privacy/`

```js
privacy.classify(header)          // → 'owner' | 'subagent' | 'qq-group' | 'qq-private'，附 chatKey
privacy.ruleFor(header)           // 工具等级与是否可学习
privacy.canLearn(header)
privacy.scopesVisibleTo(header)   // 按 4.3 节返回记忆范围列表
```

分类先查 QQ 侧的会话绑定表（`bindings.resolve(header)`，子代理沿 `parentSession` 最多上溯 8 层，找不到按外部会话处理），
查不到再看工作区目录名 `qq-<type>-<号>`，并在审计里记一条“按目录名识别”。绑定变化时 `bindings.onChange` 通知 privacy 清缓存。

## 6. QQ 侧对外接口

```js
bindings.chatOf(sessionId) / bindings.resolve(header, lookupHeader) / bindings.list() / bindings.onChange(fn)
corpus.listChats() / corpus.readRecords({ chatType, chatId, days, maxRecords }) / corpus.listMembers(records)
corpus.memberSamples(records, memberId, limits) / corpus.purgeMember(chatType, chatId, memberId)
qq.status.snapshot()      // 完整体检快照，控制台登录后可见
qq.pairing.issueCode() / qq.pairing.owner() / qq.pairing.reset()
```

QQ 工具在 `execute(args, exec)` 里用 `exec.agent.session.header` 判调用方：QQ 会话只能作用于自己所在的聊天，你自己的会话可作用于 scope 内任何聊天，拿不到 header 一律拒绝。这一层与 privacy 的工具等级叠加，不互相替代。

## 7. 进程内信号总线 `core.signals`

```js
core.signals.emit(event)  /  core.signals.on(fn) → disposer
event = { kind, source: 'qq'|'owner', scope?, chatKey?, sessionId, seq?, at, quote?, confidence?: 'high'|'low',
          memoryRevision?, personaId?, prevAssistant? }
kind: 'correction' | 'tool-fail' | 'gui-takeover' | 'handoff-miss' | 'not-like' | 'followup'
    | 'interject-engaged' | 'interject-rejected' | 'bot-recalled' | 'bot-muted' | 'interject-silence'
```

QQ 侧只采集、不下结论；判定和落账在 `lib/adapt/correction.js`。依据 correction-mining 的结论，只用高精度判据，宁漏勿错。

## 8. 群聊回复决策 `lib/group/`

```js
group.onInbound({ chatKey, messageId, senderId, senderName, at, text,
                  addressed: null|'at'|'reply-to-bot'|'name'|'poke', mentionsOthers, isCommand, fromBot,
                  quote: null|{ senderId, text, isBot } })
group.onDecision(fn)   // fn({ chatKey, respond, reason, anchorMessageId, mode: 'called'|'present'|'active' })
group.onBotReply({ chatKey, chars, at })
group.snapshot(chatKey?)
```

五层顺序：硬规则 → 在场状态 → 等时机 → 精力与冷却 → 判断模型（只在 `active` 档）。默认档位 `mention`。精力默认值照天使之心：初始 100、下限 −100、每秒恢复 0.6、每次 14 + 字数 × 0.12。

## 8.1 主动私聊主人 `lib/outreach/`（PLAN 第 45 条，阶段 2）

以 SurfCore `src/purpose-engine.js`（MIT）为蓝本：纯逻辑（排程、目标假设、提示词、备忘解析）与副作用（定时检查、投递、回执）分开。

- 只私聊、只发给配对的主人；群聊永远不主动开口。默认关，在控制台打开。
- 闸门：总开关、安静时段 23:30–08:30、每天最多 4 次、两次间隔 2.5–5 小时随机、主人 30 分钟内说过话不发、常驻会话忙不发、没有配对的主人不发。
- 下次发送时间落盘，每次检查重新计算；重启时把在途的一轮记为 interrupted，不补发。每天的次数在投递时就扣。
- 有零副作用的预览：真读素材、真拼提示词，不建会话、不发送、不写状态。
- 目标来自统一记忆层：主人范围的 `intent`/`promise`（第 42 条的“待续”）和 owner 记忆；主人的回复按第 44 条调整置信度。

## 9. 宿主 HTTP 路由

一条宿主前缀路由 `/shall/api/`，路由表 `{ method, path, auth: 'dsh'|'console'|'public', handler }` 集中在 `lib/ui/routes.js`。
QQ 侧和其他模块只提供处理函数。OneBot 端口（默认 6700）只留反向 WS 和最小健康 JSON `/shall/health`。

## 10. 宿主接口（本机 `@deepseek-ai/dsh` 0.2.1-alpha.1 核对过）

| 用途 | 结论 | 位置 |
|---|---|---|
| 系统提示段 | `systemPrompt.section({name, order, text, interpolate})`；`text(context)` 每步调用，`context = {agent, scope, signal?}`；空串段丢弃；返回值变了会追加 system 节点 | `dsh-agent/lib/index.js` 约 291 行；`dsh-agent-loop/lib/index.js:277` |
| 上下文快照 | `systemPrompt.context()`：文本不变不发（`retained?.text === snapshot`），变了替换旧快照 | `dsh-agent-loop/lib/index.js:337` |
| 会话头 | `agent.session.header`：`version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset?`；没有 workspaceId | `dsh-session` 约 1699 行 |
| 工具调用方 | `execute(args, exec)`，`exec.agent?` | `dsh-tools/lib/types/index.d.ts:128,216-242` |
| 工具门控 | `tools.guard(fn)` 同步、monotonic、在 `tools/pre-execute` 之后 | `dsh-tools/lib/index.js` 约 2645、2912 行 |
| prompt 来源 | `source.rpcId = request.requestId`；`user/message` 的 data 就是消息本体 | `dsh-api-session-controller/lib/index.js:860`；`dsh-agent-loop/lib/index.js:1061` |
| 建会话 | `sessionController.create` 的 workspaceId 与 cwd 互斥 | `dsh-api-session-controller/lib/index.js:689` |
| 模型调用 | `llm.stream` 的 purpose 只有 `'compaction' \| 'session-title'`；失败在 `finish.failure` | `dsh-llm/lib/types/types.d.ts:143-147,530` |
| 凭据 | `credentials.resolve(ref)` 返回对象或 undefined，不是字符串 | `dsh-credentials/lib/types/index.d.ts:129` |
| 技能来源 | `skills.registerProvider`；`runtime` 是保留名；技能名 `^[a-z0-9]+(?:-[a-z0-9]+)*$` | `dsh-skill` |
| 登录校验 | `connection.requestRejection(req)`：403 = Host/Origin 不过，401 = 没登录，通过返回 undefined | `dsh-client-connection/lib/index.js` 约 586 行 |
| 新增 | `@deepseek-ai/dsh-persona` 是 preset 级身份段，与我们的说话风格段不冲突，不挂它 | — |

没核对过的：桌面端 Electron 转发（不在 npm 包里），真机冒烟时确认。

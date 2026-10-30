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
├─ owner.json                主人身份绑定（4.8）：配对的 QQ 号
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
  scope: 'owner' | 'owner:work' | 'owner:chat'                 // 主人的三片，见 4.5
       | 'chat:group:<号>' | 'chat:private:<号>' | 'member:<群号>:<QQ号>' | 'persona:<人格id>',
  kind: 'trait' | 'avoid' | 'works' | 'uncertain'                          // 原画像 A/B/C/D
      | 'fact' | 'intent' | 'constraint' | 'preference' | 'promise'        // 原 QQ 碎片
      | 'relation' | 'style' | 'note'
      | 'slang'                  // 群黑话（第 11 节）
      | 'boundary',              // 用户留下的“别记这类东西”，只给生成器看，永不注入
  text: '一行，≤200 字，已脱敏',
  status: 'active'               // 参与注入
        | 'candidate'            // 等用户看：可能和被否定的结论冲突，或生成器不再支持
        | 'rejected'             // 用户判“不对”：不注入，留着挡近乎原样的复述
        | 'historical',          // 过时了：不注入，召回时标“以前”
  origin: 'user' | 'user-confirmed' | 'model' | 'import',
  pinned: false,
  quiet: false,                  // 用户说“别提”：记着，但不注入、不召回
  importance: 0,                 // 0–9
  confidence: 0.5,               // 0–1；用户确认后为 1
  sources: [{ sessionId, at, quote }],     // 最多 5 条，quote ≤120 字，已脱敏
  supersedes: [], rejects: [], conflictsWith: null,
  validUntil: null,              // 过期后 age() 转为 historical
  ledger: { refs, injected, recalled, corrected, seen, lastSeenAt, lastSeenGen, lastInjectedKey },
  history: [{ at, actor, action, delta?, reason? }],     // 最近 10 条
  createdAt, updatedAt,
}
```

### 4.2 接口

```js
const memory = createMemory({ dir, log, config: config.memory, now?: () => number })

memory.observe(input)
// → { action: 'new'|'dup'|'merged'|'ask'|'conflict'|'rejected'|'dropped', id?, similarity?, conflictsWith? }
//   input = { scope, kind, text, actor, importanceDelta?, importance?, confidence?, status?, origin?,
//             source?: { sessionId, at, quote }, supersedes?: [id], mergeWith?: id, validUntil?, gen? }
//   顺序：脱敏 → 文本指纹在“已忘掉”里就丢弃 → 和同一家里被否定的结论或边界近乎原样（≥ merge）就丢弃（rejected）
//         → mergeWith 合并 → 和同范围已有记忆 ≥ merge 判 dup → 和被否定的结论 ≥ conflict 新建为候选（conflict）
//         → ≥ ask 新建并继承旧那条的计数（ask）→ 否则 new。
//   origin 只有控制台、设置页和用户自己的写入能给 'user'，模型侧给了也记成 'model'。
memory.judge(id, verdict, { actor, text?, boundary?, scope? })   // 用户裁决，见 4.6；actor 只能是 'console' | 'dsh-settings'
memory.list(query) / memory.get(id)                               // 返回拷贝
memory.promptGuards(scope)       // → { rejected: [文本], boundaries: [文本] }，整家（4.5）一起算，给生成提示词用
memory.select(scopes, budgetTokens, policy?)   // → { picked, usedTokens, total, revisions, key }
//   只选 active、不 quiet、不是 boundary；排序 pinned → importance → refs → lastSeenAt → id；
//   policy = { reserve?: { [kind]: 比例 }, cap?: { 'kindA+kindB': 比例 }, exclude?: [kind], pinnedExempt?, trialSlots? }
memory.render(selection, { title, intro })     // 同样输入逐字节相同；空选择返回 ''
memory.retract(ids, { actor, reason })   // 生成器不再支持：转为 candidate
memory.demote(ids, { actor, reason })    // 重要度 −1
memory.recordUsage(ids, event, meta?)    // injected（按 meta.key 去重）| recalled | corrected | seen
memory.recall(query, scopes, limit?)     // active、candidate、historical 都能召回，historical 带 historical: true
memory.age(scope, { gen, now? })         // 过期、衰减、清理、单范围上限；返回 { decayed, expired, dropped }
memory.purge(query, actor) / memory.unblock(scope, actor)   // “忘掉我”：删整个范围，可屏蔽之后的写入
memory.export(query) / memory.revision(scope) / memory.onChange(listener) / memory.flush() / memory.dispose()
```

**生成器碰不到的东西**：置顶的、`origin` 为 `user` / `user-confirmed` 的记忆，`retract`、`demote`、`supersedes`、`age()` 都不动它们；
`rejected` 和 `boundary` 也不会被 `age()` 删掉。

### 4.3 相似度阈值（实测，10 组中文句子）

字符 3-gram Jaccard：真实改写只有 0.0–0.45，只差一个关键内容的不同结论也能到 0.35。所以相似度只用来做三件确定的事：

| 阈值 | 值 | 用途 |
|---|---|---|
| merge | 0.82 | 几乎原样的重复：判同一条；和被否定的结论这么像就直接丢弃 |
| conflict | 0.4 | 和被否定的结论有点像：进候选、标出冲突，等用户看，不自动挡也不自动放 |
| ask | 0.3 | 和已有记忆有点像：两条都留着，新的一条继承计数，生成器下次用 `mergeWith` 明确合并 |

挡同义改写靠生成提示词：画像、交班、成员提取的提示词都带上 `promptGuards()` 的两张清单，要求“一条都不许再产出”。

### 4.4 可见范围（硬规则，`test/memory-contract.mjs` 与隐私测试守住）

| 会话类别 | owner（身份） | owner:work（干活） | owner:chat（聊天） | 本聊天 chat | 本群 member | persona |
|---|---|---|---|---|---|---|
| 你在 DSH 里的会话 | ✅ | ✅ | ❌ | — | — | 绑定了才有 |
| 你派出的子代理 | ❌（`privacy.injectProfileIntoSubagents` 可开 owner + owner:work） | ❌ | ❌ | — | — | ❌ |
| 和主人本人的 QQ 私聊 | ✅ | ❌ | ✅ | ✅ | — | 绑定了才有 |
| 其他人的 QQ 私聊 | ❌ | ❌ | ❌ | ✅ 只本私聊 | — | 绑定了才有 |
| QQ 群会话 | ❌ | ❌ | ❌ | ✅ 只本群 | ✅ 只本群 | 绑定了才有 |

- QQ 来源的写入（actor 以 `qq` 开头）在主人范围里只能写 `owner:chat`；`owner` 与 `owner:work` 只由 DSH 侧的画像生成器和用户自己写。
- 群里**主人自己**说的话按群友处理，写 `member:<群号>:<主人QQ>`，不进主人的三片（群里说的话是在给群里的人看）。
- 计算可见范围的唯一入口是 `privacy.scopesVisibleTo(header)`（第 5 节）。

### 4.5 主人的三片记忆

同一个主人，按“在哪种任务里用得上”分三片，而不是按来源硬拆两份：

| 片 | 写什么 | 谁写 | 谁读 |
|---|---|---|---|
| `owner` 身份 | 稳定特质、称呼、长期偏好、边界 | DSH 画像生成器、用户 | DSH 会话、主人 QQ 私聊 |
| `owner:work` 干活 | 工作纪律、工具习惯、哪些做法行不通（原画像 B/C 和工作笔记） | DSH 画像生成器、用户 | 只有 DSH 会话 |
| `owner:chat` 聊天 | 聊天里提到的近况、约定、聊天口味 | QQ 私聊的交班/空闲整理、用户 | 只有主人 QQ 私聊 |

- 三片同属一家（`familyOf()`）：用户判“不对”的结论、留下的边界、要求忘掉的文本，三片互相挡。
- 控制台能把一条从一片挪到另一片（`judge(id, 'move', { scope })`），只能在同一家里挪。
- 片之间不自动复制：聊天里说的事要进身份那片，由用户在控制台确认挪过去，或下一轮画像生成时由生成器从 DSH 会话里重新归纳。

### 4.6 用户裁决（替换原来的置顶 / 封印 / 删除）

| 裁决 | 效果 | 带参数时 |
|---|---|---|
| 对 `confirm` | 转为 active，`origin` 记为用户确认，生成器以后碰不到它 | `text`：同时改写正文，`origin` 记为 user |
| 不对 `wrong` | 转为 rejected：不注入，留着挡近乎原样的复述，列进生成提示的“已被否定”清单 | `text`：新建一条用户写的正确说法 |
| 过时了 `outdated` | 转为 historical：不注入，召回时标“以前” | `text`：新建一条推翻它的新说法 |
| 别记这个 `forget` | 删除，只留文本指纹（不留原文）挡原样复述 | `boundary`：留一条边界（如“别记群友的婚恋”），只给生成器看 |
| 别提 / 可以提 `quiet` / `unquiet` | 记着但不注入、不召回 / 恢复 | — |
| 置顶 / 取消 `pin` / `unpin` | 保证注入（豁免预算） | — |
| 恢复 `restore` | rejected / historical / candidate 回到 active | — |
| 挪片 `move` | 在主人的三片之间挪 | `scope`：目标片 |

为什么换掉封印：封印要回答“新冒出来的这条是不是被封掉的那条”，靠文本相似度根本答不准（4.3 的实测）。
裁决把问题换成用户答得了的“这条对不对、还算不算数、该不该记”，并把“不对”的正确说法记下来——
生成器被纠正后得到的是“正确的是什么”，而不只是“这句别说”。

### 4.7 注入

- `owner`、`owner:work`、`persona:*` 进系统提示段（`shall:profile`、`shall:persona`，`interpolate:false`），会话中途基本不变。
- `owner:chat`、`chat:*`、`member:*` 进上下文快照 `shall:qq-memory`（`systemPrompt.context`，order 130）。空闲整理会在会话中途改它们，用快照才不会让系统提示中途变化、作废前缀缓存。
- 段与快照的文本按 `select()` 返回的 `key` 缓存，命中时返回同一个字符串。

### 4.8 主人身份绑定

DSH 用户就是 QQ 的主人，两边用同一份 owner 记忆：

- QQ 侧配对（S2.md 的配对码：控制台显示 6 位码，主人用自己的 QQ 私聊 bot 发这个码）成功后，把这个 QQ 号写进 `$DSH_HOME/shall/owner.json`：`{ qq: '<QQ号>', pairedAt }`。插件里所有“最高权限用户”的判断都读这一个文件。
- 绑定之后：和这个 QQ 号的私聊会话按“主人 QQ 私聊”分类（4.4），读 `owner` 与 `owner:chat`、写 `owner:chat`；主动私聊（8.1）只发给这个号。
- 没配对时：所有 QQ 私聊都按“其他人”处理，读不到主人的任何一片；不回复陌生人。
- 解除绑定在控制台做；解除后 `owner:chat` 保留，不再有 QQ 会话能读到它，重新配对后恢复。

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

## 11. 梗百科 `lib/meme/`（PLAN 第 46 条，阶段 2）

来源：`astrbot_plugin_memewiki` v1.7.0（MIT，作者 in1t1a1）。代码思路照搬，Python 改写成 JS，借用处在文件头注明来源和许可。

**词库数据不随本插件分发**。memewiki 自带的 `memes.db`（6668 条，16 MB）内容来自 cnmeme.wiki，版权归该站和原作者。我们提供两种拿词库的办法，都由用户在控制台里点：
- 从本地导入：选一个 memewiki 的 `memes.db`（表 `memes(title, slug, tags, usage, origin, other, summary)`），复制到 `$DSH_HOME/shall/meme/memes.db`；
- 从 cnmeme.wiki 公开只读接口增量同步（`GET /api/v1/public/memes`、`/memes/{slug}`），限速 0.35 秒一次，遇到 429 退避。**默认关**。这是本插件第一个出站请求，`test/selftest.mjs` 的“宿主侧不发网络请求”扫描要为 `lib/meme/sync.js` 单独放行并写明理由。

读库用 Node 自带的 `node:sqlite`，只读打开，每次查询开连接、用完就关（memewiki 在 Windows 上吃过一直攥着句柄导致升级失败的亏）。

**查词顺序**：本群黑话（记忆层 `kind:'slang'`，范围 `chat:group:<号>`）→ 词库精确匹配 → 检索存档（查过的结果，默认 90 天；查不到的负缓存 3 天）→ 联网（只在用户打开同步和联网时）。

**什么时候预查**（照搬 memewiki 的闸门，零成本规则先挡）：
- 明确在问梗（“X 是什么梗 / 啥意思 / 怎么接 / 出处 / 谐音 / 缩写”）：直接查；
- 2–10 字的裸词、不在口头禅表里：查本地，本地没有才过模型闸门；
- 请求类（发图、点歌、帮我、评价）、游戏数值、指代（这个 / 右边）、疑问整句、口头禅：不查；
- 模型闸门用 `group.judge` 同一个 DeepSeek 配置，1.2 秒超时就放行，结果缓存 10 分钟。

**怎么用上**：
- QQ 消息投递进常驻会话时，命中的词条作为一段附加背景跟着这条消息（“【梗百科】标题 / 怎么用、怎么接 / 出处（仅用于理解）”，最多 900 字），不进记忆、不进系统提示；
- 工具 `shall_meme_lookup`：模型拿不准时自己查；
- 前台约定段（`shall:frontdesk`）加五条用法：拿不准先查、查到先接梗别科普、只有被问才讲出处、查不到就说不知道、别用客服腔；
- 群黑话：控制台里按群增删改，存成记忆层的 `slang`，用户裁决那一套照样能用（不对、过时了、别记）；
- 控制台的梗卡片只在控制台里看，不渲染成图片发到 QQ（这一版不做图片卡片）。

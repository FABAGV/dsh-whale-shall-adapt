# 模块契约

本文件定下模块之间的接口和不变式。代码与本文冲突时，先改本文再改代码。
设计背景见仓库外的 `R:\working zone\whale\PLAN-dsh-whale-shall-adapt.md`、`UX-群聊体验调研.md`、`UX-SurfCore目的机制调研.md`。

## 1. 名字（已落地，提交 254d097）

| 东西 | 名字 |
|---|---|
| 包名 / 插件 id | `dsh-whale-shall-adapt` |
| 状态目录 | `$DSH_HOME/shall/`，下分 `adapt/`、`qq/`、`memory/` |
| 宿主 HTTP 前缀 | `/shall/api/`（设置页；控制台的接口见第 9 节） |
| QQ 体检 | 控制台的 QQ 页（`GET /api/qq/health`，登录后）；OneBot 端口上只有不带身份信息的 `/shall/qq/health` |
| 桌面端凭据头 / 页面注入全局 | `x-shall-token` / `__DSH_SHALL__` |
| 工具 | `shall_qq_send`、`shall_qq_send_image`（一条一张图：`sticker` 按名字发 `$DSH_HOME/shall/meme/stickers` 里的表情包，`path` 发本会话工作区里的图）、`shall_qq_stickers`（只读，列表情包名字）、`shall_qq_history`、`shall_qq_summary`、`shall_qq_chats`、`shall_qq_alive`、`shall_qq_memory`、`shall_memory_recall`、`shall_meme_lookup` |
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
├─ groups.json               群的运行时设置（第 8 节）：控制台里接入了哪些群、各群的档位和参数、见过但没接入的群（只记条数）、插话结果统计、后台任务进度
├─ outreach.json             主动私聊主人（8.1）：控制台的开关和调参、下次发送时间、今天的次数、最近联系记录
├─ meme/                     梗百科（第 11 节）：memes.db（导入或同步来的词库）、search_archive.json（检索存档）、settings.json（联网开关）
├─ memory/memory.json        统一记忆（第 4 节）；写前备份为 memory.json.bak
├─ adapt/                    画像侧：state.json、cursor.json、plain/、profile-history/、privacy.json、audit.jsonl、
│                            personas.json、skills.json、console-key、plugin.log
└─ qq/                       QQ 侧：state.json、bindings.json（会话绑定表）、handoff/、corpus/<type>-<号>/<日期>.jsonl、plugin.log
```

所有写文件都走原子写（写临时文件再 rename）。`test/selftest.mjs` 里的写文件白名单照旧生效，新增写目标必须先加进白名单并写明理由。

记忆库有单实例锁（`memory/memory.lock`，`lib/core/instance-lock.js`）：桌面端和命令行 profile 可能各自加载本插件，两个进程往同一个 `memory.json` 写会互相覆盖。
后来的进程发现锁被另一个活着的进程占着（或锁文件 90 秒内被刷新过）时退成**只读**：能读、能在内存里改，但不落盘，QQ 页的体检里会报一条。持有者进程不在了、锁文件超过 90 秒没刷新、持有者就是自己（重新加载插件）时接手。
只有记忆库有这把锁；`groups.json`、`outreach.json` 这类很小的文件仍是后写覆盖先写。

## 3. 配置

一份 schema（`lib/index.js` 的 `Config`），设置页和 cordis 配置共用。`splitConfig()` 把它切给两边：

```yaml
logLevel: info                      # 两边共用
# ── 画像 / 人格 / 技能 / 权限 / 控制台（顶层，字段与默认值沿用原画像侧，见 lib/adapt/schema.legacy.js）
stateDir / sessionsRoot / signals / profile / scan / inject / privacy / console / persona / skills
# ── QQ 通道与常驻对接会话
qq:
  connection:   { mount, host, reversePort: 6700, reversePath, tokenRef: SHALL_ONEBOT_TOKEN, token, callTimeoutMs }
  scope:        { groups: [], friends: [], blockedGroups: [], blockedFriends: [] }   # 默认一个群都不接；'*' = 全部；私聊 = friends ∪ 配对的主人
  participation: { privateMode, aliases: [], poke: true, mergeMs: 1200, knownBots: [], images: true, maxImages: 3, maxImageBytes: 4194304 }
  tasks:        { workspaceRoot, prefix, chatPrefix }
  conversation: { handoffAtRatio, minTokensBetweenHandoffs, memoryBudgetTokens, injectMode, handoffRetainDays, handoffInputChars,
                  handoffMaxTokens, fragmentMergeJaccard, fragmentAskJaccard, agingEveryGens, maxFragmentsPerChat, idleMinutes: 20, idleMinTurns: 3 }
  ingest:       { forwardRecords, groupArchive }
  corpus:       { retainDays: 30 }
  advanced:     { dedupeWindowMs, dedupeMaxEntries, relayFlushMs, stateDir }
# ── 群聊回复决策（第 8 节）
group:
  defaultMode: mention              # silent | mention | present | active | watch
  watch:       { minIntervalMs: 30000, perHour: 40, messages: 30, chars: 3000 }
  judge:       { provider: '', model: deepseek-flash, timeoutMs: 15000 }   # provider 留空 = 跟宿主在用的 provider
  eagerness: 0.5
  present:     { minutes: 8, messages: 12 }
  timing:      { quietMs: 4000, maxWaitMs: 20000 }
  energy:      { initial: 100, floor: -100, recoverPerSec: 0.6, base: 14, perChar: 0.12, minToSpeak: 20 }
  budget:      { perHour: 8, cooldownMs: 45000, perSenderCalls: 6, perSenderWindowMs: 60000 }
  quietHours:  { start: '', end: '' }
  context:     { messages: 20, chars: 1500, maxAgeMs: 1800000 }
  reply:       { quote: true, maxChars: 400, typingMsPerChar: 40, typingMaxMs: 2500 }
  members:     { enabled: true, maxPerRun: 20, everyHours: 6, minMessages: 5, days: 14 }
  coldStart:   { enabled: true, minMessages: 200, days: 30 }
  templates: {}                     # 按群覆盖：{ '123456': { mode: active, eagerness: 0.7 } }
# ── 主动私聊主人（8.1）
outreach: { enabled: false, quietHours: { start: '23:30', end: '08:30' }, maxPerDay: 4, minGapMs: 9000000, maxGapMs: 18000000, ownerQuietMs: 1800000 }
```

画像侧的键没有再嵌一层命名空间：它们本来就是顶层的，搬来搬去只会让旧配置全部失效，没有收益。
不识别的值一律回退默认并给出警告（`resolveConfig` / `resolveGroupConfig` / `resolveOutreachConfig`），不抛错。
**用户已定**：群聊准入默认不接。`qq.scope.groups` 为空 = 一个群都不接，控制台“群聊”页逐个接入（写进 `groups.json`）；
私聊准入 = `qq.scope.friends` ∪ 配对的主人，两者都空时拒绝所有私聊。

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
//             source?: { sessionId, at, quote }, sources?: [source], supersedes?: [id], mergeWith?: id, validUntil?, gen? }
//   dup / merged 命中一条被生成器撤回（retract）或被用户“这一版先拿掉”（dismiss）的记录时，它恢复原状态（QQ 来源不恢复）。
//   顺序：脱敏 → 文本指纹在“已忘掉”里就丢弃 → 和同一家里被否定的结论或边界近乎原样（≥ merge）就丢弃（rejected）
//         → mergeWith 合并 → 和同范围已有记忆 ≥ merge 判 dup → 和被否定的结论 ≥ conflict 新建为候选（conflict）
//         → ≥ ask 新建并继承旧那条的计数（ask）→ 否则 new。
//   origin 只有控制台、设置页和用户自己的写入能给 'user'，模型侧给了也记成 'model'。
memory.judge(id, verdict, { actor, text?, boundary?, scope? })   // 用户裁决，见 4.6；actor 只能是 'console' | 'dsh-settings'
//   例外 'qq-user'：用户在自己的 QQ 聊天里通过 shall_qq_memory 操作。只能动 chat:* 和 owner:chat，
//   只能 pin / unpin / forget / quiet / unquiet；purge 只能删整个本聊天，不能屏蔽、不能按前缀。
//   QQ 侧经 lib/conversation/chat-memory.js（ChatMemory）读写记忆层，不直接调这些接口。
memory.list(query) / memory.get(id)                               // 返回拷贝
memory.promptGuards(scope)       // → { rejected: [文本], boundaries: [文本] }，整家（4.5）一起算，给生成提示词用
memory.select(scopes, budgetTokens, policy?)   // → { picked, usedTokens, total, revisions, key }
//   只选 active、不 quiet、不是 boundary；排序 pinned → importance → refs → lastSeenAt → id；
//   policy = { reserve?: { [kind]: 比例 }, cap?: { 'kindA+kindB': 比例 }, exclude?: [kind], pinnedExempt?, trialSlots? }
memory.render(selection, { title, intro })     // 同样输入逐字节相同；空选择返回 ''
memory.retract(ids, { actor, reason })   // 生成器不再支持：active → candidate，candidate → historical；置顶、用户来源、挂着冲突的不动
memory.demote(ids, { actor, reason })    // 重要度 −1
memory.complete(ids, { actor, reason })  // 办完了（备忘“完成”、主动联系被拒绝）：active → historical，留在账里；置顶的和用户来源的不动
memory.recordUsage(ids, event, meta?)    // injected（按 meta.key 去重）| recalled | corrected | seen
memory.recall(query, scopes, limit?)     // active、candidate、historical 都能召回，historical 带 historical: true
memory.age(scope, { gen, now?, everyGens?, maxPerScope? })   // 过期、衰减、清理、单范围上限；返回 { decayed, expired, dropped }
memory.purge(query, actor) / memory.unblock(scope, actor)   // “忘掉我”：删整个范围，可屏蔽之后的写入
//   query 还可按 kind / status / origin 筛（给 origin 时置顶的不删）；不留文本指纹，这是“清空”不是“别记这个”。
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
| 这一版先拿掉 `dismiss` | 转为 historical，但不是禁令：生成器以后重新支持它（dup / merged）时回到原状态 | — |
| 恢复 `restore` | rejected / historical / candidate 回到 active | — |
| 挪片 `move` | 在主人的三片之间挪 | `scope`：目标片 |

设置页沿用三个按钮，底下走裁决（`lib/adapt/profile-memory.js`）：置顶 → `pin`，封印 → `wrong`，删除 → `dismiss`；
“恢复 / 取消置顶” → `restore` / `unpin`。画像条目本身就存在记忆层里（A → owner/trait，B → owner:work/avoid，
C → owner:work/works，D → owner/uncertain 候选，工作笔记 → owner:work/note），`state.json` 里的 `profile` 只是从记忆层重建的视图，
条目 id 就是记忆 id。生成结果经 `applyGeneration()` 写入：同文 → seen，改写 → supersedes，没再提到 → retract（截断那一轮不撤回）。
旧版 `state.json` 的画像、工作笔记、置顶 / 封印在记忆层还没有画像时一次性导入。

为什么换掉封印：封印要回答“新冒出来的这条是不是被封掉的那条”，靠文本相似度根本答不准（4.3 的实测）。
裁决把问题换成用户答得了的“这条对不对、还算不算数、该不该记”，并把“不对”的正确说法记下来——
生成器被纠正后得到的是“正确的是什么”，而不只是“这句别说”。

### 4.7 注入

- `owner`、`owner:work`、`persona:*` 进系统提示段（`shall:profile`、`shall:persona`，`interpolate:false`），会话中途基本不变。
- `owner:chat`、`chat:*`、`member:*` 进上下文快照 `shall:qq-memory`（`systemPrompt.context`，order 130）。空闲整理会在会话中途改它们，用快照才不会让系统提示中途变化、作废前缀缓存。
- 段与快照的文本按 `select()` 返回的 `key` 缓存，命中时返回同一个字符串。
- 空闲整理（`lib/conversation/idle.js`，actor `qq:idle`）：常驻会话停下来 `conversation.idleMinutes`（默认 20，0 关闭）分钟、
  且上次整理之后新增至少 `idleMinTurns`（默认 3）条用户发言时，只把新对话提取成碎片写进本聊天的范围；不换会话、不发消息、
  不按代数衰减。会话忙或正在交班时跳过；全插件同一时间只跑一个。水位线记在绑定记录的 `lastExtract = { sessionId, seq, at }`，
  交班在提示词里用分隔行标出水位线，线以上已经整理过。
- 画像段的选取规则（`INJECT_POLICY`）：总预算 `inject.budgetTokens`（默认 1500），trait 保底 30%，avoid + works 合计不超过 50%，
  uncertain 和 note 不注入，置顶豁免预算，两个新生试用位。只有真进了系统提示才记 `injected`（设置页预览不记）。

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
corpus.search({ chatType, chatId, query, since, limit }) / corpus.purgeMember(chatType, chatId, memberId) / corpus.purge(chatType, chatId)
qqStatus.register(fn) / qqStatus.snapshot()            // 体检快照（lib/index.js 的 createQqStatus），控制台 GET /api/qq/health 读它
qqStatus.provide(name, service) / qqStatus.service(name) // 运行时对象登记：group（引擎、设置、判断模型、语料库）、outreach、memberJobs、corrections
qq.pairing.issueCode() / qq.pairing.owner() / qq.pairing.reset()
```

体检（`lib/ui/qq-health.js`）：控制台的 QQ 页显示结论、每条问题的下一步、存活判据、关键状态、交班进度、配置摘要和主人配对；只在登录后可见。
OneBot 端口上不用登录的只有 `/shall/qq/health`，返回 `{ ok, alive, connections, version, detail }`，不带 chatId、群名、bot 账号、路径和配置。

QQ 工具在 `execute(args, exec)` 里用 `exec.agent.session.header` 判调用方：QQ 会话只能作用于自己所在的聊天，你自己的会话可作用于 scope 内任何聊天，拿不到 header 一律拒绝。
这一层与 privacy 的工具等级叠加，不互相替代。工具：`shall_qq_send`、`shall_qq_history`、`shall_qq_summary`（按需群总结：取某群最近一段时间的聊天，由模型自己写总结）、
`shall_qq_chats`、`shall_qq_alive`、`shall_qq_memory`、`shall_memory_recall`（按关键词翻记忆，只翻调用方看得到的范围：QQ 会话 = 本聊天 + 本群群友，你自己的会话 = `owner` + `owner:work`）、`shall_meme_lookup`。

点名（`lib/qq/pipeline.js`）：下面几种都算叫 bot（是否只认点名由群的档位决定，默认档位是 `active`，没被叫也可能接话），结果写在 `decision.addressedBy`：
`at`（@ bot；@全体成员不算）、`reply`（回复 bot 发过的消息：先查最近 500 条 bot 发出的 message_id，查不到时取回引用原文看发送者）、
`name`（消息里出现 `participation.aliases` 里的名字；写成“群号:名字”的只在那个群生效）、`poke`（戳一戳 bot，同一会话 60 秒内只响应一次，`participation.poke=false` 关闭）。

引用（`lib/qq/onebot/quote.js`）：消息带 reply 段时用 `get_msg` 取回原文（3 秒超时），
在正文前接一行 `[引用 发送者: 原文]`（原文压成一行、最多 200 字）；引用的是 bot 自己说的话时发送者后面标“(你)”；取不到原文时如实写“原文取不到”。

入站合并（`lib/qq/merge.js`）：同一个人在同一个聊天里连发的话，安静 `participation.mergeMs`（默认 1200）毫秒后合成一条再交给常驻会话；
换人说话、带引用、带合并转发、戳一戳都不合并，而且先把攒下的放行。`mergeMs: 0` 关闭。

投递给常驻会话的正文开头是来源标注 `[来自 QQ 群 <群号>，发言人 <昵称>（QQ <QQ号>，消息号 <消息号>）]`（私聊没有括号里的部分），
模型要用 `<at id>` / `<quote id>` 时只能用这里给出的号。被叫到时前面还会附“【群里刚才在聊……】”背景（只作本轮背景，不进记忆）。

## 7. 进程内信号总线 `lib/core/signals.js`

```js
signals.emit(event)  /  signals.on(fn) → disposer  /  signals.recent(limit)
event = { kind, source: 'qq', scope?, chatKey?, sessionId?, seq?, at, quote?, confidence?: 'high'|'low', memoryRevision?, prevAssistant? }
kind: 'correction' | 'tool-fail' | 'gui-takeover' | 'handoff-miss' | 'not-like' | 'followup'
    | 'interject-engaged' | 'interject-rejected' | 'bot-recalled' | 'bot-muted' | 'interject-silence'
```

采集（`lib/conversation/signals.js` 的 `SignalCollector`，订阅 `session/event`，只管常驻对接会话）：

| 信号 | 条件 | 置信度 |
|---|---|---|
| `gui-takeover` | 常驻会话里出现不是插件发起的用户回合（同一会话 5 分钟内最多报一次） | high |
| `tool-fail` | 同一个工具连续失败：第 2 次报一次，之后每多 3 次再报一次 | high |
| `correction` / `followup` | 用户的话**句首**是“不对 / 别这样 / 我说的是……” / “什么意思 / 没懂 / 再说一遍”，原话经脱敏、≤120 字 | low |
| `interject-*`、`bot-recalled`、`bot-muted` | 群决策引擎的插话反馈（第 8 节） | low |
| `handoff-miss` | 交班回看（第 13 节） | low |

落账（`lib/conversation/correction.js` 的 `CorrectionLedger`）保守：规则判纠正的准确度不高（调研里 F1≈0.46），所以**不自动改已有记忆**，
只按聊天范围记账（控制台可查），并在用户明确纠正时记一条**候选**的 `avoid`（“被纠正过：……”，同一个聊天 10 分钟内最多一条，等用户在记忆页确认）。
QQ 侧的信号只对应该聊天自己的范围（`chat:*` 或主人私聊的 `owner:chat`），绝不写 `owner` / `owner:work`。

## 8. 群聊回复决策 `lib/group/`

```js
const engine = new GroupEngine({ config, settings, judge, memory, signals, botName })
engine.onInbound({ chatKey: 'group:<群号>', messageId, senderId, senderName, at, text, addressed: ''|'at'|'reply'|'name'|'poke',
                   mentionsOthers, isCommand, fromBot, replyToMessageId })
  // → { respond, wait, mode: 'called'|'present'|'active'|'', reason, closing?, anchorMessageId }   同步返回
engine.onDecision(fn)        // 等时机的那种：到时间后 fn({ chatKey, respond, reason, mode, anchorMessageId, score?, threshold?, judgeReason? })
engine.noteBotReply({ chatKey, chars, text, at, messageId })   // 扣精力、记入最近消息、续在场、开始观察插话反馈
engine.noteTurnOutcome(chatKey, { spoke })  /  engine.reminderFor(chatKey)   // 连续 K 轮没开口时的提醒
engine.contextFor(chatKey, { excludeMessageId, excludeMessageIds })          // 群里最近的几条，已带过的不重复
engine.noteRecall(chatKey, messageId, { operatorIsBot }) / engine.noteBan(chatKey, banned)
engine.settingsFor(groupId) / engine.snapshot(chatKey?) / engine.ignoreSender(groupId, qq, reason)
```

五档（默认 `active`）：`silent` 只记录；`mention` 被叫到才回；`present` 点名之后，被它回复过的人 `present.minutes` 分钟或 `present.messages` 条之内接着说可以不再 @；
`active` 没人叫也可能插话；`watch` 盯群：等时机之后，把还没给常驻会话看过的群消息（不含命令、别的 bot 和已经单独交过的点名消息，最多 `watch.messages` 条 / `watch.chars` 字）整批交给常驻会话，
由主模型自己决定接不接（不调便宜模型）。两次看群至少隔 `watch.minIntervalMs`、每小时最多 `watch.perHour` 次，主动说话另受 `budget.perHour` 约束；常驻会话还在回上一轮（包括被叫到的那一轮）时不叠着送，回完再看；
看群那一轮默认不引用、不 @，要接哪条由模型写 `<quote id/>`；“连续几次没开口”的提醒在盯群档不发。五层，前四层不调模型：

1. **硬规则**：潜水档不回；被叫到的一律回（同一个人 60 秒内最多 6 次，另一个 bot 连环 @ 10 分钟内最多响应 2 次）；没被叫到时，命令消息、只 @ 了别人、别的 bot 说的、静默时段、被禁言、被绕开的人、对话已收尾，都不接。收尾只挡收尾话（附和/道别）：期间只要有人说了一句有内容的新话，立刻解除。
2. **在场状态**：见上。对方在在场期间说了附和/道别（“好的谢谢”“晚安”）就收尾，`closureMs`（默认 20 分钟）内不再接收尾话；中间有人说了有内容的新话就立刻解除；被叫到照常回，只是提示里带一句“对方像是在收尾”。
3. **等时机**：没被叫到的先等群里安静 `timing.quietMs`；新消息替换触发点；同一个群同一时间只排一次、只跑一次判断。
4. **预算**：精力（发言扣 `base + 字数 × perChar`，乘 `1.5 − eagerness`，按时间恢复）、两次发言的最短间隔、每小时主动插话上限、对话疲劳（连续主动聊久了门槛升高）。被叫到时跳过。
5. **判断**（只在 `active`）：便宜模型按五个维度打分（相关 25%、意愿 20%、社交适宜 20%、时机 15%、连贯 20%）。
   模型默认是宿主在用的 provider 下的 `deepseek-flash`：provider 先取正在跑的会话实际在用的（桌面端账号登录是 `deepseek-account`），再取宿主默认模型选择里的；
   用不了就依次换宿主注册的其他 `deepseek-*` 线路（模型名不变）、会话在用的模型、宿主默认模型，控制台写明改用了谁、为什么。用不了的模型 5 分钟内不再试；超时只算这次慢，不换模型。
   JSON 严格校验，格式不对、超时、模型不可用都当“不回”。阈值 `8 − 3.5 × eagerness`，再加疲劳和历史反馈的调整（最近被嫌弃比例高 +1.5，经常被接住 −0.5，群记忆里有“这个群不喜欢 bot 主动搭话” +1）。

插话反馈（`lib/group/feedback.js`）：主动插话后 5 分钟内，有人回复/@ 它 = `engaged`；说“闭嘴 / 没问你”（要出现在插话后的前 3 条消息里，或明确对 bot 说）、消息被别人撤回 = `rejected`；
被禁言 = `muted`；没人理 = `silence`。结果写进 `groups.json` 的接住率，被嫌弃满 2 次在该群记一条低置信度偏好，走 `signals` 总线。

运行时群设置 `lib/group/settings.js`（`groups.json`）：准入 = 配置里的 `qq.scope.groups`（含 `*`）∪ 控制台打开的群，黑名单优先；
每个群的有效设置 = 全局默认 ← `group.templates[群号]` ← 控制台写下的覆盖（`settingsForGroup`）。没接入的群只记“见过”（群号、群名、条数），不记内容。

## 8.1 主动私聊主人 `lib/outreach/`（PLAN 第 45 条）

以 SurfCore `src/purpose-engine.js`（MIT）为蓝本：纯逻辑（`logic.js`：挑话题、拼提示、回复分类）与副作用（`index.js`：落盘、闸门、投递）分开。

- 只私聊、只发给配对的主人；群聊永远不主动开口。**默认关**，在控制台“主动私聊”页打开。
- 话题只来自统一记忆层：主人聊天片 `owner:chat` 里还 active 的 `intent`（回合末尾备忘的“待续”）和 `promise`，按重要度和置信度加权随机挑；
  最近 `topicCooldownDays`（默认 3）天提过的、被拒绝的不再挑。**没有合适的话题就不发**，不靠定时问候凑数。
- 闸门（预览逐条列出，真发和预览用同一份逻辑）：总开关、已配对、有 QQ 连接、不在安静时段（23:30–08:30）、没超每日上限（4）、
  到了下次时间、主人 30 分钟内没说过话、常驻会话不忙且不在交班、有值得跟进的事。
- 下次发送时间落盘，每次检查重新算；刚打开或重启后至少再等 `minGap/2`，**不补发**；发到一半进程没了，记为 interrupted。每天的次数在投递时就扣（模型回合已经花钱了）。
- 投递的是一段提示，让常驻会话**自己决定**说不说（“不合适就只回 `<refuse/>`”）。
- 主人 6 小时内的回复当低置信度反馈：负面（“不用了/没空”）→ 这件事划掉（`memory.complete`）并 7 天不再提；正面 → 重要度 +1；中性 → 只清掉“在等回应”；连续两次没回应 → 划掉。
- 预览零副作用：真读记忆、真算闸门、真拼提示词，不发送、不写状态。

## 9. HTTP 路由

宿主前缀路由 `/shall/api/`（设置页，`lib/ui/http.js`）。OneBot 端口（默认 6700）只留反向 WS 和最小健康 JSON `/shall/qq/health`。
本机网页控制台（`lib/ui/console-server.js`，只监听 127.0.0.1，登录 + CSRF）的接口都在 `/api/` 下，路由表在 `lib/ui/console-api.js`，QQ 侧的接口在 `lib/ui/console-routes-qq.js`：

| 页面 | 接口 |
|---|---|
| 概览 / 画像 / 权限 / 人格 / 技能 / 审计 | `/overview`、`/profile*`、`/privacy`、`/sessions`、`/personas*`、`/skills*`、`/audit`、`/jobs*` |
| QQ | `GET /qq/health`、`/qq/owner`（配对）、`/qq/chats`、`/qq/members` |
| 群聊 | `GET /group`；`PUT /group/:id/admit`、`/group/:id/settings`；`DELETE /group/:id`；`POST /group/:id/forget-member`（“忘掉我”） |
| 主动私聊 | `GET /outreach`；`PUT /outreach`；`POST /outreach/preview`、`/outreach/reset` |
| 梗百科 | `GET /meme`；`POST /meme/import`；`PUT /meme/settings`；`POST/DELETE /meme/sync`；`DELETE /meme/archive`；`/meme/slang*` |
| 记忆 | `GET /memory/scopes`、`GET /memory?scope=&status=&kind=&q=`；`POST /memory/:id/judge`、`/memory/purge` |
| 信号 | `GET /signals` |

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

## 11. 梗百科 `lib/meme/`（PLAN 第 46 条）

来源：`astrbot_plugin_memewiki` v1.7.0（MIT，作者 in1t1a1）。代码思路照搬，Python 改写成 JS，借用处在文件头注明来源和许可。

**词库数据不随本插件分发**。memewiki 自带的 `memes.db`（6668 条，16 MB）内容来自 cnmeme.wiki，版权归该站和原作者。拿词库的办法都由用户在控制台“梗百科”页里点：
- 从本地导入：选一个 memewiki 的 `memes.db`（表 `memes(title, slug, tags, usage, origin, other, summary)`），复制到 `$DSH_HOME/shall/meme/memes.db`；少于现有条数的词库拒绝覆盖，除非强制。
- 联网同步（**默认关**）：从 cnmeme.wiki 公开只读接口增量同步（`GET /api/v1/public/memes?limit=30&offset=N` 列表按更新时间倒序，`GET /api/v1/public/memes/{slug}` 详情，slug 是小写标题），
  限速 0.35 秒一次，遇到 429 按 Retry-After 退避（最多 60 秒）；遇到整页没变就停；个别详情失败只记数；列表中断则本次作废、已有词库不动；可随时停，下次接着来。
  同步往 `memes.db` 里 `INSERT OR REPLACE`，并多建一张 `meme_sync(slug, updated_at)` 记更新时间。

联网是本插件**唯一**的出站请求，全部在 `lib/meme/sync.js`（`test/meme-online.mjs` 守着：lib 里只有这个文件含出站请求）。

读库用 Node 自带的 `node:sqlite`，只读打开，每次查询开连接、用完就关（memewiki 在 Windows 上吃过一直攥着句柄导致升级失败的亏）。

**查词顺序**：本群黑话（记忆层 `kind:'slang'`，范围 `chat:group:<号>`）→ 词库精确匹配 → 检索存档 → （联网打开时）联网。
- 检索存档 `search_archive.json`（`archive.js`）：查到的存 90 天，没查到的存 3 天，最多 2000 条。只存联网查到的结果；联网出错不存档（别把“出错”存成“没有这个梗”）；
  模型自己的说法、群友说的“XX 就是……”不进存档（存档对所有群通用，被带偏就是所有群一起错），群里的说法只能存成该群自己的黑话。
- 联网查词前的闸门：零成本规则先挡（`rules.js` 的 `worthLookup`：明确在问的词直接查；请求类、游戏数值、指代、疑问整句、口头禅不查），说不准的短词再过模型闸门（`gate.js`，
  同一个便宜模型，1.2 秒没回就放行，结果缓存 10 分钟，模型可以把要查的词改得更准）。

**怎么用上**：
- QQ 消息投递进常驻会话时，命中的词条作为一段附加背景跟着这条消息（“【梗百科】标题 / 怎么用、怎么接 / 出处（仅用于理解）”，最多 900 字），不进记忆、不进系统提示；
- 工具 `shall_meme_lookup`：模型拿不准时自己查（显式查词允许联网）；
- 前台约定段（`shall:frontdesk`）有梗和黑话的五条用法；
- 群黑话：控制台里按群增删改，存成记忆层的 `slang`，用户裁决那一套照样能用；
- 梗卡片只在控制台里看，不渲染成图片发到 QQ。

## 12. 回复格式：输出标签与回合末尾的内部备忘 `lib/conversation/reply-tags.js`

模型这一条回复先过 `parseReply()`（`ProgressRelay` 的 `outputFilter`），只处理代码块之外的内容，认不出的标签原样保留：

| 写法 | 效果 |
|---|---|
| `<refuse/>`（也认 `<silent/>`） | 这一回合不说话，整段回复都不发，也不补“这一轮结束了”；`<refuse ignore="QQ号"/>` 同时记下“主动搭话时绕开这个人”（他 @ bot 时照常回） |
| `<at id="QQ号"/>` | 群里 @ 某人；号必须是该群 30 分钟内说过话的人，否则丢掉这个 at |
| `<quote id="消息号"/>` | 引用某条消息回复；号必须是该群最近的消息，否则丢掉 |
| `【备忘】【目的】…【状态】完成 / 待续 / 跳过【待续】…` | 不发到 QQ。待续（≤3 条，每条 ≤80 字）存成 `intent`（文本带“待续：”前缀，模型来源，置信度 0.5，3 天后过期），下次注入时模型能看到；完成 → 划掉目的相近的待续（`memory.complete`）；跳过 → 当作这轮没开口 |

群里默认引用触发它的那条消息回复（只加在这一回合的第一条）；**不自动 @ 人**，要 @ 谁由模型自己写 `<at/>`；一条消息超过 `group.reply.maxChars` 就在段落/句末分条，条间按打字速度留间隔。
连续 `silentReminderAfter`（默认 6）次没开口，下一次提示里追加一句提醒。格式说明写在前台约定里（`REPLY_FORMAT_HELP`），备忘靠模型照着写，没写也没有副作用。

## 13. 群成员记忆、群概况冷启动、目标归属、交班回看

- **群成员记忆**（`lib/conversation/members.js`，默认开，`group.members`）：群里没 @ bot 的消息只进语料库、不进会话，所以从语料库里提取：每个群每 6 小时最多一次，每次最多 20 位新发言 ≥5 条的群友，
  每人最多 3 条（称呼、关系、偏好、说话风格、近期在做的事），写 `member:<群号>:<QQ号>`，只在该群可见。被“忘掉我”屏蔽过的范围，记忆层直接丢弃写入。
- **群概况冷启动**（`group.coldStart`）：第一次接入一个群、最近 30 天语料 ≥200 条时生成一份，全部是 `candidate`，不注入，在记忆页转正或删掉；每个群只做一次。
- **目标归属**：交班和空闲整理的提取提示词要求给“群友自己的愿望、计划、喜好”加 `about: QQ号`，写到他名下 `member:*`，不写成 bot 自己的偏好；群里成员记忆关着时这类碎片直接丢弃。
- **交班回看**（`lib/conversation/handoff-miss.js`）：交班时留下上一代最后 15 条用户原话；新一代前 3 次空闲整理里，用户的话与它的 3-gram 相似度 ≥0.4、
  且和该聊天现有记忆相似度 <0.3 的，补成记忆（模型来源、置信度 0.5、带原话出处）并发 `handoff-miss` 信号，每次最多 2 条。
- 这些都用同一个便宜模型（`lib/core/cheap-model.js`：配置的模型不可用时退回宿主默认模型，状态在控制台“群聊”页），输出当不可信输入：只取固定字段、限长、QQ 号必须是挑出来的那几位。

## 14. 图片 `lib/qq/onebot/image.js`

消息里的图片随消息一起交给常驻会话的模型看（`participation.images`，默认开），插件自己不调视觉模型、不下载 URL：

1. 由 NapCat 经 OneBot 的 `get_image` 取回（本机，不出站），返回 `base64` 就直接用，返回绝对路径就读那个文件；每条消息最多 `maxImages`（3）张，单张 ≤ `maxImageBytes`（4 MB）；
2. 类型只看魔数（PNG / JPEG / GIF / WebP），不看扩展名，不是图片或太大就少一张；
3. 以 `{ type: 'image', mediaType, data(base64) }` 放进 `sessions.prompt` 的 content。宿主在 prompt 接口里存成附件，并核对当前会话的模型是否支持图片输入，
   不支持就抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`（`dsh-api-session-controller` 的 `prompt()`）；bridge 退回纯文字重发，10 分钟内不再带图，正文里如实写“你看不到”。

正文末尾的说明：`（随消息附了 N 张图。）` / `（……另有 N 张没取到。）` / `（这条消息带图片，但当前模型不支持看图，你看不到……）`，让模型如实说看不到，不要猜。
活跃档的判断模型目前只看文字（图片是 `[图片]` 占位）。

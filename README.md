# dsh-whale-shall-adapt

DeepSeek Harness（DSH）插件。名字里的 shall 是“应”：**让 AI 应你而变**。

它把两个早先的插件合成一个：

- **画像侧**（原 `dsh-prompt-adapt`）：从你在 DSH 里的对话归纳出你的画像、人格和技能，按权限等级注入到会话里，本机网页控制台管理。
- **QQ 侧**（原 `dsh-whale-inurqq`）：把 QQ（OneBot 11 / NapCat）接进 DSH，每个 QQ 会话对应一台常驻对接会话，聊天和干活都在里面。

两边共用一层**统一记忆**，这是核心：你说过的话、你的纠正、群里发生的事，都沉淀成一条条可以被你裁决的记忆，用得越久越贴你。

> **状态**：0.1.0，还没发布。单元测试和假宿主 / 假 OneBot 的集成测试都过（见“开发与测试”），**还没在真机上跑过**（NapCat + DSH 桌面端），控制台新增的几页也还没人在真浏览器里看过样式。

## 它做什么

### 记忆（统一的一层）
- 一条记忆有范围、种类、状态、来源、置信度、账本（注入过几次、被召回几次、被纠正几次）。范围：`owner`（你的身份）、`owner:work`（干活）、`owner:chat`（只给你的 QQ 私聊）、`chat:*`（每个 QQ 聊天）、`member:群:QQ`（群友）、`persona:*`。
- **你有最终裁决权**：对 / 不对（可附正确说法）/ 过时了 / 别记这个 / 别提 / 置顶 / 恢复 / 忘掉。你说过或确认过的，模型生成的记忆碰不到。
- 写入前统一脱敏；相似的合并；与你否定过的说法冲突的先当候选，等你看。
- 注入只放一小组稳定的，其余用 `shall_memory_recall` 按需翻。QQ 会话只看得到自己该看的范围。

### QQ
- **常驻对接会话**：一个 QQ 会话 = 一台会话，聊天和干活都在它里面；上下文到阈值自动交班（先把该记的抽成记忆，再换一台干净的会话）；聊天停下来 20 分钟还会增量整理一次记忆。
- **主人**：用控制台生成的 6 位配对码，在 QQ 私聊里发给 bot，配对的 QQ 号就是你。没配对时 bot 不回复任何私聊。
- **群聊**（默认一个群都不接，在控制台逐个打开）：四档——潜水 / **点名（默认）** / 在场 / 活跃。被 @、回复它、叫它名字、戳一戳都算点名；活跃档由便宜模型（默认 deepseek-flash）判断要不要插话，受精力、冷却、每小时上限约束；插话被接住 / 被嫌弃都会反馈回来调整倾向；对话收尾（“好的谢谢”“晚安”）后 20 分钟内不再插话。
- 被叫到时附上群里刚才的几条作背景；同一个人连发的话合并成一条；回复默认引用触发它的那条；超长分条；模型可以用 `<refuse/>` 选择不说话，用 `<at/>`、`<quote/>` 指定 @ 和引用；回合末尾的“内部备忘”不发到 QQ，“待续”存成记忆，下次提醒它。
- 群成员记忆（默认开）、群概况冷启动（候选记忆）、交班回看、图片随消息交给模型（模型不支持看图时自动退回纯文字并如实告诉对方）、按需群总结。
- **主动私聊主人**（默认关）：只私聊你，只跟进你们聊过没说完的事，有一整套防刷屏的闸门；群聊永远不主动开口。
- **梗百科**：群聊里出现网络梗时附上词条背景；词库需要你自己导入（版权原因不随包分发），也可以打开联网同步（默认关）。

### 控制台
本机网页（只监听 127.0.0.1，登录 + CSRF）：概览、画像、权限、人格、技能、QQ（体检 + 配对）、**群聊**（接入、档位、成员记忆、“忘掉我”）、**主动私聊**（开关、节奏、预览）、**梗百科**、**记忆**（所有范围，逐条裁决）、审计。

## 安装

还没发布。本地开发机上：

```powershell
dsh plugin --profile desktop add link:R:\dsh-whale-shall-adapt
```

`install.ps1` 是给以后发版用的一键安装器（下载、装进 profile、登记成 bundle）；发版前它指向的仓库要先建好。

## 快速开始

1. NapCat 的 OneBot 反向 WebSocket 指向 `ws://127.0.0.1:6700`；在 DSH 凭据里加 `SHALL_ONEBOT_TOKEN`（NapCat 配同一个 token）。
2. 设置页里填 `qq.tasks.workspaceRoot`（QQ 项目目录的父目录，绝对路径）。
3. 打开控制台，QQ 页生成配对码，用你自己的 QQ 私聊 bot 发这 6 位数字。
4. 群聊页里把要接的群点“接入这个群”。想让它在群里更主动，改这个群的档位。
5. 想要主动私聊 / 联网查梗 / 导入词库，分别在“主动私聊”“梗百科”页打开。

## 数据在哪、什么会出站

- 所有数据在本机 `$DSH_HOME/shall/`（记忆、群设置、语料、交班束、梗百科词库……）。真实会话日志只读，不会被改动。
- 语料只存你接入的群，按天分片，默认保留 30 天。
- 判断模型、群成员整理、群概况会把相关群聊内容发给模型提供方（和主会话同一个信任域）。
- **插件自己唯一的出站请求**是梗百科的联网查词 / 同步（`cnmeme.wiki` 公开只读接口），默认关；测试守着这一点。

## 配置要点

一份 schema，设置页和 `cordis.patch.yml` 共用。常用的键：

| 键 | 含义 |
|---|---|
| `qq.scope.groups` / `friends` | 接入的群 / 私聊白名单。群默认空 = 一个都不接；私聊 = friends ∪ 配对的主人；`*` 表示全部 |
| `qq.participation` | `aliases`（群里叫 bot 的名字）、`poke`、`mergeMs`（连发合并，默认 1200）、`knownBots`、`images` |
| `group.defaultMode` | `silent` / `mention` / `present` / `active`，单个群在控制台改 |
| `group.judge` | 活跃档的判断模型，默认 `deepseek-official/deepseek-flash`，不可用时退回宿主默认模型 |
| `group.members` / `group.coldStart` | 群成员记忆、群概况冷启动 |
| `outreach` | 主动私聊（默认关）；开关和调参也可以在控制台改 |

完整的字段、默认值和各模块的契约见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

## 开发与测试

```powershell
node tools/run-tests.mjs                 # 全部：test/*.mjs + QQ 入口集成测试（约 5 分钟）
node tools/run-tests.mjs --only group    # 只跑文件名含 group 的单元测试
node tools/run-fast.mjs --base-port 6810 --rounds 1 --tag all   # 只跑 QQ 入口集成测试
node tools/build-client.mjs              # 设置页 bundle 改了源码（lib/ui/client/*.part.js）之后拼回 client.js
```

- 测试把 `HOME` / `USERPROFILE` / `DSH_HOME` 指到临时目录，并设 `DSH_SHALL_CONSOLE=off`；端口用 6810–6839（6700、6710 留给真实运行的 bot 和控制台）。
- 本地需要把 `@deepseek-ai/*` 联接到本机 DSH 的目录（`node_modules` 不进仓库）。
- 目录：`lib/memory`（统一记忆）、`lib/group`（群决策）、`lib/outreach`（主动私聊）、`lib/meme`（梗百科）、`lib/conversation`（常驻会话、交班、记忆接入、回复格式、信号）、`lib/qq`（OneBot、流水线、工具）、`lib/adapt`（画像 / 人格 / 技能）、`lib/privacy`（会话分类与权限）、`lib/ui`（设置页与控制台）、`lib/core`（日志、模型调用、后台任务、信号总线）。
- `docs/legacy/` 是两个来源插件当年的 README，留作参考。

## 许可与致谢

MIT。设计和部分代码借鉴了：[AstrBot 天使之心](https://github.com/kawayiYokami/astrbot_plugin_angel_heart)（分层与精力）、[心流 Heartflow](https://github.com/advent259141/Astrbot_plugin_Heartflow)（五维打分）、[群聊增强](https://github.com/Him666233/astrbot_plugin_group_chat_plus)（注意力 / 疲劳 / 引用）、[Enhance Mode](https://github.com/Axi404/astrbot_plugin_astrbot_enhance_mode)（输出标签）、[消息防抖](https://github.com/advent259141/astrbot_plugin_debounce)、astrbot_plugin_memewiki（MIT，in1t1a1，梗百科）、SurfCore（MIT，目的机制与对话收尾）。借用处在文件头注明了来源和许可。

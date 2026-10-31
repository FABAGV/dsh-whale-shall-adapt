/**
 * 插件配置 Schema。
 *
 * ⚠️ 重要：这里**故意不做 `volatile()`**。下面是踩过的坑，改之前务必读完。
 *
 * ## 坑：volatile 会摧毁配置传递
 *
 * `dsh-settings` 的 `volatileForm(schema)` 只收集被标为 volatile 的叶子字段；
 * 一个都没有时会在 `describe()` 里把整个插件条目丢弃 —— 即**设置页只显示
 * volatile 字段，没有就看不到这个插件**。
 *
 * 看起来"给所有字段加 volatile"就能解决。**但那样配置就传不进来了。**
 * 实测（schemastery 3.18）：
 *
 *     const S = z.object({ a: z.string().default('x').volatile(), b: z.string().default('y') })
 *     S['~standard'].validate({ a: 'q' })     // → { a: {}, b: 'y' }
 *     //                                            ↑ 默认值与传入值**都**被丢弃，变成空对象
 *
 * 而宿主正是通过 `resolveConfig(runtime, config)`（内部即
 * `runtime.Config['~standard'].validate(config)`）把配置交给插件的。
 * 所以 `tasks.workspaceRoot` / `connection.token` 一旦标为 volatile，
 * 插件收到的是 `{}` 而不是用户配置的值 —— `path.join({}, ...)` 直接抛错，
 * **每条任务都会失败**。
 *
 * volatile 的真实语义是「该字段的值来自运行时活值源（reactive ref），与静态配置无关」，
 * 和「让这个字段出现在设置页」不是一回事。要用它必须**同时**改成从活值源读取，
 * 只加标记会静默地丢掉配置。
 *
 * ## 因此本插件的配置来源
 *
 *   - profile 的 `cordis.patch.yml`（手改，或由 DSH 的插件配置界面写入）
 *   - 改完会触发 Loader 重新应用本插件，**无需重启 DSH**
 *   - 运行期体检在 shall 控制台的 QQ 页；OneBot 端口上只有不带身份信息的 /shall/qq/health
 *
 * 将来若要做 GUI 设置页，正确路径是：标 volatile **并且**改成从活值源读取，
 * 两者同时做，且必须用真实 loader 验证 `workspaceRoot` 仍能送达。
 *
 * ## 另一条注意
 *
 * `resolveConfig` 走的是 Standard Schema 的 `~standard.validate`，是鸭子类型判定，
 * 所以本插件自带的 schemastery 与宿主自带的可以共存。
 */
import z from '@deepseek-ai/schemastery'

/** 恒等包装：保留调用点形状，便于日后确认活值源方案后统一改造 */
const v = (schema) => schema

export const Config = z.object({
  logLevel: v(
    z
      .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
      .default('info')
      .description('日志详细程度。排查连接问题时设为 debug；日志同时写入 $DSH_HOME/shall/qq/plugin.log。'),
  ),

  connection: z
    .object({
      mount: v(
        z
          .union([z.const('own'), z.const('dsh')])
          .default('own')
          .description('own：插件自己监听端口，与 NapCat 默认配置对齐。dsh：挂在 DSH 的 Web 服务上，此时 NapCat 需指向 DSH 的端口。'),
      ),
      host: v(z.string().default('127.0.0.1').description('监听地址。只绑本机，不要暴露到公网。')),
      reversePort: v(
        z
          .natural()
          .min(1)
          .max(65535)
          .default(6700)
          .description('监听端口，必须与 NapCat 的 websocketClients.url 端口一致。端口被占用时会自动重试 20 次。'),
      ),
      reversePath: v(z.string().default('/').description('反向 WebSocket 的路径。NapCat 默认连根路径。')),
      tokenRef: v(
        z
          .string()
          .default('SHALL_ONEBOT_TOKEN')
          .description('从 DSH 凭据里读取 access token 的键名。推荐用凭据而不是明文配置；改这里无需重启，60 秒内生效。'),
      ),
      token: v(
        z
          .string()
          .role('secret')
          .default('')
          .description('access token 兜底值。留空且凭据也为空时表示不校验来源（不建议）。凭据优先于这里。'),
      ),
      callTimeoutMs: v(
        z.natural().min(1000).default(15000).description('单次 OneBot 动作调用的超时（毫秒）。'),
      ),
    })
    .description('与 OneBot 协议端的连接设置'),

  scope: z
    .object({
      groups: v(z.array(z.string()).default([]).description('接入的群。留空 = 一个群都不接；写 * = 全部群。被拉进没列出的群时只记录状态，不记语料、不回应。')),
      friends: v(z.array(z.string()).default([]).description('接入的私聊。留空 = 只接配对过的主人；写 * = 全部私聊。')),
      blockedGroups: v(z.array(z.string()).default([]).description('群黑名单，优先级高于白名单。')),
      blockedFriends: v(z.array(z.string()).default([]).description('好友黑名单，优先级高于白名单。')),
    })
    .description('哪些会话允许接入。同时决定哪些群会被采进语料库，shall_qq_send 工具也受此约束'),

  participation: z
    .object({
      privateMode: v(
        z
          .union([z.const('always'), z.const('never')])
          .default('always')
          .description('私聊消息是否直接当作任务处理。'),
      ),
      aliases: v(
        z
          .array(z.string())
          .default([])
          .description('群里叫 bot 的名字或别名。写“小鲸”全局生效，写“123456:小鲸”只在那个群生效。消息里出现这个名字、@ bot、回复 bot 说过的话，都算点名。'),
      ),
      poke: v(z.boolean().default(true).description('戳一戳 bot 时回应一下（同一个会话 60 秒内只回应一次）。')),
      mergeMs: v(z.natural().max(30000).default(1200).description('同一个人连发的话，安静这么多毫秒后合并成一条再处理（私聊和群聊都用）。0 = 不合并。')),
      images: v(z.boolean().default(true).description('消息里的图片随消息一起交给 bot 的模型看。当前模型不支持看图时自动退回纯文字，并如实告诉对方“看不到图”。')),
      maxImages: v(z.natural().min(1).max(9).default(3).description('一条消息最多带几张图。')),
      maxImageBytes: v(z.natural().min(1024).default(4 * 1024 * 1024).description('单张图的字节数上限。')),
      mediaUrls: v(
        z.boolean().default(true).description('把消息里图片/语音/视频的地址一并写进交给 bot 的正文（只展示，不抓取）。关掉就只留 [图片] 这种占位。'),
      ),
      voiceText: v(
        z.boolean().default(true).description('语音消息用 QQ 自带的语音转文字（NapCat 的 fetch_ptt_text）转成文字一并交给 bot；取不到就只给地址，不影响消息投递。'),
      ),
      knownBots: v(z.array(z.string()).default([]).description('已知是别的 bot 的 QQ 号：它们说话不主动接，连环 @ 本 bot 时限次响应，防止两个 bot 互刷。')),
    })
    .description('bot 在各会话里的参与程度'),

  tasks: z
    .object({
      workspaceRoot: v(
        z
          .string()
          .default('')
          .description('必填，且必须是完全限定路径（如 D:\\qq-projects）。每个 QQ 会话会在其下建一个子目录作为 DSH 工作区。'),
      ),
      prefix: v(z.string().default('').description('可选。指令前缀，例如 /task；命中后强制当作任务处理（优先级高于 chatPrefix）。')),
      chatPrefix: v(
        z
          .string()
          .default('')
          .description(
            '可选。闲聊前缀，例如 /chat；命中后强制当作闲聊处理。留空表示不启用。',
          ),
      ),
    })
    .description('任务与工作区'),

  /**
   * 常驻对接会话 + 阈值交班 + 碎片记忆。
   *
   * ⚠️ 仍然**绝对不用 `.volatile()`** —— 原因见本文件顶部。
   */
  conversation: z
    .object({
      handoffAtRatio: v(
        z
          .number()
          .min(0.05)
          .max(0.95)
          .default(0.25)
          .description(
            '上下文用到窗口的百分之多少时交班。**必须低于宿主 compaction 的 thresholdRatio（本 profile 实测 0.8）**，' +
              '否则压缩会先把历史摘要掉，交班拿到的是残缺历史。默认 0.25：1M 窗口下约 25 万 token ' +
              '（≈18 万汉字）触发，压缩要到 80 万才动手。取 0.25 而不是 0.55 的理由是"代价不对称"——' +
              '交班是无损的，触发早了只浪费一次 LLM 调用，触发晚了就是有损。',
          ),
      ),
      minTokensBetweenHandoffs: v(
        z
          .natural()
          .default(20000)
          .description('两次交班之间至少要增长多少 token，防止新会话刚建好就被再次判定为超阈值而连环交班。'),
      ),
      memoryBudgetTokens: v(
        z.natural().min(0).default(2000).description('常驻记忆注入新会话的 token 预算。0 表示不注入。按重要性贪心截断。'),
      ),
      injectMode: v(
        z
          .union([z.const('context'), z.const('off')])
          .default('context')
          .description(
            '常驻记忆的注入方式。context = 注册为 systemPrompt 的动态运行时上下文' +
              '（每步重算、只在文本变化时产生一条消息）；off = 不注入（只落盘、不喂给模型，用于排障）。',
          ),
      ),
      handoffRetainDays: v(z.natural().min(0).default(90).description('交班束（handoff/ 目录）保留天数，0 表示永久保留。')),
      handoffInputChars: v(
        z.natural().min(2000).default(120000).description('交班时喂给整理模型的对话历史字符上限，超出部分从头部截断。'),
      ),
      handoffMaxTokens: v(
        z.natural().min(256).default(4000).description('交班整理这一次 LLM 调用的输出上限。'),
      ),
      fragmentMergeJaccard: v(
        z
          .number()
          .min(0.5)
          .max(1)
          .default(0.82)
          .description('碎片判为"完全重复"的字符 3-gram Jaccard 阈值。达到即合并，不新增。'),
      ),
      fragmentAskJaccard: v(
        z
          .number()
          .min(0.1)
          .max(0.99)
          .default(0.3)
          .description(
            '碎片判为"可能重复"的下界：介于它与 fragmentMergeJaccard 之间的，交给交班时的同一次 LLM 裁决（mergeWith）。' +
              '默认 0.3 而非设计文档设想的 0.6 —— 实测中文真实改写的 3-gram Jaccard 只有 0.06—0.43，' +
              '按 0.6 会让 LLM 裁决永不触发（记忆池被近义碎片灌满）。这一档**永不自动合并**，' +
              '所以调低它只增加裁决机会、不增加误合并风险。',
          ),
      ),
      agingEveryGens: v(
        z
          .natural()
          .min(1)
          .default(10)
          .description('每多少代会话做一次重要性老化（importance 减 1、清理长期未提及的 +0 碎片）。'),
      ),
      maxFragmentsPerChat: v(
        z
          .natural()
          .min(10)
          .default(500)
          .description(
            '每个 QQ 会话的碎片数量上限。老化只治"长期没被提到"，治不了"每代都新增好几条"，所以需要有这个硬上限；' +
              '超出时淘汰最不重要、最久没被提到的**非钉住**碎片（pinned 一律保住）。',
          ),
      ),
      idleMinutes: v(
        z
          .natural()
          .default(20)
          .description('空闲整理：聊天停下来多少分钟后，把这段新对话提取成记忆（不换会话、不发消息）。0 表示关闭。'),
      ),
      idleMinTurns: v(
        z.natural().min(1).default(3).description('空闲整理至少要攒够多少条新的用户发言才跑，太短的对话不值得调一次模型。'),
      ),
    })
    .description('常驻对接会话、阈值交班与碎片记忆。一个 QQ 会话只接一台会话，聊天和干活都在它里面'),

  ingest: z
    .object({
      forwardRecords: v(z.boolean().default(true).description('把合并转发的内容展开并收进语料库。')),
      groupArchive: v(z.boolean().default(true).description('群消息沉淀进语料库（不进入会话上下文）。')),
    })
    .description('语境采集。语料只存本机，按会话分片，到期自动清理'),

  corpus: z
    .object({
      retainDays: v(z.natural().min(1).default(30).description('语料保留天数，到期自动清理。')),
    })
    .description('语料库'),

  advanced: z
    .object({
      dedupeWindowMs: v(
        z.natural().min(1000).default(300000).description('消息去重时间窗（毫秒）。防止协议端重连后重放。'),
      ),
      dedupeMaxEntries: v(z.natural().min(64).default(4096).description('去重缓存条目上限。')),
      relayFlushMs: v(
        z.natural().min(200).default(2000).description('进度回传的节流窗口（毫秒）。调小更实时，调大更省消息。'),
      ),
      stateDir: v(z.string().default('').description('状态文件目录。留空使用 $DSH_HOME/shall/qq。')),
    })
    .collapse()
    .description('高级选项，通常不需要改'),
})

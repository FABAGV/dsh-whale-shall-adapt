/**
 * `group` 配置的 schema（设置页和 cordis 配置校验用）。默认值与 config.js 的 GROUP_DEFAULTS 一致，
 * 运行时以 config.js 的 resolveGroupConfig 为准（它还会校验范围、给警告）。
 *
 * 和 qq/schema.legacy.js 一样，这里不用 volatile（见那个文件顶部的说明）。
 */
import z from '@deepseek-ai/schemastery'
import { GROUP_DEFAULTS } from './config.js'

const D = GROUP_DEFAULTS
const mode = z.union([z.const('silent'), z.const('mention'), z.const('present'), z.const('active'), z.const('watch')])

export const GroupSchema = z
  .object({
    defaultMode: mode
      .default(D.defaultMode)
      .description('群里默认怎么参与。silent 潜水只记录；mention 点名（被 @、回复它、叫名字、戳一戳才回，默认）；present 在场（点名之后被回复过的人可以接着说）；active 活跃（没人叫也可能插话，由便宜模型判断）；watch 盯群（群里说的话攒一小批就交给主模型看，由它自己决定接不接，最费额度）。单个群的档位在控制台改。'),
    judge: z
      .object({
        provider: z.string().default(D.judge.provider).description('活跃档判断用的模型提供方。留空（默认）= 跟宿主当前用的 provider（桌面端账号登录是 deepseek-account，填了 API key 是 deepseek-official）。不可用时退回宿主默认模型，并在控制台说明。'),
        model: z.string().default(D.judge.model).description('判断模型，deepseek-flash 便宜且能识图。'),
        timeoutMs: z.natural().min(1000).default(D.judge.timeoutMs).description('一次判断的超时（毫秒），超时就当“不回”。'),
      })
      .description('活跃档的判断模型'),
    eagerness: z.number().min(0).max(1).default(D.eagerness).description('插话积极度 0–1：越高越容易插话，同时越省精力。'),
    present: z
      .object({
        minutes: z.natural().default(D.present.minutes).description('点名之后保持在场多少分钟。'),
        messages: z.natural().default(D.present.messages).description('点名之后最多接多少条没被 @ 的消息。'),
      })
      .description('在场档'),
    budget: z
      .object({
        perHour: z.natural().default(D.budget.perHour).description('每小时最多主动插话几次（被叫到不算）。'),
        cooldownMs: z.natural().default(D.budget.cooldownMs).description('两次发言的最短间隔（毫秒）。'),
      })
      .description('主动插话的预算'),
    watch: z
      .object({
        minIntervalMs: z.natural().min(5000).default(D.watch.minIntervalMs).description('盯群档两次看群至少隔多久（毫秒）。'),
        perHour: z.natural().min(1).default(D.watch.perHour).description('盯群档每小时最多看几次（每看一次是常驻会话的一个回合）。'),
        messages: z.natural().min(1).default(D.watch.messages).description('看一次最多带几条新消息。'),
        chars: z.natural().min(200).default(D.watch.chars).description('看一次最多带多少字。'),
      })
      .description('盯群档'),
    quietHours: z
      .object({
        start: z.string().default('').description('静默时段开始，如 23:30。两项都留空 = 不设。'),
        end: z.string().default('').description('静默时段结束，如 08:30。这段时间不主动插话，被叫到照常回。'),
      })
      .description('静默时段'),
    reply: z
      .object({
        quote: z.boolean().default(D.reply.quote).description('群里回复时引用触发它的那条消息。'),
        maxChars: z.natural().min(40).default(D.reply.maxChars).description('群里一条消息的字数上限，超长的分几条发。'),
        typingMsPerChar: z.natural().default(D.reply.typingMsPerChar).description('分条发送时，按每个字多少毫秒留间隔，模拟打字。0 = 不留。'),
        typingMaxMs: z.natural().default(D.reply.typingMaxMs).description('条与条之间的间隔上限（毫秒）。'),
      })
      .description('群里回复的形式'),
    members: z
      .object({
        enabled: z.boolean().default(D.members.enabled).description('群成员记忆：记下每位群友的称呼、关系、偏好、说话风格，只在该群可见。默认开；某个人说“忘掉我”就删掉并不再记。'),
        maxPerRun: z.natural().min(1).default(D.members.maxPerRun).description('每次最多整理几位群友。'),
        everyHours: z.number().min(0.1).default(D.members.everyHours).description('每个群至少隔多少小时整理一次。'),
        minMessages: z.natural().min(1).default(D.members.minMessages).description('一位群友新发言不少于多少条才值得整理。'),
        days: z.natural().min(1).default(D.members.days).description('只看最近多少天的语料。'),
      })
      .description('群成员记忆'),
    coldStart: z
      .object({
        enabled: z.boolean().default(D.coldStart.enabled).description('第一次接入一个群时，从已有语料生成群概况（候选记忆，不注入，等你在控制台转正）。'),
        minMessages: z.natural().min(10).default(D.coldStart.minMessages).description('最近这段时间里语料不少于多少条才生成。'),
        days: z.natural().min(1).default(D.coldStart.days).description('看最近多少天的语料。'),
      })
      .description('群概况冷启动'),
    templates: z
      .dict(z.any())
      .default({})
      .description('按群覆盖以上设置，键是群号，如 { "123456": { "mode": "active", "eagerness": 0.7 } }。'),
  })
  .description('群聊回复决策')

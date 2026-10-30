/**
 * `outreach` 配置的 schema（设置页用）。运行时以 config.js 的 resolveOutreachConfig 为准。
 * 开关和调参也可以在控制台里改（写进 $DSH_HOME/shall/outreach.json，优先于这里）。
 */
import z from '@deepseek-ai/schemastery'
import { OUTREACH_DEFAULTS as D } from './config.js'

export const OutreachSchema = z
  .object({
    enabled: z.boolean().default(D.enabled).description('让机器人偶尔主动私聊你（只私聊配对的主人，群聊永远不主动开口）。默认关。它只会跟进你们聊过但没说完的事，没有就不发。'),
    quietHours: z
      .object({
        start: z.string().default(D.quietHours.start).description('安静时段开始（HH:MM）。'),
        end: z.string().default(D.quietHours.end).description('安静时段结束（HH:MM）。这段时间不会主动联系你。'),
      })
      .description('安静时段'),
    maxPerDay: z.natural().max(24).default(D.maxPerDay).description('每天最多主动联系几次。'),
    minGapMs: z.number().default(D.minGapMs).description('两次主动联系之间至少隔多少毫秒（默认 2.5 小时）。'),
    maxGapMs: z.number().default(D.maxGapMs).description('两次主动联系之间最多隔多少毫秒（默认 5 小时），实际间隔在两者之间随机。'),
    ownerQuietMs: z.number().default(D.ownerQuietMs).description('你最近这么久说过话就不打扰（默认 30 分钟）。'),
  })
  .description('主动私聊主人')

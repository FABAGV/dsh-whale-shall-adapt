/**
 * dsh-whale-shall-adapt 的统一入口。
 *
 * 一个插件、一份 Config、一张设置页。现阶段只是把两个来源插件的 apply 接到同一个 fiber 上：
 *   - 画像 / 人格 / 技能 / 权限 / 控制台（lib/adapt/plugin.js）读配置的顶层键；
 *   - QQ 通道 / 常驻对接会话（lib/qq/plugin.js）读 `qq` 子树，`logLevel` 与顶层共用。
 *
 * 两边各自用 `root.effect()` 登记卸载，所以卸载这个插件会把两边一起撤掉。
 * 统一记忆层（`$DSH_HOME/shall/memory`）在这里建一份，作为 apply 的第三个参数交给两边共用。
 *
 * ⚠️ `Config` 必须挂在默认导出对象上：cordis 的 loader 读的是 `runtime.Config`，
 * 只做命名导出时设置页拿不到 schema。
 */
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import adapt from './adapt/plugin.js'
import qq from './qq/plugin.js'
import { Config as AdaptConfig } from './adapt/schema.legacy.js'
import { Config as QqConfig } from './qq/schema.legacy.js'
import { createMemory } from './memory/index.js'
import { createBindings } from './conversation/bindings.js'
import { createMemeBase } from './meme/index.js'
import { MemeOnline } from './meme/sync.js'
import { MemeArchive } from './meme/archive.js'
import { createOwner } from './qq/owner.js'
import { GroupSchema } from './group/schema.js'
import { OutreachSchema } from './outreach/schema.js'
import { createGroupSettings } from './group/settings.js'
import { createSignals } from './core/signals.js'
import { resolveDshHome } from './adapt/state.js'

export const name = 'dsh-whale-shall-adapt'

const { logLevel: _qqLogLevel, ...qqFields } = QqConfig.dict

export const Config = z.object({
  ...AdaptConfig.dict,
  qq: z.object(qqFields).description('QQ 通道（OneBot 11）与常驻对接会话'),
  group: GroupSchema,
  outreach: OutreachSchema,
})

/** 从合并后的配置里切出两边各自的配置。纯函数，测试直接用。 */
export function splitConfig(config = {}) {
  const { qq: qqConfig = {}, group: groupConfig, outreach: outreachConfig, ...adaptConfig } = config
  return {
    adapt: adaptConfig,
    qq: { ...qqConfig, group: groupConfig, outreach: outreachConfig, logLevel: config.logLevel },
  }
}

/**
 * QQ 侧对控制台开放的东西的登记处。
 *   - register / snapshot：体检快照函数。没登记（单独装画像侧、QQ 还没启动）时 snapshot() 返回 null。
 *   - provide / service：群决策引擎、主动联系、成员整理等运行时对象。控制台的接口按名字取，没有就报“QQ 通道没有启用”。
 */
export function createQqStatus() {
  let source = null
  const services = new Map()
  return {
    register(fn) {
      source = typeof fn === 'function' ? fn : null
      return () => {
        if (source === fn) source = null
      }
    },
    snapshot() {
      return source ? source() : null
    },
    provide(name, value) {
      services.set(name, value)
      return () => {
        if (services.get(name) === value) services.delete(name)
      }
    },
    service(name) {
      return services.get(name) ?? null
    },
  }
}

export default {
  name,
  Config,
  /**
   * @param {import('@deepseek-ai/cordis').Context} root
   * @param {object} rawConfig 已经过 Config 校验的配置
   */
  apply(root, rawConfig = {}) {
    const parts = splitConfig(rawConfig)
    const home = path.join(resolveDshHome(), 'shall')
    const memory = createMemory({ dir: path.join(home, 'memory'), lock: true, store: parts.adapt?.memory?.store === 'sqlite' ? 'sqlite' : 'json' })
    const bindings = createBindings({ dir: parts.qq.advanced?.stateDir || path.join(home, 'qq') })
    // 梗百科词库由用户在控制台导入到这里；文件不存在时只查本群黑话（docs/CONTRACTS.md 第 11 节）。
    // 联网查词/同步（cnmeme.wiki 公开只读接口）默认关，用户在控制台里打开；查过的存进检索存档
    const memeDir = path.join(home, 'meme')
    const memeDb = path.join(memeDir, 'memes.db')
    const meme = createMemeBase({
      dbPath: memeDb,
      memory,
      online: new MemeOnline({ dbPath: memeDb }),
      archive: new MemeArchive({ file: path.join(memeDir, 'search_archive.json') }),
      settingsFile: path.join(memeDir, 'settings.json'),
    })
    // 主人身份绑定：$DSH_HOME/shall/owner.json（docs/CONTRACTS.md 4.8）
    const owner = createOwner({ dir: home })
    // QQ 体检快照的登记处：QQ 侧启动后把快照函数登记进来，控制台的 QQ 页读它（docs/CONTRACTS.md 第 6 节）
    const qqStatus = createQqStatus()
    // 群的运行时设置（控制台里接入哪个群、改档位）：$DSH_HOME/shall/groups.json
    const groupSettings = createGroupSettings({ dir: home })
    // 进程内信号总线：QQ 侧采集（纠正、插话反馈……），判定和落账的人订阅
    const signals = createSignals()
    root.effect(() => () => {
      meme.online?.stop()
      meme.archive?.flush()
      memory.dispose()
      groupSettings.dispose()
    })
    const shared = { memory, bindings, meme, owner, qqStatus, groupSettings, signals, home }
    adapt.apply(root, parts.adapt, shared)
    qq.apply(root, parts.qq, shared)
  },
}

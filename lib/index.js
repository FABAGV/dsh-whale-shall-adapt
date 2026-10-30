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
import { createOwner } from './qq/owner.js'
import { resolveDshHome } from './adapt/state.js'

export const name = 'dsh-whale-shall-adapt'

const { logLevel: _qqLogLevel, ...qqFields } = QqConfig.dict

export const Config = z.object({
  ...AdaptConfig.dict,
  qq: z.object(qqFields).description('QQ 通道（OneBot 11）与常驻对接会话'),
})

/** 从合并后的配置里切出两边各自的配置。纯函数，测试直接用。 */
export function splitConfig(config = {}) {
  const { qq: qqConfig = {}, ...adaptConfig } = config
  return {
    adapt: adaptConfig,
    qq: { ...qqConfig, logLevel: config.logLevel },
  }
}

/** 快照函数的登记处。没登记（单独装画像侧、QQ 还没启动）时 snapshot() 返回 null。 */
export function createQqStatus() {
  let source = null
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
    const memory = createMemory({ dir: path.join(home, 'memory') })
    const bindings = createBindings({ dir: parts.qq.advanced?.stateDir || path.join(home, 'qq') })
    // 梗百科词库由用户在控制台导入到这里；文件不存在时只查本群黑话（docs/CONTRACTS.md 第 11 节）。
    const meme = createMemeBase({ dbPath: path.join(home, 'meme', 'memes.db'), memory })
    // 主人身份绑定：$DSH_HOME/shall/owner.json（docs/CONTRACTS.md 4.8）
    const owner = createOwner({ dir: home })
    // QQ 体检快照的登记处：QQ 侧启动后把快照函数登记进来，控制台的 QQ 页读它（docs/CONTRACTS.md 第 6 节）
    const qqStatus = createQqStatus()
    root.effect(() => () => memory.dispose())
    adapt.apply(root, parts.adapt, { memory, bindings, meme, owner, qqStatus })
    qq.apply(root, parts.qq, { memory, bindings, meme, owner, qqStatus })
  },
}

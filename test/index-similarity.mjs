/**
 * 共享记忆层拿到的相似度阈值必须来自 QQ 配置（lib/index.js 的 memorySimilarityFor）。
 * 早先生产路径没传，设置页里改 fragmentMergeJaccard / fragmentAskJaccard 是空转。
 * 运行：node test/index-similarity.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memorySimilarityFor } from '../lib/index.js'
import { createMemory } from '../lib/memory/index.js'
import { DEFAULT_CONFIG } from '../lib/qq/config.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('A. 从 QQ 配置取值')
{
  const dflt = memorySimilarityFor({})
  check('默认值与 DEFAULT_CONFIG 一致',
    dflt.similarity.merge === DEFAULT_CONFIG.conversation.fragmentMergeJaccard &&
    dflt.similarity.ask === DEFAULT_CONFIG.conversation.fragmentAskJaccard,
    JSON.stringify(dflt))

  const custom = memorySimilarityFor({ qq: { conversation: { fragmentMergeJaccard: 0.9, fragmentAskJaccard: 0.4 } } })
  check('自定义值原样传下去', custom.similarity.merge === 0.9 && custom.similarity.ask === 0.4, JSON.stringify(custom))

  const invalid = memorySimilarityFor({ qq: { conversation: { fragmentMergeJaccard: 0.2, fragmentAskJaccard: 0.5 } } })
  check('ask ≥ merge 的非法组合回退默认（由 resolveConfig 兜底）',
    invalid.similarity.merge === DEFAULT_CONFIG.conversation.fragmentMergeJaccard, JSON.stringify(invalid))
}

console.log('B. 记忆层真的用了它')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-sim-'))
  const log = { info() {}, debug() {}, warn() {}, error() {} }
  const memory = createMemory({ dir: path.join(tmp, 'm'), config: memorySimilarityFor({ qq: { conversation: { fragmentMergeJaccard: 0.95 } } }), log })
  check('cfg 里是传进来的 0.95', memory.cfg.similarity.merge === 0.95)
  memory.dispose()

  const plain = createMemory({ dir: path.join(tmp, 'm2'), log })
  check('不传时还是默认 0.82', plain.cfg.similarity.merge === DEFAULT_CONFIG.conversation.fragmentMergeJaccard)
  plain.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

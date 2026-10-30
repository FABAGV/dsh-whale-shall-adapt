/**
 * 画像 → 统一记忆层的镜像（lib/adapt/memory-sync.js）。
 * 运行：node test/memory-sync.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import { syncProfileToMemory } from '../lib/adapt/memory-sync.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-memsync-'))
const memory = createMemory({ dir: tmp })
const entry = (id, category, claim, extra = {}) => ({ id, category, claim, confidence: 'high', evidence: [], ...extra })
const state = {
  profile: {
    entries: [
      entry('A1', 'A', '习惯一句话下达任务', { evidence: ['帮我把这个改了', '直接改，别问'] }),
      entry('B1', 'B', '不要在他没要求时升级依赖版本'),
      entry('C1', 'C', '先给结论再给细节'),
      entry('D1', 'D', '可能是在校学生'),
    ],
  },
  workingNotes: [{ text: '仓库在 R:\\dsh-whale-shall-adapt', at: 1 }],
  entryMarks: [],
}
const byText = (text) => memory.list({}).find((e) => e.text === text)

console.log('A. 第一次同步')
const s1 = syncProfileToMemory({ memory, state })
check('四条画像 + 一条工作笔记都写进去了', s1.added === 4 && s1.notes === 1, JSON.stringify(s1))
check('A → owner / trait', byText('习惯一句话下达任务')?.scope === 'owner' && byText('习惯一句话下达任务')?.kind === 'trait')
check('B → owner:work / avoid', byText('不要在他没要求时升级依赖版本')?.scope === 'owner:work' && byText('不要在他没要求时升级依赖版本')?.kind === 'avoid')
check('C → owner:work / works', byText('先给结论再给细节')?.scope === 'owner:work')
check('D → owner / uncertain，候选', byText('可能是在校学生')?.status === 'candidate')
check('工作笔记 → owner:work / note', byText('仓库在 R:\\dsh-whale-shall-adapt')?.kind === 'note')
check('引文变成来源（两条）', byText('习惯一句话下达任务')?.sources.length === 2)
check('来源记为 model，不是用户', byText('习惯一句话下达任务')?.origin === 'model')

console.log('B. 幂等')
const before = memory.list({}).length
const s2 = syncProfileToMemory({ memory, state })
check('同一版再同步不产生新记录', memory.list({}).length === before && s2.added === 0 && s2.updated === 0, JSON.stringify(s2))

console.log('C. 改写、消失')
state.profile.entries[2] = entry('C1', 'C', '先给结论，再按需展开细节')
state.profile.entries.splice(3, 1)
const s3 = syncProfileToMemory({ memory, state })
check('同一个 id 改写了正文：新记录推翻旧记录', s3.updated === 1 && byText('先给结论再给细节')?.status === 'historical'
  && byText('先给结论，再按需展开细节')?.supersedes.length === 1, JSON.stringify(s3))
check('画像里不再有的条目：链接删掉，记忆留作候选', !('D1' in state.memoryMirror.entries) && byText('可能是在校学生')?.status === 'candidate')

console.log('D. 用户标记')
state.entryMarks = [
  { key: 'k1', status: 'pinned', fromId: 'A1', entry: state.profile.entries[0] },
  { key: 'k2', status: 'sealed', fromId: 'B1', entry: state.profile.entries[1] },
]
syncProfileToMemory({ memory, state })
check('置顶 → 记忆置顶', byText('习惯一句话下达任务')?.pinned === true)
check('封印 → 记忆判“不对”', byText('不要在他没要求时升级依赖版本')?.status === 'rejected')
check('判“不对”之后，同样的话再出现被挡掉',
  memory.observe({ scope: 'owner:work', kind: 'avoid', text: '不要在他没要求时升级依赖版本', actor: 'profile' }).action === 'rejected')
state.entryMarks = []
syncProfileToMemory({ memory, state })
check('取消置顶、解除封印都同步回来', byText('习惯一句话下达任务')?.pinned === false && byText('不要在他没要求时升级依赖版本')?.status === 'active')
state.entryMarks = [{ key: 'k3', status: 'sealed', fromId: 'gone', entry: { claim: '画像里早就没有的结论', category: 'A' } }]
syncProfileToMemory({ memory, state })
check('封印一条画像里已经没有的结论：先补记，再判“不对”', byText('画像里早就没有的结论')?.status === 'rejected')

console.log('E. 清空画像')
state.profile = null
state.workingNotes = []
state.entryMarks = []
const s5 = syncProfileToMemory({ memory, state })
check('画像清空后所有镜像条目撤回，置顶的除外', s5.retracted >= 2 && memory.list({ scopePrefix: 'owner', status: 'active' }).every((e) => e.pinned || e.origin !== 'model'), JSON.stringify(s5))
check('没有记忆层时什么都不做', JSON.stringify(syncProfileToMemory({ memory: null, state })) === JSON.stringify({ added: 0, updated: 0, retracted: 0, notes: 0, marks: 0 }))

memory.dispose()
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

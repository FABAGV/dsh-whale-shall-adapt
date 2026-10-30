/**
 * 画像 ↔ 统一记忆层（lib/adapt/profile-memory.js）。纯本地：临时目录，不碰宿主。
 * 运行：node test/profile-memory.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import {
  profileEntries, applyGeneration, importLegacyProfile, addWorkingNotes, workingNotes, promptGuards,
  createProfileInjector, recordInjected, markEntry, clearMark, markViews, ledgerView, hasProfileMemory,
} from '../lib/adapt/profile-memory.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-profile-memory-'))
const fresh = (name) => createMemory({ dir: path.join(tmp, name) })
const e = (category, claim, extra = {}) => ({ id: extra.id ?? `n${Math.random().toString(36).slice(2, 7)}`, category, claim, confidence: 'high', evidence: ['原话一', '原话二'], ...extra })

console.log('A. 生成结果写入与视图')
{
  const m = fresh('a')
  const first = applyGeneration(m, [], [
    e('A', '习惯一句话下达任务，细节靠追问补'),
    e('B', '不要未经确认就批量改动用户的文件'),
    e('C', '先给结论再展开理由效果最好'),
    e('D', '可能偏好深色主题的界面配色'),
  ])
  const v1 = profileEntries(m)
  check('四类都写进去了', first.added === 4 && v1.length === 4, JSON.stringify(first))
  check('分类顺序 A B C D，id 是记忆 id', v1.map((x) => x.category).join('') === 'ABCD' && v1.every((x) => /^m\d{6}$/.test(x.id)))
  check('A/D 在 owner，B/C 在 owner:work', m.get(v1[0].id).scope === 'owner' && m.get(v1[1].id).scope === 'owner:work'
    && m.get(v1[3].id).scope === 'owner' && m.get(v1[3].id).status === 'candidate')
  check('引文进了 sources，置信度换回三档', v1[0].evidence.length === 2 && v1[0].confidence === 'high')

  const second = applyGeneration(m, v1, [v1[0], { ...v1[1], claim: '不要未经确认就批量改动或删除用户的文件' }, v1[3]])
  const v2 = profileEntries(m)
  check('未变 / 改写 / 撤回各一', second.unchanged === 2 && second.updated === 1 && second.retracted === 1, JSON.stringify(second))
  check('改写推翻了旧条目', v2.some((x) => x.claim.includes('或删除')) && m.get(v1[1].id).status === 'historical')
  check('没再提到的 C 撤回成候选', m.get(v1[2].id).status === 'candidate' && !v2.some((x) => x.id === v1[2].id))
  applyGeneration(m, v2, [...v2, e('C', '先给结论再展开理由效果最好')])
  check('撤回的那条被重新支持就回来，id 不变', profileEntries(m).some((x) => x.id === v1[2].id))

  const before = profileEntries(m).length
  const partial = applyGeneration(m, profileEntries(m), [], { partial: true })
  check('截断（partial）那一轮不撤回任何条目', partial.retracted === 0 && profileEntries(m).length === before)
  m.dispose()
}

console.log('B. 处置按钮')
{
  const m = fresh('b')
  applyGeneration(m, [], [e('A', '喜欢用表格对比几个方案'), e('A', '回复里不要用表情符号'), e('B', '不要在回答末尾追加总结段落')])
  const [x, y, z] = profileEntries(m)
  check('置顶', markEntry(m, { status: 'pinned', id: x.id }).ok && profileEntries(m).find((r) => r.id === x.id).pinned)
  check('置顶上限', markEntry(m, { status: 'pinned', id: y.id }, { maxPinned: 1 }).ok === false)
  const sealed = markEntry(m, { status: 'sealed', claim: y.claim })
  check('按正文找到并封印（= 不对）', sealed.ok && m.get(y.id).status === 'rejected' && !profileEntries(m).some((r) => r.id === y.id))
  check('删除 = 这一版先拿掉', markEntry(m, { status: 'deleted', id: z.id }).ok && m.get(z.id).status === 'historical')
  const views = markViews(m)
  check('三个区的数据', views.length === 3 && ['pinned', 'sealed', 'deleted'].every((s) => views.some((v) => v.status === s)))
  const g = promptGuards(m)
  check('提示词护栏：否定的、过时的、置顶的', g.rejected.includes(y.claim) && g.outdated.some((o) => o.claim === z.claim) && g.pinned.includes(x.claim))
  applyGeneration(m, profileEntries(m), [...profileEntries(m), e('A', '回复里不要用表情符号')])
  check('被封印的原样复述被挡住', !profileEntries(m).some((r) => r.claim === '回复里不要用表情符号'))
  applyGeneration(m, profileEntries(m), [...profileEntries(m), e('B', '不要在回答末尾追加总结段落')])
  check('删除的那条下一版还有依据就回来（不是禁令）', m.get(z.id).status === 'active' && markViews(m).every((v) => v.key !== z.id))
  markEntry(m, { status: 'deleted', id: z.id })
  check('恢复封印的', clearMark(m, y.id).ok && m.get(y.id).status === 'active')
  check('取消置顶', clearMark(m, x.id).ok && !m.get(x.id).pinned)
  check('不存在的标记', clearMark(m, 'm999999').ok === false && markEntry(m, { status: 'pinned', id: 'nope' }).ok === false)
  const kept = applyGeneration(m, profileEntries(m), [])
  check('置顶过又取消的不受保护，但用户没确认过的才会被撤回', kept.retracted >= 1)
  m.dispose()
}

console.log('C. 注入')
{
  const m = fresh('c')
  const items = []
  for (let i = 0; i < 30; i += 1) items.push(e('A', `第${i}条稳定特质：${'甲乙丙丁戊己庚辛壬癸'.slice(i % 10)}${'描述'.repeat(10)}${i}`))
  for (let i = 0; i < 30; i += 1) items.push(e(i % 2 ? 'B' : 'C', `第${i}条做法：${'子丑寅卯辰巳午未申酉'.slice(i % 10)}${'说明'.repeat(10)}${i}`))
  items.push(e('D', '可能喜欢在深夜写代码'))
  applyGeneration(m, [], items)
  const plan = createProfileInjector(m)
  const p1 = plan(1500)
  const p2 = plan(1500)
  check('内容没变返回同一个对象和同一个字符串', p1 === p2 && p1.text === p2.text)
  check('不超预算，有省略标注', !p1.overBudget && p1.estimatedTokens <= 1500 && p1.annotation.includes('本次注入'), `${p1.estimatedTokens}`)
  check('A 类有保底，B+C 不超过一半', p1.injectedByCategory.A > 0 && p1.injectedByCategory.B + p1.injectedByCategory.C > 0)
  check('D 类不注入', !p1.text.includes('深夜写代码'))
  const pinTarget = profileEntries(m).filter((r) => r.category === 'A').at(-1)
  markEntry(m, { status: 'pinned', id: pinTarget.id })
  const p3 = plan(1500)
  check('置顶后重新渲染，并保证注入', p3 !== p1 && p3.injectedIds.includes(pinTarget.id) && p3.text.includes('【置顶】'))
  check('预览不记账', ledgerView(m, p3).counts[pinTarget.id] === 0)
  recordInjected(m, p3)
  recordInjected(m, p3)
  check('注入记了账，同一版只记一次', ledgerView(m, p3).counts[pinTarget.id] === 1)
  check('D 类和总数都算进统计', p3.totalEntries === 61 && p3.omittedByCategory.D === 1)
  check('预算 0 不注入', plan(0).text === '')
  m.dispose()
}

console.log('D. 旧画像导入与工作笔记')
{
  const m = fresh('d')
  const state = {
    profile: { version: 7, entries: [e('A', '说话喜欢简短直接'), e('B', '不要替用户做决定'), e('D', '也许在准备考研')] },
    workingNotes: [{ text: '项目仓库在 R 盘的 dsh-whale-shall-adapt', at: 1 }],
    entryMarks: [
      { key: 'x', status: 'pinned', entry: { claim: '说话喜欢简短直接', category: 'A' } },
      { key: 'y', status: 'sealed', entry: { claim: '用户是一名大学老师', category: 'A' } },
    ],
  }
  check('导入 3 条', importLegacyProfile(m, state) === 3 && hasProfileMemory(m))
  check('置顶带过来了', profileEntries(m).find((r) => r.claim === '说话喜欢简短直接')?.pinned === true)
  check('封印的变成“不对”', promptGuards(m).rejected.includes('用户是一名大学老师'))
  check('工作笔记带过来了，不进画像', workingNotes(m).length === 1 && !profileEntries(m).some((r) => r.claim.includes('仓库')))
  check('第二次不再导入', importLegacyProfile(m, state) === 0)
  check('笔记去重', addWorkingNotes(m, ['项目仓库在 R 盘的 dsh-whale-shall-adapt', '短']) === 0)
  m.dispose()
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

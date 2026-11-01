/**
 * 模仿群友的「写人格」加强（2026-11-01）：
 *   - 生成 / 修订提示词里的反套话与「落到具体场景」要求确实写进了提示词；
 *   - 「说话习惯」由本地统计算出、随版本存下来、注入文本里出现，且字节稳定（系统提示缓存靠它）。
 * 运行：node test/persona-prompt.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PersonaStore,
  buildGeneratePrompt,
  buildRefinePrompt,
  renderPersonaText,
} from '../lib/adapt/persona.js'
import { describeHabit } from '../lib/adapt/persona-material.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-persona-prompt-'))
const log = { info() {}, debug() {}, warn() {}, error() {} }
const member = { kind: 'member', name: '小王', source: { memberName: '小王' } }

console.log('A. 生成提示词')
{
  const prompt = buildGeneratePrompt(member, {
    scenes: [
      { n: 1, lines: [{ who: 'other', name: '甲', text: '这周末有人去打球吗' }, { who: 'self', text: '?' }] },
      { n: 2, lines: [{ who: 'other', name: '乙', text: '你这人真行' }, { who: 'self', text: '笑死 你才行' }] },
    ],
    statsText: '按他最近 20 条发言实算：…',
  })
  check('反套话：给出了“放到谁身上都成立”的反例', prompt.includes('放到谁身上都成立') || prompt.includes('放在谁身上都成立') && prompt.includes('内心细腻'))
  check('要求每句指回具体场景', prompt.includes('指回具体的场景编号'))
  check('要求写出节奏（开口/长度/标点/连发）', prompt.includes('节奏') && prompt.includes('连不连着发'))
  check('要求照抄三个只属于他的说法', prompt.includes('至少照抄三个只属于他的说法'))
  check('挑场景要求覆盖四类情境', prompt.includes('被夸') && prompt.includes('有人求助') && prompt.includes('冷场'))
  check('排除看不出态度的场景', prompt.includes('只有“嗯”“好”这种看不出态度的场景不要选'))
  check('分析要求“找依据 / 看不出就写看不出”', prompt.includes('找不到依据的就写“看不出”'))
  check('场景仍以 JSON 数据行的形式给出', prompt.includes('"n":1') && prompt.includes('这周末有人去打球吗'))
  check('隐私红线还在', prompt.includes('不要记录他的个人信息'))
  check('描述型人格不受群友要求影响', !buildGeneratePrompt({ kind: 'description', name: 'a', description: 'b' }).includes('场景编号'))
}

console.log('B. 修订提示词')
{
  const prompt = buildRefinePrompt({ name: '小王' }, { v: 2, spec: '我懒得理人', origin: 'generate' }, [
    { message: '你好', reply: '您好，很高兴为您服务', rating: 'bad', note: '太官方' },
  ])
  check('笼统反馈要先指出最不像的两处', prompt.includes('最不像的两处'))
  check('不许顺手加戏', prompt.includes('不要顺手加一堆'))
  check('仍然只改自白、不要套话', prompt.includes('放到谁身上都成立') || prompt.includes('放在谁身上都成立'))
  check('反馈作为数据行给模型', prompt.includes('太官方'))
}

console.log('C. describeHabit')
{
  const stats = {
    messages: 40, medianChars: 4, shortShare: 0.5, longShare: 0.05,
    noPunctShare: 0.6, periodShare: 0.02, questionShare: 0.1, exclaimShare: 0.02,
    tildeShare: 0.0, ellipsisShare: 0.0, emojiShare: 0.01, burstShare: 0.3,
    phrases: [{ text: '笑死', count: 5, share: 0.12 }, { text: '行吧', count: 4, share: 0.1 }],
    repeats: [{ text: '6', count: 3 }],
  }
  const habit = describeHabit(stats)
  check('给长度和短句比例', habit.includes('4 个字左右') && habit.includes('五个字以内的占 50%'))
  check('说不打标点的比例', habit.includes('一个标点都不打的占 60%'))
  check('说几乎不用句号', habit.includes('几乎不用句号'))
  check('基本不用表情', habit.includes('基本不用表情'))
  check('说连发习惯', habit.includes('爱连发'))
  check('带上真实的口头常用（含出现比例/次数）', habit.includes('笑死') && habit.includes('原样说过 3 次'))
  check('同一份统计输出完全一致（注入要字节稳定）', describeHabit(stats) === habit)
  check('没有统计时给空串', describeHabit(null) === '' && describeHabit({ messages: 0 }) === '')
  const long = describeHabit({ ...stats, medianChars: 42, longShare: 0.4, emojiShare: 0.5, tildeShare: 0.2, ellipsisShare: 0.3, exclaimShare: 0.4, questionShare: 0.5 })
  check('长句 + 爱用表情：说法随之改变', long.includes('三四十个字') && long.includes('常带表情'))
}

console.log('D. 存进版本、注入文本')
{
  const store = new PersonaStore({ dir: path.join(tmp, 'persona'), log })
  const created = store.create({ name: '小王', kind: 'member', source: { chatType: 'group', chatId: '1', memberId: '10001', memberName: '小王' }, consent: true })
  check('建得起来', created.ok === true, created.error)
  const id = created.persona.id
  const habit = '一条消息通常 4 个字左右。口头常用：笑死（12% 的消息里有）。'
  const saved = store.addVersion(id, { spec: '我懒得跟人客套，能一个字说完不说两个', origin: 'generate', habit })
  check('版本存下来了', saved.ok === true && saved.version === 1)
  const persona = store.get(id)
  const version = persona.versions.find((v) => v.v === 1)
  check('版本里带着说话习惯', version.habit === habit, version.habit)

  const text = renderPersonaText(persona)
  check('注入文本里有说话习惯段落', text.includes('他的说话习惯') && text.includes('笑死'))
  check('注入文本仍写明不冒充本人', text.includes('你不是小王本人'))
  check('同一版本渲染两次字节一致', renderPersonaText(persona) === text)

  const manual = store.addManualVersion(id, { spec: '我懒得跟人客套，能一个字说完不说两个。就这样' })
  check('手改版本沿用说话习惯', manual.ok === true && store.get(id).versions.find((v) => v.v === 2)?.habit === habit)

  const plain = store.create({ name: '描述型', kind: 'description', description: '冷淡' })
  store.addVersion(plain.persona.id, { spec: '我不爱说话', origin: 'generate' })
  const plainText = renderPersonaText(store.get(plain.persona.id))
  check('没有习惯的版本不出现这一段', !plainText.includes('他的说话习惯'))

  const old = store.get(id)
  old.versions.find((v) => v.v === 1).habit = ''
  check('老数据（没有 habit 字段）按空处理', !renderPersonaText({ ...old, activeVersion: 1 }).includes('他的说话习惯'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0

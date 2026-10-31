/**
 * 模仿群友的素材：场景切分、本地统计、原话片段的挑选与编辑格式（lib/adapt/persona-material.js）。
 * 运行：node test/persona-material.mjs
 */
import {
  memberScenes,
  memberStats,
  describeStats,
  cleanExcerpts,
  scenesToExcerpts,
  excerptsToText,
  parseExcerptText,
} from '../lib/adapt/persona-material.js'
import { PersonaStore, renderPersonaText } from '../lib/adapt/persona.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const T0 = 1_700_000_000_000
const msg = (i, senderId, senderName, text) => ({ ts: T0 + i * 20_000, senderId, senderName, text, forwarded: false })

console.log('A. 场景切分')
{
  const records = [
    msg(0, '2', '阿花', '今天谁去吃火锅'),
    msg(1, '3', '老王', '我去'),
    msg(2, '1', '小明', '笑死'),
    msg(3, '1', '小明', '你们吃 我看着'),
    msg(4, '2', '阿花', '小明你又不来'),
    msg(5, '1', '小明', '懒得动'),
    msg(200, '1', '小明', '早'),
  ]
  const scenes = memberScenes(records, '1')
  check('每段他连着说的话算一个场景，编号从 1 起按时间排', scenes.length === 3 && scenes.map((s) => s.n).join() === '1,2,3' && scenes[0].ts < scenes[2].ts)
  const first = scenes[0]
  check('前面带最多两条别人的话', first.lines.filter((l) => l.who === 'other').length === 2 && first.lines[0].text === '今天谁去吃火锅')
  check('他连着说的几条放在一个场景里', first.lines.filter((l) => l.who === 'self').map((l) => l.text).join('|') === '笑死|你们吃 我看着')
  check('别人的名字换成甲乙丙（每个场景各自编）', first.lines[0].name === '甲' && first.lines[1].name === '乙' && scenes[1].lines[0].name === '甲')
  check('隔得太久的别人的话不算前文', scenes[2].lines.length === 1 && scenes[2].lines[0].text === '早')
  const secret = memberScenes([msg(0, '2', '阿花', '我邮箱 a@b.com'), msg(1, '1', '小明', '我手机 13812345678')], '1')
  check('文字过一遍脱敏', !JSON.stringify(secret).includes('13812345678') && !JSON.stringify(secret).includes('a@b.com'))
  check('按字数限量（至少留一个）', memberScenes(records, '1', { maxChars: 5 }).length === 1)
  check('重复的话只留一次', memberScenes([msg(0, '1', '小明', '6'), msg(100, '1', '小明', '6')], '1').length === 1)
}

console.log('B. 本地统计')
{
  const own = ['哈哈哈 离谱', '笑死', '哈哈哈 真的假的', '冲', '笑死', '这也行？', '哈哈哈', '好吧。', '笑死', '我觉得这个方案其实挺好的就是有点贵而且还要等很久才能到手不过也没别的选择']
  const others = ['大家好', '今天天气不错', '哈哈', '有人吗', '收到收到']
  const records = []
  let i = 0
  for (let k = 0; k < Math.max(own.length, others.length); k += 1) {
    if (others[k]) records.push(msg(i++, '2', '阿花', others[k]))
    if (own[k]) records.push(msg(i++, '1', '小明', own[k]))
  }
  const stats = memberStats(records, '1')
  check('条数和中位长度', stats.messages === 10 && stats.medianChars >= 2 && stats.medianChars <= 5, JSON.stringify({ n: stats.messages, median: stats.medianChars }))
  check('短句（5 字以内，空格不算）、长句、问号、句号比例', stats.shortShare === 0.8 && stats.longShare === 0.1 && stats.questionShare === 0.1 && stats.periodShare === 0.1)
  check('他比别人常说的词（带出现比例）', stats.phrases.some((p) => p.text === '哈哈哈' && p.share === 0.3), JSON.stringify(stats.phrases))
  check('短词被包含在长词里时只留长的', !stats.phrases.some((p) => p.text === '哈哈'))
  check('原样说过好几次的话', stats.repeats.some((r) => r.text === '笑死' && r.count === 3))
  const text = describeStats(stats)
  check('写成中文说明，比例写成百分数', text.includes('最近 10 条') && text.includes('哈哈哈（30%）') && text.includes('「笑死」3 次'))
  check('没有他的发言：null / 空串', memberStats(records, '999') === null && describeStats(null) === '')
}

console.log('C. 原话片段')
{
  const scenes = Array.from({ length: 12 }, (_, k) => ({ n: k + 1, ts: T0 + k, lines: [{ who: 'other', name: '甲', text: `问题${k + 1}` }, { who: 'self', name: '', text: `回答${k + 1}` }] }))
  const picked = scenesToExcerpts(scenes, [3, 3, 99, 'x', 5])
  check('按模型挑的编号照搬原文：去重、丢掉无效编号', picked.length === 2 && picked.every((e) => /^回答(3|5)$/.test(e.lines[1].text)))
  check('同一组片段每次顺序一样', JSON.stringify(scenesToExcerpts(scenes, [5, 3])) === JSON.stringify(scenesToExcerpts(scenes, [3, 5])))
  const local = scenesToExcerpts(scenes, [])
  check('模型没挑：本地按时间均匀挑 8 段', local.length === 8 && new Set(local.map((e) => e.lines[1].text)).size === 8)
  check('片段最多 12 段，每段至少有一句是他说的', cleanExcerpts([...scenes, ...scenes].map((s) => ({ lines: s.lines }))).length === 12 &&
    cleanExcerpts([{ lines: [{ who: 'other', name: '甲', text: '只有别人' }] }]).length === 0)

  const text = excerptsToText(picked, '小明')
  check('写成编辑框格式：「名字: 话」，空行隔开', text === '甲: 问题3\n小明: 回答3\n\n甲: 问题5\n小明: 回答5' || text === '甲: 问题5\n小明: 回答5\n\n甲: 问题3\n小明: 回答3', JSON.stringify(text))
  const parsed = parseExcerptText('甲: 吃了吗\n小明: 刚吃\n\n我: 冲\n乙：在吗\n没写名字的一行', '小明')
  check('编辑框文本解析回来：他自己的名字或「我」算他说的', parsed.length === 2 && parsed[0].lines[1].who === 'self' && parsed[1].lines[0].who === 'self' && parsed[1].lines[1].name === '乙')
  check('没写名字的行算他说的', parsed[1].lines[2].who === 'self' && parsed[1].lines[2].text === '没写名字的一行')
  check('往返一次不变', JSON.stringify(parseExcerptText(excerptsToText(parsed, '小明'), '小明')) === JSON.stringify(parsed))
  check('数字开头的冒号不当名字（“12:30 开会”）', parseExcerptText('12:30 开会', '小明')[0].lines[0].text === '12:30 开会')
}

console.log('D. 原话随人格注入、手动编辑存新版本')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-persona-material-'))
  const store = new PersonaStore({ dir })
  const persona = store.create({ name: '小明', kind: 'member', source: { chatType: 'group', chatId: '123', memberId: '1', memberName: '小明' }, consent: true }).persona
  const excerpts = [{ lines: [{ who: 'other', name: '甲', text: '吃了吗' }, { who: 'self', name: '', text: '刚吃 笑死' }] }]
  store.addVersion(persona.id, { spec: '我懒得理那些热脸贴冷屁股的人', excerpts, analysis: '他很懒', statsText: '按他最近 3 条发言实算：', origin: 'generate' })
  const text = renderPersonaText(store.get(persona.id))
  check('注入：自白 + 原话片段', text.includes('我懒得理那些热脸贴冷屁股的人') && text.includes('甲: 吃了吗\n小明: 刚吃 笑死'))
  check('性格分析和统计不注入', !text.includes('他很懒') && !text.includes('最近 3 条'))
  const same = store.addManualVersion(persona.id, { spec: '我懒得理那些热脸贴冷屁股的人' })
  check('手改但什么都没变：不存新版本', same.ok === false && store.get(persona.id).versions.length === 1)
  const edited = store.addManualVersion(persona.id, { spec: '我懒得理那些人，看他们折腾倒挺有意思', excerptsText: '甲: 吃了吗\n小明: 刚吃' })
  const v2 = store.get(persona.id).versions.at(-1)
  check('手改：存成新版本、设为当前版本、来源 manual', edited.ok && edited.version === 2 && store.get(persona.id).activeVersion === 2 && v2.origin === 'manual' && v2.basedOn === 1)
  check('手改：记下改了什么，分析和统计沿用', v2.changes.includes('手动改了风格说明') && v2.changes.includes('手动改了原话片段') && v2.analysis === '他很懒' && v2.statsText.startsWith('按他最近'))
  check('手改：空自白不存', store.addManualVersion(persona.id, { spec: '   ' }).ok === false)
  const fresh = store.create({ name: '自己写的', kind: 'description', manual: true })
  check('不写描述、勾“自己写”也能创建', fresh.ok === true)
  const first = store.addManualVersion(fresh.persona.id, { spec: '我说话很慢', material: { excerpts, statsText: 'x' } })
  check('没有旧版本时用调用方给的原话片段', first.ok && store.get(fresh.persona.id).versions[0].excerpts.length === 1 && store.get(fresh.persona.id).versions[0].changes[0] === '自己写的第一版')
  check('不勾“自己写”又不写描述：拒绝', store.create({ name: 'x', kind: 'description' }).ok === false)
  const reloaded = new PersonaStore({ dir })
  check('重启后原话片段还在', reloaded.get(persona.id).versions.at(-1).excerpts[0].lines[1].text === '刚吃')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

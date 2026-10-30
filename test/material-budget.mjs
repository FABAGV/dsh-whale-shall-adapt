/**
 * 材料预算（`collectHumanMessages()` 的 `maxMaterialChars`）的回归：给"发言很多的老用户"的成本刹车。
 * 只从**最旧**的丢，最新一条永不丢，`since` 语义不变，返回形状仍是数组，stats 自洽。
 *
 * 运行：node test/material-budget.mjs
 */
import { DEFAULT_MAX_MATERIAL_CHARS, collectHumanMessages } from '../lib/adapt/profile.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log('')
  console.log('='.repeat(72))
  console.log(title)
  console.log('='.repeat(72))
}

section('e. 材料预算：从最旧开始丢、最新一条永不丢、stats 自洽、since 不变')
{
  const COUNT = 12
  const texts = Array.from(
    { length: COUNT },
    (_, index) => `第${index + 1}条真人发言：` + '材料内容'.repeat(12),
  )
  function humanEvent(time, text) {
    return {
      type: 'user/message',
      time,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }
  }
  const events = texts.map((text, index) => humanEvent(1000 + index, text))
  // 一条**不是真人发言**的事件（source.kind 不是 user）：必须照旧被筛掉，不进 stats.total
  events.push({
    type: 'user/message',
    time: 5000,
    message: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '系统注入' }] },
  })
  const bySession = new Map([['s1', events]])
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0)

  // —— e1：不传 maxMaterialChars（材料远小于默认上限）→ 与现在一致：一条都不丢 ——
  const plain = collectHumanMessages(bySession, { maxMessageChars: 500 })
  check('★ 不传 `maxMaterialChars` 时行为与现在一致（不丢）',
    plain.length === COUNT && plain[0].text === texts[0] &&
      plain[COUNT - 1].text === texts[COUNT - 1],
    `保留 ${plain.length}/${COUNT} 条`)
  check('返回值形状仍是数组（调用方依赖 `messages.length` / `slice(-N)`）', Array.isArray(plain))
  check('不传 `stats` 也不崩', plain.length === COUNT)
  check(`默认上限就是导出的常量（${DEFAULT_MAX_MATERIAL_CHARS}）`,
    DEFAULT_MAX_MATERIAL_CHARS === 80000, String(DEFAULT_MAX_MATERIAL_CHARS))
  check(`本次材料总量 ${totalChars} 字符远小于默认上限（所以"不丢"是真实结论）`,
    totalChars < DEFAULT_MAX_MATERIAL_CHARS)
  check('显式 `Infinity` = 不限，同样不丢',
    collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: Infinity }).length === COUNT)

  // —— e2：maxMaterialChars 生效 → 从最旧开始丢 ——
  const BUDGET = 200
  const stats = {}
  const capped = collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: BUDGET, stats })
  check('★ 超预算时确实丢了（这条夹具真的超预算）', capped.length < COUNT && capped.length > 0,
    `保留 ${capped.length}/${COUNT} 条`)
  check('★ 保留的是原序列的**后缀**（丢的永远是最旧的那几条）',
    capped.map(item => item.text).join('|') === texts.slice(COUNT - capped.length).join('|'))
  check('★ 最新一条永不丢', capped[capped.length - 1].text === texts[COUNT - 1])
  check('★ 已经丢到不能再丢（再多留一条就越过预算）',
    (() => {
      const firstKeptIndex = COUNT - capped.length
      if (firstKeptIndex <= 0) return false
      return stats.chars + texts[firstKeptIndex - 1].length > BUDGET
    })(),
    `再多留一条 = ${stats.chars + texts[COUNT - capped.length - 1].length} > ${BUDGET}`)
  check('★ 落进预算（`stats.chars` ≤ 上限）', stats.chars <= BUDGET, `${stats.chars} <= ${BUDGET}`)
  check('★ 编号不重排（保留的是"全局第 N 条"）',
    capped[0].index === COUNT - capped.length + 1, `index ${capped[0].index}`)

  // —— e3：stats 自洽 ——
  check('★ `stats.total` = 筛掉非真人发言后的候选条数', stats.total === COUNT, String(stats.total))
  check('★ `stats.kept + stats.dropped === stats.total`',
    stats.kept + stats.dropped === stats.total,
    `${stats.kept} + ${stats.dropped} = ${stats.total}`)
  check('★ `stats.kept` 与实际返回条数一致', stats.kept === capped.length, String(stats.kept))
  check('★ `stats.chars` = 返回文本的真实字符总数',
    stats.chars === capped.reduce((sum, item) => sum + item.text.length, 0), String(stats.chars))

  // —— e4：预算比单条还小 → 仍然留下最新一条 ——
  const tinyStats = {}
  const tiny = collectHumanMessages(bySession, { maxMessageChars: 500, maxMaterialChars: 10, stats: tinyStats })
  check('★ 预算比单条还小也留下最新一条', tiny.length === 1 && tiny[0].text === texts[COUNT - 1])
  check('★ tiny 的 stats 同样自洽',
    tinyStats.kept === 1 && tinyStats.dropped === COUNT - 1 &&
      tinyStats.kept + tinyStats.dropped === tinyStats.total,
    JSON.stringify(tinyStats))

  // —— e5：since 语义不变 \
  const sinceStats = {}
  const sinceList = collectHumanMessages(bySession, { maxMessageChars: 500, since: 1000 + 4, stats: sinceStats })
  check('★ `since` 仍然生效（时间 <= since 的照旧被跳过）',
    sinceList.length === COUNT - 5 && sinceList[0].text === texts[5],
    `保留 ${sinceList.length} 条`)
  check('★ `since` 先筛、材料预算只作用于筛剩的那批（两道闸门可叠加）',
    sinceStats.total === COUNT - 5 && sinceList[0].text === texts[5])
  check('`since` 路径的编号照旧从 1 起（现状不变）', sinceList[0].index === 1, String(sinceList[0].index))
  check('组合使用时 stats 仍自洽',
    sinceStats.kept + sinceStats.dropped === sinceStats.total && sinceStats.kept === sinceList.length)

  // —— e6：逐条截断（maxMessageChars）不受影响 ——
  const longText = '很长的发言'.repeat(200)
  const longMap = new Map([['s1', [humanEvent(1, longText)]]])
  const truncated = collectHumanMessages(longMap, { maxMessageChars: 50, maxMaterialChars: 80000 })
  check('★ 逐条截断仍在（`maxMessageChars` 先截，材料预算再算总账）',
    truncated.length === 1 && truncated[0].text.endsWith('…[截断]') &&
      truncated[0].text.length === 50 + '…[截断]'.length,
    `${truncated[0].text.length} 字符`)
}

console.log('')
console.log('='.repeat(72))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(72))
process.exit(fail === 0 ? 0 : 1)

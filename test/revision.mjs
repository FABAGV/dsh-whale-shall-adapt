/**
 * “复制之后画像又改了几处”：服务端按记忆 id 算（lib/adapt/revision.js）。运行：node test/revision.mjs
 */
import { computeRevision, snapshotEntries, SNAPSHOT_FORMAT } from '../lib/adapt/revision.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const e = (id, claim, extra = {}) => ({ id, category: 'A', claim, ...extra })
const snap = (entries, extra = {}) => ({ text: '画像文本', at: 1000, profileVersion: 3, entries: snapshotEntries(entries), algorithmVersion: SNAPSHOT_FORMAT, ...extra })
const base = [e('m000001', '喜欢简短回答'), e('m000002', '不要擅自改文件'), e('m000003', '先给结论')]

console.log('A. 没有基线 / 基线过旧')
{
  check('从没复制过', computeRevision({ text: null, at: null, entries: null }, base).status === 'no-baseline')
  check('没有快照对象', computeRevision(null, base).status === 'no-baseline')
  check('旧格式快照（id 是 A1 这类每版重来的）→ 要重新复制', computeRevision(snap([e('A1', 'x')]), base).status === 'stale-baseline')
  check('旧版本号的快照也算过旧', computeRevision(snap(base, { algorithmVersion: 'entries-v1' }), base).status === 'stale-baseline')
  check('当前画像是空的', computeRevision(snap(base), []).status === 'empty-current')
  check('带出基线时间和版本', (() => { const r = computeRevision(snap(base), base); return r.baselineAt === 1000 && r.baselineProfileVersion === 3 })())
}

console.log('B. 比较')
{
  const same = computeRevision(snap(base), base)
  check('没变：0 处', same.status === 'clean' && same.count === 0)
  const added = computeRevision(snap(base), [...base, e('m000004', '新结论')])
  check('新增一条', added.count === 1 && added.added[0].claim === '新结论' && added.status === 'dirty')
  const removed = computeRevision(snap(base), base.slice(0, 2))
  check('少了一条', removed.count === 1 && removed.removed[0].id === 'm000003')
  const edited = computeRevision(snap(base), [base[0], e('m000002', '不要擅自改动文件'), base[2]])
  check('同 id 改了正文：算修改', edited.count === 1 && edited.modified[0].before.claim === '不要擅自改文件' && edited.modified[0].after.claim === '不要擅自改动文件')
  const rewritten = computeRevision(snap(base), [base[0], e('m000009', '没有确认不要改文件', { supersedes: ['m000002'] }), base[2]])
  check('改写（新记录 supersedes 旧记录）：算 1 处，不算删一条加一条',
    rewritten.count === 1 && rewritten.modified.length === 1 && rewritten.added.length === 0 && rewritten.removed.length === 0)
  const mixed = computeRevision(snap(base), [base[0], e('m000009', '改写后', { supersedes: ['m000002'] }), e('m000010', '全新的')])
  check('改写 + 新增 + 删除各算各的', mixed.modified.length === 1 && mixed.added.length === 1 && mixed.removed.length === 1 && mixed.count === 3)
  const twice = computeRevision(snap(base), [base[0], e('m000009', 'a', { supersedes: ['m000002'] }), e('m000010', 'b', { supersedes: ['m000002'] }), base[2]])
  check('一条旧记录只配一次对', twice.modified.length === 1 && twice.added.length === 1)
  check('置顶之类不影响比较', computeRevision(snap(base), base.map((x) => ({ ...x, pinned: true }))).count === 0)
}

console.log('C. 快照')
{
  const s = snapshotEntries([e('m000001', '甲', { evidence: ['原话'], confidence: 'high' }), { id: '', claim: '无 id' }, { id: 'm000002', claim: '' }, null])
  check('只存 id、分类、正文，丢掉没 id 或没正文的', s.length === 1 && Object.keys(s[0]).sort().join() === 'category,claim,id')
  check('不是数组时给空数组', snapshotEntries(undefined).length === 0)
}

console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

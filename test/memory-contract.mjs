/**
 * 统一记忆层的契约测试（docs/CONTRACTS.md 第 4 节）。纯本地：临时目录、假时钟，不碰宿主。
 * 运行：node test/memory-contract.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory, compareMemories } from '../lib/memory/index.js'
import { jaccard, estimateTokens } from '../lib/memory/text.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-memory-'))
let clock = 1_800_000_000_000
const now = () => clock
const fresh = (name, config) => createMemory({ dir: path.join(tmp, name), now, config })

console.log('A. observe')
{
  const m = fresh('a')
  const r1 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇没补', actor: 'qq:handoff', importanceDelta: 1 })
  check('新建返回 new 和插件分配的 id', r1.action === 'new' && /^m\d{6}$/.test(r1.id), JSON.stringify(r1))
  const r2 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇没补！', actor: 'qq:handoff', importanceDelta: 2 })
  check('几乎相同的话判为 dup，计数和重要度累加', r2.action === 'dup' && r2.id === r1.id && m.get(r1.id).ledger.refs === 2 && m.get(r1.id).importance === 3)
  const r3 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '换个说法也行', actor: 'qq:handoff', mergeWith: r1.id })
  check('mergeWith 指向已有记忆时合并', r3.action === 'merged' && r3.id === r1.id && m.get(r1.id).ledger.refs === 3)
  const r4 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇，周五前交', actor: 'qq:handoff' })
  check('有点像但不够像判为 ask：两条都留着，新的一条继承旧那条的计数', r4.action === 'ask' && m.get(r4.id).status === 'active' && m.get(r4.id).ledger.refs === 4 && m.get(r1.id).status === 'active', JSON.stringify(r4))
  const r5 = m.observe({ scope: 'chat:group:999', kind: 'fact', text: '论文参考文献还差三篇没补', actor: 'qq:handoff' })
  check('不同范围互不判重', r5.action === 'new' && r5.id !== r1.id)
  check('QQ 来源写 owner 被拒', m.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短回答', actor: 'qq:idle' }).action === 'dropped')
  check('画像生成器能写 owner', m.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短回答', actor: 'profile' }).action === 'new')
  check('scope 不合法被拒', m.observe({ scope: 'chat:group:abc', kind: 'fact', text: 'x', actor: 'qq' }).action === 'dropped')
  check('kind 不合法被拒', m.observe({ scope: 'owner', kind: 'whatever', text: 'x', actor: 'profile' }).action === 'dropped')
  check('缺 actor 被拒', m.observe({ scope: 'owner', kind: 'trait', text: 'x' }).action === 'dropped')
  const red = m.observe({ scope: 'owner', kind: 'note', text: '令牌是 ghp_abcdefghijklmnopqrstuvwxyz0123，别外传\n## 第二行', actor: 'profile' })
  const stored = m.get(red.id).text
  check('写入前脱敏', !stored.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), stored)
  check('正文压成一行、去掉 Markdown 标题', !stored.includes('\n') && !stored.includes('##'), stored)
  const longId = m.observe({ scope: 'owner', kind: 'note', text: '长'.repeat(500), actor: 'profile' }).id
  check('正文截到 200 字', m.get(longId).text.length === 200)
}

console.log('B. 封印与推翻')
{
  const m = fresh('b')
  const id = m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时升级依赖版本', actor: 'profile' }).id
  m.mark(id, 'seal', 'console')
  const again = m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时，升级依赖版本！', actor: 'profile' })
  check('和封印的记忆相似的新观察被挡掉', again.action === 'sealed' && again.id === id, JSON.stringify(again))
  check('被挡掉时没有新增记录', m.list({ scope: 'owner' }).length === 1)
  const other = m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时改代码风格', actor: 'profile' })
  check('只差关键内容的另一条结论不会被误封', other.action === 'new' || other.action === 'ask', JSON.stringify(other))
  const oldId = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '周三前把报告发给他', actor: 'qq:handoff' }).id
  const newId = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '截止改到下周一', actor: 'qq:handoff', supersedes: [oldId] }).id
  check('推翻：旧记忆转为候选，新记忆记下推翻了谁', m.get(oldId).status === 'candidate' && m.get(newId).supersedes.includes(oldId))
  m.mark(newId, 'pin', 'console')
  const third = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '又改成周五了', actor: 'qq:handoff', supersedes: [newId] }).id
  check('置顶的记忆不会被推翻', m.get(newId).status === 'active' && !m.get(third).supersedes.includes(newId))
}

console.log('C. select / render')
{
  const m = fresh('c')
  const ids = ['先说结论，再给细节', '命令行优先，不要图形界面截图', '中文回答，代码注释也用中文'].map((text, i) =>
    m.observe({ scope: 'owner', kind: 'trait', text, actor: 'profile', importance: 3 - i }).id)
  m.observe({ scope: 'owner', kind: 'uncertain', text: '可能是学生', actor: 'profile', importance: 9 })
  m.observe({ scope: 'owner', kind: 'trait', text: '候选不注入', actor: 'profile', status: 'candidate', importance: 9 })
  const s1 = m.select(['owner'], 1000, { exclude: ['uncertain'] })
  check('只选 active，按重要度排序，排除指定的类', s1.picked.map((e) => e.id).join() === ids.join(), s1.picked.map((e) => e.text).join(' / '))
  const t1 = m.render(s1, { title: '## 关于这个用户' })
  const t2 = m.render(m.select(['owner'], 1000, { exclude: ['uncertain'] }), { title: '## 关于这个用户' })
  check('同样的记忆集合渲染出逐字节相同的文本', t1 === t2 && t1.startsWith('## 关于这个用户'), JSON.stringify(t1.slice(0, 40)))
  check('渲染文本不带时间戳之类的活值', !/\d{10,}/.test(t1))
  check('没有选中时渲染空串', m.render(m.select(['chat:group:1'], 1000)) === '')
  check('预算 0 时什么都不选', m.select(['owner'], 0).picked.length === 0)
  const tight = m.select(['owner'], estimateTokens('先说结论，再给细节') + 1, { exclude: ['uncertain'] })
  check('预算只够一条时只选第一条（贪心截断）', tight.picked.length === 1 && tight.picked[0].id === ids[0])
  const before = m.select(['owner'], 1000).key
  m.recordUsage(ids, 'injected', { key: before })
  check('记账不改 revision（账本不影响渲染）', m.select(['owner'], 1000).key === before)
  m.observe({ scope: 'owner', kind: 'trait', text: '讨厌被反问', actor: 'profile' })
  check('内容变了 revision 才 +1', m.select(['owner'], 1000).key !== before)

  const a = { pinned: false, importance: 1, ledger: { refs: 1, lastSeenAt: 5 }, id: 'm000002' }
  const b = { pinned: false, importance: 1, ledger: { refs: 1, lastSeenAt: 5 }, id: 'm000001' }
  check('同分时按 id 定序（排序稳定）', [a, b].sort(compareMemories)[0].id === 'm000001')
}

console.log('D. select 的配额')
{
  const m = fresh('d')
  const avoids = ['不要擅自升级依赖', '别在回复里用表情', '不许删除测试文件', '别把密钥写进日志', '不要改动公共接口', '别跳过失败的测试']
  const traits = ['习惯一句话下达任务', '偏好命令行操作', '回答先给结论', '写代码要带注释', '喜欢看真实数字', '讨厌冗长的铺垫']
  for (const text of avoids) m.observe({ scope: 'owner', kind: 'avoid', text, actor: 'profile', importance: 9 })
  for (const text of traits) m.observe({ scope: 'owner', kind: 'trait', text, actor: 'profile', importance: 1 })
  const budget = 60
  const s = m.select(['owner'], budget, { reserve: { trait: 0.3 }, cap: { 'avoid+works': 0.5 } })
  const cost = (kind) => s.picked.filter((e) => e.kind === kind).reduce((n, e) => n + estimateTokens(e.text), 0)
  check('保底：trait 至少占 30% 预算（差不过一条的长度）', cost('trait') >= budget * 0.3 - 10, `trait=${cost('trait')}`)
  check('上限：avoid+works 合计不超过 50%', cost('avoid') <= budget * 0.5, `avoid=${cost('avoid')}`)
  check('总量不超预算', s.usedTokens <= budget, `used=${s.usedTokens}`)
  const pinId = m.list({ scope: 'owner', kind: 'trait' }).at(-1).id
  m.mark(pinId, 'pin', 'console')
  check('置顶豁免预算', m.select(['owner'], 1, { pinnedExempt: true }).picked.some((e) => e.id === pinId))
  const trialId = m.observe({ scope: 'owner', kind: 'trait', text: '新生条目有两条引文', actor: 'profile', importance: 0, source: { sessionId: 's1', quote: '一' } }).id
  m.observe({ scope: 'owner', kind: 'trait', text: '新生条目有两条引文', actor: 'profile', source: { sessionId: 's2', quote: '二' } })
  check('试用位：从没注入过且引文 ≥2 的新条目能进', m.select(['owner'], 40, { trialSlots: 1 }).picked.some((e) => e.id === trialId))
}

console.log('E. mark / retract / demote')
{
  const m = fresh('e')
  const id = m.observe({ scope: 'owner', kind: 'trait', text: '喜欢表格', actor: 'profile', importance: 2 }).id
  check('模型侧不能处置记忆', throws(() => m.mark(id, 'delete', 'model')))
  check('QQ 侧不能处置记忆', throws(() => m.mark(id, 'pin', 'qq:tools')))
  check('控制台能删除，并记删除次数', m.mark(id, 'delete', 'console').ok && m.get(id).status === 'deleted' && m.get(id).ledger.deletedCount === 1)
  const back = m.observe({ scope: 'owner', kind: 'trait', text: '喜欢表格', actor: 'profile' })
  check('删除的记忆可以被重新归纳回来（删除不等于封印）', back.action === 'dup' && m.get(id).status === 'active')
  check('不认识的动作返回错误', m.mark(id, 'explode', 'console').ok === false)
  check('retract 转为候选', m.retract([id], { actor: 'profile' }) === 1 && m.get(id).status === 'candidate')
  m.mark(id, 'pin', 'dsh-settings')
  check('置顶会恢复为 active，retract 不动置顶的', m.get(id).status === 'active' && m.retract([id], { actor: 'profile' }) === 0)
  const id2 = m.observe({ scope: 'chat:group:5', kind: 'fact', text: '群主姓王', actor: 'qq:handoff', importance: 2 }).id
  check('demote 重要度 −1', m.demote([id2], { actor: 'qq:handoff' }) === 1 && m.get(id2).importance === 1)
}

console.log('F. 记账')
{
  const m = fresh('f')
  const id = m.observe({ scope: 'owner', kind: 'trait', text: '偏好短句', actor: 'profile' }).id
  const key = m.select(['owner'], 100).key
  for (let i = 0; i < 5; i += 1) m.recordUsage([id], 'injected', { key })
  check('同一版选取结果只记一次注入（段每步都求值）', m.get(id).ledger.injected === 1)
  m.observe({ scope: 'owner', kind: 'trait', text: '偏好表格', actor: 'profile' })
  m.recordUsage([id], 'injected', { key: m.select(['owner'], 100).key })
  check('选取结果换了版本再记一次', m.get(id).ledger.injected === 2)
  m.recordUsage([id], 'corrected', { actor: 'signals', reason: '用户说不对' })
  check('被纠正计数并写进 history', m.get(id).ledger.corrected === 1 && m.get(id).history.at(-1).action === 'corrected')
  check('不认识的记账事件抛错', throws(() => m.recordUsage([id], 'liked')))
}

console.log('G. recall')
{
  const m = fresh('g')
  m.observe({ scope: 'chat:group:7', kind: 'fact', text: '小李在准备考研，目标是浙大', actor: 'qq:member' })
  m.observe({ scope: 'chat:group:7', kind: 'fact', text: '群里周末约了打球', actor: 'qq:member' })
  m.observe({ scope: 'chat:group:8', kind: 'fact', text: '小李在准备考研', actor: 'qq:member' })
  const hits = m.recall('考研', ['chat:group:7'])
  check('按关键词召回本范围的记忆', hits.length >= 1 && hits[0].text.includes('考研'), hits.map((h) => h.text).join(' / '))
  check('不会召回别的范围', hits.every((h) => h.scope === 'chat:group:7'))
  check('空查询返回空', m.recall('  ', ['chat:group:7']).length === 0)
}

console.log('H. age')
{
  const m = fresh('h', { aging: { everyGens: 10, staleGens: 5, dropGens: 10, maxPerScope: 3 } })
  const promise = m.observe({ scope: 'chat:private:9', kind: 'promise', text: '明天下午三点提醒他开会', actor: 'qq:handoff', validUntil: clock + 1000 }).id
  clock += 2000
  check('过期的约定降为候选', m.age('chat:private:9', { gen: 1 }).expired === 1 && m.get(promise).status === 'candidate')
  const stale = m.observe({ scope: 'chat:private:9', kind: 'fact', text: '他养了一只叫团子的橘猫', actor: 'qq:handoff', importance: 1, gen: 1 }).id
  const r = m.age('chat:private:9', { gen: 20 })
  check('很久没提到的先降重要度，降到 0 且只提到过一次就删掉', r.decayed >= 1 && m.get(stale) === null, JSON.stringify(r))
  for (let i = 0; i < 5; i += 1) m.observe({ scope: 'chat:group:3', kind: 'fact', text: `第${i}条完全不同的事实内容${'甲乙丙丁戊'[i]}`, actor: 'qq:handoff', importance: i })
  const pinned = m.list({ scope: 'chat:group:3' }).at(-1).id
  m.mark(pinned, 'pin', 'console')
  m.age('chat:group:3', { gen: 1 })
  const left = m.list({ scope: 'chat:group:3' })
  check('超过上限时从排序末尾删，置顶的保留', left.length === 3 && left.some((e) => e.id === pinned), left.map((e) => e.importance).join(','))
}

console.log('I. forget / export')
{
  const m = fresh('i')
  m.observe({ scope: 'member:100:200', kind: 'preference', text: '不喜欢被叫全名', actor: 'qq:member' })
  m.observe({ scope: 'member:100:201', kind: 'preference', text: '喜欢猫', actor: 'qq:member' })
  check('“忘掉我”只能由控制台发起', throws(() => m.forget({ scope: 'member:100:200' }, 'qq:tools')))
  check('必须给出范围', throws(() => m.forget({}, 'console')))
  check('删掉这个人的记忆', m.forget({ scope: 'member:100:200', block: true }, 'console') === 1 && m.list({ scope: 'member:100:200' }).length === 0)
  check('屏蔽之后再写也被丢弃', m.observe({ scope: 'member:100:200', kind: 'preference', text: '又说了一遍', actor: 'qq:member' }).action === 'dropped')
  check('别人的记忆不受影响', m.list({ scope: 'member:100:201' }).length === 1)
  m.unblock('member:100:200', 'console')
  check('解除屏蔽后能再写', m.observe({ scope: 'member:100:200', kind: 'preference', text: '重新认识一下', actor: 'qq:member' }).action === 'new')
  const out = m.export({ scopePrefix: 'member:100:' })
  check('导出带版本号和条目', out.version === 1 && out.entries.length === 2)
}

console.log('J. 落盘与重载')
{
  const dir = path.join(tmp, 'j')
  const m = createMemory({ dir, now })
  const id = m.observe({ scope: 'owner', kind: 'trait', text: '习惯一句话下达任务', actor: 'profile' }).id
  let changes = 0
  const off = m.onChange(() => (changes += 1))
  m.mark(id, 'pin', 'console')
  off()
  m.mark(id, 'unpin', 'console')
  check('onChange 收到通知，退订后不再收到', changes === 1)
  m.flush()
  const again = createMemory({ dir, now })
  check('重载后内容一致', again.get(id)?.text === '习惯一句话下达任务' && again.revision('owner') === m.revision('owner'))
  check('重载后 id 继续递增，不复用', again.observe({ scope: 'owner', kind: 'trait', text: '另一条完全不同的习惯', actor: 'profile' }).id > id)
  again.flush()
  fs.writeFileSync(path.join(dir, 'memory.json'), '{坏了', 'utf8')
  const recovered = createMemory({ dir, now })
  check('正式文件坏了从 .bak 恢复', recovered.get(id)?.text === '习惯一句话下达任务')
  check('get / list 返回拷贝，改了不影响仓库', (() => {
    const copy = recovered.get(id)
    copy.text = '被改了'
    return recovered.get(id).text === '习惯一句话下达任务'
  })())
  m.dispose()
  again.dispose()
  recovered.dispose()
}

console.log('K. 文本工具')
check('换个说法的中文句子相似度高于无关句子', jaccard('还差参考文献', '参考文献还没弄') > jaccard('还差参考文献', '今天天气不错'))

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

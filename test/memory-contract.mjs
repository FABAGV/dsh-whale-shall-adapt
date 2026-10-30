/**
 * 统一记忆层的契约测试（docs/CONTRACTS.md 第 4 节）。纯本地：临时目录、假时钟，不碰宿主。
 * 运行：node test/memory-contract.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory, compareMemories, familyOf } from '../lib/memory/index.js'
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
const C = { actor: 'console' }

console.log('A. observe')
{
  const m = fresh('a')
  const r1 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇没补', actor: 'qq:handoff', importanceDelta: 1 })
  check('新建返回 new 和插件分配的 id，来源默认 model', r1.action === 'new' && /^m\d{6}$/.test(r1.id) && m.get(r1.id).origin === 'model', JSON.stringify(r1))
  const r2 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇没补！', actor: 'qq:handoff', importanceDelta: 2 })
  check('几乎相同的话判为 dup，计数和重要度累加', r2.action === 'dup' && r2.id === r1.id && m.get(r1.id).ledger.refs === 2 && m.get(r1.id).importance === 3)
  const r3 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '换个说法也行', actor: 'qq:handoff', mergeWith: r1.id })
  check('mergeWith 指向已有记忆时合并', r3.action === 'merged' && r3.id === r1.id && m.get(r1.id).ledger.refs === 3)
  const r4 = m.observe({ scope: 'chat:group:123', kind: 'fact', text: '论文参考文献还差三篇，周五前交', actor: 'qq:handoff' })
  check('有点像判为 ask：两条都留着，新的一条继承计数', r4.action === 'ask' && m.get(r4.id).status === 'active' && m.get(r4.id).ledger.refs === 4 && m.get(r1.id).status === 'active', JSON.stringify(r4))
  check('不同范围互不判重', m.observe({ scope: 'chat:group:999', kind: 'fact', text: '论文参考文献还差三篇没补', actor: 'qq:handoff' }).action === 'new')
  check('scope / kind / actor 不合法被拒',
    m.observe({ scope: 'chat:group:abc', kind: 'fact', text: 'x', actor: 'qq' }).action === 'dropped'
    && m.observe({ scope: 'owner', kind: 'whatever', text: 'x', actor: 'profile' }).action === 'dropped'
    && m.observe({ scope: 'owner', kind: 'trait', text: 'x' }).action === 'dropped')
  const red = m.observe({ scope: 'owner', kind: 'note', text: '令牌是 ghp_abcdefghijklmnopqrstuvwxyz0123，别外传\n## 第二行', actor: 'profile' })
  const stored = m.get(red.id).text
  check('写入前脱敏，正文压成一行', !stored.includes('ghp_abcdefghijklmnopqrstuvwxyz0123') && !stored.includes('\n') && !stored.includes('##'), stored)
  check('正文截到 200 字', m.get(m.observe({ scope: 'owner', kind: 'note', text: '长'.repeat(500), actor: 'profile' }).id).text.length === 200)
  check('模型侧不能自称 origin=user', m.get(m.observe({ scope: 'owner', kind: 'trait', text: '冒充用户说的话', actor: 'profile', origin: 'user' }).id).origin === 'model')
}

console.log('B. 主人记忆的三片')
{
  const m = fresh('b')
  check('QQ 来源不能写 owner（身份）', m.observe({ scope: 'owner', kind: 'trait', text: '喜欢简短回答', actor: 'qq:idle' }).action === 'dropped')
  check('QQ 来源不能写 owner:work（干活）', m.observe({ scope: 'owner:work', kind: 'works', text: '先跑测试再提交', actor: 'qq:handoff' }).action === 'dropped')
  check('QQ 来源能写 owner:chat（聊天）', m.observe({ scope: 'owner:chat', kind: 'preference', text: '聊天时喜欢被叫老大', actor: 'qq:handoff' }).action === 'new')
  check('DSH 侧的画像生成器能写 owner 与 owner:work',
    m.observe({ scope: 'owner', kind: 'trait', text: '习惯一句话下达任务', actor: 'profile' }).action === 'new'
    && m.observe({ scope: 'owner:work', kind: 'works', text: '改代码前先读测试', actor: 'profile' }).action === 'new')
  check('三片同属一家', familyOf('owner') === familyOf('owner:work') && familyOf('owner:chat') === 'owner' && familyOf('chat:group:1') === 'chat:group:1')
  const id = m.list({ scope: 'owner:chat' })[0].id
  check('控制台能把一条挪到另一片', m.judge(id, 'move', { ...C, scope: 'owner' }).ok && m.get(id).scope === 'owner')
  check('不能挪出这一家', m.judge(id, 'move', { ...C, scope: 'chat:group:1' }).ok === false)
}

console.log('C. 用户裁决')
{
  const m = fresh('c')
  check('模型侧和 QQ 侧都不能裁决', throws(() => m.judge('m000001', 'wrong', { actor: 'model' })) && throws(() => m.judge('m000001', 'pin', { actor: 'qq:tools' })))
  const a = m.observe({ scope: 'owner', kind: 'trait', text: '喜欢表格', actor: 'profile' }).id
  check('对：转为用户确认', m.judge(a, 'confirm', C).ok && m.get(a).origin === 'user-confirmed' && m.get(a).confidence === 1)
  check('用户确认过的，生成器撤回、降级都不动它', m.retract([a], { actor: 'profile' }) === 0 && m.demote([a], { actor: 'profile' }) === 0 && m.get(a).status === 'active')
  const b = m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时升级依赖版本', actor: 'profile' }).id
  const w = m.judge(b, 'wrong', { ...C, text: '依赖版本可以升，但要先说一声' })
  check('不对 + 正确说法：旧的转为 rejected，新建一条用户写的', w.ok && m.get(b).status === 'rejected' && m.get(w.correctionId).origin === 'user' && m.get(w.correctionId).rejects.includes(b))
  check('近乎原样的复述被挡掉', m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时，升级依赖版本！', actor: 'profile' }).action === 'rejected')
  const c = m.observe({ scope: 'owner:work', kind: 'avoid', text: '不要在他没要求时擅自升级依赖的版本', actor: 'profile' })
  check('有点像的改写进候选并标出冲突（跨片也认）', c.action === 'conflict' && m.get(c.id).status === 'candidate' && m.get(c.id).conflictsWith === b, JSON.stringify(c))
  check('只差关键内容的另一条结论不受影响', ['new', 'ask'].includes(m.observe({ scope: 'owner', kind: 'avoid', text: '不要在他没要求时改代码风格', actor: 'profile' }).action))
  const g = m.promptGuards('owner:chat')
  check('promptGuards 给生成器列出整家被否定的结论', g.rejected.includes('不要在他没要求时升级依赖版本'), JSON.stringify(g))
  const d = m.observe({ scope: 'chat:private:5', kind: 'promise', text: '周三前把报告发给他', actor: 'qq:handoff' }).id
  const o = m.judge(d, 'outdated', { ...C, text: '截止改到下周一' })
  check('过时了：旧的转为 historical，新的一条推翻它', m.get(d).status === 'historical' && m.get(o.replacementId).supersedes.includes(d))
  check('historical 能召回并标出来，但不注入', m.recall('报告', ['chat:private:5']).some((h) => h.id === d && h.historical) && !m.select(['chat:private:5'], 500).picked.some((e) => e.id === d))
  const q = m.observe({ scope: 'owner', kind: 'fact', text: '在准备考研', actor: 'profile' }).id
  m.judge(q, 'quiet', C)
  check('别提：记着但不注入、不召回', m.get(q) && !m.select(['owner'], 500).picked.some((e) => e.id === q) && m.recall('考研', ['owner']).length === 0)
  m.judge(q, 'unquiet', C)
  check('可以提：恢复注入', m.select(['owner'], 500).picked.some((e) => e.id === q))
  check('恢复：rejected 回到 active', m.judge(b, 'restore', C).ok && m.get(b).status === 'active')
  check('不认识的裁决返回错误', m.judge(a, 'explode', C).ok === false)
}

console.log('D. 别记这个与边界')
{
  const m = fresh('d')
  const id = m.observe({ scope: 'chat:group:7', kind: 'fact', text: '老王上周离婚了', actor: 'qq:member' }).id
  const r = m.judge(id, 'forget', { ...C, boundary: '别记群友的婚恋和家庭情况' })
  check('删除这条，留一条用户写的边界', r.ok && m.get(id) === null && m.get(r.boundaryId).kind === 'boundary' && m.get(r.boundaryId).origin === 'user')
  check('原样复述被已忘指纹挡掉（不保留原文）', m.observe({ scope: 'chat:group:7', kind: 'fact', text: '老王上周离婚了', actor: 'qq:member' }).action === 'dropped'
    && !JSON.stringify(m.export({ scope: 'chat:group:7' })).includes('离婚了'))
  check('边界不注入，但给生成器看', m.select(['chat:group:7'], 500).picked.length === 0 && m.promptGuards('chat:group:7').boundaries.includes('别记群友的婚恋和家庭情况'))
  const o = m.observe({ scope: 'owner:chat', kind: 'fact', text: '不想让 bot 记住住址', actor: 'qq:handoff' }).id
  const ob = m.judge(o, 'forget', { ...C, boundary: '别记住址' })
  check('主人任一片的边界挂在共用的 owner 上，三片都看得到', m.get(ob.boundaryId).scope === 'owner' && m.promptGuards('owner:work').boundaries.includes('别记住址'))
}

console.log('E. select / render')
{
  const m = fresh('e')
  const ids = ['先说结论，再给细节', '命令行优先，不要图形界面截图', '中文回答，代码注释也用中文'].map((text, i) =>
    m.observe({ scope: 'owner', kind: 'trait', text, actor: 'profile', importance: 3 - i }).id)
  m.observe({ scope: 'owner', kind: 'uncertain', text: '可能是学生', actor: 'profile', importance: 9 })
  m.observe({ scope: 'owner', kind: 'trait', text: '候选不注入', actor: 'profile', status: 'candidate', importance: 9 })
  const s1 = m.select(['owner'], 1000, { exclude: ['uncertain'] })
  check('只选 active，按重要度排序，排除指定的类', s1.picked.map((e) => e.id).join() === ids.join(), s1.picked.map((e) => e.text).join(' / '))
  const t1 = m.render(s1, { title: '## 关于这个用户' })
  check('同样的记忆集合渲染出逐字节相同的文本', t1 === m.render(m.select(['owner'], 1000, { exclude: ['uncertain'] }), { title: '## 关于这个用户' }) && t1.startsWith('## 关于这个用户'))
  check('渲染文本不带时间戳之类的活值', !/\d{10,}/.test(t1))
  check('没有选中时渲染空串；预算 0 时什么都不选', m.render(m.select(['chat:group:1'], 1000)) === '' && m.select(['owner'], 0).picked.length === 0)
  const tight = m.select(['owner'], estimateTokens('先说结论，再给细节') + 1, { exclude: ['uncertain'] })
  check('预算只够一条时只选第一条', tight.picked.length === 1 && tight.picked[0].id === ids[0])
  const before = m.select(['owner'], 1000).key
  m.recordUsage(ids, 'injected', { key: before })
  check('记账不改 revision', m.select(['owner'], 1000).key === before)
  m.observe({ scope: 'owner', kind: 'trait', text: '讨厌被反问', actor: 'profile' })
  check('内容变了 revision 才 +1', m.select(['owner'], 1000).key !== before)
  m.observe({ scope: 'owner:work', kind: 'works', text: '提交前跑全量测试', actor: 'profile' })
  check('多片一起选：干活会话可以同时看身份和干活两片', m.select(['owner', 'owner:work'], 1000).picked.some((e) => e.scope === 'owner:work'))
  const a = { pinned: false, importance: 1, ledger: { refs: 1, lastSeenAt: 5 }, id: 'm000002' }
  const b = { pinned: false, importance: 1, ledger: { refs: 1, lastSeenAt: 5 }, id: 'm000001' }
  check('同分时按 id 定序', [a, b].sort(compareMemories)[0].id === 'm000001')
}

console.log('F. select 的配额')
{
  const m = fresh('f')
  const avoids = ['不要擅自升级依赖', '别在回复里用表情', '不许删除测试文件', '别把密钥写进日志', '不要改动公共接口', '别跳过失败的测试']
  const traits = ['习惯一句话下达任务', '偏好命令行操作', '回答先给结论', '写代码要带注释', '喜欢看真实数字', '讨厌冗长的铺垫']
  for (const text of avoids) m.observe({ scope: 'owner', kind: 'avoid', text, actor: 'profile', importance: 9 })
  for (const text of traits) m.observe({ scope: 'owner', kind: 'trait', text, actor: 'profile', importance: 1 })
  const budget = 60
  const s = m.select(['owner'], budget, { reserve: { trait: 0.3 }, cap: { 'avoid+works': 0.5 } })
  const cost = (kind) => s.picked.filter((e) => e.kind === kind).reduce((n, e) => n + estimateTokens(e.text), 0)
  check('保底：trait 至少占 30% 预算', cost('trait') >= budget * 0.3 - 10, `trait=${cost('trait')}`)
  check('上限：avoid+works 不超过 50%；总量不超预算', cost('avoid') <= budget * 0.5 && s.usedTokens <= budget, `avoid=${cost('avoid')} used=${s.usedTokens}`)
  const pinId = m.list({ scope: 'owner', kind: 'trait' }).at(-1).id
  m.judge(pinId, 'pin', C)
  check('置顶豁免预算', m.select(['owner'], 1, { pinnedExempt: true }).picked.some((e) => e.id === pinId))
  const trialId = m.observe({ scope: 'owner', kind: 'trait', text: '新生条目有两条引文', actor: 'profile', source: { sessionId: 's1', quote: '一' } }).id
  m.observe({ scope: 'owner', kind: 'trait', text: '新生条目有两条引文', actor: 'profile', source: { sessionId: 's2', quote: '二' } })
  check('试用位：从没注入过且引文 ≥2 的新条目能进', m.select(['owner'], 40, { trialSlots: 1 }).picked.some((e) => e.id === trialId))
}

console.log('G. 推翻、记账、召回')
{
  const m = fresh('g')
  const oldId = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '周三前把报告发给他', actor: 'qq:handoff' }).id
  const newId = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '截止改到下周一', actor: 'qq:handoff', supersedes: [oldId] }).id
  check('生成器推翻：旧的转为 historical', m.get(oldId).status === 'historical' && m.get(newId).supersedes.includes(oldId))
  m.judge(newId, 'confirm', C)
  const third = m.observe({ scope: 'chat:private:1', kind: 'promise', text: '又改成周五了', actor: 'qq:handoff', supersedes: [newId] }).id
  check('用户确认过的不会被生成器推翻', m.get(newId).status === 'active' && !m.get(third).supersedes.includes(newId))
  const key = m.select(['chat:private:1'], 100).key
  for (let i = 0; i < 5; i += 1) m.recordUsage([third], 'injected', { key })
  check('同一版选取结果只记一次注入', m.get(third).ledger.injected === 1)
  check('不认识的记账事件抛错', throws(() => m.recordUsage([third], 'liked')))
  m.observe({ scope: 'chat:group:7', kind: 'fact', text: '小李在准备考研，目标是浙大', actor: 'qq:member' })
  m.observe({ scope: 'chat:group:8', kind: 'fact', text: '小李在准备考研', actor: 'qq:member' })
  const hits = m.recall('考研', ['chat:group:7'])
  check('召回只看给定范围', hits.length === 1 && hits[0].scope === 'chat:group:7')
  check('空查询返回空', m.recall('  ', ['chat:group:7']).length === 0)
}

console.log('H. age')
{
  const m = fresh('h', { aging: { everyGens: 10, staleGens: 5, dropGens: 10, maxPerScope: 3 } })
  const promise = m.observe({ scope: 'chat:private:9', kind: 'promise', text: '明天下午三点提醒他开会', actor: 'qq:handoff', validUntil: clock + 1000 }).id
  clock += 2000
  check('过期的约定转为 historical', m.age('chat:private:9', { gen: 1 }).expired === 1 && m.get(promise).status === 'historical')
  const stale = m.observe({ scope: 'chat:private:9', kind: 'fact', text: '他养了一只叫团子的橘猫', actor: 'qq:handoff', importance: 1, gen: 1 }).id
  const r = m.age('chat:private:9', { gen: 20 })
  check('很久没提到的先降重要度，降到 0 且只提到一次就删掉', r.decayed >= 1 && m.get(stale) === null, JSON.stringify(r))
  for (let i = 0; i < 5; i += 1) m.observe({ scope: 'chat:group:3', kind: 'fact', text: `第${i}条完全不同的事实内容${'甲乙丙丁戊'[i]}`, actor: 'qq:handoff', importance: i })
  const low = m.list({ scope: 'chat:group:3' }).at(-1).id
  m.judge(low, 'confirm', C)
  m.age('chat:group:3', { gen: 1 })
  const left = m.list({ scope: 'chat:group:3' })
  check('超过上限时从末尾删，用户确认过的保留', left.length === 3 && left.some((e) => e.id === low), left.map((e) => e.importance).join(','))
  const rej = m.observe({ scope: 'chat:group:4', kind: 'fact', text: '群主是女生', actor: 'qq:member', gen: 1 }).id
  m.judge(rej, 'wrong', C)
  m.age('chat:group:4', { gen: 30 })
  check('rejected 不会被老化删掉（要留着挡复述）', m.get(rej)?.status === 'rejected')
}

console.log('I. purge / export / 落盘')
{
  const m = fresh('i')
  m.observe({ scope: 'member:100:200', kind: 'preference', text: '不喜欢被叫全名', actor: 'qq:member' })
  m.observe({ scope: 'member:100:201', kind: 'preference', text: '喜欢猫', actor: 'qq:member' })
  check('“忘掉我”只能由控制台发起，且必须给出范围', throws(() => m.purge({ scope: 'member:100:200' }, 'qq:tools')) && throws(() => m.purge({}, 'console')))
  check('删掉这个人的记忆并屏蔽', m.purge({ scope: 'member:100:200', block: true }, 'console') === 1
    && m.observe({ scope: 'member:100:200', kind: 'preference', text: '又说了一遍', actor: 'qq:member' }).action === 'dropped')
  check('别人的记忆不受影响', m.list({ scope: 'member:100:201' }).length === 1)
  m.unblock('member:100:200', 'console')
  check('解除屏蔽后能再写', m.observe({ scope: 'member:100:200', kind: 'preference', text: '重新认识一下', actor: 'qq:member' }).action === 'new')
  check('导出带条目', m.export({ scopePrefix: 'member:100:' }).entries.length === 2)

  const dir = path.join(tmp, 'j')
  const s = createMemory({ dir, now })
  const id = s.observe({ scope: 'owner', kind: 'trait', text: '习惯一句话下达任务', actor: 'profile' }).id
  let changes = 0
  const off = s.onChange(() => (changes += 1))
  s.judge(id, 'pin', C)
  off()
  s.judge(id, 'unpin', C)
  check('onChange 收到通知，退订后不再收到', changes === 1)
  s.flush()
  const again = createMemory({ dir, now })
  check('重载后内容一致，id 继续递增', again.get(id)?.text === '习惯一句话下达任务'
    && again.observe({ scope: 'owner', kind: 'trait', text: '另一条完全不同的习惯', actor: 'profile' }).id > id)
  again.flush()
  fs.writeFileSync(path.join(dir, 'memory.json'), '{坏了', 'utf8')
  const recovered = createMemory({ dir, now })
  check('正式文件坏了从 .bak 恢复', recovered.get(id)?.text === '习惯一句话下达任务')
  const copy = recovered.get(id)
  copy.text = '被改了'
  check('get 返回拷贝，改了不影响仓库', recovered.get(id).text === '习惯一句话下达任务')
  s.dispose()
  again.dispose()
  recovered.dispose()
}

console.log('I2. 聊天里的用户（qq-user）')
{
  const m = fresh('chat-user')
  const U = { actor: 'qq-user' }
  const own = m.observe({ scope: 'chat:private:5', kind: 'fact', text: '周五下午要去医院复查', actor: 'qq:handoff' }).id
  const ownerWork = m.observe({ scope: 'owner:work', kind: 'avoid', text: '不要擅自改动配置文件', actor: 'profile' }).id
  const added = m.observe({ scope: 'chat:private:5', kind: 'fact', text: '喜欢别人叫他老王', actor: 'qq-user', origin: 'user' })
  check('qq-user 写入可以带 user 来源', m.get(added.id).origin === 'user')
  check('qq-user 能钉住本聊天的记忆', m.judge(own, 'pin', U).ok && m.get(own).pinned)
  check('qq-user 不能判“不对”', m.judge(own, 'wrong', U).ok === false && m.get(own).status === 'active')
  check('qq-user 动不了主人的干活记忆', m.judge(ownerWork, 'forget', U).ok === false && Boolean(m.get(ownerWork)))
  check('qq-user 能忘掉本聊天的一条', m.judge(own, 'forget', U).ok && !m.get(own))
  check('qq-user 不能屏蔽、不能按前缀删', throws(() => m.purge({ scope: 'chat:private:5', block: true }, 'qq-user'))
    && throws(() => m.purge({ scopePrefix: 'chat:' }, 'qq-user')) && throws(() => m.purge({ scope: 'owner:work' }, 'qq-user')))
  check('qq-user 能清空本聊天', m.purge({ scope: 'chat:private:5' }, 'qq-user') === 1 && m.list({ scope: 'chat:private:5' }).length === 0)
  const aged = fresh('chat-user-age')
  for (let i = 0; i < 4; i += 1) aged.observe({ scope: 'chat:group:9', kind: 'fact', text: `完全不同的第${i}件事${'甲乙丙丁'[i].repeat(6)}`, actor: 'qq:handoff' })
  check('age 可以按次覆盖上限', aged.age('chat:group:9', { gen: 1, maxPerScope: 2 }).dropped === 2 && aged.list({ scope: 'chat:group:9' }).length === 2)
  m.dispose()
  aged.dispose()
}

console.log('J. 文本工具')
check('换个说法的中文句子相似度高于无关句子', jaccard('还差参考文献', '参考文献还没弄') > jaccard('还差参考文献', '今天天气不错'))

console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

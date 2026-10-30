/**
 * 梗百科：查词规则与本地词库（docs/CONTRACTS.md 第 11 节）。
 * 词库是测试里现建的合成库，不用 memewiki 随包的真实数据。
 * 运行：node test/meme.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractQuery, askedTerm, normalizeQuery, worthLookup } from '../lib/meme/rules.js'
import { createMemeBase, entryText, formatSlang, parseSlang } from '../lib/meme/index.js'
import { createMemory } from '../lib/memory/index.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-meme-'))

console.log('A. 抽词')
check('“X 是什么梗”抽出 X', extractQuery('大水理论是什么梗') === '大水理论')
check('“X 啥意思？”抽出 X', extractQuery('绝绝子啥意思？') === '绝绝子')
check('去掉开头的 @ 和 bot 名字', extractQuery('@小鲸鱼 杂鱼', { names: [] }) === '杂鱼' && extractQuery('小鲸鱼杂鱼', { names: ['小鲸鱼'] }) === '杂鱼')
check('带标点的裸词也认（“飞八分钱。”）', extractQuery('飞八分钱。') === '飞八分钱')
check('指代不抽（“这是什么意思”）', extractQuery('这是什么意思') === null)
check('口头禅不抽', extractQuery('哈哈') === null && extractQuery('晚安') === null)
check('长句不抽', extractQuery('今天下午我们一起去图书馆复习吧') === null)
check('askedTerm 从长句里抠出被问的词', askedTerm('请问阿一古是什么意思') === '阿一古' && askedTerm('什么意思没看懂') === '')

console.log('B. 重复折叠')
check('杂鱼杂鱼 → 杂鱼', normalizeQuery('杂鱼杂鱼') === '杂鱼')
check('666666 → 666', normalizeQuery('666666') === '666')
check('已取餐已取餐 → 已取餐', normalizeQuery('已取餐已取餐') === '已取餐')
check('不重复的不动', normalizeQuery('大水理论') === '大水理论')

console.log('C. 值不值得往下查（memewiki README 里的例子）')
check('明确在问梗：直接查', worthLookup('杂鱼是什么梗', '杂鱼') === true)
check('长句里顺带“什么意思”：交给模型闸门', worthLookup('你刚才那句话到底什么意思啊我没懂', '你刚才那句话到底') === null)
check('请求类不查（发图、点歌、帮我）', worthLookup('来个摸猫的表情', '来个摸猫的表情') === false && worthLookup('帮我点歌', '帮我点歌') === false)
check('游戏数值不查', worthLookup('速猪是哪八张卡', '速猪是哪八张卡') === false)
check('口头禅不查', worthLookup('666', '666') === false && worthLookup('好的', '好的') === false)
check('指代不查', worthLookup('这个', '这个') === false)
check('“我/你”开头的整句不查', worthLookup('你今天吃了', '你今天吃了') === false)
check('陌生短词交给模型闸门', worthLookup('杂鱼', '杂鱼') === null && worthLookup('马眼', '马眼') === null)
check('超过字数上限不查', worthLookup('一二三四五六七八九十一', '一二三四五六七八九十一', { maxChars: 10 }) === false)

console.log('D. 本地词库')
let haveSqlite = true
let Db = null
try {
  ;({ DatabaseSync: Db } = await import('node:sqlite'))
} catch {
  haveSqlite = false
}
const dbPath = path.join(tmp, 'memes.db')
if (haveSqlite) {
  const db = new Db(dbPath)
  db.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT)')
  const ins = db.prepare('INSERT INTO memes VALUES (?, ?, ?, ?, ?, ?, ?)')
  ins.run('大水理论', '大水理论', '文字梗、博主梗', '弱者喝饮料，强者喝大水', '出自博主长安二求', '', '')
  ins.run('你是什么冠军', '你是什么冠军', '游戏梗', '调侃对方自封第一', '出自某直播', '', '')
  ins.run('杂鱼', '杂鱼', '二次元', '', '', '', '用来嘲讽对方很弱')
  db.close()
}
const memory = createMemory({ dir: path.join(tmp, 'memory') })
memory.observe({ scope: 'chat:group:42', kind: 'slang', text: formatSlang('大水理论', '本群指每天喝两升水的打卡活动'), actor: 'console', origin: 'user' })
memory.observe({ scope: 'chat:group:42', kind: 'slang', text: formatSlang('老地方', '学校东门那家麻辣烫'), actor: 'console', origin: 'user' })
const base = createMemeBase({ dbPath, memory })

if (!haveSqlite) {
  check('当前 Node 没有 node:sqlite：status 如实报告', (await base.status()).ok === false)
} else {
  const st = await base.status()
  check('status 报出词条数', st.ok && st.count === 3, JSON.stringify(st))
  const hit = await base.lookup('大水理论')
  check('精确匹配，标签拆成数组', hit?.title === '大水理论' && hit.tags.join() === '文字梗,博主梗' && !hit.custom)
  check('消息里包含完整标题时命中最长的那个', (await base.lookup('你说你是什么冠军'))?.title === '你是什么冠军')
  check('消息只是标题前缀时不命中（“你是什么”）', (await base.lookup('你是什么')) === null)
  check('usage 为空时用 summary 兜底', (await base.lookup('杂鱼杂鱼'))?.usage === '用来嘲讽对方很弱')
  const text = entryText(hit)
  check('给模型的文本：用法在前，出处标“仅用于理解”', text.indexOf('怎么用') < text.indexOf('出处') && text.includes('仅用于理解') && text.includes('cnmeme.wiki/词条/大水理论'))
  const pre = await base.prelookup('大水理论是什么梗')
  check('prelookup 查到时直接给出背景文本', pre?.entry?.title === '大水理论' && pre.text.startsWith('【梗百科】大水理论'))
  const miss = await base.prelookup('马眼')
  check('prelookup 查不到时给出判定（交给模型闸门）', miss?.entry === undefined && miss?.verdict === null)
  check('prelookup 对整句闲聊返回 null', (await base.prelookup('今天下午我们一起去图书馆复习吧')) === null)
}

console.log('E. 本群黑话')
check('parseSlang / formatSlang 互逆', JSON.stringify(parseSlang(formatSlang('老地方', '东门麻辣烫'))) === JSON.stringify({ title: '老地方', meaning: '东门麻辣烫' }))
const slang = await base.lookup('大水理论', { chatKey: 'chat:group:42' })
check('本群黑话优先于词库', slang?.custom === true && slang.usage.includes('两升水'))
check('别的群看不到这个群的黑话', (await base.lookup('老地方', { chatKey: 'chat:group:7' })) === null)
check('私聊不查群黑话', (await base.lookup('老地方', { chatKey: 'chat:private:42' })) === null)
const own = await base.lookup('老地方', { chatKey: 'chat:group:42' })
check('词库里没有的群黑话也能查到', own?.custom === true && entryText(own).includes('本群黑话'))
memory.judge(own.memoryId, 'outdated', { actor: 'console' })
check('群黑话被判过时后不再命中', (await base.lookup('老地方', { chatKey: 'chat:group:42' })) === null)

console.log('F. 没导入词库')
const empty = createMemeBase({ dbPath: path.join(tmp, 'nope.db') })
check('status 说还没导入', (await empty.status()).reason === '还没导入词库')
check('lookup 返回 null，不抛', (await empty.lookup('大水理论')) === null)

memory.dispose()
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

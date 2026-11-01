/**
 * ChatMemory：QQ 会话的记忆视图（lib/conversation/chat-memory.js）。纯本地：临时目录，不碰宿主。
 * 运行：node test/chat-memory.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory/index.js'
import { ChatMemory } from '../lib/conversation/chat-memory.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shall-chat-memory-'))
let ownerQq = null
const owner = { owner: () => ownerQq }
const store = createMemory({ dir: tmp })
const cm = new ChatMemory({ store, owner })

console.log('A. absorb')
{
  const r = cm.absorb({
    scope: 'private:5',
    gen: 1,
    fragments: [
      { text: '周五下午要去医院复查', tag: 2, kind: 'constraint' },
      { text: '喜欢喝无糖可乐', tag: 1, kind: 'preference' },
      { text: '缺 tag 的一条', kind: 'fact' },
      { text: '不认识的 kind 归为事实', tag: 0, kind: 'weird' },
    ],
  })
  check('新增 3 条、坏 1 条', r.added === 3 && r.bad === 1, JSON.stringify(r))
  const frags = cm.forScope('private:5')
  check('写进 chat:private:5，碎片形状带回 QQ 的 scope', frags.length === 3 && frags.every((f) => f.scope === 'private:5')
    && store.list({ scope: 'chat:private:5' }).length === 3)
  check('不认识的 kind 归为 fact', frags.some((f) => f.text.startsWith('不认识') && f.kind === 'fact'))
  check('写完立即落盘', fs.existsSync(store.file) && JSON.parse(fs.readFileSync(store.file, 'utf8')).entries.length === 3)
  const again = cm.absorb({ scope: 'private:5', gen: 2, fragments: [{ text: '周五下午要去医院复查', tag: 2, kind: 'constraint' }] })
  const dup = cm.forScope('private:5').find((f) => f.text === '周五下午要去医院复查')
  check('同一句再来判为 dup，重要度累加到 4、refs 到 2', again.dup === 1 && dup.importance === 4 && dup.refs === 2)
  const cola = cm.forScope('private:5').find((f) => f.text === '喜欢喝无糖可乐')
  const other = cm.absorb({ scope: 'group:9', gen: 1, fragments: [{ text: '群里周三晚上开黑', tag: 1, kind: 'fact' }] })
  const groupId = other.ids[0]
  const dropped = cm.absorb({ scope: 'private:5', gen: 3, fragments: [], drop: [cola.id, groupId] })
  check('drop 只降本会话的', dropped.dropped === 1 && cm.forScope('private:5').find((f) => f.id === cola.id).importance === 0
    && cm.forScope('group:9')[0].importance === 1)
}

console.log('B. mutate')
{
  const first = cm.forScope('private:5')[0]
  const groupFrag = cm.forScope('group:9')[0]
  check('pin 本会话的', cm.mutate({ scope: 'private:5', action: 'pin', id: first.id }).ok && cm.forScope('private:5')[0].pinned)
  check('不能 pin 别的会话的', cm.mutate({ scope: 'private:5', action: 'pin', id: groupFrag.id }).ok === false)
  check('不能 forget 别的会话的', cm.mutate({ scope: 'private:5', action: 'forget', id: groupFrag.id }).ok === false && cm.forScope('group:9').length === 1)
  const added = cm.mutate({ scope: 'private:5', action: 'add', text: '叫他老王就行', importance: 2 })
  check('add 记成用户来源', added.ok && added.action === 'new' && store.get(added.id).origin === 'user')
  const forgot = cm.mutate({ scope: 'private:5', action: 'forget', id: added.id })
  check('forget 删掉，原样再记会被挡', forgot.ok && !store.get(added.id)
    && cm.mutate({ scope: 'private:5', action: 'add', text: '叫他老王就行' }).ok === false)
  const all = cm.mutate({ scope: 'group:9', action: 'forget-all' })
  check('forget-all 只清本会话', all.ok && all.removed === 1 && cm.forScope('group:9').length === 0 && cm.forScope('private:5').length > 0)
  check('未知动作被拒', cm.mutate({ scope: 'private:5', action: 'rewrite' }).ok === false)
}

console.log('C. 渲染')
{
  const a = cm.renderFor('private:5', 2000)
  const b = cm.renderFor('private:5', 2000)
  check('标题固定、两次逐字节相同', /^\[常驻记忆\]/.test(a.text) && a.text === b.text && a.count > 0)
  check('别的会话渲染不到', !cm.renderFor('group:9', 2000).text.includes('医院'))
  const before = cm.keyOf('private:5')
  store.recordUsage(cm.forScope('private:5').map((f) => f.id), 'seen')
  check('记账不改缓存键', cm.keyOf('private:5') === before)
  // 同一句话又说了一遍（dup）会让版本号 +1、refs / lastSeenAt 变化：
  // 这些都不是"内容变了"，注入文本必须一个字节都不动，否则宿主的前缀缓存每轮失效。
  cm.absorb({ scope: 'private:5', gen: 4, fragments: [{ text: '周五下午要去医院复查', tag: 2, kind: 'constraint' }] })
  check('重复写入同一句话：缓存键不变', cm.keyOf('private:5') === before, cm.keyOf('private:5'))
  check('重复写入同一句话：渲染文本不变', cm.renderFor('private:5', 2000).text === cm.renderFor('private:5', 2000).text)
  cm.absorb({ scope: 'private:5', gen: 4, fragments: [{ text: '下个月搬家去杭州', tag: 1, kind: 'intent' }] })
  check('内容变了缓存键跟着变', cm.keyOf('private:5') !== before)
  check('预算为 0 不注入', cm.renderFor('private:5', 0).text === '')
}

console.log('D. 主人私聊')
{
  store.observe({ scope: 'owner', kind: 'trait', text: '习惯一句话下达任务', actor: 'profile' })
  store.observe({ scope: 'owner:work', kind: 'avoid', text: '不要擅自改动配置文件', actor: 'profile' })
  ownerQq = '5'
  check('配对后私聊写到 owner:chat', cm.scopeOf('private:5') === 'owner:chat')
  const r = cm.absorb({ scope: 'private:5', gen: 5, fragments: [{ text: '最近在准备驾照科目二', tag: 1, kind: 'intent' }] })
  check('交班写进 owner:chat', r.added === 1 && store.get(r.ids[0]).scope === 'owner:chat')
  const text = cm.renderFor('private:5', 4000).text
  check('注入读 owner + owner:chat + 配对前的旧碎片', text.includes('一句话下达任务') && text.includes('科目二') && text.includes('医院'))
  check('不读 owner:work（干活的那片）', !text.includes('配置文件'))
  check('其他人的私聊不受影响', cm.scopeOf('private:6') === 'chat:private:6' && !cm.renderFor('private:6', 4000).text.includes('一句话'))
  const ownerFrag = cm.forScope('private:5')[0]
  check('主人在聊天里能钉住 owner:chat 的', cm.mutate({ scope: 'private:5', action: 'pin', id: ownerFrag.id }).ok)
  const trait = store.list({ scope: 'owner' })[0]
  check('主人在聊天里动不了 owner 片', cm.mutate({ scope: 'private:5', action: 'forget', id: trait.id }).ok === false && Boolean(store.get(trait.id)))
  check('all() 把 owner:chat 换回主人私聊的 scope', cm.all().some((f) => f.scope === 'private:5' && f.text.includes('科目二')))
  check('snapshot 带文件位置和总数', cm.snapshot().file.endsWith('memory.json') && cm.snapshot().count === cm.all().length)
}

store.dispose()
console.log(`结果：${pass} 通过 / ${fail} 失败`)
if (fail === 0) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

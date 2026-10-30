/**
 * 回复里的输出标签和内部备忘（lib/conversation/reply-tags.js）。运行：node test/reply-tags.mjs
 */
import { parseReply, REPLY_FORMAT_HELP } from '../lib/conversation/reply-tags.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('A. 内部备忘')
{
  const full = '好的，已经帮你改完了。\n\n【备忘】\n【目的】帮他改配置\n【状态】待续\n【待续】问他要不要顺便升级依赖；确认测试有没有跑过'
  const r = parseReply(full)
  check('备忘从正文里剥掉', r.text === '好的，已经帮你改完了。')
  check('解析目的、状态、待续', r.memo.purpose === '帮他改配置' && r.memo.status === 'pending' && r.memo.pending.length === 2)
  check('多条待续按分号拆开', r.memo.pending[0].startsWith('问他要不要') && r.memo.pending[1].startsWith('确认测试'))
  check('有正文的待续不算沉默', !r.silent)

  const done = parseReply('搞定了\n【目的】修 bug\n【状态】完成')
  check('完成：status=done，没有待续', done.memo.status === 'done' && done.memo.pending.length === 0 && done.text === '搞定了')

  const skip = parseReply('嗯嗯\n【备忘】\n【目的】没人叫我\n【状态】跳过')
  check('跳过：整条不发，算沉默', skip.silent && skip.text === '' && skip.memo.status === 'skip')

  const surf = parseReply('在的\n【目的】陪聊【状态：待续】【待续：问问他周末去哪】')
  check('也认 SurfCore 风格的写法', surf.memo.status === 'pending' && surf.memo.pending[0] === '问问他周末去哪' && surf.text === '在的')

  const none = parseReply('你好呀\n【待续】无\n【状态】完成')
  check('“待续：无”不算待续', none.memo.pending.length === 0)

  const long = parseReply(`ok\n【状态】待续\n【待续】${'很长'.repeat(100)}；二；三；四；五`)
  check('待续最多 3 条、每条限长', long.memo.pending.length === 3 && long.memo.pending[0].length <= 80)
  check('目的限长', parseReply(`x\n【目的】${'a'.repeat(500)}\n【状态】完成`).memo.purpose.length <= 120)

  const noStatus = parseReply('我觉得【目的】这个词不太好')
  check('正文里提到“【目的】”但没有状态字段：不当备忘', noStatus.memo === null && noStatus.text.includes('【目的】'))
  check('没有备忘返回 null', parseReply('普通回复').memo === null)

  const onlyMemo = parseReply('【备忘】\n【目的】看看\n【状态】完成')
  check('只有备忘没有正文：文本为空但不算沉默', onlyMemo.text === '' && !onlyMemo.silent)
}

console.log('B. 输出标签')
{
  let r = parseReply('<refuse/>')
  check('<refuse/>：沉默', r.silent && r.text === '')
  r = parseReply('这个我不回\n<refuse />\n【备忘】\n【状态】跳过')
  check('<refuse/> 夹在正文里：整条不发', r.silent && r.text === '')
  r = parseReply('<refuse ignore="123456"/>')
  check('refuse 可以带 ignore：记下要绕开的人', r.silent && r.ignore.join() === '123456')
  r = parseReply('<refuse ignore="12"/>')
  check('ignore 不是 QQ 号被忽略', r.ignore.length === 0)
  r = parseReply('<SILENT/>')
  check('标签不分大小写、<silent/> 也行', r.silent)

  r = parseReply('<at id="10001"/> 你说得对')
  check('<at id=…/> 转成 at 列表并从正文去掉', r.at.join() === '10001' && r.text === '你说得对')
  r = parseReply('<at id="10001"/><at id="10001"/><at qq="20002"/>好')
  check('at 去重，也认 qq 属性', r.at.join() === '10001,20002')
  r = parseReply('<at id="99999"/>你好', { validQq: (qq) => qq === '10001' })
  check('@ 的人不是群里最近说过话的：丢掉这个 at', r.at.length === 0 && r.text === '你好')
  r = parseReply('<at id="abc"/>你好')
  check('at 的号不是数字：不转换也不当标签吃掉', r.at.length === 0 && r.text.includes('<at id="abc"/>'))

  r = parseReply('<quote id="789"/>这个说得对')
  check('<quote id=…/>：取引用的消息号', r.quote === '789' && r.text === '这个说得对')
  r = parseReply('<quote id="789"/><quote id="790"/>好')
  check('只取第一个引用', r.quote === '789')
  r = parseReply('<quote id="789"/>好', { validMessage: () => false })
  check('引用的消息不是最近的：丢掉', r.quote === '' && r.text === '好')

  r = parseReply('示例：\n```html\n<refuse/>\n<at id="10001"/>\n```\n以上')
  check('代码块里的标签原样保留', !r.silent && r.at.length === 0 && r.text.includes('<refuse/>') && r.text.includes('<at id="10001"/>'))
  r = parseReply('用 `<refuse/>` 可以不说话')
  check('行内代码里的标签也保留', !r.silent && r.text.includes('`<refuse/>`'))
  r = parseReply('<div>普通 html</div>')
  check('不认识的标签原样保留', r.text === '<div>普通 html</div>')
  r = parseReply('')
  check('空输入不抛', r.text === '' && !r.silent)
  r = parseReply(null)
  check('null 不抛', r.text === '')
  check('格式说明提到全部标签和备忘字段', ['<refuse/>', '<at id=', '<quote id=', '【目的】', '【状态】', '【待续】'].every((s) => REPLY_FORMAT_HELP.includes(s)))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

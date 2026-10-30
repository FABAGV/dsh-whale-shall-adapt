/**
 * QQ 图片随消息交给模型（lib/qq/onebot/image.js）：魔数、大小、数量、取图失败。运行：node test/qq-image.mjs
 */
import { sniffImageType, imageSegments, loadImages, imageNote, IMAGE_DEFAULTS } from '../lib/qq/onebot/image.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) pass += 1
  else fail += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64')
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)])
const TXT = Buffer.from('this is definitely not an image file at all')
const messageWith = (files) => ({ segments: [{ kind: 'text', text: '看' }, ...files.map((file) => ({ kind: 'image', file }))] })
const connReturning = (table) => ({ call: async (action, params) => { if (action !== 'get_image') throw new Error('不该调别的'); const v = table[params.file]; if (v instanceof Error) throw v; return v } })

console.log('A. 认图')
{
  check('PNG / JPEG / GIF / WebP 按魔数认', sniffImageType(PNG) === 'image/png' && sniffImageType(JPG) === 'image/jpeg' && sniffImageType(GIF) === 'image/gif' && sniffImageType(WEBP) === 'image/webp')
  check('不是图片的字节认不出', sniffImageType(TXT) === '' && sniffImageType(Buffer.alloc(4)) === '' && sniffImageType(null) === '')
  check('只取有 file 标识的图片段', imageSegments({ segments: [{ kind: 'image', file: 'a' }, { kind: 'image', file: '' }, { kind: 'text', text: 'x' }] }).length === 1)
}

console.log('B. 取图')
{
  let r = await loadImages(connReturning({ a: { base64: PNG.toString('base64') } }), messageWith(['a']))
  check('base64：取到，类型以魔数为准', r.images.length === 1 && r.images[0].mediaType === 'image/png' && r.images[0].data === PNG.toString('base64') && r.skipped === 0)

  r = await loadImages(connReturning({ a: { file: '/tmp/x.jpg' } }), messageWith(['a']), { readFile: async () => JPG })
  check('本地路径（绝对路径）：读文件，扩展名不算数', r.images[0]?.mediaType === 'image/jpeg')
  r = await loadImages(connReturning({ a: { file: 'relative/x.png' } }), messageWith(['a']), { readFile: async () => PNG })
  check('相对路径不读', r.images.length === 0 && r.skipped === 1)
  r = await loadImages(connReturning({ a: { base64: TXT.toString('base64') } }), messageWith(['a']))
  check('魔数不对（不是图片）：丢掉', r.images.length === 0 && r.skipped === 1)
  r = await loadImages(connReturning({ a: { base64: PNG.toString('base64') } }), messageWith(['a']), { maxBytes: 10 })
  check('超过大小上限：丢掉', r.images.length === 0 && r.skipped === 1)
  r = await loadImages(connReturning({ a: new Error('NapCat 取不到'), b: { base64: PNG.toString('base64') } }), messageWith(['a', 'b']))
  check('一张取不到不影响另一张', r.images.length === 1 && r.skipped === 1)
  r = await loadImages(connReturning({ a: { base64: PNG.toString('base64') } }), messageWith(['a', 'a', 'a', 'a', 'a']), { maxImages: 2 })
  check('超过张数上限：只取前几张，剩下的计入没取到', r.images.length === 2 && r.skipped === 3)
  r = await loadImages(null, messageWith(['a', 'b']))
  check('没有连接：全部算没取到，不抛', r.images.length === 0 && r.skipped === 2)
  r = await loadImages({ call: () => new Promise(() => {}) }, messageWith(['a']), { timeoutMs: 60 })
  check('取图卡住：超时放弃', r.images.length === 0 && r.skipped === 1)
  r = await loadImages(connReturning({}), { segments: [{ kind: 'text', text: '没有图' }] })
  check('没有图片段：什么都不取', r.images.length === 0 && r.skipped === 0)
  check('默认值：3 张、4 MB', IMAGE_DEFAULTS.maxImages === 3 && IMAGE_DEFAULTS.maxBytes === 4 * 1024 * 1024)
}

console.log('C. 给模型的说明')
{
  check('附了图', imageNote({ attached: 2, skipped: 0 }) === '（随消息附了 2 张图。）')
  check('附了一部分', imageNote({ attached: 1, skipped: 2 }).includes('另有 2 张没取到'))
  check('一张都没取到：如实说看不到、别猜', imageNote({ attached: 0, skipped: 1 }).includes('看不到') && imageNote({ attached: 0, skipped: 1 }).includes('不要猜'))
  check('模型不支持看图：如实说', imageNote({ attached: 0, skipped: 0, unsupported: true }).includes('不支持看图'))
  check('没有图什么都不说', imageNote({ attached: 0, skipped: 0 }) === '')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

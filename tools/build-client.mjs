/**
 * 把 lib/ui/client/*.part.js 按文件名顺序拼成 lib/ui/client.js。
 *
 * DSH 的桌面端设置页是一个手写的 bundle（没有构建步骤，宿主直接加载 lib/ui/client.js），
 * 3000 多行放在一个文件里不好改。所以源码拆在 lib/ui/client/ 下，按文件名顺序拼接，拼出来的文件提交进仓库，
 * 宿主不用跑任何构建。零依赖，只是字符串拼接：每一段是同一个函数体里的一截，单独不是合法的 JS。
 *
 * 用法：
 *   node tools/build-client.mjs          拼接并写入 lib/ui/client.js
 *   node tools/build-client.mjs --check  只检查已提交的 client.js 是不是最新（不一致时退出码为 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PARTS_DIR = path.join(ROOT, 'lib', 'ui', 'client')
export const BUNDLE = path.join(ROOT, 'lib', 'ui', 'client.js')

/** 读取所有分段，返回 { names, text }。分段不合规时抛错。 */
export function buildClient({ dir = PARTS_DIR } = {}) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.part.js')).sort()
  if (names.length === 0) throw new Error(`${dir} 下没有 *.part.js`)
  let text = ''
  for (const name of names) {
    if (!/^\d{2}-[a-z0-9-]+\.part\.js$/.test(name)) throw new Error(`分段文件名要像 20-copy-zh.part.js：${name}`)
    const body = fs.readFileSync(path.join(dir, name), 'utf8')
    if (body.includes('\r')) throw new Error(`${name} 有 CRLF，统一用 LF`)
    if (!body.endsWith('\n')) throw new Error(`${name} 末尾要有换行，否则和下一段会粘在一起`)
    text += body
  }
  return { names, text }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { names, text } = buildClient()
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE, 'utf8') : ''
    if (current === text) {
      console.log(`client.js 是最新的（${names.length} 段）`)
      process.exit(0)
    }
    console.error('lib/ui/client.js 和 lib/ui/client/*.part.js 对不上：改了分段之后要跑 node tools/build-client.mjs')
    process.exit(1)
  }
  fs.writeFileSync(BUNDLE, text)
  console.log(`已写入 lib/ui/client.js（${names.length} 段，${text.split('\n').length - 1} 行）`)
}

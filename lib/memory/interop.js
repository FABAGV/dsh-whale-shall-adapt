/**
 * 记忆互通的运行时开关（`$DSH_HOME/shall/memory/interop.json`）。
 *
 * 现在只有一个：`readAll` —— 开了以后**任何会话**（包括所有群聊）翻记忆时都能查到全部范围；
 * 不开就还是按会话切（本群 + 自己的 + 主人那几片）。
 *
 * 和 config 的区别：这个要能在控制台一键切换、不用重载插件，所以落一个小 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'interop.json'
const DEFAULTS = Object.freeze({ readAll: false })

export function interopPath(dir) {
  return path.join(dir, FILE)
}

export function readInterop(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(interopPath(dir), 'utf8'))
    return { ...DEFAULTS, readAll: parsed?.readAll === true }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeInterop(dir, patch = {}) {
  const next = { ...readInterop(dir) }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'readAll')) next.readAll = patch.readAll === true
  fs.mkdirSync(dir, { recursive: true })
  const file = interopPath(dir)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return next
}

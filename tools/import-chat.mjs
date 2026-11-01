// 把 QQ 导出的聊天记录（txt / JSON / JSONL）导进插件的语料目录，供「模仿群友」生成人格。
//
// 用法：
//   node tools/import-chat.mjs --file "C:\path\to\记录.txt" --type group --id 123456789 --name 某个群
//   node tools/import-chat.mjs --file dump.json --type private --id 10001
//   node tools/import-chat.mjs --file 记录.bak --type group --id 123456789      # 认得出是 QQNT 备份会直接告诉你怎么办
//
// 可选：
//   --home <DSH_HOME>   默认 $DSH_HOME，再默认 ~/.dsh
//   --json              只输出 JSON（给脚本用）
//
// 导进来的记录落在 $DSH_HOME/shall/qq/imported/<group|private>-<号>/<日期>.jsonl，
// 不参与语料的 30 天清理；控制台「QQ → 导入的历史」里可以整聊删除。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importChatRecords } from '../lib/adapt/chat-record-import.js'

const argv = process.argv.slice(2)
const value = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const jsonOut = argv.includes('--json')
const file = value('file')
const chatType = value('type', 'group')
const chatId = value('id')
const chatName = value('name')
const home = value('home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function fail(message) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: message }))
  else {
    console.error(`x ${message}`)
    console.error('\n用法：node tools/import-chat.mjs --file <记录文件> --type group --id <群号> [--name 群名]')
  }
  process.exitCode = 1
}

if (!file) fail('缺 --file')
else if (!/^\d{1,12}$/.test(String(chatId))) fail('--id 必须是群号 / QQ 号（1–12 位数字）')
else {
  const importRoot = path.join(home, 'shall', 'qq', 'imported')
  let result
  try {
    result = importChatRecords({ file, importRoot, chatType, chatId, chatName })
  } catch (error) {
    fail(`导入失败：${error?.message ?? error}`)
  }
  if (result) {
    if (jsonOut) {
      console.log(JSON.stringify(result))
    } else if (!result.ok) {
      fail(result.error)
    } else {
      const fmt = result.format.toUpperCase()
      console.log(`+ 读到了 ${fmt}，共 ${result.total} 条`)
      console.log(`  新导入 ${result.imported} 条，重复跳过 ${result.duplicate} 条`)
      const skipped = Object.entries(result.skipped ?? {}).filter(([, n]) => n > 0)
      if (skipped.length > 0) console.log(`  没导的：${skipped.map(([why, n]) => `${why} ${n}`).join('，')}`)
      if (result.firstTs) console.log(`  时间范围：${new Date(result.firstTs).toLocaleString()} → ${new Date(result.lastTs).toLocaleString()}`)
      console.log(`  写到：${result.dir}`)
      console.log('\n接下来：控制台 → 人格 → 新建 → 「模仿群友」，')
      console.log(`  选 ${chatType === 'group' ? '群' : '私聊'} ${chatId}，再选要模仿的人，点生成。`)
    }
  }
}

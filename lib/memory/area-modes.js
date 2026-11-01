/**
 * 书架的「注入方式」：每个 `area` 一个档位，存在 `$DSH_HOME/shall/memory/area-modes.json`。
 *
 *   full（默认）：正常注入条目正文
 *   index       ：只注入一行「书架「X」N 条」——模型知道有这个书架，要看内容再 `shall_memory_recall`
 *   off         ：这条书架的内容不进注入（仍在库里、仍能被召回）
 *
 * 为什么按书架而不是按条目：书架是用户自己组织的归置单位（"DNS 那摞纸"），
 * 一摞要不要展开读，用户比模型更有判断。
 *
 * 文件形状：`{ "version": 1, "modes": { "<书架名>": "full" | "index" | "off" } }`
 * 没写的书架按 full 处理；某项值不合法就忽略（不让一个坏值把整份设置作废）。
 */
import path from 'node:path'
import { isPlainObject, readJsonFile, writeJsonAtomic } from '../core/fs-atomic.js'

export const AREA_MODES = new Set(['full', 'index', 'off'])
export const AREA_MODE_LABELS = {
  full: '完全注入',
  index: '只注入书架列表',
  off: '不注入',
}

export function areaModesFile(dir) {
  return path.join(dir, 'area-modes.json')
}

/** 读书架模式。坏文件走 fs-atomic 的留档逻辑，返回空表（= 全部 full）。 */
export function readAreaModes(dir, { log = null } = {}) {
  const read = readJsonFile(areaModesFile(dir), { log, validate: isPlainObject, fallback: () => ({}) })
  const raw = isPlainObject(read.value?.modes) ? read.value.modes : isPlainObject(read.value) ? read.value : {}
  const modes = {}
  for (const [area, mode] of Object.entries(raw)) {
    const key = String(area ?? '').trim()
    if (key && AREA_MODES.has(mode)) modes[key] = mode
  }
  return modes
}

export function writeAreaModes(dir, modes) {
  const clean = {}
  for (const [area, mode] of Object.entries(modes ?? {})) {
    // full 是默认值，不落盘：文件里只留需要偏离默认的那几项
    if (mode !== 'full' && AREA_MODES.has(mode)) clean[String(area)] = mode
  }
  writeJsonAtomic(areaModesFile(dir), { version: 1, modes: clean })
  return clean
}

/** 某个书架当前生效的模式（缺省 full）。 */
export function modeOf(modes, area) {
  return modes?.[String(area ?? '')] ?? 'full'
}

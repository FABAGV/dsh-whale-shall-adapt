/**
 * 极简分级日志。前缀统一，便于在 dsh 日志里 grep。
 *
 * 可选地把日志同时镜像到文件：桌面端插件的 stdout 归 Electron 管，
 * 出问题时看不到，所以运行时诊断必须落一份到磁盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** 默认镜像位置：$DSH_HOME/shall/qq/plugin.log */
export function defaultLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'shall', 'qq', 'plugin.log')
}

/** 单个日志文件的上限；超过就把它挪成 `.1`（只留一份旧的），和 privacy 审计文件同一套做法 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024

/** file → 当前估算字节数。目录只在第一次写这个文件时建，不再每行 mkdir */
const sizes = new Map()

/**
 * 追加一行日志，超过上限先轮转。失败一律吞掉：落盘失败不能影响插件本身。
 * 字节数在进程内累计，只在第一次写时 stat 一次；另一个进程同时写同一个文件时会估小，
 * 最多晚一点轮转，不会丢行。
 */
export function appendLogLine(file, line, { maxBytes = LOG_MAX_BYTES } = {}) {
  try {
    let size = sizes.get(file)
    if (size === undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
    }
    const text = `${line}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
      // 上一份 `.1` 直接删掉（只留一代），再把这个文件挪过去。两个路径都由 `file` 派生。
      const rotated = `${file}.1`
      try {
        fs.rmSync(rotated, { force: true })
        fs.renameSync(file, rotated)
      } catch {
        /* 挪不动（Windows 上被别的进程开着）就接着往原文件写，下一行再试 */
      }
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
    }
    fs.appendFileSync(file, text, 'utf8')
    sizes.set(file, size + bytes)
  } catch {
    sizes.delete(file)
  }
}

function appendLine(file, line) {
  appendLogLine(file, line)
}

export function createLogger(namespace = 'shall:qq', minLevel = 'info', file = null) {
  const threshold = LEVELS[minLevel] ?? LEVELS.info
  const emit = (level, args) => {
    if ((LEVELS[level] ?? 99) < threshold) return
    const line = `[${namespace}]`
    if (level === 'error') console.error(line, ...args)
    else if (level === 'warn') console.warn(line, ...args)
    else console.log(line, ...args)
    if (file) {
      const text = args
        .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a)))
        .join(' ')
      appendLine(file, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line} ${text}`)
    }
  }
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    file,
    child: (sub) => createLogger(`${namespace}:${sub}`, minLevel, file),
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 控制台「书架」页：把记忆按书架列出来，一摞一摞地决定它怎么进注入。
 *
 * 三档（存在 `$DSH_HOME/shall/memory/area-modes.json`，见 lib/memory/area-modes.js）：
 *   完全注入       —— 条目正文照常进常驻记忆（默认）
 *   只注入书架列表 —— 只给模型一行「书架「X」N 条」，要内容再 shall_memory_recall
 *   不注入         —— 这摞不进注入，但仍留在库里、仍能被召回
 *
 * 为什么要按书架：书架的存废和展开与否，你比模型更有判断。一个"DNS 那摞纸"越堆越厚时，
 * 把它切成"只给目录"比逐条删要省事得多。
 */
import { api, el, clear, action, section, toast, select } from './lib.js'

const MODE_INFO = [
  ['full', '完全注入'],
  ['index', '只注入书架列表'],
  ['off', '不注入'],
]
const MODE_HINT = {
  full: '条目正文照常进常驻注入',
  index: '只给模型一行「书架 + 条数」，要看内容它会自己 shall_memory_recall',
  off: '这一摞不进注入；仍在库里，仍能被召回',
}

function scopeLabel(scope) {
  if (scope === 'owner') return '你：身份'
  if (scope === 'owner:work') return '你：干活'
  if (scope === 'owner:chat') return '你：聊天'
  if (scope === 'shared') return '所有人'
  if (scope.startsWith('chat:group:')) return `群 ${scope.slice(11)}`
  if (scope.startsWith('chat:private:')) return `私聊 ${scope.slice(13)}`
  if (scope.startsWith('member:')) return `群友 ${scope.slice(7).replace(':', ' 里的 ')}`
  if (scope.startsWith('persona:')) return `人格 ${scope.slice(8)}`
  return scope
}

function shelfRow(item, setMode, rerender) {
  const counts = `${item.total} 条${item.active !== item.total ? `（在用 ${item.active}、候选 ${item.candidate}）` : ''}`
  const dropdown = select(MODE_INFO, item.mode, (mode) => {
    if (mode === item.mode) return
    setMode(item.area, mode)
  }, { class: 'short' })
  return el('li', { class: 'list-item' },
    el('div', {},
      el('strong', { text: item.area }),
      ' ',
      el('span', { class: 'badge', text: item.mode === 'full' ? '完全注入' : item.mode === 'index' ? '只给目录' : '不注入' }),
      ' ',
      el('span', { class: 'muted small', text: counts })),
    el('div', { class: 'muted small', text: `${MODE_HINT[item.mode]}　·　范围：${item.scopes.map(scopeLabel).join('、')}` }),
    el('div', { class: 'btn-row' },
      dropdown,
      el('button', {
        class: 'btn', type: 'button', text: '看这摞记忆',
        onclick: () => rerender(`#/memory?area=${encodeURIComponent(item.area)}`),
      })))
}

export async function renderShelves(view, { signal, rerender, navigate }) {
  const data = await api('GET', '/memory/areas').catch((error) => ({ error }))
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: '书架' }),
      el('p', { class: 'muted', text: '记忆按书架归置。每个书架单独决定它怎么进常驻注入：整摞倒进去，还是只给模型看一眼目录。它和权限（谁能看见）是两件事。' })),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate(location.hash) }))))
  if (data.error) {
    view.append(el('div', { class: 'notice bad', text: data.error.message ?? String(data.error) }))
    return
  }
  const areas = Array.isArray(data.areas) ? data.areas : []
  const setMode = (area, mode) => {
    action(async () => {
      const out = await api('PUT', '/memory/areas', { area, mode })
      if (out?.ok !== true) throw new Error(out?.error ?? '保存失败')
      toast(`「${area}」改为：${MODE_HINT[mode].split('；')[0]}`, 'ok')
      rerender()
    })()
  }
  if (areas.length === 0) {
    view.append(section('还没有书架',
      el('p', { class: 'muted', text: '记忆写入时会自动归到书架（你的画像、每个 QQ 会话、每个群、每位群友各是一个）。等有记忆之后这里就会列出来。' })))
    return
  }
  const byMode = { full: [], index: [], off: [] }
  for (const item of areas) (byMode[item.mode] ?? byMode.full).push(item)
  view.append(section('概况',
    el('div', { class: 'btn-row' },
      el('span', { class: 'badge', text: `共 ${areas.length} 个书架` }),
      el('span', { class: 'badge', text: `完全注入 ${byMode.full.length}` }),
      el('span', { class: 'badge', text: `只给目录 ${byMode.index.length}` }),
      el('span', { class: 'badge', text: `不注入 ${byMode.off.length}` })),
    el('p', { class: 'muted small', text: '改了立刻生效：下一次常驻注入就按新档位算（注入文本变了会重新发一条快照）。' })))
  view.append(section('书架列表',
    el('ul', { class: 'list' }, areas.map((item) => shelfRow(item, setMode, rerender)))))
}

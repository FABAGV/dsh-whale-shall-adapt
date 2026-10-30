import { api, el, clear, action, section, fmtTime, toast, select } from './lib.js'

const STATUS_LABEL = { active: '在用', candidate: '候选', rejected: '已否定', historical: '已过时' }
const STATUS_BADGE = { active: 'ok', candidate: 'warn', rejected: '', historical: '' }
const KIND_LABEL = {
  trait: '特质', avoid: '别这样做', works: '有效做法', uncertain: '待确认', fact: '事实', intent: '在做', constraint: '约束',
  preference: '偏好', promise: '约定', relation: '关系', style: '风格', note: '笔记', slang: '黑话', boundary: '边界',
}
const ORIGIN_LABEL = { user: '你写的', 'user-confirmed': '你确认的', model: '模型提取', import: '导入' }

function scopeLabel(scope) {
  if (scope === 'owner') return '你：身份（两边都读）'
  if (scope === 'owner:work') return '你：干活（只给 DSH 会话）'
  if (scope === 'owner:chat') return '你：聊天（只给你的 QQ 私聊）'
  if (scope.startsWith('chat:group:')) return `QQ 群 ${scope.slice(11)}`
  if (scope.startsWith('chat:private:')) return `QQ 私聊 ${scope.slice(13)}`
  if (scope.startsWith('member:')) return `群友 ${scope.slice(7).replace(':', ' 里的 ')}`
  if (scope.startsWith('persona:')) return `人格 ${scope.slice(8)}`
  return scope
}

function entryRow(entry, rerender) {
  const judge = (verdict, extra = {}) => action(async () => {
    await api('POST', `/memory/${entry.id}/judge`, { verdict, ...extra })
    rerender()
  })
  const buttons = []
  if (entry.status === 'candidate') buttons.push(el('button', { class: 'btn', type: 'button', text: '对（转正）', onclick: judge('confirm') }))
  if (entry.status === 'active') {
    buttons.push(el('button', { class: 'btn', type: 'button', text: entry.pinned ? '取消置顶' : '置顶', onclick: judge(entry.pinned ? 'unpin' : 'pin') }))
    buttons.push(el('button', { class: 'btn', type: 'button', text: entry.quiet ? '恢复提起' : '别提', onclick: judge(entry.quiet ? 'unquiet' : 'quiet') }))
    buttons.push(el('button', { class: 'btn', type: 'button', text: '过时了', onclick: judge('outdated') }))
  }
  if (entry.status !== 'rejected') {
    buttons.push(el('button', { class: 'btn', type: 'button', text: '不对', onclick: action(async () => {
      const text = prompt('不对的话，正确的说法是？（不想写就留空）', '')
      if (text === null) return
      await api('POST', `/memory/${entry.id}/judge`, { verdict: 'wrong', ...(text.trim() ? { text: text.trim() } : {}) })
      rerender()
    }) }))
  }
  if (entry.status === 'rejected' || entry.status === 'historical') buttons.push(el('button', { class: 'btn', type: 'button', text: '恢复', onclick: judge('restore') }))
  buttons.push(el('button', { class: 'btn btn-danger', type: 'button', text: '忘掉', onclick: action(async () => {
    if (!confirm('永久忘掉这一条？之后近似的说法也不会再记。')) return
    await api('POST', `/memory/${entry.id}/judge`, { verdict: 'forget' })
    rerender()
  }) }))

  const ledger = entry.ledger
  return el('li', { class: 'list-item' },
    el('div', {},
      el('span', { class: `badge ${STATUS_BADGE[entry.status] ?? ''}`, text: STATUS_LABEL[entry.status] ?? entry.status }),
      el('span', { class: 'badge', text: KIND_LABEL[entry.kind] ?? entry.kind }),
      entry.pinned ? el('span', { class: 'badge accent', text: '置顶' }) : null,
      entry.quiet ? el('span', { class: 'badge', text: '别提' }) : null,
      ' ', entry.text),
    el('div', { class: 'muted small', text: `${ORIGIN_LABEL[entry.origin] ?? entry.origin}　重要度 ${entry.importance}　置信度 ${entry.confidence}　注入过 ${ledger.injected} 次、召回 ${ledger.recalled} 次、被纠正 ${ledger.corrected} 次　更新于 ${fmtTime(entry.updatedAt)}${entry.validUntil ? `　到期 ${fmtTime(entry.validUntil)}` : ''}` }),
    entry.sources.length ? el('details', {}, el('summary', { class: 'muted small', text: `出处（${entry.sources.length}）` }),
      el('ul', {}, entry.sources.map(s => el('li', { class: 'small', text: `${s.at ? fmtTime(s.at) : ''}　${s.quote || '（没有原话）'}` })))) : null,
    el('div', { class: 'btn-row' }, buttons))
}

export async function renderMemory(view, { signal, navigate, params }) {
  // 地址里空的部分用 _ 占位（空段会被路由丢掉，后面的参数就错位了）
  const part = index => (params[index] && params[index] !== '_' ? params[index] : '')
  const scopeParam = part(0)
  const filter = { status: part(1), q: part(2) }
  const scopes = await api('GET', '/memory/scopes').catch(error => ({ error }))
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: '记忆' }),
      el('p', { class: 'muted', text: '所有范围的记忆都在这里：你的画像、QQ 聊天、群友、人格。你有最终裁决权：对、不对、过时了、别提、置顶、忘掉。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate(location.hash) }))))
  if (scopes.error) {
    view.append(el('div', { class: 'notice bad', text: scopes.error.message ?? String(scopes.error) }))
    return
  }
  const go = (scope, status, q) => navigate(`#/memory/${[scope, status, q].map(value => encodeURIComponent(value || '_')).join('/')}`)
  const options = [['', '（选一个范围）'], ...scopes.scopes.map(s => [s.scope, `${scopeLabel(s.scope)}　${s.total} 条${s.candidate ? `（候选 ${s.candidate}）` : ''}`])]
  const query = el('input', { type: 'text', size: '24', placeholder: '搜关键字', value: filter.q })
  view.append(section('范围',
    el('div', { class: 'btn-row' },
      select(options, scopeParam, value => go(value, filter.status, filter.q)),
      select([['', '全部状态'], ...Object.entries(STATUS_LABEL)], filter.status, value => go(scopeParam, value, filter.q)),
      query, el('button', { class: 'btn', type: 'button', text: '搜', onclick: () => go(scopeParam, filter.status, query.value.trim()) }))))
  if (!scopeParam) {
    view.append(el('p', { class: 'muted', text: `共 ${scopes.scopes.length} 个范围。选一个看里面的记忆。` }))
    return
  }
  const params2 = new URLSearchParams({ scope: scopeParam })
  if (filter.status) params2.set('status', filter.status)
  if (filter.q) params2.set('q', filter.q)
  const result = await api('GET', `/memory?${params2}`)
  if (signal.aborted) return
  const rerender = () => navigate(location.hash)
  view.append(section(`${scopeLabel(scopeParam)}（${result.total} 条）`,
    result.entries.length ? el('ul', { class: 'list' }, result.entries.map(entry => entryRow(entry, rerender))) : el('p', { class: 'muted', text: '没有符合条件的记忆。' }),
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn', href: `/api/memory?${params2}&limit=500`, target: '_blank', rel: 'noopener', text: '导出（JSON）' }),
      el('button', { class: 'btn btn-danger', type: 'button', text: '清空这个范围', onclick: action(async () => {
        const typed = prompt(`清空「${scopeLabel(scopeParam)}」的全部记忆。要继续请输入：忘掉`)
        if (typed !== '忘掉') return
        const block = confirm('同时屏蔽这个范围，之后不再往里记任何东西？（“忘掉我”选这个）')
        const out = await api('POST', '/memory/purge', { scope: scopeParam, confirm: '忘掉', block })
        toast(`已清掉 ${out.removed} 条`)
        go('', '', '')
      }) }))))
}

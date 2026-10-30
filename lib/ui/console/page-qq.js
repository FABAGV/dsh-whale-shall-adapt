import { api, el, clear, action, section, fmtTime, toast } from './lib.js'

/** 快照里的 `**强调**` 换成 <strong>：逐段建节点，不拼 HTML 字符串。 */
function rich(text) {
  const parts = String(text ?? '').split(/\*\*(.+?)\*\*/g)
  return parts.map((part, index) => (index % 2 === 1 ? el('strong', { text: part }) : part))
}

function ownerCard(info, rerender) {
  const body = []
  if (info.paired) {
    body.push(el('p', {}, '已配对：主人 QQ ', el('strong', { text: info.qq }), `（${fmtTime(info.pairedAt)}）`))
    body.push(el('p', { class: 'muted small', text: '和这个 QQ 的私聊会读到你的身份记忆和私聊记忆；解除后私聊记忆保留，重新配对后恢复。' }))
    body.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-danger', type: 'button', text: '解除配对', onclick: action(async () => {
        if (!confirm('解除和这个 QQ 的主人配对？解除后它就按普通私聊对待。')) return
        await api('DELETE', '/qq/owner')
        rerender()
      }) })))
  } else {
    body.push(el('p', { class: 'muted', text: '还没有配对主人。没配对时 bot 不回复任何私聊。' }))
    const codeBox = el('div', {})
    body.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', type: 'button', text: info.codePending ? '重新生成配对码' : '生成配对码', onclick: action(async () => {
        const out = await api('POST', '/qq/owner/code')
        clear(codeBox)
        codeBox.append(
          el('p', {}, '配对码 ', el('strong', { class: 'stat', text: out.code }), `，${fmtTime(out.expiresAt)} 前有效`),
          el('p', { class: 'muted small', text: out.hint }))
        toast('配对码已生成')
      }) })))
    body.push(codeBox)
  }
  return section('主人配对', body)
}

export async function renderQq(view, { signal, navigate }) {
  const [health, owner] = await Promise.all([
    api('GET', '/qq/health').catch(error => ({ error })),
    api('GET', '/qq/owner').catch(error => ({ error })),
  ])
  if (signal.aborted) return
  clear(view)

  view.append(el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: 'QQ' }),
      el('p', { class: 'muted', text: health.generatedAt ? `版本 ${health.version ?? '—'} · 生成于 ${fmtTime(health.generatedAt)}` : 'QQ 通道的体检和主人配对。' })),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate('#/qq') }))))

  if (health.error) {
    view.append(el('div', { class: 'notice bad', text: health.error.message ?? String(health.error) }))
  } else {
    view.append(el('div', { class: `notice ${health.verdict.tone === 'ok' ? 'ok' : 'warn'}` },
      el('strong', { text: health.verdict.title }), el('div', { class: 'small', text: health.verdict.note })))

    if (health.issues.length) {
      view.append(section('要处理的事', el('ul', { class: 'list' }, health.issues.map(issue => el('li', { class: 'list-item' },
        el('div', {}, rich(issue.text)),
        issue.nextStep ? el('div', { class: 'muted small' }, el('strong', { text: '下一步 ' }), issue.nextStep) : null)))))
    }

    const alive = health.alive
    view.append(section('它现在还活着吗',
      el('p', {}, el('span', { class: `badge ${alive.alive ? 'ok' : 'warn'}`, text: alive.alive ? '活着' : '不活着' }),
        el('span', { class: 'muted small', text: '  只认“有连接 + 事件没静默 + 计时器在跑”，缺一条就报不活着。' })),
      alive.because.length ? el('ul', {}, alive.because.map(line => el('li', {}, rich(line)))) : el('p', { class: 'muted', text: '没有可显示的判据。' }),
      el('p', { class: 'muted small', text: `${alive.silence} · ${alive.tick} · 事件静默阈值 ${alive.silenceLimit}` })))

    view.append(section('关键状态', el('div', { class: 'grid' }, health.facts.map(fact => el('div', { class: 'card' },
      el('div', { class: 'stat-label', text: fact.label }),
      el('div', { class: 'stat', text: String(fact.value ?? '—') }),
      fact.note ? el('div', { class: 'muted small', text: fact.note }) : null)))))

    if (health.chats.length) {
      view.append(section('交班进度（离阈值还有多远）', el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['会话', '第几代', '当前 token', '占阈值'].map(text => el('th', { text })))),
        el('tbody', {}, health.chats.map(row => el('tr', {},
          el('td', { text: row.name }),
          el('td', { text: row.generation ?? '—' }),
          el('td', { text: row.totalTokens === null ? '—' : row.totalTokens.toLocaleString('en-US') }),
          el('td', { text: row.progressPercent === null ? '—' : `${row.progressPercent}%` }))))))))
    }

    view.append(section('配置摘要', el('dl', { class: 'kv' }, health.config.flatMap(item => [el('dt', { text: item.label }), el('dd', { class: 'mono small', text: item.value })]))))
    if (health.warnings.length) view.append(section('配置警告', el('ul', {}, health.warnings.map(text => el('li', { text })))))
    if (health.passed.length) {
      view.append(el('details', { class: 'card' },
        el('summary', { text: `通过的检查（${health.passed.length} 项）` }),
        el('ul', {}, health.passed.map(line => el('li', {}, rich(line))))))
    }
  }

  if (owner.error) view.append(section('主人配对', el('p', { class: 'muted', text: owner.error.message ?? String(owner.error) })))
  else view.append(ownerCard(owner, () => navigate('#/qq')))
}

import { api, el, clear, action, section, fmtTime, fmtAgo, toast, checkbox } from './lib.js'

const GATE_LABEL = {
  enabled: '总开关', owner: '已配对主人', connection: 'QQ 连接', 'quiet-hours': '安静时段', 'daily-cap': '每日上限',
  schedule: '到点了吗', 'owner-active': '你最近说过话吗', busy: '常驻会话忙不忙', topic: '有没有值得跟进的事',
}

function gateTable(preview) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['闸门', '通过', '说明'].map(text => el('th', { text })))),
    el('tbody', {}, preview.gates.map(gate => el('tr', {},
      el('td', { text: GATE_LABEL[gate.name] ?? gate.name }),
      el('td', {}, el('span', { class: `badge ${gate.ok ? 'ok' : 'warn'}`, text: gate.ok ? '通过' : '没过' })),
      el('td', { text: gate.detail }))))))
}

export async function renderOutreach(view, { signal, navigate }) {
  const data = await api('GET', '/outreach').catch(error => ({ error }))
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: '主动私聊' }),
      el('p', { class: 'muted', text: '让机器人偶尔主动私聊你。只私聊配对的主人，群聊永远不主动开口；只跟进你们聊过但没说完的事，没有就不发。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate('#/outreach') }))))
  if (data.error) {
    view.append(el('div', { class: 'notice bad', text: data.error.message ?? String(data.error) }))
    return
  }
  const rerender = () => navigate('#/outreach')
  const save = async patch => {
    const result = await api('PUT', '/outreach', patch)
    if (result.warnings?.length) toast(result.warnings.join('；'), 'bad')
    else toast('已保存')
    rerender()
  }

  view.append(section('开关',
    el('p', {}, checkbox('让它主动私聊我', data.enabled, value => action(() => save({ enabled: value }))())),
    !data.ownerPaired ? el('div', { class: 'notice warn', text: '还没有配对主人（去 QQ 页生成配对码），没配对时不会发。' }) : null,
    el('p', { class: 'muted small', text: '防刷屏：安静时段不发、每天有上限、两次之间隔几个小时、你刚说过话不发、它在忙不发；重启后不会补发。' })))

  const c = data.config
  const start = el('input', { type: 'text', size: '5', value: c.quietHours.start })
  const end = el('input', { type: 'text', size: '5', value: c.quietHours.end })
  const perDay = el('input', { type: 'number', min: '0', max: '24', value: String(c.maxPerDay) })
  const minGap = el('input', { type: 'number', min: '0.2', step: '0.5', value: String(c.minGapMs / 3600000) })
  const maxGap = el('input', { type: 'number', min: '0.2', step: '0.5', value: String(c.maxGapMs / 3600000) })
  view.append(section('节奏',
    el('div', { class: 'field' }, el('label', { text: '安静时段' }), start, '—', end),
    el('div', { class: 'field' }, el('label', { text: '每天最多' }), perDay, ' 次'),
    el('div', { class: 'field' }, el('label', { text: '两次之间隔' }), minGap, ' 到 ', maxGap, ' 小时（随机）'),
    el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-primary', type: 'button', text: '保存', onclick: action(() => save({
      quietHours: { start: start.value.trim(), end: end.value.trim() },
      maxPerDay: Number(perDay.value),
      minGapMs: Number(minGap.value) * 3600000,
      maxGapMs: Number(maxGap.value) * 3600000,
    })) }))))

  view.append(section('现在的状态',
    el('dl', { class: 'kv' },
      el('dt', { text: '今天已发' }), el('dd', { text: `${data.sentToday} / ${c.maxPerDay}` }),
      el('dt', { text: '下次最早' }), el('dd', { text: data.enabled ? fmtTime(data.nextAt) : '（没开）' }),
      el('dt', { text: '上一次' }), el('dd', { text: data.lastSentAt ? `${fmtTime(data.lastSentAt)}（${fmtAgo(data.lastSentAt)}）${data.awaitingReply ? '，在等你回' : ''}` : '还没发过' }),
      el('dt', { text: '累计' }), el('dd', { text: `发出 ${data.sent} 次，没发成功 ${data.failures} 次，被打断 ${data.interrupted} 次` })),
    data.recent.length
      ? el('ul', { class: 'list' }, data.recent.map(item => el('li', { class: 'list-item' }, `${fmtTime(item.at)}　${item.text}`)))
      : el('p', { class: 'muted', text: '还没有主动联系过。' })))

  const out = el('div', {})
  view.append(section('预览（不会发出去）',
    el('p', { class: 'muted small', text: '真的读记忆、真的算每一道闸门、真的拼提示词，但不发送、不记账。' }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', text: '现在预览一次', onclick: action(async () => {
        const preview = await api('POST', '/outreach/preview')
        clear(out)
        out.append(
          el('div', { class: `notice ${preview.pass ? 'ok' : 'warn'}`, text: preview.pass ? '所有闸门都过了：下次检查时会发。' : '现在不会发（见下表哪一道没过）。' }),
          gateTable(preview),
          preview.prompt ? el('details', {}, el('summary', { text: '会交给常驻会话的提示' }), el('pre', { class: 'mono small', text: preview.prompt })) : null)
      }) }),
      el('button', { class: 'btn btn-danger', type: 'button', text: '重置进度', onclick: action(async () => {
        if (!confirm('清掉今天的次数、下次时间和最近联系记录？开关和参数不动。')) return
        await api('POST', '/outreach/reset')
        toast('已重置')
        rerender()
      }) })),
    out))
}

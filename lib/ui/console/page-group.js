import { api, el, clear, action, section, fmtTime, fmtAgo, toast, select, checkbox } from './lib.js'

const MODE_HINT = {
  silent: '只记录，从不发言',
  mention: '被 @、回复它、叫它的名字、戳一戳，才回',
  present: '点名之后，被它回复过的人接着说可以不再 @',
  active: '没人叫也可能接话：便宜模型判断 + 精力预算（默认）',
  watch: '一直看着群：群里说的话攒一小批就交给主模型，由它自己决定接不接。最费额度（每看一眼是一个回合）',
}

const CADENCE_LABEL = { conversation: '对话中', relaxing: '回落中', steady: '常态' }

const REASON_LABEL = {
  'called:at': '被 @', 'called:reply': '回复了它', 'called:name': '叫了它的名字', 'called:poke': '戳了它',
  'judged-yes': '判断通过', 'judged-no': '判断不接', 'judge-failed': '判断出错', 'present-follow-up': '在场追问',
  'not-called': '没叫它', 'not-present': '不在场', 'mode-silent': '潜水档', 'command': '像是发给别的 bot 的命令',
  'mentions-others': '只 @ 了别人', 'from-bot': '别的 bot 说的', 'quiet-hours': '静默时段', 'closed': '对话已收尾',
  'sender-ignored': '这个人被绕开', 'cooldown': '冷却中', 'hour-limit': '每小时上限', 'energy-low': '精力不够',
  'superseded': '被新消息取代', 'muted': '被禁言', 'sender-rate': '这个人刷得太快', 'bot-loop': '防另一个 bot 互刷', 'no-judge': '没有判断模型',
  'watch-look': '盯群：交给主模型看', 'watch-limit': '盯群：这小时看够次数了',
}
const reasonText = reason => REASON_LABEL[reason] ?? (String(reason).startsWith('closing:') ? '对方像在收尾' : reason)

async function put(path, body, rerender, okText = '已保存') {
  const result = await api('PUT', path, body)
  if (result.warnings?.length) toast(result.warnings.join('；'), 'bad')
  else toast(okText)
  rerender()
  return result
}

/** 对话中节奏的四个旋钮（盯群档和“所有群统一设置”共用） */
function cadenceInputs(s) {
  const active = el('input', { type: 'number', class: 'narrow', min: '1', max: '3600', value: String(Math.round((s.watch.activeIntervalMs ?? 10000) / 1000)) })
  const windowMin = el('input', { type: 'number', class: 'narrow', min: '0', max: '360', value: String(Math.round((s.watch.conversationWindowMs ?? 300000) / 60000)) })
  const relaxMin = el('input', { type: 'number', class: 'narrow', min: '0', max: '360', value: String(Math.round((s.watch.relaxMs ?? 600000) / 60000)) })
  const activePerHour = el('input', { type: 'number', class: 'narrow', min: '1', max: '3600', value: String(s.watch.activePerHour ?? 120) })
  return {
    element: el('div', { class: 'field' },
      el('label', { text: '对话中的节奏' }),
      '对话中每', active, '秒看一次；bot 说过话之后', windowMin, '分钟内都算对话中；之后用', relaxMin, '分钟慢慢回到常态；对话中每小时最多', activePerHour, '次',
      el('div', { class: 'muted small', text: '被叫到、或者刚回过话的那一阵子会看得更勤；聊完了自动慢回去。把“对话中”设得比常态还长不会生效。闹的群建议先把“对话中每小时最多”压到 30–40，看两天实际额度。' })),
    read: () => ({
      activeIntervalMs: Number(active.value) * 1000,
      conversationWindowMs: Number(windowMin.value) * 60000,
      relaxMs: Number(relaxMin.value) * 60000,
      activePerHour: Number(activePerHour.value),
    }),
  }
}

/**
 * 盯群节奏的一组输入。`onSave(patch)` 负责提交；不传就不带保存按钮（给统一设置表单用）。
 * @returns {{element: any, read: () => object}}
 */
function watchControls(s, onSave, { withSave = true } = {}) {
  const interval = el('input', { type: 'number', class: 'narrow', min: '5', max: '3600', value: String(Math.round(s.watch.minIntervalMs / 1000)) })
  const perHour = el('input', { type: 'number', class: 'narrow', min: '1', max: '360', value: String(s.watch.perHour) })
  const messages = el('input', { type: 'number', class: 'narrow', min: '1', max: '60', value: String(s.watch.messages) })
  const chars = el('input', { type: 'number', class: 'narrow', min: '200', max: '12000', step: '100', value: String(s.watch.chars) })
  const speak = el('input', { type: 'number', class: 'narrow', min: '0', max: '600', value: String(s.budget.perHour) })
  const cadence = cadenceInputs(s)
  const read = () => ({
    watch: {
      minIntervalMs: Number(interval.value) * 1000,
      perHour: Number(perHour.value),
      messages: Number(messages.value),
      chars: Number(chars.value),
      ...cadence.read(),
    },
    budget: { perHour: Number(speak.value) },
  })
  const element = el('div', { class: 'field' },
    el('label', { text: '盯群节奏' }),
    '常态：至少隔', interval, '秒看一次，每小时最多', perHour, '次，一次带', messages, '条 /', chars, '字，最多主动说', speak, '次',
    withSave ? el('button', { class: 'btn', type: 'button', text: '保存', onclick: action(() => onSave(read())) }) : null,
    cadence.element,
    el('div', { class: 'muted small', text: '每看一眼都是常驻会话的一个回合（用主模型），群越热闹越费额度。被叫到时照常回，不受这里限制。' }))
  return { element, read }
}

/** 某个群的盯群节奏（保存写这个群的单独设置） */
function watchFields(group, s, rerender) {
  return watchControls(s, patch => put(`/group/${group.groupId}/settings`, patch, rerender)).element
}

/** “所有群统一设置”：没单独设置的群都跟随它 */
function globalCard(data, rerender) {
  const g = data.global
  const s = g.settings
  const modeSelect = select(data.modes.map(item => [item.id, item.label]), s.mode, null)
  const eagerness = el('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(s.eagerness) })
  const eagernessLabel = el('span', { class: 'mono small', text: s.eagerness.toFixed(1) })
  eagerness.addEventListener('input', () => { eagernessLabel.textContent = Number(eagerness.value).toFixed(1) })
  const quoteInput = el('input', { type: 'checkbox', checked: s.reply.quote })
  const membersInput = el('input', { type: 'checkbox', checked: s.members.enabled })
  const coldStartInput = el('input', { type: 'checkbox', checked: s.coldStart.enabled })
  const quietStart = el('input', { type: 'text', class: 'narrow', placeholder: '23:30', value: s.quietHours.start })
  const quietEnd = el('input', { type: 'text', class: 'narrow', placeholder: '08:30', value: s.quietHours.end })
  const watch = watchControls(s, null, { withSave: false })
  const patch = () => ({
    mode: modeSelect.value,
    eagerness: Number(eagerness.value),
    reply: { quote: quoteInput.checked },
    members: { enabled: membersInput.checked },
    coldStart: { enabled: coldStartInput.checked },
    quietHours: { start: quietStart.value.trim(), end: quietEnd.value.trim() },
    ...watch.read(),
  })
  return section('所有群的统一设置',
    el('p', { class: 'muted small', text: `这里是默认值：没单独设置的群都跟随它。当前 ${g.follows} 个已接入群跟随，${g.overridden} 个群有自己的单独设置。` }),
    g.overridden > 0 && g.follows === 0
      ? el('div', { class: 'notice warn', text: `现在所有有单独设置的群都不跟随这里的统一设置，改这里不会生效。想统一：挑一个设置最合适的群，点它的「把本群设置设为所有群的默认」；或者点下面「所有群改为跟随统一设置」（落盘前会留 groups.json.bak）。` })
      : null,
    el('div', { class: 'field' }, el('label', { text: '参与方式' }), modeSelect,
      el('div', { class: 'muted small', text: '改这里会影响所有跟随统一设置的群；单个群想不一样，在下面那个群里改就会自动变成“本群单独设置”。' })),
    el('div', { class: 'field' }, el('label', { text: '插话积极度' }), eagerness, eagernessLabel,
      el('div', { class: 'muted small', text: '越高越容易插话，同时越省精力。被叫到时不受限制。' })),
    el('div', { class: 'btn-row' },
      el('label', { class: 'inline' }, quoteInput, '回复时引用触发它的那条消息'),
      el('label', { class: 'inline' }, membersInput, '记群友的称呼、关系、偏好（成员记忆）'),
      el('label', { class: 'inline' }, coldStartInput, '接入时生成群概况')),
    el('div', { class: 'field' }, el('label', { text: '静默时段（不主动插话，被叫到照常回）' }), quietStart, '—', quietEnd),
    watch.element,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', type: 'button', text: '保存统一设置', onclick: action(() => put('/group/global-settings', patch(), rerender, '已保存到所有跟随的群')) }),
      el('button', { class: 'btn', type: 'button', text: '清空统一设置', onclick: action(async () => {
        if (!confirm('清空“所有群统一设置”？所有群会回到配置文件里的默认值。')) return
        await api('DELETE', '/group/global-settings')
        toast('已清空统一设置')
        rerender()
      }) }),
      el('button', { class: 'btn', type: 'button', text: '所有群改为跟随统一设置', onclick: action(async () => {
        if (!confirm('清掉所有群的单独设置，让它们全部跟随这里的统一设置？（落盘前会留 groups.json.bak）')) return
        const result = await api('POST', '/group/apply-global')
        toast(result.cleared ? `已让 ${result.cleared} 个群改为跟随` : '所有群本来就都跟随')
        rerender()
      }) })),
    el('p', { class: 'muted small', text: '保存会把这一页的项整层写成覆盖，配置文件里的默认值和 group.templates 会被盖住；想回到配置默认点「清空统一设置」。每次写 groups.json 前会把上一份留成 groups.json.bak。' }))
}

function groupCard(group, data, rerender) {
  const s = group.settings
  const badges = [
    el('span', { class: `badge ${group.inScope ? 'ok' : 'warn'}`, text: group.inScope ? '已接入' : '没接入' }),
    group.inScope ? el('span', { class: 'badge', text: group.followsGlobal ? '跟随统一设置' : '本群单独设置' }) : null,
    group.viaConfig ? el('span', { class: 'badge', text: '配置里写了' }) : null,
    group.blocked ? el('span', { class: 'badge warn', text: '在黑名单里' }) : null,
    group.engine?.muted ? el('span', { class: 'badge warn', text: '被禁言' }) : null,
  ]
  const head = el('div', { class: 'card-head' },
    el('h2', { text: `群 ${group.groupId}${group.name ? `（${group.name}）` : ''}` }), el('div', { class: 'badges' }, badges))

  const controls = []
  if (!group.viaConfig && !group.blocked) {
    controls.push(el('div', { class: 'btn-row' },
      el('button', { class: `btn ${group.admittedRuntime ? '' : 'btn-primary'}`, type: 'button',
        text: group.admittedRuntime ? '不再接入这个群' : '接入这个群',
        onclick: action(async () => {
          if (!group.admittedRuntime && !confirm(`接入群 ${group.groupId}？接入后它会记录这个群的聊天（只存本机），被叫到时回话。`)) return
          await put(`/group/${group.groupId}/admit`, { admitted: !group.admittedRuntime }, rerender, group.admittedRuntime ? '已关闭' : '已接入')
        }) }),
      el('span', { class: 'muted small', text: group.seenCount ? `见过 ${group.seenCount} 条消息，最后一条 ${fmtAgo(group.lastSeenAt)}（只记条数，不记内容）` : '' })))
  }
  if (!group.inScope) return el('section', { class: 'card' }, head, controls)

  const modeSelect = select(data.modes.map(item => [item.id, item.label]), s.mode,
    value => action(() => put(`/group/${group.groupId}/settings`, { mode: value }, rerender))())
  const eagerness = el('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(s.eagerness) })
  const eagernessLabel = el('span', { class: 'mono small', text: s.eagerness.toFixed(1) })
  eagerness.addEventListener('input', () => { eagernessLabel.textContent = Number(eagerness.value).toFixed(1) })
  eagerness.addEventListener('change', action(() => put(`/group/${group.groupId}/settings`, { eagerness: Number(eagerness.value) }, rerender)))
  const quietStart = el('input', { type: 'text', class: 'narrow', placeholder: '23:30', value: s.quietHours.start })
  const quietEnd = el('input', { type: 'text', class: 'narrow', placeholder: '08:30', value: s.quietHours.end })

  controls.push(
    el('div', { class: 'field' }, el('label', { text: '参与方式' }), modeSelect,
      el('div', { class: 'muted small', text: MODE_HINT[s.mode] ?? '' })),
    s.mode === 'active' || s.mode === 'present'
      ? el('div', { class: 'field' }, el('label', { text: '插话积极度' }), eagerness, eagernessLabel,
        el('div', { class: 'muted small', text: '越高越容易插话，同时越省精力。被叫到时不受限制。' }))
      : null,
    s.mode === 'watch' ? watchFields(group, s, rerender) : null,
    el('div', { class: 'btn-row' },
      checkbox('回复时引用触发它的那条消息', s.reply.quote, value => action(() => put(`/group/${group.groupId}/settings`, { reply: { quote: value } }, rerender))()),
      checkbox('记群友的称呼、关系、偏好（成员记忆）', s.members.enabled, value => action(() => put(`/group/${group.groupId}/settings`, { members: { enabled: value } }, rerender))()),
      checkbox('接入时生成群概况', s.coldStart.enabled, value => action(() => put(`/group/${group.groupId}/settings`, { coldStart: { enabled: value } }, rerender))())),
    el('div', { class: 'field' }, el('label', { text: '静默时段（不主动插话，被叫到照常回）' }), quietStart, '—', quietEnd,
      el('button', { class: 'btn', type: 'button', text: '保存', onclick: action(() => put(`/group/${group.groupId}/settings`, { quietHours: { start: quietStart.value.trim(), end: quietEnd.value.trim() } }, rerender)) })),
    el('div', { class: 'btn-row' },
      group.followsGlobal ? null : el('button', { class: 'btn', type: 'button', text: '改为跟随统一设置', onclick: action(async () => {
        await api('DELETE', `/group/${group.groupId}/settings`)
        toast('已改为跟随统一设置')
        rerender()
      }) }),
      group.followsGlobal ? null : el('button', { class: 'btn', type: 'button', text: '把本群设置设为所有群的默认', onclick: action(async () => {
        if (!confirm('把这个群的单独设置提为“所有群的统一设置”？其他群的单独设置会被清掉（会留 groups.json.bak）。')) return
        const result = await api('POST', `/group/${group.groupId}/promote`)
        toast(result.cleared ? `已设为统一设置，${result.cleared} 个群改为跟随` : '已设为统一设置')
        rerender()
      }) })),
  )

  const engine = group.engine
  const stats = group.interjects
  const cadence = engine?.lookCadence
  const watchNow = cadence
    ? `　当前节奏：${CADENCE_LABEL[cadence.phase] ?? cadence.phase}（${Math.round(cadence.intervalMs / 1000)} 秒/次，每小时最多 ${cadence.perHourCap} 次）`
    : ''
  const looksTotal = (engine?.looksLastHour ?? 0) + (engine?.activeLooksLastHour ?? 0)
  const now = !engine
    ? '还没有人说过话'
    : s.mode === 'watch'
      ? `最近一小时看群 ${looksTotal} 次${engine.activeLooksLastHour ? `（其中对话中 ${engine.activeLooksLastHour} 次）` : ''}、主动说话 ${engine.interjectsLastHour} 次${watchNow}${engine.lastLookAt ? `　上次看群 ${fmtAgo(engine.lastLookAt)}` : ''}${engine.turnOpen ? '　正在回上一轮' : ''}`
      : `${engine.present ? '在场' : '离场'}　精力 ${engine.energy}　最近一小时主动插话 ${engine.interjectsLastHour} 次${engine.closedUntil ? '　对话已收尾' : ''}`
  const status = el('dl', { class: 'kv' },
    el('dt', { text: '现在' }), el('dd', { text: now }),
    el('dt', { text: '插话被接住率' }), el('dd', { text: stats.total ? `最近 ${stats.total} 次主动插话：被接住 ${stats.engaged}、被嫌弃 ${stats.rejected}、没人理 ${stats.silence}` : '还没有主动插话过' }),
    el('dt', { text: '记忆' }), el('dd', { text: `${group.memberMemories} 条群友记忆，${group.candidates} 条候选（群概况等，去“记忆”页转正）` }))

  const decisions = engine?.decisions?.length
    ? el('details', {}, el('summary', { text: `最近 ${engine.decisions.length} 次决定和理由` }),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['时间', '档位', '回不回', '理由', '分数'].map(text => el('th', { text })))),
        el('tbody', {}, engine.decisions.map(d => el('tr', {},
          el('td', { text: fmtTime(d.at) }), el('td', { text: d.mode }), el('td', { text: d.respond ? '回' : '不回' }),
          el('td', { text: reasonText(d.reason) + (d.judgeReason ? `（${d.judgeReason}）` : '') }),
          el('td', { class: 'mono small', text: d.score !== undefined ? `${d.score}/${d.threshold}` : '' })))))))
    : null

  const memberId = el('input', { type: 'text', class: 'narrow', placeholder: 'QQ 号' })
  const deleteMessages = el('input', { type: 'checkbox' })
  const forget = el('details', {}, el('summary', { text: '“忘掉我”：删掉某个群友的记忆' }),
    el('div', { class: 'btn-row' }, memberId, el('label', { class: 'inline' }, deleteMessages, '同时删掉他在语料库里的原话'),
      el('button', { class: 'btn btn-danger', type: 'button', text: '忘掉他', onclick: action(async () => {
        const id = memberId.value.trim()
        if (!/^\d{1,12}$/.test(id)) throw new Error('请填 QQ 号')
        if (!confirm(`删掉群友 ${id} 在这个群的全部记忆，并不再记他？`)) return
        const result = await api('POST', `/group/${group.groupId}/forget-member`, { memberId: id, deleteMessages: deleteMessages.checked })
        toast(`已删 ${result.removedMemories} 条记忆${result.removedMessages === null ? '' : `、${result.removedMessages} 条原话`}`)
        rerender()
      }) })))

  return el('section', { class: 'card' }, head, controls, status, decisions, forget)
}

export async function renderGroup(view, { signal, navigate }) {
  const data = await api('GET', '/group').catch(error => ({ error }))
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: '群聊' }),
      el('p', { class: 'muted', text: '群聊默认不接，在这里逐个打开。没单独设置的群跟随「所有群的统一设置」，一个地方改全部；单个群想不一样再单独改。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate('#/group') }))))
  if (data.error) {
    view.append(el('div', { class: 'notice bad', text: data.error.message ?? String(data.error) }))
    return
  }
  const rerender = () => navigate('#/group')
  const judge = data.judge
  const target = judge.status.target
  const configured = judge.config.provider
    ? `${judge.config.provider}/${judge.config.model}`
    : `${target?.provider ?? '（宿主当前的 provider）'}/${target?.model ?? judge.config.model}（provider 跟着宿主）`
  view.append(section('活跃档的判断模型',
    el('p', {}, configured,
      el('span', { class: `badge ${judge.status.using === 'unavailable' ? 'warn' : 'ok'}`, text: { configured: '正常', fallback: '已改用备用模型', unavailable: '不可用' }[judge.status.using] ?? judge.status.using })),
    judge.status.candidates?.length > 1 ? el('p', { class: 'muted small', text: `用不了时依次改用：${judge.status.candidates.slice(1).join(' → ')}` }) : null,
    judge.status.timeouts ? el('p', { class: 'muted small', text: `超时 ${judge.status.timeouts} 次（超时只算这次慢，不换模型）` }) : null,
    judge.status.note ? el('p', { class: 'muted small', text: judge.status.note }) : null,
    judge.status.lastError ? el('p', { class: 'muted small', text: `最近的错误：${judge.status.lastError}` }) : null,
    data.memberJobs ? el('p', { class: 'muted small', text: `成员记忆整理：跑过 ${data.memberJobs.runs} 次，新增群友记忆 ${data.memberJobs.memberItems} 条、群概况 ${data.memberJobs.overviewItems} 条${data.memberJobs.lastError ? `；最近的错误：${data.memberJobs.lastError}` : ''}` }) : null))
  if (data.global) view.append(globalCard(data, rerender))
  if (data.groups.length === 0) view.append(el('p', { class: 'muted', text: '还没有见过任何群。bot 被拉进群、有人说话之后，这里会出现。' }))
  for (const group of data.groups) view.append(groupCard(group, data, rerender))
}

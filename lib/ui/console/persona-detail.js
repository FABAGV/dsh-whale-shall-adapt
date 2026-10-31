import { api, el, clear, action, toast, waitJob, select, checkbox, fmtTime, fmtAgo } from './lib.js'

const ORIGIN_LABEL = { generate: '生成', refine: '按反馈修订', manual: '手动修改' }
const OWNER_SCOPE = '你在 DSH 里直接开的会话'

/** 试聊记录只留在这个浏览器标签页里，切换人格时清空。 */
const chatHistory = new Map()

const chatName = key => {
  const [type, id] = String(key).split(':')
  return `${type === 'group' ? 'QQ 群' : 'QQ 私聊'} ${id}`
}

/** 绑定写成一句话：这个人格用在哪些会话。 */
export function scopeText(bindings = []) {
  const parts = bindings.map(item => (item.kind === 'owner' ? OWNER_SCOPE : item.kind === 'chat' ? chatName(item.key) : `会话 ${item.id}`))
  return parts.length ? parts.join('、') : '还没绑定任何会话'
}

/** 模仿群友的人格没用在来源会话上时给一句提示（群里看不到人格多半是这个原因）。 */
function scopeNotice(persona) {
  const source = persona.source
  if (persona.kind !== 'member' || !source) return null
  const key = `${source.chatType}:${source.chatId}`
  if (persona.bindings.some(item => item.kind === 'chat' && item.key === key)) return null
  return el('div', { class: 'notice warn', text: `这个人格模仿的是${chatName(key)}里的人，但现在没用在${chatName(key)}：在那里聊天时不会带上它。要用的话，到下面「用在哪些会话」勾上它再保存。` })
}

/** 自己写 / 改一版：自白和原话片段，存成新版本（来源“手动修改”）并设为当前版本 */
function versionEditor(persona, version, { onDone, onCancel = null }) {
  const isMember = persona.kind === 'member'
  const who = persona.source?.memberName || persona.name
  const spec = el('textarea', {
    rows: 12, maxlength: 4000, value: version?.spec ?? '',
    placeholder: '用这个人自己的口吻写一段内心独白：我怎么看这些人、什么事我懒得理、什么时候我会接话、我为什么这么说话……',
  })
  const excerpts = isMember && version
    ? el('textarea', { rows: 10, value: version.excerptsText ?? '', placeholder: `${who}: 他说的话\n甲: 别人说的话\n\n（空一行隔开一个场景）` })
    : null
  const save = el('button', { class: 'btn btn-primary', type: 'button', text: '存成新版本' })
  save.addEventListener('click', action(async () => {
    const body = { spec: spec.value }
    if (excerpts) body.excerptsText = excerpts.value
    const result = await api('POST', `/personas/${persona.id}/versions`, body)
    toast(`已存成 v${result.version}，并设为当前版本`)
    await onDone()
  }, { busyText: '保存中…' }))
  return el('div', {},
    el('label', { text: isMember ? `风格说明（${who}的自白，会注入）` : '风格说明（会注入）' }), spec,
    el('div', { class: 'field-hint', text: '写态度和动机，别写成规则清单。比如别写“整体是懒散、冷幽默”，写“我不是很喜欢那些热脸贴冷屁股的人，更不会去做”。' }),
    excerpts
      ? [el('label', { text: '原话片段（聊天记录原文，会注入）' }), excerpts,
        el('div', { class: 'field-hint', text: `每行「名字: 说的话」，他自己写「${who}」或「我」；空一行隔开一个场景，最多 12 段。全删掉就不带原话。` })]
      : null,
    isMember && !version ? el('div', { class: 'field-hint', text: '原话片段会从聊天记录里自动挑几段，存好之后可以再改。' }) : null,
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, save,
      onCancel ? el('button', { class: 'btn btn-ghost', type: 'button', text: '取消', onclick: onCancel }) : null))
}

function versionBody(body, version) {
  clear(body)
  if (!version) return
  if (version.changes?.length) {
    body.append(el('div', { class: 'notice' }, el('strong', { text: `v${version.v} 改了：` }), el('ul', {}, version.changes.map(text => el('li', { class: 'small', text })))))
  }
  body.append(el('pre', { class: 'block', text: version.spec }))
  if (version.excerptsText) {
    body.append(el('h3', { text: '原话片段（聊天记录原文，一起注入）', style: 'margin-top:12px' }), el('pre', { class: 'block', text: version.excerptsText }))
  } else if (version.samples?.length) {
    body.append(el('h3', { text: '示例回复（旧版本由模型写的，不注入）', style: 'margin-top:12px' }), el('ul', {}, version.samples.map(text => el('li', { text }))))
  }
  if (version.analysis) {
    body.append(el('details', {}, el('summary', { text: '性格分析（模型写的，只给你看，不注入）' }), el('pre', { class: 'block', text: version.analysis })))
  }
  if (version.statsText) {
    body.append(el('details', {}, el('summary', { text: '本地统计（按他的真实发言算的）' }), el('pre', { class: 'block', text: version.statsText })))
  }
  body.append(el('p', { class: 'muted small', text: version.model ? `模型：${version.model}` : version.origin === 'manual' ? '你手动写的' : '' }))
}

function versionCard(persona, refresh) {
  const active = persona.versions.find(item => item.v === persona.activeVersion)
  const head = el('div', { class: 'card-head' }, el('h2', { text: '风格说明' }))
  const card = el('section', { class: 'card' }, head)
  if (!active) {
    if (persona.runningJob) {
      card.append(el('p', { class: 'empty', text: '正在生成第一个版本…' }))
      return card
    }
    card.append(el('p', { class: 'muted', text: '还没有版本。点上面的「生成」让模型写一份，或者在这里自己写。' }), versionEditor(persona, null, { onDone: refresh }))
    return card
  }
  const versions = [...persona.versions].reverse()
  const picker = select(versions.map(item => [String(item.v), `v${item.v} · ${ORIGIN_LABEL[item.origin] ?? item.origin} · ${fmtTime(item.at)}`]), String(active.v))
  const useVersion = el('button', { class: 'btn btn-small', type: 'button', text: '设为当前版本', disabled: true })
  const edit = el('button', { class: 'btn btn-small', type: 'button', text: '编辑' })
  const body = el('div', {})
  let shown = active
  const show = version => {
    shown = version
    versionBody(body, version)
  }
  picker.addEventListener('change', () => {
    useVersion.disabled = picker.value === String(persona.activeVersion)
    show(persona.versions.find(item => String(item.v) === picker.value))
  })
  useVersion.addEventListener('click', action(async () => {
    await api('PATCH', `/personas/${persona.id}`, { activeVersion: Number(picker.value) })
    toast(`已切到 v${picker.value}`)
    await refresh()
  }))
  edit.addEventListener('click', () => {
    clear(body)
    body.append(el('p', { class: 'muted small', text: `在 v${shown.v} 的基础上改，存好之后是一个新版本，旧版本都还在。` }),
      versionEditor(persona, shown, { onDone: refresh, onCancel: () => show(shown) }))
  })
  show(active)
  head.append(el('div', { class: 'btn-row' }, picker, useVersion, edit))
  card.append(body, el('details', {}, el('summary', { text: '实际注入的文本（当前版本）' }), el('pre', { class: 'block', text: persona.preview || '（空）' })))
  return card
}

function chatCard(persona, refresh) {
  const history = chatHistory.get(persona.id) ?? []
  chatHistory.set(persona.id, history)
  const versions = [...persona.versions].reverse()
  const versionSelect = select(versions.map(item => [String(item.v), `用 v${item.v}`]), String(persona.activeVersion ?? ''))
  const log = el('div', { class: 'chat' })
  const input = el('textarea', { rows: 2, placeholder: '说点什么，看它怎么回…' })
  const send = el('button', { class: 'btn btn-primary', type: 'button', text: '发送' })

  const feedbackFor = (message, reply, version) => {
    const note = el('input', { type: 'text', placeholder: '哪里不像？（比如：他不会用这么多感叹号）' })
    const submit = rating => action(async () => {
      await api('POST', `/personas/${persona.id}/feedback`, { version, message, reply, note: note.value.trim(), rating })
      toast('反馈已记下，攒几条后点「按反馈修订」')
      await refresh()
    })
    return el('div', { class: 'msg-actions' },
      el('button', { class: 'btn btn-small', type: 'button', text: '像', onclick: submit('good') }),
      el('div', { style: 'width:300px' }, note),
      el('button', { class: 'btn btn-small', type: 'button', text: '不像，记下', onclick: submit('bad') }))
  }
  const draw = () => {
    clear(log)
    if (history.length === 0) log.append(el('p', { class: 'empty', text: '试聊不会进任何 DSH 会话，也不会留下会话记录。' }))
    history.forEach((item, index) => {
      log.append(el('div', { class: `msg ${item.role}`, text: item.text }))
      if (item.role === 'assistant') log.append(feedbackFor(history[index - 1]?.text ?? '', item.text, item.version))
    })
    log.scrollTop = log.scrollHeight
  }
  send.addEventListener('click', action(async () => {
    const message = input.value.trim()
    if (!message) return
    const version = Number(versionSelect.value)
    const prior = history.map(item => ({ role: item.role, text: item.text }))
    history.push({ role: 'user', text: message })
    input.value = ''
    draw()
    try {
      const result = await api('POST', `/personas/${persona.id}/test`, { version, history: prior, message })
      history.push({ role: 'assistant', text: result.reply || '（空回复）', version: result.version })
    } catch (error) {
      history.pop()
      input.value = message
      throw error
    } finally {
      draw()
    }
  }, { busyText: '等回复…' }))
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send.click()
  })
  draw()
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '试聊' }),
      el('div', { class: 'btn-row' }, versionSelect,
        el('button', { class: 'btn btn-small btn-ghost', type: 'button', text: '清空', onclick: () => { history.length = 0; draw() } }))),
    log,
    el('div', { class: 'chat-input' }, input, send),
    el('p', { class: 'field-hint', text: 'Ctrl + Enter 发送。对回复点「像」或「不像」都会记成一条反馈。' }))
}

function feedbackCard(persona, refresh) {
  const pending = persona.feedback.filter(item => item.appliedIn === null)
  const applied = persona.feedback.filter(item => item.appliedIn !== null)
  const row = item => el('div', { class: 'entry' },
    el('div', {},
      el('div', { class: 'entry-meta' },
        el('span', { class: `badge ${item.rating === 'good' ? 'ok' : item.rating === 'bad' ? 'bad' : ''}`, text: item.rating === 'good' ? '像' : item.rating === 'bad' ? '不像' : '意见' }),
        el('span', { class: 'muted small', text: `v${item.version ?? '?'} · ${fmtAgo(item.at)}${item.appliedIn ? ` · 已用于 v${item.appliedIn}` : ''}` })),
      item.note ? el('div', { text: item.note }) : null,
      item.message ? el('div', { class: 'small muted', text: `测试：${item.message}` }) : null,
      item.reply ? el('div', { class: 'small muted ellipsis', title: item.reply, text: `回复：${item.reply}` }) : null),
    el('div', {}, el('button', { class: 'btn btn-small btn-ghost', type: 'button', text: '删掉', onclick: action(async () => {
      await api('DELETE', `/personas/${persona.id}/feedback/${item.id}`)
      await refresh()
    }) })))
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: `反馈（${pending.length} 条待用）` })),
    pending.length ? pending.map(row) : el('p', { class: 'empty', text: '还没有待用的反馈。在试聊里标出哪里不像。' }),
    applied.length ? el('details', {}, el('summary', { text: `已经用过的反馈（${applied.length}）` }), applied.map(row)) : null)
}

function memoryCard(persona, refresh) {
  const save = memory => api('PATCH', `/personas/${persona.id}`, { memory })
  const items = persona.memory.map(item => el('div', { class: 'entry' },
    el('div', {}, el('div', { text: item.text }),
      el('div', { class: 'entry-meta' }, el('span', { class: `badge ${item.status === 'active' ? 'ok' : 'warn'}`, text: item.status === 'active' ? '启用' : '候选（修订时模型建议的）' }))),
    el('div', { class: 'btn-row' },
      item.status === 'candidate'
        ? el('button', { class: 'btn btn-small', type: 'button', text: '采用', onclick: action(async () => {
          await save(persona.memory.map(other => (other.id === item.id ? { ...other, status: 'active' } : other)))
          await refresh()
        }) })
        : null,
      el('button', { class: 'btn btn-small btn-ghost', type: 'button', text: '删掉', onclick: action(async () => {
        await save(persona.memory.filter(other => other.id !== item.id))
        await refresh()
      }) }))))
  const input = el('input', { type: 'text', maxlength: 200, placeholder: '比如：群里管群主叫"老大"' })
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '人格记忆' })),
    el('p', { class: 'muted small', text: '启用的记忆会附在风格说明后面一起注入。只写这个人格该知道的事实，不要写别人的隐私。' }),
    items.length ? items : el('p', { class: 'empty', text: '还没有记忆。' }),
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, el('div', { style: 'flex:1;min-width:220px' }, input),
      el('button', { class: 'btn', type: 'button', text: '添加', onclick: action(async () => {
        const text = input.value.trim()
        if (!text) return
        await save([...persona.memory, { text, status: 'active' }])
        await refresh()
      }) })))
}

function bindingCard(persona, chats, refresh) {
  const bindings = persona.bindings.map(item => ({ ...item }))
  const has = predicate => bindings.some(predicate)
  const toggle = (binding, on) => {
    const index = bindings.findIndex(item => JSON.stringify(item) === JSON.stringify(binding))
    if (on && index < 0) bindings.push(binding)
    if (!on && index >= 0) bindings.splice(index, 1)
  }
  const chatKeys = new Set([...chats.map(chat => chat.key), ...bindings.filter(item => item.kind === 'chat').map(item => item.key)])
  const sessionList = el('div', {})
  const drawSessions = () => {
    clear(sessionList)
    for (const binding of bindings.filter(item => item.kind === 'session')) {
      sessionList.append(el('div', { class: 'btn-row' }, el('span', { class: 'mono small', text: binding.id }),
        el('button', { class: 'btn btn-small btn-ghost', type: 'button', text: '移除', onclick: () => { toggle(binding, false); drawSessions() } })))
    }
  }
  drawSessions()
  const sessionInput = el('input', { type: 'text', placeholder: '会话 id（在「权限 → 单个会话」里能看到）' })
  const chatInput = el('input', { type: 'text', placeholder: 'group:群号 或 private:QQ号' })
  const chatBoxes = el('div', { class: 'list' })
  const drawChats = () => {
    clear(chatBoxes)
    for (const key of [...chatKeys].sort()) {
      chatBoxes.append(checkbox(chatName(key), has(item => item.kind === 'chat' && item.key === key), on => toggle({ kind: 'chat', key }, on)))
    }
    if (chatKeys.size === 0) chatBoxes.append(el('p', { class: 'muted small', text: '还没有 QQ 会话，可以在下面手动填。' }))
  }
  drawChats()
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: '用在哪些会话' })),
    el('p', { class: 'muted small', text: `人格只注入勾上的会话。「${OWNER_SCOPE}」指桌面端和命令行里你自己开的会话，不含 QQ 群和私聊；QQ 里要用就勾下面对应的群或私聊。同一个会话命中多个人格时：单个会话的绑定优先，其次 QQ 会话，最后是「${OWNER_SCOPE}」。子代理不注入人格。` }),
    checkbox(`${OWNER_SCOPE}（桌面端、命令行，不含 QQ）`, has(item => item.kind === 'owner'), on => toggle({ kind: 'owner' }, on)),
    el('h3', { text: 'QQ 会话', style: 'margin-top:12px' }), chatBoxes,
    el('div', { class: 'btn-row', style: 'margin-top:6px' }, el('div', { style: 'width:240px' }, chatInput),
      el('button', { class: 'btn btn-small', type: 'button', text: '加上', onclick: () => {
        const key = chatInput.value.trim()
        if (!/^(group|private):\d{1,12}$/.test(key)) return toast('格式是 group:群号 或 private:QQ号', 'bad')
        chatKeys.add(key)
        toggle({ kind: 'chat', key }, true)
        chatInput.value = ''
        drawChats()
      } })),
    el('h3', { text: '单个会话', style: 'margin-top:12px' }), sessionList,
    el('div', { class: 'btn-row', style: 'margin-top:6px' }, el('div', { style: 'width:320px' }, sessionInput),
      el('button', { class: 'btn btn-small', type: 'button', text: '加上', onclick: () => {
        const id = sessionInput.value.trim()
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return toast('会话 id 只能有字母、数字、连字符和下划线', 'bad')
        toggle({ kind: 'session', id }, true)
        sessionInput.value = ''
        drawSessions()
      } })),
    el('div', { class: 'btn-row', style: 'margin-top:14px' },
      el('button', { class: 'btn btn-primary', type: 'button', text: '保存绑定', onclick: action(async () => {
        await api('PATCH', `/personas/${persona.id}`, { bindings })
        toast('绑定已保存')
        await refresh()
      }) })))
}

export async function renderPersonaDetail(container, id, { signal, rerender, navigate, chats }) {
  const { persona } = await api('GET', `/personas/${id}`)
  if (signal.aborted) return
  const refresh = async () => rerender()
  const unapplied = persona.feedback.filter(item => item.appliedIn === null).length
  const runJob = path => action(async () => {
    const { job } = await api('POST', `/personas/${id}/${path}`)
    toast(`${job.label}：已开始`)
    await refresh()
  })
  const name = el('input', { type: 'text', value: persona.name, maxlength: 40 })
  name.addEventListener('change', action(async () => {
    await api('PATCH', `/personas/${id}`, { name: name.value })
    toast('名字已保存')
  }))
  const enabled = el('input', { type: 'checkbox', checked: persona.enabled, disabled: persona.activeVersion === null })
  enabled.addEventListener('change', action(async () => {
    try {
      await api('PATCH', `/personas/${id}`, { enabled: enabled.checked })
    } catch (error) {
      enabled.checked = !enabled.checked
      throw error
    }
    toast(enabled.checked ? `已启用：${scopeText(persona.bindings)}下一步就会用上` : '已停用')
    await refresh()
  }))
  const source = persona.source
  const head = el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { style: 'flex:1;max-width:320px' }, name),
      el('div', { class: 'btn-row' },
        el('label', { class: 'inline' }, enabled, '启用'),
        el('button', { class: 'btn', type: 'button', text: persona.versions.length ? '重新生成' : '生成', disabled: Boolean(persona.runningJob), onclick: runJob('generate') }),
        el('button', { class: 'btn btn-primary', type: 'button', text: `按反馈修订${unapplied ? `（${unapplied}）` : ''}`, disabled: Boolean(persona.runningJob) || unapplied === 0 || persona.activeVersion === null, onclick: runJob('refine') }),
        el('button', { class: 'btn btn-danger btn-ghost', type: 'button', text: '删除', onclick: action(async () => {
          if (!confirm(`删除人格「${persona.name}」？所有版本和反馈都会删掉。`)) return
          await api('DELETE', `/personas/${id}`)
          chatHistory.delete(id)
          navigate('#/persona')
        }) }))),
    el('p', { class: 'muted small', text: persona.kind === 'member'
      ? `模仿 QQ ${source?.chatType === 'group' ? '群' : '私聊'} ${source?.chatId} 里的「${source?.memberName || source?.memberId}」，读取最近 ${source?.days ?? 30} 天的发言。`
      : persona.description ? `按描述生成：${persona.description}` : '你自己写的人格（没有描述，“生成”用不了）' }),
    el('p', { class: 'small', text: `用在：${scopeText(persona.bindings)}${persona.enabled ? '' : '（未启用）'}` }),
    scopeNotice(persona),
    persona.runningJob ? el('div', { class: 'notice', text: `${persona.runningJob.label}…${persona.runningJob.progress ? `（${persona.runningJob.progress}）` : ''}` }) : null,
    !persona.runningJob && persona.lastJob?.status === 'failed' ? el('div', { class: 'notice bad', text: `上次${persona.lastJob.label}失败：${persona.lastJob.error}` }) : null)
  clear(container)
  container.append(head, versionCard(persona, refresh))
  if (persona.activeVersion !== null) container.append(chatCard(persona, refresh))
  container.append(feedbackCard(persona, refresh), memoryCard(persona, refresh), bindingCard(persona, chats, refresh))

  if (persona.runningJob) {
    const done = await waitJob(persona.runningJob.id, { signal })
    if (!done || signal.aborted) return
    if (done.status === 'done') toast(`${done.label}完成：v${done.result?.version}`)
    else toast(`${done.label}失败：${done.error}`, 'bad')
    await refresh()
  }
}

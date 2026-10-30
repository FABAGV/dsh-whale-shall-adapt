import { api, el, clear, action, section, fmtTime, toast, checkbox } from './lib.js'

function jobLine(job) {
  if (!job) return '还没同步过。'
  const phase = job.running ? (job.phase === 'list' ? '正在翻列表' : '正在抓词条') : '已结束'
  return `${phase}：翻了 ${job.pages} 页、看到 ${job.listed} 条、需要更新 ${job.changed} 条、已抓 ${job.fetched} 条${job.failed ? `、失败 ${job.failed} 条` : ''}${job.stoppedEarly ? '（增量：遇到整页没变就停了）' : ''}${job.error ? `；${job.error}` : ''}`
}

async function slangBox(view, rerender) {
  const group = el('input', { type: 'text', size: '12', placeholder: '群号' })
  const list = el('div', {})
  const title = el('input', { type: 'text', size: '12', placeholder: '黑话（≤20 字）' })
  const meaning = el('input', { type: 'text', size: '40', placeholder: '含义 / 怎么用' })
  const load = action(async () => {
    const id = group.value.trim()
    clear(list)
    if (!/^\d{1,12}$/.test(id)) throw new Error('请填群号')
    const { items } = await api('GET', `/meme/slang?group=${id}`)
    if (items.length === 0) list.append(el('p', { class: 'muted', text: '这个群还没有黑话。' }))
    else {
      list.append(el('ul', { class: 'list' }, items.map(item => el('li', { class: 'list-item' },
        el('strong', { text: item.title ?? '?' }), `：${item.meaning ?? ''}`,
        item.status !== 'active' ? el('span', { class: 'badge', text: item.status }) : null,
        el('button', { class: 'btn btn-danger', type: 'button', text: '删除', onclick: action(async () => {
          await api('DELETE', `/meme/slang/${item.id}`)
          await load()
        }) })))))
    }
  })
  view.append(section('本群黑话',
    el('p', { class: 'muted small', text: '群里自己的梗，优先于词库。只在那个群里生效。' }),
    el('div', { class: 'btn-row' }, group, el('button', { class: 'btn', type: 'button', text: '查看', onclick: load })),
    list,
    el('div', { class: 'btn-row' }, title, meaning, el('button', { class: 'btn btn-primary', type: 'button', text: '添加', onclick: action(async () => {
      await api('POST', '/meme/slang', { group: group.value.trim(), title: title.value, meaning: meaning.value })
      toast('已添加')
      title.value = ''
      meaning.value = ''
      await load()
    }) }))))
  void rerender
}

export async function renderMeme(view, { signal, navigate }) {
  const data = await api('GET', '/meme').catch(error => ({ error }))
  if (signal.aborted) return
  clear(view)
  view.append(el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: '梗百科' }),
      el('p', { class: 'muted', text: '群聊里出现网络梗时，把词条作为背景附给它，让它能接梗。词库不随插件分发，需要你自己导入或同步。' })),
    el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => navigate('#/meme') }))))
  if (data.error) {
    view.append(el('div', { class: 'notice bad', text: data.error.message ?? String(data.error) }))
    return
  }
  const rerender = () => navigate('#/meme')

  view.append(section('词库',
    el('p', {}, data.db.ok ? `已有 ${data.db.count} 条词条。` : `还不能用：${data.db.reason}`, el('span', { class: 'muted small', text: `　位置 ${data.dbPath}` })),
    el('p', { class: 'muted small', text: '导入：选 astrbot_plugin_memewiki 自带的 memes.db（内容来自 cnmeme.wiki，版权归该站和原作者）。少于现有条数的词库会被拒绝，除非勾选强制覆盖。' })))

  const path = el('input', { type: 'text', size: '60', placeholder: 'memes.db 的完整路径' })
  const force = el('input', { type: 'checkbox' })
  view.append(section('从本地导入',
    el('div', { class: 'btn-row' }, path, el('label', { class: 'inline' }, force, '强制覆盖'),
      el('button', { class: 'btn btn-primary', type: 'button', text: '导入', onclick: action(async () => {
        const result = await api('POST', '/meme/import', { path: path.value.trim(), force: force.checked })
        toast(`已导入 ${result.count} 条`)
        rerender()
      }) }))))

  const job = data.sync?.job
  view.append(section('联网（默认关）',
    el('p', {}, checkbox('允许联网查词和同步', data.settings.online, value => action(async () => {
      await api('PUT', '/meme/settings', { online: value })
      toast(value ? '联网已打开' : '联网已关闭')
      rerender()
    })())),
    el('p', { class: 'muted small', text: '打开后：词库没有、又像在问的词，会向 cnmeme.wiki 的公开只读接口查一次（限速，查过的存进检索存档）。这是插件唯一会往外发的请求；关着就一个请求都不发。' }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', text: '增量同步到本地词库', disabled: job?.running === true, onclick: action(async () => {
        await api('POST', '/meme/sync', {})
        toast('已开始，在后台跑')
        rerender()
      }) }),
      el('button', { class: 'btn', type: 'button', text: '全量同步', disabled: job?.running === true, onclick: action(async () => {
        if (!confirm('全量同步要翻完整个列表，词条多时需要几十分钟（每秒约 3 个请求）。继续？')) return
        await api('POST', '/meme/sync', { full: true })
        toast('已开始，在后台跑')
        rerender()
      }) }),
      el('button', { class: 'btn btn-danger', type: 'button', text: '停止', disabled: job?.running !== true, onclick: action(async () => {
        await api('DELETE', '/meme/sync')
        toast('已请求停止')
        rerender()
      }) })),
    el('p', { class: 'muted small', text: jobLine(job) }),
    data.sync ? el('p', { class: 'muted small', text: `请求 ${data.sync.requests} 次，被限流 ${data.sync.rateLimited} 次，失败 ${data.sync.failures} 次` }) : null))
  if (job?.running) {
    const timer = setTimeout(() => { if (!signal.aborted) rerender() }, 3000)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }

  view.append(section('检索存档',
    el('p', { class: 'muted small', text: '联网查过的结果：查到的存 90 天，没查到的存 3 天，省得重复发请求。' }),
    el('p', {}, data.archive ? `共 ${data.archive.total} 条（查到 ${data.archive.ok}、没有 ${data.archive.miss}），命中过 ${data.archive.hits} 次。` : '没有启用。'),
    data.archive?.total ? el('button', { class: 'btn btn-danger', type: 'button', text: '清空存档', onclick: action(async () => {
      if (!confirm('清空检索存档？之后会重新联网查。')) return
      const result = await api('DELETE', '/meme/archive')
      toast(`已清掉 ${result.removed} 条`)
      rerender()
    }) }) : null))

  await slangBox(view, rerender)
  void fmtTime
}

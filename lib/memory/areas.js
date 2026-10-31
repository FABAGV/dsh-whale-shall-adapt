/**
 * 记忆的「书架」——`area`。
 *
 * 和 `scope` 是两回事：
 *   - `scope` = 谁能看见（权限），由来源和隐私矩阵决定，模型不能改；
 *   - `area` = 这条放在哪个书架（归置），模型可以在写入时选，也可以新建。
 *
 * 用户定的规则（2026-11-01）：新学到的、跨聊天的学问默认**所有人可见**（scope = `shared`），
 * 归到哪个书架由模型/控制台决定；群聊里的话仍然只进那个群的书架。
 */
export const AREA_MAX = 40

const SCOPES_TO_DEFAULT_AREA = {
  owner: 'owner',
  'owner:work': 'owner:work',
  'owner:chat': 'owner:chat',
  shared: 'shared',
  persona: 'persona',
}

/** 书架名规整：去空白、限长、只留一个空格分隔；空值返回空串（由调用方兜底）。 */
export function normalizeArea(value) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  return raw.slice(0, AREA_MAX)
}

/**
 * 没有显式指定书架时，按 scope 推一个默认书架。
 * 群聊/私聊就用它自己的聊天名，群友相关的归到「group:<群号>」。
 */
export function defaultAreaOf(scope) {
  const s = String(scope ?? '')
  if (SCOPES_TO_DEFAULT_AREA[s]) return SCOPES_TO_DEFAULT_AREA[s]
  if (s.startsWith('chat:')) return s
  if (s.startsWith('member:')) {
    const group = s.split(':')[1]
    return group ? `group:${group}` : 'member'
  }
  if (s.startsWith('persona:')) return 'persona'
  return 'other'
}

/** 一条记忆最终用的书架：显式写的优先，否则按 scope 推。 */
export function areaOf(scope, area) {
  return normalizeArea(area) || defaultAreaOf(scope)
}

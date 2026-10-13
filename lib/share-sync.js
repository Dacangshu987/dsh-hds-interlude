/**
 * 分享码同步 —— 从分享站按分享码拉取预设并应用配置（移植自上游 `src/share-sync.ts`）。
 *
 * ## 安全铁律（上游与站点同源，本仓逐条保留）
 *
 * 预设只允许携带**白名单分区**；任何**连接类字段**（apiKey / endpoint /
 * proxyAgent / extraHeaders / secret / token / password / authorization）在拉取后
 * **立即深度剔除**。上游原话：站点已清洗过一次，插件侧再清洗一次，构成**纵深防御**
 * ——不信任任何一端的清洗是完备的。
 *
 * 本仓额外收紧了范围：上游的 `model` 与 `onebot` 永不出现在应用范围内；本仓与之
 * 对应的是**连接与模型相关的分区根本不进白名单**（`im` 整段不在白名单里——
 * 它带着 appId / secretRef / bots 绑定）。
 *
 * ## 本仓相对上游的两处适配
 *
 *   ① **白名单按本仓的 schema 写**：上游的 `chatActions` / `stickers` / `memory` /
 *      `worldSeeder` 在本仓分别落到 `im.*` 与别处，不是顶层段。白名单只列
 *      **本仓真实存在的顶层分区**——列了不存在的名字只会让人以为能同步。
 *   ② **出站走本仓的 SSRF 防护**（`lib/net/safe-fetch.js`）：上游直接用
 *      `ctx.http.get`，本仓默认**拒绝内网地址**，只有显式开启
 *      `presetSync.allowPrivateBaseUrl` 才放行（自托管分享站是正当用法，
 *      但必须由用户主动开）。
 *
 * @module dsh-hds-interlude/share-sync
 */

import { safeFetch } from './net/safe-fetch.js'

/**
 * 允许同步的**顶层分区**（本仓 schema 里真实存在的那些）。
 *
 * 刻意不含：
 *   - `im`：连接与机器人绑定（appId / secretRef / bots）——**连接类永不同步**；
 *   - `enabled` / `blackBox` / `mainPrompt` / `fixedPrompt` / `formatPrompt` /
 *     `stylePrompt` / `rules` / `timeZone`：开关、人格与提示词属于「这个人是谁」，
 *     不该被一份外来预设整段替换（要改提示词应当自己去改）；
 *   - `presetSync` 自身：防止一份预设把同步设置改成指向别处。
 */
export const SHARE_SECTIONS = [
  'story', 'runtime', 'urge', 'schedulePreplan', 'timelineDirector', 'agency',
  'proactive', 'alterSystem', 'longHorizon', 'blindMode', 'logging',
]

/** 分区内部**绝不允许出现**的字段名（深度扫描，不分层级）。 */
const FORBIDDEN_FIELDS = /^(apiKey|endpoint|extraHeaders|proxyAgent|deliveryBaseUrl|priceInput|priceOutput|price|baseUrl|secretRef|appId|appSecret|token|password|authorization|credit|balance)/i

/** 与上一条同义但按「敏感词」再兜一层（大小写不敏感）。 */
const SENSITIVE_FIELDS = /^(secret|token|password|authorization)$/i

/** 是不是「普通对象」（排除数组与 null）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 插件侧二次清洗：只保留白名单分区，并深度剔除连接类字段。
 *
 * **不信任远端**：这一步不看站点有没有清洗过，一律再洗一遍。
 *
 * @param {unknown} raw 远端返回的 payload。
 * @returns {{preset: object, removed: string[]}} 清洗后的预设与被剔除的路径。
 */
export function sanitizeSharePayload(raw) {
  if (!isPlainObject(raw)) throw new Error('预设 payload 不是对象。')
  const removed = []
  const scrub = (value, path) => {
    if (Array.isArray(value)) return value.map((item, i) => scrub(item, `${path}[${i}]`))
    if (!isPlainObject(value)) return value
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.test(key) || SENSITIVE_FIELDS.test(key)) {
        removed.push(`${path}.${key}`)
        continue
      }
      out[key] = scrub(val, `${path}.${key}`)
    }
    return out
  }
  const preset = {}
  for (const [key, value] of Object.entries(raw)) {
    if (SHARE_SECTIONS.includes(key)) preset[key] = scrub(value, key)
    else removed.push(key)
  }
  return { preset, removed }
}

/**
 * 规范化分享码：大写、去掉连字符与空白；非法返回 null。
 *
 * 字母表是 Crockford base32（去掉易混的 I / L / O / U），共 8 位。
 * 校验放在**发请求之前**：形状不对就没必要打扰分享站。
 *
 * @param {unknown} input 用户输入。
 * @returns {string|null}
 */
export function normalizeShareCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(code) ? code : null
}

/**
 * 深拷贝快照。
 *
 * 用途是**回滚**：存活引用会在应用补丁时被就地改动，于是「应用前的快照」
 * 悄悄变成「应用后的值」，回滚就失效了。
 *
 * @param {unknown} value 任意可 JSON 化的值。
 * @returns {unknown} 深拷贝。
 */
export function snapshotDeepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 稳定序列化：对象键排序后序列化，用于比较（键序不同不算「改过」）。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 比较一个分区的本地值与远端值（键级差异）。
 *
 * 只比**远端的键**（added / changed）加上「本地有而远端没有」的键（removedKeys）
 * ——removedKeys 只是提示：应用时是**整段替换**，所以远端没有的键会被清掉。
 *
 * @param {unknown} local 本地分区值。
 * @param {unknown} remote 远端分区值。
 * @returns {{changed: string[], added: string[], removedKeys: string[]}}
 */
export function diffSection(local, remote) {
  const localObj = isPlainObject(local) ? local : {}
  const remoteObj = isPlainObject(remote) ? remote : {}
  const changed = []
  const added = []
  for (const key of Object.keys(remoteObj)) {
    if (!(key in localObj)) added.push(key)
    else if (stableStringify(localObj[key]) !== stableStringify(remoteObj[key])) changed.push(key)
  }
  const removedKeys = Object.keys(localObj).filter(key => !(key in remoteObj))
  return { changed, added, removedKeys }
}

/**
 * 算出**要应用的配置补丁**（不改入参）。
 *
 * 整段替换：分区在远端是什么样，应用后就是什么样（而不是逐字段合并）——
 * 否则「远端删掉了一个字段」在本地永远删不掉。
 *
 * @param {object} config 当前配置。
 * @param {object} preset 清洗后的预设。
 * @param {string[]} sections 要应用的分区。
 * @param {{includeStoryDefaults?: boolean}} [opts] `story` 是否也按配置路径整段替换。
 * @returns {object} 新配置。
 */
export function buildConfigPatch(config, preset, sections, opts = {}) {
  const next = { ...(isPlainObject(config) ? config : {}) }
  for (const section of Array.isArray(sections) ? sections : []) {
    // `story` 是**故事档案模板**，默认走另一条路径（下面 storyDefaultsToStoryPatch），
    // 不在这里整段替换——否则会把当前正在跑的故事设定一起换掉。
    if (section === 'story' && !opts.includeStoryDefaults) continue
    if (!SHARE_SECTIONS.includes(section)) continue
    if (!isPlainObject(preset[section])) continue
    next[section] = JSON.parse(JSON.stringify(preset[section]))
  }
  return next
}

/**
 * `story` 预设 → 故事设定补丁。
 *
 * 上游同源语义：**只放入远端实际存在且非空的字段**——只给了角色名时，
 * 不会同时把本地已有的 profile 清空。这是「部分覆盖」的关键。
 *
 * @param {unknown} story 远端 story 分区。
 * @returns {object} 故事设定补丁（可能为空对象）。
 */
export function storyDefaultsToStoryPatch(story) {
  const s = isPlainObject(story) ? story : {}
  const patch = {}
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined)
  const character = {}
  const name = text(s.characterName ?? s.character?.name, 60)
  const profile = text(s.characterProfile ?? s.character?.profile, 20_000)
  if (name) character.name = name
  if (profile) character.profile = profile
  if (Object.keys(character).length) patch.character = character
  const userProfile = text(s.userProfile ?? s.user?.profile, 20_000)
  if (userProfile) patch.user = { profile: userProfile }
  const relationship = text(s.relationship, 4_000)
  if (relationship) patch.relationship = relationship
  const world = text(typeof s.world === 'string' ? s.world : s.world?.description, 20_000)
  if (world) patch.world = world
  const perspective = text(s.perspective, 1_200)
  if (perspective) patch.perspective = perspective
  if (Array.isArray(s.perspectives)) {
    const perspectives = s.perspectives.filter(p => typeof p === 'string' && p.trim()).map(p => p.slice(0, 1_200))
    if (perspectives.length) patch.perspectives = perspectives
  }
  if (Array.isArray(s.supplementaryFacts)) {
    const supplementaryFacts = s.supplementaryFacts.filter(f => typeof f === 'string' && f.trim()).map(f => f.slice(0, 1_200))
    if (supplementaryFacts.length) patch.supplementaryFacts = supplementaryFacts
  }
  const location = text(s.location, 500)
  if (location) patch.location = location
  const style = text(s.style, 20_000)
  if (style) patch.style = style
  return patch
}

/** 版本标识归一：把 `1.0.1-rc46` 与 `rc46` 视作同一版，避免误报版本差异。 */
export function normalizeShareVersion(value) {
  const m = String(value ?? '').match(/(?:rc|beta|alpha)\d+/i)
  return m ? m[0].toLowerCase() : String(value ?? '').toLowerCase()
}

/**
 * 组装给人看的概览（标题 / 作者 / 版本 / 分区 + 每分区键级差异）。
 *
 * @param {object} args
 * @param {object} args.info 远端分享信息（`fetchShare` 的 info）。
 * @param {object} args.config 当前配置。
 * @param {string[]} args.sections 本次将应用的分区。
 * @param {string} [args.localVersion] 本插件版本（用于版本差异提示）。
 * @param {string[]} [args.removed] 清洗时剔除的路径（要如实告知用户）。
 * @returns {{header: string[], diffs: Array<object>, storyPatch: object}}
 */
export function summarizeShare({ info, config, sections, localVersion, removed = [] }) {
  const list = Array.isArray(sections) ? sections : []
  const header = [
    `远程预设：${info.title}`,
    `作者：@${info.author?.name ?? '匿名'} · 类型：${info.type ?? '—'} · 适配 ${info.hdsi_version ?? '—'} · revision ${info.revision}`,
    info.nsfw ? '⚠ 此预设标记为含成人内容（NSFW）' : '',
    localVersion && info.hdsi_version
      && normalizeShareVersion(localVersion) !== normalizeShareVersion(info.hdsi_version)
      ? `⚠ 版本差异：预设来自 ${info.hdsi_version}，当前插件 ${localVersion}；个别字段可能有出入`
      : '',
    `包含分区：${(info.sections ?? []).join('、') || '（无）'}`,
    (info.sections ?? []).length !== list.length ? `本次将应用：${list.join('、') || '（无）'}` : '',
    removed.length ? `已剔除 ${removed.length} 项连接/敏感字段：${removed.slice(0, 6).join('、')}${removed.length > 6 ? ' …' : ''}` : '',
  ].filter(Boolean)
  const diffs = list
    .filter(section => section !== 'story')
    .map(section => ({ section, ...diffSection(config?.[section], info.payload?.[section]) }))
  return { header, diffs, storyPatch: storyDefaultsToStoryPatch(info.payload?.story) }
}

/**
 * 把概览渲染成命令行输出的若干行。
 *
 * @param {object} summary `summarizeShare` 的结果。
 * @returns {string[]} 行数组。
 */
export function formatDiffLines(summary) {
  const lines = [...(summary?.header ?? [])]
  for (const diff of summary?.diffs ?? []) {
    const bits = []
    if (diff.added.length) bits.push(`新增 ${diff.added.length} 项（${diff.added.slice(0, 5).join('、')}）`)
    if (diff.changed.length) bits.push(`改动 ${diff.changed.length} 项（${diff.changed.slice(0, 5).join('、')}）`)
    if (diff.removedKeys.length) bits.push(`本地多出 ${diff.removedKeys.length} 项将被清掉（${diff.removedKeys.slice(0, 5).join('、')}）`)
    lines.push(`  · ${diff.section}：${bits.join('；') || '无差异'}`)
  }
  const storyKeys = Object.keys(summary?.storyPatch ?? {})
  if (storyKeys.length) {
    lines.push(`  · story（故事档案模板）：${storyKeys.join('、')}`
      + '——默认**只显示不应用**，需要时用 apply --story 单独应用到当前故事')
  }
  return lines
}

/**
 * 按分享码拉取远端预设（已做二次清洗）。
 *
 * ## 错误分类（每一种都对应一种用户能采取的行动）
 *
 *   - 码格式不对 → 本地就能判定，**不发请求**；
 *   - 404 → 码不存在/已过期（作者改了预设旧码会失效）；
 *   - 429 → 分享站限流，等一会儿；
 *   - 响应与请求的码不一致 / revision 非法 / sections 不合法 → **当作无效响应**，
 *     防止旧接口、网关错误页或恶意响应被当成有效预设；
 *   - 清洗后没有可应用分区 → 报错，而不是「应用了一个空预设」（那会把配置清空）。
 *
 * ## 出站安全：本仓**不支持**内网分享站
 *
 * 上游用 `ctx.http.get` 直连，用户可以把 `baseUrl` 指向局域网自托管站点。
 * 本仓的出站一律走 `lib/net/safe-fetch.js`（SSRF 全防护：DNS 固定 + 逐跳重校验
 * + 内网地址拦截），而那一层**刻意不做内网例外**。所以：
 *
 *   - 分享站必须是**公网可达**的域名（默认 `https://typ0.space` 即可）；
 *   - 把 `baseUrl` 指向 `192.168.x.x` / `localhost` 会被拦下并如实报错。
 *
 * 这是**刻意的收紧**：为了支持局域网站点而在整个插件的出站层开一个内网口子，
 * 代价远大于收益。要自托管就把它放到公网（或自己加反代）。
 *
 * @param {object} args
 * @param {string} args.baseUrl 分享站地址（公网）。
 * @param {string} args.code 分享码（原始输入即可）。
 * @param {Function} [args.fetchImpl] 注入的抓取实现（测试用，形如
 *   `(url) => ({ status, body })`）；默认走 SSRF 防护层。
 * @returns {Promise<{info: object, removed: string[], cleaned: object}>}
 */
export async function fetchShare({ baseUrl, code, fetchImpl } = {}) {
  const normalized = normalizeShareCode(code)
  if (!normalized) throw new Error('分享码格式不正确：应为 8 位字母数字（大小写均可，可带连字符）。')
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置分享站地址（presetSync.baseUrl）。')
  const url = `${base}/api/share/${normalized}`

  let status = 200
  let body
  if (typeof fetchImpl === 'function') {
    const result = await fetchImpl(url)
    status = Number(result?.status) || 200
    body = result?.body
  } else {
    let result
    try {
      result = await safeFetch(url)
    } catch (error) {
      // SSRF 拦截也走这里——错误原文里已说明原因（内网地址/DNS 等），直接转达。
      throw new Error(`无法连接分享站（${base}）：${error?.message ?? String(error)}`)
    }
    status = Number(result?.statusCode) || 0
    // `safeFetch` 给的是**文本**（≤50000 字符），JSON 要自己解析。
    try {
      body = JSON.parse(String(result?.body ?? ''))
    } catch {
      body = undefined
    }
  }

  if (status === 404) throw new Error('分享码不存在、已过期或不可用。作者修改预设后旧码会失效——请到分享站获取新分享码。')
  if (status === 429) throw new Error('分享站限流：请求过于频繁，请约 1 分钟后重试。')
  if (status !== 200) throw new Error(`分享站返回异常状态 ${status}。`)
  if (!isPlainObject(body)) throw new Error('分享站响应格式异常（不是有效的 JSON 对象）。')

  // 响应校验：防止旧接口 / 网关错误页 / 恶意响应被当成有效预设。
  if (normalizeShareCode(String(body.code ?? '')) !== normalized) {
    throw new Error('分享站返回的分享码与请求不一致。')
  }
  const revision = Number(body.revision)
  if (!Number.isInteger(revision) || revision < 1) throw new Error('分享站返回的 revision 无效。')
  const sectionsRaw = body.sections
  if (!Array.isArray(sectionsRaw) || !sectionsRaw.every(s => typeof s === 'string')) {
    throw new Error('分享站返回的 sections 无效。')
  }

  const { preset, removed } = sanitizeSharePayload(body.payload)
  if (!Object.keys(preset).length) throw new Error('该预设经插件侧清洗后没有可应用的分区。')

  const author = isPlainObject(body.author) ? body.author : {}
  return {
    removed,
    cleaned: preset,
    info: {
      code: normalized,
      slug: typeof body.slug === 'string' ? body.slug : '',
      title: typeof body.title === 'string' ? body.title : code,
      type: typeof body.type === 'string' ? body.type : '',
      nsfw: body.nsfw === true,
      author: { id: Number(author.id) || 0, name: typeof author.name === 'string' ? author.name : '匿名' },
      hdsi_version: typeof body.hdsi_version === 'string' ? body.hdsi_version : '',
      revision,
      sections: sectionsRaw.filter(s => SHARE_SECTIONS.includes(s)),
      payload: preset,
    },
  }
}

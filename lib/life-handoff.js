/**
 * 生活交接（Life Handoff）—— 场景转换的**逐字溯源**。
 * 移植自上游 hds-interlude `src/script/life-handoff.ts`，并把校验接到本地账本上。
 *
 * ## 它解决什么问题
 *
 * 「她换了地方」「她现在在做别的事」「屋里还有谁」——这些是场景状态，模型每轮都
 * 可能声称它们变了。但模型**很会编**：它完全可以在没有任何依据的情况下写
 * 「她起身去了厨房」，于是场景状态被一个凭空的转换带跑。
 *
 * 上游的规矩很硬：**任何位置/活动/在场的声明，都必须引用这一段散文里的原文片段**，
 * 而且要能在该条目正文里逐字找到（见 `script-entry.js` 的 `verifyQuote`）。
 * 这样做的意义不是语义理解，而是**来源可查**：
 *   - 模型不能说「她答应了」而不指出哪几个字是「答应」；
 *   - 「在场的人」必须在那段原文里被点到名（`names` 里每个名字都要出现在 quote 中）。
 *
 * ## 关键语义（改动前务必读完，这几条都在上游被显式设计过）
 *
 * 1. **`presence` 是「完整的本地在场名单」，不是增量**。
 *    上游原话：`Complete local roster, including an explicitly evidenced empty roster.`
 *    所以「一个人独处」必须用 `names: []` + 支持性引文**显式**表达，
 *    而不是「没提 presence」——后者是「这次没说」，不是「她一个人」。
 *
 * 2. **转换会顶掉**`所有`本地占用**。
 *    只要有 `transition`、或 `place` 变了、或给了 `presence`，之前在场的人
 *    一律标记为 `off-scene`。上游注释：`Local occupancy superseded by a new
 *    original-script handoff; not an invented departure.`
 *    —— 注意这是**场景重置**，不是「她察觉某人离开了」。
 *
 * 3. **引文是证据，不是语义证明**。
 *    逐字匹配只能说明「这句话确实在那个条目里」，不能说明含义。判读仍归文学。
 *
 * @module dsh-hds-interlude/life-handoff
 */

/** 位置/活动取值长度上限（上游 160）。 */
const MAX_VALUE = 160
/** 引文长度上限（上游 500）。 */
const MAX_QUOTE = 500
/** 引文最短长度：一个字太容易误命中，上游从 2 起算。 */
const MIN_QUOTE = 2
/** 在场名单上限（上游 8）。 */
const MAX_NAMES = 8
/** 已完成的进行中细节上限（上游 10）。 */
const MAX_RESOLVED = 10
/** label 长度上限（上游 80）。 */
const MAX_LABEL = 80

/**
 * 在 `prose` 里逐字校验一条引文。
 *
 * 刻意不做的事：不做同义判断、不做模糊匹配、不纠正错别字、不忽略空白差异。
 * 引用对不上就是对不上——**宁可判为无证据，也不要替模型圆场**。
 *
 * @param {unknown} quote 候选引文。
 * @param {string} prose 被引用的原文。
 * @returns {boolean}
 */
export function isGroundedQuote(quote, prose) {
  if (typeof quote !== 'string') return false
  if (quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return false
  if (typeof prose !== 'string' || !prose) return false
  return prose.includes(quote)
}

/**
 * 规范化一个「值 + 引文」字段（`place` / `activity` 共用）。
 *
 * @param {unknown} item 候选 `{ value, quote }`。
 * @param {string} prose 原文。
 * @returns {{value: string, quote: string}|undefined}
 */
function normalizeQuotedValue(item, prose) {
  if (!item || typeof item !== 'object') return undefined
  const value = typeof item.value === 'string' ? item.value.trim() : ''
  if (!value || value.length > MAX_VALUE) return undefined
  if (!isGroundedQuote(item.quote, prose)) return undefined
  return { value, quote: item.quote }
}

/**
 * 把模型给的原始 lifeHandoff 规范化成**可用的**交接描述。
 *
 * 每一个字段都必须自带能在 `prose` 里逐字找到的引文；**任何一项引文对不上，
 * 就整项丢掉**（而不是保留一个没有依据的值）。全部丢光则返回 undefined——
 * 调用方据此知道「这次没有任何可信的场景转换」。
 *
 * @param {unknown} raw 模型给的 `{ place?, activity?, presence?, transition?, resolvedDetails? }`。
 * @param {string} prose 这次的散文原文（校验依据）。
 * @returns {object|undefined} 规范化后的交接；无可信内容则 undefined。
 */
export function normalizeLifeHandoff(raw, prose) {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw
  const result = {}

  // place / activity：值 + 逐字引文。
  const place = normalizeQuotedValue(value.place, prose)
  if (place) result.place = place
  const activity = normalizeQuotedValue(value.activity, prose)
  if (activity) result.activity = activity

  // presence：**完整名单**，且名单里每个名字都要出现在引文里。
  //
  // 为什么要求「每个名字都在引文里」：否则模型可以给一个漂亮的支持性引文，
  // 却在 names 里塞几个引文根本没提的人——那不叫有依据。
  const presence = value.presence
  if (presence && typeof presence === 'object'
    && Array.isArray(presence.names)
    && isGroundedQuote(presence.quote, prose)
    && presence.names.every(name => typeof name === 'string' && name.trim() && presence.quote.includes(name))) {
    result.presence = {
      // 显式空名单是合法的：那表示「她确实一个人」，且由引文支持。
      names: [...new Set(presence.names.map(name => name.trim()))].slice(0, MAX_NAMES),
      quote: presence.quote,
    }
  }

  // transition：只有引文，表示「明确发生了本地场景转换」。
  if (value.transition && typeof value.transition === 'object' && isGroundedQuote(value.transition.quote, prose)) {
    result.transition = { quote: value.transition.quote }
  }

  // resolvedDetails：某个进行中的细节**完成了**（由引文证明）。
  if (Array.isArray(value.resolvedDetails)) {
    const resolved = value.resolvedDetails
      .filter(item => item && typeof item === 'object'
        && typeof item.label === 'string' && item.label.trim() && item.label.length <= MAX_LABEL
        && isGroundedQuote(item.quote, prose))
      .slice(0, MAX_RESOLVED)
      .map(item => ({ label: item.label.trim(), quote: item.quote }))
    if (resolved.length) result.resolvedDetails = resolved
  }

  return Object.keys(result).length ? result : undefined
}

/**
 * 这个交接是否意味着**本地占用被顶掉**（在场名单要整体重置）。
 *
 * 上游判定：有 `transition`，或 `place` 变了，或**给了** `presence`
 *（哪怕 names 是空的）。注意「没给 presence」不算——那是「这次没说」。
 *
 * @param {object|undefined} handoff 规范化后的交接。
 * @param {string} [currentPlace] 当前场景帧里的位置。
 * @returns {boolean}
 */
export function supersedesLocalOccupancy(handoff, currentPlace = '') {
  if (!handoff) return false
  if (handoff.transition) return true
  if (handoff.place && handoff.place.value !== currentPlace) return true
  if (handoff.presence) return true
  return false
}

/**
 * 把一次交接应用到「在场名单」上，返回新名单。
 *
 * **不被就地修改**：调用方拿到的是一份新数组，便于比较与回滚。
 *
 * @param {Array<object>} current 现有在场记录 `[{ name, status, basis, sourceEntryIds }]`。
 * @param {object|undefined} handoff 规范化后的交接。
 * @param {number} entryId 来源条目 id（每个状态都记它，用于溯源）。
 * @param {object} options
 * @param {string} [options.currentPlace] 当前位置（用于判断是否真的换了地方）。
 * @param {string} [options.now] 更新时间（ISO）。
 * @param {number} [options.limit=8] 保留上限。
 * @returns {Array<object>} 新的在场名单。
 */
export function applyPresence(current, handoff, entryId, { currentPlace = '', now, limit = MAX_NAMES } = {}) {
  const list = Array.isArray(current) ? current : []
  if (!handoff || !supersedesLocalOccupancy(handoff, currentPlace)) return [...list]
  const at = typeof now === 'string' && now ? now : new Date().toISOString()
  const presence = new Map()
  // 先把**原有**的人整体标记为 off-scene。
  //
  // 上游的理由（写得很准）：这是「本地占用被新的原始剧本交接取代」，
  // **不是**「她发现某人离开了」。所以 basis 要如实这么写，
  // 免得下游把它读成「角色观察到对方走了」。
  for (const item of list) {
    if (!item?.name) continue
    presence.set(item.name, {
      ...item,
      status: 'off-scene',
      sourceEntryIds: [entryId],
      updatedAt: at,
      // 措辞刻意**不含「离开」字样**：这句话会被拼进提示词，而「离开」属于
      // 「角色观察到的行为」。这里的事实只是「本地占用被新交接取代」——
      // 把两者混起来，模型会以为她"看见"对方走了。用「递补」这个词，
      // 语义上只说「名单被新的一份顶替了」。
      basis: '本地在场名单被新的原始剧本交接递补；这只表示占用关系变了，不表示观察到任何人的去留。',
    })
  }
  // 再把这次明确在场的人置为 present，依据就是那条引文。
  for (const name of handoff.presence?.names ?? []) {
    presence.set(name, {
      name,
      status: 'present',
      basis: handoff.presence.quote,
      sourceEntryIds: [entryId],
      updatedAt: at,
    })
  }
  return [...presence.values()].slice(-Math.max(1, limit))
}

/**
 * 从交接里取出「场景锚点」引文（用于场景记录）。
 *
 * 上游取 `activity ?? place`——活动比位置更能说明「此刻在做什么」。
 *
 * @param {object|undefined} handoff 规范化后的交接。
 * @param {number} entryId 来源条目 id。
 * @returns {string|undefined}
 */
export function sceneAnchor(handoff, entryId) {
  const anchor = handoff?.activity ?? handoff?.place
  if (!anchor) return undefined
  return `原文 #${entryId}：${anchor.quote}`
}

/**
 * 从交接里取出「这次完成了哪些进行中细节」的标签集合。
 *
 * @param {object|undefined} handoff 规范化后的交接。
 * @returns {Set<string>}
 */
export function resolvedLabels(handoff) {
  return new Set((handoff?.resolvedDetails ?? []).map(item => item.label))
}

/**
 * 供提示词使用的形态说明。模型要按这个结构返回，才可能通过校验。
 *
 * 与上游 narrator.ts 的措辞保持一致（`After writing, optionally return lifeHandoff...`），
 * 但**不照搬**上游那整段 Script-First 的上下文——DSH 走工具调用，只需要字段契约。
 */
export const LIFE_HANDOFF_FRAME = 'LIFE HANDOFF (optional): if this passage changed concrete local facts, report only what changed —— '
  + 'place / activity (each needs "value" plus "quote": the exact words in THIS passage), '
  + 'presence (the COMPLETE local roster with a supporting quote; an explicitly solitary scene is names: [] plus its quote, '
  + 'and omitting presence means "not stated", not "alone"), '
  + 'transition (quote of an explicit local scene shift), '
  + 'resolvedDetails (label + the quote showing that pending detail finished). '
  + 'Quotes are verified verbatim against this passage; anything that cannot be matched word-for-word is discarded. '
  + 'These are pointers into the original, not a second scene summary.'

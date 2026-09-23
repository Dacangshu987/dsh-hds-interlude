/**
 * Urge 弹性推进（移植自上游 hds-interlude `src/urge.ts`，1.0.0-beta8 核心）。
 *
 * ## 它解决什么
 *
 * 自动生活推进原本只有固定间隔（默认 40 分钟）——角色像上了发条：不管刚聊得多
 * 热络还是已经冷了一整天，推进节奏都一样。上游引入 Urge 后，推进节奏开始
 * **跟随真实的消息热度**：刚聊完时下一次推进快一些（对话还热着），冷下来后
 * 逐步变慢，甚至可以由模型显式标 `pace: "slow"`（在睡觉、在专注）来拉长间隔。
 *
 * ## 与上游的差异（DSH 形态）
 *
 * 上游的 `commitUrge` 依赖模型在续写正文里返回一个 `urge:{...}` JSON 字段。
 * DSH 没有结构化输出通道，所以这里：
 *   - 状态机、密度、计划、爆发（burst）全部按上游逐行移植（纯函数）；
 *   - `commitUrge` 的输入由 `lib/index.js` 从自动推进的捕获文本里解析得到
 *     （见 `parseUrgeHandoff`），解析失败时按上游同样规则**不采纳**（旧状态不延续）；
 *   - 模型**不调用**时，纯热度密度（`urgeDensity`）依然让推进节奏随对话热度
 *     自然伸缩——这是把「弹性」落地的最小形态。
 *
 * 刻意不做的事：Urge 只是**调度元数据**（下一次什么时候推进），绝不直接决定
 * 是否联系对方、也不进记忆——联系决策仍由 Agency 窗口与到期待办负责。
 *
 * @module dsh-hds-interlude/urge
 */

const MINUTE = 60_000

/** 常用频率档的默认参数（上游同表：hot/idle/burst/slow 四档 [min,max] 分钟）。 */
const FREQUENCY_DEFAULTS = {
  low: [20, 30, 60, 90, 5, 10, 120, 180],
  medium: [10, 20, 35, 55, 3, 7, 110, 130],
  high: [6, 12, 20, 35, 2, 5, 90, 120],
}

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const finite = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(min, Math.min(max, value))
  : fallback

/**
 * 把原始配置规整成解析后的 Urge 配置。
 *
 * @param {object} [raw] 配置（`cfg.urge`）。
 * @returns {object} 解析后的配置。
 */
export function resolveUrgeConfig(raw) {
  const c = record(raw)
  const a = record(c.advanced)
  const frequency = ['low', 'medium', 'high', 'custom'].includes(String(c.frequency)) ? String(c.frequency) : 'medium'
  const defaults = FREQUENCY_DEFAULTS[frequency] ?? FREQUENCY_DEFAULTS.medium
  const range = (name, i) => {
    const lo = finite(a[name + 'Min'], defaults[i], 1, 1440)
    return [lo, Math.max(lo, finite(a[name + 'Max'], defaults[i + 1], 1, 1440))]
  }
  return {
    enabled: c.enabled === true,
    frequency,
    willingness: finite(c.proactiveWillingnessThreshold, 0.4, 0, 1),
    hot: range('hot', 0),
    idle: range('idle', 2),
    burst: range('burst', 4),
    slow: range('slow', 6),
    halfLife: finite(a.halfLifeMinutes, 45, 5, 240),
    threshold: finite(a.burstThreshold, 0.75, 0, 1),
    jitter: finite(a.jitter, 0.15, 0, 1),
    extremeChance: finite(a.extremeChance, 0.03, 0, 1),
    ttl: finite(a.burstTtlMinutes, 35, 5, 120),
    budget: Math.floor(finite(a.burstBudget, 3, 0, 10)),
    contactMin: finite(a.burstContactMinMinutes, 5, 1, 60),
  }
}

/**
 * 新建/规范化一份 Urge 状态。
 *
 * 任何非法输入都降级为「无记录」的空状态，绝不抛错（持久化数据不该打断回合）。
 *
 * @param {unknown} raw 盘上的值。
 * @param {number} now 当前毫秒时间戳。
 * @returns {object} 规范化后的 Urge 状态。
 */
export function normalizeUrgeState(raw, now) {
  const r = record(raw)
  if (r.version !== 1) return { version: 1, buckets: [] }
  const a = record(r.armed)
  const b = record(r.burst)
  const timestamp = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now
  return {
    version: 1,
    mode: typeof r.mode === 'string' ? r.mode : undefined,
    buckets: Array.isArray(r.buckets)
      ? [...new Set(r.buckets.filter((v) => timestamp(v) && now - v < 240 * MINUTE))].sort((x, y) => x - y).slice(-120)
      : [],
    value: typeof r.value === 'number' ? finite(r.value, 0, 0, 1) : undefined,
    pace: r.pace === 'slow' ? 'slow' : 'normal',
    suggested: typeof r.suggested === 'number' ? finite(r.suggested, 120, 1, 1440) : undefined,
    sourceEntryId: typeof r.sourceEntryId === 'number' ? r.sourceEntryId : undefined,
    spent: r.spent === true,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 160) : undefined,
    armed: typeof a.participantId === 'string' && typeof a.entryId === 'number' && timestamp(a.at) && now - Number(a.at) < 10 * MINUTE
      ? { participantId: a.participantId, entryId: a.entryId, at: Number(a.at) }
      : undefined,
    burst: typeof b.participantId === 'string' && timestamp(b.started)
      ? { participantId: b.participantId, started: Number(b.started), used: Math.floor(finite(b.used, 0, 0, 10)) }
      : undefined,
  }
}

/**
 * 记一次真实入站事件（只有真实收到消息才调用；打字碎片用 2 分钟桶合并）。
 *
 * @param {object} state Urge 状态。
 * @param {number} now 当前毫秒时间戳。
 * @returns {object} 新状态。
 */
export function urgeUserEvent(state, now) {
  const bucket = Math.floor(now / (2 * MINUTE)) * 2 * MINUTE
  return {
    ...state,
    buckets: [...new Set([...(state.buckets ?? []), bucket])].slice(-120),
    pace: 'normal',
    suggested: undefined,
    armed: undefined,
    burst: undefined,
    spent: false,
  }
}

/**
 * 当前热度密度（0–1）——「最近聊得多密」的衰减指标。
 *
 * @param {object} state Urge 状态。
 * @param {number} now 当前毫秒时间戳。
 * @param {object} c 解析后的配置。
 * @returns {number} 0–1。
 */
export function urgeDensity(state, now, c) {
  const last = (state.buckets ?? []).at(-1)
  if (last === undefined) return 0
  const recent = (state.buckets ?? []).filter((t) => t >= last - 15 * MINUTE).length
  return Math.min(1, recent / 6) * Math.pow(0.5, Math.max(0, now - last) / (c.halfLife * MINUTE))
}

/**
 * 采纳模型的一次 Urge 交接。
 *
 * **不采纳的输入**（与上游一致）：引用缺失/不在正文里、value 缺失或非法——
 * 此时返回「清掉旧慢速/爆发」的干净状态，绝不延续旧的慢速相位。
 *
 * @param {object} state Urge 状态。
 * @param {unknown} raw 模型交接（`urge:{...}`）。
 * @param {string} script 本轮正文（用于逐字校验 basisQuote）。
 * @param {number} entryId 本轮条目 id。
 * @param {string|undefined} target 可联系的目标（有绑定时的 participantId）。
 * @param {number} now 当前毫秒时间戳。
 * @param {object} c 解析后的配置。
 * @param {Function} [random] 随机源（测试注入）。
 * @returns {object} 新状态。
 */
export function commitUrge(state, raw, script, entryId, target, now, c, random = Math.random) {
  const r = record(raw)
  const quote = typeof r.basisQuote === 'string' ? r.basisQuote.trim() : ''
  if (!quote || !String(script ?? '').includes(quote) || typeof r.value !== 'number' || !Number.isFinite(r.value)) {
    return { ...state, pace: 'normal', suggested: undefined, armed: undefined, burst: undefined }
  }
  const value = random() < c.extremeChance ? random() : finite(r.value + (random() * 2 - 1) * c.jitter, 0, 0, 1)
  const pace = r.pace === 'slow' ? 'slow' : 'normal'
  const high = value >= c.threshold && pace !== 'slow'
  return {
    ...state,
    value,
    pace,
    sourceEntryId: entryId,
    suggested: typeof r.suggestedDelayMinutes === 'number' ? finite(r.suggestedDelayMinutes, 120, 1, 1440) : undefined,
    burst: high ? state.burst : undefined,
    armed: high && target && !state.spent && !state.burst && c.budget > 0
      ? { participantId: target, entryId, at: now }
      : undefined,
  }
}

/**
 * 确认一次「已建立联系的爆发」：只有命中 armed 才消耗它。
 *
 * @param {object} state Urge 状态。
 * @param {string} participantId 联系目标。
 * @param {number} entryId 触发条目 id。
 * @param {number} now 当前毫秒时间戳。
 * @returns {object} 新状态。
 */
export function acknowledgeUrge(state, participantId, entryId, now) {
  if (!state.armed || state.armed.participantId !== participantId || state.armed.entryId !== entryId || state.spent) return state
  return { ...state, armed: undefined, spent: true, burst: { participantId, started: now, used: 0 } }
}

/**
 * 当前是否处于「已确认联系的爆发期」（TTL 内、预算未用尽、非慢速）。
 *
 * @param {object} state Urge 状态。
 * @param {number} now 当前毫秒时间戳。
 * @param {object} c 解析后的配置。
 * @param {string} [participantId] 限定目标。
 * @returns {boolean}
 */
export function urgeBurstActive(state, now, c, participantId) {
  return Boolean(state.burst)
    && (!participantId || participantId === state.burst.participantId)
    && now - state.burst.started < c.ttl * MINUTE
    && state.burst.used <= c.budget
    && state.pace !== 'slow'
}

/**
 * 计划下一次自动推进的时机（核心调度函数）。
 *
 * 分支逻辑与上游一致：
 *   1. 休息窗口 / 慢速脚本 → 用 slow 档（或模型建议值微调）；
 *   2. 已确认联系的爆发期内 → 用 burst 档，预算指数倍增（每次爆发联系后越等越久）；
 *   3. 普通 → 用 idle 档减去热度密度折算（聊得热就快，冷了就慢）。
 *
 * @param {object} state Urge 状态。
 * @param {number} now 当前毫秒时间戳。
 * @param {object} c 解析后的配置。
 * @param {number} [restMinutes=0] 剩余休息分钟数。
 * @param {boolean} [unavailable=false] 当前是否不可联系（隐私/设备）。
 * @param {Function} [random] 随机源。
 * @returns {{state: object, nextAdvanceAt: string, minutes: number, reason: string}}
 */
export function planUrge(state, now, c, restMinutes = 0, unavailable = false, random = Math.random) {
  const sample = (range) => range[0] + random() * (range[1] - range[0])
  let next = { ...state }
  let minutes
  let reason
  if (restMinutes > 0 || state.pace === 'slow') {
    const suggested = state.suggested === undefined
      ? sample(c.slow)
      : Math.max(c.slow[0], Math.min(c.slow[1], state.suggested * (0.9 + random() * 0.2)))
    minutes = Math.max(restMinutes, suggested)
    reason = restMinutes ? 'rest-window' : 'script-slow'
    next = { ...next, burst: undefined, armed: undefined }
  } else if (!unavailable && urgeBurstActive(state, now, c) && state.burst.used < c.budget) {
    minutes = sample(c.burst) * Math.pow(2, state.burst.used)
    minutes = Math.min(minutes, Math.max(1, (state.burst.started + c.ttl * MINUTE - now) / MINUTE))
    reason = 'confirmed-contact-burst'
    next.burst = { ...state.burst, used: state.burst.used + 1 }
  } else {
    const idle = sample(c.idle)
    const hot = Math.min(idle, sample(c.hot))
    minutes = idle - urgeDensity(state, now, c) * (idle - hot)
    reason = 'conversation-density-decay'
    next.burst = undefined
    if (unavailable) next.armed = undefined
  }
  next.reason = reason
  return { state: next, nextAdvanceAt: new Date(now + minutes * MINUTE).toISOString(), minutes, reason }
}

/**
 * 提示词指令（追加到推进/跟进/到期回合，请求模型输出调度交接）。
 *
 * @param {boolean} enabled 是否启用 Urge。
 * @param {string} phase 叙事阶段。
 * @returns {string} 指令文本；不启用或不适用阶段时为空串。
 */
export function urgeInstruction(enabled, phase) {
  return enabled && ['advance', 'conversation-follow-up', 'intent-due'].includes(phase)
    ? '\n可选：在正文末尾另起一行输出 `urge:{value:0..1, pace:"normal"|"slow", suggestedDelayMinutes:number, basisQuote:"本段原文里的一句原话"}`，'
      + '反映主角当下的推动力与自然的下一步生活节奏；slow 适合睡眠或持续专注。'
      + '这只是调度交接，不是台词、不是未来事件、也不是第二次联系决策。'
    : ''
}

/**
 * 从捕获文本里提取模型输出的 `urge:{...}` JSON 交接。
 *
 * DSH 形态：模型在正文末尾写一行 JSON。这里做**宽容提取**：
 *   - 支持 `urge:{...}` 与纯 `{...}`（后者必须整行都是 JSON，避免误抓正文）；
 *   - 解析失败返回 undefined（调用方按「未交接」处理，不进 commitUrge）。
 *
 * @param {string} text 捕获到的模型正文。
 * @returns {object|undefined} 交接对象。
 */
export function parseUrgeHandoff(text) {
  const source = String(text ?? '')
  if (!source) return undefined
  const match = /(?:^|[\n\s])urge\s*:\s*(\{[\s\S]*?\})\s*(?:$|[\n}])/i.exec(source)
  const candidate = match?.[1]
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 落到纯 JSON 行尝试
    }
  }
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && ('value' in parsed || 'pace' in parsed)) return parsed
    } catch {
      // 不是 JSON 行，继续
    }
  }
  return undefined
}

/**
 * 把 urge 交接行从捕获文本里**剥离**，返回纯正文。
 *
 * 为什么必须有这一步：`commitUrge` 用 `script.includes(basisQuote)` 做**逐字校验**，
 * 而 urge 行本身就在正文里——JSON 里写着的 `basisQuote:"这句话"` 会让
 * `includes` 恒为 true（自引用），校验形同虚设。剥离后正文里只剩真正的故事，
 * 「模型把引文抄进 JSON 却没在正文里说过」就能被正确拒绝。
 *
 * @param {string} text 捕获到的模型正文。
 * @returns {string} 剥离 urge 行后的正文。
 */
export function stripUrgeHandoff(text) {
  const source = String(text ?? '')
  // `urge:{...}` 形态（行首/换行后，尽量非贪婪到最近的收尾）
  const withMarker = source.replace(/(?:^|[\n\s])urge\s*:\s*\{[\s\S]*?\}\s*(?:$|[\n}])/gi, (match) => {
    // 保留原本的行结构：整行被替换为空串，避免留下多余空行语义
    return match.startsWith('\n') ? '\n' : ''
  })
  // 纯 JSON 整行形态
  const lines = withMarker.split('\n')
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return true
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && ('value' in parsed || 'pace' in parsed)) return false
    } catch {
      // 不是 JSON 行，保留
    }
    return true
  })
  return kept.join('\n').trim()
}

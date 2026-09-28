/**
 * 世界事件播种器（World Event Seeder）—— 移植自上游 `1.0.1-rc23` 的
 * `src/world-seeder.ts`（189 行）与设计文档 `docs/WORLD_EVENT_SEEDER_DESIGN.md`。
 *
 * ## 它解决什么
 *
 * 主叙事提示词受「不得虚构外部事件」教条约束——所以**她的世界自己不会动**：
 * 没有用户输入时，生活只剩她自己的动作。seeder 是一个与压缩器/时间导演同级的
 * 后台侧模型：周期性以**低概率**生成与她有关的外部事件，由模型给出发生时间，
 * 宿主到点以 `[世界事件] ` 条目注入剧本。
 *
 * 核心机制洞察：**事件一旦进入 supplied context，主模型就获得了书写它的合法性**。
 * seeder 是「持证的外部事件源」——它生成的事实由宿主落账后，主模型书写这些事件
 * 不再违反不得虚构教条。
 *
 * ## 核心语义：事实权威，反应自由
 *
 * - **事实权威**：条目描述「发生了什么」，是既成现实，主模型不得改写或无视；
 * - **反应自由**：她如何感知、是否在意、如何应对，完全是主作者领地。
 * - 与管理员注记**同管线、不同语义**：注记是 directive，世界事件只是 fact
 *   （无任何义务、可被后续事实自然冲淡）。
 *
 * ## 边界（与上游一致）
 *
 * | 系统 | seeder 的边界 |
 * |---|---|
 * | 时间导演 | 导演管**她自己的行动**；seeder 只写**世界对她做了什么** |
 * | Urge / Agency | 永不直接生成「她想联系谁」；只生成可能构成动机的生活事实 |
 * | Schedule Preplan | 拿它当**约束**（事件须落在日程缝隙），不当内容来源 |
 * | dueIntents | 事件是**外部新事实**，不是既有意图的兑现 |
 *
 * ## 安全栏
 *
 * **注册参与者严格拉黑**（他们背后是真实的人）；只允许线下通道与 NPC；
 * 绝不生成任何聊天消息、平台通知或线上会话内容。
 *
 * ## DSH 侧适配（唯一差别，已在文档记录）
 *
 * 上游在**模型中心的连接行**勾选「用于世界播种」来选模型，请求走
 * `narrator.customSideTask`。DSH 的模型路由由宿主统一管理、且本仓没有独立侧端
 * 模型通道，因此这里把「执行器」做成**可注入**的（与 `lib/side-task.js` 同一模式）：
 * `createWorldSeeder(runtime, { execute })`。`assigned` 为假（没有执行器）时
 * 功能自动关闭——与上游「未勾选连接即关闭」语义一致。
 *
 * @module dsh-hds-interlude/world-seeder
 */

/* ─────────────────────────────────────────────────────────── 类型与运行配置 */

/** 事件重要性三档。low 必须是绝大多数；high 罕见。 */
export const SEED_IMPORTANCE = ['low', 'medium', 'high']

/** 默认运行参数（数值逐字对齐上游）。 */
export const DEFAULT_WORLD_SEEDER_RUNTIME = {
  enabled: false,
  cadenceMinutes: 45,
  maxPending: 4,
  dailyCap: 4,
  maxHorizonHours: 72,
  temperature: 0.9,
  maxTokens: 1000,
  timeout: 60000,
}

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/**
 * 规整运行配置（对齐上游 `resolveWorldSeederRuntime`）。
 *
 * @param {unknown} value `cfg.worldSeeder`。
 * @param {unknown} assigned 是否已指定模型/执行器（上游为 provider；本仓为执行器）。
 * @returns {object} 规整后的运行参数（`enabled` 需要 `assigned` 为真）。
 */
export function resolveWorldSeederRuntime(value, assigned) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const ok = Boolean(assigned) && assigned?.enabled !== false
  return {
    ...DEFAULT_WORLD_SEEDER_RUNTIME,
    enabled: record.enabled === true && ok,
    assigned: ok,
    cadenceMinutes: clampInt(record.cadenceMinutes, 5, 1440, DEFAULT_WORLD_SEEDER_RUNTIME.cadenceMinutes),
    maxPending: clampInt(record.maxPending, 1, 20, DEFAULT_WORLD_SEEDER_RUNTIME.maxPending),
    dailyCap: clampInt(record.dailyCap, 1, 20, DEFAULT_WORLD_SEEDER_RUNTIME.dailyCap),
    maxHorizonHours: clampInt(record.maxHorizonHours, 1, 336, DEFAULT_WORLD_SEEDER_RUNTIME.maxHorizonHours),
    temperature: Math.max(0, Math.min(2, Number(record.temperature) || DEFAULT_WORLD_SEEDER_RUNTIME.temperature)),
    maxTokens: clampInt(record.maxTokens, 256, 8192, DEFAULT_WORLD_SEEDER_RUNTIME.maxTokens),
    timeout: clampInt(record.timeout, 5000, 300000, DEFAULT_WORLD_SEEDER_RUNTIME.timeout),
  }
}

/* ─────────────────────────────────────────────────────────────────── 提示词 */

/**
 * 侧模型系统提示词（**逐字对齐上游**，含中文输出要求）。
 *
 * 关键行：`MOST RUNS MUST RETURN an empty events array.`——稀疏才是真实感。
 */
export function worldSeederSystemPrompt() {
  return [
    'You are the world seeder for HDS Interlude. Your only job is to occasionally originate small external events in the protagonist’s world.',
    'You will receive: current local time and season, the story’s world setting, current scene and arc summaries, a bounded excerpt of her recent established life, her in-flight working details, her relationship network listed as BLOCKED NAMES, and recently seeded events to avoid repeating.',
    'Rules:',
    '- External facts only: things that happen TO her world — environment, neighborhood, offline social world, NPCs she knows, minor mishaps, small opportunities. Never her own decisions, feelings or actions.',
    '- Offline channels only: phone calls, in-person encounters, notices, deliveries, weather, public events. Never any chat message, platform notification or online conversation content.',
    '- NEVER generate events about BLOCKED NAMES or the user. Family, classmates, shopkeepers and strangers who exist only in her offline life are fine.',
    '- Fit the environment: season, weather, the canon setting’s texture (city or village, era, neighborhood), and her daily circumstances.',
    '- Fit her established life: events must be plausible next to the recent script, her working details and the current arc; never contradict what has already happened.',
    '- Place events at concrete future times within the allowed horizon, expressed in the story timezone. Ordinary gaps in her day are the best slots.',
    '- Importance: low = texture she may barely notice; medium = a small practical change; high = relationship-relevant or disruptive. Low must be most of your output; high is rare.',
    'Real life is mostly uneventful. MOST RUNS MUST RETURN an empty events array. Output at most 2 events.',
    'Output one JSON object only: {"events":[{"summary":"one concrete Chinese sentence stating what happened","importance":"low|medium|high","occursAt":"ISO-8601 with offset","expiresAt":"optional ISO-8601","subjects":["names of offline people involved, empty when none"],"rationale":"short reason this fits now"}]}',
  ].join('\n')
}

/* ───────────────────────────────────────────── 解析与校验闸（纯函数，可测） */

/** 去掉标点/符号/空白后取 bigram 集合。 */
function bigrams(text) {
  const normalized = String(text ?? '').replace(/[\p{P}\p{S}\s]+/gu, '')
  const grams = new Set()
  for (let i = 0; i < normalized.length - 1; i += 1) grams.add(normalized.slice(i, i + 2))
  return grams
}

/** 两条事件摘要的 bigram Jaccard 相似度（去重闸用，阈值 0.6）。 */
export function summaryJaccard(left, right) {
  const a = bigrams(left); const b = bigrams(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** 某时刻在故事时区的**小时**（0–23）；时区非法时退回 UTC。 */
function localHourIn(date, timezone) {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(date))
    return Number.isFinite(hour) ? hour : date.getUTCHours()
  } catch {
    return date.getUTCHours()
  }
}

/**
 * 单事件校验闸——**宁可错杀**：任何一项不过即弃，不重试（生成是廉价的）。
 *
 * 上游六道闸里，本函数负责其中四道（另两道是 service 层的 Preplan 冲突与频控）：
 *   ① `invalid-time`：`occursAt ∈ (now, now + maxHorizonHours]`；
 *   ② `blocked-name`：subjects 或 summary 命中拉黑名单（注册参与者背后是真人）；
 *   ③ `night-high`：high 事件落在故事时区深夜 0:00–6:00；
 *   ④ `duplicate`：与近 14 天已注入事件摘要 bigram Jaccard > 0.6。
 *
 * @param {{summary:string,importance:string,occursAt:Date,subjects:string[]}} draft 候选事件。
 * @param {{now:Date,timezone:string,maxHorizonHours:number,blockedNames:string[],recentSummaries:string[]}} input 校验输入。
 * @returns {string|undefined} 拒绝原因；通过返回 undefined。
 */
export function validateSeedEvent(draft, input) {
  if (!draft?.summary || !String(draft.summary).trim() || String(draft.summary).length > 200) return 'empty-summary'
  if (!SEED_IMPORTANCE.includes(draft.importance)) return 'invalid-importance'
  const time = draft.occursAt instanceof Date ? draft.occursAt.getTime() : Number.NaN
  if (!Number.isFinite(time) || time <= input.now.getTime()
    || time > input.now.getTime() + input.maxHorizonHours * 3600000) return 'invalid-time'
  for (const name of input.blockedNames ?? []) {
    const trimmed = String(name ?? '').trim()
    if (trimmed.length >= 2 && (String(draft.summary).includes(trimmed)
      || (draft.subjects ?? []).some((subject) => String(subject).includes(trimmed) || trimmed.includes(String(subject).trim())))) {
      return 'blocked-name'
    }
  }
  if (draft.importance === 'high') {
    const hour = localHourIn(draft.occursAt, input.timezone)
    if (hour >= 0 && hour < 6) return 'night-high'
  }
  for (const recent of input.recentSummaries ?? []) {
    if (summaryJaccard(draft.summary, recent) > 0.6) return 'duplicate'
  }
  return undefined
}

/**
 * 防御解析模型输出：字段裁剪、时间解析、subjects/rationale 归一；**坏项丢弃**。
 *
 * @param {unknown} value 模型返回的 JSON 对象（`{events:[...]}`）。
 * @param {number} [limit] 最多采纳几条（上游 2）。
 * @returns {Array<object>} 候选事件（尚未校验）。
 */
export function parseWorldSeedEvents(value, limit = 2) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const rawEvents = Array.isArray(record.events) ? record.events : []
  const drafts = []
  for (const raw of rawEvents.slice(0, limit)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 200) : ''
    const importance = raw.importance
    if (!summary || !SEED_IMPORTANCE.includes(importance)) continue
    const occursAt = new Date(String(raw.occursAt ?? ''))
    if (Number.isNaN(occursAt.getTime())) continue
    const expiresRaw = typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : undefined
    const expiresAt = expiresRaw && !Number.isNaN(expiresRaw.getTime()) && expiresRaw > occursAt ? expiresRaw : undefined
    const subjects = Array.isArray(raw.subjects)
      ? raw.subjects.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 40)).filter(Boolean).slice(0, 4)
      : []
    drafts.push({
      summary,
      importance,
      occursAt,
      subjects,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 200) : '',
      ...(expiresAt ? { expiresAt } : {}),
    })
  }
  return drafts
}

/* ─────────────────────────────────────────────── 事件表（M1 注入侧，纯函数） */

/** 事件状态机（对齐上游 `interlude_seeded_event.status`）。 */
export const SEED_STATUS = ['scheduled', 'injected', 'expired', 'dropped']

/** 事件表默认保留条数（JSON 版，防止状态文件膨胀）。 */
export const SEEDED_EVENT_LIMIT = 60

/** 注入条目的正文前缀（上游 `[世界事件] `）。 */
export const WORLD_EVENT_PREFIX = '[世界事件] '

/**
 * 注入条目的 kind —— **`world-event`**（上游 `drainDueSeededEvents` 实际写入值）。
 *
 * 设计文档 §5 曾把 `system-event` 列为「复用现有 kind」的备选，但上游实现最终
 * 采用 `kind: 'world-event', actor: 'system'`（见 `src/service.ts` 的
 * `drainDueSeededEvents`）；`system-event` 只是 `recentScriptOwnership`
 * 为「非对话类条目」推导出的 ownership 标签。此处与实现对齐。
 */
export const WORLD_EVENT_KIND = 'world-event'

/** 注入条目的 actor（上游固定 `'system'`）。 */
export const WORLD_EVENT_ACTOR = 'system'

const safeInt = (value) => (Number.isSafeInteger(value) ? value : undefined)
const isoOrNull = (value) => (typeof value === 'string' && value ? value : null)

/**
 * 单条播种事件的规范化（防御读取：坏项丢弃）。
 *
 * 字段对齐上游表结构：`{id, summary, importance, occursAt, expiresAt, status,
 * wakeEligible, subjects, sourcePayload, injectedEntryId, createdAt, updatedAt}`。
 * 本仓为 JSON 存储，故时间一律用 ISO 字符串。
 *
 * @param {unknown} value 候选记录。
 * @returns {object|undefined}
 */
export function normalizeSeededEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = safeInt(value.id)
  if (id === undefined || id < 1) return undefined
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 200) : ''
  if (!summary) return undefined
  const occursAt = isoOrNull(value.occursAt)
  if (!occursAt || !Number.isFinite(Date.parse(occursAt))) return undefined
  return {
    id,
    summary,
    importance: SEED_IMPORTANCE.includes(value.importance) ? value.importance : 'low',
    occursAt,
    expiresAt: isoOrNull(value.expiresAt),
    status: SEED_STATUS.includes(value.status) ? value.status : 'scheduled',
    wakeEligible: value.wakeEligible === true,
    subjects: Array.isArray(value.subjects)
      ? value.subjects.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)).slice(0, 4) : [],
    sourcePayload: value.sourcePayload && typeof value.sourcePayload === 'object' ? value.sourcePayload : null,
    injectedEntryId: safeInt(value.injectedEntryId) ?? null,
    injectedAt: isoOrNull(value.injectedAt),
    announcedAt: isoOrNull(value.announcedAt),
    createdAt: isoOrNull(value.createdAt) ?? occursAt,
    updatedAt: isoOrNull(value.updatedAt) ?? new Date().toISOString(),
  }
}

/**
 * 规整整张事件表：坏项丢弃、按 id 去重、按容量裁剪（保留最新）。
 *
 * @param {unknown} value 事件表。
 * @param {number} [limit] 保留条数上限。
 * @returns {{nextId: number, events: Array<object>}}
 */
export function normalizeSeededEvents(value, limit = SEEDED_EVENT_LIMIT) {
  const raw = Array.isArray(value) ? value : []
  let maxId = 0
  const seen = new Set()
  const kept = []
  for (const item of raw) {
    const event = normalizeSeededEvent(item)
    if (!event || seen.has(event.id)) continue
    seen.add(event.id)
    maxId = Math.max(maxId, event.id)
    kept.push(event)
  }
  kept.sort((a, b) => a.id - b.id)
  const events = kept.slice(-Math.max(1, limit))
  return { nextId: Math.max(1, maxId + 1), events }
}

/**
 * 到期事件 → 该注入的列表（**纯函数**，不改状态）。
 *
 * 上游语义：`occursAt <= now` 且仍 `scheduled` 的事件按时间顺序注入；
 * 已过 `expiresAt` 的作废（`expired`）——过期未注入即不再补发。
 *
 * @param {Array<object>} events 事件表。
 * @param {number} now 当前毫秒时间戳。
 * @returns {{due: Array<object>, expired: Array<object>}}
 */
export function planSeedDrain(events, now) {
  const due = []
  const expired = []
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.status !== 'scheduled') continue
    const occurs = Date.parse(event.occursAt)
    if (!Number.isFinite(occurs)) continue
    const expires = event.expiresAt ? Date.parse(event.expiresAt) : NaN
    if (Number.isFinite(expires) && expires <= now && occurs <= now) {
      // 到点却没注入、且已过期 → 作废（保留审计痕迹，与上游一致）。
      expired.push(event)
      continue
    }
    if (occurs <= now) due.push(event)
  }
  due.sort((a, b) => Date.parse(a.occursAt) - Date.parse(b.occursAt))
  return { due, expired }
}

/**
 * 注入条目的正文（`[世界事件] ` + summary）——上游注入条目形态。
 *
 * @param {{summary: string}} event 事件。
 * @returns {string}
 */
export function worldEventContent(event) {
  return `${WORLD_EVENT_PREFIX}${String(event?.summary ?? '').trim()}`
}

/* ──────────────────────────────────────────────────────────── 生成侧客户端 */

/**
 * 播种器客户端。
 *
 * DSH 适配：上游 `createWorldSeeder(ctx, modelConfig, runtime, onUsage)` 直接构造
 * OpenAI 兼容客户端并复用 `narrator.customSideTask`；本仓无侧端模型通道，改为
 * **注入执行器**——与 `lib/side-task.js` 同一模式。未注入执行器时 `available=false`，
 * 整条生成回路自动关闭（等价的「未勾选连接即关闭」）。
 *
 * @param {object} runtime `resolveWorldSeederRuntime` 的结果。
 * @param {{execute?: Function, onUsage?: Function}} [deps] 执行器与用量回调。
 * @returns {{available: boolean, generate: (userPayload: string) => Promise<unknown>}}
 */
export function createWorldSeeder(runtime, { execute, onUsage } = {}) {
  if (!runtime?.enabled || typeof execute !== 'function') {
    return { available: false, generate: async () => { throw new Error('世界播种器未配置执行器。') } }
  }
  return {
    available: true,
    generate: (userPayload) => execute({
      task: '世界播种',
      system: worldSeederSystemPrompt(),
      user: userPayload,
      temperature: runtime.temperature,
      maxTokens: runtime.maxTokens,
      timeout: runtime.timeout,
      onUsage,
    }),
  }
}

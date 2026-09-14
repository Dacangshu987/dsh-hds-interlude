/**
 * 幕间状态 —— DSH 侧对 hds-interlude 13 张数据表的等价物。
 *
 * 设计取舍（如实记录，见 MIGRATION.md）：
 * - 原项目用 Koishi `ctx.database`（SQLite）存 13 张表；
 *   DSH 无 `ctx.database`，这里退化为「每会话一个 JSON 文档」落在 `$DSH_HOME/hds-interlude/<sessionId>.json`。
 *   一个 DSH agent = 一个 session = 一个主剧本，因此单文档足以承载 Canon/facts/overlay/intents/agency/alter/preplan。
 * - 互动时序（谁在什么时候说过话）不落盘，直接从 session 日志增量折叠 —— 对齐 DSH 的
 *   「model-visible means logged」不变式，也避免了「用户消息时间」与「已注入快照」的重复计数。
 * - 读取失败一律降级为空状态，绝不让持久化问题打断一个回合。
 *
 * @module dsh-hds-interlude/state
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAlterSystemState, normalizeAlterSystemState } from './alter.js'

/** 插件在日志 source 里的署名，用于把自己的注入排除在「用户说话」之外。 */
export const PLUGIN_NAME = 'hds-interlude'

const STATE_VERSION = 1
const MAX_INTENTS = 40
const MAX_FACTS = 200

/** 幕间数据目录：`$DSH_HOME/hds-interlude`（默认 `~/.dsh/hds-interlude`）。 */
export function interludeHome() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'hds-interlude')
}

/** 会话 id 可能含路径分隔符，落盘前做一次白名单化。 */
function safeFileName(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default'
}

/** 会话标识；取不到返回 undefined（宁可无幕间，也不跨会话串状态）。 */
export function sessionKeyOf(agent) {
  const session = agent?.session
  const id = session?.id ?? session?.header?.id ?? session?.sessionId
  if (id === undefined || id === null || String(id).trim() === '') return undefined
  return String(id)
}

/** 全新状态。 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    /** 归属的会话 id；落盘时由 saveState 盖章，用于「冷会话」扫描反查。 */
    sessionId: null,
    lastSeenSeq: 0,
    turns: 0,
    lastUserAt: null,
    previousUserAt: null,
    lastAssistantAt: null,
    lastInjectedAt: null,
    /** Canonical Story（首次使用时从 config.story 拷贝）。 */
    story: null,
    /** 低频连续性快照（由模型经工具维护）。 */
    continuity: '',
    continuityUpdatedAt: null,
    /** 长期事实。 */
    facts: [],
    /** 非破坏性设定演化（character/perspective/relationship/world）。 */
    overlay: [],
    /** 意图：延迟回复 / 提醒 / 主动联系 / 承诺回访 / 跟进。 */
    intents: [],
    seq: 0,
    /** 主体行动窗口 + 主动联系候选（Agency Window）。 */
    agencyWindow: null,
    proactiveDrafts: [],
    proactiveFingerprints: [],
    /** 是否被标记为「角色会话」（/interlude on）。roleplayOnly 开启时仅此类会话生效。 */
    roleplay: false,
    /** 是否已注入人设/规则段（pre-step 首次角色回合注入一次，持久于会话日志）。 */
    canonInjected: false,
    reachedOut: 0,
    reachedOutDay: '',
    lastAutoAdvanceAt: null,
    /**
     * 上一次「自动发消息」的时刻。
     *
     * 与 lastAutoAdvanceAt（上一次**写故事**）分开记：写故事与发消息现在是两个
     * 独立节奏（写故事默认 40 分钟，发消息默认 120 分钟）。合成一个字段的话，
     * 每写一次故事就会把发消息间隔一起重置——间隔永远走不到头。
     *
     * 注意：到点的提醒 / 承诺回访**不**更新这个字段，它们是角色答应过的事，
     * 不该被「刚自动发过一条」挡住。
     */
    lastAutoMessageAt: null,
    /** 情绪偏移追踪（Alter System）。 */
    alter: createAlterSystemState(),
    /** 近期日程（Schedule Preplan）。 */
    preplan: null,
  }
}

/** 读取状态；任何异常降级为空状态，并用 Alter 规范化器修复字段。 */
export function loadState(key) {
  try {
    const file = path.join(interludeHome(), `${safeFileName(key)}.json`)
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== STATE_VERSION) return emptyState()
    const base = emptyState()
    return {
      ...base,
      ...parsed,
      alter: normalizeAlterSystemState(parsed.alter) ?? base.alter,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      overlay: Array.isArray(parsed.overlay) ? parsed.overlay : [],
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      proactiveDrafts: Array.isArray(parsed.proactiveDrafts) ? parsed.proactiveDrafts : [],
      proactiveFingerprints: Array.isArray(parsed.proactiveFingerprints) ? parsed.proactiveFingerprints : [],
    }
  } catch {
    return emptyState()
  }
}

/** 原子落盘；失败静默（意图丢失不应打断对话）。 */
export function saveState(key, state) {
  try {
    const dir = interludeHome()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safeFileName(key)}.json`)
    const tmp = `${file}.tmp`
    // 落盘时回填归属会话：后台扫描要在没人说话的冷会话上也能知道这份状态是谁的。
    if (state && typeof state === 'object') state.sessionId = String(key)
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 持久化是尽力而为的 */
  }
}

/**
 * 列出磁盘上所有会话状态（含冷会话）。
 *
 * 为什么需要：后台扫描原先只遍历 `liveAgents`——而「用户没在说话」恰恰意味着
 * 那个会话没有实时 agent，于是「到点主动开口」永远轮不到它。扫描必须能看见
 * 落盘的状态文件，才能在需要时把它唤醒。
 *
 * 会话 id 优先取状态里盖的章；**旧文件没有章**（本次改动之前写的），此时回退到
 * 文件名——`safeFileName` 只对 `[A-Za-z0-9._-]` 之外的字白名单化，而 DSH 的会话 id
 * 形如 `session-<uuid>`，完全落在这个字符集内，所以文件名就等于会话 id。
 * 回退路径是必须的：否则升级后的第一次扫描看不见任何历史会话，
 * 「到点提醒」要等用户下次主动说话才活过来——而那正是我们要修的场景。
 *
 * 两条路径都拿不到就跳过：宁可不开口，也不猜错人。
 *
 * @returns {Array<{key: string, state: object}>}
 */
export function listStoredStates() {
  const out = []
  let files = []
  try {
    files = fs.readdirSync(interludeHome())
  } catch {
    return out
  }
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(interludeHome(), file), 'utf8'))
      if (!parsed || parsed.version !== STATE_VERSION) continue
      const stamped = typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null
      // 文件名回退：只接受形状像会话 id 的（避免把 `default` 之类的兜底名当成会话）。
      const stem = file.slice(0, -'.json'.length)
      const fromFile = /^session-[A-Za-z0-9._-]+$/.test(stem) ? stem : null
      const key = stamped ?? fromFile
      if (!key) continue
      if (!stamped) parsed.sessionId = key
      out.push({ key, state: parsed })
    } catch {
      /* 单份状态坏掉不该拖垮扫描 */
    }
  }
  return out
}

/** 折叠一条已提交的会话事件进状态。 */
export function applyEvent(state, event) {
  const type = event?.type
  const time = Number(event?.time)
  if (type === 'user/message') {
    const source = event?.data?.source
    if (source?.kind === 'plugin' && source?.plugin === PLUGIN_NAME) return
    if (Number.isFinite(time)) {
      state.previousUserAt = state.lastUserAt
      state.lastUserAt = time
    }
    return
  }
  if (type === 'assistant/message') {
    if (Number.isFinite(time)) state.lastAssistantAt = time
    return
  }
  if (type === 'turn/end') {
    state.turns = (state.turns ?? 0) + 1
  }
}

/** 把日志推进到最新（就地折叠，返回同一份 state 引用）。 */
export function foldFromLog(agent, state) {
  const session = agent?.session
  const total = Number(session?.seq)
  if (!Number.isFinite(total) || typeof session?.eventAt !== 'function') return state

  let cursor = Number.isFinite(state.lastSeenSeq) ? state.lastSeenSeq : 0
  if (cursor > total) {
    const rebuilt = emptyState()
    Object.assign(state, rebuilt, {
      seq: state.seq, intents: state.intents, facts: state.facts, overlay: state.overlay,
      alter: state.alter, agencyWindow: state.agencyWindow, preplan: state.preplan,
      proactiveDrafts: state.proactiveDrafts, proactiveFingerprints: state.proactiveFingerprints,
    })
    cursor = 0
  }
  for (let index = cursor; index < total; index += 1) {
    const event = session.eventAt(index)
    if (event) applyEvent(state, event)
  }
  state.lastSeenSeq = total
  return state
}

/* ------------------------------------------------------------------ 意图 */

export function addIntent(state, draft, now) {
  state.seq = (state.seq ?? 0) + 1
  const intent = {
    id: `i${state.seq}`,
    kind: draft.kind || 'followup',
    summary: draft.summary,
    dueAt: draft.dueAt,
    createdAt: now,
    status: 'pending',
  }
  state.intents.push(intent)
  if (state.intents.length > MAX_INTENTS) {
    const pending = state.intents.filter(item => item.status === 'pending')
    const settled = state.intents.filter(item => item.status !== 'pending').slice(-5)
    state.intents = [...settled, ...pending].slice(-MAX_INTENTS)
  }
  return intent
}

export function dueIntents(state, now) {
  return (state.intents ?? [])
    .filter(item => item.status === 'pending' && Number.isFinite(item.dueAt) && item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
}

export function settleIntent(state, id, status = 'done') {
  const intent = (state.intents ?? []).find(item => item.id === id)
  if (!intent) return undefined
  intent.status = status
  intent.settledAt = Date.now()
  return intent
}

/* ------------------------------------------------------------ 长期事实 */

export function addFact(state, { scope, content, importance = 0.5, confidence = 0.5 }, now) {
  state.seq = (state.seq ?? 0) + 1
  const fact = {
    id: `f${state.seq}`,
    scope: scope || 'general',
    content,
    status: 'active',
    importance: clamp(importance, 0, 1),
    confidence: clamp(confidence, 0, 1),
    createdAt: now,
    updatedAt: now,
    // 「上次被提到」的时间。排序里的时间衰减用它，而不是 createdAt——
    // 一条三个月前写下、但昨天又被说起的事，仍然是新鲜的。
    lastSeenAt: now,
  }
  state.facts.push(fact)
  if (state.facts.length > MAX_FACTS) state.facts = state.facts.slice(-MAX_FACTS)
  return fact
}

/**
 * 长期事实的**排序**（不是简单取前 N 条）。
 *
 * 移植自参考项目 `service.ts:6687` 的 `factScore`：
 *
 * ```
 * score = importance×0.5 + confidence×0.35 + recency×0.15
 *       + semantic×0.55 + unresolved(promise)×0.2
 * recency = exp(-ageDays / 30)
 * ```
 *
 * 我们原先的「检索」是 `state.facts.filter(...).slice(0, memoryLimit)`——
 * **按插入顺序取前 N 条**。`importance` 字段一直在写，但**从不参与选择**；
 * 于是「三天前随口说的小事」会挤掉「上周那条要紧的承诺」。
 *
 * 这里实现前四项（纯计算）。`semantic` 项需要 embedding，DSH 侧不具备，
 * 因此**不加权**而不是给 0 分——否则每条事实都会被均等地压低，
 * 排序结果与不加这一项完全一样，只是白白多了个误导性的权重。
 *
 * @param {object} state 会话状态。
 * @param {number} [limit] 取前几条。
 * @param {number} [now] 当前时刻（注入以便测试）。
 * @returns {Array<object>} 按得分降序的事实（只含 active）。
 */
export function rankFacts(state, limit = 20, now = Date.now()) {
  const active = (state?.facts ?? []).filter(fact => fact.status === 'active')
  const scored = active.map(fact => {
    const seen = Number.isFinite(fact.lastSeenAt) ? fact.lastSeenAt
      : Number.isFinite(fact.updatedAt) ? fact.updatedAt
        : Number.isFinite(fact.createdAt) ? fact.createdAt : now
    const ageDays = Math.max(0, (now - seen) / 86_400_000)
    const recency = Math.exp(-ageDays / 30)
    // 未兑现的承诺多给一点权重——那是「还欠着的事」，最不该被挤掉。
    const unresolved = fact.scope === 'promise' && fact.status === 'active' ? 1 : 0
    const score = clamp(fact.importance ?? 0.5, 0, 1) * 0.5
      + clamp(fact.confidence ?? 0.5, 0, 1) * 0.35
      + recency * 0.15
      + unresolved * 0.2
    return { fact, score }
  })
  scored.sort((left, right) => right.score - left.score
    || (right.fact.updatedAt ?? 0) - (left.fact.updatedAt ?? 0))
  return scored.slice(0, Math.max(1, limit)).map(item => item.fact)
}

export function closeFact(state, id, status = 'resolved') {
  const fact = (state.facts ?? []).find(item => item.id === id)
  if (!fact) return undefined
  fact.status = status
  fact.updatedAt = Date.now()
  return fact
}

/* ------------------------------------------------------- 设定演化（Overlay） */

export function upsertOverlay(state, { layer, content }, now) {
  if (!['character', 'perspective', 'relationship', 'world'].includes(layer)) return undefined
  const existing = (state.overlay ?? []).find(item => item.layer === layer)
  const entry = {
    id: existing?.id ?? `o${(state.seq = (state.seq ?? 0) + 1)}`,
    layer,
    content,
    evidence: (existing?.evidence ?? 0) + 1,
    appliedAt: now,
  }
  state.overlay = [...(state.overlay ?? []).filter(item => item.layer !== layer), entry]
  return entry
}

export function clearOverlay(state, layer) {
  if (layer === 'all') {
    state.overlay = []
    return true
  }
  if (!['character', 'perspective', 'relationship', 'world'].includes(layer)) return false
  state.overlay = (state.overlay ?? []).filter(item => item.layer !== layer)
  return true
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * 群聊发言意愿与节流（移植自上游 `1.0.1-beta10` 的 `src/group-willingness.ts`
 * ＋ `1.0.1-rc23` 的**意愿档位化与 auto 档**，以及本地补充的**冷却间隔**）。
 *
 * ## 它解决什么
 *
 * 不开 `mentionOnly` 时，群里**每条消息**都会触发一次完整的主叙事回合：
 * 一轮上万 token、还要等模型跑完。一个活跃群几分钟就能烧掉大量额度，
 * 而角色其实没必要对每句话都插嘴。
 *
 * 上游的做法是一层**纯算法、零模型调用**的意愿判定（启发自 YesImBot v3）：
 *
 *   - **累积分数**：每条消息按条数加分（边际递减），被引用、命中关键词额外加分；
 *   - **半衰期衰减**：放着不管，分数按 `decayHalfLifeSeconds` 衰减一半——
 *     所以"群里一直有人在聊"会自然攒起意愿，"偶尔冒一句"攒不起来；
 *   - **阈值 + 概率**：低于阈值直接不回；超过阈值后按超出幅度换算成概率投骰子；
 *   - **回复即消耗**：说过一次就扣掉 `replyCost`，不会连着抢话；
 *   - **@ 强制通过**：被点名时必须回（绕过一切概率）。
 *
 * ## 档位化（rc23 移植）
 *
 * 10 个数值参数收敛为**单选档位**（quiet / reserved / normal / active / eager），
 * 并新增 **auto 档**：按主角当前生活状态（busy / asleep / idle）自动切档。
 * 评分数学零改动——档位只是参数来源。见文件下半部的 `WILLINGNESS_TIERS`。
 *
 * 睡眠态（asleep）三个固定行为（与上游一致）：
 *   1. **@ 不再直通**——她在睡觉，@ 留给醒来后的回合自然处理；
 *   2. **概率 ×0.2**——独立于所配档位的安全余量，对冲状态过期/误判；
 *   3. 掷骰失败时拒绝原因记为 `asleep`，日志可见。
 *
 * ## 本地补充：最小回复间隔（冷却）
 *
 * 上游只有概率，没有硬间隔——概率再低，连着两条也可能都中。这里加一层
 * `minReplyIntervalSeconds`：距上次群内发言不足这个时长时，**直接不回**
 * （被 @ 仍然放行；睡眠态同样受它约束）。这正是"多少时间内限制回复"那条需求。
 *
 * ## DSH 侧适配（唯一与上游的差别）
 *
 * 上游的 `lifeStatus` 搭**压缩器**便车（压缩提示词附带返回，零额外模型调用）。
 * DSH 没有独立侧端模型通道，因此本仓把它做成可写入的状态字段
 * `state.lifeStatus = {status, updatedAt}`（见 `state.js` 的 `normalizeLifeStatus`），
 * 由既有「模型交接」通道或 `/interlude life` 命令写入；**状态缺失或超过 6 小时
 * 未刷新时 auto 档回退 normal —— 与上游完全一致**。
 *
 * ## 刻意不做的事（与上游一致）
 *
 * - **不调模型**：纯算术，零延迟、零 token；
 * - **不影响私聊**：私聊回合的判定不经过这里；
 * - **不写进故事状态**：**分数**只活在内存（重载归零，避免污染叙事）；
 * - **不取代 Agency/Agency Window**：那是「主动联系」的容量约束，与这里无关。
 *
 * @module dsh-hds-interlude/group-willingness
 */

/** 默认配置（数值与上游一致）。 */
export const DEFAULT_GROUP_WILLINGNESS = {
  enabled: false,
  maxScore: 1,
  threshold: 0.24,
  probabilityAmplifier: 1.3,
  decayHalfLifeSeconds: 180,
  replyCost: 0.55,
  baseGain: 0.12,
  quoteGain: 0.12,
  keywordGain: 0.18,
  keywords: [],
  /** 本地补充：两次群内发言之间的最短间隔（秒）；0 = 不限制。 */
  minReplyIntervalSeconds: 0,
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * 规整配置：缺省值兜底、关键词去重截断。
 *
 * @param {object} [config] 用户配置。
 * @returns {object} 规整后的配置。
 */
export function resolveGroupWillingness(config) {
  const source = config && typeof config === 'object' ? config : {}
  const rawKeywords = Array.isArray(source.keywords) ? source.keywords : DEFAULT_GROUP_WILLINGNESS.keywords
  return {
    ...DEFAULT_GROUP_WILLINGNESS,
    ...source,
    enabled: source.enabled === true,
    maxScore: Number.isFinite(source.maxScore) ? clamp(source.maxScore, 0.01, 10) : DEFAULT_GROUP_WILLINGNESS.maxScore,
    threshold: Number.isFinite(source.threshold) ? clamp(source.threshold, 0, 10) : DEFAULT_GROUP_WILLINGNESS.threshold,
    probabilityAmplifier: Number.isFinite(source.probabilityAmplifier)
      ? clamp(source.probabilityAmplifier, 0, 100) : DEFAULT_GROUP_WILLINGNESS.probabilityAmplifier,
    decayHalfLifeSeconds: Number.isFinite(source.decayHalfLifeSeconds)
      ? clamp(source.decayHalfLifeSeconds, 1, 86_400) : DEFAULT_GROUP_WILLINGNESS.decayHalfLifeSeconds,
    replyCost: Number.isFinite(source.replyCost) ? clamp(source.replyCost, 0, 10) : DEFAULT_GROUP_WILLINGNESS.replyCost,
    baseGain: Number.isFinite(source.baseGain) ? clamp(source.baseGain, 0, 10) : DEFAULT_GROUP_WILLINGNESS.baseGain,
    quoteGain: Number.isFinite(source.quoteGain) ? clamp(source.quoteGain, 0, 10) : DEFAULT_GROUP_WILLINGNESS.quoteGain,
    keywordGain: Number.isFinite(source.keywordGain) ? clamp(source.keywordGain, 0, 10) : DEFAULT_GROUP_WILLINGNESS.keywordGain,
    minReplyIntervalSeconds: Number.isFinite(source.minReplyIntervalSeconds)
      ? clamp(source.minReplyIntervalSeconds, 0, 86_400) : DEFAULT_GROUP_WILLINGNESS.minReplyIntervalSeconds,
    keywords: rawKeywords.map((item) => String(item).trim()).filter(Boolean).slice(0, 30),
  }
}

/**
 * 按半衰期把分数衰减到 `now`。
 *
 * @param {{score: number, updatedAt: number}|undefined} previous 上一次状态。
 * @param {object} config 规整后的配置。
 * @param {number} now 当前毫秒时间戳。
 * @returns {{score: number, updatedAt: number}} 衰减后的状态（新对象）。
 */
export function decayWillingness(previous, config, now) {
  const score = Number.isFinite(previous?.score) ? previous.score : 0
  const elapsedSeconds = Math.max(0, now - (previous?.updatedAt ?? now)) / 1000
  const factor = 0.5 ** (elapsedSeconds / Math.max(1, config.decayHalfLifeSeconds))
  const next = score * factor
  return { score: next < 1e-3 ? 0 : next, updatedAt: now }
}

/**
 * 判定这一条群消息要不要触发角色。
 *
 * @param {{score: number, updatedAt: number}|undefined} previous 该群的意愿状态。
 * @param {object} configInput 配置。
 * @param {object} input
 * @param {number} input.now 当前毫秒时间戳。
 * @param {number} input.messageCount 本次合并批的消息条数。
 * @param {string} input.content 消息正文。
 * @param {boolean} [input.quotedBot] 是否引用了机器人。
 * @param {boolean} input.mentionedBot 是否 @ 了机器人。
 * @param {number} [input.lastReplyAt] 该群上次机器人发言的时刻（冷却用）。
 * @param {Function} [input.random] 随机源（测试注入）。
 * @returns {{state: object, shouldCall: boolean, probability: number, reason: string}}
 *   `reason` 取值：`disabled` / `forced-mention` / `cooldown` / `below-threshold` / `probability-roll`。
 */
export function evaluateGroupWillingness(previous, configInput, input) {
  const config = resolveGroupWillingness(configInput)
  const state = decayWillingness(previous, config, input.now ?? Date.now())

  if (!config.enabled) {
    return { state, shouldCall: true, probability: 1, reason: 'disabled' }
  }

  // 累积意愿：条数（边际递减）+ 引用 + 关键词。
  const keywordHit = Array.isArray(config.keywords) && config.keywords.some((keyword) => String(input.content ?? '').includes(keyword))
  const messageCount = Number.isFinite(input.messageCount) ? input.messageCount : 1
  const rawGain = config.baseGain * Math.max(1, Math.min(3, messageCount))
    + (input.quotedBot ? config.quoteGain : 0)
    + (keywordHit ? config.keywordGain : 0)
  // 边际递减：分数越接近上限，加得越少（防止刷屏把意愿顶满）。
  const marginal = 1 - Math.min(1, state.score / config.maxScore) ** 2
  state.score = clamp(state.score + rawGain * Math.max(0, marginal), 0, config.maxScore)

  // @ 机器人 = 点名，必须回（绕过冷却与概率）。
  if (input.mentionedBot) {
    return { state, shouldCall: true, probability: 1, reason: 'forced-mention' }
  }

  // 冷却：距上次群内发言不足最小间隔 → 不回（本地补充的那一层）。
  const lastReplyAt = Number.isFinite(input.lastReplyAt) ? input.lastReplyAt : 0
  if (config.minReplyIntervalSeconds > 0 && lastReplyAt > 0
    && (input.now - lastReplyAt) < config.minReplyIntervalSeconds * 1000) {
    return { state, shouldCall: false, probability: 0, reason: 'cooldown' }
  }

  if (state.score <= config.threshold) {
    return { state, shouldCall: false, probability: 0, reason: 'below-threshold' }
  }

  const probability = clamp((state.score - config.threshold) * config.probabilityAmplifier, 0, 1)
  const roll = typeof input.random === 'function' ? input.random() : Math.random()
  return { state, shouldCall: roll < probability, probability, reason: 'probability-roll' }
}

/**
 * 回复之后的消耗：扣掉 `replyCost`（说过一次就降温，不连着抢话）。
 *
 * @param {{score: number, updatedAt: number}|undefined} previous 当前状态。
 * @param {object} configInput 配置。
 * @param {number} now 当前毫秒时间戳。
 * @returns {{score: number, updatedAt: number}} 新状态。
 */
export function consumeGroupWillingness(previous, configInput, now) {
  const config = resolveGroupWillingness(configInput)
  const state = decayWillingness(previous, config, now)
  return { score: Math.max(0, state.score - config.replyCost), updatedAt: now }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 档位化（willingness preset）与 auto 档
 *   移植自上游 `1.0.1-rc23` 的 `src/group-willingness.ts` L103-244。
 *
 * 上游把「10 个数值参数」收敛为**单选档位**，并新增 auto 档：压缩器在每次
 * 整理时附带返回主角注意力状态（busy | asleep | idle），宿主据此自动切档。
 * auto 档**不增加任何模型调用**——状态搭压缩器便车。
 *
 * 评分数学零改动（本地累积/半衰期/阈值/掷骰），档位只是参数来源。
 *
 * DSH 侧适配（与上游的唯一差别，已在文档记录）：
 *   上游的 lifeStatus 来自压缩器侧端调用；DSH 没有独立侧端模型通道，
 *   因此本仓把它做成**可写入的状态字段** `state.lifeStatus`（见 state.js 的
 *   `normalizeLifeStatus`），由既有「模型交接」通道或 `/interlude life` 命令写入。
 *   状态缺失或超过 6 小时未刷新时，auto 档回退 normal —— 与上游完全一致。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 五档之一。 */
export const WILLINGNESS_TIERS_LIST = ['quiet', 'reserved', 'normal', 'active', 'eager']

/**
 * 档位参数表（数值逐字对齐上游）。
 *
 * 基线校准：normal 约每 4~5 条普通群消息触发一次模型调用（单条批次连续到达、
 * 随机数公平时的期望值；密集批次会更快）。上游以固定掷骰 0.4 锁定区间：
 * eager=1、active=2、normal=4~5、reserved=6~8、quiet=9~13。
 */
export const WILLINGNESS_TIERS = {
  quiet: { enabled: true, maxScore: 2, threshold: 0.80, probabilityAmplifier: 1.1, decayHalfLifeSeconds: 150, replyCost: 0.85, baseGain: 0.12, quoteGain: 0.08, keywordGain: 0.12, keywords: [] },
  reserved: { enabled: true, maxScore: 2, threshold: 0.75, probabilityAmplifier: 1.25, decayHalfLifeSeconds: 200, replyCost: 0.85, baseGain: 0.17, quoteGain: 0.12, keywordGain: 0.16, keywords: [] },
  normal: { enabled: true, maxScore: 2, threshold: 0.62, probabilityAmplifier: 1.4, decayHalfLifeSeconds: 240, replyCost: 0.80, baseGain: 0.25, quoteGain: 0.15, keywordGain: 0.20, keywords: [] },
  active: { enabled: true, maxScore: 2, threshold: 0.30, probabilityAmplifier: 1.6, decayHalfLifeSeconds: 300, replyCost: 0.60, baseGain: 0.34, quoteGain: 0.20, keywordGain: 0.25, keywords: [] },
  eager: { enabled: true, maxScore: 2, threshold: 0.10, probabilityAmplifier: 1.8, decayHalfLifeSeconds: 360, replyCost: 0.50, baseGain: 0.45, quoteGain: 0.28, keywordGain: 0.30, keywords: [] },
}

/** auto 档的三态默认映射（上游默认值）。 */
export const DEFAULT_AUTO_WILLINGNESS = { busy: 'quiet', idle: 'active', asleep: 'quiet' }

/**
 * 睡眠态安全余量：概率乘数。
 *
 * 独立于所配档位——对「压缩器状态过期/误判」的兜底。她在睡觉，即使档位是
 * eager 也不该几乎每批都插话。
 */
export const ASLEEP_PROBABILITY_MULTIPLIER = 0.2

/** lifeStatus 超过该时长未刷新时，auto 档回退 normal。 */
export const LIFE_STATUS_STALE_MS = 6 * 60 * 60 * 1000

/**
 * 防御归一：只接受三个合法值，其余（含 undefined/错类型）返回 undefined。
 * 与上游 `normalizeLifeStatusDraft` 逐字对齐。
 */
export function normalizeLifeStatusDraft(value) {
  return value === 'busy' || value === 'asleep' || value === 'idle' ? value : undefined
}

/** 归一单个档位名。 */
function normalizeTier(value) {
  return WILLINGNESS_TIERS_LIST.includes(value) ? value : undefined
}

/** 规整 auto 档三态映射（缺省/非法回退默认档）。 */
export function resolveAutoWillingness(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    busy: normalizeTier(record.busy) ?? DEFAULT_AUTO_WILLINGNESS.busy,
    idle: normalizeTier(record.idle) ?? DEFAULT_AUTO_WILLINGNESS.idle,
    asleep: normalizeTier(record.asleep) ?? DEFAULT_AUTO_WILLINGNESS.asleep,
  }
}

/**
 * 解析「档位 + auto + lifeStatus」→ 实际生效的数值配置与诊断。
 *
 * 兼容规则（上游语义，存量行为字节级不变）：
 *   未设置档位（或显式 off）但旧数值门 `enabled === true` → 按 custom 处理。
 *
 * @returns {{preset: string, config: object, diagnosis: object}}
 */
function resolveWillingnessLayers(preset, autoInput, lifeStatus, now, legacyInput) {
  const rawPreset = typeof preset === 'string' ? preset : ''
  const legacyEnabled = legacyInput?.enabled === true
  const known = WILLINGNESS_TIERS_LIST.includes(rawPreset) || rawPreset === 'auto' || rawPreset === 'custom'
  const resolved = legacyEnabled && (rawPreset === '' || rawPreset === 'off')
    ? 'custom'
    : known ? rawPreset : 'off'
  const diagnosis = { preset: resolved, asleep: false }
  if (resolved === 'off' || resolved === 'custom') {
    return {
      preset: resolved,
      config: resolved === 'off' ? { ...legacyInput, enabled: false } : (legacyInput ?? {}),
      diagnosis,
    }
  }
  let tier
  if (resolved === 'auto') {
    const status = lifeStatus ? normalizeLifeStatusDraft(lifeStatus.status) : undefined
    const updatedAt = lifeStatus ? Date.parse(lifeStatus.updatedAt) : NaN
    if (!status || !Number.isFinite(updatedAt) || now - updatedAt > LIFE_STATUS_STALE_MS) {
      tier = 'normal'
      if (lifeStatus) diagnosis.stale = true
    } else {
      tier = resolveAutoWillingness(autoInput)[status]
      diagnosis.lifeStatus = status
      diagnosis.asleep = status === 'asleep'
    }
  } else {
    tier = resolved
  }
  diagnosis.tier = tier
  // keywords 恒取旧配置：内容维度与档位正交（所有档位下旧关键词仍生效）。
  return { preset: resolved, config: { ...WILLINGNESS_TIERS[tier], keywords: legacyInput?.keywords ?? [] }, diagnosis }
}

/** 该群当前是否处于最小回复间隔内（本地补充的冷却层）。 */
function inCooldown(config, input) {
  const lastReplyAt = Number.isFinite(input?.lastReplyAt) ? input.lastReplyAt : 0
  return config.minReplyIntervalSeconds > 0 && lastReplyAt > 0
    && (input.now - lastReplyAt) < config.minReplyIntervalSeconds * 1000
}

/**
 * 档位统一评估门：按 preset 解析参数后走核心打分。
 *
 * auto 档按压缩器（DSH 侧为 `state.lifeStatus`）写入的状态切换档位；
 * **asleep 态概率 ×0.2 且 @ 不再直通**（她在睡觉，@ 留给醒来后的回合自然处理，
 * 主模型会写她没看手机）。
 *
 * @param {{score:number,updatedAt:number}|undefined} previous 该群意愿状态。
 * @param {string} preset `off` | 五档 | `auto` | `custom`。
 * @param {object} autoInput auto 档三态映射。
 * @param {{status:string,updatedAt:string}|undefined} lifeStatus 生活状态。
 * @param {object} legacyInput 旧数值配置（custom/off 用；keywords 恒用它）。
 * @param {object} input 同 evaluateGroupWillingness。
 * @returns {{state:object,shouldCall:boolean,probability:number,reason:string,diagnosis:object}}
 */
export function evaluateWillingnessGate(previous, preset, autoInput, lifeStatus, legacyInput, input) {
  const layers = resolveWillingnessLayers(preset, autoInput, lifeStatus, input.now, legacyInput)
  if (layers.diagnosis.asleep) {
    // 概率乘数独立于档位：先取未乘的概率（random=1 阻断核心掷骰、@ 不直通、
    // 冷却不参与测量），再手动掷。
    const base = evaluateGroupWillingness(previous, layers.config, {
      ...input, mentionedBot: false, random: 1, lastReplyAt: 0,
    })
    const probability = clamp(base.probability * ASLEEP_PROBABILITY_MULTIPLIER, 0, 1)
    // 本地冷却层仍优先：睡眠态也不该绕过最小回复间隔。
    if (inCooldown(resolveGroupWillingness(layers.config), input)) {
      return { state: base.state, shouldCall: false, probability: 0, reason: 'cooldown', diagnosis: layers.diagnosis }
    }
    const roll = typeof input.random === 'function' ? input.random() : Math.random()
    const shouldCall = roll < probability
    return {
      state: base.state,
      shouldCall,
      probability,
      reason: shouldCall ? 'probability-roll' : 'asleep',
      diagnosis: layers.diagnosis,
    }
  }
  const decision = evaluateGroupWillingness(previous, layers.config, input)
  return { ...decision, diagnosis: layers.diagnosis }
}

/**
 * 她在群内成功发言后的意愿扣减，与评估门使用**同一档位解析**（replyCost 对齐）。
 */
export function consumeWillingnessGate(previous, preset, autoInput, lifeStatus, legacyInput, now) {
  const layers = resolveWillingnessLayers(preset, autoInput, lifeStatus, now, legacyInput)
  return consumeGroupWillingness(previous, layers.config, now)
}

/**
 * 按群分会话的意愿状态表（每群一份，互不影响）。
 *
 * 只活在内存里：重载归零。群聊意愿是**当下这一小段时间**的判断，
 * 落盘反而会让重启后带着旧的"热情"继续抢话。
 */
export class GroupWillingnessStore {
  constructor() {
    /** @type {Map<string, {score: number, updatedAt: number}>} */
    this.states = new Map()
    /** @type {Map<string, number>} 上次机器人发言时刻（冷却用）。 */
    this.lastReplyAt = new Map()
  }

  /** 取某群的状态（没有就是空）。 */
  stateOf(key) {
    return this.states.get(String(key ?? ''))
  }

  /** 写回某群的状态。 */
  setState(key, state) {
    this.states.set(String(key ?? ''), state)
    return state
  }

  /** 取某群上次发言时刻。 */
  lastReplyOf(key) {
    return this.lastReplyAt.get(String(key ?? '')) ?? 0
  }

  /** 记一次发言（同时消耗意愿）。 */
  noteReply(key, config, now) {
    const id = String(key ?? '')
    this.lastReplyAt.set(id, now)
    return this.setState(id, consumeGroupWillingness(this.states.get(id), config, now))
  }

  /**
   * 档位版的发言记账：与 `evaluateWillingnessGate` 共用同一档位解析，
   * 保证评估门与扣减用的 `replyCost` 一致（上游 `consumeWillingnessGate`）。
   */
  noteReplyGate(key, preset, autoInput, lifeStatus, legacyInput, now) {
    const id = String(key ?? '')
    this.lastReplyAt.set(id, now)
    return this.setState(id, consumeWillingnessGate(this.states.get(id), preset, autoInput, lifeStatus, legacyInput, now))
  }

  /** 全部分数（诊断用）。 */
  snapshot() {
    const out = {}
    for (const [key, state] of this.states) {
      out[key] = { score: state.score, updatedAt: state.updatedAt, lastReplyAt: this.lastReplyAt.get(key) ?? 0 }
    }
    return out
  }
}


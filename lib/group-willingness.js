/**
 * 群聊发言意愿与节流（移植自上游 1.0.1-beta10 的 `src/group-willingness.ts`
 * + 本地补充的**冷却间隔**）。
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
 * ## 本地补充：最小回复间隔（冷却）
 *
 * 上游只有概率，没有硬间隔——概率再低，连着两条也可能都中。这里加一层
 * `minReplyIntervalSeconds`：距上次群内发言不足这个时长时，**直接不回**
 * （被 @ 仍然放行）。这正是"多少时间内限制回复"那条需求。
 *
 * ## 刻意不做的事（与上游一致）
 *
 * - **不调模型**：纯算术，零延迟、零 token；
 * - **不影响私聊**：私聊回合的判定不经过这里；
 * - **不写进故事状态**：分数只活在内存（重载归零，避免污染叙事）；
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

  /** 全部分数（诊断用）。 */
  snapshot() {
    const out = {}
    for (const [key, state] of this.states) {
      out[key] = { score: state.score, updatedAt: state.updatedAt, lastReplyAt: this.lastReplyAt.get(key) ?? 0 }
    }
    return out
  }
}

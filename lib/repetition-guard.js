/**
 * 连发同条数守卫（Repetition Guard，移植自上游 1.0.1-rc18 的
 * `detectMessageRepetition` + `repetitionGuardInstruction`）。
 *
 * ## 它解决什么（上游实机诊断）
 *
 * 弱模型会把「上一轮发了几条」当成固定形态照着复刻：连续几批回复都是恰好 2 条
 * 气泡，且剧本叙述层也同步固化（写成"敲出两行"+ `<sep/>`）。一旦某个形态进入
 * 可见历史，下一次输出就会被它偏置——这是**上下文自我模仿的正反馈**，任何稳定
 * 的每回合形态都会锁死。
 *
 * 修法分两层（上游 rc18 的做法）：
 *   1. **宿主检测**：倒序归批统计她每批回复的气泡数，尾部连续 ≥2 批都是同一个
 *      x（x≥2）时判定为「条数锚定」；
 *   2. **提示词守卫**：只在私聊对话回合注入一段守卫，明确告诉模型「这是产物
 *      不是她的声音」，并要求这一轮不要复刻同样的条数。
 *
 * x=1（每轮都只发一条）**不触发**——那是正常的短消息习惯，不是锚定。
 *
 * ## 与上游的差异（DSH 形态）
 *
 * 上游的归批以投递元数据 `bubbleIndex`/`bubbleCount` 为权威（批次首领
 * `bubbleIndex === 0`）；DSH 侧由 `script-entry.js` 在投递后补写同样的元数据
 * （见 `lib/index.js` 的 `recordDeliveryLedger` 附近）。没有元数据的旧条目
 * 回退为「连续的 character-message 归一批」——与上游一致。
 *
 * 守卫文案改写为**中文**：本地提示词架构是中文叙事 + `interlude_say` 工具调用，
 * 不适用上游那套英文 JSON 传输合约。
 *
 * @module dsh-hds-interlude/repetition-guard
 */

/** 最多统计多少批（与上游一致）。 */
export const MAX_BATCHES = 8

/** 命中所需的连续同条数批次数（与上游一致）。 */
export const MIN_CONSECUTIVE = 2

/** 触发守卫的最小气泡数：单条不触发（那是正常习惯，不是锚定）。 */
export const MIN_BUBBLES = 2

/** 非负安全整数；否则 undefined（与上游 `safeCount` 一致）。 */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 从条目列表里检测「连发同条数」。
 *
 * 归批规则（严格照上游移植）：
 *   - 从最新往旧扫，最多收集 `MAX_BATCHES` 批；
 *   - 遇到 `character-message` 且有 `metadata.scriptEvent.bubbleCount`、
 *     且 `bubbleIndex === 0` → 这是一批的**首领**，直接锁定该批条数；
 *   - 其它 `character-message`（无元数据的老条目 / 非首领气泡）累加进当前批；
 *   - 遇到任何**非** `character-message` 的条目 → 批次边界，收束当前批。
 *
 * @param {Array<object>} entries 近期条目（**时间升序**，最新的在末尾）。
 * @returns {{bubbles: number, consecutive: number}|undefined}
 *   命中时返回 `{bubbles, consecutive}`；未命中返回 undefined。
 */
export function detectMessageRepetition(entries) {
  const list = Array.isArray(entries) ? entries : []
  /** @type {number[]} */
  const batches = []
  let pending = 0
  for (let i = list.length - 1; i >= 0 && batches.length < MAX_BATCHES; i -= 1) {
    const entry = list[i]
    if (!entry || entry.kind !== 'character-message') {
      // 非角色消息 = 批次边界（她说完一批，对方接话，再下一批）。
      if (pending) {
        batches.push(pending)
        pending = 0
      }
      continue
    }
    const raw = entry.metadata?.scriptEvent
    const event = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined
    const bubbleCount = safeCount(event?.bubbleCount)
    if (bubbleCount !== undefined && safeCount(event?.bubbleIndex) === 0) {
      // 批次首领：以它声明的条数为准（权威元数据）。
      batches.push(bubbleCount)
      pending = 0
      continue
    }
    // 无元数据的旧条目 / 该批的后续气泡：计入当前批。
    pending += 1
  }
  if (pending && batches.length < MAX_BATCHES) batches.push(pending)

  const bubbles = batches[0]
  if (!Number.isSafeInteger(bubbles) || bubbles < MIN_BUBBLES) return undefined
  let consecutive = 1
  while (consecutive < batches.length && batches[consecutive] === bubbles) consecutive += 1
  return consecutive >= MIN_CONSECUTIVE ? { bubbles, consecutive } : undefined
}

/**
 * 守卫提示词段。未命中（或参数不足以构成锚定）时返回空串。
 *
 * @param {{bubbles: number, consecutive: number}|undefined} repetition 检测结果。
 * @returns {string} 注入段；不注入时为空串。
 */
export function repetitionGuardInstruction(repetition) {
  if (!repetition || repetition.bubbles < MIN_BUBBLES || repetition.consecutive < MIN_CONSECUTIVE) return ''
  const { bubbles, consecutive } = repetition
  return `【条数守卫（宿主对近期记录的观察）】她最近连续 ${consecutive} 次开口都恰好分成 ${bubbles} 条消息。真人打字不会把条数稳定卡在同一个数字上——那是格式的惯性，不是她的语气。这一段不要再复刻 ${bubbles} 条的形状，让这一轮按此刻的需要自然成形：一句紧凑的话、条数不同的几个碎片、或者一整段较长的话都可以。拿不准时，就只发一条。`
}

/**
 * 判断某个回合该不该做条数检测。
 *
 * 与上游一致：只有**私聊对话回合**才检——它关心的是"recentScript 里她怎么回复
 * 用户的"。
 *   - `advance`（自动推进）：她在过自己的生活，条数形态不构成对用户的锚定；
 *   - 群聊：协议与投递路径不同，也不注入。
 *
 * @param {object} args
 * @param {string} args.phase 叙事阶段。
 * @param {boolean} [args.isGroup] 是否群聊回合。
 * @returns {boolean}
 */
export function shouldCheckRepetition({ phase, isGroup = false } = {}) {
  if (isGroup) return false
  return phase === 'user-message' || phase === 'conversation-follow-up'
}

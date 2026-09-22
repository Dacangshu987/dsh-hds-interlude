/**
 * 时间导演的退避与熔断（移植自上游 `src/service.ts` 的 backoff + fuse 段）。
 *
 * ## 它解决什么问题
 *
 * 「时间导演」是一类**会失败且会重试**的模型调用（给一段时间窗口生成事件账本）。
 * 上游踩过的坑有两层：
 *
 * 1. **失败后不能每个后台扫描周期都重试**。后台扫描三分钟一轮，故事游标没动时
 *    重试必然还是同一个结果——纯烧 token。所以要按「同一个起点」记退避，
 *    退避期内直接跳过（上游注释：`A failed automatic timeline must not be sent
 *    again on every three-minute background sweep while the story cursor is unchanged.`）。
 *
 * 2. **反复失败要熔断**。退避只挡「同一个窗口」，但模型可能对**每一个**新窗口
 *    都失败。连续失败到 6 次就熔断：自动推进降级为「无账本守恒推进」，
 *    两小时内不再调用时间导演，到期自动解除并重试一次完整路径。
 *
 * ## 为什么单独成模块
 *
 * 上游把这段逻辑内嵌在 487KB 的 `service.ts` 里，和数据库/消息队列缠在一起，
 * 几乎无法单测。这里抽成纯函数 + 一个小状态对象：退避与熔断的**判定**全是
 * 纯计算，只有时间需要注入。这样「连续失败第 6 次必须熔断」这类性质才验得动。
 *
 * @module dsh-hds-interlude/timeline-guard
 */

/** 退避基数：失败后至少等这么久才允许对**同一个窗口**重试。 */
export const RETRY_BACKOFF_BASE_MS = 10 * 60_000

/** 连续失败达到该次数即熔断。 */
export const DIRECTOR_FUSE_THRESHOLD = 6

/** 熔断冷却时长；到期自动解除熔断，重试一次完整路径。 */
export const DIRECTOR_FUSE_COOLDOWN_MS = 2 * 60 * 60_000

/**
 * 新建一份守卫状态。
 *
 * 故意做成**纯数据**（不是 class）：它会被序列化检查、被测试直接断言，
 * 也让调用方决定什么时候落盘。
 *
 * @returns {{failures: number, backoff: {from: number, until: number}|null}}
 */
export function createTimelineGuard() {
  return { failures: 0, backoff: null }
}

/**
 * 把任意（可能损坏的、来自旧版本的）值规范化成合法守卫状态。
 *
 * @param {unknown} value 盘上的值。
 * @returns {{failures: number, backoff: {from: number, until: number}|null}}
 */
export function normalizeTimelineGuard(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const failures = Number.isSafeInteger(raw.failures) && raw.failures >= 0 ? raw.failures : 0
  const b = raw.backoff
  const backoff = b && typeof b === 'object'
    && Number.isFinite(b.from) && Number.isFinite(b.until) && b.until >= b.from
    ? { from: b.from, until: b.until }
    : null
  return { failures, backoff }
}

/**
 * 现在允许调用时间导演吗？
 *
 * 三种情况返回不允许（并给出原因，便于诊断）：
 *   - **熔断中**：连续失败已达阈值，且冷却未过；
 *   - **退避中**：同一个窗口刚失败过，还没到重试时间；
 *   - 都不是 → 允许。
 *
 * 注意熔断判定的顺序与上游一致：先看退避，再看熔断。这样「熔断冷却已过」
 * 时不会被一条陈旧的退避记录继续挡住。
 *
 * @param {object} guard 守卫状态。
 * @param {object} args
 * @param {number} args.now 当前时刻。
 * @param {number} args.from 本次要生成的时间窗口起点（用于判断"同一个窗口"）。
 * @returns {{allowed: boolean, reason?: 'fused'|'backoff', failures: number}}
 */
export function timelineDirectorAllowed(guard, { now, from }) {
  const state = normalizeTimelineGuard(guard)
  const backoff = state.backoff
  if (backoff && now >= backoff.until) return { allowed: true, failures: state.failures }
  if (backoff) {
    // 熔断优先：连续失败够多时，**连换了窗口也要挡住**整个冷却期。
    // 否则每来一个新窗口就重试一次，熔断等于只挡了同一个窗口。
    if (state.failures >= DIRECTOR_FUSE_THRESHOLD) {
      return { allowed: false, reason: 'fused', failures: state.failures }
    }
    // 普通退避只挡**同一个窗口**：换了窗口说明是新的工作，应当放行。
    if (backoff.from === from) {
      return { allowed: false, reason: 'backoff', failures: state.failures }
    }
  }
  return { allowed: true, failures: state.failures }
}

/**
 * 记一次失败：递增计数并按**指数退避**推后重试时间。
 *
 * 指数退避的倍数取 2 的幂（10min → 20min → 40min → …），与上游同量级。
 * 计数不会因为退避变长而封顶——它正是熔断判据。
 *
 * @param {object} guard 守卫状态（就地修改并返回）。
 * @param {object} args
 * @param {number} args.now 当前时刻。
 * @param {number} args.from 本次失败的窗口起点。
 * @returns {object} 更新后的守卫状态。
 */
export function recordDirectorFailure(guard, { now, from }) {
  // **就地修改调用方的对象**，而不是换一个新对象。
  //
  // 踩过的坑：一开始写成 `const state = normalizeTimelineGuard(guard)` 然后改
  // state —— normalize 返回的是**副本**，于是调用方手里的 guard 永远不变，
  // 失败计数根本没涨，熔断也永远不会触发。这类"看起来在工作、其实没生效"的
  // 写法在守卫逻辑里尤其危险：它会让保护机制静默失效。
  const state = guard && typeof guard === 'object' ? guard : createTimelineGuard()
  const current = normalizeTimelineGuard(state)
  state.failures = current.failures + 1
  // 指数退避：第 1 次失败退避 10min，第 2 次 20min……上限取熔断冷却时长，
  // 免得退避算出来比熔断还久（那会让熔断形同虚设）。
  const multiplier = 2 ** Math.min(state.failures - 1, 10)
  const wait = Math.min(RETRY_BACKOFF_BASE_MS * multiplier, DIRECTOR_FUSE_COOLDOWN_MS)
  state.backoff = { from, until: now + wait }
  return state
}

/**
 * 记一次成功：**清空失败计数与退避**。
 *
 * 这条很重要：熔断是为了「连续失败」，一旦成功就说明路径恢复了，
 * 不该再把之前累积的失败带进下一次判定（否则偶发抖动会慢慢攒到熔断）。
 *
 * @param {object} guard 守卫状态（就地修改并返回）。
 * @returns {object} 更新后的守卫状态。
 */
export function recordDirectorSuccess(guard) {
  const state = guard && typeof guard === 'object' ? guard : createTimelineGuard()
  state.failures = 0
  state.backoff = null
  return state
}

/**
 * 当前是否处于熔断（用于决定要不要降级为「无账本守恒推进」）。
 *
 * @param {object} guard 守卫状态。
 * @returns {number|undefined} 熔断时的连续失败次数；未熔断则 undefined。
 */
export function timelineDirectorFused(guard) {
  const state = normalizeTimelineGuard(guard)
  return state.failures >= DIRECTOR_FUSE_THRESHOLD ? state.failures : undefined
}

/**
 * 熔断/退避的可读描述，用于日志与 `/interlude status`。
 *
 * @param {object} guard 守卫状态。
 * @param {number} now 当前时刻。
 * @returns {string} 描述；正常时为空串。
 */
export function describeTimelineGuard(guard, now) {
  const state = normalizeTimelineGuard(guard)
  const remaining = state.backoff ? Math.max(0, state.backoff.until - now) : 0
  if (state.failures >= DIRECTOR_FUSE_THRESHOLD && remaining > 0) {
    return `时间导演已熔断（连续失败 ${state.failures} 次），${Math.ceil(remaining / 60_000)} 分钟后自动重试；`
      + '期间自动推进降级为无账本守恒推进。'
  }
  if (remaining > 0) {
    return `时间导演退避中（连续失败 ${state.failures} 次），${Math.ceil(remaining / 60_000)} 分钟后重试。`
  }
  return ''
}

/* ======================================================================
 * 时间导演路由（移植自上游 src/script/timeline-routing.ts）
 * ====================================================================== */

/** 超过这个间隔就必须让时间导演参与（时间跨度大到不能靠惯性推进）。 */
const ROUTING_GAP_MS = 20 * 60_000

/**
 * 这一轮需要时间导演吗？
 *
 * 上游的口径：**路由改变的是模型工作量，不是散文的裁决**。
 * 具体判据（任一成立就要）：
 *   - 阶段是 `advance`（自动推进）；
 *   - 距上次已经超过 20 分钟（跨度大，惯性不够）；
 *   - 跨了本地日历日（日期变了，时间线必须重算）；
 *   - 日程里有一个**边界**落在这个区间内。
 *
 * `user-message` 阶段**永远不需要**——用户刚说话，时间没有真正流动。
 *
 * @param {object} args
 * @param {string} args.phase 叙事阶段。
 * @param {number} args.from 上一段结束时刻。
 * @param {number} args.now 当前时刻。
 * @param {string} args.timezone 时区。
 * @param {object} [args.schedule] 近期日程窗口（含 blocks）。
 * @param {Function} args.dayKey `(ms, tz) => string` 日历日。
 * @param {Function} args.clockMinutes `(ms, tz) => number` 本地分钟数。
 * @returns {boolean}
 */
export function needsTimelineDirector({ phase, from, now, timezone, schedule, dayKey, clockMinutes }) {
  if (phase === 'user-message') return false
  if (phase === 'advance' || now - from > ROUTING_GAP_MS) return true
  if (dayKey(from, timezone) !== dayKey(now, timezone)) return true
  const start = clockMinutes(from, timezone)
  const end = clockMinutes(now, timezone)
  const today = dayKey(now, timezone)
  return Boolean(schedule?.blocks?.some(block => block.date === today
    && [block.start, block.end].some(clock => {
      const [hour, minute] = String(clock).split(':').map(Number)
      const at = hour * 60 + minute
      return at > start && at <= end
    })))
}

/**
 * 健康面板（移植自上游 1.0.1-rc1 的 `src/health.ts`）。
 *
 * ## 它解决什么
 *
 * 上游进入 rc 阶段后，问题从「功能缺失」变成了「**偶发质量抖动**」——主叙事偶发
 * 失败、结构化回复偶发缺失、回复模式分布异常、前缀缓存没命中、延迟突然变长。
 * 这些都不报错、不崩溃，只是"感觉不对劲"，靠翻日志很难判断趋势。
 *
 * 健康面板把关键指标做成**内存滚动计数器**，在 `/interlude status` 里追加一段，
 * 一眼看出「最近这一段时间到底稳不稳」。
 *
 * ## 设计取舍（与上游一致）
 *
 * - **不持久化**：重载后归零，`sinceAt` 标注统计起点。这是刻意的——它回答的是
 *   「**本次运行**以来怎么样」，不是历史审计。落盘反而会让人误读为长期趋势。
 * - **按故事分桶**：每个会话（= 一个故事）一套计数，互不干扰。
 * - **延迟只留最近 N 条**：中位数不需要全量样本，无界增长会吃内存。
 *
 * @module dsh-hds-interlude/health
 */

/** 延迟样本上限（超出后丢弃最旧的）。 */
export const MAX_LATENCIES = 200

/** 一份新的计数状态。 */
function newState(now = Date.now()) {
  return {
    narrativeTotal: 0,
    narrativeFailed: 0,
    structureMissing: 0,
    recoverySaved: 0,
    replyModes: { immediate: 0, none: 0, delayed: 0, noDelivery: 0 },
    sideTaskTotal: 0,
    sideTaskFailed: 0,
    proactiveTotal: 0,
    proactiveSent: 0,
    inputTokens: 0,
    cachedTokens: 0,
    latenciesMs: [],
    startedAt: new Date(now),
  }
}

/**
 * 按故事分桶的滚动健康指标。
 *
 * 所有 `record*` 方法都会**按需建桶**，调用方不必先初始化。
 */
export class HealthMonitor {
  constructor(now = Date.now()) {
    /** @type {Map<string, object>} */
    this.stories = new Map()
    this.now = now
  }

  state(storyId) {
    const key = String(storyId ?? '')
    let state = this.stories.get(key)
    if (!state) {
      state = newState(typeof this.now === 'function' ? this.now() : this.now)
      this.stories.set(key, state)
    }
    return state
  }

  /**
   * 记一次主叙事完成。
   *
   * @param {string} storyId 故事 id。
   * @param {number} latencyMs 本次耗时（毫秒）。
   * @param {string} replyMode 回复模式（immediate/none/delayed/其它视为无投递）。
   */
  recordNarrativeComplete(storyId, latencyMs, replyMode) {
    const s = this.state(storyId)
    s.narrativeTotal += 1
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      s.latenciesMs.push(latencyMs)
      if (s.latenciesMs.length > MAX_LATENCIES) s.latenciesMs.shift()
    }
    if (replyMode === 'immediate') s.replyModes.immediate += 1
    else if (replyMode === 'none') s.replyModes.none += 1
    else if (replyMode === 'delayed') s.replyModes.delayed += 1
    else s.replyModes.noDelivery += 1
  }

  /** 记一次主叙事失败。 */
  recordNarrativeFailed(storyId) {
    this.state(storyId).narrativeFailed += 1
  }

  /**
   * 记一次「结构化回复缺失」。
   *
   * 注意与 `recordRecoverySaved` 的分工：首稿缺失计这里，恢复稿通过才计那里。
   * 两者混在一个分支里会算出失真的挽回率（上游 rc2 修过这个）。
   */
  recordStructureMissing(storyId) {
    this.state(storyId).structureMissing += 1
  }

  /** 记一次「恢复稿成功挽回」。 */
  recordRecoverySaved(storyId) {
    this.state(storyId).recoverySaved += 1
  }

  /** 记一次侧端任务（成功/失败）。 */
  recordSideTask(storyId, ok) {
    const s = this.state(storyId)
    s.sideTaskTotal += 1
    if (!ok) s.sideTaskFailed += 1
  }

  /** 记一次主动联系尝试（是否真的送出去了）。 */
  recordProactive(storyId, sent) {
    const s = this.state(storyId)
    s.proactiveTotal += 1
    if (sent) s.proactiveSent += 1
  }

  /** 记一次 Token 用量（输入 / 缓存命中）。 */
  recordTokens(storyId, input, cached) {
    const s = this.state(storyId)
    if (Number.isFinite(input)) s.inputTokens += input
    if (Number.isFinite(cached)) s.cachedTokens += cached
  }

  /**
   * 取某个故事的快照（含派生率值）。
   *
   * @param {string} storyId 故事 id。
   * @returns {object} 快照。
   */
  snapshot(storyId) {
    const s = this.state(storyId)
    const total = s.narrativeTotal + s.narrativeFailed
    const sorted = [...s.latenciesMs].sort((a, b) => a - b)
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    return {
      narrativeTotal: s.narrativeTotal,
      narrativeFailed: s.narrativeFailed,
      structureMissing: s.structureMissing,
      recoverySaved: s.recoverySaved,
      replyModes: { ...s.replyModes },
      sideTaskTotal: s.sideTaskTotal,
      sideTaskFailed: s.sideTaskFailed,
      proactiveTotal: s.proactiveTotal,
      proactiveSent: s.proactiveSent,
      inputTokens: s.inputTokens,
      cachedTokens: s.cachedTokens,
      latenciesMs: [...s.latenciesMs],
      sinceAt: s.startedAt.toISOString(),
      // 派生指标：分母为 0 时的取值与上游一致（成功率 1、其余 0），
      // 表示「还没有样本，不构成问题」而不是「0% 成功」。
      successRate: total ? s.narrativeTotal / total : 1,
      structureMissingRate: s.narrativeTotal ? s.structureMissing / s.narrativeTotal : 0,
      cacheHitRate: s.inputTokens ? s.cachedTokens / s.inputTokens : 0,
      proactiveRate: s.proactiveTotal ? s.proactiveSent / s.proactiveTotal : 0,
      medianLatencyMs: median,
    }
  }

  /** 全部故事快照：`{ storyId: snapshot }`。 */
  all() {
    const out = {}
    for (const [id] of this.stories) out[id] = this.snapshot(id)
    return out
  }
}

/**
 * 把快照渲染成 `/interlude status` 尾部的一段可读文本。
 *
 * @param {object} snapshot `HealthMonitor#snapshot` 的返回值。
 * @param {object} [labels] 可选的标题文案。
 * @returns {string} 多行文本。
 */
export function renderHealthSection(snapshot, labels = {}) {
  if (!snapshot) return ''
  const pct = (value) => `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`
  const modes = snapshot.replyModes ?? {}
  const lines = [
    labels.title ?? '运行健康（本次运行以来，重载后归零）',
    `  主叙事：成功 ${snapshot.narrativeTotal} / 失败 ${snapshot.narrativeFailed}`
      + `（成功率 ${pct(snapshot.successRate)}，中位延迟 ${Math.round(snapshot.medianLatencyMs)}ms）`,
    `  结构化回复：缺失 ${snapshot.structureMissing}（${pct(snapshot.structureMissingRate)}）`
      + ` / 挽回 ${snapshot.recoverySaved}`,
    `  回复模式：即时 ${modes.immediate ?? 0} · 沉默 ${modes.none ?? 0}`
      + ` · 延迟 ${modes.delayed ?? 0} · 无投递 ${modes.noDelivery ?? 0}`,
    `  侧端任务：${snapshot.sideTaskTotal} 次（失败 ${snapshot.sideTaskFailed}）`,
    `  主动联系：${snapshot.proactiveSent} / ${snapshot.proactiveTotal}（${pct(snapshot.proactiveRate)}）`,
    `  前缀缓存：命中 ${snapshot.cachedTokens} / 输入 ${snapshot.inputTokens}（${pct(snapshot.cacheHitRate)}）`,
    `  统计起点：${snapshot.sinceAt}`,
  ]
  return lines.join('\n')
}

/**
 * 意图生命周期（移植自上游 `src/script/intent-lifecycle.ts`）。
 *
 * ## 它解决什么问题
 *
 * DSH 的待办（intents）里有几类是**由插件自己的执行器处理的**，不该被
 * 「模型这一轮没提到它」当成已消费：
 *   - `split-message`：分条发送，通道自己会发完；
 *   - `browser-research`：网页调研，有自己的执行器；
 *   - `proactive-check`：主动联系检查，由后台扫描负责；
 *   - `active-consequence`：剧情余波，自然过期而非"被说掉"。
 *
 * 如果不区分，模型只要有一轮没提到它们，就会被判成「已消费」而清理掉——
 * 那些待办就此**静默消失**。这是只有「谁负责完成它」这个概念才能解决的问题。
 *
 * ## 另一条规则
 *
 * `follow-up-commitment`（承诺回访）**永远不由"消费"关闭**：它是一条真实的承诺，
 * 只能通过到期投递或显式关闭来结清。所以 `consumedLiveIntentIds` 把它排除在外。
 *
 * @module dsh-hds-interlude/intent-lifecycle
 */

/** 这几类有自己的执行器，不归「当前这一轮叙述」管。 */
export const DERIVED_INTENT_TYPES = ['split-message', 'browser-research', 'proactive-check', 'active-consequence']

/** 不能靠「被消费」关闭的类型——它们是真实承诺，只能到期投递或显式结清。 */
export const NON_CONSUMABLE_TYPES = ['follow-up-commitment']

/**
 * 只留下「归当前这一轮叙述负责」的意图。
 *
 * @param {Array<object>} intents 意图列表。
 * @returns {Array<object>} 过滤后的列表。
 */
export function liveNarrativeIntents(intents) {
  return (Array.isArray(intents) ? intents : [])
    .filter(intent => intent && !DERIVED_INTENT_TYPES.includes(intent.type))
}

/**
 * 这一轮**可以被消费掉**的意图 id。
 *
 * 在 `liveNarrativeIntents` 的基础上再排除承诺型——它们只能靠到期投递或
 * 显式关闭结清，不能被"这一轮说到了"消费掉。
 *
 * @param {Array<object>} intents 意图列表。
 * @returns {string[]} 可消费的 id。
 */
export function consumedLiveIntentIds(intents) {
  return liveNarrativeIntents(intents)
    .filter(intent => !NON_CONSUMABLE_TYPES.includes(intent.type))
    .map(intent => intent.id)
}

/**
 * 这条意图是否由插件自己的执行器负责。
 *
 * @param {object} intent 意图。
 * @returns {boolean}
 */
export function isDerivedIntent(intent) {
  return DERIVED_INTENT_TYPES.includes(intent?.type)
}

/**
 * 这条意图能不能被「本轮叙述提到过」消费掉。
 *
 * 与 {@link consumedLiveIntentIds} 同一判据，做成单条查询便于调用点直接判断。
 *
 * @param {object} intent 意图。
 * @returns {boolean}
 */
export function isConsumableIntent(intent) {
  if (!intent) return false
  if (DERIVED_INTENT_TYPES.includes(intent.type)) return false
  if (NON_CONSUMABLE_TYPES.includes(intent.type)) return false
  return true
}

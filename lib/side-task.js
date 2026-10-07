/**
 * sideTaskJson —— 侧端 JSON 任务共享通道（移植自上游 `src/narrator.ts` 的
 * `sideTaskJson`，1.0.1-beta5-ostt 核心修复）。
 *
 * ## 它解决什么
 *
 * 思考型网关（如 gemini-3.7 系）把 **reasoning 计入 completion 预算**：带小
 * `max_tokens` cap 的侧端 JSON 任务会被推理挤到只剩残句（实测 Alter 错误率
 * 5%→31%）。上游的修法是统一一条通道：**首次输出不可解析时去掉 max_tokens
 * 原样重试一次**——成功路径零额外请求。
 *
 * 五个侧端任务共用这条通道：压缩、时间导演、日程预排、Overlay 整理、Alter 分析。
 *
 * ## 与上游的差异（DSH 形态）
 *
 * 上游的通道直接持有 Koishi 的 http 与 provider 路由。DSH 插件没有独立模型
 * 调用权（模型由宿主提供），所以这里把通道拆成两层：
 *   - **执行器** `sideTaskJson`：只负责「跑一次 → 不可解析 → 去掉 cap 再跑一次」，
 *     真正的网络调用由调用方注入的 `run(capped)` 完成；
 *   - **解析器** `chatTextCandidates`：多文本字段宽容提取（content /
 *     reasoning_content / refusal / text / output_text 逐一尝试）。
 *
 * 这样无论将来谁拿到模型调用权（宿主暴露 LLM 服务、或插件直连网关），
 * 都能直接复用这套「思考预算容错」语义。
 *
 * @module dsh-hds-interlude/side-task
 */

/** 触发重试的解析错误特征（与上游一致，并覆盖 JSON.parse 的原生报错形态）。 */
const RETRYABLE_PATTERN = /invalid JSON|Unterminated|Unexpected|empty response/i

/**
 * 从一条 Chat Completion 响应里宽容提取全部文本候选字段。
 *
 * 思考型网关可能把有效 JSON 放在 `reasoning_content` 里、把占位说明放在
 * `content` 里（或反过来）。逐字段尝试解析，与上游一致。
 *
 * @param {unknown} response 响应对象。
 * @returns {string[]} 候选文本（去空去重，保持字段顺序）。
 */
export function chatTextCandidates(response) {
  const r = response && typeof response === 'object' ? response : {}
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) candidates.push(value)
  }
  const choices = Array.isArray(r.choices) ? r.choices : []
  for (const choice of choices) {
    const message = choice && typeof choice === 'object' ? choice.message : undefined
    if (message && typeof message === 'object') {
      push(message.content)
      push(message.reasoning_content)
      push(message.reasoning)
      push(message.refusal)
      push(message.text)
      push(message.output_text)
    }
    // 部分网关把文本直接挂在 choice 上
    push(choice.text)
    push(choice.output_text)
  }
  // 顶层兜底（流式聚合后的简化形态）
  push(r.content)
  push(r.text)
  push(r.output_text)
  return [...new Set(candidates)]
}

/**
 * 错误信息是否属于「可重试的思考预算截断」。
 *
 * @param {unknown} error 抛出的错误。
 * @returns {boolean}
 */
export function isSideTaskRetryable(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return RETRYABLE_PATTERN.test(message)
}

/**
 * 侧端 JSON 任务共享通道。
 *
 * @param {object} options
 * @param {string} options.task 任务名（日志用）。
 * @param {Function} options.run `async (capped: boolean) => string` 执行一次调用，
 *   返回**原始文本**；`capped=true` 时带上 `max_tokens`，`false` 时去掉。
 * @param {Function} options.parse `(text: string) => T` 解析文本为结构化结果；
 *   不可解析时抛错。
 * @param {Function} [options.warn] 日志回调 `(message: string) => void`。
 * @param {Array} [options.usageSink] 可选的用量收集数组（聚合场景由调用方统一上报）。
 * @returns {Promise<T>} 解析结果。
 * @template T
 */
export async function sideTaskJson({ task, run, parse, warn, usageSink }) {
  const log = typeof warn === 'function' ? warn : () => {}
  const runOnce = async (capped) => {
    const text = await run(capped)
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`${task} provider returned an empty response.`)
    }
    let lastError
    let sawText = false
    for (const candidate of chatTextCandidates({ content: text })) {
      sawText = true
      try {
        return parse(candidate)
      } catch (error) {
        lastError = error
      }
    }
    if (!sawText) throw new Error(`${task} provider returned an empty response.`)
    throw lastError ?? new Error(`${task} provider returned invalid JSON.`)
  }
  try {
    try {
      return await runOnce(true)
    } catch (error) {
      if (!isSideTaskRetryable(error)) throw error
      log(`${task} 首次输出不可解析（疑似思考预算截断），已去掉 max_tokens 重试一次 错误=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`)
      return await runOnce(false)
    }
  } finally {
    // usageSink 由调用方统一上报；无 sink 时这里无事可做（DSH 形态无独立用量）。
    if (usageSink) void usageSink
  }
}

/**
 * 直接解析一段可能是 JSON 的文本；不可解析时抛「invalid JSON」特征错误。
 *
 * 供解析器复用：把「这不是 JSON」统一映射成可重试特征，避免各任务各写一套。
 *
 * @param {string} text 原始文本。
 * @param {string} task 任务名（错误信息用）。
 * @returns {unknown} 解析结果。
 */
export function parseJsonOrThrow(text, task) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`${task} provider returned an empty response.`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${task} provider returned invalid JSON. ${error instanceof Error ? error.message : String(error)}`)
  }
}

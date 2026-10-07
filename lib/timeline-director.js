/**
 * 时间导演主体（移植自上游 `src/service.ts` 的 `planAutomaticTimeline` +
 * `normalizeTimelinePlan` + `describeTimelinePlanRejection`）。
 *
 * ## 它解决什么
 *
 * 自动生活推进不能由自由散文自行决定「世界时间」——否则角色会写飞（跳到下周、
 * 双倍推进同一段生活）。上游的解法是「时间导演 → 主叙事」双层：先让一个便宜
 * 模型给当前窗口生成 1–4 个**相对时间事件账本**（beats），主叙事再照着账本写。
 * 账本失败时保留游标等待重试（或熔断降级为无账本守恒推进），不让散文决定时间。
 *
 * ## 与上游的差异（DSH 形态）
 *
 * 上游的时间导演是一次**独立侧端模型调用**（走压缩路由）。DSH 插件没有独立
 * 模型调用权，所以这里改成**同一轮自动推进的提示内完成**：
 *   - `renderTimelineDirectorRequest` 在自动推进 notice 里追加一段「账本请求」，
 *     要求模型在正文前输出一个 JSON 块（`<timeline_plan>{...}</timeline_plan>`）；
 *   - `parseTimelinePlanFromText` 从捕获文本里提取该块、规范化，并把块**从正文中
 *     剥离**（不污染故事本身）；
 *   - 解析失败时返回 undefined，调用方照常走退避/熔断（`timeline-guard.js`）。
 *
 * 语义对齐点：beats 是**建议**不是既成事实（上游 beta6「导演 beats/carry 是
 * 建议而非既成事实」）；账本只含客观时间事实与可能的时间逻辑，不做笃定的
 * 未来预测（1.0.1-beta1~3-ostt 轻量化）。
 *
 * @module dsh-hds-interlude/timeline-director
 */

/** 账本块的最大捕获字符数（防止模型输出超长垃圾占满内存）。 */
const MAX_CAPTURE = 4000

/** 可接受的 kind 近义映射（与上游 `TIMELINE_KIND_ALIASES` 一致）。 */
const KIND_ALIASES = {
  activity: 'activity', action: 'activity', event: 'activity', scene: 'activity', behavior: 'activity',
  thought: 'thought', think: 'thought', feeling: 'thought', mood: 'thought', inner: 'thought',
  state: 'state', status: 'state', condition: 'state',
  活动: 'activity', 行动: 'activity', 事件: 'activity', 场景: 'activity',
  想法: 'thought', 心情: 'thought', 思绪: 'thought',
  状态: 'state',
}

/** 宽容解析 kind：近义标签映射到三个合法值之一；未知回退 activity（与上游一致）。 */
export function coerceTimelineKind(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  return KIND_ALIASES[normalized] ?? 'activity'
}

/** 宽容解析位置：数字 / 数字字符串 / 百分比字符串 → [0,1]；非法返回 NaN。 */
export function coerceTimelinePosition(value) {
  if (typeof value === 'number') return Math.max(0, Math.min(1, value))
  if (typeof value === 'string') {
    const text = value.trim().replace(/%$/, '')
    const parsed = Number(text)
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed <= 1 ? parsed : parsed / 100))
  }
  return Number.NaN
}

const clip = (text, limit) => String(text ?? '').slice(0, limit)

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const record = (value) => isRecord(value) ? value : {}

/**
 * 只解析狭窄的事件账本形状。未知字段与空计划在成为世界状态来源之前就被丢弃。
 *
 * @param {unknown} value 模型返回。
 * @returns {object|undefined} `{beats, carry?}`；非法/空返回 undefined。
 */
export function normalizeTimelinePlan(value) {
  const source = record(value)
  if (!Array.isArray(source.beats)) return undefined
  const beats = source.beats
    .filter(record)
    .map((item) => ({
      at: coerceTimelinePosition(item.at),
      kind: coerceTimelineKind(item.kind),
      summary: typeof item.summary === 'string' ? clip(item.summary, 240).trim() : '',
    }))
    .filter((item) => Number.isFinite(item.at) && Boolean(item.kind) && Boolean(item.summary))
    .sort((left, right) => left.at - right.at)
    .slice(0, 4)
  if (!beats.length) return undefined
  const carry = Array.isArray(source.carry)
    ? source.carry.filter((item) => typeof item === 'string').map((item) => clip(item, 180).trim()).filter(Boolean).slice(0, 4)
    : []
  return { beats, ...(carry.length ? { carry } : {}) }
}

/** 人类可读的拒绝原因（用于 warn 日志）。 */
export function describeTimelinePlanRejection(value) {
  if (!isRecord(value)) return '返回不是 JSON 对象'
  if (!Array.isArray(value.beats)) return '缺少 beats 数组'
  if (!value.beats.length) return 'beats 为空数组（模型未产出任何节点）'
  const details = value.beats.filter(record).map((item) => {
    const problems = []
    const at = coerceTimelinePosition(item.at)
    if (!Number.isFinite(at)) problems.push(`at=${JSON.stringify(item.at)} 无法解析`)
    if (!coerceTimelineKind(item.kind)) problems.push(`kind=${JSON.stringify(item.kind)} 非法`)
    if (typeof item.summary !== 'string' || !item.summary.trim()) problems.push('summary 为空')
    return problems.join('，') || '通过'
  })
  return `节点校验详情：${details.join('；')}`
}

/** 自动推进 notice 里追加的「账本请求」段。 */
export function renderTimelineDirectorRequest() {
  return [
    '',
    '<timeline_plan>',
    '在开始写正文之前，先给这段时间（上一段结束 → 当前时刻）安排 1–4 个事件节点，',
    '输出一个 JSON：{"beats":[{"at":"0.0~1.0 之间的相对位置","kind":"activity|thought|state","summary":"一句话客观描述"}],"carry":["需要延续到下一轮的时间线事实（最多 4 条，可省略）"]}',
    '只写时间账本，不写预测；把这一整段 JSON 放在 <timeline_plan> 与 </timeline_plan> 之间，',
    '然后再写正文。账本只用来对齐时间线，正文才是故事。',
    '</timeline_plan>',
  ].join('\n')
}

/**
 * 从捕获文本里提取时间账本块，并把块从正文中剥离。
 *
 * @param {string} text 模型输出的完整捕获文本。
 * @returns {{plan: object|undefined, body: string, raw: unknown|undefined}}
 *   - `plan`：规范化后的账本（非法/缺失为 undefined）；
 *   - `body`：去掉账本块后的正文（保持原样，不含块）；
 *   - `raw`：模型原始输出（供拒绝诊断）。
 */
export function parseTimelinePlanFromText(text) {
  const source = String(text ?? '')
  const block = /<timeline_plan>([\s\S]*?)<\/timeline_plan>/i.exec(source)
  if (!block) {
    return { plan: undefined, body: source, raw: undefined }
  }
  const rawText = block[1].trim().slice(0, MAX_CAPTURE)
  const body = source.slice(0, block.index) + source.slice(block.index + block[0].length)
  let raw
  try {
    raw = rawText ? JSON.parse(rawText) : undefined
  } catch {
    raw = { _unparsed: rawText }
  }
  const plan = normalizeTimelinePlan(raw)
  return { plan, body: body.trim(), raw }
}

/**
 * 把账本投影成下一轮的「宿主时间线」说明（上游 `timelineEntryPromptProjection`）。
 *
 * 自动推进的正文是**渲染**，不是下一轮的时间来源；宿主账本保留真实顺序，
 * 避免上一段被复制进新的时间窗口。
 *
 * @param {object|undefined} plan 账本。
 * @returns {string} 投影说明；无账本时为空串。
 */
export function renderTimelineLedgerLine(plan) {
  if (!plan || !Array.isArray(plan.beats) || !plan.beats.length) return ''
  const beats = plan.beats.map((beat) => `${Math.round(beat.at * 100)}% ${beat.kind}: ${beat.summary}`).join(' | ')
  const carry = Array.isArray(plan.carry) && plan.carry.length ? ` Carry: ${plan.carry.join(' | ')}` : ''
  return `[宿主时间线账本：${beats}.${carry}]`
}

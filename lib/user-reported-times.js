/**
 * 用户报时提取（移植自上游 `1.0.1-rc13` 修复后的
 * `service.ts` 的 `extractUserReportedTimes`，含 `chineseClockNumber`）。
 *
 * ## 它解决什么
 *
 * 用户说「我十点下班」「八点半开会」「下午三点见」，那是**事实**：角色该知道
 * 对方几点有空、几点在忙。但主模型读到的是一整段话，时间表达散落其中、还可能
 * 有歧义（「6.30」是早上还是傍晚？）。这里把它抽成**克制的客观事实**
 * ——只抽明确写出来的钟点，不做任何推测（上游原话：`a small factual aid,
 * not an attempt to infer every temporal expression`），上限 4 条。
 *
 * 每条事实带 `relation`（past / future / current，相对故事当前时钟）与
 * `statement`（原话片段，供溯源与守卫理解上下文）。
 *
 * ## 覆盖三种写法（与上游一致）
 *
 * 1. **数字钟点**：`18:30` / `18：30` / `18.30` / `6点30` / `6点半`；
 *    带「下午/晚上」前缀时小时 +12；**没有前缀且小时 <12 时**，取「离当前
 *    故事时钟更近的那个解释」——傍晚收到「6.30」按 18:30 理解，而不是
 *    把 06:30 当成遥远的下一次。
 * 2. **时段词**：早上/上午/中午/下午/傍晚/晚上 → 该时段的代表性钟点
 *    （8 / 9 / 12 / 15 / 18 / 20），用来理解「中午一起吃饭」这类约定。
 * 3. **中文数字钟点**：`八点` / `八点半` / `九点一刻` 的口语写法
 *    —— **这正是 rc13 修的缺陷**：此前「八点半」被解析成 8:00。
 *
 * ## 与解析器（`lib/commitment.js`）的分工
 *
 * 这里**不做**「多久之后」的相对时间解析（那是承诺回路的事，输出的是分钟数），
 * 也不判断「是不是承诺」。两者互不替代：一个是「对方几点」的客观事实，
 * 一个是「我答应了多久以后做」。
 *
 * @module dsh-hds-interlude/user-reported-times
 */

/** 中文数字（含「两」的两种写法）。 */
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 时段词 → 代表性钟点（上游表，逐字对齐）。 */
export const PERIOD_HOURS = { 早上: 8, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20 }

/** 单条事实保留的原话片段长度上限（上游 `clip(statement, 240)`）。 */
const STATEMENT_MAX = 240

/** 最多抽几条（上游 `facts.slice(0, 4)`）。 */
export const MAX_USER_REPORTED_TIMES = 4

/**
 * 中文数字钟点（`八`→8、`十`→10、`十一`→11、`二十`→20）。
 * 逐字移植上游 `chineseClockNumber`；无法解析返回 `undefined`（调用方跳过）。
 *
 * @param {string} value 中文数字串。
 * @returns {number|undefined}
 */
export function chineseClockNumber(value) {
  const text = String(value ?? '')
  if (text === '十') return 10
  if (text.includes('十')) {
    const [left, right] = text.split('十')
    const tens = left ? CN_DIGITS[left] : 1
    const ones = right ? CN_DIGITS[right] : 0
    return tens === undefined || ones === undefined ? undefined : tens * 10 + ones
  }
  return text.length === 1 ? CN_DIGITS[text] : undefined
}

/**
 * 从一条实时用户消息里抽**明确写出的钟点**（对齐上游 `extractUserReportedTimes`）。
 *
 * @param {string} content 用户消息原文。
 * @param {Date|number} now 当前时刻。
 * @param {string} timezone 故事时区。
 * @param {{localClockMinutes: Function, calendarDayKey: Function}} [clock] 时钟工具（缺省用本仓 clock.js）。
 * @returns {Array<{localTime: string, relation: 'past'|'future'|'current', statement: string}>}
 */
export function extractUserReportedTimes(content, now, timezone, clock) {
  const text = String(content ?? '')
  if (!text) return []
  const { localClockMinutes, calendarDayKey } = clock ?? {}
  if (typeof localClockMinutes !== 'function' || typeof calendarDayKey !== 'function') {
    throw new Error('extractUserReportedTimes 需要 clock 工具（localClockMinutes / calendarDayKey）')
  }
  const at = now instanceof Date ? now : new Date(now)
  const currentMinutes = localClockMinutes(at, timezone)
  const date = calendarDayKey(at, timezone)
  const facts = []
  const seen = new Set()

  const add = (hour, minute, statement) => {
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return
    const clockText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    const relation = hour * 60 + minute < currentMinutes ? 'past'
      : hour * 60 + minute > currentMinutes ? 'future' : 'current'
    const key = `${clockText}:${statement}`
    if (seen.has(key)) return
    seen.add(key)
    facts.push({ localTime: `${date} ${clockText}`, relation, statement: statement.slice(0, STATEMENT_MAX).trim() })
  }
  const clipAround = (index, length) => text.slice(Math.max(0, index - 48), Math.min(text.length, index + length + 96))

  // ① 数字钟点（含「半」）。
  for (const match of text.matchAll(/(?:今天|今晚|下午|晚上|早上|上午)?\s*(\d{1,2})\s*(?:[:：.]|点)\s*(\d{2}|半)?/g)) {
    let hour = Number(match[1])
    const minute = match[2] === '半' ? 30 : match[2] ? Number(match[2]) : 0
    const prefix = match[0]
    if ((prefix.includes('下午') || prefix.includes('晚上')) && hour < 12) hour += 12
    else if (!/(?:早上|上午|下午|晚上|中午)/.test(prefix) && hour > 0 && hour < 12) {
      // 裸「6.30」有歧义：取**离当前故事时钟更近**的解释。
      const morning = hour * 60 + minute
      const evening = (hour + 12) * 60 + minute
      if (Math.abs(evening - currentMinutes) < Math.abs(morning - currentMinutes)) hour += 12
    }
    add(hour, minute, clipAround(match.index, match[0].length))
  }

  // ② 时段词：代表性钟点锚点（供守卫与提示词理解「中午一起吃饭」）。
  for (const match of text.matchAll(/(早上|上午|中午|下午|傍晚|晚上)/g)) {
    const hour = PERIOD_HOURS[match[1]]
    if (hour === undefined) continue
    add(hour, 0, clipAround(match.index, match[0].length))
  }

  // ③ 中文数字钟点（「八点」「八点半」「九点一刻」）—— rc13 修复的那一类。
  for (const match of text.matchAll(/([零一二三四五六七八九十两]+)点(?:(?:零|([零一二三四五六七八九十两]+))分?|(半))?/g)) {
    const hour = chineseClockNumber(match[1])
    const minute = match[3] === '半' ? 30 : match[2] ? chineseClockNumber(match[2]) : 0
    if (hour === undefined || minute === undefined) continue
    add(hour, minute, clipAround(match.index, match[0].length))
  }

  return facts.slice(0, MAX_USER_REPORTED_TIMES)
}

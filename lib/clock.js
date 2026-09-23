/**
 * 幕间时钟 —— 忠实移植自 hds-interlude 的 src/time.ts。
 *
 * 原模块职责：时区校验、本地时间端点、日照时段、复用的 Intl formatter 缓存。
 * 本移植保持函数名与语义逐行一致，仅去除 TypeScript 类型标注，改为 ESM + JSDoc。
 *
 * @module dsh-hds-interlude/clock
 */

const formatterCache = new Map()
const timezoneCache = new Map()

function formatter(kind, locale, timezone, options) {
  const resolved = resolveTimezone(timezone)
  const key = `${kind}:${locale}:${resolved}`
  const existing = formatterCache.get(key)
  if (existing) return existing
  const created = new Intl.DateTimeFormat(locale, { ...options, timeZone: resolved })
  formatterCache.set(key, created)
  return created
}

/** 规范化时区名；非法时区回退为 UTC。 */
export function resolveTimezone(timezone) {
  const candidate = timezone?.trim() || 'UTC'
  const cached = timezoneCache.get(candidate)
  if (cached !== undefined) return cached ? candidate : 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0)
    timezoneCache.set(candidate, true)
    return candidate
  } catch {
    timezoneCache.set(candidate, false)
    return 'UTC'
  }
}

/** 把某个时刻翻译成角色能理解的时间事实（本地日期、时分秒、星期、时段、日照预期）。 */
export function storyLocalTimeContext(value, timezone) {
  const resolvedTimezone = resolveTimezone(timezone)
  const parts = formatter('story', 'en-US', resolvedTimezone, {
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(value)
  const part = (type) => parts.find(item => item.type === type)?.value ?? ''
  const hour = Number(part('hour'))
  const period = hour >= 5 && hour < 12 ? 'morning'
    : hour >= 12 && hour < 18 ? 'afternoon'
      : hour >= 18 && hour < 22 ? 'evening'
        : 'night'
  const periodZh = ({ morning: '上午', afternoon: '下午', evening: '傍晚/晚上', night: '夜间' })[period]
  const daylightExpectation = period === 'morning' || period === 'afternoon'
    ? 'normally daylight unless current weather, season, or setting explicitly says otherwise'
    : period === 'evening'
      ? 'transitioning toward darkness; use the established season and setting'
      : 'normally dark outside unless the setting explicitly says otherwise'
  const date = `${part('year')}-${part('month')}-${part('day')}`
  const time = `${part('hour')}:${part('minute')}:${part('second')}`
  return {
    timezone: resolvedTimezone,
    utc: value.toISOString(),
    local: `${date} ${time}`,
    date,
    time,
    hour,
    weekday: part('weekday'),
    offset: part('timeZoneName'),
    period,
    periodZh,
    daylightExpectation,
  }
}

export function formatLogTime(value, timezone) {
  if (!value || Number.isNaN(value.getTime())) return '-'
  return formatter('log', 'zh-CN', timezone, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(value)
}

/** 面向用户的命令输出：附带配置的时区偏移，避免复制的时间线记录看起来像 UTC。 */
export function formatStoryDisplayTime(value, timezone) {
  if (!value || Number.isNaN(value.getTime())) return '-'
  const context = storyLocalTimeContext(value, timezone)
  return `${context.local} ${context.offset || 'GMT+0'}`
}

export function localClockMinutes(value, timezone) {
  const parts = formatter('clock', 'en-GB', timezone, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value)
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? value.getUTCHours())
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? value.getUTCMinutes())
  return hour * 60 + minute
}

export function calendarDayKey(value, timezone) {
  return formatter('day', 'en-CA', timezone, {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value)
}

export function timeFormatterCacheSize() {
  return formatterCache.size
}

/* -------------------------------------------------------------------------
 * DSH 入口辅助（适配层，非原 time.ts 内容）
 * ---------------------------------------------------------------------- */

/**
 * 解析插件配置时区。留空取进程时区；非法显式时区直接抛出（启动即暴露配置错误）。
 * 与原 time.ts 的 resolveTimezone（非法回退 UTC）分工不同：那个用于纯逻辑投影，
 * 这个用于 apply 入口的一次性校验。
 */
export function resolveZone(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) {
    return new Intl.DateTimeFormat('en-US', { timeZone: explicit.trim() }).resolvedOptions().timeZone
  }
  return new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
}

/** 把毫秒时长说成人话。 */
export function formatGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '不到 1 分钟'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const out = []
  if (days > 0) out.push(`${days} 天`)
  if (hours > 0) out.push(`${hours} 小时`)
  if (minutes > 0 && days === 0) out.push(`${minutes} 分钟`)
  return out.join(' ') || '不到 1 分钟'
}

/** 解析 HH:mm 为当日分钟数。 */
function timeMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/**
 * 判断当前本地时刻是否落在任一启用的休息窗口内（可跨午夜）。
 * @param now - epoch 毫秒。
 * @param timezone - IANA 时区。
 * @param restWindows - `[{ enabled, start:'HH:mm', end:'HH:mm' }]`。
 */
export function inRestWindow(now, timezone, restWindows) {
  const minute = localClockMinutes(new Date(now), timezone)
  for (const window of (restWindows ?? [])) {
    if (!window || window.enabled === false) continue
    const start = timeMinutes(window.start)
    const end = timeMinutes(window.end)
    if (start === undefined || end === undefined) continue
    if (start === end) continue
    if (start < end) {
      if (minute >= start && minute < end) return true
    } else {
      if (minute >= start || minute < end) return true
    }
  }
  return false
}

/** 判断两个 epoch 时刻是否落在同一本地日（用于主动联系配额按角色本地日重置）。 */
export function sameLocalDay(a, b, timezone) {
  return calendarDayKey(new Date(a), timezone) === calendarDayKey(new Date(b), timezone)
}

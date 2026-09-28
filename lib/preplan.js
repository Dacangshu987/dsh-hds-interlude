/**
 * Schedule Preplan（近期日程层）—— 忠实移植自 hds-interlude 的 src/schedule-preplan.ts。
 *
 * 原模块职责：周规律与例外合并、日期展开、半日投影、推进锚点。
 * 仅依赖 clock.js 的时间端点，纯逻辑可移植。
 *
 * @module dsh-hds-interlude/preplan
 */

import { calendarDayKey, localClockMinutes, storyLocalTimeContext } from './clock.js'

export const DEFAULT_SCHEDULE_PREPLAN_CONFIG = {
  enabled: true,
  horizonDays: 14,
  reviewAfterLocalHour: 3,
  anchorAutoAdvance: true,
  variationLevel: 'stable',
  candidateActivationProbability: 0.25,
  candidateRevealMinutes: 120,
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const KINDS = ['fixed', 'routine', 'flexible', 'open']
const PRIORITY = { fixed: 4, routine: 3, flexible: 2, open: 1 }

export function resolveSchedulePreplanConfig(value) {
  return {
    enabled: value?.enabled !== false,
    horizonDays: clampInt(value?.horizonDays, 3, 30, 14),
    reviewAfterLocalHour: clampInt(value?.reviewAfterLocalHour, 0, 23, 3),
    anchorAutoAdvance: value?.anchorAutoAdvance !== false,
    variationLevel: ['stable', 'contextual', 'granular'].includes(String(value?.variationLevel))
      ? value.variationLevel : 'stable',
    candidateActivationProbability: clampNumber(value?.candidateActivationProbability, 0.05, 0.5, 0.25),
    candidateRevealMinutes: clampInt(value?.candidateRevealMinutes, 15, 360, 120),
  }
}

export function normalizeSchedulePreplanRecord(value) {
  if (!isRecord(value) || typeof value.storyId !== 'string') return undefined
  const validFrom = dateKey(value.validFrom)
  const validThrough = dateKey(value.validThrough)
  if (!validFrom || !validThrough) return undefined
  return {
    storyId: value.storyId,
    revision: clampInt(value.revision, 0, 1_000_000, 0),
    timezone: text(value.timezone, 127) || 'UTC',
    validFrom,
    validThrough,
    lastReviewedLocalDate: dateKey(value.lastReviewedLocalDate) ?? '',
    lastEvidenceEntryId: clampInt(value.lastEvidenceEntryId, 0, Number.MAX_SAFE_INTEGER, 0),
    reviewReason: text(value.reviewReason, 500),
    regimes: normalizeRegimes(value.regimes),
    exceptions: normalizeExceptions(value.exceptions),
    materializedDays: normalizeDays(value.materializedDays),
    createdAt: validDate(value.createdAt) ?? new Date(0),
    updatedAt: validDate(value.updatedAt) ?? new Date(0),
  }
}

export function schedulePreplanReviewDue(record, now, timezone, config) {
  if (!config.enabled) return false
  const today = calendarDayKey(now, timezone)
  if (!record) return true
  if (record.timezone !== timezone) return true
  return record.lastReviewedLocalDate !== today && localClockMinutes(now, timezone) >= config.reviewAfterLocalHour * 60
}

export function schedulePreplanNeedsModel(record, evidence, today, timezone, config) {
  if (!record || record.timezone !== timezone) return true
  if (evidence.some(entry => entry.id > record.lastEvidenceEntryId)) return true
  if (!record.regimes.length) return false
  const coverageTarget = addDate(today, Math.max(1, config.horizonDays - 3))
  if (!record.regimes.some(regime => regime.from <= coverageTarget && (!regime.to || regime.to >= coverageTarget))) return true
  return record.validThrough < coverageTarget
}

export function refreshSchedulePreplan(record, today, timezone, config, now, reason = 'Daily review found no schedule-changing evidence.') {
  const validThrough = addDate(today, config.horizonDays - 1)
  return {
    ...record,
    timezone,
    validFrom: today,
    validThrough,
    lastReviewedLocalDate: today,
    reviewReason: reason,
    materializedDays: materializeSchedulePreplan(record.regimes, record.exceptions, today, config.horizonDays),
    updatedAt: now,
  }
}

export function applySchedulePreplanProposal(current, proposalValue, evidence, today, timezone, config, now, variationLevel = 'stable') {
  const proposal = normalizeProposal(proposalValue, new Set(evidence.map(entry => entry.id)), variationLevel)
  if (!proposal) return current ? refreshSchedulePreplan(current, today, timezone, config, now, 'Invalid proposal ignored; existing Schedule Preplan retained.') : undefined
  if (proposal.outcome === 'unchanged' && current) {
    return {
      ...refreshSchedulePreplan(current, today, timezone, config, now, proposal.reason),
      lastEvidenceEntryId: Math.max(current.lastEvidenceEntryId, ...evidence.map(entry => entry.id), 0),
    }
  }

  let regimes = current?.regimes ?? []
  let exceptions = current?.exceptions ?? []
  if (proposal.outcome === 'replace' || !current) {
    regimes = proposal.regimes ?? []
    exceptions = proposal.exceptions ?? []
  } else {
    regimes = mergeBy(regimes, proposal.regimes ?? [], item => item.id)
    exceptions = mergeBy(exceptions, proposal.exceptions ?? [], item => item.date)
  }
  if (!regimes.length) {
    if (!current) {
      return {
        storyId: '', revision: 1, timezone, validFrom: today, validThrough: addDate(today, config.horizonDays - 1),
        lastReviewedLocalDate: today,
        lastEvidenceEntryId: Math.max(...evidence.map(entry => entry.id), 0),
        reviewReason: proposal.reason,
        regimes: [], exceptions: [], materializedDays: [], createdAt: now, updatedAt: now,
      }
    }
    return refreshSchedulePreplan(current, today, timezone, config, now, 'Empty proposal ignored; existing Schedule Preplan retained.')
  }
  const validThrough = addDate(today, config.horizonDays - 1)
  return {
    storyId: current?.storyId ?? '',
    revision: (current?.revision ?? 0) + 1,
    timezone,
    validFrom: today,
    validThrough,
    lastReviewedLocalDate: today,
    lastEvidenceEntryId: Math.max(current?.lastEvidenceEntryId ?? 0, ...evidence.map(entry => entry.id), 0),
    reviewReason: proposal.reason,
    regimes: regimes.slice(-6),
    exceptions: exceptions.filter(item => item.date >= addDate(today, -1)).slice(-30),
    materializedDays: materializeSchedulePreplan(regimes, exceptions, today, config.horizonDays),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  }
}

export function materializeSchedulePreplan(regimes, exceptions, startDate, horizonDays) {
  const days = []
  for (let offset = 0; offset < Math.max(1, horizonDays); offset++) {
    const date = addDate(startDate, offset)
    const matching = regimes
      .filter(regime => regime.from <= date && (!regime.to || regime.to >= date))
      .sort((left, right) => right.from.localeCompare(left.from))[0]
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]
    let blocks = matching?.weekly[weekday]?.map(block => ({ ...block })) ?? []
    const exception = exceptions.find(item => item.date === date)
    if (exception?.mode === 'replace') blocks = exception.blocks?.map(block => ({ ...block })) ?? []
    else if (exception) {
      const removed = new Set(exception.removeBlockIds ?? [])
      blocks = [...blocks.filter(block => !removed.has(block.id)), ...(exception.blocks ?? []).map(block => ({ ...block }))]
    }
    days.push({ date, blocks: resolveOverlaps(blocks).slice(0, 12) })
  }
  return days
}

/**
 * 取用于窗口计算的物化天：缺 [今天, 明天] 时本地无模型重物化（上游 rc13 防线）。
 *
 * @param {object} record 日程记录。
 * @param {string} today 今天的日期键（故事时区）。
 * @param {string} timezone 故事时区。
 * @param {object} config 日程配置。
 * @returns {Array<object>} 物化天数组（原数组或本地重算结果）。
 */
function ensureWindowDays(record, today, timezone, config) {
  const days = Array.isArray(record.materializedDays) ? record.materializedDays : []
  const tomorrow = addDate(today, 1)
  const covered = days.some(day => day?.date === today || day?.date === tomorrow)
  if (covered) return days
  // 锚定**今天**重建（与上游「本地重物化（锚定今天）」一致）——不能用 days[0].date：
  // 滞后的正是最近两天，用旧起点重建仍然覆盖不到今天。
  const horizon = Math.max(2, config?.horizonDays ?? DEFAULT_SCHEDULE_PREPLAN_CONFIG.horizonDays)
  try {
    const rebuilt = materializeSchedulePreplan(record.regimes ?? [], record.exceptions ?? [], today, horizon)
    if (Array.isArray(rebuilt) && rebuilt.some(day => day?.date === today || day?.date === tomorrow)) return rebuilt
  } catch { /* 重物化失败就沿用原数据——好过让整个窗口抛错 */ }
  return days
}

/** 只投影未来约 12 小时；其余 horizon 不进入主提示词。 */export function schedulePreplanWindow(record, now, timezone, hours = 12, config = DEFAULT_SCHEDULE_PREPLAN_CONFIG) {
  if (!record || record.timezone !== timezone) return null
  const local = storyLocalTimeContext(now, timezone)
  const today = local.date
  const startMinute = local.hour * 60 + Number(local.time.slice(3, 5))
  const endMinute = startMinute + Math.max(1, hours) * 60
  // 物化滞后防线（移植自上游 `1.0.1-rc13`）：
  // 每日审查/退避/推迟都可能让 `materializedDays` 的 [今天, 明天] 槽位缺失，
  // 而下面的循环只取 dayOffset 0..1 → 窗口会**静默变空**（模型以为她没有日程，
  // 而且不报错、不留痕）。上游的做法是取窗口前先本地无模型重物化一次。
  //
  // 本仓刻意只**在内存里**重算这一天：本函数同时被提示词渲染路径（render.js）
  // 调用，从渲染里写状态会让纯投影变成有副作用的操作；下一次每日审查会把
  // 重物化结果正常落盘。可观测结果与上游一致：窗口不再凭空变空。
  const days = ensureWindowDays(record, today, timezone, config)
  const blocks = []
  for (const day of days) {
    const dayOffset = dateDifference(today, day.date)
    if (dayOffset < 0 || dayOffset > 1) continue
    for (const block of day.blocks) {
      const start = dayOffset * 1_440 + timeMinutes(block.start)
      let end = dayOffset * 1_440 + timeMinutes(block.end)
      if (end <= start) end += 1_440
      if (end <= startMinute || start >= endMinute) continue
      if (block.tentative) {
        if (!isTentativeBlockActive(record.storyId, day.date, block.id, config.candidateActivationProbability)) continue
        const minutesUntil = (start - startMinute)
        if (minutesUntil > config.candidateRevealMinutes) {
          blocks.push({ ...block, label: '可能的个人安排', location: undefined, date: day.date, tentative: true })
          continue
        }
      }
      blocks.push({ ...block, date: day.date })
    }
  }
  const toTotal = endMinute
  const toDate = addDate(today, Math.floor(toTotal / 1_440))
  const toClock = clock(toTotal % 1_440)
  return {
    name: 'Schedule Preplan', timezone,
    from: `${today} ${clock(startMinute)}`,
    to: `${toDate} ${toClock}`,
    plannedNotObserved: true,
    revision: record.revision,
    blocks: blocks.slice(0, 8),
  }
}

export function nextSchedulePreplanTransition(record, now, timezone, maxHours = 12) {
  const window = schedulePreplanWindow(record, now, timezone, maxHours)
  if (!window) return undefined
  const local = storyLocalTimeContext(now, timezone)
  const current = local.hour * 60 + Number(local.time.slice(3, 5))
  const candidates = []
  for (const block of window.blocks.filter(item => item.kind === 'fixed')) {
    const offset = dateDifference(local.date, block.date) * 1_440
    const start = offset + timeMinutes(block.start)
    let end = offset + timeMinutes(block.end)
    if (end <= start) end += 1_440
    if (start > current) candidates.push(start)
    if (end > current) candidates.push(end)
  }
  const next = candidates.sort((left, right) => left - right)[0]
  return next == null ? undefined : new Date(now.getTime() + (next - current) * 60_000)
}

function normalizeProposal(value, validEvidenceIds, variationLevel) {
  if (!isRecord(value) || !['unchanged', 'extend', 'patch', 'replace'].includes(String(value.outcome))) return undefined
  const outcome = value.outcome
  const reason = text(value.reason, 500)
  if (!reason) return undefined
  const sourceEntryIds = ids(value.sourceEntryIds).filter(id => validEvidenceIds.has(id))
  const allowTentative = variationLevel === 'granular'
  const regimes = normalizeRegimes(value.regimes, validEvidenceIds, allowTentative)
  const exceptions = normalizeExceptions(value.exceptions, validEvidenceIds, allowTentative)
  if ((outcome === 'patch' || outcome === 'replace') && validEvidenceIds.size && !sourceEntryIds.length && !regimes.some(item => item.sourceEntryIds?.length) && !exceptions.some(item => item.sourceEntryIds?.length)) return undefined
  return { outcome, reason, confidence: finite(value.confidence), sourceEntryIds, regimes, exceptions }
}

function normalizeRegimes(value, validEvidenceIds, allowTentative = true) {
  if (!Array.isArray(value)) return []
  return value.map(item => normalizeRegime(item, validEvidenceIds, allowTentative)).filter(Boolean).slice(0, 6)
}

function normalizeRegime(value, validEvidenceIds, allowTentative = true) {
  if (!isRecord(value) || !isRecord(value.weekly)) return undefined
  const id = slug(value.id, 80)
  const label = text(value.label, 120)
  const from = dateKey(value.from)
  const to = dateKey(value.to)
  if (!id || !label || !from || (to && to < from)) return undefined
  const weekly = {}
  for (const weekday of WEEKDAYS) {
    const blocks = normalizeBlocks(value.weekly[weekday], validEvidenceIds, allowTentative)
    if (blocks.length) weekly[weekday] = blocks
  }
  return { id, label, from, ...(to ? { to } : {}), weekly, sourceEntryIds: evidenceIds(value.sourceEntryIds, validEvidenceIds) }
}

function normalizeExceptions(value, validEvidenceIds, allowTentative = true) {
  if (!Array.isArray(value)) return []
  return value.map(item => normalizeException(item, validEvidenceIds, allowTentative)).filter(Boolean).slice(0, 30)
}

function normalizeException(value, validEvidenceIds, allowTentative = true) {
  if (!isRecord(value)) return undefined
  const date = dateKey(value.date)
  const mode = value.mode === 'replace' ? 'replace' : value.mode === 'patch' ? 'patch' : undefined
  const reason = text(value.reason, 300)
  if (!date || !mode || !reason) return undefined
  return {
    date, mode, reason,
    removeBlockIds: Array.isArray(value.removeBlockIds) ? value.removeBlockIds.map(item => slug(item, 80)).filter(Boolean).slice(0, 20) : [],
    blocks: normalizeBlocks(value.blocks, validEvidenceIds, allowTentative),
    sourceEntryIds: evidenceIds(value.sourceEntryIds, validEvidenceIds),
  }
}

function normalizeDays(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => isRecord(item) && dateKey(item.date)
    ? [{ date: dateKey(item.date), blocks: normalizeBlocks(item.blocks) }]
    : []).slice(0, 31)
}

function normalizeBlocks(value, validEvidenceIds, allowTentative = true) {
  if (!Array.isArray(value)) return []
  return value.map(item => normalizeBlock(item, validEvidenceIds, allowTentative)).filter(Boolean).slice(0, 20)
}

function normalizeBlock(value, validEvidenceIds, allowTentative = true) {
  if (!isRecord(value)) return undefined
  const id = slug(value.id, 80)
  const start = timeKey(value.start)
  const end = timeKey(value.end)
  const label = text(value.label, 160)
  const kind = KINDS.includes(value.kind) ? value.kind : undefined
  if (!id || !start || !end || start === end || !label || !kind) return undefined
  const location = text(value.location, 120)
  const tentative = allowTentative && value.tentative === true && (kind === 'flexible' || kind === 'open')
  return { id, start, end, label, kind, ...(location ? { location } : {}), ...(tentative ? { tentative: true } : {}), sourceEntryIds: evidenceIds(value.sourceEntryIds, validEvidenceIds) }
}

function isTentativeBlockActive(storyId, date, blockId, probability) {
  const input = `${storyId}|${date}|${blockId}`
  let hash = 2166136261
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619)
  return ((hash >>> 0) / 0x1_0000_0000) < probability
}

function resolveOverlaps(blocks) {
  const chosen = []
  for (const candidate of [...blocks].sort((left, right) => PRIORITY[right.kind] - PRIORITY[left.kind] || timeMinutes(left.start) - timeMinutes(right.start))) {
    const start = timeMinutes(candidate.start)
    let end = timeMinutes(candidate.end)
    if (end <= start) end += 1_440
    const overlaps = chosen.some(block => {
      const otherStart = timeMinutes(block.start)
      let otherEnd = timeMinutes(block.end)
      if (otherEnd <= otherStart) otherEnd += 1_440
      return start < otherEnd && end > otherStart
    })
    if (!overlaps && !chosen.some(block => block.id === candidate.id)) chosen.push(candidate)
  }
  return chosen.sort((left, right) => timeMinutes(left.start) - timeMinutes(right.start))
}

function evidenceIds(value, valid) {
  const normalized = ids(value)
  return valid ? normalized.filter(id => valid.has(id)) : normalized
}

function ids(value) {
  return Array.isArray(value) ? Array.from(new Set(value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 30) : []
}

function mergeBy(current, changes, key) {
  const merged = new Map(current.map(item => [key(item), item]))
  for (const item of changes) merged.set(key(item), item)
  return [...merged.values()]
}

function dateKey(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  const date = new Date(`${raw}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : undefined
}

function addDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function dateDifference(left, right) {
  return Math.round((new Date(`${right}T00:00:00.000Z`).getTime() - new Date(`${left}T00:00:00.000Z`).getTime()) / 86_400_000)
}

function timeKey(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{2}):(\d{2})$/.exec(raw)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined
  return raw
}

function timeMinutes(value) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function clock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function slug(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, limit) : ''
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ').slice(0, limit) : ''
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined
}

function validDate(value) {
  const date = value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') ? new Date(value) : undefined
  return date && !Number.isNaN(date.getTime()) ? date : undefined
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

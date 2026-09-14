/**
 * Alter System（情绪偏移追踪）—— 忠实移植自 hds-interlude 的 src/alter.ts。
 *
 * 原模块职责：Alter 状态规范化、纯状态转移、动态阈值、权重与提示词投影。
 * 完全无副作用、无平台依赖，仅做状态机与投影，因此可逐行移植。
 *
 * @module dsh-hds-interlude/alter
 */

const HOUR = 60 * 60 * 1000
const HISTORY_LIMIT = 50

/** 叙事四阶段（与原项目 NarrativePhase 一致）。 */
export const NARRATIVE_PHASES = ['advance', 'conversation-follow-up', 'user-message', 'intent-due']

export const DEFAULT_ALTER_SYSTEM_CONFIG = {
  enabled: false,
  baseThreshold: 10,
  densityFactor: 0.3,
  sameDirectionBoost: 0.05,
  oppositeDecay: 0.15,
  minWeight: 0.2,
  maxIntensity: 2,
  modelId: '',
  providerId: '',
  model: '',
  temperature: 0.3,
  topP: 1,
  maxTokens: 400,
  timeout: 30_000,
  prompt: '',
}

export function resolveAlterSystemConfig(value) {
  return { ...DEFAULT_ALTER_SYSTEM_CONFIG, ...value }
}

/** 把任意输入规整为 -5..+5 的整数；非法输入返回 undefined。 */
export function normalizeAlterValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(-5, Math.min(5, Math.round(value)))
}

export function createAlterSystemState(now = new Date()) {
  return {
    alterValue: 0,
    alterWeight: 0,
    lastTriggerDirection: 0,
    emotionalOffset: null,
    history: [],
    lastUpdatedAt: now.toISOString(),
  }
}

export function normalizeAlterSystemState(value) {
  if (!isRecord(value)) return undefined
  const history = Array.isArray(value.history)
    ? value.history.filter(isRecord).map((entry, index) => ({
      turn: Math.max(1, Math.floor(finiteNumber(entry.turn, index + 1))),
      phase: normalizePhase(entry.phase),
      alter: normalizeAlterValue(entry.alter) ?? 0,
      alterValue: clamp(finiteNumber(entry.alterValue, 0), -1_000, 1_000),
      timestamp: normalizedIso(entry.timestamp) ?? new Date(0).toISOString(),
    })).slice(-HISTORY_LIMIT)
    : []
  const emotionalOffset = isRecord(value.emotionalOffset) && typeof value.emotionalOffset.description === 'string'
    ? {
      direction: value.emotionalOffset.direction === 'relaxed' ? 'relaxed' : 'serious',
      description: value.emotionalOffset.description.trim().slice(0, 800),
      intensity: clamp(finiteNumber(value.emotionalOffset.intensity, 1), 0, 3),
      generatedAt: normalizedIso(value.emotionalOffset.generatedAt) ?? new Date(0).toISOString(),
    }
    : null
  const legacyDirection = Math.sign(finiteNumber(value.lastTriggerAlter, 0))
  const direction = Math.sign(finiteNumber(value.lastTriggerDirection, legacyDirection))
  return {
    alterValue: clamp(finiteNumber(value.alterValue, 0), -1_000, 1_000),
    alterWeight: clamp(finiteNumber(value.alterWeight, 0), 0, 1),
    lastTriggerDirection: direction,
    emotionalOffset,
    history,
    lastUpdatedAt: normalizedIso(value.lastUpdatedAt) ?? new Date(0).toISOString(),
    lastAnalysisAttemptAt: normalizedIso(value.lastAnalysisAttemptAt),
  }
}

/** 动态阈值：最近一小时叙事越密集，阈值越低（最低不低于基础阈值一半）。 */
export function calculateAlterThreshold(history, config, now = new Date()) {
  const oneHourAgo = now.getTime() - HOUR
  const turns = history.filter(entry => (dateValue(entry.timestamp)?.getTime() ?? 0) >= oneHourAgo).length
  const density = Math.min(turns / 10, 1)
  const base = Math.max(1, finiteNumber(config.baseThreshold, 10))
  const factor = clamp(finiteNumber(config.densityFactor, 0.3), 0, 1)
  return Math.max(base * 0.5, base * (1 - density * factor))
}

export function adjustAlterWeight(weight, sameDirection, magnitude, config) {
  const rate = sameDirection ? config.sameDirectionBoost : -config.oppositeDecay
  return clamp(weight + Math.max(0, magnitude) * finiteNumber(rate, 0), 0, 1)
}

export function advanceAlterSystem(current, alter, phase, now, config) {
  const state = current
    ? { ...current, history: [...current.history] }
    : createAlterSystemState(now)
  state.alterValue = clamp(state.alterValue + alter, -1_000, 1_000)
  const direction = Math.sign(alter)
  let offsetExpired = false
  if (state.emotionalOffset && direction) {
    state.alterWeight = adjustAlterWeight(
      state.alterWeight,
      direction === state.lastTriggerDirection,
      Math.abs(alter),
      config,
    )
    if (state.alterWeight < config.minWeight) {
      state.emotionalOffset = null
      state.alterWeight = 0
      offsetExpired = true
    }
  }
  state.history.push({
    turn: (state.history.at(-1)?.turn ?? 0) + 1,
    phase,
    alter,
    alterValue: state.alterValue,
    timestamp: now.toISOString(),
  })
  state.history = state.history.slice(-HISTORY_LIMIT)
  state.lastUpdatedAt = now.toISOString()
  const threshold = calculateAlterThreshold(state.history, config, now)
  return { state, threshold, offsetExpired, thresholdReached: Math.abs(state.alterValue) >= threshold }
}

export function completeAlterAnalysis(state, description, threshold, now, config) {
  const triggerValue = state.alterValue
  const direction = Math.sign(triggerValue)
  return {
    ...state,
    alterValue: 0,
    alterWeight: 1,
    lastTriggerDirection: direction,
    emotionalOffset: {
      direction: direction > 0 ? 'serious' : 'relaxed',
      description: description.trim().slice(0, 800),
      intensity: Math.min(Math.abs(triggerValue) / Math.max(1, threshold), config.maxIntensity),
      generatedAt: now.toISOString(),
    },
    lastUpdatedAt: now.toISOString(),
  }
}

export function emotionalOffsetForPrompt(state, config) {
  if (!config.enabled || !state?.emotionalOffset || state.alterWeight < config.minWeight) return null
  return { ...state.emotionalOffset, weight: state.alterWeight }
}

export function alterAnalysisCoolingDown(state, now = new Date(), cooldownMs = 5 * 60 * 1000) {
  const lastAttempt = dateValue(state.lastAnalysisAttemptAt)
  return !!lastAttempt && now.getTime() - lastAttempt.getTime() < cooldownMs
}

function normalizePhase(value) {
  return NARRATIVE_PHASES.includes(String(value)) ? value : 'user-message'
}

function normalizedIso(value) {
  return dateValue(value)?.toISOString()
}

function dateValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * dsh-hds-interlude —— hds-interlude 的 DeepSeek Harness 移植版
 *
 * 「聊天在幕前发生，生活在幕间继续。」
 *
 * 这是对 Koishi 插件 hds-interlude（AGPL-3.0）的移植，是其衍生作品，因此按 AGPL-3.0 分发。
 * - 纯逻辑模块（clock/alter/agency/preplan）是对原项目 src/ 下同名纯函数的逐行翻译；
 * - DSH 集成层（入口、注入、工具、命令、持久化）落在 DSH 原生扩展点上。
 * 许可证见 LICENSE 与 MIGRATION.md。
 *
 * 核心功能（详见 README / MIGRATION.md）：
 *   1. 幕间时钟 —— 由 session 日志折叠出「距上次互动过了多久」，经 agent/pre-step 注入；
 *   2. 延迟意图 / 承诺回访 —— 模型记下到点要处理的事，到期重新进入上下文；
 *   3. 情绪偏移追踪（Alter System）—— 模型报告氛围净变化，累积过阈值成为底色；
 *   4. 主体行动窗口（Agency Window）—— 日程/隐私/设备约束主动联系；
 *   5. 近期日程（Schedule Preplan）—— 周规律 + 例外 + 半日投影；
 *   6. 主动联系 / 自动生活推进 —— 由后台扫描经 agent.followup 唤起。
 *
 * @module dsh-hds-interlude
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Config } from './schema.js'
import {
  PLUGIN_NAME,
  sessionKeyOf, loadState, saveState, foldFromLog, listStoredStates,
  addIntent, dueIntents, addFact, closeFact, upsertOverlay, clearOverlay, rankFacts,
} from './state.js'
import { resolveZone, calendarDayKey, inRestWindow, formatStoryDisplayTime } from './clock.js'
import { recordFromLog, DEFAULT_LEDGER_LIMIT } from './script-entry.js'
import { normalizeLifeHandoff, applyPresence, resolvedLabels } from './life-handoff.js'
import { projectSceneFrame, renderSceneFrame, renderDialogueBurst } from './scene-frame.js'
import { normalizeKnowledgeEvidence, renderKnowledge } from './knowledge-evidence.js'
import { developmentDimension, promptReadyDevelopment, DEVELOPMENT_FRAME } from './development.js'
import { recallFocus } from './recall.js'
import {
  createTimelineGuard, recordDirectorFailure, recordDirectorSuccess,
  timelineDirectorAllowed, timelineDirectorFused, describeTimelineGuard, DIRECTOR_FUSE_COOLDOWN_MS,
} from './timeline-guard.js'
import { consumedLiveIntentIds } from './intent-lifecycle.js'
import { continuationBookmark, renderContinuationBookmark } from './continuation.js'
import { buildEpisodeIndex } from './episode-index.js'
import { installProactiveCapture, textOfContent, sessionIdOf } from './capture.js'
import {
  detectMessageRepetition, repetitionGuardInstruction, shouldCheckRepetition,
} from './repetition-guard.js'
import { HealthMonitor, renderHealthSection } from './health.js'
import { detectCommitment } from './commitment.js'
import { installQqIm } from './qq-im/channel.js'
import { targetIdOf, scopeOf } from './qq-im/binding.js'
import { createBotCommandHandler } from './qq-im/bot-commands.js'
import { normalizeImageSource } from './qq-im/outbound.js'
import { imageOfToolCall } from './qq-im/say.js'
import { defaultStickerDir, findStickerByName, listStickers, stickerStats } from './qq-im/sticker-store.js'
import { materializeFaces, splitKeepingFaces } from './qq-im/face.js'
import { mdToPlain } from './vendor/md-to-plain.js'
import { createProvisionManager } from './qq-im/connect.js'
import { applyScanCredentials } from './qq-im/credential-apply.js'
import { renderCanon, renderRules, renderInterludeBlock, renderProactiveText, renderStatus, renderPresetCard, renderAdvanceNotice, renderManualAdvanceNotice, renderSpeechModeLine, storyRules, parsePresetCard } from './render.js'
import {
  splitImText, resolveImChunking, resolveImBinding,
} from './im.js'
import { decideAdvanceDelivery, extractSpeech, looksLikeSelfNarration, salvageBodySpeech, looksLikeMissedSpeech } from './story.js'
import {
  advanceAlterSystem, completeAlterAnalysis, alterAnalysisCoolingDown,
  resolveAlterSystemConfig, normalizeAlterValue,
} from './alter.js'
import { evaluateAgencyCapacity, resolveAgencyConfig } from './agency.js'
import {
  resolveSchedulePreplanConfig, schedulePreplanReviewDue, applySchedulePreplanProposal,
  schedulePreplanWindow,
} from './preplan.js'
import {
  resolveUrgeConfig, normalizeUrgeState, urgeUserEvent,
  commitUrge, planUrge,
  parseUrgeHandoff, stripUrgeHandoff,
} from './urge.js'
import {
  parseTimelinePlanFromText,
  describeTimelinePlanRejection,
} from './timeline-director.js'
import {
  segmentsFromMessages, createDeliveryAction, appendDeliveryAction,
} from './delivery-ledger.js'
import { redactRange } from './script-entry.js'

export const name = PLUGIN_NAME

export { Config }
export { createConfigEditorScope }

/**
 * 依赖声明：等这些服务就绪后再启动。
 * `settings` 由 dsh-base 提供，用于可编辑配置。
 *
 * 注意这里**不**声明 `credentials` / `sessionController` / `dshIm`：它们是可选增强——
 *   - 没有 `dshIm` 时主动开口退回「唤起 agent」，只是到不了聊天软件；
 *   - 没有 `sessionController` 时冷会话无法被唤醒，扫描只覆盖活跃会话；
 *   - 没有 `credentials` 时 QQ 通道退读环境变量 / 凭据文件。
 * 声明成必需会让插件在精简 profile（headless 等）里直接起不来。
 *
 * **Cordis 没有「可选依赖」语法**：`inject` 里的每一项都是必需的，
 * 名字必须与服务注册名逐字相同。写成 `'credentials?'` 不会被当成可选，
 * 而是要求一个名叫 `credentials?` 的服务——它永远不存在，于是本插件
 * 永久停在 PENDING，dsh 启动时报「plugin tree failed to load」并退出。
 * 可选服务一律用 `ctx.get(name)`（见下方各调用点）而不是写进 inject。
 */
export const inject = ['agents', 'systemPrompt', 'tools', 'commands', 'settings', 'webServer']

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 写一条 JSON 响应（所有 HTTP 设置路由共用，避免九处重复的 writeHead/end 样板）。
 *
 * @param {object} res Node http 响应对象。
 * @param {number} code HTTP 状态码。
 * @param {unknown} payload 响应体（直接 JSON.stringify）。
 */
function writeJson(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 深合并两个普通对象（对齐 dsh-settings 的 mergeLayers：对象递归合并，数组/其它值整体替换）。
 *
 * 新宿主 settings 服务的 `update`/`replace` 内部走的就是这套合并语义；
 * configEditor 适配层复用它，保证「字段缺席 = 保持原值」与老宿主一致。
 */
function deepMerge(under, over) {
  const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (!isPlain(under) || !isPlain(over)) return over ?? under
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = Object.hasOwn(merged, key) ? deepMerge(merged[key], value) : value
  }
  return merged
}

/**
 * 新宿主（dsh-settings ≥0.1.7）的设置命名空间适配：走 `ctx.configEditor` 直写。
 *
 * ## 为什么需要它（线上症状：扫码「更新配置 ✗ 设置命名空间不可用」）
 *
 * 老宿主提供 `ctx.settings.register(ns, Config, ...)`，返回一个带
 * `get/watch/update/replace` 的 scope。新版 SettingsForms 服务**没有 register**，
 * 只有 `configure/describe/update/replace/mutate`；且新版 `update(ns, patch)` 只接受
 * schema 里标了 `.volatile()` 的字段——把字段标成 volatile 会让解析结果变成
 * `{ get }` 包装对象，破坏插件内部 `current().im` 这类普通读取（那会让整个插件感知
 * 的都是包装壳而不是真实配置）。
 *
 * 所以这里改用 `ctx.configEditor`（dsh-config-editor 服务，`SettingsForms` 自己
 * 底层就是它）直接编辑 entry 的 raw config：无 volatile 门槛、语义与
 * `settings.update/replace` 完全一致（深合并 / 继承层 + 覆盖），并保留
 * `get/watch/update/replace` 的 scope 形状，让调用方零改动。
 *
 * 拿不到 configEditor（精简宿主 / 测试环境）时返回 null，调用方退回静态配置。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {string} ns 本插件的 profile entry id（即 `name`/`hds-interlude`）。
 * @param {() => object} readCurrent 读当前生效配置（内存引用）。
 * @returns {{get: () => object, watch: (cb: Function) => Function,
 *   update: (patch: object) => Promise<void>, replace: (section: object) => Promise<void>}|null}
 */
function createConfigEditorScope(ctx, ns, readCurrent) {
  let editor
  try {
    editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : ctx.configEditor
  } catch {
    editor = undefined
  }
  if (!editor || typeof editor?.entries !== 'function' || typeof editor?.edit !== 'function') return null

  const listeners = new Set()
  /** 内存叠加层：写盘（configEditor.edit）之外，把本次改动同步进内存，让
   * `get()` / watch 立即看到新值（对齐老 host register scope 的纯内存语义）。 */
  let overlay = {}
  const value = () => deepMerge(readCurrent(), overlay)
  const notify = (next = value()) => {
    for (const cb of listeners) {
      try { cb(next) } catch { /* 单次回调失败不拖垮更新链路 */ }
    }
  }

  /** 找到本插件的配置 entry（profile patch 里的那一行）。 */
  const entryOf = () => {
    try {
      return (editor.entries?.() ?? []).find(row => row?.options?.id === ns)
    } catch {
      return undefined
    }
  }

  return {
    get: value,
    watch(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async update(patch) {
      const entry = entryOf()
      if (!entry) throw new Error(`找不到插件配置条目 ${ns}`)
      await editor.edit(entry, (raw, inherited) => deepMerge(raw ?? {}, patch))
      overlay = deepMerge(overlay, patch)
      notify()
    },
    async replace(section) {
      const entry = entryOf()
      if (!entry) throw new Error(`找不到插件配置条目 ${ns}`)
      // 与 SettingsForms.replace 一致：以继承层为底，section 覆盖。
      await editor.edit(entry, (_raw, inherited) => deepMerge(inherited ?? {}, section))
      overlay = section
      notify()
    },
  }
}

/**
 * 超过这个时长还没送达的到期待办不再补发，只标过期。
 * 「三分钟后提醒我喝水」在 DSH 停了一天之后补发没有意义，还会凑成消息风暴。
 */
const STALE_INTENT_MS = 6 * HOUR

/**
 * 从预设的 `agent.cordis.yml` 里提取「角色卡」文本。
 *
 * 卡片文本挂在 persona 块的 `prefix: |-`（或早期 `text: |-`）块里，内容以 6 空格
 * 缩进（buildAgentCordisYml 的 `'      ' + line`）。找到块首行后收集后续 6 空格行、
 * 剥掉缩进，直到遇到非缩进行（下一个顶层 `- id:` 项）。
 *
 * @param {string} yml agent.cordis.yml 全文。
 * @returns {string|undefined} 角色卡文本；找不到返回 undefined。
 */
function extractPresetCardText(yml) {
  const lines = String(yml ?? '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{2,}(?:prefix|text):\s*\|-/.test(lines[i])) { start = i + 1; break }
  }
  if (start < 0) return undefined
  const out = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    // 块内的空行可能是「6 空格」或「无缩进」（被其它工具重写过），都不该中断。
    if (line.trim() === '') { out.push(''); continue }
    if (!/^\s{6}/.test(line)) break
    out.push(line.slice(6))
  }
  return out.join('\n').trim()
}

/**
 * 会话从「没有投递目标」变成「绑定到聊天软件」时补发的一句口径更正。
 *
 * 背景：规则段只在首轮注入一次，而它注入的内容随 `imActive` 分叉。
 * 早先按「无绑定」注入过的会话，在绑定建立之后不会重注 ——
 * 模型于是保留着「写故事」的口径，却同时看到「本轮模式：可能发消息」，
 * 结果把要说的话写在正文里（strict 下正文永不外发）。
 *
 * 这句话只做一件事：明确告诉它口径换了、以及换成了什么。
 */
const IM_FORM_SWITCH_NOTICE = [
  '【口径更新】这个会话现在接上了聊天软件——你说的话可以真的送到对方那里了。',
  '从现在起，发言方式按下面的规则：要把话说给对方，就调用 interlude_say。',
  '**正文里写的字一条都不会发出去**（旁白、动作、你的思考都只留在你这边）。',
].join('\n')

/** IM 绑定来源的显示名。 */
const IM_BINDING_SOURCE = { session: '会话绑定', config: '插件配置', discover: '自动发现' }

/** 注册一个随插件卸载自动清理的定时器（优先 ctx.effect，退而 ctx.interval / setInterval）。 */
function every(ctx, ms, callback) {
  const wrapped = () => {
    try { callback() } catch { /* 单次失败不终止心跳 */ }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const id = setInterval(wrapped, ms)
      if (id && typeof id.unref === 'function') id.unref()
      return () => clearInterval(id)
    })
    return
  }
  if (typeof ctx.interval === 'function') { ctx.interval(wrapped, ms); return }
  const id = setInterval(wrapped, ms)
  if (id && typeof id.unref === 'function') id.unref()
  if (typeof ctx.on === 'function') ctx.on('dispose', () => clearInterval(id))
}

/** 解析配置里的 Alter 参数（缺省合并默认）。 */
function alterConfigOf(config) {
  return resolveAlterSystemConfig(config.alterSystem ?? {})
}

/**
 * 故事续写里的发言要不要自动发出去。
 *
 * 两个开关都开才发：
 *   - `im.autoMessage`：这件事本身的总开关（关掉 = 只写故事，不打扰）；
 *   - `im.deliverAutoAdvance`：改版前的老开关，保留为兼容退出口。
 * 到点的提醒 / 承诺回访走的是 handleProactive，**不受这里影响**——那是角色答应过的事。
 *
 * `im.enabled` 刻意不参与判定：它默认 false，而默认路径（自动发现绑定）下
 * 这个字段根本不会被用户改到，把它当条件等于默认静默不发（线上踩过，见 CONFIGURATION.md）。
 */
function autoMessageOnFor(config) {
  return config?.im?.autoMessage !== false && config?.im?.deliverAutoAdvance !== false
}

/**
 * 休息时段里该用多长的推进间隔。
 *
 * 参考项目的语义：窗口内不是「停止推进」，而是「降低频率」
 * （`service.ts:6760` 返回 `randomInteger(min, max)`）。我们照做，并且：
 *   - 没配 min/max 时，退化成「普通间隔的 3 倍」，至少 60 分钟；
 *   - 取配置区间内的随机值，避免整点同时唤醒所有会话。
 *
 * @param {Array<object>} restWindows 休息窗口列表。
 * @param {number} fallbackMs 非休息时段的间隔（毫秒）。
 * @returns {number} 本次该等多久（毫秒）。
 */
function restIntervalFor(restWindows, fallbackMs) {
  const window = (restWindows ?? []).find(item => item?.enabled !== false && item?.minIntervalMinutes)
  const min = Number(window?.minIntervalMinutes)
  const max = Number(window?.maxIntervalMinutes)
  if (Number.isFinite(min) && min > 0) {
    const lo = min * MINUTE
    const hi = Number.isFinite(max) && max > min ? max * MINUTE : lo
    return lo + Math.random() * (hi - lo)
  }
  return Math.max(fallbackMs * 3, 60 * MINUTE)
}

export function apply(ctx, config) {
  /**
   * 警告也要进 stdout。
   *
   * 为什么：`ctx.logger.warn` 的输出去向取决于宿主配置，实测**不会**出现在
   * 启动日志（dsh-out.log）里。结果「无法解析 AppSecret」「未配置 appId」
   * 这类真正的原因全被吞掉，只剩一句「未启动」——排查成本极高。
   * 这里额外打一份到 console，让每一道失败闸门都留下痕迹。
   */
  const warn = (message) => {
    try { ctx.logger?.warn?.(message) } catch { /* 忽略 */ }
    try { console.log(`[${name}] ${message}`) } catch { /* 忽略 */ }
  }
  const info = (message) => {
    try { console.log(`[${name}] ${message}`) } catch { /* 忽略 */ }
  }

  let zone
  try {
    zone = resolveZone(config.timeZone)
  } catch (error) {
    throw new Error(`${name}: 无法解析时区 ${JSON.stringify(config.timeZone)}`, { cause: error })
  }

  /* --------------------------------------------- 设置命名空间（可编辑配置） */
  let activeConfig = config
  let settingsLive = false
  let settingsScope = null
  if (typeof ctx.settings?.register === 'function') {
    try {
      settingsScope = ctx.settings.register(name, Config, { base: config, applies: 'live' })
      activeConfig = settingsScope.get()
      settingsLive = true
      ctx.effect(() => settingsScope.watch((next) => {
        activeConfig = next
        try { zone = resolveZone(next.timeZone) } catch (e) { warn(`时区无效，沿用 ${zone}: ${e?.message}`) }
        info('配置已更新，下一次回复生效')
      }))
    } catch (error) {
      warn(`注册设置命名空间失败，退回静态配置：${error?.message ?? String(error)}`)
      console.log(`[${name}] 警告：设置面板不可用，当前使用静态配置`)
    }
  } else {
    // 老宿主走 `ctx.settings.register`；新宿主（dsh-settings ≥0.1.7）没有该方法，
    // 只有 configure/describe/update/replace。新版 update 只接受 `.volatile()` 字段，
    // 而本插件的 Config 没有也不能标 volatile（会把字段解析成包装对象，破坏内部读取）。
    // 所以新宿主下改用更底层的 configEditor 直写（dsh-settings 自己底层就是它，无 volatile 门槛）。
    settingsScope = createConfigEditorScope(ctx, name, () => activeConfig)
    if (settingsScope) {
      settingsLive = true
      ctx.effect(() => settingsScope.watch((next) => {
        activeConfig = next
        try { zone = resolveZone(next.timeZone) } catch (e) { warn(`时区无效，沿用 ${zone}: ${e?.message}`) }
        info('配置已更新，下一次回复生效')
      }))
    } else {
      warn('设置命名空间不可用（宿主无 settings.register 且无 configEditor），设置页保存与扫码配置写入将失败')
    }
  }
  const current = () => activeConfig

  /**
   * 运行健康监控（移植自上游 rc1 的 `src/health.ts`）。
   *
   * **只活在内存里**：重载后归零，`sinceAt` 标注统计起点——它回答的是
   * 「本次运行以来稳不稳」，落盘会让人误读成长期趋势。
   */
  const health = new HealthMonitor()

  /* ---------------------------------------- 自建 QQ IM 通道（取代 dsh-im） */

  /**
   * 通道日志：走宿主的 logger，并带上插件名前缀，与 DSH 官方包的惯例一致。
   * 级别过滤由通道自己按 `im.logLevel` 处理。
   */
  const channelLog = (level, text) => {
    if (level === 'error' || level === 'warn') warn(text)
    else info(text)
  }

  /**
   * 把扫码凭据落地报告压成一行（/interlude im 状态用）。
   */
  const formatApplyReport = (report) => {
    const mark = (ok) => (ok ? '✓' : '✗')
    const parts = []
    if (report.credential) parts.push(`${mark(report.credential.ok)}凭据${report.credential.error ? `(${report.credential.error})` : ''}`)
    if (report.config) parts.push(`${mark(report.config.ok)}配置${report.config.error ? `(${report.config.error})` : ''}`)
    if (report.reconnect) parts.push(`${mark(report.reconnect.ok)}重连${report.reconnect.error ? `(${report.reconnect.error})` : ''}`)
    return parts.join(' ')
  }

  /**
   * 测试注入的投递出口。
   *
   * 为什么要留这个口子：投递的真行为（分条、逐条确认、部分失败记账）
   * 必须能在**不连 QQ**的情况下被完整测到。如果测试去替换整个通道，
   * 测到的就是替身而不是真实路径——那种「兼容」没有意义。
   *
   * 生产路径上 `ctx.__qqImTransport` 不存在，取到 undefined，走真实 SDK。
   */
  const qqIm = installQqIm(ctx, {
    config: current().im ?? {},
    log: channelLog,
    transport: ctx.__qqImTransport,
    // 自动新建会话时带上角色预设——没预设的新会话不会被注入人设与发言规则，
    // 模型不会调用 interlude_say，于是「收得到消息却永远不回复」。
    // 用箭头包一层：resolveAgentPresetId 定义在后面（TDZ），但只在收到
    // QQ 消息时才被调用，那时早已初始化完成。
    resolvePreset: (nameOrId) => resolveAgentPresetId(nameOrId),
    // 新建会话的 workspace：DSH 会话列表按 workspace 分组，建在别的 cwd 下的
    // 会话不会显示在用户当前打开的 workspace 里（「有回复但不显示会话」）。
    resolveCwd: () => recentSessionCwd(),
    // 群聊「@角色名」识别用的 bot 人设名（见 channel.js 的 mentionNames）：与
    // resolvePreset 同理，storyNameFor 定义在后面（TDZ），收到消息时才调用。
    resolveBotName: (botId) => storyNameFor(botId),
    // QQ 用户端机器人命令（/help /status /new /session /sessionlist）：
    // 与 resolvePreset 同理，handleBotCommand 定义在后面（TDZ），收到命令时才调用。
    onBotCommand: (args) => handleBotCommand(args),
  })

  /**
   * 把通道服务提供出去（可选，服务名沿用 `dshIm`）。
   *
   * ## 为什么默认**不**注册（线上事故复盘）
   *
   * 最初这里无条件 `ctx.provide('dshIm', …)`，理由是「兼容契约」：让外部按
   * `ctx.get('dshIm')` 找投递服务的代码继续可用。
   *
   * 但线上实测证明这个理由撑不起它的代价。Cordis 的 `provide` 在名字被占用时
   * **直接抛错**，而且这个错误会带崩整个插件树：
   *
   *     service "dshIm" has been registered at <hds-interlude>
   *     → 插件树加载失败 → 进程退出
   *
   * 于是「两个插件都注册 dshIm」变成一场**零和竞速**：谁后到谁死。
   * 而我们是**后装的那个**——本来该让位，却因为先跑完 `apply` 而抢到了名字，
   * 把原本正常工作的 `@xmanrui/dsh-im` 推下悬崖。
   *
   * 关键认识：**本插件根本不需要这个服务名**。
   *   - 收：`qqIm` 自己监听入站消息，不查服务；
   *   - 发：`deliverToIm` 直接调用 `qqIm.sendToTarget`，不经过服务名；
   *   - 兼容出口的唯一受益者是**外部消费者**（旧代码按 `dshIm` 找投递服务）。
   *
   * 所以正确做法是：**默认不注册**，把「要不要占用这个名字」交给用户显式决定。
   * 这样默认情况下两个插件可以安全共存——本插件照常收发消息，
   * 只是不去抢那个名字。
   *
   * 需要让外部消费者用本通道时，打开 `im.exposeService`。
   * 那时请先停用 dsh-im，否则（按上面的零和规则）总有一方会崩。
   */
  const exposeService = current().im?.exposeService === true
  if (exposeService) {
    // 显式要求暴露时，先确认名字空着——不空就让位并说清楚，
    // **绝不**用抛错的方式把别人挤掉。
    // 用 ctx.get('dshIm') 而不是 ctx.dshIm：`dshIm` 不在 inject 里（可选增强），
    // Cordis 对未声明服务做属性访问是**抛错**而不是返回 undefined。
    // ctx.get() 对未注册的名字返回 undefined —— 正好用来判断名字是否空着。
    let occupied
    try {
      occupied = typeof ctx.get === 'function' ? ctx.get('dshIm') : ctx.dshIm
    } catch {
      occupied = undefined
    }
    if (occupied) {
      warn('im.exposeService 已开启，但 dshIm 服务名已被其他插件占用，本通道让位。'
        + '若要由本通道接管，请先停用那个插件（profile 的 cordis.patch.yml 里给它 disabled: true）。')
    } else {
      try {
        ctx.effect(() => ctx.provide('dshIm', qqIm.service))
        info('已注册 dshIm 服务（兼容出口，供外部消费者使用）。')
      } catch (error) {
        warn(`注册 dshIm 服务失败，本通道让位（${error?.message ?? String(error)}）。`)
      }
    }
  } else {
    info('未注册 dshIm 服务（默认行为：不占用该名字，避免与其他插件冲突）。'
      + '如需对外暴露兼容出口，打开 im.exposeService。')
  }

  // 配置热更新时同步给通道（appId / 策略 / 分条等都可能被改）。
  if (settingsLive && settingsScope) {
    ctx.effect(() => settingsScope.watch((next) => {
      // **必须用 watch 的 next 参数，不要读 current()**：
      // current() 由另一个 watch（activeConfig = next）更新，两个 watch 的触发
      // 顺序不保证。若这里先跑，读到的是**旧配置**（被删的 bot 还在 bots 里），
      // applyConfig 就不会 stop 它——线上症状正是「删了机器人它还连着」。
      const im = next?.im ?? current().im ?? {}
      qqIm.applyConfig?.(im)
      // 启动时设置可能还没加载完（settings 加载与插件 apply 竞速），
      // 那时 installQqIm 拿到的 im 快照是空的、start() 在「缺 appId」处直接返回，
      // 通道就一直停在「未启动」——线上症状正是「重启 DSH 后必须重新扫码才连上」。
      // 所以配置一旦就绪且通道没在跑，就补一次启动。
      const st = qqIm.status()
      const hasAnyBot = (im.appId && im.appId.trim())
        || (Array.isArray(im.bots) && im.bots.some(bot => bot && bot.appId && String(bot.appId).trim()))
      if (im.enabled !== false && hasAnyBot && !st.started) {
        info('配置已就绪，启动 QQ 通道…')
        Promise.resolve().then(() => qqIm.start()).catch((error) => {
          warn(`配置就绪后启动 IM 通道异常：${error?.message ?? String(error)}`)
        })
      }
    }))
  }

  /* ---------------------------------------- QQ 机器人扫码绑定（provisioning） */

  /**
   * 扫码绑定的「凭据落地」。
   *
   * 流程：手机 QQ 扫码 → 腾讯授权页确认 → connector SDK 把 AppID/AppSecret
   * 交给本函数 → 写凭据服务 → 更新配置 → 重连通道。
   * 编排逻辑在 credential-apply.js（可单测），这里只把依赖接上。
   */
  const onScanCredentials = async (creds) => {
    // 用 ctx.get('credentials') 而不是 ctx.credentials：
    // `credentials` 不在 inject 里（精简 profile 兼容点），Cordis 对「未在 inject
    // 声明的服务」做属性访问会抛错（而不是返回 undefined）。
    // ctx.get() 对未注册的名字返回 undefined —— 这样凭据服务缺失时走降级，
    // 而不会让扫码落地静默失败（线上症状：凭据没写进 .credentials.yaml，
    // 重连时读不到 secret，QQ 一直「连接中」）。
    let credentials
    try {
      credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    } catch {
      credentials = undefined
    }
    // **必须有 return**：connect.js 的 onSuccess 靠这个返回值回填 lastApply
    // （前端「正在应用凭据…」的三环报告）。上一版漏了 return，report 一直是
    // undefined → 前端永远卡在「正在应用凭据」看不到 ✓/✗。
    return applyScanCredentials({
      creds,
      im: current().im ?? {},
      credentials,
      settingsScope,
      channel: qqIm,
      log: channelLog,
    })
  }

  /**
   * 扫码绑定管理器。测试可注入假 connector / 二维码生成 / 凭据落地。
   */
  const provision = createProvisionManager({
    log: channelLog,
    ...ctx.__qqProvisionOverrides ?? {},
    onCredentials: ctx.__qqProvisionOverrides?.onCredentials ?? onScanCredentials,
    // 重启后内存里的扫码状态会丢，但配置与凭据已持久化——把「是否已配置」
    // 告诉 provision，前端就能显示「已绑定 AppID xxx，无需重新扫码」，
    // 而不是渲染一个诱导用户重扫的面板。
    readConfigured() {
      const im = current().im ?? {}
      const appId = typeof im.appId === 'string' ? im.appId.trim() : ''
      // 多 Bot：bots 数组里有 AppID 也算已配置（扫码面板据此显示「已绑定」）。
      const anyBotAppId = Array.isArray(im.bots)
        && im.bots.some(bot => bot && typeof bot.appId === 'string' && bot.appId.trim())
      return { configured: im.enabled === true && Boolean(appId || anyBotAppId), appId }
    },
  })

  // 三个子路由：GET <base> 状态 / POST <base> 开始 / POST <base>/cancel 取消。
  // 用 prefix 注册（同一组端点公用 handler），handler 内按 pathname 精确分发。
  const provisionRoute = async (req, res) => {
    const json = (code, payload) => writeJson(res, code, payload)
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const base = '/api/hds-interlude/qq-connect'
      if (req.method === 'GET' && pathname === base) {
        json(200, { ok: true, value: provision.status() })
        return
      }
      if (req.method === 'POST' && pathname === base) {
        json(200, { ok: true, value: await provision.begin() })
        return
      }
      if (req.method === 'POST' && pathname === `${base}/cancel`) {
        json(200, { ok: true, value: provision.cancel() })
        return
      }
      res.writeHead(405)
      res.end()
    } catch (error) {
      json(500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/hds-interlude/qq-connect', handler: provisionRoute }))

  /* ---------------------------------------- Agent 预设：写入 DSH 自身的 Agent 预设 */
  const agentPresetsRoot = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.agent-presets')

  /**
   * 把「preset-hds-」前缀的预设 id 解析成它在 Agent 预设目录下的绝对路径。
   *
   * 两道防御（防路径穿越，见 readPresetStory / deletePreset / updatePreset 的调用点）：
   *   1. **白名单字符集**：id 只允许 `[A-Za-z0-9._-]`，直接排除路径分隔符（`/`、`\`）
   *      与 `..` 分段——没有分隔符就没有穿越段；
   *   2. **边界校验**：`path.resolve` 后仍须落在 `agentPresetsRoot()` 之内（防符号链接等绕过）。
   * 任一不满足返回 undefined，调用方一律当作「预设不存在」，绝不越权触碰预设目录之外的文件。
   *
   * @param {string} id 用户传入的预设 id。
   * @returns {string|undefined} 解析后的绝对路径；非法返回 undefined。
   */
  const presetDirOf = (id) => {
    if (typeof id !== 'string' || !/^preset-hds-[A-Za-z0-9._-]+$/.test(id)) return undefined
    const root = path.resolve(agentPresetsRoot())
    const dir = path.resolve(root, id)
    if (dir !== root && !dir.startsWith(root + path.sep)) return undefined
    return dir
  }

  const buildAgentCordisYml = (story) => {
    const card = renderPresetCard(story)
    const indented = card.split('\n').map((line) => '      ' + line).join('\n')
    return [
      '# 幕间系统预设生成',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: |-',
      indented,
      '    complete: true',
      '    includeRuntimeContext: false',
      '',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '',
      '- id: ask-user',
      "  name: '@deepseek-ai/dsh-tool-ask-user'",
      '',
    ].join('\n')
  }

  const readPresetsJson = () => {
    try {
      const raw = fs.readFileSync(path.join(agentPresetsRoot(), 'presets.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed?.presets) ? parsed.presets : []
    } catch {
      return []
    }
  }

  const writePresetsJson = (presets) => {
    const dir = agentPresetsRoot()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'presets.json')
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ presets }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  /**
   * 把「预设 id 或预设名」解析成可用的角色预设 id。
   *
   * 自动新建 QQ 会话时必须带上角色预设：没有预设的会话不会被注入人设与
   * 发言规则（pre-step 注入以 isRoleplaySession 为前提），模型不会调用
   * interlude_say，于是收得到消息却永远不回复。
   *
   * 匹配顺序：presets.json 里的 id → name（角色名，如「江柚」）。
   * 返回 undefined 表示匹配不到（调用方会记一条警告）。
   *
   * @param {string} [nameOrId]
   * @returns {string|undefined}
   */
  const resolveAgentPresetId = (nameOrId) => {
    if (typeof nameOrId !== 'string' || !nameOrId.trim()) return undefined
    const wanted = nameOrId.trim()
    const presets = readPresetsJson()
    // ① 直接是 id。
    const byId = presets.find(p => p?.id === wanted)
    if (byId && isRoleplayPresetId(byId.id)) return byId.id
    // ② 是角色名（绑定里的 name 就是角色名）。
    const byName = presets.find(p => p?.name === wanted)
    if (byName && isRoleplayPresetId(byName.id)) return byName.id
    return undefined
  }

  /**
   * 猜一个「用户此刻大概在看哪个 workspace」的目录，用作自动新建会话的 cwd。
   *
   * 为什么需要：DSH 的会话列表**按 workspace（cwd）分组**。自动建的 QQ 会话
   * 如果落在宿主的 defaultCwd（常见是用户主目录），它就不会出现在用户当前
   * 打开的 workspace 里——线上症状正是「已经有回复了，但 dsh 里不显示会话」。
   *
   * 取值顺序：正在跑的实时会话里最近活跃的那个的 cwd。实时会话就是用户
   * 此刻打开着的会话，它的目录最可能正是用户在看的那一个。
   * 拿不到就返回空串，交给宿主的默认目录（调用方会记一条警告）。
   *
   * @returns {string} cwd，或空串。
   */
  const recentSessionCwd = () => {
    try {
      let best = ''
      let bestAt = -1
      for (const agent of liveAgents.values()) {
        const header = agent?.session?.header
        const cwd = header?.cwd
        if (typeof cwd !== 'string' || !cwd) continue
        const at = Number(header?.updatedAt ?? agent?.session?.updatedAt ?? 0) || 0
        if (at >= bestAt) { bestAt = at; best = cwd }
      }
      return best
    } catch {
      return ''
    }
  }

  const savePreset = (name, story) => {
    const id = `preset-hds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dir = path.join(agentPresetsRoot(), id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), buildAgentCordisYml(story), 'utf8')
    fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${JSON.stringify(name)}\ndescription: ${JSON.stringify('🎭 幕间系统预设')}\n`, 'utf8')
    // 结构化快照：供设置页「读取预设」把设定原样填回创作表单。
    // agent.cordis.yml 里只有渲染后的卡片文本，反解析回 story 字段不现实，
    // 所以保存时把 story 的 JSON 一并落盘；读取预设读的就是它。
    fs.writeFileSync(path.join(dir, 'story.json'), `${JSON.stringify(story, null, 2)}\n`, 'utf8')
    const presets = readPresetsJson()
    presets.push({
      mode: 'roleplay',
      id,
      name,
      dir: id,
      description: `🎭 幕间系统 | 保存于 ${new Date().toLocaleString('zh-CN')}`,
      createdAt: Date.now(),
    })
    writePresetsJson(presets)
    return { id, name }
  }

  const listMyPresets = () => readPresetsJson()
    .filter((p) => typeof p.id === 'string' && p.id.startsWith('preset-hds-'))
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? null,
    }))

  /**
   * 列出可切换的角色预设（QQ 用户 /preset 用）：presets.json 里、**属于幕间系统**
   * 且目录真实存在的 roleplay 预设。
   *
   * 为什么必须限定 `preset-hds-` 前缀：`isRoleplayPresetId` 只检查目录里有没有
   * `preset.yml` / `agent.cordis.yml`，对「谁创建的预设」是无差别的。而
   * `~/.dsh/.agent-presets/` 是宿主与其它插件（如 tavern-lite）共享的目录，
   * 别家写进去的预设同样带这两个文件，于是会被一并列出——线上症状正是
   * `/presetlist` 里混进幕间系统以外的预设。与 listMyPresets（设置页）和
   * presetDirOf（路径操作）统一为同一口径：只认自己创建的预设。
   *
   * 懒调用（命令到达时才执行）：isRoleplayPresetId 定义在后面，TDZ 由调用时机规避——
   * 与 `resolvePreset: (nameOrId) => resolveAgentPresetId(nameOrId)` 同一模式。
   *
   * @returns {Array<{id: string, name: string}>}
   */
  const listRoleplayPresets = () => readPresetsJson()
    .filter((p) => typeof p?.id === 'string' && p.id.startsWith('preset-hds-') && isRoleplayPresetId(p.id))
    .map((p) => ({ id: p.id, name: typeof p.name === 'string' && p.name ? p.name : p.id }))

  /**
   * 读取一个已保存预设的 story 设定（「读取预设」用）。
   *
   * 只认 `preset-hds-` 前缀的 id（防路径穿越）。两级来源：
   *   ① `story.json` 结构化快照（2026-09-16 起保存预设时写入）；
   *   ② 老预设没有快照 → 从 `agent.cordis.yml` 的角色卡文本反解析
   *     （`parsePresetCard`，卡片是保存那一刻的忠实快照）。
   *
   * @param {string} id 预设 id。
   * @returns {object|undefined} story；读不到返回 undefined。
   */
  const readPresetStory = (id) => {
    const dir = presetDirOf(id)
    if (!dir) return undefined
    // ① 结构化快照。
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'story.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch (e) { ctx.logger?.debug?.('operation failed:', e.message); /* 缺失/损坏 → 走回退 */ }
    // ② 角色卡文本反解析（老预设兼容）。
    try {
      const yml = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8')
      const card = extractPresetCardText(yml)
      if (card) {
        const story = parsePresetCard(card)
        // 卡片里没有「角色名」时，用 preset.yml 的 name 补主角名。
        if (!story.character?.name) {
          try {
            const presetYml = fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8')
            const match = /name:\s*"?([^"\n]+)"?/.exec(presetYml)
            if (match?.[1]) story.character.name = match[1].trim()
          } catch (e) { ctx.logger?.debug?.('operation failed:', e.message); /* 无所谓 */ }
        }
        return story
      }
    } catch (e) { ctx.logger?.debug?.('operation failed:', e.message); /* 无 yml */ }
    return undefined
  }

  const deletePreset = (id) => {
    const dir = presetDirOf(id)
    if (!dir) return false
    fs.rmSync(dir, { recursive: true, force: true })
    const presets = readPresetsJson().filter((p) => p.id !== id)
    writePresetsJson(presets)
    return true
  }

  /**
   * 更新一个已保存的预设：
   *   - 传 `story` → 重写 story.json / agent.cordis.yml（内容更新）；
   *   - 传 `name` → 只改名（presets.json / preset.yml，内容不动）。
   * createdAt 保留；updatedAt 刷新。
   *
   * @param {string} id 预设 id（preset-hds- 前缀）。
   * @param {object|undefined} [story] 新 Story；缺省不重写内容。
   * @param {string} [name] 可选：预设新名称。
   * @returns {{id: string, name: string}|null} 更新后的条目；不存在返回 null。
   */
  const updatePreset = (id, story, name) => {
    const dir = presetDirOf(id)
    if (!dir) return null
    if (!fs.existsSync(path.join(dir, 'story.json')) && !fs.existsSync(path.join(dir, 'agent.cordis.yml'))) return null
    const presets = readPresetsJson()
    const index = presets.findIndex((p) => p.id === id)
    if (index < 0) return null
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : presets[index].name
    try {
      if (story && typeof story === 'object' && !Array.isArray(story)) {
        fs.writeFileSync(path.join(dir, 'story.json'), `${JSON.stringify(story, null, 2)}\n`, 'utf8')
        fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), buildAgentCordisYml(story), 'utf8')
      }
      fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${JSON.stringify(nextName)}\ndescription: ${JSON.stringify('🎭 幕间系统预设')}\n`, 'utf8')
      presets[index] = {
        ...presets[index],
        name: nextName,
        description: `🎭 幕间系统 | 更新于 ${new Date().toLocaleString('zh-CN')}`,
        updatedAt: Date.now(),
      }
      writePresetsJson(presets)
      return { id, name: nextName }
    } catch (error) {
      warn(`更新预设 ${id} 失败：${error?.message ?? String(error)}`)
      return null
    }
  }

  /* ---------------------------------------- HTTP 设置路由（dsh-tavern 风格，供设置页 fetch） */
  if (typeof ctx.webServer?.register === 'function') {
    const readBody = (req) => new Promise((resolve, reject) => {
      // 请求体上限：所有用到 readBody 的端点都只读一小段配置/路径/预设名，
      // 没理由接收任意大的 body。设 1MB 上限，避免把进程内存撑爆。
      const chunks = []
      let size = 0
      const limit = 1_048_576
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体过大（>1MB）'))
          if (typeof req.destroy === 'function') req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
        catch (error) { reject(error) }
      })
      req.on('error', reject)
    })
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/settings',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method === 'GET') {
            json(200, { ok: true, value: current() })
          } else if (req.method === 'POST') {
            if (!settingsScope) { json(500, { ok: false, error: '设置命名空间不可用' }); return }
            const body = await readBody(req)
            await settingsScope.update(body)
            json(200, { ok: true })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 只读运行状态：设置页的「运行状态」卡片专用。
    // 刻意只实现 GET——POST/DELETE 一律 405，保证这张卡片永远不会写坏什么。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/status',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method === 'GET') {
            json(200, { ok: true, value: collectRuntimeStatus() })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 预设：保存 / 列举 / 删除（写入 DSH 自身的 Agent 预设目录）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/presets',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method === 'GET') {
            json(200, { ok: true, presets: listMyPresets() })
          } else if (req.method === 'POST') {
            const body = await readBody(req)
            const presetName = String(body?.name ?? '').trim()
            if (!presetName) { json(400, { ok: false, error: '预设名称不能为空' }); return }
            // story 来源：前端可传草稿（创作页「新建预设」把正在编辑的设定直接存成预设）；
            // 不传则保存当前已生效配置的 story（预设页「保存当前设定为预设」行为不变）。
            const story = body?.story && typeof body.story === 'object' && !Array.isArray(body.story)
              ? body.story
              : current().story
            const preset = savePreset(presetName, story)
            json(200, { ok: true, preset })
          } else if (req.method === 'DELETE') {
            const body = await readBody(req)
            const deleted = deletePreset(body?.id)
            json(deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: '未找到该预设' })
          } else if (req.method === 'PUT') {
            // 更新预设：{ id, story? } 更新内容；{ id, name } 只改名。
            const body = await readBody(req)
            const id = String(body?.id ?? '').trim()
            if (!id) { json(400, { ok: false, error: '缺少预设 id' }); return }
            const story = body?.story && typeof body.story === 'object' && !Array.isArray(body.story)
              ? body.story
              : undefined
            const updated = updatePreset(id, story, body?.name)
            if (!updated) { json(404, { ok: false, error: '未找到该预设' }); return }
            json(200, { ok: true, preset: updated })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 读取预设：把某个已保存预设的 story 设定取回（设置页「读取预设」按钮用）。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/preset',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method === 'GET') {
            const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id')
            if (!id) { json(400, { ok: false, error: '缺少预设 id' }); return }
            const story = readPresetStory(id)
            if (!story) { json(404, { ok: false, error: '未找到该预设的设定' }); return }
            json(200, { ok: true, story })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 解绑：机器人卡片二级面板「投递目标」里解绑某条聊天 ↔ 会话关系。
    // POST /api/hds-interlude/qq-im/unbind  { botId, conversationKey }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/qq-im/unbind',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method === 'POST') {
            const body = await readBody(req)
            const botId = String(body?.botId ?? '').trim()
            const conversationKey = String(body?.conversationKey ?? '').trim()
            if (!botId || !conversationKey) { json(400, { ok: false, error: '缺少 botId 或 conversationKey' }); return }
            const removed = qqIm.bindings.remove(conversationKey, botId)
            qqIm.invalidateBindings()
            json(200, { ok: true, removed })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 投递自检：设置页的「发送测试消息」按钮用。
    //
    // POST /api/hds-interlude/im-test  { botId, conversationKey?, text? }
    //   → { ok, sentCount, total, error?, target, text }
    //
    // 与 `/interlude im test` 命令走**同一条**投递路径（deliverToIm → 分条 →
    // 通道），所以它验证的是真实链路，不是替身。刻意不做「静默成功」：
    // 没绑定、通道没启动、发送被平台拒绝，都原样回报给面板。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/im-test',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
          const body = await readBody(req)
          const botId = String(body?.botId ?? '').trim()
          const wantedKey = String(body?.conversationKey ?? '').trim()
          const customText = typeof body?.text === 'string' ? body.text.trim() : ''

          // 找投递目标：优先用指定的那条，否则取该 bot 的第一条绑定。
          const forBot = qqIm.bindings.list(botId || undefined)
          const target = wantedKey
            ? forBot.find((item) => item.conversationKey === wantedKey)
            : forBot[0]
          if (!target) {
            json(200, {
              ok: false,
              error: botId
                ? `机器人 ${botId} 还没有投递目标：先让该机器人收到一条 QQ 私聊（会自动建会话并绑定），或在「投递目标」里确认绑定。`
                : '还没有任何投递目标。',
            })
            return
          }
          // 目标绑定的会话就是这次投递要记进哪份状态（配额/回执都记在它身上）。
          const sessionKey = String(target.sessionId ?? '')
          if (!sessionKey) { json(200, { ok: false, error: '该投递目标没有关联会话。' }); return }
          const state = loadState(sessionKey)
          /*
           * 默认文案刻意写成「一眼能认出是测试」的形态，避免用户把它当成角色真的说话。
           *
           * ⚠️ 不能用【】或 [] 包标记：出站清洗（`cleanImText`）会把整行括号内容当旁白
           * 删掉、行内括号也会被 `INLINE_NARRATION` 吃掉——用户就看不到标记了。
           * 所以用不会被清洗的全角符号 + 与正文同行。
           */
          const finalText = customText || `投递测试 → 通道正常（${new Date().toLocaleString('zh-CN', { hour12: false })}）`
          const result = await deliverToIm({
            key: sessionKey, state, cfg: current(), text: finalText, reason: '设置面板测试投递',
          })
          json(200, {
            ok: result.ok === true,
            sentCount: result.sentCount ?? 0,
            total: result.total ?? 0,
            error: result.error ?? null,
            target: { botId: target.botId, conversationKey: target.conversationKey, sessionId: sessionKey },
            text: finalText,
          })
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 表情库：设置页展示「库里有什么」用。
    // GET /api/hds-interlude/stickers?dir=… → { ok, dir, stats, stickers }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/stickers',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          const url = new URL(req.url, 'http://localhost')
          // 以配置目录为准；允许显式传 dir 以便「还没保存时预览所选目录」。
          const cfg = current()
          const requested = String(url.searchParams.get('dir') ?? '').trim()
          let dir
          try {
            dir = requested ? path.resolve(requested) : (cfg.im?.stickerDir || defaultStickerDir())
          } catch {
            json(400, { ok: false, error: '路径非法' })
            return
          }
          const stickers = listStickers(dir, { limit: 200 })
          json(200, {
            ok: true,
            dir,
            defaultDir: defaultStickerDir(),
            stats: stickerStats(dir),
            stickers: stickers.map((s, index) => ({
              ...s,
              // 给 UI 一个可直接 <img src> 的地址（渲染缩略图用）。
              thumb: `/api/hds-interlude/sticker-file?dir=${encodeURIComponent(dir)}&i=${index}`,
            })),
          })
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 单张表情图：设置页缩略图用（同一份 list 的下标，防路径穿越）。
    // GET /api/hds-interlude/sticker-file?dir=…&i=0
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/sticker-file',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const requested = String(url.searchParams.get('dir') ?? '').trim()
          const index = Number(url.searchParams.get('i'))
          let dir
          try {
            dir = requested ? path.resolve(requested) : (current().im?.stickerDir || defaultStickerDir())
          } catch {
            res.writeHead(400); res.end(); return
          }
          // **按下标取**，而不是接受任意路径：这样请求方无法用它读目录外的文件。
          const all = listStickers(dir, { limit: 200 })
          const hit = Number.isInteger(index) && index >= 0 ? all[index] : undefined
          if (!hit) { res.writeHead(404); res.end(); return }
          // 双保险：解析后的真实路径必须仍在表情目录内。
          const real = path.resolve(hit.path)
          const root = path.resolve(dir)
          if (real !== root && !real.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
          const buf = fs.readFileSync(real)
          const ext = path.extname(real).toLowerCase()
          const mime = ext === '.png' ? 'image/png'
            : ext === '.gif' ? 'image/gif'
              : ext === '.webp' ? 'image/webp'
                : ext === '.bmp' ? 'image/bmp'
                  : 'image/jpeg'
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' })
          res.end(buf)
        } catch {
          res.writeHead(404); res.end()
        }
      },
    }))

    // 目录浏览：机器人卡片二级面板「会话存放工作区」的目录选择器用。
    // POST /api/hds-interlude/fs/list  { path? } → { ok, path, home, entries }
    // 只列**目录**（不列文件），不写盘、不执行——纯只读浏览。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/fs/list',
      handler: async (req, res) => {
        const json = (code, payload) => writeJson(res, code, payload)
        try {
          if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
          const body = await readBody(req)
          const raw = String(body?.path ?? '').trim()
          let dir
          try {
            dir = raw ? path.resolve(raw) : os.homedir()
          } catch (error) {
            json(400, { ok: false, error: `路径非法：${error?.message ?? String(error)}` })
            return
          }
          let entries
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((entry) => ({
                name: entry.name,
                path: path.join(dir, entry.name),
                hidden: entry.name.startsWith('.'),
              }))
          } catch (error) {
            json(200, { ok: false, error: `无法读取目录 ${dir}：${error?.message ?? String(error)}` })
            return
          }
          json(200, {
            ok: true,
            path: dir,
            home: os.homedir(),
            // 快速访问（Windows 资源管理器侧边栏风格）：存在的标准目录才列。
            quick: [
              { name: '主目录', path: os.homedir() },
              { name: '桌面', path: path.join(os.homedir(), 'Desktop') },
              { name: '下载', path: path.join(os.homedir(), 'Downloads') },
              { name: '文档', path: path.join(os.homedir(), 'Documents') },
              { name: '图片', path: path.join(os.homedir(), 'Pictures') },
              { name: '视频', path: path.join(os.homedir(), 'Videos') },
              { name: '音乐', path: path.join(os.homedir(), 'Music') },
            ].filter(item => fs.existsSync(item.path)),
            entries,
          })
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  }

  /* ------------------------------------ 只读运行状态（设置页「运行状态」卡片，只读不写） */

  /**
   * 汇总当前运行状态，供设置页的只读视图卡片展示。
   *
   * **这是一条纯读路径：不写盘、不改配置、不触发扫描、不唤醒任何会话。**
   * 数据来源全部是既有事实：
   *   - 生效配置 `current()`；
   *   - 内存里的实时 agent 登记 `liveAgents`；
   *   - 磁盘上的会话状态 `listStoredStates()`（含冷会话）；
   *   - 定时器 / 扫描的即时计数。
   *
   * 汇总口径与 `/interlude status` 和 `interlude_state` 保持一致（同一份 state 字段），
   * 但这里是对**全插件**的横切视图，而不是某一个会话的。
   *
   * @returns {object} 可直接 JSON 序列化的状态快照。
   */
  const collectRuntimeStatus = () => {
    const now = Date.now()
    const cfg = current()
    const stored = listStoredStates()

    // 「实时 agent」的统一入口：内存登记优先，再问宿主的权威来源。
    // 只认前者会漏掉「插件加载前就已经在跑」的会话。
    const agentOf = key => liveAgents.get(key) ?? ctx.agents?.get?.(key)

    /**
     * 角色会话集合 —— 这张卡片只关心「真正在用幕间层的会话」。
     *
     * 判定分两条路（与 runSweep / handleSession 完全一致，避免卡片和实际行为对不上）：
     *   - 有实时 agent：用权威的 SessionHeader（agentPreset）；
     *   - 冷会话：退化成看状态里的幕间痕迹（isRoleplayState）。
     *
     * 冷会话**不再作为一个统计数字**展示，但它们的待办仍会真的到点开口
     * （wakeIdleSessions 会唤醒它们），所以算「下一次主动发消息」时必须纳入。
     */
    const roleplay = []
    const seen = new Set()
    for (const { key, state } of stored) {
      const agent = agentOf(key)
      if (agent) {
        if (isRoleplaySession(agent, state)) roleplay.push({ key, state, live: true })
      } else if (isRoleplayState(state)) {
        roleplay.push({ key, state, live: false })
      }
      seen.add(key)
    }
    // 还没落过盘的实时会话（新建、从未交互）：只有 SessionHeader 能判断身份。
    for (const [key, agent] of liveAgents) {
      if (seen.has(key)) continue
      const state = states.get(key) ?? loadState(key)
      if (isRoleplaySession(agent, state)) roleplay.push({ key, state, live: true })
    }

    let pending = 0
    let dueNow = 0
    let failed = 0
    let reachedOutToday = 0
    const upcoming = []
    const upcomingWakes = []

    const grace = Math.max(0, cfg.proactive?.graceMinutes ?? 1) * MINUTE

    for (const { key, state } of roleplay) {
      const intents = Array.isArray(state.intents) ? state.intents : []
      for (const intent of intents) {
        if (intent.status === 'pending') {
          pending += 1
          if (Number.isFinite(intent.dueAt)) {
            if (intent.dueAt <= now) {
              dueNow += 1
            } else {
              // 只收「尚未到点」的：已到点的属于待补跑，混进来会让卡片标题
              // 「即将到点」名不副实——它们其实已经到点了。
              upcoming.push({
                sessionId: key,
                id: intent.id,
                kind: intent.kind,
                summary: intent.summary,
                dueAt: intent.dueAt,
              })
            }
            // 真正会被唤起开口的时刻 = 到点 + 宽限（与 scheduleIntentWake 同一口径）。
            // 已到点的也要算：它会由扫描补跑，也就是「随时可能开口」。
            upcomingWakes.push({
              sessionId: key,
              id: intent.id,
              kind: intent.kind,
              summary: intent.summary,
              at: intent.dueAt + grace,
              atLatest: null,
              overdue: intent.dueAt <= now,
              via: 'intent',
              blockedByRest: false,
              // 有 IM 绑定就真的发到聊天软件；没有则只在 DSH 内唤起。
              // 用当前 state 解析，才能带上会话级 /interlude im bind 的绑定。
              pushToIm: Boolean(bindingFor(key, state, cfg)),
            })
          }
        } else if (intent.status === 'failed') {
          failed += 1
        }
      }
      // 「今日已主动联系」按角色本地日判定，跨角色会话累加。
      if (state.reachedOutDay && calendarDayKey(new Date(now), zone) === state.reachedOutDay) {
        reachedOutToday += Number(state.reachedOut ?? 0)
      }
    }

    upcoming.sort((a, b) => a.dueAt - b.dueAt)

    /* ---------------------------------------------- 自动生活推进（幕间推进）状态 */

    const autoAdvanceOn = cfg.runtime?.autoAdvanceEnabled !== false
    const advanceInterval = Math.max(5, cfg.runtime?.autoAdvanceIntervalMinutes ?? 40) * MINUTE
    const advanceJitter = Math.max(0, cfg.runtime?.autoAdvanceJitterMinutes ?? 5) * MINUTE
    const restWindows = cfg.runtime?.restWindows ?? []

    // 自动推进只在**实时**会话里发生（冷会话唤醒一次太贵，见 handleAutoAdvance）。
    const advanceRows = []
    for (const { key, state, live } of roleplay) {
      if (!live) continue
      const lastAssistant = Number.isFinite(state.lastAssistantAt) ? state.lastAssistantAt : 0
      const lastAdvance = Number.isFinite(state.lastAutoAdvanceAt) ? state.lastAutoAdvanceAt : 0
      // 判定条件是 now - lastAssistant >= threshold 且 now - lastAdvance >= interval，
      // 其中 threshold = interval + 随机抖动。所以最早可能在 max(两者+interval)，
      // 最晚再往后一个抖动。抖动是随机的，卡片因此给一个区间而不是假装精确。
      const earliest = Math.max(lastAssistant + advanceInterval, lastAdvance + advanceInterval)
      const latest = Math.max(lastAssistant + advanceInterval + advanceJitter, lastAdvance + advanceInterval)
      // 这段补写到底算不算「发消息」：只有绑定了聊天软件、且发言开关开着、
      // 且过了发消息间隔的会话，这一轮才可能真的把话发出去（见 story.js 的判定）。
      // 卡片必须如实区分，否则用户会以为「下次补齐」就是「下次会收到消息」。
      const bindingForSession = bindingFor(key, state, cfg)
      const gate = storyMessageGate(state, cfg, earliest, Boolean(bindingForSession))
      const willSpeak = Boolean(bindingForSession) && gate.allowed
      const restingEarliest = inRestWindow(earliest, zone, restWindows)
      advanceRows.push({
        sessionId: key,
        lastAssistantAt: lastAssistant || null,
        lastAutoAdvanceAt: lastAdvance || null,
        lastAutoMessageAt: Number.isFinite(state.lastAutoMessageAt) ? state.lastAutoMessageAt : null,
        nextAt: autoAdvanceOn ? earliest : null,
        nextLatestAt: autoAdvanceOn ? latest : null,
        restingNow: inRestWindow(now, zone, restWindows),
        // 推进会避开休息时段（handleAutoAdvance 里直接 return），所以这个时刻只是
        // 「最早可能」，真正要等休息窗口结束——如实标出来，别让用户以为准点会响。
        blockedByRest: autoAdvanceOn ? restingEarliest : false,
        pushToIm: willSpeak,
        speakMode: willSpeak ? 'speak' : 'story-only',
        speakBlockedBy: willSpeak ? null : gate.reason,
        lastDelivery: state.lastAdvanceDelivery ?? null,
      })
    }
    advanceRows.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))

    // 推进候选里最近的那个（未开启推进时为 null）。
    const nextAdvance = autoAdvanceOn
      ? advanceRows.filter(row => Number.isFinite(row.nextAt)).sort((a, b) => a.nextAt - b.nextAt)[0] ?? null
      : null

    /* ------------------------------------------------ 下一次「主动发消息」预计时间 */

    // 汇总两条来源，取最早的一个：
    //   1. 到期待办（承诺/提醒/延迟回复/主动问候）—— 到点+宽限即开口，
    //      有 IM 绑定就真的发到聊天软件，没有则只在 DSH 内唤起；
    //   2. 故事续写 —— 到点续写一段生活；其中只有「发消息间隔」已过、且角色
    //      确实说了话的那一轮才会真的发出去（story.js 判定），其余只留在 DSH 里。
    const wakes = upcomingWakes.slice()
    if (nextAdvance) {
      wakes.push({
        sessionId: nextAdvance.sessionId,
        id: null,
        kind: 'advance',
        summary: nextAdvance.speakMode === 'speak'
          ? '续写故事（若角色说了话，会发出来）'
          : '续写故事（只写故事，不发消息）',
        at: nextAdvance.nextAt,
        atLatest: nextAdvance.nextLatestAt,
        overdue: false,
        via: 'advance',
        blockedByRest: nextAdvance.blockedByRest,
        pushToIm: nextAdvance.pushToIm,
      })
    }
    wakes.sort((a, b) => a.at - b.at)
    const nextWake = wakes[0] ?? null

    // 还在跑的实时 agent 总数（不区分是否角色会话）——用于对照「真正在用幕间层的」有几个。
    const liveKeys = new Set()
    for (const { key } of stored) if (agentOf(key)) liveKeys.add(key)
    for (const key of liveAgents.keys()) if (agentOf(key)) liveKeys.add(key)

    const liveRoleplayCount = roleplay.filter(item => item.live).length

    return {
      now,
      zone,
      character: cfg.story?.character?.name || '',
      enabled: cfg.enabled !== false,
      // 各子系统的开关，直接来自生效配置。
      toggles: {
        proactive: cfg.proactive?.enabled !== false,
        autoAdvance: autoAdvanceOn,
        autoMessage: autoMessageOnFor(cfg),
        agency: cfg.agency?.enabled !== false,
        alter: cfg.alterSystem?.enabled !== false,
        preplan: cfg.schedulePreplan?.enabled !== false,
        wakeIdle: cfg.proactive?.wakeIdleSessions !== false,
        commitmentBackstop: cfg.proactive?.commitmentBackstop !== false,
      },
      // 定时与配额：卡片上解释「下一次扫描/推进什么时候来」。
      timing: {
        checkIntervalMinutes: cfg.proactive?.checkIntervalMinutes ?? 5,
        graceMinutes: cfg.proactive?.graceMinutes ?? 1,
        autoAdvanceIntervalMinutes: cfg.runtime?.autoAdvanceIntervalMinutes ?? 40,
        autoAdvanceJitterMinutes: cfg.runtime?.autoAdvanceJitterMinutes ?? 5,
        // 写故事与发消息是两个独立节奏，卡片必须分别报出来。
        messageIntervalMinutes: cfg.im?.messageIntervalMinutes ?? 120,
        autoMessage: autoMessageOnFor(cfg),
        maxPerDay: cfg.proactive?.maxPerDay ?? 6,
      },
      /**
       * IM 通道状态。
       *
       * 为什么放进运行状态卡片：这一项**最容易静默失败**——AppID 填错、
       * 密钥没配、SDK 没装，都不会报错，只会让角色不说话。
       * 把它摆在设置页最显眼的位置，「填了没生效」才看得见。
       */
      channel: {
        enabled: cfg.im?.enabled === true,
        connected: Boolean(qqIm.status().ready),
        started: Boolean(qqIm.status().started),
        appId: cfg.im?.appId || '',
        secretRef: cfg.im?.secretRef || '',
        botId: cfg.im?.botId || '',
        sayFallback: cfg.im?.sayFallback === 'loose' ? 'loose' : 'strict',
        lastError: qqIm.status().lastError ?? null,
        bindings: qqIm.bindings.list().length,
        inbound: qqIm.stats?.inbound ?? 0,
        outbound: qqIm.stats?.outbound ?? 0,
        // 多 Bot 明细：每个机器人的连接状态、配置字段与绑定列表（前端卡片展示）。
        bots: (qqIm.status().bots ?? []).map(bot => {
          const cfgBot = (qqIm.config.bots ?? []).find(b => b.botId === bot.botId)
          return {
            botId: bot.botId,
            alias: bot.alias || '',
            appId: bot.appId,
            started: bot.started,
            ready: bot.ready,
            lastError: bot.lastError ?? null,
            // 二级面板需要的配置字段（与配置页同源）。
            cwd: cfgBot?.cwd || '',
            agentPreset: cfgBot?.agentPreset || '',
            whitelist: Array.isArray(cfgBot?.whitelist) ? cfgBot.whitelist : [],
            // 该 bot 的投递目标（绑定表）：conversationKey → 会话（双向同步消息）。
            bindings: qqIm.bindings.list(bot.botId).map(b => ({
              conversationKey: b.conversationKey,
              sessionId: b.sessionId,
              name: b.name ?? null,
              boundAt: b.boundAt ?? null,
            })),
          }
        }),
        // 最近一次入站路由结果（消息到没到、被谁消化了）。
        // 「成功连接但收消息不回复」的分诊线索：
        //   lastInbound 为 null → SDK 从未把消息交进来（订阅/权限问题）；
        //   lastInbound.status === 'delivered' → 消息进了会话但模型没回应；
        //   lastInbound.status 为 ignore/error → 路由环节丢弃。
        lastInbound: qqIm.stats?.lastInbound ?? null,
      },
      sessions: {
        // 只统计「正在跑幕间层的实时会话」——即真正在用角色预设（或 /interlude on）的会话。
        // 不再把冷会话当作一个数字展示（它们仍参与下面的开口预计）。
        live: liveRoleplayCount,
        // 还在跑的实时 agent 总数（含没用幕间层的普通会话），仅作对照。
        liveTotal: liveKeys.size,
      },
      // 幕间推进（自动生活推进）状态。
      advance: {
        enabled: autoAdvanceOn,
        sessions: advanceRows.slice(0, 8),
      },
      intents: {
        pending,
        dueNow,
        failed,
        upcoming: upcoming.slice(0, 8),
      },
      proactive: {
        reachedOutToday,
        maxPerDay: cfg.proactive?.maxPerDay ?? 6,
        // 下一次预计会主动开口的时刻（待办到点+宽限，或自动生活推进到点），取最早。
        next: nextWake,
      },
      timers: {
        // 每个会话一次的一次性到点定时器 + 进行中的扫描。
        intentTimers: intentTimers.size,
        scansInFlight: inFlight.size,
      },
    }
  }

  /* ------------------------------------------------- 会话状态与 Agent 登记 */
  const states = new Map()
  const liveAgents = new Map()

  const entryFor = (agent) => {
    if (!agent) return undefined
    const key = sessionKeyOf(agent)
    if (!key) return undefined
    let state = states.get(key)
    if (state === undefined) {
      state = loadState(key)
      states.set(key, state)
    }
    foldFromLog(agent, state)
    // 把新推进的那一段日志记进条目账本（幂等，重复折叠不会重复记）。
    //
    // 放在 `foldFromLog` **之后**：账本要的是「日志已被折叠到最新」这个前提。
    // 放在这里（而不是单独再挂一个 session/event 监听）是因为 entryFor 正是
    // 「每个 pre-step / 每次工具调用都会走」的那个点，且此时 state 已在手。
    recordLedger(state, key, agent)
    liveAgents.set(key, agent)
    return { key, state, agent }
  }

  /**
   * 从会话日志把条目补进账本。
   *
   * 为什么需要 `try/catch`：记账失败**绝不能**打断一个回合。账本是溯源的地基，
   * 但它不是用户此刻说话的必需品——失败时如实记日志、下一轮重试即可。
   *
   * @param {object} state 会话状态。
   * @param {string} key 会话 key（落盘用）。
   * @param {object} agent 实时 agent。
   */
  const recordLedger = (state, key, agent) => {
    try {
      const session = agent?.session
      const total = Number(session?.seq)
      if (!Number.isFinite(total) || typeof session?.eventAt !== 'function') return
      const created = recordFromLog(state, {
        total,
        eventAt: index => session.eventAt(index),
        participantId: key ?? '',
        limit: DEFAULT_LEDGER_LIMIT,
      })
      // 记账之后顺手重投影一次场景帧。
      //
      // 为什么放在这里而不是单独挂事件监听：帧是**从证据算出来的**，
      // 证据变了帧就该跟着变；而这里正是「证据刚更新完」的那个点。
      // 上游的铁律是「每轮从事实源重新投影」——所以这里是**整体重算**，
      // 不是增量修改（增量会让旧的投影错误一直传下去）。
      if (created.length) {
        reprojectFrame(state)
        if (key) saveState(key, state)
      } else {
        // 没有新条目**也要**重投影。
        //
        // 踩过的坑：一开始只在 `created.length` 时投影，于是「这一轮没有新日志、
        // 但 interlude_handoff 刚更新了在场名单」这种情形下帧永远是旧的——
        // 证据变了帧没变，正是这套机制要防的不一致。
        // 投影是纯计算（零模型调用、零 IO），每轮重算的代价可以忽略。
        reprojectFrame(state)
      }
    } catch (error) {
      warn(`条目记账失败（不影响本轮）：${error?.message ?? String(error)}`)
    }
  }

  /**
   * 从当前证据重新投影场景帧（确定性，零模型调用）。
   *
   * 只在**有证据**时才覆盖：一份空投影不该把已经算好的帧抹掉——
   * 那会让「在场名单明明还在，帧里却空了」。
   *
   * @param {object} state 会话状态。
   */
  const reprojectFrame = (state) => {
    const frame = projectSceneFrame({
      storyId: state.sessionId ?? '',
      sceneId: state.sceneFrame?.sceneId,
      scenePresence: state.scenePresence,
      workingDetails: state.workingDetails,
      agencyWindow: state.agencyWindow,
      // 传上一帧只为继承 localBoundaryEntryId——帧身份本身由故事+场景决定。
      previousFrame: state.sceneFrame,
      now: new Date().toISOString(),
      visibleEntryIds: (state.ledger?.entries ?? []).map(entry => entry.id),
    })
    if (frame.sourceEntryIds.length) state.sceneFrame = frame
  }

  const callerAgent = (exec) => exec?.agent
    ?? ctx.agents.currentInitiator?.()
    ?? [...liveAgents.values()].at(-1)

  /**
   * 解析一个会话的 IM 投递目标。
   *
   * 三层优先级（前两层就是 im.js 的 resolveImBinding）：
   *   1. 会话级 `/interlude im bind`（人工指定，最可信）；
   *   2. 插件配置里的 im.botId / im.targetId；
   *   3. **自动发现**——dsh-im 的「会话双向同步」已经把 conversationKey 绑到了会话上，
   *      从 `$DSH_HOME/integrations` 反查即可。
   *
   * 第 3 层是「主动回复发不出去」的修复核心：只有手工绑定过才生效的话，任何一次
   * 忘记 `/interlude im bind` 都会让主动开口在 QQ/微信里静默消失。
   *
   * @param {string} key 会话 id。
   * @param {object} state 会话状态。
   * @param {object} cfg 生效配置。
   */
  const bindingFor = (key, state, cfg) => {
    const configured = resolveImBinding(state, cfg)
    if (configured) return configured
    if (!key) return undefined
    // 自建通道自带绑定表——不再去读 dsh-im 的磁盘文件反查。
    // 旧的三层优先级（会话绑定 → 插件配置 → 自动发现）现在收敛为两层：
    // 「自动发现」变成了「查自己的绑定表」，可靠得多。
    const found = qqIm.bindingForSession(key)
    if (!found) return undefined
    return {
      botId: found.botId,
      targetId: found.targetId,
      conversationKey: found.conversationKey,
      // 群聊绑定：投递时用 scope 区分 group/c2c（见 deliverToIm）。
      scope: found.scope,
      source: 'discover',
      channel: 'qq',
      name: found.name,
    }
  }

  /**
   * 本会话是否确实经聊天软件收发（决定要不要注入「一条一条发」的说话方式）。
   *
   * **三态**（阶段 6）：
   *   - `'im'`：有绑定 → 注入 IM 形态的规则（怎么用 interlude_say 发言）；
   *   - `'story'`：IM 通道整体没启用，形态稳定是「写故事」；
   *   - `'unknown'`：IM 已启用但本会话此刻没有绑定 —— 形态随时可能因
   *     自动绑定/手工绑定而切换，**判不出**。此时不写 `canonInjectedIm`
   *     （B-1：写坏它会让「形态切换补注」失效），也不触发补注循环。
   */
  const imActiveFor = (key, state, cfg) => {
    if (bindingFor(key, state, cfg)) return 'im'
    if (cfg?.im?.enabled === true) return 'unknown'
    return 'story'
  }

  /* ------------------------------------------------ per-bot 人设（架构级） */

  /**
   * 一个 bot 的生效人设：bot 自己配了 `story` 用它，否则继承全局 `config.story`。
   *
   * 多 bot 场景下，每个机器人可以有独立角色；不配的 bot 行为与改版前完全一致。
   *
   * @param {object|undefined} bot `qqIm.config.bots[]` 里的条目。
   * @returns {object} story。
   */
  const storyForBot = (bot) => {
    const own = bot?.story
    return own && typeof own === 'object' && !Array.isArray(own) ? own : current().story
  }

  /**
   * 一个会话的生效人设：经绑定表反查它属于哪个 bot，再用该 bot 的 story。
   * 查不到（未绑定 / 绑定的 bot 已从配置移除）时回退全局 story。
   *
   * @param {string} key 会话 id。
   * @returns {object} story。
   */
  const storyForSession = (key) => {
    try {
      if (!key) return current().story
      const found = qqIm.bindings.bySessionId(key)
      if (!found?.botId) return current().story
      const bot = (qqIm.config.bots ?? []).find(b => b.botId === found.botId)
      return storyForBot(bot)
    } catch {
      return current().story
    }
  }

  /** 某个 bot 的角色名（绑定 name 用它；per-bot story 的主角名）。 */
  const storyNameFor = (botId) => {
    try {
      const bot = (qqIm.config.bots ?? []).find(b => b.botId === botId)
      const name = storyForBot(bot)?.character?.name
      return typeof name === 'string' && name.trim() ? name.trim() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * QQ 用户端机器人命令（对齐 dsh-im 的 /new /session /sessionlist /status /help）。
   *
   * 实现抽在 `lib/qq-im/bot-commands.js`（依赖注入，可单测）；这里只把依赖接上。
   * 由 channel.js 在入站时拦截（私聊、单行、以 / 开头），**不进模型**，
   * 命令操作的是「这条消息所属的 bot + 聊天」。
   */
  const handleBotCommand = createBotCommandHandler({
    qqIm,
    listStoredStates,
    storyNameFor,
    // /preset 需列出可切换的角色预设、并按名字/id 解析——复用宿主侧的预设来源。
    listPresets: () => listRoleplayPresets(),
    resolvePresetId: (nameOrId) => resolveAgentPresetId(nameOrId),
  })

  /**
   * 判定一个会话是否为「角色会话」：
   * - roleplayOnly 关闭 → 所有会话都算（保持旧行为）；
   * - 否则要求：会话被 /interlude on 标记（state.roleplay），或绑定了角色预设。
   *
   * 角色预设的权威位置是 **SessionHeader**：`agent.session.header.agentPreset`
   * （dsh-session 用创建时的 `meta.agentPreset` 构造 header，并以 `session.header` 持有；
   * 序列化进日志时，该字段被平铺在 header 行的顶层）。因此三种位置都读，按可信度依次兜底。
   * 注意：内置默认预设（standard / default / minimal-* / router-standard 等）也是非空字符串，
   * 但它们是「非角色」预设；只有真实落在 `~/.dsh/.agent-presets/<id>/` 下的预设目录才视为角色预设。
   */
  const isRoleplayPresetId = (presetId) => {
    if (typeof presetId !== 'string' || presetId.trim() === '') return false
    const id = presetId.trim()
    try {
      return fs.existsSync(path.join(agentPresetsRoot(), id, 'preset.yml'))
        || fs.existsSync(path.join(agentPresetsRoot(), id, 'agent.cordis.yml'))
    } catch {
      return false
    }
  }

  const isRoleplaySession = (agent, state) => {
    if (current().runtime?.roleplayOnly === false) return true
    if (state?.roleplay === true) return true
    const session = agent?.session
    // 运行时权威位置：agent.session.header.agentPreset（SessionHeader）。
    // 后两种是历史/序列化形态的兼容兜底，顺序不可颠倒。
    const presetId = session?.header?.agentPreset
      ?? session?.agentPreset
      ?? session?.meta?.agentPreset
    return isRoleplayPresetId(presetId)
  }

  /**
   * 冷会话（没有实时 agent）的角色会话判定。
   *
   * 冷会话读不到 SessionHeader，只剩两条依据：
   *   - `/interlude on` 标记；
   *   - 真实存在过的幕间痕迹（注入过人设、记过待办、有互动时间）。
   *
   * 为什么不用「预设 id」：预设 id 不在状态里。反过来，只要状态里有痕迹，
   * 就说明这个会话此前确实被当作角色会话在跑——重新加载它不会误伤普通会话。
   */
  const isRoleplayState = (state) => {
    if (current().runtime?.roleplayOnly === false) return true
    if (state?.roleplay === true) return true
    return state?.canonInjected === true
      || (Array.isArray(state?.intents) && state.intents.length > 0)
      || Number.isFinite(state?.lastUserAt)
  }

  /* ------------------------------------------------- 每步注入：人设 + 幕间事实
   * 注意：人设（canon）与规则（rules）不再注册为全局 systemPrompt.section——
   * 那会让江柚的人设注入所有会话。改为在 pre-step 里按「角色会话」门控注入：
   * 首次角色回合注入一次人设+规则（持久于会话日志），此后每回合注入幕间时间事实。
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!current().enabled) return decision
    if (!decision || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted) return decision

    const entry = entryFor(payload.agent)
    if (!entry) return decision
    const { state } = entry
    // roleplayOnly 开启时，非角色会话不注入任何东西（人设、规则、幕间块）。
    if (!isRoleplaySession(payload.agent, state)) return decision
    const now = Date.now()
    const cfg = current()
    const due = dueIntents(state, now)
    // 这个会话到底会不会经聊天软件发出去——决定「一条一条发」的说话方式要不要注入。
    // 三态：'im' 有绑定 / 'story' 通道未启用 / 'unknown' 判不出（不写 canonInjectedIm）。
    const imActive = imActiveFor(entry.key, state, cfg)

    const messages = []

    // 首次角色回合：注入人设（canon）+ 规则（rules），持久于会话日志。
    // 规则段按**会话形态**分叉：
    //   - 绑定了聊天软件的会话：你在聊天软件里和对方说话（IM 规则，只写发得出去的字）；
    //   - 没绑定的会话：没有人收到你的话，你写的每一段都只是故事（故事续写规则）。
    // 两条规则的口径正好相反（前者禁旁白、后者要旁白），给错了故事就会写成聊天记录，
    // 或者聊天记录里塞满旁白——所以这里必须按实际形态选，而不是一律给 IM 规则。
    //
    // ⚠️ 形态会变。绑定可能在首轮之后才建立（先聊了几天，才把 QQ 接上），
    // 而 canonInjected 一旦置位就永不再注 —— 结果是模型从来没被告知过
    // 「怎么把话说出去」，只会看到「可能发消息」的模式行，于是把话写在正文里。
    // 线上故障 session-xxx 就是这样（规则段 09-12 注入、绑定 09-15 才建立）。
    //
    // 所以判据不是「注入过没有」，而是「**按当前形态**注入过没有」：
    // 形态从「无绑定」变成「有绑定」时，补一次。
    // 'unknown' 时**不参与对比**（判不出就不写、也不触发补注循环，B-1）。
    const formChanged = state.canonInjected === true
      && imActive !== 'unknown'
      && state.canonInjectedIm !== imActive
    if (state.canonInjected !== true || formChanged) {
      // canon 是稳定的身份设定，形态变化时不必重发（省上下文）。
      // per-bot 人设：注入该会话所属 bot 的 story（未绑定/无 per-bot story → 全局）。
      if (state.canonInjected !== true) {
        const canonText = renderCanon(storyForSession(entry.key))
        if (canonText) {
          messages.push(createUserMessage({
            content: [{ type: 'text', text: canonText }],
            source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:canon`, text: canonText }] },
          }))
        }
      } else {
        // 只补「怎么发言」这一段，并把口径从故事切到 IM。
        messages.push(createUserMessage({
          content: [{ type: 'text', text: IM_FORM_SWITCH_NOTICE }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:im-form` }] },
        }))
      }
      const rulesText = renderRules(cfg, { imActive: imActive === 'im' })
      if (rulesText) {
        messages.push(createUserMessage({
          content: [{ type: 'text', text: rulesText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:rules`, text: rulesText }] },
        }))
      }
      if (imActive !== 'im') {
        const storyText = storyRules(autoMessageOnFor(cfg))
        messages.push(createUserMessage({
          content: [{ type: 'text', text: storyText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:story`, text: storyText }] },
        }))
      }
      state.canonInjected = true
      if (imActive !== 'unknown') state.canonInjectedIm = imActive
    }

    // 每回合：幕间时间事实。只在该回合的**第一个 step** 注入一次。
    //
    // 为什么必须按 step 挡：agent 每跑一个 step 都会触发一次 pre-step，而模型
    // 调用工具（如 interlude_plan）会生成第二个 step。若不挡，同一回合里会注入
    // 两条几乎一样的幕间块——线上日志可见：turn 2 的 21:34:53 与 21:34:56、
    // turn 4 的 22:19:55 与 22:19:58，相隔 3 秒，纯浪费上下文。
    // 时间事实在回合开始时说一次就够；step 2 的模型已经在写最终回复，不需要再喂。
    const stepNo = Number.isSafeInteger(payload?.step) ? payload.step : 1
    if (stepNo === 1) {
      // 这一轮的「发不发」事实由 scheduleAdvance 在唤起前写进 state，
      // 这里只负责读出来告诉模型（见 renderSpeechModeLine 的说明）。
      const modeLine = state.advanceMode === 'speak' || state.advanceMode === 'story-only'
        ? renderSpeechModeLine(cfg, state.advanceMode)
        : ''
      // 场景帧 + 对话突发：**确定性投影**出来的当下场景，不是模型的自由文本。
      //
      // 为什么要注入：模型每轮都在重新"理解"现在是什么场景（在哪、谁在、在做什么），
      // 而证据早就在账本里了。让它自己猜只会引入新的幻觉来源，且每轮答案都不一样。
      // 投影出来的字段每一条都带溯源——没有证据的部分**不出现**，
      // 而不是留个空占位符邀请它填空。
      const frameText = renderSceneFrame(state.sceneFrame)
      const burstText = renderDialogueBurst(state.dialogueBurst, new Date(now).toISOString())
      // 活跃剧情余波：仍在影响她当下的具体事件（会自然过期）。
      const consequences = (state.activeConsequences ?? []).filter(item => item.status === 'active')
      const consequenceText = consequences.length
        ? `仍在影响当下的余波：\n${consequences.slice(0, 4).map(item => `- ${item.content}`).join('\n')}`
        : ''
      // 交付现实：上一条消息**到底有没有送出去**。
      //
      // 为什么必须告诉模型：投递失败时，角色在故事里照样"说过了"，
      // 而用户那边什么都没收到——双方对「说过没有」的认知就此分叉，
      // 且不会报错、不会留痕（这正是它难查的原因）。
      // 只有失败/部分失败时才说：成功是默认预期，每次都念叨是噪声。
      const deliveryText = deliveryRealityLine(state)
      // 续写书签：告诉模型「从哪儿接着写」，**用指针而不是副本**。
      //
      // 复制最近原文会让同一段对话在上下文里出现两遍，模型容易当成
      // 「又发生了一次」而重复回答。书签只给条目 id 与字符偏移，
      // 原文仍只在会话日志里出现一次。
      const bookmark = continuationBookmark({
        entries: state.ledger?.entries ?? [],
        from: Number.isFinite(state.lastAssistantAt) ? state.lastAssistantAt : now,
        now,
      })
      const bookmarkText = renderContinuationBookmark(bookmark)
      // 连发同条数守卫（Repetition Guard，上游 rc18）：她最近连续几批都以同样的
      // 条数开口 → 那是格式惯性不是语气，本段不要复刻。
      //
      // 只在**私聊对话回合**检测（上游口径）：自动推进是她在过自己的生活，
      // 条数形态不构成对用户的锚定；群聊协议与投递路径也不同。
      const repetitionText = repetitionGuardFor(state, payload, cfg)
      const extraLine = [modeLine, frameText, burstText, consequenceText, deliveryText, bookmarkText, repetitionText, DEVELOPMENT_FRAME]
        .filter(Boolean).join('\n')
      // 长期记忆：按「重要度 + 新旧」排序，再叠加**词法相关度**。
      //
      // 查询串取「最近一条用户消息 + 到期待办摘要」：这正是「当下在聊什么」。
      // 只靠重要度排序的话，一条三个月前的高重要度事实会永远压过昨天刚聊到的细节；
      // 有了相关度，用户刚提到的那件事才浮得上来（见 lib/recall.js）。
      //
      // 注意这是**只读**的：召回只决定「把哪几条拿出来看」，不改变事实本身。
      const recentUserText = latestUserText(state)
      const facts = rankFacts(state, cfg.runtime?.memoryLimit ?? 20, now, {
        query: recallFocus(recentUserText, due.map(item => item.summary ?? '')),
      })
      const text = renderInterludeBlock({
        now, zone, state, config: cfg, due, imActive: imActiveFor(entry.key, state, cfg) === 'im', extraLine, facts,
      })
      if (text) {
        state.lastInjectedAt = now
        messages.push(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }))
      }
    }

    if (messages.length === 0) return decision
    saveState(entry.key, state)
    return {
      ...decision,
      messages: [...decision.messages, ...messages],
    }
  })

  /* ---------------------------------------------------------- 模型可调工具 */

  // 延迟意图 / 承诺回访
  ctx.tools.register(defineTool({
    name: 'interlude_plan',
    description: '记下一件「到点要处理」的事：延迟回复、提醒、主动关心、承诺回访、后续跟进。到期后它会重新进入你的上下文；若那时没有新消息且时机合适，你可能被唤起主动开口。只记真正需要你在未来某个时刻自己想起来的事。',
    parameters: {
      summary: { type: 'string', required: true, description: '到点要做什么，一句话，用第一人称。' },
      afterMinutes: { type: 'integer', required: true, description: '多少分钟后到期，1–10080。' },
      kind: { type: 'string', enum: ['reply', 'reminder', 'followup', 'contact', 'promise'], description: 'reply 延迟回复 / reminder 提醒 / followup 跟进 / contact 主动联系 / promise 承诺回访。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话，无法记录待办。`)
      const now = Date.now()
      const minutes = Math.min(10080, Math.max(1, Math.round(Number(args.afterMinutes) || 1)))
      const dueAt = now + minutes * MINUTE
      const summary = String(args.summary ?? '').trim()
      if (!summary) throw new Error(`${name}: summary 不能为空。`)
      const intent = addIntent(entry.state, { kind: args.kind || 'followup', summary, dueAt }, now)
      saveState(entry.key, entry.state)
      // 「一分钟后提醒我喝水」不该等到下一次五分钟扫描——那就成了「六分钟后」。
      // 这里按精确到点时间补一个一次性定时器，扫描仍是兜底（进程重启、定时器丢失、
      // 容量当时不满足等都由它收口）。
      scheduleIntentWake(entry.key, dueAt)
      return `已记下 (${intent.id})：${summary}；到点时间 ${formatStoryDisplayTime(new Date(dueAt), zone)}，约 ${minutes} 分钟后。`
    },
  }))

  // 情绪偏移追踪（Alter System）
  ctx.tools.register(defineTool({
    name: 'interlude_alter',
    description: '报告本轮对话让整体氛围发生的净变化：-5 更轻松随意，0 无变化，+5 更严肃绷紧。累积过阈值后会成为你后续应答的底色（权重同向增强、反向消退）。只在氛围确实移动时调用，不必每轮都报。',
    parameters: {
      shift: { type: 'integer', required: true, description: '-5 到 5 的净变化。' },
      note: { type: 'string', description: '可选：一句话说明当下的底色；触发时会采用这句（替代侧端模型生成描述）。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const cfg = current()
      const alterCfg = alterConfigOf(cfg)
      const shift = normalizeAlterValue(Number(args.shift))
      if (shift === undefined || shift === 0) return '无净变化，未记录。'
      const now = new Date()
      const result = advanceAlterSystem(entry.state.alter, shift, 'user-message', now, alterCfg)
      entry.state.alter = result.state // 无论是否触发阈值，累积值都必须写回，否则会逐轮丢失
      let reply
      if (result.thresholdReached) {
        if (alterAnalysisCoolingDown(entry.state.alter, now)) {
          reply = `累计 ${result.state.alterValue} 已过阈值 ${result.threshold.toFixed(1)}，但仍在冷却期，暂不生成新底色。`
        } else {
          const note = typeof args.note === 'string' && args.note.trim()
            ? args.note.trim()
            : (result.state.alterValue > 0 ? '整体氛围比之前更严肃绷紧。' : '整体氛围比之前更轻松随意。')
          entry.state.alter = completeAlterAnalysis(result.state, note, result.threshold, now, alterCfg)
          entry.state.alter.lastAnalysisAttemptAt = now.toISOString()
          reply = `氛围底色已触发（${entry.state.alter.emotionalOffset.direction}，强度 ${entry.state.alter.emotionalOffset.intensity.toFixed(1)}）：${note}`
        }
      } else {
        reply = `已累积 ${result.state.alterValue}，阈值 ${result.threshold.toFixed(1)}，尚未触发。`
      }
      saveState(entry.key, entry.state)
      return reply
    },
  }))

  // 长期事实
  ctx.tools.register(defineTool({
    name: 'interlude_memory',
    description: '维护长期记忆：add 写入一条承诺/重要事件/稳定世界事实/未解决事项；close 关闭一条已兑现或已失效的事实；overlay 记录一次累积性的设定演化。',
    parameters: {
      action: { type: 'string', enum: ['add', 'close', 'overlay'], required: true, description: 'add / close / overlay。' },
      content: { type: 'string', description: 'add 时：事实内容。' },
      scope: { type: 'string', enum: ['promise', 'event', 'world', 'relationship', 'general'], description: '事实类别。' },
      importance: { type: 'number', description: '0–1 重要度。' },
      id: { type: 'string', description: 'close 时：事实 id。' },
      layer: { type: 'string', enum: ['character', 'perspective', 'relationship', 'world'], description: 'overlay 时：作用于哪一层设定。' },
      dimension: { type: 'string', description: 'overlay 时：白名单维度（traits/preferences/coping/values/interpretation/trust/closeness/boundaries/established）。' },
      // 认知模式：这条是「她的解读」还是「双方确认」。
      //
      // 为什么必须让模型显式声明：默认值无论取哪个都会出错——默认 confirmed
      // 会让「她以为」变成「说定了」；默认 belief 又会把真的约定降级。
      // 所以不给默认值，让模型自己承担这个判断，并且必须给证据。
      knowledge: {
        type: 'object',
        additionalProperties: false,
        description: 'add 时（可选但强烈建议）：这条知识的认知模式与依据。'
          + 'mode=observed(亲眼所见)/reported(对方所说)/belief(她的解读)/proposal(已提出)/'
          + 'conditional(有前置条件)/confirmed(双方确认)。'
          + 'confirmed **必须**同时给出 proposal 与 confirmation 两条子句，且来自不同的人。',
        properties: {
          mode: {
            type: 'string',
            enum: ['observed', 'reported', 'belief', 'proposal', 'conditional', 'confirmed'],
            description: '认知模式。',
          },
          holder: { type: 'string', description: '谁持有这个认知（mode=belief 时默认主角）。' },
          topic: { type: 'string', description: '主题（必须出现在某条引文里）。' },
          clauses: {
            type: 'array',
            description: '[{ role, quote, sourceEntryId }]：role=observation/interpretation/proposal/condition/confirmation；'
              + 'quote 必须是该条目里的**逐字**片段；sourceEntryId 是本轮原文的条目 id。',
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const now = Date.now()
      if (args.action === 'add') {
        const content = String(args.content ?? '').trim()
        if (!content) throw new Error(`${name}: content 不能为空。`)
        // 认知证据：拿模型给的 mode/clauses 去账本里**逐字校验**。
        // 引用对不上的子句会被丢掉；丢光就退化成 unclassified（什么都确认不了）——
        // 这是刻意的：宁可标成「不确定」，也不要让一条没依据的 confirmed 混进来。
        const sourceIds = (entry.state.ledger?.entries ?? []).slice(-20).map(item => item.id)
        const knowledge = args.knowledge
          ? normalizeKnowledgeEvidence(args.knowledge, entry.state.ledger, sourceIds)
          : undefined
        const fact = addFact(entry.state, {
          scope: args.scope, content, importance: args.importance,
          ...(knowledge ? { knowledge } : {}),
        }, now)
        saveState(entry.key, entry.state)
        const note = knowledge && knowledge.mode !== 'unclassified'
          ? `［${knowledge.mode}］`
          : knowledge ? '［证据不足，未标认知模式］' : ''
        return `已写入长期事实 (${fact.id})${note}：${content}`
      }
      if (args.action === 'close') {
        const fact = closeFact(entry.state, String(args.id ?? ''), 'resolved')
        saveState(entry.key, entry.state)
        return fact ? `已关闭 (${fact.id})：${fact.content}` : `没有找到事实 ${args.id}。`
      }
      if (args.action === 'overlay') {
        const content = String(args.content ?? '').trim()
        if (!content) throw new Error(`${name}: overlay 需要 content。`)
        const layer = String(args.layer ?? '').trim()
        // 维度白名单：不在表内的一律拒绝（不猜、不纠正）。
        const dimension = developmentDimension(layer, String(args.dimension ?? ''))
        if (!dimension) {
          throw new Error(`${name}: dimension 必须是白名单内的维度（character.traits/preferences/coping、`
            + `perspective.values/interpretation、relationship.trust/closeness/boundaries、world.established）。`)
        }
        // **跨场景门控**：性格/关系的长期变化要跨 ≥2 个不同场景才够格。
        //
        // 为什么要有这一关：模型很容易把一次单独互动（甚至一句玩笑）就上升成
        // 「她的性格变了」，于是角色几轮之内性格急变。门控不是保守，而是
        // 「变化要被反复观察到才算数」。
        const existing = (entry.state.overlay ?? []).find(item => item.layer === layer)
        const candidate = { status: existing ? 'applied' : 'proposed', sourceEntryIds: [] }
        // 首次提交视为提案：要有跨场景证据才放行；已有 overlay 的更新沿用原 layer
        // （那条已经被采纳过，重复门槛只会让它永远改不动）。
        if (!existing && !promptReadyDevelopment(candidate, entry.state.ledger?.entries ?? [])) {
          const scenes = (entry.state.ledger?.entries ?? []).filter(item => item.kind === 'script').length
          return `设定演化暂未采纳：${layer}.${dimension} 需要**跨越至少两个不同场景**的证据`
            + `（当前账本里只有 ${scenes} 条正文，尚不足以支持长期变化）。`
            + `一次互动只算一个场景——这不代表她没变化，只是还不到改长期设定的程度。`
        }
        const ov = upsertOverlay(entry.state, { layer, content: `${dimension}：${content}` }, now)
        saveState(entry.key, entry.state)
        return `设定演化已更新（${ov.layer}.${dimension}，第 ${ov.evidence} 次证据）：${content}`
      }
      return '未知 action。'
    },
  }))

  // 主体行动窗口（Agency Window）
  ctx.tools.register(defineTool({
    name: 'interlude_agency',
    description: '更新主体行动窗口：报告角色当下的日程负荷、隐私空间、设备可用性。这决定到期意图能否主动开口（负荷过载/无隐私/设备不可用会延后）。',
    parameters: {
      activityLoad: { type: 'string', enum: ['free', 'occupied', 'overloaded'], required: true, description: '日程负荷。' },
      privacy: { type: 'string', enum: ['private', 'shared', 'public'], required: true, description: '隐私空间。' },
      deviceAccess: { type: 'string', enum: ['available', 'limited', 'unavailable'], required: true, description: '设备可用性。' },
      basis: { type: 'string', description: '一句生活依据（为什么是当前状态）。' },
      nextOpportunityAt: { type: 'string', description: '可选：下次合适的开口时间（ISO）。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const now = Date.now()
      const cfg = current()
      const agencyCfg = resolveAgencyConfig(cfg.agency ?? {})
      const validUntil = new Date(now + Math.max(5, agencyCfg.maxWindowMinutes) * MINUTE)
      const nextOpportunityAt = args.nextOpportunityAt ? new Date(args.nextOpportunityAt) : undefined
      entry.state.agencyWindow = {
        activityLoad: args.activityLoad,
        privacy: args.privacy,
        deviceAccess: args.deviceAccess,
        nextOpportunityAt: nextOpportunityAt && !Number.isNaN(nextOpportunityAt.getTime()) ? nextOpportunityAt.toISOString() : undefined,
        validUntil: validUntil.toISOString(),
        basis: typeof args.basis === 'string' ? args.basis.trim().slice(0, 500) : '',
        sourceEntryIds: [],
        updatedAt: new Date(now).toISOString(),
      }
      saveState(entry.key, entry.state)
      return `Agency Window 已更新：负荷=${args.activityLoad} 隐私=${args.privacy} 设备=${args.deviceAccess}（有效期至 ${formatStoryDisplayTime(validUntil, zone)}）。`
    },
  }))

  /**
   * 列出「模型给了、但没通过逐字校验」的字段。
   *
   * 为什么要把这个回给模型：交接是**可选**的，模型第一次给引文很可能对不上
   * （它习惯转述而不是抄原文）。如果只回一句「未采纳」，它下一轮多半还会犯同样的
   * 错；点名说清「哪一项、为什么」，它才知道要**逐字**引用。
   *
   * @param {object} raw 模型给的原始参数。
   * @param {object} handoff 规范化后通过的交接。
   * @returns {string} 逗号分隔的字段名；没有丢弃项则为空串。
   */
  const describeDropped = (raw, handoff) => {
    const names = []
    if (raw?.place && !handoff.place) names.push('place')
    if (raw?.activity && !handoff.activity) names.push('activity')
    if (raw?.presence && !handoff.presence) names.push('presence')
    if (raw?.transition && !handoff.transition) names.push('transition')
    if (Array.isArray(raw?.resolvedDetails) && raw.resolvedDetails.length && !handoff.resolvedDetails) {
      names.push('resolvedDetails')
    }
    return names.join('/')
  }

  /**
   * 「上一条消息到底送出去了没有」——只在**出问题**时才告诉模型。
   *
   * ## 为什么需要
   *
   * 投递失败时，角色在故事里照样把话说完了，而用户那边什么都没收到。
   * 于是双方对「说过没有」的认知分叉——角色会接着往下聊一个对方根本没收到的话题。
   * 这个故障**不抛错、不留痕**，只表现为「用户说没收到」。
   *
   * ## 为什么只在失败时说
   *
   * 成功是默认预期。每轮都注入「上次发送成功」纯属噪声，还会挤占上下文
   * （与幕间块里那些「没必要说」的行同一条道理）。
   *
   * @param {object} state 会话状态。
   * @returns {string} 提示行；无异常时返回空串。
   */
  /**
   * 取「最近一条用户消息」的正文，用作记忆召回的查询串。
   *
   * 为什么不直接用 `payload.messages`：那是**本回合已注入的**消息（含插件自己的
   * 幕间块），拿它当查询会把上一条注入的内容当成"用户在说的事"。
   * 原文在账本里，而且那里已经过滤掉插件注入，用它更准。
   *
   * @param {object} state 会话状态。
   * @returns {string} 最近一条用户消息；没有则空串。
   */
  function latestUserText(state) {
    const entries = state?.ledger?.entries ?? []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.kind === 'user-message') return entries[i].content
    }
    return ''
  }

  // 用 `function` 声明而不是 `const` 箭头函数：它在 pre-step 里被调用，
  // 而那段代码在本行**之前**。函数声明会提升，箭头函数不会（会撞 TDZ）。
  function deliveryRealityLine(state) {
    const last = state.lastImDelivery
    if (!last || last.ok) return ''
    const sent = last.sentCount ?? 0
    const total = last.total ?? 0
    const detail = last.error ? `（${last.error}）` : ''
    // 部分送达要如实说清楚送出去几条——不能笼统说"没发出去"，
    // 那会让角色把已经送达的话再重复一遍。
    if (sent > 0 && sent < total) {
      return `交付现实：上一次开口只送出了 ${sent}/${total} 条${detail}，`
        + `**剩下的没有送达**。不要把没送出去的内容当成对方已经看到。`
    }
    return `交付现实：上一次开口**没有送达**${detail}。`
      + `你可以在故事里继续生活，但不要假定对方读到了那条消息。`
  }

  // 近期日程（Schedule Preplan）
  ctx.tools.register(defineTool({
    name: 'interlude_preplan',
    description: '提出近期日程审查结论：稳定周规律（regimes）与日期例外（exceptions）。outcome 为 unchanged/extend/patch/replace。只约束合理性，真实剧情优先。',
    parameters: {
      outcome: { type: 'string', enum: ['unchanged', 'extend', 'patch', 'replace'], required: true, description: '审查结论。' },
      reason: { type: 'string', required: true, description: '一句审查理由。' },
      regimes: { type: 'array', description: '周规律数组（[{id,label,from,to,weekly:{monday:[{id,start,end,label,kind}]}}]）。' },
      exceptions: { type: 'array', description: '日期例外数组。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const cfg = current()
      const preplanCfg = resolveSchedulePreplanConfig(cfg.schedulePreplan ?? {})
      const now = new Date()
      const today = calendarDayKey(now, zone)
      const evidence = [{ id: Math.max(0, entry.state.turns ?? 0) }]
      const proposal = { outcome: args.outcome, reason: args.reason, regimes: args.regimes, exceptions: args.exceptions }
      entry.state.preplan = applySchedulePreplanProposal(
        entry.state.preplan, proposal, evidence, today, zone, preplanCfg, now,
        preplanCfg.variationLevel,
      )
      saveState(entry.key, entry.state)
      return entry.state.preplan
        ? `Schedule Preplan 已更新（rev ${entry.state.preplan.revision}，${entry.state.preplan.regimes.length} 条规律 / ${entry.state.preplan.exceptions.length} 条例外）。`
        : '提议无效，保留原日程。'
    },
  }))

  /**
   * 生活交接：报告「这一轮发生的具体本地变化」（换了地方 / 在做别的 / 屋里谁在）。
   *
   * 为什么把它做成工具而不是从正文里猜：场景状态必须**可溯源**。
   * 猜出来的「她去了厨房」没有依据，而工具参数里的 `quote` 会被拿去
   * **逐字比对**本轮原文——对不上就整项丢弃。这样模型编不动。
   *
   * 注意它是**可选**的：不调用就代表「这一轮场景没变」，而不是「她一个人」。
   * 这个区别在描述里对模型讲清楚了（见 LIFE_HANDOFF_FRAME 的同一条说明）。
   */
  ctx.tools.register(defineTool({
    name: 'interlude_handoff',
    description: '报告这一轮发生的**具体本地变化**：位置、正在做的事、屋里实际在场的人、已完成的小事。'
      + '每一项都必须附带**本轮续写原文里的逐字片段**作为依据（quote），对不上会被丢弃。'
      + '**不调用就代表「这一轮场景没变」**；若要表达「她确实一个人」，请用 presence 且 names 留空并给出依据。',
    parameters: {
      // 注意：DSH 的 schema 编译器要求 `type: 'object'` **必须显式**声明布尔
      // `additionalProperties`，否则整个插件在注册时就会抛错；声明成 false 时
      // 还必须把 `properties` 写全，否则模型一传参就被判「未声明的属性」。
      // 所以这里把每个子结构的形状都钉死——顺带也让模型更清楚该给什么。
      place: {
        type: 'object',
        additionalProperties: false,
        description: '当前位置。value 是结论，quote 是**本轮原文里的逐字片段**。',
        properties: {
          value: { type: 'string', description: '位置名，如「厨房」。' },
          quote: { type: 'string', description: '本轮正文里的逐字片段（会被逐字比对）。' },
        },
      },
      activity: {
        type: 'object',
        additionalProperties: false,
        description: '此刻在做的事。value 是结论，quote 是逐字片段。',
        properties: {
          value: { type: 'string', description: '活动，如「烧水」。' },
          quote: { type: 'string', description: '本轮正文里的逐字片段（会被逐字比对）。' },
        },
      },
      presence: {
        type: 'object',
        additionalProperties: false,
        description: '**完整的**本地在场名单。独处时 names 给空数组并附依据；不传 presence 表示「这一轮没说」，不等于一个人。',
        properties: {
          names: { type: 'array', description: '此刻物理上在场的人名；每个名字都必须出现在 quote 里。' },
          quote: { type: 'string', description: '支持这份名单的原文逐字片段。' },
        },
      },
      transition: {
        type: 'object',
        additionalProperties: false,
        description: '明确的本地场景转换（如「回到客厅」）。会给在场名单做整体重置。',
        properties: {
          quote: { type: 'string', description: '本轮正文里表示场景转换的逐字片段。' },
        },
      },
      resolvedDetails: { type: 'array', description: '这一轮完成掉的进行中细节：[{ label: "既有的细节标签", quote: "它确实完成的那句原文" }]。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const state = entry.state
      // 依据是**最近一条角色正文**（就是这一轮写出来的那段）。
      // 没有正文就没有可比对的原文，交接无从谈起——如实拒绝，不猜。
      const latest = [...(state.ledger?.entries ?? [])].reverse().find(item => item.kind === 'script')
      if (!latest) {
        return '还没有可依据的续写正文，这次交接未记录。请先写出这一轮的故事。'
      }
      const handoff = normalizeLifeHandoff(args, latest.content)
      if (!handoff) {
        // 全部没通过时也要**点名**是哪几项，并给出可照抄的原文片段。
        //
        // 只回一句「未记录」模型下一轮多半照错不误——它习惯转述而不是抄原文。
        // 把「你给的引文对不上」和「本轮原文长这样」一起回给它，它才知道怎么改。
        const which = describeDropped(args, {}) || '参数'
        const preview = latest.content.length > 200 ? `${latest.content.slice(0, 200)}…` : latest.content
        return `没有一项能对上原文的逐字引文，这次交接未记录（未采纳：${which}）。`
          + `quote 必须是本轮正文里**原样连续**的片段，不能改写或概括。本轮正文是：${preview}`
      }

      const nowIso = new Date().toISOString()
      const currentPlace = state.sceneFrame?.place ?? ''
      const before = state.scenePresence ?? []
      state.scenePresence = applyPresence(before, handoff, latest.id, { currentPlace, now: nowIso })

      // 已完成的进行中细节：按 label 从 workingDetails 里摘掉。
      // 与上游一致——**不做模糊匹配**，label 对不上就留着（宁可多留，不要误删）。
      const labels = resolvedLabels(handoff)
      if (labels.size) {
        state.workingDetails = (state.workingDetails ?? []).filter(item => !labels.has(item?.label))
      }

      // 交接刚改动了在场/细节，帧要**立刻**跟着重算。
      //
      // 不能等下一次 pre-step：模型完全可能在同一轮里先调 interlude_handoff、
      // 再去看幕间块，那时它看到的会是旧场景。
      reprojectFrame(state)
      saveState(entry.key, state)

      const parts = []
      if (handoff.place) parts.push(`位置=${handoff.place.value}`)
      if (handoff.activity) parts.push(`活动=${handoff.activity.value}`)
      if (handoff.presence) parts.push(`在场=${handoff.presence.names.length ? handoff.presence.names.join('、') : '（一个人）'}`)
      if (labels.size) parts.push(`已完成=${[...labels].join('、')}`)
      const dropped = describeDropped(args, handoff)
      return `生活交接已记录：${parts.join(' ')}。`
        + (dropped ? `（未采纳：${dropped}——引文对不上原文）` : '')
    },
  }))

  /**
   * 发言工具 —— 「从根上分离」的核心。
   *
   * 为什么需要它：在此之前，「角色要说什么」是从**正文的文本形态**推断出来的
   * （整行引号即台词）。这个判据被线上事故反复击穿：
   *   ① 模型把思考写成正文 → 整段被逐字发出去；
   *   ② 模型在思考**里**用引号列候选台词 → 候选被当成真台词发出去。
   * 根因不是判据不够严，而是**思考与发言共用了同一个通道**。
   *
   * 有了这个工具，两者在通道上就分开了：
   *   - 正文 = 故事，只留在 DSH 会话里，永远不发；
   *   - 要发出去的话，必须调本工具明确说出来。
   *
   * 于是「模型把思考写成正文」这件事**不再有任何投递后果**——它压根不参与投递。
   *
   * 注意本工具的 execute 只做参数校验与回报，**不在这里投递**：
   * 真正发出去要等回合结束，由 handleProactive / handleAutoAdvance 按
   * 频次、配额、绑定统一裁定（投递策略只有一份，不在两个地方各写一套）。
   */
  ctx.tools.register(defineTool({
    name: 'interlude_say',
    description: '把你要发给对方的话说出去。**只有通过这个工具说出来的话才会被发送**——正文（旁白、动作、你的思考）永远只留在本地，对方看不到。想说的每一句话单独一条；不调用本工具就代表这一轮你什么都不想说。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要发给对方的话。想连发几条就用换行分开，每行一条、每条一件事（像真人聊天那样）。只写你会真正打出来发出去的字，不要写旁白或解释。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话，无法投递。`)
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error(`${name}: text 不能为空；不想说话就不要调用本工具。`)
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
      const cfg = current()
      const binding = bindingFor(entry.key, entry.state, cfg)
      if (!binding) {
        return `已记下这段话，但当前会话没有绑定聊天软件，所以没有发出去。`
      }
      // 投递发生在回合结束后（见 handleProactive / handleAutoAdvance）：
      // 那里才有完整的频次与配额上下文。这里只如实回报。
      return `已记下 ${lines.length} 条，将在本回合结束时发送。`
    },
  }))

  /**
   * 发一张图片（表情包 / 照片）给对方。
   *
   * 与 `interlude_say` 同一套结构：**只有显式调用本工具才会发图**，
   * 正文里写图片路径不会有任何投递后果。
   *
   * 为什么单独一个工具而不是给 interlude_say 加参数：`text` 是「每行一条」的
   * 纯文本管线，混进图片会让「第几条是图、第几条是字」变得没法表达。
   * 拆成两个工具后，**模型调用它们的先后顺序就是发送顺序**——
   * 「先甩张图再补一句」和「先说一句再甩图」都能表达（见 say.js 的有序收集）。
   *
   * ## 三种给图方式（按优先级）
   *
   *   ① `url`       —— 网络地址；
   *   ② `file_path` —— 完整本地路径；
   *   ③ `name`      —— **只给名字**，从表情库里找（找不到再在默认目录下按
   *      文件名单个试）。这是给模型最省事的方式：它不需要知道任何路径。
   *
   * ③ 是刻意设计的：要求模型记住 `D:/pics/xx.png` 这种绝对路径不现实，
   * 而「从库里挑一个叫开心的」是它能稳定做对的事。
   *
   * 图片来源只接受本地路径或 http(s)；`file:` / `data:` 一律拒绝
   * （理由见 outbound.normalizeImageSource 的注释）。
   */
  ctx.tools.register(defineTool({
    name: 'interlude_send_image',
    description: '给对方发一张图片（表情包、照片等）。只有通过本工具发的图片才会被送出去，正文里提到的图片不会被发送。想同时说点什么，另外调用 interlude_say——两个工具的调用先后顺序就是发送顺序。最省事的用法是只给 name（如「开心」），会从表情库里找。',
    parameters: {
      name: {
        type: 'string',
        description: '表情库里的表情名（如「开心」「无语」）。推荐优先用它——不必知道任何路径。可先用 interlude_stickers 查看库里有什么。与 file_path / url 三选一。',
      },
      file_path: {
        type: 'string',
        description: '本地图片文件的完整路径（如 D:/pics/开心.png）。只给文件名时会到表情包目录下找。支持 png / jpg / jpeg / gif / webp / bmp。',
      },
      url: {
        type: 'string',
        description: '图片的网络地址（http 或 https 开头）。与 file_path / name 三选一。',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话，无法投递。`)
      const cfg = current()
      const stickerDir = cfg.im?.stickerDir || defaultStickerDir()

      // ① 只给了名字 → 从表情库找。这是最常用的路径。
      const wantedName = typeof args.name === 'string' ? args.name.trim() : ''
      if (wantedName) {
        const hit = findStickerByName(stickerDir, wantedName)
        if (!hit) {
          // 报错时**列出库里有什么**，模型下一轮就能挑对，而不是反复猜同一个名字。
          const all = listStickers(stickerDir, { limit: 40 })
          const names = all.map(s => s.name).filter(Boolean)
          const hint = names.length
            ? `库里现有：${names.slice(0, 30).join('、')}`
            : `表情库还是空的（${stickerDir}）。你可以用 file_path 给一个本地图片路径。`
          throw new Error(`${name}: 表情库里没有叫「${wantedName}」的表情。${hint}`)
        }
        const binding0 = bindingFor(entry.key, entry.state, cfg)
        if (!binding0) return '已记下这张图片，但当前会话没有绑定聊天软件，所以没有发出去。'
        return `已记下表情「${hit.name}」，将在本回合结束时发送。`
      }

      // ② 给了路径/URL。
      let localPath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      // 只给了文件名（没有目录分隔符）→ 到表情库找同名文件。
      // 模型常把 file_path 当「文件名」用，宽容一点比报错有用。
      if (localPath && !path.isAbsolute(localPath) && !localPath.includes('/') && !localPath.includes('\\')) {
        const hit = findStickerByName(stickerDir, localPath.replace(/\.[a-z0-9]+$/i, ''))
        if (hit) localPath = hit.path
        else localPath = path.join(stickerDir, localPath)
      }

      const source = normalizeImageSource({ url: args.url, localPath })
      if (!source) {
        throw new Error(`${name}: 需要提供 name、file_path 或 url 之一，且只接受本地图片路径或 http(s) 网址。`)
      }
      // 本地文件当场校验存在性：等到投递时才发现路径写错，模型已经以为发出了。
      // 这里报错能让它**当场**改用正确的路径再试一次。
      if (source.localPath) {
        let ok = false
        try { ok = fs.existsSync(source.localPath) } catch { ok = false }
        if (!ok) {
          const all = listStickers(stickerDir, { limit: 30 })
          const names = all.map(s => s.name).filter(Boolean)
          const hint = names.length ? `表情库里有：${names.join('、')}` : `表情库目录：${stickerDir}`
          throw new Error(`${name}: 图片文件不存在：${source.localPath}。${hint}`)
        }
      }
      const binding = bindingFor(entry.key, entry.state, cfg)
      if (!binding) {
        return '已记下这张图片，但当前会话没有绑定聊天软件，所以没有发出去。'
      }
      return '已记下这张图片，将在本回合结束时发送。'
    },
  }))

  /**
   * 查看表情库 —— 让角色知道「自己有哪些表情可以用」。
   *
   * 为什么必须有这个工具：语言模型不知道磁盘上有什么。没有它，
   * `interlude_send_image({name})` 就只能靠猜，而猜错的表现是
   * 一条报错 + 一轮浪费。有了它，角色可以先看一眼再挑。
   */
  ctx.tools.register(defineTool({
    name: 'interlude_stickers',
    description: '查看表情库里有哪些表情可以用（含名字与来源）。想发表情包但不确定有什么时先调它，再用 interlude_send_image 的 name 参数发出去。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const cfg = current()
      const stickerDir = cfg.im?.stickerDir || defaultStickerDir()
      const all = listStickers(stickerDir, { limit: 60 })
      if (all.length === 0) {
        return `表情库是空的。目录：${stickerDir}\n把喜欢的表情包图片放进这个目录（或它的 mine/ 子目录），之后就能用名字发出来；对方发来的表情也会自动存进来。`
      }
      const lines = [`表情库（${all.length} 个）：`]
      for (const item of all) {
        const from = item.source === 'inbound' && item.sender
          ? `（来自对方的表情）`
          : '（你自己的）'
        lines.push(`- ${item.name}${from}`)
      }
      lines.push('用 interlude_send_image 的 name 参数发送。')
      return lines.join('\n')
    },
  }))

  // 读取幕间事实
  ctx.tools.register(defineTool({
    name: 'interlude_state',
    description: '读取当前幕间事实：角色本地时间、距上次互动多久、连续性快照、长期事实、气氛底色、到期待办、主体行动窗口、近期日程。拿不准「现在是什么时候」时用它。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      // 身份暴露 gate：只有「角色会话」才能读到主角身份。
      //
      // 为什么必须 gate：工具是全局注册的，任何会话都能调。而 renderStatus 第一行
      // 就是 `- 主角：<全局配置的角色名>`（story.character.name，与哪个 bot 无关）。
      // 普通会话（standard 预设、未被 /interlude on 标记）没有角色人设，一旦调了
      // interlude_state 就会读到全局主角名，模型据此「冒充」角色——
      // 线上症状：新接入的 bot 自称江柚。它其实没有江柚人设（canonInjected=false），
      // 是 interlude_state 把全局主角名透给了它。
      //
      // gate 用 isRoleplaySession（看 agentPreset / roleplay 标记），**不用**
      // isRoleplayState——后者会把「收到过 QQ 消息」的会话（lastUserAt 有值）也
      // 判成角色会话，gate 就失效了。这里一定在实时 agent 里执行，有 header 可查。
      if (!isRoleplaySession(entry.agent, entry.state)) {
        return '本会话未启用幕间层角色（没有角色预设，也未标记为角色会话），幕间工具对普通会话不生效。'
      }
      const cfg = current()
      const now = Date.now()
      return renderStatus({
        now, zone, state: entry.state,
        // per-bot 人设：主角名用该会话所属 bot 的 story（未绑定/无 per-bot story → 全局）。
        config: { ...cfg, story: storyForSession(entry.key) },
        due: dueIntents(entry.state, now),
        imBinding: bindingFor(entry.key, entry.state, cfg),
      })
    },
  }))

  /* ------------------------------------------------------------ 人类命令 */

  ctx.commands.register({
    name: 'interlude',
    description: '幕间层：status/context/schedule/memory/overlay/alter/agency/preplan/advance/im/purge。',
    handler: async ({ agent, rawInput }) => {
      const entry = entryFor(agent)
      if (!entry) return { kind: 'error', text: `${name}: 当前没有可归属的会话。` }
      const { key, state } = entry
      const now = Date.now()
      const cfg = current()
      const input = String(rawInput ?? '').trim()
      const [verb = 'status', ...rest] = input.split(/\s+/)
      const argument = rest.join(' ').trim()

      switch (verb) {
        case 'status':
          // per-bot 人设：主角名用本会话所属 bot 的 story（未绑定 → 全局）。
          return {
            kind: 'success',
            text: [
              renderStatus({ now, zone, state, config: { ...cfg, story: storyForSession(key) }, due: dueIntents(state, now), imBinding: bindingFor(key, state, cfg) }),
              // 运行健康段（内存滚动指标，重载后归零）：一眼看出最近稳不稳。
              renderHealthSection(health.snapshot(key)),
            ].filter(Boolean).join('\n\n'),
          }
        case 'context': {
          // 按得分排序，不是按插入顺序取前 N 条（见 state.js 的 rankFacts 说明）。
          const facts = rankFacts(state, cfg.runtime?.memoryLimit ?? 20, now)
          const lines = [
            `连续性快照：${state.continuity || '（无）'}`,
            `长期事实（${facts.length}，按重要度/时效排序）：`,
            ...facts.map(f => `  (${f.id}) [${f.scope}] ${renderKnowledge(f.knowledge)}${f.content}`),
            `设定演化（Overlay，${state.overlay?.length ?? 0}）：`,
            ...(state.overlay ?? []).map(o => `  ${o.layer}: ${o.content}`),
          ]
          // 条目账本与情节分组的概览：排查「溯源为什么对不上」时最先要看的东西。
          const entries = state.ledger?.entries ?? []
          if (entries.length) {
            const index = buildEpisodeIndex(entries)
            const groups = new Set()
            for (const ids of index.values()) groups.add(ids.join(','))
            lines.push(`条目账本：${entries.length} 条（id ${entries[0]?.id}–${entries.at(-1)?.id}），`
              + `发号器下一个 ${state.ledger?.nextId ?? '?'}，情节分组 ${groups.size} 段。`)
            lines.push(`  最近 3 条：${entries.slice(-3).map(e => `#${e.id}:${e.kind}`).join('、')}`)
          } else {
            lines.push('条目账本：（空）')
          }
          // 自动推进的退避/熔断：持续失败时这里是唯一的可见处。
          const guardText = describeTimelineGuard(state.timelineGuard, now)
          if (guardText) lines.push(`自动推进：${guardText}`)
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'schedule': {
          const window = schedulePreplanWindow(state.preplan, new Date(now), zone, 12, cfg.schedulePreplan ?? {})
          if (!window) return { kind: 'error', text: '尚未建立近期日程。用 /interlude preplan refresh 或让模型提出日程。' }
          const lines = [`Schedule Preplan（rev ${window.revision}）：${window.from} → ${window.to}`]
          for (const b of window.blocks ?? []) lines.push(`  ${b.date} ${b.start}–${b.end} ${b.label}${b.location ? ` @${b.location}` : ''}${b.tentative ? '（可能）' : ''}`)
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'memory': {
          if (argument) {
            const fact = addFact(state, { content: argument }, now)
            saveState(key, state)
            return { kind: 'success', text: `已写入长期事实 (${fact.id})：${argument}` }
          }
          const facts = (state.facts ?? []).filter(f => f.status === 'active')
          return { kind: 'success', text: [`长期事实（${facts.length}）：`, ...facts.map(f => `  (${f.id}) [${f.scope}] ${f.content}`)].join('\n') }
        }
        case 'overlay': {
          if (argument === 'clear') return { kind: 'success', text: '用法：/interlude overlay clear <character|perspective|relationship|world|all>' }
          const [sub, target] = argument.split(/\s+/)
          if (sub === 'clear') {
            const ok = clearOverlay(state, target)
            saveState(key, state)
            return { kind: 'success', text: ok ? `已清除 overlay：${target}` : `未知层：${target}` }
          }
          const overlay = state.overlay ?? []
          return { kind: 'success', text: [`设定演化（${overlay.length}）：`, ...overlay.map(o => `  ${o.layer}: ${o.content}（证据 ${o.evidence}）`)].join('\n') }
        }
        case 'alter': {
          if (argument === 'reset') {
            const alter = entry.state.alter
            alter.alterValue = 0
            alter.alterWeight = 0
            alter.lastTriggerDirection = 0
            alter.emotionalOffset = null
            saveState(key, state)
            return { kind: 'success', text: '情绪偏移已清空。' }
          }
          const alter = state.alter
          return { kind: 'success', text: `Alter：累计 ${alter.alterValue}，权重 ${alter.alterWeight?.toFixed(2) ?? 0}${alter.emotionalOffset ? `，底色（${alter.emotionalOffset.direction}）：${alter.emotionalOffset.description}` : '，无底色'}` }
        }
        case 'agency': {
          if (argument) {
            const parts = argument.split(/\s+/)
            entry.state.agencyWindow = {
              activityLoad: parts[0] || 'free',
              privacy: parts[1] || 'private',
              deviceAccess: parts[2] || 'available',
              validUntil: new Date(now + 240 * MINUTE).toISOString(),
              basis: '',
              sourceEntryIds: [],
              updatedAt: new Date(now).toISOString(),
            }
            saveState(key, state)
          }
          const aw = state.agencyWindow
          return { kind: 'success', text: aw ? `Agency：负荷=${aw.activityLoad} 隐私=${aw.privacy} 设备=${aw.deviceAccess}（至 ${formatStoryDisplayTime(new Date(aw.validUntil), zone)}）` : '尚未建立 Agency Window。' }
        }
        case 'preplan': {
          if (argument === 'refresh') {
            const preplanCfg = resolveSchedulePreplanConfig(cfg.schedulePreplan ?? {})
            if (!state.preplan || state.preplan.timezone !== zone || schedulePreplanReviewDue(state.preplan, new Date(now), zone, preplanCfg)) {
              return { kind: 'success', text: '日程需要审查。请用 interlude_preplan 工具（或在此对话中提出结论）更新。' }
            }
            return { kind: 'success', text: '日程今日已审查，无需重复。' }
          }
          const window = schedulePreplanWindow(state.preplan, new Date(now), zone, 12, cfg.schedulePreplan ?? {})
          return { kind: 'success', text: window ? `Schedule Preplan（rev ${window.revision}）：${window.from} → ${window.to}` : '尚未建立近期日程。' }
        }
        case 'advance': {
          const interval = Math.max(1, cfg.runtime?.autoAdvanceIntervalMinutes ?? 40) * MINUTE
          if (Number.isFinite(state.lastAutoAdvanceAt) && now - state.lastAutoAdvanceAt < interval) {
            return { kind: 'error', text: `距上次推进不足 ${Math.round(interval / MINUTE)} 分钟。` }
          }
          state.lastAutoAdvanceAt = now
          const silent = !storyMessageGate(state, cfg, now, Boolean(bindingFor(key, state, cfg))).allowed
          state.advanceMode = silent ? 'story-only' : 'speak'
          saveState(key, state)
          try {
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: renderManualAdvanceNotice(silent) }],
              source: { kind: 'plugin', plugin: name, form: 'notice', summary: '手动推进一次剧本' },
            }))
            return { kind: 'success', text: silent
              ? '已请求手动推进一次剧本（本轮只写故事，不发消息）。'
              : '已请求手动推进一次剧本（若角色写了整句引语，会发出去）。' }
          } catch (error) {
            return { kind: 'error', text: `推进失败：${error?.message ?? String(error)}` }
          }
        }
        case 'im': {
          const [sub, ...rest] = argument.split(/\s+/).filter(Boolean)
          if (sub === 'bind') {
            const [botId, targetId] = rest
            if (!botId || !targetId) return { kind: 'error', text: '用法：/interlude im bind <botId> <targetId>' }
            state.imBinding = { botId, targetId, boundAt: new Date(now).toISOString() }
            saveState(key, state)
            return { kind: 'success', text: `已绑定本会话的 IM 投递目标：${botId} / ${targetId}` }
          }
          if (sub === 'unbind') {
            state.imBinding = null
            saveState(key, state)
            const stillFound = bindingFor(key, state, cfg)
            return { kind: 'success', text: stillFound?.source === 'discover'
              ? `已解除手工绑定，但本会话仍有一个绑定表目标可用：${stillFound.botId} / ${stillFound.targetId}（自动发现）。`
              : '已解除本会话的 IM 投递绑定。' }
          }
          if (sub === 'targets') {
            const service = qqIm.service
            let bots = []
            try { bots = await service.listBots() } catch (error) {
              return { kind: 'error', text: `列举 Bot 失败：${error?.message ?? error}` }
            }
            if (!Array.isArray(bots) || bots.length === 0) {
              return { kind: 'success', text: '没有可用的 IM Bot。请在设置里填 im.appId 与 AppSecret（或扫码绑定）。' }
            }
            const lines = []
            for (const bot of bots) {
              const botId = bot?.id ?? bot
              let targets = []
              try { targets = await service.listTargets(botId) } catch { targets = [] }
              lines.push(`Bot ${botId}（${bot?.connected ? '已连接' : '未连接'}）：${targets.length} 个目标`)
              for (const target of targets) {
                const mine = target?.sessionId === key ? '→ ' : '  '
                lines.push(`${mine}${target?.id}${target?.name ? ` ${target.name}` : ''} → 会话 ${String(target?.sessionId ?? '').slice(0, 20)}…`)
              }
            }
            lines.push('标 → 的就是本会话。收到 QQ 私聊会自动建立绑定。')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'test') {
            const binding = bindingFor(key, state, cfg)
            if (!binding) return { kind: 'error', text: '未绑定投递目标。先 /interlude im bind <botId> <targetId>，或在设置里填 im.appId 后让 QQ 消息自动绑定。' }
            // 用 | 分隔多段，模拟「角色连发几条」；不分段时给一段默认文案。
            const raw = rest.join(' ')
            const source = raw.includes('|') ? raw : (raw || '在忙吗 | 刚下楼买了瓶水 | 今天降温了 记得加件衣服')
            const parts = source.split('|').map(part => part.trim()).filter(Boolean)
            const result = await deliverToIm({
              key, state, cfg,
              text: parts.join('\n'),
              reason: '测试投递',
            })
            const detail = result.ok
              ? `已投递 ${result.sentCount} 条`
              : `失败：${result.error ?? '未知'}（已发送 ${result.sentCount} 条）`
            return { kind: result.ok ? 'success' : 'error', text: `IM 投递测试 → ${binding.botId} / ${binding.targetId}（来源：${IM_BINDING_SOURCE[binding.source] ?? binding.source}）：${detail}` }
          }
          if (sub === 'new') {
            // 对齐 dsh-im 的 /new：为当前聊天的 QQ 会话开一个全新 DSH 会话。
            // 语义：解绑当前会话与聊天的绑定 → 新建一个会话并绑回同一个聊天。
            const binding = bindingFor(key, state, cfg)
            if (!binding) {
              return { kind: 'error', text: '本会话没有绑定聊天软件，没有可解绑的聊天。先让 QQ 消息绑定它，或 /interlude im bind <botId> <targetId>。' }
            }
            const conversationKey = binding.conversationKey
              ?? (binding.targetId.startsWith('c2c:') || binding.targetId.startsWith('group:')
                ? binding.targetId
                : `c2c:${binding.targetId}`)
            qqIm.bindings.remove(conversationKey, binding.botId)
            qqIm.invalidateBindings()
            const openid = targetIdOf(conversationKey) ?? binding.targetId
            const scope = scopeOf(conversationKey)
            try {
              const fresh = await qqIm.createSessionFor(
                conversationKey,
                {
                  kind: scope === 'group' ? 'group' : 'c2c',
                  senderId: openid,
                  content: '（用户主动开启了一个全新会话）',
                  messageId: `interlude-new-${Date.now()}`,
                },
                binding.botId,
              )
              if (typeof fresh === 'string' && fresh) {
                // 新会话接管该聊天：把绑定指到 fresh（createSessionFor 只建会话，
                // 绑定由这里显式建立——否则下一条 QQ 消息会再自动建一个新会话）。
                qqIm.bindings.set({ conversationKey, sessionId: fresh, botId: binding.botId, name: storyNameFor(binding.botId) })
                qqIm.invalidateBindings()
                // 本会话从此不再接收该聊天的消息；新会话接管。
                state.imBinding = null
                saveState(key, state)
                return { kind: 'success', text: `已为 ${binding.botId} / ${binding.targetId} 开启全新会话 ${fresh.slice(0, 24)}…：之后的 QQ 消息会进到那个新会话。` }
              }
            } catch (error) {
              warn(`/interlude im new 新建会话失败：${error?.message ?? String(error)}`)
            }
            return { kind: 'success', text: `已解除 ${binding.botId} / ${binding.targetId} 的绑定；未能立即新建会话（${qqIm.bindings.get(conversationKey, binding.botId) ? '仍可查' : '已解绑'}）。下一条 QQ 消息会自动创建新会话（需 im.autoCreateSession，默认开）。` }
          }
          if (sub === 'sessions') {
            // 对齐 dsh-im 的 /sessionlist：列出可绑定的会话（序号从 0 开始）。
            const lines = []
            const seen = new Set()
            const bound = qqIm.bindings.list()
            for (const item of bound) {
              if (seen.has(item.sessionId)) continue
              seen.add(item.sessionId)
              lines.push(`  [${lines.length}] ${String(item.sessionId).slice(0, 20)}… → ${item.conversationKey}${item.name ? `（${item.name}）` : ''}`)
            }
            for (const { key: storedKey, state: storedState } of listStoredStates()) {
              if (seen.has(storedKey)) continue
              seen.add(storedKey)
              const title = storedState?.continuity
                || (Array.isArray(storedState?.facts) ? storedState.facts[0]?.content?.slice(0, 20) : '')
                || ''
              lines.push(`  [${lines.length}] ${String(storedKey).slice(0, 20)}…${title ? `（${title}）` : ''}`)
            }
            if (lines.length === 0) lines.push('  （没有可绑定的会话）')
            lines.unshift('可选会话（序号从 0 开始）：')
            lines.push('用 /interlude im session <会话ID|序号> 把当前聊天的 QQ 消息绑到指定会话；/interlude im new 开一个全新会话。')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'session') {
            // 对齐 dsh-im 的 /session：把当前聊天绑到指定会话。
            const want = rest[0]
            if (!want) return { kind: 'error', text: '用法：/interlude im session <会话ID|序号>。先 /interlude im sessions 查看可选项。' }
            const candidates = []
            const seen = new Set()
            for (const item of qqIm.bindings.list()) {
              if (seen.has(item.sessionId)) continue
              seen.add(item.sessionId)
              candidates.push({ sessionId: item.sessionId, title: `→ ${item.conversationKey}` })
            }
            for (const { key: storedKey, state: storedState } of listStoredStates()) {
              if (seen.has(storedKey)) continue
              seen.add(storedKey)
              candidates.push({ sessionId: storedKey, title: storedState?.continuity || '' })
            }
            let target = null
            if (/^\d+$/.test(want)) {
              const index = Number(want)
              target = candidates[index] ?? null
              if (!target) return { kind: 'error', text: `没有序号 ${index} 的会话（可选 0–${candidates.length - 1}）。` }
            } else {
              target = candidates.find(c => c.sessionId === want || c.sessionId.startsWith(want)) ?? null
              if (!target) return { kind: 'error', text: `找不到会话 ${want}。用 /interlude im sessions 查看。` }
            }
            const binding = bindingFor(key, state, cfg)
            const conversationKey = binding?.conversationKey
              ?? (binding?.targetId?.startsWith('c2c:') || binding?.targetId?.startsWith('group:')
                ? binding.targetId
                : binding?.targetId ? `c2c:${binding.targetId}` : undefined)
            if (!conversationKey) {
              return { kind: 'error', text: '本会话没有绑定聊天软件。先让 QQ 消息绑定它，或 /interlude im bind <botId> <targetId>。' }
            }
            qqIm.bindings.set({
              conversationKey,
              sessionId: target.sessionId,
              botId: binding?.botId,
              name: storyNameFor(binding?.botId),
            })
            qqIm.invalidateBindings()
            return { kind: 'success', text: `已把 ${conversationKey} 绑到会话 ${String(target.sessionId).slice(0, 24)}…${target.title ? `（${target.title}）` : ''}。之后的 QQ 消息会进到那个会话。` }
          }
          if (sub === 'discover') {
            // 自建之后「发现」就是查自己的绑定表——不再读 dsh-im 的磁盘文件。
            // 多 Bot：遍历全部 bot，各自列绑定。
            const bots = qqIm.config.bots ?? []
            const all = []
            for (const bot of bots) {
              const rows = await qqIm.service.listTargets(bot.botId)
              all.push({ botId: bot.botId, rows })
            }
            if (all.every(group => group.rows.length === 0)) {
              return { kind: 'success', text: '尚无绑定。在 QQ 里给任意机器人发一条私聊即可自动建立（需 im.autoCreateSession，默认开）。' }
            }
            const lines = ['本通道的绑定关系：']
            for (const { botId, rows } of all) {
              lines.push(`Bot ${botId}（${rows.length} 个目标）`)
              for (const item of rows) {
                lines.push(`  ${item.sessionId === key ? '→ ' : '  '}${item.conversationKey}${item.name ? `（${item.name}）` : ''} → ${String(item.sessionId).slice(0, 20)}…`)
              }
            }
            lines.push('标 → 的就是本会话。')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'reconnect') {
            // 支持 [botId]：只重连指定机器人；无参重连全部。
            const botId = rest[0]
            try {
              if (botId) await qqIm.reconnect(botId)
              else await qqIm.reconnect()
              const st = qqIm.status()
              const perBot = (st.bots ?? []).map(b => `${b.botId}：${b.ready ? '已连接' : (b.started ? '连接中' : '未启动')}`).join('；')
              return { kind: 'success', text: `已重新连接 IM 通道${botId ? `（${botId}）` : ''}。${perBot}` }
            } catch (error) {
              return { kind: 'error', text: `重连失败：${error?.message ?? String(error)}` }
            }
          }
          if (sub === 'rebind') {
            // 把本会话设成「该 QQ 私聊的投递目标」。
            //
            // 为什么需要：自动新建的会话如果建在了别的 workspace、或旧绑定
            // 指向了一个已失效的会话（例如 npx 缓存目录下的老会话），消息就会
            // 一直被投到那个看不见的会话里。用这条命令在**你正打开的这个会话**里
            // 重新绑定，是最直接的修复——不必手删 bindings.json。
            //
            // 目标来源刻意**只认显式参数或本会话的「发现型」绑定**
            // （qqIm.bindingForSession，即 bindings.json 里的那条），
            // 不碰配置型绑定（im.botId / im.targetId 是全局旧设置）——
            // 否则在任意新会话里执行都会悄悄改到那个全局目标上，很意外。
            //
            // botId 不做 `|| config.botId` 兜底（C-1）：多 Bot 下 config.botId
            // 只是「第一个 Bot」，拿它给重绑的目标盖戳会把绑定归错机器人。
            // 归属不确定时如实报错，让用户先建立绑定再重绑。
            const explicit = rest[0]
            const discovered = qqIm.bindingForSession(key)
            const target = explicit || discovered?.targetId
            if (!target) {
              return { kind: 'error', text: '用法：/interlude im rebind <targetId>。当前会话没有已发现的绑定，请先用 /interlude im targets 查目标，或直接带上 targetId。' }
            }
            try {
              const conversationKey = target.startsWith('c2c:') || target.startsWith('group:')
                ? target
                : `c2c:${target}`
              // 归属：优先本会话已发现的绑定；否则查绑定表里这条聊天已归谁（旧绑定）。
              const botId = discovered?.botId
                ?? qqIm.bindings.get(conversationKey)?.botId
                // 单 Bot 配置下归属无歧义：就是那一个 Bot（多 Bot 才拒绝猜测）。
                ?? (qqIm.config.bots.length === 1 ? qqIm.config.bots[0].botId : undefined)
              if (!botId) {
                return { kind: 'error', text: `无法确定 ${conversationKey} 归属的机器人：当前会话没有已发现的绑定，绑定表里也没有它的旧记录（且配置了多个机器人）。先让 QQ 消息绑定它，再重试。` }
              }
              qqIm.bindings.set({ conversationKey, sessionId: key, botId, name: storyNameFor(botId) })
              qqIm.invalidateBindings()
              return { kind: 'success', text: `已把 ${conversationKey}（${botId}）的投递目标改为本会话（${key.slice(0, 24)}…）。之后 QQ 消息会进到这里。` }
            } catch (error) {
              return { kind: 'error', text: `重新绑定失败：${error?.message ?? String(error)}` }
            }
          }
          const binding = bindingFor(key, state, cfg)
          const last = state.lastImDelivery
          const st = qqIm.status()
          const imCfg = cfg.im ?? {}
          const prov = provision.status()
          const botRows = (st.bots ?? []).map(b => `    ${b.botId}${b.alias ? `（${b.alias}）` : ''}：${b.ready ? '已连接' : (b.started ? '连接中' : '未启动')}${b.appId ? `（AppID ${b.appId}）` : '（未配 AppID）'}${b.lastError ? ` —— ${b.lastError}` : ''}`)
          const lines = [
            binding
              ? `IM 绑定：${binding.botId} / ${binding.targetId}（来源：${IM_BINDING_SOURCE[binding.source] ?? binding.source}${binding.channel ? `，渠道 ${binding.channel}` : ''}）`
              : 'IM 绑定：未配置。收到 QQ 私聊会自动绑定；也可用 /interlude im bind <botId> <targetId> 手工指定。',
            `通道：${st.started ? (st.ready ? '已连接' : '连接中') : '未启动'}（${(st.bots ?? []).length} 个机器人，AppID ${imCfg.appId || (Array.isArray(imCfg.bots) ? imCfg.bots[0]?.appId : '') || '未配置'}）`,
            ...botRows,
            // 这一行是本插件最重要的自检输出：模型到底有没有在调发言工具。
            `降级策略：${imCfg.sayFallback ?? 'strict'}${(imCfg.sayFallback ?? 'strict') === 'strict'
              ? '（不调 interlude_say 就什么都不发——思考结构上不可能外泄）'
              : '（过渡期：会从正文提取，实测会复现历史泄漏事故）'}`,
            `本通道累计：收 ${qqIm.stats.inbound} 条 / 发 ${qqIm.stats.outbound} 条`,
            `自动生活推进推送：${cfg.im?.deliverAutoAdvance === false ? '关（仅本地补写）' : '开（有绑定的会话会发到聊天软件）'}`,
            last
              ? `上次投递：${last.ok ? '成功' : '失败'} ${last.sentCount}/${last.total} 条${last.error ? `（${last.error}）` : ''} @ ${last.at}`
              : '上次投递：无',
            ...st.lastError ? [`最近通道错误：${st.lastError}`] : [],
            ...(prov?.phase === 'done' && prov.lastApply)
              ? [`扫码落地：${formatApplyReport(prov.lastApply)}`]
              : [],
          ]
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'purge': {
          // 支持两种形态：
          //   `/interlude purge` —— 全量清除可变字段（历史行为，保留游标与身份标记）；
          //   `/interlude purge <from> <to>` —— 范围软删：把账本里落在时间区间内的
          //     条目软删为墓碑（redacted），并回拨推进游标到区间起点（对齐上游
          //     purgeStoryRange + cursorAt 回拨语义）。facts 中引用被删条目的
          //     一并清除，避免溯源悬空。
          const fromArg = rest[0]
          const toArg = rest[1]
          if (fromArg && toArg) {
            const fromMs = Date.parse(fromArg)
            const toMs = Date.parse(toArg)
            if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
              return { kind: 'error', text: '范围格式：/interlude purge <ISO起始时间> <ISO结束时间>（起始不得晚于结束）。' }
            }
            const tombstoned = redactRange(state.ledger, { from: fromMs, to: toMs })
            // 引用被删条目的长期事实/意图一并清除（与上游 purge 行为一致）。
            const dead = new Set(tombstoned)
            if (dead.size > 0) {
              state.facts = (state.facts ?? []).filter(fact => {
                const sources = Array.isArray(fact.sourceEntryIds) ? fact.sourceEntryIds : []
                return !sources.some(id => dead.has(id))
              })
              state.intents = (state.intents ?? []).filter(intent => !dead.has(intent.entryId))
            }
            // 游标回拨：推进游标回退到区间起点，叙事时钟从 forkPoint 重新推进。
            // 只有回拨点比当前游标更早才生效（回拨只向过去）。
            const current = Number.isFinite(state.lastAutoAdvanceAt) ? state.lastAutoAdvanceAt : Infinity
            if (fromMs < current) {
              state.lastAutoAdvanceAt = fromMs
              state.timelineGuard = createTimelineGuard()
            }
            saveState(key, state)
            return {
              kind: 'success',
              text: `已软删 ${tombstoned.length} 条区间内条目${dead.size ? `，并清除 ${state.facts.length} 条残留事实引用` : ''}；`
                + (fromMs < current ? '推进游标已回拨到区间起点。' : '游标早于区间起点，未回拨。'),
            }
          }
          // 简单重置：把可变字段清空，保留游标与「角色会话」身份标记。
          state.facts = []
          state.overlay = []
          state.intents = []
          state.continuity = ''
          state.continuityUpdatedAt = null
          state.alter = { alterValue: 0, alterWeight: 0, lastTriggerDirection: 0, emotionalOffset: null, history: [], lastUpdatedAt: new Date().toISOString() }
          state.agencyWindow = null
          state.proactiveDrafts = []
          state.proactiveFingerprints = []
          state.commitmentFingerprints = []
          state.preplan = null
          state.reachedOut = 0
          state.reachedOutDay = ''
          state.deliveries = []
          saveState(key, state)
          return { kind: 'success', text: '已清除本会话的幕间数据（事实/意图/演化/日程/气氛/投递账本）。' }
        }
        case 'cursor': {
          // `/interlude cursor <ISO时间>` —— 设置叙事游标（对齐上游 cursor-set）：
          // 分支截断后把推进游标回拨到指定时刻，叙事时钟从该点重新推进。
          const target = rest[0]
          if (!target) {
            const current = Number.isFinite(state.lastAutoAdvanceAt)
              ? formatStoryDisplayTime(new Date(state.lastAutoAdvanceAt), zone)
              : '无'
            return { kind: 'success', text: `当前推进游标：${current}。用法：/interlude cursor <ISO时间> 把游标回拨到指定时刻。` }
          }
          const targetMs = Date.parse(target)
          if (!Number.isFinite(targetMs)) {
            return { kind: 'error', text: `无法解析时间「${target}」；请用 ISO 格式，如 2026-09-20T18:00:00。` }
          }
          state.lastAutoAdvanceAt = targetMs
          state.timelineGuard = createTimelineGuard()
          saveState(key, state)
          return { kind: 'success', text: `已把推进游标设为 ${formatStoryDisplayTime(new Date(targetMs), zone)}；自动推进将从该时刻之后的生活继续。` }
        }
        case 'on':
          state.roleplay = true
          saveState(key, state)
          return { kind: 'success', text: '已把本会话标记为「角色会话」：幕间注入、自动推进与主动联系将对此会话生效。' }
        case 'off':
          state.roleplay = false
          saveState(key, state)
          return { kind: 'success', text: '已取消本会话的「角色会话」标记：幕间注入、自动推进与主动联系将不再作用于本会话（roleplayOnly 开启时）。' }
        default:
          return { kind: 'error', text: `未知子命令 ${verb}；可用：status | context | schedule | memory | overlay | alter | agency | preplan | advance | im | on | off | purge | cursor` }
      }
    },
  })

  /* --------------------------------------------------- 后台：到点唤起 / 自动推进 */

  /**
   * 主动开口的文本捕获（见 lib/capture.js）。
   *
   * 为什么需要：`agent.followup()` 只有唤起、没有回执——它不告诉我们角色写了什么，
   * 而 dsh-im 的会话同步只在「用户在 DSH 里发起的回合」才投递，主动回合的文本
   * 根本不会进 IM（QQ 侧更是缺被动回复的 msg_id，必然失败）。
   * 所以这里在唤起前挂一个捕获器，从 session 事件里取回角色当场写的那段话，再直投。
   */
  const proactiveCapture = installProactiveCapture(ctx, {
    name,
    // 主动回合也要能发表情包：把「表情名」解析成本地路径。
    // 不注入的话，模型只给 name 时图片会被丢弃（而工具已回答"将发送"）。
    resolveSticker: (wanted) => {
      const dir = current().im?.stickerDir || defaultStickerDir()
      return findStickerByName(dir, wanted)?.path
    },
  })

  /**
   * 把「并入本次开口」的其它到期待办一起结掉。
   * 它们在同一次主动联系里被一起说了，不该之后再各触发一次。
   * state 由调用方传入（这个函数在闭包外没有 state 可依）。
   */
  function settleBundled(state, target, now) {
    // 只结掉「归当前叙述负责」的那几类。
    //
    // 为什么不一律结掉：`split-message` / `browser-research` / `proactive-check` /
    // `active-consequence` 各有**自己的执行器**（分条发送、调研、后台扫描、自然过期）。
    // 把它们当成「这次一起说掉了」而结掉，等于让它们**静默消失**——
    // 而且不报错、不留痕。`follow-up-commitment` 同理：它是真实承诺，
    // 只能靠到期投递或显式关闭结清。
    const consumable = new Set(consumedLiveIntentIds(state.intents ?? []))
    for (const item of target.bundled ?? []) {
      if (!consumable.has(item.id)) continue
      const intent = (state.intents ?? []).find(entry => entry.id === item.id)
      if (intent && intent.status === 'pending') {
        intent.status = 'delivered'
        intent.deliveredAt = now
        intent.bundledInto = target.id
      }
    }
  }
  // 卸载时结算掉挂着的捕获窗口，别让等待中的投递拖到超时。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => proactiveCapture.dispose())

  /**
   * 把角色当场写的一段话，按「真人发消息」的方式分条直投到 IM。
   *
   * 记账原则：**全部条目投递成功才返回 ok**。部分成功时会记下已完成条数，
   * 由调用方保留意图而不是标成已处理——宁可不标，也不假装送达。
   */
  /**
   * 把一次投递的分段状态记入投递账本（`state.deliveries`）。
   *
   * 状态判定（与上游 `aggregateDeliveryStatus` 一致）：
   *   - 全部段 delivered → delivered；
   *   - 部分段 delivered → partial；
   *   - 没有段 delivered 且整体失败 → failed。
   * `delivered` 是终态，后续记账错误不得降级（由 delivery-ledger.js 保证）。
   *
   * 同时把**气泡元数据**（`scriptEvent.bubbleIndex/bubbleCount`）写回本批
   * `character-message` 条目——这是 Repetition Guard 的归批依据（上游 rc18
   * 以投递元数据为权威）。没有它，条数检测只能靠"连续 character-message
   * 归一批"的退化路径，遇到穿插条目就会误判。
   */
  function recordDeliveryLedger(state, messages, result, reason) {
    try {
      const segments = segmentsFromMessages(messages)
      if (!segments.length) return
      const sent = Math.max(0, Number(result?.sentCount) || 0)
      const allSent = result?.ok === true && sent >= segments.length
      const someSent = result?.ok === true && sent > 0
      const action = createDeliveryAction({
        id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        reason,
        segments,
      })
      // 段级回写：前 sent 条视为 delivered，其余按整体成败记 failed/pending。
      const nowIso = new Date().toISOString()
      const finalSegments = action.segments.map((segment, index) => {
        if (index < sent) {
          return { ...segment, status: 'delivered', attemptedAt: nowIso, completedAt: nowIso }
        }
        if (!result?.ok) {
          return { ...segment, status: 'failed', attemptedAt: nowIso, completedAt: nowIso, reason: result?.error ?? reason }
        }
        return segment // 还有没确认的段 → 保持 pending（由 aggregate 决定 partial/pending）
      })
      const final = { ...action, segments: finalSegments, status: allSent ? 'delivered' : someSent ? 'partial' : result?.ok ? 'pending' : 'failed' }
      state.deliveries = appendDeliveryAction(state.deliveries, final)
      // 只有**真的送出去**（至少一条）才写气泡元数据：没送达的话她并没有
      // "发成那样"，拿它做条数锚定的证据会让守卫对着没发生的形态报警。
      if (someSent || allSent) {
        stampBubbleMetadata(state, messages.length || segments.length)
      }
    } catch (error) {
      warn(`投递记账失败（不影响投递结果）：${error?.message ?? String(error)}`)
    }
  }

  /**
   * 把 `bubbleIndex/bubbleCount` 盖到本轮最新一批 `character-message` 条目上。
   *
   * DSH 侧的一轮投递 = 上游的「一个已提交剧本行动拆成多个气泡」，所以整批共用
   * 同一个 `bubbleCount`，只有**批次首领**（本批第一条）带 `bubbleIndex: 0`，
   * 这正是 `detectMessageRepetition` 认的形态。
   *
   * 幂等：同一批已经盖过就不重复盖（防止重试投递把一批算成两批）。
   *
   * @param {object} state 会话状态。
   * @param {number} bubbleCount 本批气泡数。
   */
  function stampBubbleMetadata(state, bubbleCount) {
    const total = Math.max(1, Number(bubbleCount) || 1)
    const entries = state.ledger?.entries ?? []
    // 从最新往回找本批的 character-message（遇到别的类型就停——那是上一批）。
    const batch = []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (entry.kind !== 'character-message') break
      // 已经盖过章（首领存在）→ 本批已记，直接返回。
      if (Number.isSafeInteger(entry.metadata?.scriptEvent?.bubbleIndex)) return
      batch.push(entry)
    }
    if (!batch.length) return
    // batch 是倒序的；批次首领 = 最早那条（数组末尾），盖 bubbleIndex: 0。
    batch.forEach((entry, offsetFromNewest) => {
      const index = batch.length - 1 - offsetFromNewest
      entry.metadata = {
        ...(entry.metadata ?? {}),
        scriptEvent: {
          ...(entry.metadata?.scriptEvent ?? {}),
          bubbleIndex: index,
          bubbleCount: total,
        },
      }
    })
  }

  async function deliverToIm({ key, state, cfg, text, items, reason }) {
    const binding = bindingFor(key, state, cfg)
    if (!binding) return { ok: false, error: 'no-binding' }

    // 有序条目优先（文字 + 图片交错）；否则退回纯文本路径。
    //
    // 文本清洗与分条仍走原来的逻辑（mdToPlain → splitImText），但**逐条**做：
    // 图片条目原样保留，文字条目就地清洗分条。这样「图 - 文 - 图」的顺序不变。
    //
    // faceEnabled 时文字走 face 安全的分条：`splitImText` 会把整行只有方括号的
    // 内容当旁白整行删掉，而模型完全可以「只发一个表情」——那一行就是 `[face:14]`，
    // 会被删得干干净净，变成「这一轮什么都没说」。
    //
    // 注意保护必须包在**分条外面**：splitImText 内部自己会再清洗一次，
    // 所以「先 cleanKeepingFaces 再 split」是没用的（第二遍照样吃掉）。
    const faceOn = cfg.im?.faceEnabled !== false
    const chunkingCfg0 = cfg.im?.chunking ?? {}
    const splitText = (raw) => {
      const plain = mdToPlain(raw)
      if (!plain) return []
      if (chunkingCfg0.enabled === false) return [plain]
      const opts = resolveImChunking(chunkingCfg0)
      return faceOn ? splitKeepingFaces(plain, splitImText, opts) : splitImText(plain, opts)
    }
    let messages
    if (Array.isArray(items) && items.length > 0) {
      messages = []
      for (const item of items) {
        if (item && typeof item === 'object' && item.kind === 'image') {
          messages.push(item)
          continue
        }
        const rawText = typeof item === 'string' ? item : String(item?.text ?? '')
        messages.push(...splitText(rawText))
      }
      if (messages.length === 0) return { ok: false, error: 'no-content' }
    } else {
      // 先剥 Markdown，再分条。
      //
      // 顺序不能反：`**加粗**` 里的星号若在这一步之前切条，可能被切到两条里，
      // 单条内的配对规则就匹配不上了（两条各自只剩下孤立的 `**`）。
      //
      // 为什么必须有这一步：模型正文是叙事体（`render.js` 的 storyRules 明确
      // 鼓励它写旁白与环境），Markdown 标记会原样出现在聊天窗口里。
      messages = splitText(text)
      if (messages.length === 0) return { ok: false, error: 'no-content' }
    }

    /**
     * 走通道自己的 `sendToTarget`，**不再**经 `deliverImChunks(service)`。
     *
     * 为什么改：`deliverImChunks` 是当年为了在**别人的服务**（dsh-im）之上做
     * 分条与记账而写的适配层——它只知道 `service.send(botId, targetId, text)`。
     * 通道现在是自建的，自己就有分条、逐条确认、`msgId` 被动回复、
     * 超时与错误分类；再套一层适配只会把能力挡在外面：
     *   - 被动回复（省主动额度）用不上；
     *   - 腾讯 SDK 的错误分类（可重试/凭据问题）被压成一句 delivery-not-confirmed；
     *   - 测试注入的投递出口也只有这条路径能走到。
     *
     * `deliverImChunks` 本身保留（它仍被别的调用点与测试用），只是主动投递
     * 不再绕它走。
     */
    // 群聊适配：scope 显式区分 group/c2c，targetId 剥离前缀后再交给 sendToTarget
    // （避免把 group:xxx 拼成 group:group:xxx）。会话/配置级绑定可能带前缀，统一归一。
    const rawTarget = typeof binding.targetId === 'string' ? binding.targetId : ''
    const scope = binding.scope === 'group' || rawTarget.startsWith('group:') ? 'group' : 'c2c'
    const targetId = rawTarget.startsWith('group:') ? rawTarget.slice('group:'.length)
      : rawTarget.startsWith('c2c:') ? rawTarget.slice('c2c:'.length)
        : rawTarget
    const result = await qqIm.sendToTarget({
      botId: binding.botId,
      targetId,
      scope,
      messages,
      reason,
    })

    state.lastImDelivery = {
      at: new Date().toISOString(),
      reason,
      binding,
      ok: result.ok,
      sentCount: result.sentCount,
      total: messages.length,
      error: result.error ?? null,
    }
    if (result.ok) state.lastAssistantAt = Date.now()

    // 投递账本（delivery ledger）：把本次投递的分段状态记入 state.deliveries。
    // delivered 是终态；部分成功记 partial；失败记 failed（reason 保留）。
    // 与上游 M6.1 一致：只记账，不做第二发送器、不改变投递时机。
    recordDeliveryLedger(state, messages, result, reason)

    saveState(key, state)
    return result
  }
  ctx.on('agent/session-start', ({ agent }) => {
    const key = sessionKeyOf(agent)
    if (key && agent) liveAgents.set(key, agent)
  })

  /* -------------------------------------------- 承诺兜底：说了就必须记下来 */

  /**
   * 每轮的「承诺体检」。
   *
   * 起因（线上实测 session-xxx）：用户说「三分钟后提醒我喝水」，
   * 角色回「行 / 三分钟后喊你」，**但没有调用 interlude_plan** —— 三分钟后自然
   * 什么都没发生。工具确实暴露给了模型（request/header 里 6 个 interlude_* 都在），
   * 规则段也写了「务必调用」，模型仍然漏了。
   *
   * 结论：能不能按时提醒，不能押在「模型每次都记得调工具」上。这里做确定性兜底：
   * 只有在这一轮**真的没有任何 plan 类工具调用**、而回复里又出现了将来的时间承诺时，
   * 才替角色补记一条待办。它兑现的是角色自己说出口的话，不是插件替它编内容。
   *
   * 记完同样挂精确定时器，所以到点唤醒与手工记的待办走完全同一条路。
   */
  const pendingTurns = new Map()

  ctx.on('session/event', (session, event) => {
    const key = sessionIdOf(session)
    if (!key) return
    const type = event?.type

    if (type === 'user/message') {
      // 插件自己的注入不算「用户说话」；跟着它只会把上一轮的承诺又记一遍。
      const source = event?.data?.source
      if (source?.kind === 'plugin') return
      pendingTurns.set(key, { text: '', planned: false, startedAt: Date.now() })
      // Urge 弹性推进：真实入站事件 → 热度桶（只有开启时生效，2 分钟桶天然幂等）。
      try {
        const cfg = current()
        if (cfg.urge?.enabled === true) {
          const state = loadState(key)
          const now = Number.isFinite(Number(event?.time)) ? Number(event.time) : Date.now()
          state.urge = urgeUserEvent(normalizeUrgeState(state.urge, now), now)
          saveState(key, state)
        }
      } catch (error) {
        warn(`Urge 用户事件记账失败（不影响本轮）：${error?.message ?? String(error)}`)
      }
      return
    }

    const turn = pendingTurns.get(key)
    if (!turn) return

    if (type === 'assistant/message') {
      const content = event?.data?.message?.content
      const text = textOfContent(content)
      if (text) turn.text = turn.text ? `${turn.text}\n${text}` : text
      // 模型这一轮只要动过任何记录类工具就不再兜底——它已经记了。
      const blob = JSON.stringify(event?.data?.message ?? {})
      if (/interlude_plan|interlude_remember/.test(blob)) turn.planned = true
      return
    }

    if (type === 'turn/end') {
      // 诊断「写了却没发」：用户消息触发的**聊天回合**里，模型写了正文却没调
      // interlude_say。
      //
      // beta10「消息感知」之后，沉默是**被允许**的——但被允许的沉默是「什么都不写」。
      // 聊天模式明确告诉过模型「只写你会打出来发出去的字，不要写旁白」，
      // 所以它**写了正文却没发**总是值得看一眼的：可能是它把要回的话写成了正文
      // （旧版丢台词 bug 的症状），也可能是它写了一段不该写的内心戏。
      // 纯沉默（正文为空）是正常行为，不在此列，也不刷日志。
      const speech = turnSpeech.get(key)
      const saidSomething = Boolean(speech?.messages?.length || speech?.items?.length)
      if (!saidSomething && turn.text.trim()) {
        // 结构化回复缺失：模型写了正文却没调 interlude_say（可能是已读未回，
        // 也可能是把回复写成了正文）。计进健康面板——这是 rc 阶段最该盯的
        // 抖动之一（上游把「首稿缺失」与「恢复稿挽回」分开计数）。
        health.recordStructureMissing(key)
        info(`交互式回合写了正文但未调 interlude_say（可能已读未回，也可能把回复写成了正文）：`
          + `${key} · ${turn.text.trim().slice(0, 60)}`)
      }
      // 主叙事完成：本回合走完了（回复模式按"有没有真的发出去"归档）。
      health.recordNarrativeComplete(key, Date.now() - (turn.startedAt ?? Date.now()), saidSomething ? 'immediate' : 'none')
      pendingTurns.delete(key)
      if (turn.planned) return
      recordMissedCommitment(key, turn.text)
    }
  }, { global: true })

  /* ------------------------------------------- 交互式回复：interlude_say → QQ */

  /**
   * 交互式回复的投递 —— **自建通道后才做得到的事**。
   *
   * ## 为什么以前做不到
   *
   * 旧架构里交互式回复（用户在 DSH 界面说话、角色回话）的投递权在 dsh-im 手里：
   * 它把 `assistant/message` 的**整段正文**镜像到聊天软件。插件插不进那个通道，
   * 也就无法把「只发 interlude_say 里的内容」这条规则应用上去——
   * 这正是泄漏源 ③，且查证结论是没有出路。
   *
   * 自建之后投递权回到我们手里，这个缺口自然消失：
   * 我们监听 `turn/end`，用 say.js 裁定「这一轮到底说了什么」，
   * 只有工具里的内容会被发出去。**正文一个字都不参与投递。**
   *
   * ## 与主动投递的分工
   *
   * 这条路径走 `im.interactive` 配置，**不占** `proactive.maxPerDay` 名额：
   * 用户先说了话，角色回一句是对话的一部分，不是「主动打扰」。
   * 主动投递（到点提醒/承诺/生活推进）仍走 handleProactive / handleAutoAdvance。
   */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const key = sessionIdOf(session)
    if (!key) return
    void deliverInteractiveSpeech(key).catch((error) => {
      warn(`交互式回复投递失败（${key}）：${error?.message ?? String(error)}`)
    })
  }, { global: true })

  /**
   * 把本轮 `interlude_say` 说的话发回 QQ。
   *
   * 注意几个刻意的取舍：
   *   - **只认工具通道**：`sayFallback` 在这里不参与判定。loose 是给
   *     「主动唤起」路径的过渡补偿，而交互式回复有用户在等着，
   *     模型不调工具就是「这一轮不说」，不该由插件代猜。
   *   - 需要 `interactive.requireInbound`：只有该会话确实从 QQ 说过话才回投，
   *     否则用户在 DSH 界面里的私聊会被莫名其妙发到 QQ。
   */
  async function deliverInteractiveSpeech(key) {
    const cfg = current()
    if (cfg.enabled === false) return
    if (cfg.im?.interactive?.enabled === false) return
    // 「能不能发」以绑定为准，不再额外看 im.enabled——与自动推进 / 到点提醒路径同口径：
    // 通道是否真的启动由 sendToTarget 兜底（未启动时如实报 im-unavailable），而不是在
    // 这里静默跳过（否则交互式回复与自动推进会出现「一个能发、一个不能发」的分裂）。
    const binding = bindingFor(key, undefined, cfg)
    if (!binding) return
    if (cfg.im?.interactive?.requireInbound !== false) {
      const { at } = qqIm.lastInboundOf(key)
      if (!at) return
    }

    const captured = turnSpeech.get(key)
    turnSpeech.delete(key)
    const messages = captured?.messages ?? []
    // 有序条目（文字 + 图片）。老形态（只有 messages）时退化成纯文字表——
    // 保证任何没走新收集路径的调用点行为不变。
    const items = captured?.items?.length ? captured.items : messages
    if (items.length === 0) return
    // 防御性双保险：插件自己唤起的回合（自动推进 / 到点提醒）由主动投递路径负责，
    // 这里不该再发——正常路径已在收集时跳过，但扫描与 turn/end 存在竞态，标记可能
    // 已被清掉，所以这里再判一次。手动推进（/interlude advance）不在此列。
    if (pluginDrivenTurns.has(key)) return
    // 自言自语闸：与主动路径一致。工具通道挡得住「正文泄漏」，但挡不住模型把思考
    // 塞进 interlude_say 参数（say.js 注释里说过「发生过」）——这一关宁可少发也不误发。
    // **只看文字**：图片没有「自言自语」这回事，混进来只会让判据失真。
    if (messages.length > 0 && looksLikeSelfNarration(messages.join('\n')).leak) {
      warn(`交互式回复疑似自言自语，已跳过：${key}`)
      return
    }

    const result = await deliverToIm({ key, state: stateFor(key), cfg, items, reason: 'interactive' })
    if (result.ok) info(`交互式回复已投递 ${result.sentCount} 条 → ${binding.targetId}`)
    else warn(`交互式回复投递失败（${result.error}）：${binding.targetId}`)
  }

  /** 取会话状态（拿不到就现建，别让投递因为状态缺失而中断）。 */
  function stateFor(key) {
    const live = liveAgents.get(key) ?? ctx.agents?.get?.(key)
    const entry = live ? entryFor(live) : undefined
    return entry?.state ?? loadState(key)
  }

  /** 本轮从 interlude_say 收集到的话：sessionId → { messages }。 */
  const turnSpeech = new Map()

  /**
   * 「插件自己唤起的回合」集合。
   *
   * 自动生活推进（`handleAutoAdvance`）与到点提醒（`handleProactive`）会 `agent.followup`
   * 唤起一个回合，并**由它们自己的捕获路径负责投递**（含发消息间隔 / 每日配额门控）。
   * 这些回合里模型调用 `interlude_say` 说出的话，交互式回复路径**不得再投一遍**——
   * 否则同一段话会被投递两次（线上实测：QQ 里每条都出现两遍），而且第二次是
   * `deliverInteractiveSpeech` 发的，**绕过了间隔与配额门控**。
   *
   * 只标记「有自己的投递路径」的插件回合；`/interlude advance`（手动推进）**不标记**，
   * 因为它没有捕获路径，它的 `interlude_say` 正是靠交互式回复送出去的。
   *
   * 生命周期：回合开始前 add；`turn/end` 或下一条用户消息时 delete。
   */
  const pluginDrivenTurns = new Set()
  const markPluginDrivenTurn = (key) => { if (key) pluginDrivenTurns.add(key) }

  ctx.on('session/event', (session, event) => {
    const key = sessionIdOf(session)
    if (!key) return
    if (event?.type === 'user/message') {
      // 新一轮：清掉上一轮的残留，免得把它错当成这一轮说的话。
      turnSpeech.delete(key)
      // **插件自己的注入不算「用户说话」**——它恰恰就是被标记那个回合的开场。
      // 宿主在回合开始时把 followup 的消息以 `user/message` 落进会话（source.kind
      // 为 'plugin'），若不排除它，标记会在 assistant 发言之前就被清掉，
      // 于是同一段 interlude_say 又会被交互式路径收一遍——线上「每条发两遍」原样复现。
      const source = event?.data?.source
      if (source?.kind !== 'plugin') pluginDrivenTurns.delete(key)
      return
    }
    if (event?.type === 'turn/end') {
      // 标记只对一个回合有效。
      pluginDrivenTurns.delete(key)
      return
    }
    if (event?.type === 'tool/call') {
      // 插件自己唤起的回合：交给主动投递路径（它带间隔/配额门控），
      // 交互式回复不重复收集——否则同一段话会被投两次。
      if (pluginDrivenTurns.has(key)) return
      const entry = turnSpeech.get(key) ?? { messages: [], items: [] }
      const toolName = event?.data?.name
      if (toolName === (current().im?.sayTool ?? 'interlude_say')) {
        const raw = event.data?.arguments
        try {
          const parsed = JSON.parse(raw)
          const text = typeof parsed?.text === 'string' ? parsed.text : ''
          for (const line of text.split('\n')) {
            const item = line.trim()
            // QQ 原生 face：模型写 `[微笑]`，QQ 只认 `[face:0]`。
            // 在**收集时**就翻好（而不是投递时），因为自言自语闸、去重等
            // 下游判据看到的应当是最终要发出去的形态。
            const finalText = current().im?.faceEnabled === false ? item : materializeFaces(item)
            // items 是**有序**条目表（文字与图片按调用顺序交错），messages 只收文字。
            if (finalText) { entry.messages.push(finalText); entry.items.push(finalText) }
          }
        } catch (e) { ctx.logger?.debug?.('operation failed:', e.message); /* 参数不是合法 JSON：不猜，跳过 */ }
      } else if (toolName === (current().im?.imageTool ?? 'interlude_send_image')) {
        // 图片不参与自言自语闸（那是给文字用的），所以不 push 进 messages——
        // 只进 items。否则图片对象会被拿去 join('\n') 而变成 "[object Object]"。
        // imagesEnabled=false 时整个忽略：模型即使调了工具也发不出去（配置即开关）。
        //
        // 注入 resolveSticker：工具文档推荐模型「只给 name」，所以这里必须能把
        // 表情名翻成路径，否则按推荐用法调用时图片会被静默丢弃。
        const imageCfg = current()
        const image = imageCfg.im?.imagesEnabled === false
          ? null
          : imageOfToolCall(event, toolName, {
            resolveSticker: (wanted) => {
              const dir = imageCfg.im?.stickerDir || defaultStickerDir()
              const hit = findStickerByName(dir, wanted)
              return hit?.path
            },
          })
        if (image) entry.items.push(image)
      }
      turnSpeech.set(key, entry)
    }
  }, { global: true })

  /**
   * 把角色漏记的承诺补进待办。
   *
   * 静默原则：这里**不**注入任何提示、不改写角色的下一句话——角色不需要知道
   * 插件替它补了记录，用户那边更不该看到系统痕迹。补记只影响「到点会不会被唤起」。
   */
  function recordMissedCommitment(key, text) {
    const cfg = current()
    if (cfg.enabled === false) return
    if (cfg.proactive?.enabled === false) return
    if (cfg.proactive?.commitmentBackstop === false) return
    if (!text) return

    const found = detectCommitment(text, {
      vagueMinutes: cfg.proactive?.vagueCommitmentMinutes,
      tomorrowMinutes: cfg.proactive?.tomorrowCommitmentMinutes,
    })
    if (!found) return

    // 只对角色会话兜底：普通会话里「等会儿」是工作用语，不该被记成承诺。
    const live = liveAgents.get(key) ?? ctx.agents?.get?.(key)
    const state = live ? entryFor(live)?.state : loadState(key)
    if (!state) return
    if (live) { if (!isRoleplaySession(live, state)) return } else if (!isRoleplayState(state)) return

    const now = Date.now()
    // 同一件事只兜底一次。判定看两样：
    //   ① 逐字指纹（同一句话被重新提交）；
    //   ② 「同类承诺 + 到点时间接近」——角色常把同一件事说两遍
    //      （「三分钟后喊你」→「行吧，三分钟后见」），措辞不同但就是一件事。
    //      同 kind 且在 2 分钟内到点的已有待办，视为同一件。
    const duplicateWindow = 2 * MINUTE
    const dueAt = now + found.minutes * MINUTE
    const existing = (state.intents ?? []).filter(item =>
      item.status === 'pending' || item.status === 'delivering')
    const samePromise = existing.find(item =>
      item.kind === found.kind &&
      Number.isFinite(item.dueAt) &&
      Math.abs(item.dueAt - dueAt) <= duplicateWindow)
    if (samePromise) return
    // 模型可能换个说法已经记过了：摘要相同也算重复。
    if (existing.some(item => item.summary === found.summary)) return

    const fingerprint = `${found.kind}:${found.minutes}:${found.summary}`
    state.commitmentFingerprints = state.commitmentFingerprints ?? []
    const seen = state.commitmentFingerprints.find(item => item.fingerprint === fingerprint)
    if (seen && now - seen.at < 30 * MINUTE) return

    const intent = addIntent(state, { kind: found.kind, summary: found.summary, dueAt }, now)
    intent.auto = 'commitment-backstop'
    intent.sourcePhrase = found.phrase
    state.commitmentFingerprints = [...state.commitmentFingerprints.slice(-19), { fingerprint, at: now }]
    saveState(key, state)
    scheduleIntentWake(key, dueAt)
    info(`角色漏记了承诺（「${found.phrase}」），已补记为待办 ${intent.id}：${found.summary}`)
  }

  /* ---------------------------------------------------- 承诺型待办的即时唤醒 */

  /**
   * 每个会话一个「最近到点时刻」的一次性定时器。
   *
   * 为什么需要：周期扫描默认 5 分钟一次，而「一分钟后提醒我喝水」这种待办的
   * 语义就是「一分钟后」。只靠周期扫描，最短也要等到下一个扫描点，用户看到的
   * 是「你答应一分钟，结果六分钟后才说话」。这里按精确到点时间补一个定时器，
   * 周期扫描仍然保留作为兜底（进程重启、定时器丢失、当时容量不满足等）。
   *
   * 到点后不另开捷径：统一再走一次扫描，判定逻辑与周期扫描完全一致。
   */
  const intentTimers = new Map()
  /** setTimeout 的延时上限是 2^31-1 毫秒（约 24.8 天），更远的到点时间分段等待。 */
  const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

  /**
   * 实际该被唤起的时刻 = 到点时间 + 宽限。
   *
   * 必须带上宽限：判定里要求 `now - dueAt >= graceMinutes`，如果定时器卡在
   * dueAt 准点触发，那一刻宽限还没走完，这次唤醒会空转，然后再等一整个扫描
   * 周期——「一分钟提醒」又变回六分钟。
   */
  function wakeAtFor(dueAt) {
    const grace = Math.max(0, current().proactive?.graceMinutes ?? 1) * MINUTE
    return dueAt + grace
  }

  function scheduleIntentWake(key, dueAt) {
    if (!key || !Number.isFinite(dueAt)) return
    const wakeAt = wakeAtFor(dueAt)
    const existing = intentTimers.get(key)
    // 已经有更早（或同样早）的唤醒就不动它：早的那次会把所有到期待办一起处理。
    if (existing && existing.dueAt <= wakeAt) return
    if (existing) clearTimeout(existing.timer)

    const wait = Math.max(0, wakeAt - Date.now())
    const chunk = Math.min(wait, MAX_TIMER_DELAY_MS)
    const timer = setTimeout(() => {
      // 还没走到真正的唤起时刻（被上限切过一段），继续等剩下的部分。
      if (Date.now() < wakeAt) { scheduleIntentWake(key, dueAt); return }
      intentTimers.delete(key)
      void runSweep({ only: key })
    }, chunk)
    if (timer && typeof timer.unref === 'function') timer.unref()
    intentTimers.set(key, { dueAt: wakeAt, timer })
  }

  /** 启动时把所有未来的到点时间都挂上定时器；周期扫描仍负责漏网的。 */
  function armIntentTimers() {
    for (const { key, state } of listStoredStates()) rearmFromState(key, state)
  }

  /**
   * 兜底自愈：把这一轮里看见的「还要等的 pending 待办」挂上定时器。
   *
   * 为什么需要：定时器只活在内存里。任何绕过 `interlude_plan` 写盘的路径
   * （别的进程写的、插件热重载、文件被手工改过）都不会有待定时器，只剩周期
   * 扫描兜底——那意味着最长要等一整个扫描周期。见过就顺手补上，系统自己收敛。
   *
   * 已经到点但还在宽限期内的也要挂：它的唤起时刻（到点 + 宽限）仍在未来。
   */
  function rearmFromState(key, state) {
    const now = Date.now()
    for (const intent of (state.intents ?? [])) {
      if (intent.status !== 'pending' || !Number.isFinite(intent.dueAt)) continue
      if (wakeAtFor(intent.dueAt) <= now) continue
      scheduleIntentWake(key, intent.dueAt)
    }
  }

  const sweepInterval = Math.max(1, config.proactive?.checkIntervalMinutes ?? 5) * MINUTE
  every(ctx, sweepInterval, () => { void runSweep() })

  /**
   * 让一个会话的 agent 立刻可用。
   *
   * 会话在没人说话时是「冷的」：没有实时 agent，`agents.get()` 拿不到东西。
   * 但 dsh-im 的「会话双向同步」随时可以把一段话投回聊天窗口——只要会话被唤醒。
   * `ctx.sessionController.resolveAgent()` 正是宿主自己的「找到或恢复这个会话」入口
   * （客户端打开历史会话走的也是它），所以这里复用它，而不是自己拼 resume 参数。
   *
   * 拿不到就不勉强：返回 undefined，本轮放弃，等下次扫描再试。
   */
  async function wakeAgent(key) {
    const live = liveAgents.get(key) ?? ctx.agents?.get?.(key)
    if (live) return live
    // 注意：`ctx.sessionController` 在服务未注册时**会抛错**（Cordis 对未声明服务
    // 的访问是抛错而不是返回 undefined），所以可选链 `?.` 挡不住——必须在取值本身
    // 外面套 try/catch。踩过一次：headless profile 里每次扫描都会崩在扫描的
    // catch 里，冷会话永远醒不过来，日志还刷屏。
    let controller
    try {
      controller = ctx.sessionController
    } catch {
      return undefined
    }
    if (typeof controller?.resolveAgent !== 'function') return undefined
    try {
      const resolved = await controller.resolveAgent(key)
      // 宿主约定：拿不到时返回 `{ error }` 而不是抛错。
      if (!resolved || resolved.error) return undefined
      return resolved
    } catch (error) {
      warn(`恢复会话 ${key} 失败，跳过本次主动开口：${error?.message ?? String(error)}`)
      return undefined
    }
  }

  /**
   * 处理一个会话：到期待办 → 主动开口；随后（仅活跃会话）自动生活推进。
   *
   * @param {string} key 会话 id。
   * @param {object|undefined} live 该会话当前的实时 agent（无则为冷会话）。
   * @param {object} cfg 生效配置。
   * @param {number} now 当前时刻。
   */
  async function handleSession(key, live, cfg, now) {
    // 实时会话走 entryFor（会顺手折叠会话日志、登记 agent）。
    let state = live ? entryFor(live)?.state : undefined
    if (live && !state) return
    if (!state) state = loadState(key)
    // 角色会话判定分两条路：
    //   实时会话用权威的 SessionHeader（新会话还没留下任何状态痕迹，只有它能判断）；
    //   冷会话读不到 header，退化成看状态里的痕迹。
    if (live) {
      if (!isRoleplaySession(live, state)) return
    } else if (!isRoleplayState(state)) return

    const entry = { key, state, agent: live }

    // 顺手把还没到点的待办补上定时器（内存里的定时器不跨进程/不跨重载）。
    rearmFromState(key, state)

    const agencyCfg = resolveAgencyConfig(cfg.agency ?? {})

    // 主动联系配额按角色本地日期重置。
    const today = calendarDayKey(new Date(now), zone)
    if (state.reachedOutDay !== today) {
      state.reachedOutDay = today
      state.reachedOut = 0
      saveState(key, state)
    }

    if (await handleProactive(entry, cfg, now, agencyCfg)) return
    if (live) await handleAutoAdvance(entry, cfg, now)
  }

  /**
   * 到期待办 → 唤起角色 → 取回它当场写的话 → 直投 IM。
   * @returns {boolean} 本次是否已经用掉了这一轮（调用方据此跳过自动推进）。
   */
  async function handleProactive(entry, cfg, now, agencyCfg) {
    const { key, state } = entry
    if (cfg.proactive?.enabled === false) return false

    // 崩溃/重启恢复：投递中途断电会把待办永远卡在 delivering（dueIntents 只看 pending）。
    // 超过一次投递窗口还没落地，就当作没送到，放回 pending 重试。
    const stuckAfter = (cfg.im?.waitForTurnMs ?? 90_000) + MINUTE
    for (const intent of (state.intents ?? [])) {
      if (intent.status !== 'delivering') continue
      if (now - (intent.deliveringAt ?? 0) < stuckAfter) continue
      intent.status = 'pending'
      intent.recoveredAt = now
      warn(`待办 ${intent.id} 卡在投递中超过 ${Math.round(stuckAfter / MINUTE)} 分钟，放回待重试`)
    }

    // 长时间停机（DSH 没在跑）后，到期待办会一起涌出来。逐条补发等于一次消息风暴，
    // 而且内容多半已经过时。超过 STALE_INTENT_MS 的一律不投递、只标过期；
    // 剩余的多条合并成一次开口，由角色自己把几件事一起说掉。
    const staleBefore = now - STALE_INTENT_MS
    const waiting = dueIntents(state, now)
      .filter(intent => now - intent.dueAt >= (cfg.proactive?.graceMinutes ?? 1) * MINUTE)
    const stale = waiting.filter(intent => intent.dueAt < staleBefore)
    for (const intent of stale) {
      intent.status = 'expired'
      intent.settledAt = now
      intent.expiredReason = '到点太久没送达（DSH 未运行），不再补发'
    }
    if (stale.length) {
      info(`跳过 ${stale.length} 项已过时机待办（超过 ${Math.round(STALE_INTENT_MS / HOUR)} 小时未送达）`)
      saveState(key, state)
    }

    const batch = waiting.filter(intent => intent.status === 'pending')
    const target = batch[0]
    if (batch.length > 1) {
      // 把其余待办并入本次开口的动机里，避免连发多条。
      target.bundled = batch.slice(1).map(intent => ({ id: intent.id, summary: intent.summary, kind: intent.kind }))
    }
    if (!target) return false

    // 「承诺型」到期待办（提醒/回访/主动问候/延迟回复）是角色自己答应过的事。
    // 先算出这个类别，再判配额——配额的本意是「别没事找事」，不是「让角色赖掉
    // 答应过的事」。自动生活推进现在也会占名额，若两者共用一道闸，一次忙碌的生活
    // 推进就可能把当天到点的提醒挤掉（`handleSession` 里 proactive 先跑、推进后跑，
    // 所以排在后面的推进总能把额度吃光）。承诺永远优先。
    const promised = target.kind === 'promise' || target.kind === 'reminder'
      || target.kind === 'contact' || target.kind === 'reply'
    // 配额只拦「随性起意的联系」，不拦角色答应过的事：`promised` 必须参与判定。
    // 少了 `!promised` 的话，名额一满连到点的提醒都会被打回 ——
    // 上面那段注释描述的行为与实际代码不符（这正是「配额用光后提醒仍该发」那条用例在抓的）。
    if (!promised && (state.reachedOut ?? 0) >= (cfg.proactive?.maxPerDay ?? 6)) return false

    // 休息时段：随性起意的联系该让路，但角色当场答应的事不该被「你该睡了」吞掉——
    // 用户还醒着、还在等，承诺就得兑现。
    const resting = inRestWindow(now, zone, cfg.runtime?.restWindows ?? [])
    const sleepAllowed = !resting
      || cfg.proactive?.duringSleep === true
      || (promised && cfg.proactive?.duringSleepPromises !== false)
    if (!sleepAllowed) return false

    const nowDate = new Date(now)
    // 主体行动窗口缺失/过期时按「空闲/私密/可用」放行，避免因模型没报过 agency 而永远无法主动联系。
    const agencyWindow = (state.agencyWindow && new Date(state.agencyWindow.validUntil) > nowDate)
      ? state.agencyWindow
      : { activityLoad: 'free', privacy: 'private', deviceAccess: 'available', validUntil: new Date(now + 24 * 3600_000).toISOString() }
    const capacity = evaluateAgencyCapacity(agencyWindow, {
      participantId: key,
      // 承诺型不受「日程占用」的普通闲聊约束，只受设备与隐私约束。
      origin: promised ? 'promise' : 'life-event',
      disclosure: 'ordinary', motive: target.summary, sourceEntryIds: [], outcome: 'send-now', expiresAt: new Date(now + 24 * 3600_000).toISOString(),
    }, nowDate, agencyCfg, Number.isFinite(state.lastAssistantAt) ? new Date(state.lastAssistantAt).toISOString() : undefined)
    if (!capacity.allowed) {
      info(`会话 ${key} 的到期待办暂缓（${capacity.reason}）：${target.summary}`)
      return false
    }

    const binding = bindingFor(key, state, cfg)
    // 通道是本插件自己装的，装好即在——不需要再等 dsh-im 那个 8MB 大包注册服务。
    // （原先这里有一段 500/1500/3000ms 的等待循环，专为「说好三分钟、八分钟后才有动静」
    //  那个线上问题而加；自建之后这个竞态从根上消失了。）
    const service = binding ? qqIm.service : undefined

    // 需要投递（或需要在聊天软件里说话）时才唤醒冷会话；纯 Web 会话没有实时 agent
    // 也没关系——它下次被打开时会看到幕间块里的到期待办。
    const needsAgent = Boolean(binding && service) || Boolean(entry.agent)
    if (!needsAgent) return false
    const agent = entry.agent ?? (cfg.proactive?.wakeIdleSessions === false ? undefined : await wakeAgent(key))
    if (!agent) return false
    entry.agent = agent

    if (binding && service) {
      // **先看有没有上一轮没送出去的草稿**：有就直接重发它，不再唤起模型。
      // 理由见下面失败分支的注释——重试不该重新生成内容。
      if (typeof target.pendingText === 'string' && target.pendingText.trim()) {
        const resumeText = Array.isArray(target.pendingRemaining) && target.pendingRemaining.length
          ? target.pendingRemaining.join('\n')
          : target.pendingText
        target.status = 'delivering'
        target.attempts = (target.attempts ?? 0) + 1
        target.deliveringAt = Date.now()
        saveState(key, state)
        const retried = await deliverToIm({ key, state, cfg, text: resumeText, reason: target.summary })
        if (retried.ok) {
          target.status = 'delivered'
          target.deliveredAt = Date.now()
          delete target.pendingText
          delete target.pendingRemaining
          state.reachedOut = (state.reachedOut ?? 0) + 1
          health.recordProactive(key, true)
          settleBundled(state, target, now)
          info(`到期待办 ${target.id} 的草稿已重发成功（未重新生成）：${key}`)
        } else if (target.attempts >= 3) {
          target.status = 'failed'
          target.failedAt = Date.now()
          target.failure = retried.error ?? 'unknown'
          warn(`主动投递连续失败，已放弃意图 ${target.id}：${target.failure}`)
        } else {
          if (Array.isArray(retried.remaining) && retried.remaining.length) target.pendingRemaining = retried.remaining
          target.status = 'pending'
        }
        saveState(key, state)
        return true
      }

      // IM 直投：唤起角色 → 取回它当场写的话 → 分条直投。
      // 投递失败不标 delivered，留待下轮退避重试。
      const capture = proactiveCapture.begin(key, cfg.im?.waitForTurnMs ?? 90_000)
      target.status = 'delivering'
      target.attempts = (target.attempts ?? 0) + 1
      target.deliveringAt = Date.now()
      saveState(key, state)
      markPluginDrivenTurn(key)
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: renderProactiveText(target, now, zone, state) }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: `幕间到点：${target.summary}` },
        }))
      } catch (error) {
        // 唤起失败：放弃这次捕获窗口，把待办放回 pending 等下一轮。
        capture.cancel?.()
        target.status = 'pending'
        saveState(key, state)
        warn(`唤起会话 ${key} 失败，到期待办保留待重试：${error?.message ?? String(error)}`)
        return true
      }
      const captured = await capture; 
      const written = captured.text
      // 优先用显式发言（interlude_say）：那是模型**明确**要发出去的话，
      // 与旁白/思考在通道上就分开了，不需要再猜文本形态。
      const explicit = captured.speech ?? []
      // 有序投递条目（文字 + 图片按调用顺序）。带图时用它，纯文字时退回 text——
      // 图片**不参与**自言自语闸（那是给文字用的判据），所以闸只看 explicit。
      const capturedItems = Array.isArray(captured.items) ? captured.items : []
      const hasImage = capturedItems.some(item => item && typeof item === 'object' && item.kind === 'image')
      if (explicit.length || hasImage) {
        // 自言自语闸：模型可能在工具参数里也把思考写进去（少见，但发生过）。
        // 与自动推进路径（decideAdvanceDelivery 对 explicitSpeech 过同一道闸）保持一致。
        if (explicit.length && looksLikeSelfNarration(explicit.join('\n')).leak) {
          target.status = 'delivered'
          target.deliveredAt = Date.now()
          target.skippedReason = 'self-narration-explicit'
          settleBundled(state, target, now)
          warn(`到期待办 ${target.id} 的显式发言疑似自言自语（已跳过）：${key}`)
          saveState(key, state)
          return true
        }
        const delivered = await deliverToIm({
          key, state, cfg,
          // 有图就走 items（保序）；纯文字走 text（与既有路径逐字节一致）。
          ...(hasImage || capturedItems.length
            ? { items: capturedItems }
            : { text: explicit.join('\n') }),
          reason: target.summary,
        })
        if (delivered.ok) {
          target.status = 'delivered'
          target.deliveredAt = Date.now()
          delete target.pendingText
          delete target.pendingRemaining
          state.reachedOut = (state.reachedOut ?? 0) + 1
          health.recordProactive(key, true)
          settleBundled(state, target, now)
          saveState(key, state)
          return true
        }
        // 显式发言投递失败：保留原文，下一轮重发同一段（不重新生成）。
        target.pendingText = explicit.join('\n')
        target.status = target.attempts >= 3 ? 'failed' : 'pending'
        if (target.status === 'failed') {
          target.failedAt = Date.now()
          target.failure = delivered.error ?? 'unknown'
          warn(`主动投递连续失败，已放弃意图 ${target.id}：${target.failure}`)
        }
        saveState(key, state)
        return true
      }
      const verdict = written ? looksLikeSelfNarration(written) : { leak: false }
      if (verdict.leak) {
        // 模型把思考过程写成了正文：**不发**，但这件事仍然要结算掉。
        // 不结算的话它下次扫描还会到点、还会再唤起一次，用户会被反复打扰——
        // 而模型每次都只是又自言自语一遍。这类唤起对用户毫无价值，直接算作已处理。
        target.status = 'delivered'
        target.deliveredAt = Date.now()
        target.skippedReason = verdict.reason
        settleBundled(state, target, now)
        warn(`到期待办 ${target.id} 的正文像是在自言自语（${verdict.reason}），已静默跳过，不打扰用户：${key}`)
        saveState(key, state)
        return true
      }
      const delivered = written
        ? await deliverToIm({ key, state, cfg, text: written, reason: target.summary })
        : { ok: false, sentCount: 0, error: 'no-writeback' }
      if (delivered.ok) {
        target.status = 'delivered'
        target.deliveredAt = Date.now()
        // 送完了就把草稿清掉，别让它留在状态里
        delete target.pendingText
        delete target.pendingRemaining
        state.reachedOut = (state.reachedOut ?? 0) + 1
        health.recordProactive(key, true)
        settleBundled(state, target, now)
      } else if (target.attempts >= 3) {
        target.status = 'failed'
        target.failedAt = Date.now()
        target.failure = delivered.error ?? 'unknown'
        warn(`主动投递连续失败，已放弃意图 ${target.id}：${target.failure}`)
      } else {
        // **重试不重新生成内容。**
        //
        // 这是从参考项目学来的关键一条（service.ts:2525-2531）：它把已决定的每条
        // 消息**先落库成 intent 行**，投递失败时 +30 秒重发**同一段文字**。
        //
        // 我们原先的做法是把待办放回 pending —— 下一轮扫描会重新唤起模型，
        // 于是：① 又花一次全量上下文（这个会话每轮 1.5 万 token）；
        // ② 模型会写出一句**不一样**的话；③ 若上一轮已经送出一部分，
        // 用户就会看到「前半句是旧版本、后半句是新版本」的错位。
        //
        // 现在把写好的文字存进待办，下一轮直接重发它，模型不再参与。
        if (written) {
          target.pendingText = written
          target.pendingRemaining = Array.isArray(delivered.remaining) ? delivered.remaining : null
        }
        target.status = 'pending'
      }
      // 兜底：IM 没送到时，至少在本地会话里留下一次唤起，别把这件事彻底吞掉。
      // 默认关，因为 Web 侧会重复看到同一件事。
      if (!delivered.ok && cfg.im?.keepPassive === true) {
        markPluginDrivenTurn(key)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: renderProactiveText(target, now, zone, state) }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: `幕间到点（IM 投递失败）：${target.summary}` },
        }))
      }
      saveState(key, state)
      return true
    }

    // 无 IM 绑定：仍然唤起角色，让它自己把这件到点的事接上（话留在本地会话里）。
    // 唤起成功才结算——followup 抛错时待办要留着下轮重试，别白吞一次配额。
    markPluginDrivenTurn(key)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderProactiveText(target, now, zone, state) }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: `幕间到点：${target.summary}` },
      }))
    } catch (error) {
      warn(`唤起会话 ${key} 失败，到期待办保留待重试：${error?.message ?? String(error)}`)
      return true
    }
    target.status = 'delivered'
    target.deliveredAt = now
    target.attempts = (target.attempts ?? 0) + 1
    state.reachedOut = (state.reachedOut ?? 0) + 1
    health.recordProactive(key, true)
    settleBundled(state, target, now)
    saveState(key, state)
    return true
  }

  /**
   * 自动生活推进 = **续写故事**；要不要顺手发条消息，是另一件事。
   *
   * 结构（对齐 hds-interlude 的原意：「聊天在幕前发生，生活在幕间继续」）：
   *   1. 按「写故事间隔」唤起角色续写一段生活 —— 这段文字留在 DSH 会话里，是叙事；
   *   2. 从这段续写里剥出角色**整句引号写的台词**（story.js，确定性判定）；
   *   3. 只有台词非空、且有聊天软件绑定、且过了「发消息间隔」与每日配额，才投递出去。
   *
   * 第 3 步是关键：改版之前这里是无条件投递，于是每 40 分钟聊天窗口里就多一条
   * 没头没尾的消息。现在「不想被打扰」由 messageIntervalMinutes 承担，而**不是**
   * 关掉投递——关掉投递并不能让那条消息消失，只会让角色把话说给空气听
   * （session-xxx 第 7 轮就是这么坏的）。
   */
  /**
   * 从本轮正文里解析模型返回的 Urge 调度交接并采纳（引用必须逐字命中正文）。
   *
   * 计划（planUrge）在推进前已算过；这里采纳的是**这一轮**的交接，
   * 供下一轮 planUrge 使用（慢速/建议延迟/爆发武装都从这里来）。
   * 未开启 / 无交接 / 引用对不上 → 无副作用。
   */
  function adoptUrgeHandoff(state, key, cfg, written, now) {
    const urgeOn = cfg.urge?.enabled === true
    if (!urgeOn || !written) return
    const handoff = parseUrgeHandoff(written)
    if (!handoff) return
    // 校验用**剥离 urge 行后**的正文：JSON 里写着的 basisQuote 不能自证（自引用漏洞）。
    const storyBody = stripUrgeHandoff(written)
    const scriptEntries = (state.ledger?.entries ?? [])
      .filter(entry => entry.kind === 'script')
      .sort((left, right) => right.id - left.id)
    const entryId = scriptEntries[0]?.id
    const target = bindingFor(key, state, cfg) ? key : undefined
    state.urge = commitUrge(
      normalizeUrgeState(state.urge, now), handoff, storyBody,
      entryId ?? 0, target, now, resolveUrgeConfig(cfg.urge),
    )
    if (state.urge.armed) {
      info(`Urge：模型意愿 ${state.urge.value} 已武装一次主动联系意图（${key}）`)
    }
  }

  /**
   * 连发同条数守卫：本回合该不该注入守卫段。
   *
   * 判据（与上游 rc18 一致）：
   *   1. 只在**私聊对话回合**——本轮 `payload.messages` 里有真实用户消息，
   *      且不是插件唤起（`state.advanceMode` 存在即为推进回合）；
   *   2. 从条目账本倒序归批，尾部连续 ≥2 批同为 x 条（x≥2）才算锚定。
   *
   * @param {object} state 会话状态。
   * @param {object} payload pre-step 的 payload。
   * @param {object} cfg 生效配置。
   * @returns {string} 注入段；不该注入时为空串。
   */
  function repetitionGuardFor(state, payload, cfg) {
    if (cfg.runtime?.repetitionGuard === false) return ''
    // 推进/主动唤起的回合不带守卫：`advanceMode` 由唤起方写入。
    if (state.advanceMode) return ''
    // 本轮有没有真实用户消息（插件注入不算）。
    const incoming = Array.isArray(payload?.messages) ? payload.messages : []
    const hasUserMessage = incoming.some((message) => {
      const source = message?.data?.source ?? message?.source
      if (source?.kind === 'plugin') return false
      return message?.type === 'user/message' || message?.role === 'user'
    })
    if (!hasUserMessage) return ''
    // 群聊回合不注入：群聊与私聊共用同一条投递路径，靠绑定 scope 区分。
    // key 优先取 payload 里的 agent（pre-step 时 `state.sessionId` 可能还没盖章）。
    const key = sessionKeyOf(payload?.agent) || entryKeyOf(state)
    const binding = bindingFor(key, state, cfg)
    const isGroup = binding?.scope === 'group' || String(binding?.targetId ?? '').startsWith('group:')
    if (!shouldCheckRepetition({ phase: 'user-message', isGroup })) return ''
    const repetition = detectMessageRepetition(state.ledger?.entries ?? [])
    return repetitionGuardInstruction(repetition)
  }

  /** 从状态里反查会话 key（状态落盘时会盖 `sessionId` 章）。 */
  function entryKeyOf(state) {
    return typeof state?.sessionId === 'string' && state.sessionId ? state.sessionId : ''
  }

  async function handleAutoAdvance(entry, cfg, now) {
    const { key, state, agent } = entry
    if (cfg.runtime?.autoAdvanceEnabled === false) return
    const interval = Math.max(5, cfg.runtime?.autoAdvanceIntervalMinutes ?? 40) * MINUTE
    const jitter = Math.max(0, cfg.runtime?.autoAdvanceJitterMinutes ?? 5) * MINUTE
    // 抖动取**对称**（±jitter/2），不是只加不减。
    //
    // 原先写的是 interval + random()*jitter：只可能变长，平均多等 jitter/2。
    // 默认 5 分钟抖动 → 每一轮都白白晚 2.5 分钟，长期下来是系统性偏慢。
    // 参考项目用的是 randomInteger(min, max)（service.ts:6761），本来就是对称的。
    const lastAssistant = Number.isFinite(state.lastAssistantAt) ? state.lastAssistantAt : 0
    const lastAdvance = Number.isFinite(state.lastAutoAdvanceAt) ? state.lastAutoAdvanceAt : 0
    const restWindows = cfg.runtime?.restWindows ?? []
    // 休息时段：**拉长间隔，而不是整段停掉**。
    //
    // 参考项目的做法是「窗口内改用 120–240 分钟的低频节奏」（service.ts:6760），
    // 我们原先是直接 return —— 于是 23:00–07:00 这 8 小时里角色完全静止，
    // 第二天早上要么什么都不记得，要么一次性补写一大段「昨天夜里……」。
    // 低频而不是静止，更接近「她睡了，但生活还在走」。
    const resting = inRestWindow(now, zone, restWindows)

    // Urge 弹性推进：开启后推进间隔由热度密度/模型交接决定，而非固定间隔。
    // 休息时段仍走休息窗口的低频节奏（urge 的 slow 档与它同向，不必叠加）。
    const urgeOn = cfg.urge?.enabled === true && !resting
    let effectiveInterval = interval
    let urgeReason = null
    if (urgeOn) {
      const urgeCfg = resolveUrgeConfig(cfg.urge)
      const planned = planUrge(
        normalizeUrgeState(state.urge, now), now, urgeCfg, 0, !bindingFor(key, state, cfg), Math.random,
      )
      state.urge = planned.state
      effectiveInterval = Math.max(5 * MINUTE, planned.minutes * MINUTE)
      urgeReason = planned.reason
    } else if (resting) {
      effectiveInterval = restIntervalFor(restWindows, interval)
    }
    const threshold = urgeOn ? effectiveInterval : interval + (jitter ? (Math.random() - 0.5) * jitter : 0)
    if (now - lastAssistant < threshold && !resting) return
    if (now - lastAdvance < effectiveInterval) return

    // 熔断/退避检查：连续失败过多次就**暂时不再唤起**。
    //
    // 为什么必须有：写回超时后 `lastAutoAdvanceAt` 不推进（那是刻意的，不占间隔），
    // 于是每一轮后台扫描都会重来一次、每次都等到超时——一个持续卡住的会话会
    // 无限烧 token，而且**不会自愈**（失败原因通常是会话本身的问题）。
    const guardCheck = timelineDirectorAllowed(state.timelineGuard ?? createTimelineGuard(), { now, from: lastAdvance })
    if (!guardCheck.allowed) {
      // 只在状态切换时说一次，别每轮刷屏。
      if (state.timelineGuardWarned !== guardCheck.reason) {
        state.timelineGuardWarned = guardCheck.reason
        info(`自动推进跳过（${guardCheck.reason === 'fused' ? '已熔断' : '退避中'}，连续失败 ${guardCheck.failures} 次）：${key}`)
        saveState(key, state)
      }
      return
    }
    state.timelineGuardWarned = null

    // 绑定必须在提交 lastAutoAdvanceAt **之前**定下来。
    // 顺序反了会制造一个要等满一个间隔才自愈的静默丢失：这一轮已经把时间戳落盘、
    // 却发现投不出去，于是角色的话只能留在本地，而下一轮要再等 40 分钟。
    const binding = bindingFor(key, state, cfg)
    const service = binding ? qqIm.service : undefined

    // 这一轮「发不发」的预判：只用来决定给模型的提示与系统提示词口径。
    // 真正的发言内容要等角色写出来才知道，写完之后再按同样规则复核一次。
    const preGating = storyMessageGate(state, cfg, now, Boolean(binding && service)); 
    const mode = preGating.allowed ? 'speak' : 'story-only'

    state.lastAutoAdvanceAt = now
    state.advanceMode = mode
    saveState(key, state)
    // 这一回合由自动推进唤起：它的发言归「主动投递」路径处理（story-only 不发、
    // speak 走 decideAdvanceDelivery 的门控），交互式回复不得重复投递。
    markPluginDrivenTurn(key)

    // 时间导演：开启时在自动推进 notice 里请求模型输出时间账本（对 story-only 与
    // speak 都生效——上游的导演就是给「自动生活推进」服务的，与发不发消息无关）。
    const directorOn = cfg.timelineDirector?.enabled === true
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: renderAdvanceNotice(mode === 'story-only', {
          director: directorOn,
          urge: urgeOn,
        }),
      }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: mode === 'speak' ? '自动生活推进（本轮可能发消息）' : '自动生活推进（只写故事）',
      },
    })

    if (mode === 'story-only' && !directorOn && !urgeOn) {
      // 只写故事：不投递、不等捕获窗口。话留在会话里，下次打开就能看见。
      // 也不提交 lastAutoMessageAt —— 间隔是「上一条自动消息」到现在的距离，
      // 与「写了几次故事」无关。
      state.lastAdvanceDelivery = {
        at: new Date(now).toISOString(),
        mode: 'story-only',
        reason: preGating.reason,
        noBinding: !binding,
      }
      saveState(key, state)
      try {
        agent.followup(notice)
      } catch (error) {
        warn(`续写故事唤起会话 ${key} 失败：${error?.message ?? String(error)}`)
      }
      return
    }

    // 本轮可能发言（或需要解析时间账本）：唤起角色 → 取回它写的故事。
    // story-only + directorOn 时同样走捕获窗口，但只解析账本、不投递、
    // 不提取台词。
    const capture = proactiveCapture.begin(key, cfg.im?.waitForTurnMs ?? 90_000)
    try {
      agent.followup(notice)
    } catch (error) {
      capture.cancel?.()
      warn(`自动生活推进唤起会话 ${key} 失败：${error?.message ?? String(error)}`)
      return
    }

    const captured = await capture
    let written = captured.text

    // 时间导演：从捕获文本里解析账本块，剥离后正文继续走原流程。
    // 解析成功 → 账本落盘（本轮与后续的权威时间线）；
    // 解析失败/缺失 → 记一次导演失败（走 timeline-guard 退避/熔断），降级为无账本推进。
    if (directorOn && written) {
      const parsed = parseTimelinePlanFromText(written)
      if (parsed.plan) {
        state.timelinePlan = parsed.plan
        // carry 并入 timelineCarry（时间线承载，供下一轮投影）。
        const carry = Array.isArray(parsed.plan.carry) ? parsed.plan.carry : []
        if (carry.length) {
          state.timelineCarry = [...new Set([...(state.timelineCarry ?? []), ...carry])].slice(-4)
        }
        recordDirectorSuccess(state.timelineGuard = state.timelineGuard ?? createTimelineGuard())
        info(`时间导演已生成事件账本（${key}）：${parsed.plan.beats.length} 个节点`)
        written = parsed.body
      } else {
        const rawPreview = parsed.raw && typeof parsed.raw === 'object' && !('_unparsed' in parsed.raw)
          ? JSON.stringify(parsed.raw).slice(0, 400)
          : typeof parsed.raw === 'string' ? parsed.raw.slice(0, 400) : 'undefined'
        recordDirectorFailure(state.timelineGuard = state.timelineGuard ?? createTimelineGuard(), { now, from: state.lastAutoAdvanceAt ?? now })
        warn(`时间导演返回被拒绝（连续第 ${state.timelineGuard.failures} 次）：${key} 原始返回=${rawPreview} 拒绝原因=${describeTimelinePlanRejection(parsed.raw)}`)
        // 账本块若存在但非法，仍从正文剥离（不让 JSON 残渣进故事）；无块时正文原样。
        if (parsed.body !== written) written = parsed.body
      }
    }

    // story-only：账本与 urge 已在上面解析/采纳（若开启），正文只留作故事，
    // 到此结束——不投递、不提取台词、不占 lastAutoMessageAt。
    if (mode === 'story-only') {
      adoptUrgeHandoff(state, key, cfg, written, now)
      state.lastAdvanceDelivery = {
        at: new Date(now).toISOString(),
        mode: 'story-only',
        reason: preGating.reason,
        noBinding: !binding,
      }
      saveState(key, state)
      return
    }

    // Urge：从正文里解析模型返回的调度交接并采纳（引用必须逐字命中正文）。
    // 计划（planUrge）在推进前已算过；这里采纳的是**这一轮**的交接，
    // 供下一轮 planUrge 使用（慢速/建议延迟/爆发武装都从这里来）。
    adoptUrgeHandoff(state, key, cfg, written, now)

    if (!written && !(captured.speech ?? []).length) {
      // 写回超时（模型卡住 / 会话被中断）。故事没写出来，间隔不占——下次扫描重来，
      // 否则要白等一整个写故事间隔。
      //
      // **但要退避**：不退避的话，一个持续卡住的会话会被每一轮后台扫描反复唤起，
      // 每次都等到超时才失败——纯烧 token，且永远好不了。
      // 连续失败到阈值就熔断，两小时内不再尝试（降级为「这一轮不推进」）。
      recordDirectorFailure(state.timelineGuard = state.timelineGuard ?? createTimelineGuard(), { now, from: state.lastAutoAdvanceAt ?? now })
      const fuse = timelineDirectorFused(state.timelineGuard)
      if (fuse) {
        warn(`自动推进连续失败 ${fuse} 次，已熔断：${key}（${Math.round(DIRECTOR_FUSE_COOLDOWN_MS / 60_000)} 分钟内不再尝试）`)
      }
      state.lastAdvanceDelivery = {
        at: new Date(now).toISOString(),
        mode: 'none',
        reason: 'no-writeback',
        noBinding: false,
      }
      if (capture.size?.() === 0) delete state.advanceMode
      saveState(key, state)
      return
    }

    // 写回成功 → 清零失败计数与退避，让下一轮正常推进。
    // 不清的话偶发抖动会慢慢攒到熔断（熔断针对的是**连续**失败）。
    recordDirectorSuccess(state.timelineGuard = state.timelineGuard ?? createTimelineGuard())

    // 复核：预判可能因为「角色其实没写台词」而落空，也可能因为这一轮里
    // 别处的投递刚把间隔用掉（并发扫描）而变得不该发。规则只有一份，
    // 复核走的就是 story.js 的纯函数。
    //
    // **显式发言优先**：模型调了 interlude_say 时，那几句话就是它要发出去的，
    // 不需要再从正文里猜。这是「从根上分离」的核心——思考与发言各走各的通道。
    const explicit = captured.speech ?? []
    const decision = decideAdvanceDelivery({
      text: written,
      explicitSpeech: explicit,
      bound: Boolean(binding && service),
      lastMessageAt: state.lastAutoMessageAt ?? 0,
      messageIntervalMinutes: cfg.im?.messageIntervalMinutes ?? 120,
      reachedOut: state.reachedOut ?? 0,
      maxPerDay: cfg.proactive?.maxPerDay ?? 6,
      autoMessageEnabled: autoMessageOnFor(cfg),
      advanceEnabled: cfg.runtime?.autoAdvanceEnabled !== false,
      now: Date.now(),
    })

    if (decision.mode !== 'speak') {
      // 兜底：模型把要说的话写进了**正文**，却没有调用 interlude_say。
      //
      // 线上故障（session-xxx，turn 65，2026-09-17 01:39）：用户从 QQ 发来
      // 「睡了？」，模型写了两行台词却**没调工具**，于是判定 no-speech、
      // 一个字都没发出去 —— 用户那边看到的是「回了但没收到」。
      //
      // 为什么值得兜底：`interlude_say` 是模型**可能忘**的动作，而这段正文
      // 是它**真的写出来的话**。此前承诺漏记（commitmentBackstop）已经证明
      // 「不押在模型每次都记得」这条原则是对的，这里按同一原则办。
      //
      // 边界（三条都得满足才补发）：
      //   ① 确实是「没话说」而不是被间隔/配额拦下 —— 后者发出去会破坏节流；
      //   ② 正文里**确实**有整行台词的形态（extractSpeech 认得出来）；
      //   ③ 过了自言自语闸 —— 否则会把模型的内心独白发出去（出过两次事故）。
      const salvaged = decision.reason === 'no-speech'
        ? salvageBodySpeech(written, explicit)
        : null
      if (salvaged) {
        const resent = await deliverToIm({
          key, state, cfg, text: salvaged.join('\n'), reason: '正文补发（未调用 interlude_say）',
        })
        if (resent.ok) {
          state.reachedOut = (state.reachedOut ?? 0) + 1
          health.recordProactive(key, true)
          state.lastAutoMessageAt = Date.now()
          state.lastAdvanceDelivery = {
            at: new Date(now).toISOString(),
            mode: 'speak',
            reason: 'body-salvage',
            speechLines: salvaged.length,
            sentCount: resent.sentCount,
            noBinding: !binding,
          }
          saveState(key, state)
          info(`模型没调 interlude_say，已从正文补发 ${resent.sentCount} 条：${key}`)
          return
        }
        warn(`正文补发失败（${resent.error}）：${key}`)
      } else if (decision.reason === 'no-speech' && looksLikeMissedSpeech(written, explicit)) {
        // 捞不出来但「看着像有话没发」——只记审计，**不投递**。
        //
        // 这一条覆盖的是 turn 65 那种形态：模型把台词写成**不带引号的裸行**。
        // 它与正常的故事续写在文本上不可区分（见 story.js 的说明），
        // 所以这里刻意不发 —— 但必须留下痕迹，否则故障只表现为
        // 「用户说 QQ 没收到」，而我们这边日志一片安静（正是这次难查的原因）。
        warn(
          `疑似漏发：模型写了正文但没调用 interlude_say（未补发，形态无法安全判定）：`
          + `${key} · ${written.trim().slice(0, 60)}`,
        )
      }

      // 角色这一轮只是活着，没对用户说话（或者间隔/配额不允许多说）：
      // 故事已经留在会话里了，这里只如实记下「没发」的原因，不打扰用户。
      state.lastAdvanceDelivery = {
        at: new Date(now).toISOString(),
        mode: 'story-only',
        reason: decision.reason,
        speechLines: decision.lines,
        noBinding: !binding,
      }
      saveState(key, state)
      return
    }

    // 有序投递条目：文字与图片按调用顺序交错。
    //
    // `decideAdvanceDelivery` 只裁**文字**（它要过自言自语闸、间隔、配额），
    // 图片不参与那些判据——所以这里单独取出来，在真的发言时一起带上。
    // 不带的话，模型在自动推进里调了 interlude_send_image 会被静默丢掉。
    const advanceItems = Array.isArray(captured.items) ? captured.items : []
    const advanceImages = advanceItems.filter(item => item && typeof item === 'object' && item.kind === 'image')
    // 保序合并：把 decision.messages 替换成「原始 items 里的文字 + 图片」。
    // 顺序取自模型调用顺序（items 本就是按调用顺序收集的）。
    const orderedWithImages = advanceImages.length
      ? advanceItems.filter(item => typeof item === 'string')
        .concat(advanceImages)
      : null
    const delivered = await deliverToIm({
      key, state, cfg,
      ...(orderedWithImages ? { items: orderedWithImages } : { text: decision.messages.join('\n') }),
      reason: '故事续写中的发言',
    })
    if (delivered.ok) {
      // 占掉一个主动联系名额，否则上面那道每日上限永远算不到生活推进。
      state.reachedOut = (state.reachedOut ?? 0) + 1
      health.recordProactive(key, true)
      // 只有真的发出去了才推进「发消息间隔」的水位：投递失败时不该白等两小时。
      state.lastAutoMessageAt = Date.now()
      state.lastAdvanceDelivery = {
        at: new Date(now).toISOString(),
        mode: 'speak',
        reason: 'speak',
        speechLines: decision.lines,
        sentCount: delivered.sentCount,
        noBinding: false,
      }
      saveState(key, state)
      return
    }

    warn(`故事续写里的发言投递失败（${delivered.error ?? 'unknown'}），这段话只留在故事里：${key}`)
    state.lastAdvanceDelivery = {
      at: new Date(now).toISOString(),
      mode: 'story-only',
      reason: `delivery-failed:${delivered.error ?? 'unknown'}`,
      speechLines: decision.lines,
      noBinding: false,
    }
    saveState(key, state)
  }

  /**
   * 故事续写的发言门（唤起前的预判）。
   *
   * 与 story.js 的 decideAdvanceDelivery 共用同一套语义，只是这里还没有文本，
   * 所以「有没有台词」这一关必然要留到写完之后复核。这里回答的是
   * 「假设它写了话，这一轮该不该发」。
   *
   * **绑定必须在这里也判一次**（`bound`）。只判间隔与配额的话，未绑定的会话会被
   * 告知「这一轮可能发消息」，而它其实永远发不出去——模型于是照着这个前提写故事
   * （把该说的话写成引语行），用户却什么都没收到。提示词与实际行为必须一致。
   *
   * @param {object} state 会话状态。
   * @param {object} cfg 生效配置。
   * @param {number} now 当前时刻。
   * @param {boolean} bound 本会话是否真的能把消息发出去。
   * @returns {{allowed: boolean, reason: string}}
   */
  function storyMessageGate(state, cfg, now, bound) {
    if (!autoMessageOnFor(cfg)) return { allowed: false, reason: 'auto-message-disabled' }
    if (!bound) return { allowed: false, reason: 'no-binding' }
    const intervalMs = Math.max(0, cfg.im?.messageIntervalMinutes ?? 120) * MINUTE
    const last = Number.isFinite(state.lastAutoMessageAt) ? state.lastAutoMessageAt : 0
    if (last > 0 && now - last < intervalMs) return { allowed: false, reason: 'message-interval' }
    if ((state.reachedOut ?? 0) >= (cfg.proactive?.maxPerDay ?? 6)) return { allowed: false, reason: 'daily-quota' }
    return { allowed: true, reason: 'speak' }
  }

  /**
   * 正在处理中的会话（key → 本轮处理任务）；同一会话同时只允许一次扫描。
   *
   * 为什么必须有：三条路径都会触发扫描——启动扫描、周期扫描、到点定时器——
   * 而一次投递要等捕获窗口（默认 90 秒），重叠窗口很宽。
   * 更要紧的是「标记 delivering 落盘」发生在 `await wakeAgent()` **之后**
   * （冷会话恢复在真机上要几百毫秒），所以并发下两次扫描会读到同一份 pending：
   * 实测两条扫描相距 290ms 各自开口了一次，角色把同一件事说了两遍。
   */
  const inFlight = new Map()

  /** 处理一个会话并登记在案（同一会话不重叠）。 */
  async function processSession(key, live, cfg, now) {
    const task = handleSession(key, live, cfg, now)
      .catch(error => warn(`后台扫描失败（${key}）：${error?.message ?? String(error)}`))
      .finally(() => { if (inFlight.get(key) === task) inFlight.delete(key) })
    inFlight.set(key, task)
    await task
  }

  /**
   * 后台扫描：遍历「实时会话 + 落盘的冷会话」。
   *
   * 冷会话也纳入的原因是整个插件最容易踩的坑：用户不说话时那个会话就没有实时
   * agent，而「到点主动开口」恰恰只在用户不说话时才有意义。只扫 liveAgents
   * 会让主动联系退化成「只在你刚说完话之后才有用」。
   *
   * 各会话**并发**处理：一次 IM 投递要等捕获窗口（默认 90 秒），串行会让
   * 「排在后面的会话」白等前面那个说完话。会话之间互不共享状态（冷会话的
   * state 各自从磁盘读出），所以并发是安全的；同会话的互斥由 inFlight 保证。
   *
   * @param {object} [options]
   * @param {string} [options.only] 只处理这一个会话（定时器到点时的精确触发）。
   */
  async function runSweep(options = {}) {
    const cfg = current()
    if (!cfg.enabled) return
    const now = Date.now()

    /**
     * key -> 实时 agent（没有就是冷会话）。
     *
     * `liveAgents` 只由 `agent/session-start` 与 `entryFor`（pre-step / 工具调用）
     * 填充，所以「插件加载前就已经在跑的会话」可能不在里面。这里统一再问一次
     * `ctx.agents.get()`——它是权威来源，避免把一个其实活着的会话当冷会话去 resume。
     */
    const agentOf = key => liveAgents.get(key) ?? ctx.agents?.get?.(key)
    const targets = new Map()
    if (options.only) {
      targets.set(options.only, agentOf(options.only))
    } else {
      for (const [key, agent] of liveAgents) targets.set(key, agent)
      for (const { key } of listStoredStates()) if (!targets.has(key)) targets.set(key, agentOf(key))
    }

    const jobs = []
    for (const [key, live] of targets) {
      const running = inFlight.get(key)
      if (running) {
        // 周期扫描撞上就跳过：下一轮自己会再来。
        if (!options.only) continue
        // 到点定时器撞上则必须补跑——它是一次性的，跳过就等于把这次精确定时丢了，
        // 那条待办要干等一个扫描周期（默认 5 分钟）才轮到。
        jobs.push(running.then(() => {
          // 等的时候可能又有人接手了，那就交给它，别插队。
          if (inFlight.has(key)) return undefined
          return processSession(key, live, cfg, now)
        }))
        continue
      }
      jobs.push(processSession(key, live, cfg, now))
    }
    await Promise.all(jobs)
  }

  /* ---------------------------------------------------- 到点定时器：启动与回收 */

  // 启动时把磁盘上所有未来的到点时间挂上定时器，并立刻跑一次扫描，
  // 处理「DSH 关着的时候到点」的那批（批内合并、超时过久的不补发）。
  armIntentTimers()
  void runSweep()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const { timer } of intentTimers.values()) clearTimeout(timer)
      intentTimers.clear()
    })
  }

  /* ---------------------------------------------------------------- 启动日志 */
  const boot = current()

  /**
   * 启动自建通道，并在凭据服务稍后就绪时**再启动一次**。
   *
   * ## 为什么需要补启动（线上事故：「重启后必须重新扫码才连上」）
   *
   * 启动日志里 `describeIm` 明明打印了正确的 AppID，通道却停在「未启动」，
   * 而且**一句原因都没有**。原因是两道叠加：
   *
   *   1. `credentials` 不在本插件的 `inject` 里（精简 profile 兼容点），
   *      所以 Cordis 在它注册时**不会**回来通知我们；插件 apply 的这一刻
   *      `ctx.get('credentials')` 还是 undefined；
   *   2. `resolveSecret` 于是退回环境变量、再失败抛错，`start()` 直接返回。
   *      —— 这条失败原先只写了 `ctx.logger.warn`，而它的输出**不进启动日志**，
   *      于是整件事在日志里完全静默（warn 现在也打 stdout，见文件顶部）。
   *
   * 重新扫码之所以能救回来：那时进程早就跑起来了，凭据服务已就绪。
   *
   * 修法：用 `ctx.inject(['credentials'], …)` 精确地「等这个服务出现再补一次」，
   * 而不是盲目轮询——后者在「密钥本身无效」时会反复打 QQ 的 token 接口。
   */
  const tryStartChannel = () => {
    const im = current().im ?? {}
    if (im.enabled === false || !im.appId) return
    const st = qqIm.status()
    if (st.started || st.ready) return
    Promise.resolve().then(() => qqIm.start()).catch((error) => {
      warn(`启动 IM 通道异常：${error?.message ?? String(error)}`)
    })
  }

  qqIm.migrate()
  qqIm.applyConfig?.(current().im ?? {})
  Promise.resolve().then(tryStartChannel)

  // 凭据服务（或任何晚到的依赖）就绪后，补一次启动——这就是「重启不必再扫码」。
  // 用具名函数：cordis 拿函数名当子插件名，日志里能看出是谁触发的。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['credentials'], function startImChannelOnceCredentialsReady() {
        tryStartChannel()
      })
    } catch (error) {
      warn(`注册「凭据就绪后补启动」失败：${error?.message ?? String(error)}`)
    }
  }

  if (boot.enabled) {
    const storyFilled = Object.values(boot.story?.character ?? {}).some(Boolean)
      || Boolean(boot.story?.perspective)
      || Object.values(boot.story?.world ?? {}).some(Boolean)

    const describeIm = () => {
      const im = boot.im ?? {}
      if (im.enabled === false) return '关（im.enabled=false）'
      if (!im.appId) return '关（未配 appId）'
      const st = qqIm.status()
      const where = st.ready ? '已连接' : (st.started ? '连接中' : '未启动')
      return `开（${where}，AppID ${st.appId}，策略 ${im.sayFallback ?? 'strict'}）`
    }
    const meta = `时区=${zone} 写故事=${boot.runtime?.autoAdvanceIntervalMinutes ?? 40}分钟 ` +
      `发消息=${autoMessageOnFor(boot) ? `${boot.im?.messageIntervalMinutes ?? 120}分钟` : '关（只写故事）'} ` +
      `Alter=${boot.alterSystem?.enabled !== false ? '开' : '关'} Agency=${boot.agency?.enabled !== false ? '开' : '关'} ` +
      `Preplan=${boot.schedulePreplan?.enabled !== false ? '开' : '关'} 主动联系=${boot.proactive?.enabled !== false ? `开（每日上限 ${boot.proactive?.maxPerDay ?? 6}）` : '关'} ` +
      `设定=${storyFilled ? '已填' : '未填'} 设置面板=${settingsLive ? '可用（设置 → 插件）' : '不可用'}`

    info(`幕间层已启用 ${meta} IM 直投=${describeIm()}（不调 interlude_say 就不外发）`)

    // 连接是异步的，5 秒后补报一次真实状态——启动失败或凭据缺失在这里暴露。
    const settle = setTimeout(() => {
      const st = qqIm.status()
      if (st.lastError) info(`IM 通道状态：连接失败——${st.lastError}`)
      else if (st.ready) info('IM 通道状态：已连接')
      else info(`IM 通道状态：${st.started ? '连接中' : '未启动（检查 appId / secretRef）'}`)
    }, 5_000)
    if (settle && typeof settle.unref === 'function') settle.unref()
  } else {
    info('幕间层已安装但处于关闭状态（enabled=false）')
  }

  // 卸载时优雅收尾：中止 WS、结算统计。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { qqIm.stop() })
  }
}


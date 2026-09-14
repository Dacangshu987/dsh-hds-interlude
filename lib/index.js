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
  addIntent, dueIntents, settleIntent, addFact, closeFact, upsertOverlay, clearOverlay, rankFacts,
} from './state.js'
import { resolveZone, calendarDayKey, inRestWindow, sameLocalDay, formatStoryDisplayTime } from './clock.js'
import { installProactiveCapture, textOfContent, sessionIdOf } from './capture.js'
import { detectCommitment } from './commitment.js'
import { discoverImBinding, clearImBindingCache, dshHome, listDiscoveredBindings } from './im-binding.js'
import { renderCanon, renderRules, renderInterludeBlock, renderProactiveText, renderStatus, renderPresetCard, renderAdvanceNotice, renderManualAdvanceNotice, renderSpeechModeLine, storyRules } from './render.js'
import {
  splitImText, resolveImChunking, resolveImTimeout, resolveImBinding, resolveImService, deliverImChunks,
} from './im.js'
import { decideAdvanceDelivery, extractSpeech, looksLikeSelfNarration } from './story.js'
import {
  advanceAlterSystem, completeAlterAnalysis, alterAnalysisCoolingDown,
  emotionalOffsetForPrompt, resolveAlterSystemConfig, normalizeAlterValue,
} from './alter.js'
import { evaluateAgencyCapacity, resolveAgencyConfig } from './agency.js'
import {
  resolveSchedulePreplanConfig, schedulePreplanReviewDue, applySchedulePreplanProposal,
  schedulePreplanWindow,
} from './preplan.js'

export const name = PLUGIN_NAME

export { Config }

/**
 * 依赖声明：等这些服务就绪后再启动。
 * `settings` 由 dsh-base 提供，用于可编辑配置。
 *
 * 注意这里**不**声明 `sessionController` / `dshIm`：它们是可选增强——
 *   - 没有 `dshIm` 时主动开口退回「唤起 agent」，只是到不了聊天软件；
 *   - 没有 `sessionController` 时冷会话无法被唤醒，扫描只覆盖活跃会话。
 * 声明成必需会让插件在精简 profile（headless 等）里直接起不来。
 */
export const inject = ['agents', 'systemPrompt', 'tools', 'commands', 'settings', 'webServer']

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 超过这个时长还没送达的到期待办不再补发，只标过期。
 * 「三分钟后提醒我喝水」在 DSH 停了一天之后补发没有意义，还会凑成消息风暴。
 */
const STALE_INTENT_MS = 6 * HOUR

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
  const warn = (message) => {
    try { ctx.logger?.warn?.(message) } catch { /* 忽略 */ }
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
  }
  const current = () => activeConfig

  /* ---------------------------------------- Agent 预设：写入 DSH 自身的 Agent 预设 */
  const agentPresetsRoot = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.agent-presets')

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

  const savePreset = (name, story) => {
    const id = `preset-hds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dir = path.join(agentPresetsRoot(), id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), buildAgentCordisYml(story), 'utf8')
    fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${JSON.stringify(name)}\ndescription: ${JSON.stringify('🎭 幕间系统预设')}\n`, 'utf8')
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
    .map((p) => ({ id: p.id, name: p.name, description: p.description, createdAt: p.createdAt }))

  const deletePreset = (id) => {
    if (typeof id !== 'string' || !id.startsWith('preset-hds-')) return false
    const dir = path.join(agentPresetsRoot(), id)
    fs.rmSync(dir, { recursive: true, force: true })
    const presets = readPresetsJson().filter((p) => p.id !== id)
    writePresetsJson(presets)
    return true
  }

  /* ---------------------------------------- HTTP 设置路由（dsh-tavern 风格，供设置页 fetch） */
  if (typeof ctx.webServer?.register === 'function') {
    const readBody = (req) => new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
        catch (error) { reject(error) }
      })
      req.on('error', reject)
    })
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/settings',
      handler: async (req, res) => {
        const json = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
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
    })

    // 只读运行状态：设置页的「运行状态」卡片专用。
    // 刻意只实现 GET——POST/DELETE 一律 405，保证这张卡片永远不会写坏什么。
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/status',
      handler: async (req, res) => {
        const json = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
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
    })

    // 预设：保存 / 列举 / 删除（写入 DSH 自身的 Agent 预设目录）
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/hds-interlude/presets',
      handler: async (req, res) => {
        const json = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          if (req.method === 'GET') {
            json(200, { ok: true, presets: listMyPresets() })
          } else if (req.method === 'POST') {
            const body = await readBody(req)
            const presetName = String(body?.name ?? '').trim()
            if (!presetName) { json(400, { ok: false, error: '预设名称不能为空' }); return }
            const story = current().story
            const preset = savePreset(presetName, story)
            json(200, { ok: true, preset })
          } else if (req.method === 'DELETE') {
            const body = await readBody(req)
            const deleted = deletePreset(body?.id)
            json(deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: '未找到该预设' })
          } else {
            res.writeHead(405)
            res.end()
          }
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
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
    liveAgents.set(key, agent)
    return { key, state, agent }
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
    if (cfg?.im?.autoDiscover === false) return undefined
    if (!key) return undefined
    const found = discoverImBinding(key, { home: dshHome() })
    if (!found) return undefined
    return { botId: found.botId, targetId: found.targetId, source: 'discover', channel: found.channel, name: found.name }
  }

  /** 本会话是否确实经聊天软件收发（决定要不要注入「一条一条发」的说话方式）。 */
  const imActiveFor = (key, state, cfg) => Boolean(bindingFor(key, state, cfg))

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
    const imActive = imActiveFor(entry.key, state, cfg)

    const messages = []

    // 首次角色回合：注入人设（canon）+ 规则（rules），持久于会话日志，此后不再重复。
    // 规则段按**会话形态**分叉：
    //   - 绑定了聊天软件的会话：你在聊天软件里和对方说话（IM 规则，只写发得出去的字）；
    //   - 没绑定的会话：没有人收到你的话，你写的每一段都只是故事（故事续写规则）。
    // 两条规则的口径正好相反（前者禁旁白、后者要旁白），给错了故事就会写成聊天记录，
    // 或者聊天记录里塞满旁白——所以这里必须按实际形态选，而不是一律给 IM 规则。
    if (state.canonInjected !== true) {
      const canonText = renderCanon(cfg.story)
      if (canonText) {
        messages.push(createUserMessage({
          content: [{ type: 'text', text: canonText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:canon`, text: canonText }] },
        }))
      }
      const rulesText = renderRules(cfg, { imActive })
      if (rulesText) {
        messages.push(createUserMessage({
          content: [{ type: 'text', text: rulesText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:rules`, text: rulesText }] },
        }))
      }
      if (!imActive) {
        const storyText = storyRules(autoMessageOnFor(cfg))
        messages.push(createUserMessage({
          content: [{ type: 'text', text: storyText }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: `${name}:story`, text: storyText }] },
        }))
      }
      state.canonInjected = true
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
      const text = renderInterludeBlock({
        now, zone, state, config: cfg, due, imActive: imActiveFor(entry.key, state, cfg), extraLine: modeLine,
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
    description: '维护长期事实：add 写入一条承诺/重要事件/稳定世界事实/未解决事项；close 关闭一条已兑现或已失效的事实。',
    parameters: {
      action: { type: 'string', enum: ['add', 'close'], required: true, description: 'add 或 close。' },
      content: { type: 'string', description: 'add 时：事实内容。' },
      scope: { type: 'string', enum: ['promise', 'event', 'world', 'relationship', 'general'], description: '事实类别。' },
      importance: { type: 'number', description: '0–1 重要度。' },
      id: { type: 'string', description: 'close 时：事实 id。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const now = Date.now()
      if (args.action === 'add') {
        const content = String(args.content ?? '').trim()
        if (!content) throw new Error(`${name}: content 不能为空。`)
        const fact = addFact(entry.state, { scope: args.scope, content, importance: args.importance }, now)
        saveState(entry.key, entry.state)
        return `已写入长期事实 (${fact.id})：${content}`
      }
      if (args.action === 'close') {
        const fact = closeFact(entry.state, String(args.id ?? ''), 'resolved')
        saveState(entry.key, entry.state)
        return fact ? `已关闭 (${fact.id})：${fact.content}` : `没有找到事实 ${args.id}。`
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

  // 读取幕间事实
  ctx.tools.register(defineTool({
    name: 'interlude_state',
    description: '读取当前幕间事实：角色本地时间、距上次互动多久、连续性快照、长期事实、气氛底色、到期待办、主体行动窗口、近期日程。拿不准「现在是什么时候」时用它。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) {
      const entry = entryFor(callerAgent(exec))
      if (!entry) throw new Error(`${name}: 当前调用没有可归属的会话。`)
      const now = Date.now()
      return renderStatus({
        now, zone, state: entry.state, config: current(), due: dueIntents(entry.state, now),
        imBinding: bindingFor(entry.key, entry.state, current()),
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
          return { kind: 'success', text: renderStatus({ now, zone, state, config: cfg, due: dueIntents(state, now), imBinding: bindingFor(key, state, cfg) }) }
        case 'context': {
          // 按得分排序，不是按插入顺序取前 N 条（见 state.js 的 rankFacts 说明）。
          const facts = rankFacts(state, cfg.runtime?.memoryLimit ?? 20, now)
          const lines = [
            `连续性快照：${state.continuity || '（无）'}`,
            `长期事实（${facts.length}，按重要度/时效排序）：`,
            ...facts.map(f => `  (${f.id}) [${f.scope}] ${f.content}`),
            `设定演化（Overlay，${state.overlay?.length ?? 0}）：`,
            ...(state.overlay ?? []).map(o => `  ${o.layer}: ${o.content}`),
          ]
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
              ? `已解除手工绑定，但本会话仍有一个「会话双向同步」目标可用：${stillFound.botId} / ${stillFound.targetId}（自动发现）。`
              : '已解除本会话的 IM 投递绑定。' }
          }
          if (sub === 'targets') {
            const service = resolveImService(ctx)
            if (!service) return { kind: 'error', text: 'dsh-im 未加载，无法列出投递目标。' }
            if (typeof service.listBots !== 'function' || typeof service.listTargets !== 'function') {
              return { kind: 'error', text: 'dsh-im 未暴露 listBots/listTargets。' }
            }
            let bots = []
            try { bots = await service.listBots() } catch (error) {
              return { kind: 'error', text: `列举 Bot 失败：${error?.message ?? error}` }
            }
            if (!Array.isArray(bots) || bots.length === 0) {
              return { kind: 'success', text: '没有可用的 IM Bot。先在 设置 → IM机器人 里添加一个。' }
            }
            const lines = []
            for (const botId of bots) {
              let targets = []
              try { targets = await service.listTargets(botId) } catch { targets = [] }
              lines.push(`Bot ${botId}：${targets.length} 个目标`)
              for (const target of targets) {
                const route = target?.route
                  ? Object.entries(target.route).map(([k, v]) => `${k}=${v}`).join(' ')
                  : ''
                lines.push(`    ${target?.targetId}（${target?.kind ?? '?'}）${target?.name ? ` ${target.name}` : ''}${route ? ` [${route}]` : ''}`)
              }
            }
            lines.push('用 /interlude im bind <botId> <targetId> 绑定到本会话。')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (sub === 'test') {
            const binding = bindingFor(key, state, cfg)
            if (!binding) return { kind: 'error', text: '未绑定投递目标。先 /interlude im bind <botId> <targetId>，或在设置里填 im.botId / im.targetId。' }
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
          if (sub === 'discover' || sub === 'targets' && rest[0] === '--refresh') {
            clearImBindingCache()
            const found = listDiscoveredBindings({ home: dshHome(), ttlMs: 0 })
            if (found.length === 0) {
              return { kind: 'success', text: '没有发现任何已开启「会话双向同步」的投递目标。在 设置 → IM机器人 → 目标行 打开该开关后再试。' }
            }
            const lines = ['从 dsh-im 发现的目标（按会话双向同步）：']
            for (const item of found) {
              lines.push(`  ${item.sessionId === key ? '→ ' : '  '}${item.botId} / ${item.targetId}（${item.channel}${item.name ? ` ${item.name}` : ''}）→ ${item.sessionId.slice(0, 20)}…`)
            }
            lines.push('标 → 的就是本会话，已自动生效。')
            return { kind: 'success', text: lines.join('\n') }
          }
          const binding = resolveImBinding(state, cfg)
          const last = state.lastImDelivery
          const lines = [
            binding
              ? `IM 绑定：${binding.botId} / ${binding.targetId}（来源：${IM_BINDING_SOURCE[binding.source] ?? binding.source}${binding.channel ? `，渠道 ${binding.channel}` : ''}）`
              : 'IM 绑定：未配置（主动消息不会走到 IM）。用 /interlude im bind <botId> <targetId> 绑定，或在 设置 → IM机器人 里给目标打开「会话双向同步」。',
            `投递服务：${resolveImService(ctx) ? '可用' : '不可用（dsh-im 未加载）'}`,
            `自动发现：${cfg.im?.autoDiscover === false ? '关' : '开'}`,
            `自动生活推进推送：${cfg.im?.deliverAutoAdvance === false ? '关（仅本地补写）' : '开（有绑定的会话会发到聊天软件）'}`,
            last
              ? `上次投递：${last.ok ? '成功' : '失败'} ${last.sentCount}/${last.total} 条${last.error ? `（${last.error}）` : ''} @ ${last.at}`
              : '上次投递：无',
          ]
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'purge': {
          Object.assign(state, loadState(key).__proto__ === Object.prototype ? {} : {})
          // 简单重置：把可变字段清空，保留游标。
          state.facts = []
          state.overlay = []
          state.intents = []
          state.continuity = ''
          state.alter = { alterValue: 0, alterWeight: 0, lastTriggerDirection: 0, emotionalOffset: null, history: [], lastUpdatedAt: new Date().toISOString() }
          state.agencyWindow = null
          state.proactiveDrafts = []
          state.preplan = null
          state.reachedOut = 0
          saveState(key, state)
          return { kind: 'success', text: '已清除本会话的幕间数据（事实/意图/演化/日程/气氛）。' }
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
          return { kind: 'error', text: `未知子命令 ${verb}；可用：status | context | schedule | memory | overlay | alter | agency | preplan | advance | im | on | off | purge` }
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
  const proactiveCapture = installProactiveCapture(ctx, { name })

  /**
   * 把「并入本次开口」的其它到期待办一起结掉。
   * 它们在同一次主动联系里被一起说了，不该之后再各触发一次。
   * state 由调用方传入（这个函数在闭包外没有 state 可依）。
   */
  function settleBundled(state, target, now) {
    for (const item of target.bundled ?? []) {
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
  async function deliverToIm({ key, state, cfg, text, reason }) {
    const binding = bindingFor(key, state, cfg)
    if (!binding) return { ok: false, error: 'no-binding' }
    const service = resolveImService(ctx)
    if (!service) return { ok: false, error: 'dsh-im-unavailable' }

    const chunkingCfg = cfg.im?.chunking ?? {}
    const messages = chunkingCfg.enabled === false
      ? (text.trim() ? [text.trim()] : [])
      : splitImText(text, resolveImChunking(chunkingCfg))
    if (messages.length === 0) return { ok: false, error: 'no-content' }

    const result = await deliverImChunks({
      service,
      binding,
      messages,
      chunking: chunkingCfg,
      timeoutMs: resolveImTimeout(cfg.im ?? {}),
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
   * 起因（线上实测 session-ffc1e728）：用户说「三分钟后提醒我喝水」，
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
      pendingTurns.set(key, { text: '', planned: false })
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
      pendingTurns.delete(key)
      if (turn.planned) return
      recordMissedCommitment(key, turn.text)
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
    let service = binding ? resolveImService(ctx) : undefined

    /**
     * 到点当口 dsh-im 还没就绪时，短暂等一下再判。
     *
     * 为什么需要：dsh-im 是 8 MB 的大包，服务注册偏晚（`provide` 在 async apply 里）。
     * 如果待办恰好在这之前到点，旧逻辑会因为「binding 有、service 没有、又没有实时 agent」
     * 而直接 return —— 待办留在 pending，要等**下一次扫描**（默认 5 分钟）才重来。
     * 用户看到的就是「说好三分钟，结果八分钟后才有动静」。
     *
     * 只在「差一点就能直投」时等：有 binding 但没 service。
     * 等不到就照常走后面的被动分支，不阻塞其它会话。
     */
    if (binding && !service) {
      for (const wait of [500, 1500, 3000]) {
        await new Promise(resolve => setTimeout(resolve, wait))
        service = resolveImService(ctx)
        if (service) {
          info(`dsh-im 服务在第 ${wait}ms 就绪，到期待办改用 IM 直投：${target.summary}`)
          break
        }
      }
    }

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
      const written = await capture
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
   * （session-58be9b68 第 7 轮就是这么坏的）。
   */
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
    const threshold = interval + (jitter ? (Math.random() - 0.5) * jitter : 0)
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
    const effectiveInterval = resting ? restIntervalFor(restWindows, interval) : interval
    if (now - lastAssistant < threshold && !resting) return
    if (now - lastAdvance < effectiveInterval) return

    // 绑定与投递服务必须在提交 lastAutoAdvanceAt **之前**定下来。
    // 顺序反了会制造一个要等满一个间隔才自愈的静默丢失：这一轮已经把时间戳落盘、
    // 却发现 dsh-im 还没就绪，于是角色的话只能留在本地，而下一轮要再等 40 分钟。
    const binding = bindingFor(key, state, cfg)
    let service = binding ? resolveImService(ctx) : undefined
    if (binding && !service) {
      // 与到期待办同样的「差一点就绪」等待：dsh-im 的 provide 在 async apply 里，注册偏晚。
      for (const wait of [500, 1500, 3000]) {
        await new Promise(resolve => setTimeout(resolve, wait))
        service = resolveImService(ctx)
        if (service) break
      }
    }

    // 这一轮「发不发」的预判：只用来决定给模型的提示与系统提示词口径。
    // 真正的发言内容要等角色写出来才知道，写完之后再按同样规则复核一次。
    const preGating = storyMessageGate(state, cfg, now, Boolean(binding && service))
    const mode = preGating.allowed ? 'speak' : 'story-only'

    state.lastAutoAdvanceAt = now
    state.advanceMode = mode
    saveState(key, state)

    const notice = createUserMessage({
      content: [{ type: 'text', text: renderAdvanceNotice(mode === 'story-only') }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: mode === 'speak' ? '自动生活推进（本轮可能发消息）' : '自动生活推进（只写故事）',
      },
    })

    if (mode === 'story-only') {
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

    // 本轮可能发言：唤起角色 → 取回它写的故事 → 从故事里剥出要对用户说的话。
    const capture = proactiveCapture.begin(key, cfg.im?.waitForTurnMs ?? 90_000)
    try {
      agent.followup(notice)
    } catch (error) {
      capture.cancel?.()
      warn(`自动生活推进唤起会话 ${key} 失败：${error?.message ?? String(error)}`)
      return
    }

    const written = await capture
    if (!written) {
      // 写回超时（模型卡住 / 会话被中断）。故事没写出来，间隔不占——下次扫描重来，
      // 否则要白等一整个写故事间隔。
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

    // 复核：预判可能因为「角色其实没写台词」而落空，也可能因为这一轮里
    // 别处的投递刚把间隔用掉（并发扫描）而变得不该发。规则只有一份，
    // 复核走的就是 story.js 的纯函数。
    const decision = decideAdvanceDelivery({
      text: written,
      bound: Boolean(binding && service),
      lastMessageAt: state.lastAutoMessageAt ?? 0,
      messageIntervalMinutes: cfg.im?.messageIntervalMinutes ?? 120,
      reachedOut: state.reachedOut ?? 0,
      maxPerDay: cfg.proactive?.maxPerDay ?? 6,
      autoMessageEnabled: autoMessageOnFor(cfg),
      advanceEnabled: cfg.runtime?.autoAdvanceEnabled !== false,
      now: Date.now(),
    })

    return
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
  if (boot.enabled) {
    const storyFilled = Object.values(boot.story?.character ?? {}).some(Boolean)
      || Boolean(boot.story?.perspective)
      || Object.values(boot.story?.world ?? {}).some(Boolean)
    const imBinding = resolveImBinding(null, boot)
    const discovered = boot.im?.autoDiscover === false ? [] : listDiscoveredBindings({ home: dshHome() })

    /**
     * IM 状态要**延迟**判一次。
     *
     * 插件是按 inject 就绪就开始的，而 dsh-im 是 8MB 的大包、服务注册也偏晚；
     * 启动那一瞬 `ctx.get('dshIm')` 可能还查不到（提供者 fiber 尚未 ACTIVE）。
     * 若当场就把结论写死，日志会误报「dsh-im 未加载」——而它其实好好的。
     * 这行日志是用户唯一能自检的窗口，必须如实。
     */
    const describeIm = () => {
      const svc = resolveImService(ctx)
      if (!svc) return '关（dsh-im 未加载）'
      if (imBinding) return `开（配置 ${imBinding.botId} / ${imBinding.targetId}）`
      return discovered.length ? `开（自动发现 ${discovered.length} 个会话目标）` : '开但未绑定目标'
    }
    const meta = `时区=${zone} 写故事=${boot.runtime?.autoAdvanceIntervalMinutes ?? 40}分钟 ` +
      `发消息=${autoMessageOnFor(boot) ? `${boot.im?.messageIntervalMinutes ?? 120}分钟` : '关（只写故事）'} ` +
      `Alter=${boot.alterSystem?.enabled !== false ? '开' : '关'} Agency=${boot.agency?.enabled !== false ? '开' : '关'} ` +
      `Preplan=${boot.schedulePreplan?.enabled !== false ? '开' : '关'} 主动联系=${boot.proactive?.enabled !== false ? `开（每日上限 ${boot.proactive?.maxPerDay ?? 6}）` : '关'} ` +
      `设定=${storyFilled ? '已填' : '未填'} 设置面板=${settingsLive ? '可用（设置 → 插件）' : '不可用'}`

    info(`幕间层已启用 ${meta} IM 直投=${describeIm()}（启动即时判定）`)
    // 给后来的服务一次补报机会：与上一行不一致时再打一行，免得用户被启动那行误导。
    const settle = setTimeout(() => {
      const late = describeIm()
      if (!late.startsWith('关（dsh-im 未加载）')) {
        info(`IM 直投状态已就绪：${late}`)
      }
    }, 5_000)
    if (settle && typeof settle.unref === 'function') settle.unref()
  } else {
    info('幕间层已安装但处于关闭状态（enabled=false）')
  }
}

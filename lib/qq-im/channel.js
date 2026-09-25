/**
 * QQ IM 通道 —— hds-interlude 的聊天软件接入层。
 *
 * ## 这一层解决什么
 *
 * hds-interlude 原本依赖 `@xmanrui/dsh-im` 做两件事：**收**（QQ 消息进会话）
 * 与**发**（角色的话出到 QQ）。dsh-im 的 3.4 MB / 317 文件里我们实际只用
 * 一条渠道，却要为 11 个渠道的抽象与大量不需要的概念付出复杂度。
 *
 * 更要命的是它的 `sessionSync`：那个对象的存在本身就是开关，关掉它会
 * `delete` 整个对象，而我们做自动绑定发现又依赖它的 `conversationKey`——
 * 于是「关掉镜像」与「保留主动投递能力」被不可分割地耦合在一起，
 * **没有出路**。自建之后这个死结直接消失：绑定与镜像本来就是两件事，
 * 本层只负责前者，镜像通道根本不存在。
 *
 * ## 多 Bot（v2）
 *
 * 一个插件实例可以挂多个 QQ 机器人账号（开放平台 5 个/人），模型与 dsh-im
 * 的 `QqController` 对齐：
 *   - `const channel` → `Map<botId, QqChannel>`（对应 dsh-im 的 `#runtimes`）；
 *   - 每个 Bot 独立启动/停止/重连，单个失败只记进 per-bot 错误表（对应
 *     dsh-im 的 `#errors`），不影响其它 Bot；
 *   - 运行统计与最近错误按 botId 分桶（解决 C-2）；
 *   - 绑定表复合键 `botId\0conversationKey` 由 binding.js 负责。
 *
 * ## 与宿主的分工（合并后的边界）
 *
 * **本层负责**：
 *   - QQ 协议的收发（经 `qq.js` 包装腾讯官方 SDK）；
 *   - 入站幂等与路由（QQ 消息 → DSH 会话）；
 *   - 绑定表的读写（会话 ↔ 投递目标）；
 *   - 分条与投递记账。
 *
 * **宿主（index.js）负责**：
 *   - 什么时候该说话（频次、配额、休息时段、主体行动窗口）；
 *   - 说什么（`say.js` 从 `interlude_say` 取话）；
 *   - 会话状态的持久化。
 *
 * 分工的判据很简单：**凡是「与聊天软件协议相关」的在这里，凡是
 * 「与角色何时开口相关」的在宿主**。投递策略只有一份，不在两个地方各写一套。
 *
 * ## 服务形状
 *
 * 本层通过 `installQqIm()` 向宿主暴露一个对象（形状与 dsh-im 的 `dshIm` 一致：
 * `send` / `listBots` / `listTargets`），宿主再把它 `provide` 出去。
 * 这样 hds-interlude 既有的 `deliverImChunks` 调用点可以原样复用。
 *
 * @module dsh-hds-interlude/qq-im/channel
 */

import path from 'node:path'
import fs from 'node:fs'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveConfig } from './config.js'
import { BindingStore, migrateLegacyBindings, targetIdOf, scopeOf, integrationHome } from './binding.js'
import { isBotCommandCandidate } from './bot-commands.js'
import { QqChannel, resolveSecret, QqCredentialError } from './qq.js'
import { DedupeWindow, handleInbound, renderInboundText } from './inbound.js'
import { harvestInboundImages } from './sticker-harvest.js'
import { deliverMessages, splitOutboundText, resolveChunking, resolveTimeout, buildReceipt } from './outbound.js'
import { GroupWillingnessStore, evaluateGroupWillingness, resolveGroupWillingness } from '../group-willingness.js'

/** 会话事件里用于标记「这条注入来自 IM 通道」的署名。 */
export const SOURCE_PLUGIN = 'hds-interlude'

/** 单个会话保留的事件窗口上限——只用于本轮发言判定，不需要长期累积。 */
const MAX_TURN_EVENTS = 200

/** 通道记账文件。 */
function stateFile(home) {
  return path.join(integrationHome(home), 'state.json')
}

/** 把错误（对象/Error/字符串）统一规整成可读文本。 */
function normalizeErrorText(value) {
  if (value == null) return null
  if (typeof value === 'string') return value || null
  if (value instanceof Error) return value.message || String(value)
  if (typeof value === 'object') {
    const text = value.error ?? value.message ?? value.text
    if (typeof text === 'string' && text) return text
  }
  try { return String(value) } catch { return '未知错误' }
}

/** 新建一份 per-bot 统计桶。 */
function emptyStats() {
  return {
    inbound: 0,
    outbound: 0,
    blocked: 0,
    lastDelivery: null,
    lastError: null,
    lastInbound: null,
  }
}

/**
 * 安装 QQ 通道。
 *
 * @param {object} ctx Cordis 上下文（宿主的，不是本层新建的）。
 * @param {object} options
 * @param {object} options.config 已归一的 IM 通道配置（宿主从自己的 config.im 传入）。
 * @param {(level: string, text: string) => void} [options.log] 日志回调（宿主提供，带前缀）。
 * @param {(nameOrId?: string) => string|undefined} [options.resolvePreset]
 *   把「预设名或 id」解析成可传给 sessionController.create 的预设 id。
 *   自动新建会话时用它带上角色预设——**没有角色预设的新会话不会注入人设与
 *   发言规则，模型不会调用 interlude_say，于是收得到消息却永远不回复。**
 * @returns {object}通道句柄：服务对象 + 生命周期 + 供宿主查询的接口。
 */
export function installQqIm(ctx, {
  config: rawConfig = {}, log = () => {}, transport, resolvePreset, resolveCwd, onBotCommand, resolveBotName,
  registerPreset,
} = {}) {
  let config = resolveConfig(rawConfig)
  const debug = (text) => log('debug', text)
  const info = (text) => log('info', text)
  const warn = (text) => log('warn', text)

  /* ------------------------------------------------------------ 状态与组件 */

  // v1 → v2 迁移时给无归属旧绑定补的 botId：取「迁移那一刻配置里的 botId」。
  const bindings = new BindingStore({ legacyBotId: config.botId })
  const dedupe = new DedupeWindow({
    ttlMs: config.dedupe.ttlMinutes * 60_000,
    maxEntries: config.dedupe.maxEntries,
  })
  /**
   * 群聊发言意愿状态（每群一份）。
   *
   * 只活在内存：它是**当下这一小段时间**的判断，重载归零反而更合理——
   * 落盘会让重启后带着旧的"热情"继续抢话。
   */
  const willingnessStore = new GroupWillingnessStore()

  /** botId → QqChannel 运行时（对齐 dsh-im 的 `#runtimes`）。 */
  const channels = new Map()
  /** botId → 该 Bot 的运行统计。 */
  const statsByBot = new Map()
  /** botId → 该 Bot 最近一次失败原因（对齐 dsh-im 的 `#errors`，解决 C-2）。 */
  const errorsByBot = new Map()

  /** sessionId → 投递目标（避免每条入站消息都查一遍绑定表）。 */
  const sessionBindings = new Map()
  /** 每个会话最近一次入站消息的时刻 / msgId（决定走被动回复还是主动推送）。 */
  const lastInboundAt = new Map()
  const lastInboundRef = new Map()
  /** 正在处理的投递：防止同一轮被投递两次。带超时释放。 */
  const delivering = new Map()
  const DELIVERING_TTL_MS = 5 * 60 * 1000

  /** 取（或建）一个 Bot 的统计桶。 */
  function statsFor(botId) {
    const key = typeof botId === 'string' && botId ? botId : config.botId
    let bucket = statsByBot.get(key)
    if (!bucket) {
      bucket = emptyStats()
      statsByBot.set(key, bucket)
    }
    return bucket
  }

  /**
   * 全通道统计（聚合）：宿主与前端读的是这一个对象，per-bot 明细在
   * `statsByBot` 里。`lastError` / `lastInbound` 取最近的。
   */
  function aggregateStats() {
    const buckets = [...statsByBot.values()]
    const withAt = (key) => buckets
      .map(b => b[key])
      .filter(Boolean)
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0] ?? null
    return {
      inbound: buckets.reduce((sum, b) => sum + (b.inbound ?? 0), 0),
      outbound: buckets.reduce((sum, b) => sum + (b.outbound ?? 0), 0),
      blocked: buckets.reduce((sum, b) => sum + (b.blocked ?? 0), 0),
      lastDelivery: withAt('lastDelivery') ?? null,
      lastError: [...errorsByBot.values()][0] ?? null,
      lastInbound: withAt('lastInbound') ?? null,
    }
  }

  /**
   * 统计落盘（合并节流）。
   *
   * 入站消息、投递记账、错误记录常成批触发，每次都同步 `writeFileSync` 会在消息风暴下
   * 阻塞事件循环。这里把同一 tick 内的多次调用合并成「下一宏任务再写」；
   * 进程卸载走 `stop()` 时改用同步 flush，保证最终数据不丢。
   */
  let statsFlushPending = false
  let statsFlushTimer = null
  function saveStats() {
    if (statsFlushPending) return
    statsFlushPending = true
    statsFlushTimer = setTimeout(() => {
      statsFlushPending = false
      statsFlushTimer = null
      writeStatsNow()
    }, 0)
    if (statsFlushTimer && typeof statsFlushTimer.unref === 'function') statsFlushTimer.unref()
  }

  function writeStatsNow() {
    try {
      const file = stateFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const perBot = Object.fromEntries([...statsByBot.entries()].map(([botId, s]) => [botId, s]))
      const data = `${JSON.stringify({ version: 2, stats: aggregateStats(), bots: perBot }, null, 2)}\n`
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, data, 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      debug(`统计落盘失败：${error?.message ?? String(error)}`)
    }
  }

  function recordDelivery(receipt, botId) {
    const bucket = statsFor(botId)
    bucket.lastDelivery = receipt
    if (receipt?.ok !== true && receipt?.error) bucket.lastError = { at: receipt.at, error: receipt.error }
    saveStats()
  }

  /** 记一条「这个 Bot 连不上/启动失败」的原因（per-bot，互不覆盖）。 */
  function recordBotError(botId, text) {
    const at = new Date().toISOString()
    errorsByBot.set(botId, { at, error: text })
    statsFor(botId).lastError = { at, error: text }
    saveStats()
  }

  /** 按 botId 找配置条目。 */
  function botEntryOf(botId) {
    return config.bots.find(bot => bot.botId === botId)
  }

  /** 取 Bot 的通道实例（没有就建）。 */
  function channelOf(botId) {
    const bot = botEntryOf(botId)
    if (!bot) return undefined
    let ch = channels.get(botId)
    if (!ch) {
      ch = new QqChannel({
        appId: bot.appId,
        // AppSecret 在 start() 时才解析——凭据可能后填，启动时缺不该让插件起不来。
        appSecret: undefined,
        accountId: bot.botId,
        markdownSupport: config.markdownSupport,
        logger: {
          info: (message) => debug(`QQ SDK: ${message}`),
          warn: (message) => debug(`QQ SDK warn: ${message}`),
          error: (message) => warn(`QQ SDK error: ${message}`),
          debug: (message) => debug(`QQ SDK debug: ${message}`),
        },
      })
      channels.set(botId, ch)
    }
    return ch
  }

  /** 第一条可用的通道（缺省投递目标用）。 */
  function primaryChannel() {
    for (const bot of config.bots) {
      const ch = channels.get(bot.botId)
      if (ch) return ch
    }
    return undefined
  }

  /* ------------------------------------------------------------ 绑定解析 */

  /**
   * 取某会话键绑定的角色名（用来匹配同名角色预设）。
   * 绑定里没记名字时返回 undefined。
   */
  function bindingNameOf(conversationKey, botId) {
    if (typeof conversationKey !== 'string' || !conversationKey) return undefined
    const found = bindings.get(conversationKey, botId)
    const name = found?.name
    return typeof name === 'string' && name.trim() ? name.trim() : undefined
  }

  /**
   * 按 DSH 会话 id 查投递目标。
   *
   * 这是替换 dsh-im `sessionSync` 的关键：绑定关系由我们自己持有，
   *不再需要去读别人的磁盘文件反查，也不再有「关掉镜像就失去绑定」的死结。
   *
   * 缓存键带 botId（`botId\0sessionId`，解决 A-2）：绑定跨 Bot 变更后不会
   * 命中旧缓存；再加上绑定写入路径统一 invalidate，手动 rebind 也立即生效。
   */
  function bindingForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    const found = bindings.bySessionId(sessionId)
    if (!found) return undefined
    const cacheKey = `${found.botId ?? ''}\u0000${sessionId}`
    const cached = sessionBindings.get(cacheKey)
    if (cached) return cached
    const resolved = {
      sessionId,
      // 不再 `?? config.botId` 兜底（C-1）：v2 绑定必有 botId，旧数据迁移时已补全。
      botId: found.botId,
      targetId: targetIdOf(found.conversationKey) ?? found.conversationKey,
      conversationKey: found.conversationKey,
      scope: scopeOf(found.conversationKey),
      source: 'binding',
    }
    sessionBindings.set(cacheKey, resolved)
    return resolved
  }

  /** 清掉会话级绑定缓存（绑定变更后调用）。 */
  function invalidateBindings() {
    sessionBindings.clear()
  }

  /**
   * 清除某个 bot 的全部绑定（删除机器人时调用）。
   *
   * 为什么必须清：绑定表是**持久化**的，删除 bot 只改配置、不碰它。若不清理，
   * 该 bot 重新扫码接回来后，旧绑定还指向删除前的旧会话——消息又进旧会话，
   * 而不是按用户预期「开新会话」。
   *
   * @param {string} botId
   * @returns {number} 清除的绑定条数。
   */
  function removeBotBindings(botId) {
    if (typeof botId !== 'string' || !botId) return 0
    const rows = bindings.list(botId)
    for (const row of rows) {
      try { bindings.remove(row.conversationKey, botId) } catch { /* 单条失败不影响其它 */ }
    }
    if (rows.length > 0) invalidateBindings()
    return rows.length
  }

  /* ------------------------------------------------------------ 投递 */

  /**
   * 发一段话到 QQ。
   *
   * @param {object} options
   * @param {string} [options.botId] 用哪个机器人发；缺省用第一个已启动的。
   * @param {string} options.targetId 用户 openid。
   * @param {string} [options.text] 原始文本（会自动分条）。
   * @param {string[]} [options.messages] 已分好的消息（优先于 text）。
   * @param {string} [options.scope] `c2c` / `group`。
   * @param {string} [options.msgId] 被动回复关联的入站消息 id。
   * @param {string} [options.reason] 投递原因（记账用）。
   * @returns {Promise<object>} 投递结果（含 receipt）。
   */
  async function sendToTarget({ botId, targetId, text, messages, scope = 'c2c', msgId, reason }) {
    const chunking = resolveChunking(config.chunking)
    // 条目可以是文字（字符串）或图片（`{kind:'image', source}`），按顺序交错。
    //
    // **`messages` 里的是已定稿的条目，不在这里重新分条/清洗**——这是刻意的：
    // 调用方把文本放进 `messages` 就是在说「这几条原样发出去」。bot-command
    // 路径正依赖这一点：命令回复是系统文本，`（测试）` 这类括号若过分条清洗
    // 会被当旁白删掉（线上症状：`/status` 回「已连接（测试）」变成「已连接」）。
    // 需要分条的调用方走 `text` 参数，或自己先切好再传进来。
    const hasItems = Array.isArray(messages) && messages.length > 0
    const list = hasItems
      ? messages.filter(item => (typeof item === 'string' ? item.trim() : item))
      : chunking.enabled === false
        ? (typeof text === 'string' && text.trim() ? [text.trim()] : [])
        : splitOutboundText(text, chunking)

    if (list.length === 0) {
      return {
        ok: false, sentCount: 0, total: 0, error: 'no-messages',
        receipt: buildReceipt({ ok: false, sentCount: 0, total: 0, error: 'no-messages' }, { reason }),
      }
    }

    const ch = botId ? channels.get(botId) : primaryChannel()
    if (!ch?.bot && !transport) {
      const receipt = buildReceipt({ ok: false, sentCount: 0, total: list.length, error: 'im-unavailable' }, { reason })
      recordDelivery(receipt, botId)
      return { ok: false, sentCount: 0, total: list.length, error: 'im-unavailable', receipt }
    }

    // 被动回复：有 msgId 时走 reply 路径，不消耗主动消息额度。
    // **只有第一条**带 msgId——QQ 的被动回复必须关联到触发它的那一条入站消息。
    //
    // 用下标而不是比文本：两条内容相同的消息（角色完全可能连发两句「在的」）
    // 会让「chunk === list[0]」误判第二条也是被动回复，而那时 QQ 侧的
    // 5 分钟回复窗口可能已经关掉，第二条就会莫名其妙失败。
    let firstTextDone = false
    const result = await deliverMessages({
      send: async (peer, chunk, extra) => {
        // 图片条目：走 sendImage。它是**主动消息**路径——被动回复（replyText）
        // 只支持文本，图片带 msgId 会被 QQ 侧拒绝，所以刻意不传 msgId。
        const isImage = extra?.kind === 'image' || (chunk && typeof chunk === 'object' && chunk.kind === 'image')
        if (isImage) {
          const source = chunk?.source ?? chunk
          if (transport) return transport(peer, chunk)
          return ch.sendImage(scope === 'group' ? `group:${peer}` : peer, source)
        }
        // 被动回复只给**第一条文本**：图片不占这个名额，否则「图 + 文」时
        // 那句话会退化成主动消息、白白吃掉主动额度。
        const useReply = !firstTextDone && msgId
        firstTextDone = true
        // transport 是测试注入的出口：有了它就不碰真实网络，
        // 但**走的是同一条记账与分条路径**，所以测的是真行为而不是替身行为。
        if (transport) return transport(peer, chunk)
        return useReply
          ? ch.replyText(peer, chunk, msgId, scope)
          : ch.sendText(scope === 'group' ? `group:${peer}` : peer, chunk)
      },
      targetId,
      messages: list,
      chunking,
      timeoutMs: resolveTimeout(config),
      reason,
      // 图片发不出去时降级成一句文字：对方至少知道「本想发张图」，
      // 而不是对话里凭空少了一段、角色像没回应一样。
      onImageError: () => '[图片发送失败]',
    })

    if (result.ok) {
      statsFor(botId).outbound += result.sentCount
      saveStats()
    }
    recordDelivery(result.receipt, botId)
    return result
  }

  /* ------------------------------------------------------------ 入站 */

  /**
   * 让一个会话的 agent 可用。
   *
   * 冷会话没有实时 agent，但 `sessionController.resolveAgent()` 正是宿主自己的
   * 「找到或恢复这个会话」入口（客户端打开历史会话走的也是它）。
   *
   * **取服务必须用 `ctx.get('sessionController')` 而不是属性访问 `ctx.sessionController`**：
   * 本插件不在 inject 里声明 sessionController（它是精简 profile 的可选增强），
   * Cordis 对未声明服务的属性访问**抛错**，catch 后 controller=undefined，
   * 于是「恢复会话」永远失败 → 入站消息 status=no-agent → 角色不回复。
   * （线上事故：`status=error (no-agent)` 且 dsh 端没有任何会话变化。）
   * `ctx.get()` 对未注册的名字返回 undefined，不会抛——正好走降级分支。
   */
  async function resolveAgentFor(sessionId) {
    const live = ctx.agents?.get?.(sessionId)
    if (live) return live
    let controller
    try {
      controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
    } catch {
      return undefined
    }
    if (typeof controller?.resolveAgent !== 'function') return undefined
    try {
      const resolved = await controller.resolveAgent(sessionId)
      if (!resolved || resolved.error) return undefined
      return resolved.agent
    } catch (error) {
      warn(`恢复会话 ${sessionId} 失败：${error?.message ?? String(error)}`)
      return undefined
    }
  }

  /**
   * 建一个新的 DSH 会话并把首条消息带进去。
   *
   * 走 `sessionController.create()` 而不是 `ctx.agents.create()`：后者**要求调用方
   * 自己提供 sessionId**（它是「在给定身份上构造 agent」），而我们要的正是
   * 「让宿主分配一个身份」。自己拼 id 会和宿主的命名/持久化约定脱节。
   *
   * 注意 `sessionController.create()` 失败时是**抛错**（不像 resolveAgent 返回
   * `{error}`），所以这里必须 try/catch。
   *
   * @param {object} [options] 可选参数。
   * @param {string} [options.presetId] 显式指定角色预设（QQ 用户 /preset 切换角色用）；
   *   缺省时按「bot.agentPreset → 全局 im.agentPreset → 绑定角色名」的顺序解析。
   */
  async function createSessionFor(conversationKey, message, botId, options = {}) {
    let controller
    try {
      // 同上：用 ctx.get 而不是属性访问（未声明服务时属性访问抛错）。
      controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
    } catch {
      warn('session 不可用，无法自动新建会话。请用 /interlude im bind 手工绑定。')
      return undefined
    }
    if (typeof controller?.create !== 'function') {
      warn('宿主未暴露会话创建入口，无法自动新建会话。请用 /interlude im bind 手工绑定。')
      return undefined
    }

    // 带上角色预设。**没有角色预设的新会话不会被注入人设与发言规则**
    // （index.js 的 pre-step 注入以 isRoleplaySession 为前提），模型因此不会
    // 调用 interlude_say → 收得到消息却永远不回复。
    // 预设来源（per-bot）：该 bot 自己的 agentPreset 优先，其次全局 im.agentPreset，
    // 最后按绑定里的角色名匹配同名预设。
    let presetId
    if (typeof resolvePreset === 'function') {
      try {
        const bot = botEntryOf(botId)
        // 显式指定（QQ 用户 /preset 切换角色）优先；否则按 bot 默认预设链解析。
        const preferred = typeof options?.presetId === 'string' && options.presetId.trim()
          ? options.presetId.trim()
          : (bot?.agentPreset || config.agentPreset || bindingNameOf(conversationKey, botId))
        presetId = resolvePreset(preferred)
      } catch (error) {
        warn(`解析角色预设失败：${error?.message ?? String(error)}`)
      }
    }
    if (presetId) info(`自动新建会话将使用角色预设 ${presetId}`)
    else warn('自动新建会话没有可用角色预设：新会话不会注入人设与发言规则，角色可能不回复。请用 /interlude im bind 绑到已有角色会话，或配置 im.agentPreset。')

    // 工作目录：DSH 的会话列表**按 workspace 分组**，建在别的 cwd 下的会话
    // 不会出现在用户当前打开的 workspace 里（线上症状：「已经有回复了，
    // 但 dsh 里不显示会话」）。优先级：该 bot 自己的 cwd → 全局 im.cwd →
    // 宿主最近活跃会话目录 → 宿主的 defaultCwd。
    let cwd = botEntryOf(botId)?.cwd || config.cwd || ''
    if (!cwd && typeof resolveCwd === 'function') {
      try { cwd = resolveCwd() || '' } catch (error) {
        warn(`解析工作目录失败：${error?.message ?? String(error)}`)
      }
    }
    if (cwd) info(`自动新建会话的工作目录：${cwd}`)
    else warn('自动新建会话没有确定的工作目录，将落在宿主的默认目录；它可能不会出现在你当前打开的 workspace 列表里。请配置 im.cwd。')

    let created
    try {
      created = await controller.create({
        ...presetId ? { agentPreset: presetId } : {},
        ...cwd ? { cwd } : {},
      })
    } catch (error) {
      // DSH 升级后 `create({ agentPreset })` 会强校验预设是否注册在宿主
      // agentPresets registry；本插件的预设只写在 ~/.dsh/.agent-presets/，
      // 宿主从不扫描该目录 → Unknown agent preset → 建会话失败 → 降级建出
      // 无预设会话 → 不是角色会话 → 不注入人设 → 收得到消息却永远不回复。
      // 这里尝试把预设注册进宿主后**重试一次**（幂等：已注册则直接放行）。
      const msg = String(error?.message ?? error)
      if (presetId && /Unknown agent preset/i.test(msg) && typeof registerPreset === 'function') {
        info(`宿主不认识角色预设 ${presetId}，尝试注册后重试建会话…`)
        try {
          const registered = await registerPreset(presetId)
          if (registered) {
            created = await controller.create({
              ...presetId ? { agentPreset: presetId } : {},
              ...cwd ? { cwd } : {},
            })
          } else {
            warn(`注册角色预设 ${presetId} 未成功，放弃建会话。`)
          }
        } catch (retryError) {
          warn(`注册角色预设 ${presetId} 后重试建会话仍失败：${retryError?.message ?? String(retryError)}`)
        }
      } else {
        warn(`新建会话失败：${msg}`)
      }
      if (!created) return undefined
    }

    const sessionId = created?.sessionId ?? created?.id ?? created?.agent?.session?.id
      ?? created?.session?.id ?? created?.header?.id
    if (typeof sessionId !== 'string' || !sessionId) {
      warn('新建会话没有返回可识别的 sessionId，已放弃。')
      return undefined
    }

    // 把首条消息注入，让角色一开始就知道有人在 QQ 里说话。
    // 用 followup 而不是 inject：inject 不唤醒驱动，新会话没人唤醒它就不会回话。
    //
    // **重要：`create()` 不返回 live agent**（返回 `{ sessionId, agentPreset? }`），
    // 所以必须再 `resolveAgentFor(sessionId)` 拿真正的 agent 才能 followup。
    // 旧写法 `const agent = created?.agent` 永远是 undefined → 首条消息从未注入
    // → 会话建了、绑定建了、消息标记 delivered，但模型一个字都没看到 →
    // 「收 1 条、绑 1 个会话、三环全✓，却发 0 条、没有回复」。
    const agent = await resolveAgentFor(sessionId)
    if (agent && typeof agent.followup === 'function') {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: renderInboundText(message, { includeSource: config.inboundPrefix }) }],
          source: { kind: SOURCE_PLUGIN, plugin: SOURCE_PLUGIN, form: 'notice', summary: 'QQ 私聊消息' },
        }))
      } catch (error) {
        warn(`新会话注入首条消息失败：${error?.message ?? String(error)}`)
      }
    } else {
      warn(`新建会话 ${sessionId} 后未能恢复 live agent，首条消息未注入。`)
    }
    return sessionId
  }

  /** 处理一条入站 QQ 消息（botId 标明它来自哪个机器人）。 */
  async function onQqMessage(message, botId) {
    const bucket = statsFor(botId)
    bucket.inbound += 1
    saveStats()
    // 入站诊断：只要 SDK 把消息交进来，这里必有这行 info。
    // 「成功连接但收消息不回复」在此一分为二：
    //   没有这行 → SDK 没收到消息（订阅/权限问题，看 QQ SDK debug 日志）；
    //   有这行但没有后续 → 路由/唤醒环节把消息丢了（看下面每步日志）。
    info(`收到 QQ 消息（bot ${botId}）：kind=${message?.kind} sender=${message?.senderId ?? '?'} msgId=${message?.messageId ?? '?'} content=${String(message?.content ?? '').slice(0, 40)}`)
    // 每条消息按它来自的 Bot 路由：config.botId 决定绑定复合键的 botId 段，
    // 并带上该 bot 的白名单（routeInbound 据此过滤非白名单用户）。
    const perBotConfig = { ...config, botId }
    const botWhitelist = botEntryOf(botId)?.whitelist
    if (Array.isArray(botWhitelist) && botWhitelist.length > 0) perBotConfig.whitelist = botWhitelist

    // 群聊「@角色名」识别：收集本会话/本 bot 的角色名候选（绑定 name / bot 别名 /
    // bot 人设名），供 isGroupMention 判「@江柚」这类**纯文本**提及——QQ 群里用户
    // 敲的 @人设名 不会产生平台 mention，得按名字识别（见 inbound.js）。
    const mentionNames = []
    const botEntry = botEntryOf(botId)
    if (botEntry?.alias) mentionNames.push(String(botEntry.alias).trim())
    const mbScope = message?.kind === 'group' ? 'group' : 'c2c'
    const mbPeer = mbScope === 'group' ? (message?.groupOpenid ?? message?.senderId) : message?.senderId
    if (typeof mbPeer === 'string' && mbPeer) {
      const bindName = bindings.get(`${mbScope}:${mbPeer}`, botId)?.name
      if (typeof bindName === 'string' && bindName) mentionNames.push(bindName.trim())
    }
    if (typeof resolveBotName === 'function') {
      const storyName = resolveBotName(botId)
      if (typeof storyName === 'string' && storyName) mentionNames.push(storyName.trim())
    }
    const uniqueNames = [...new Set(mentionNames.filter(Boolean))]
    if (uniqueNames.length) perBotConfig.mentionNames = uniqueNames

    // ══ 用户发来的表情包：落盘进表情库，供角色之后复用 ══
    //
    // 为什么在这里、且**不 await**：QQ 给的图片 URL 会过期，不落盘就等于没收到；
    // 但收割是旁路，绝不能让它拖慢（更不能挡住）消息注入模型。
    // 所以 fire-and-forget，失败只记日志。
    if (config.harvestInbound !== false && config.stickerDir) {
      void harvestInboundImages({
        message,
        dir: config.stickerDir,
        sender: message?.senderId,
        fetchImpl: config.harvestFetch,
        log,
      }).then((r) => {
        if (r.saved > 0) info(`已收入 ${r.saved} 张用户表情（新增 ${r.created}）→ ${config.stickerDir}`)
      }).catch((error) => warn(`表情包收割失败：${error?.message ?? error}`))
    }

    // ══ 机器人命令（对齐 dsh-im：用户在 QQ 私聊里发 /命令，插件直接处理、不进模型）══
    // 判定（isBotCommandCandidate）：单行文本、以 / 开头、私聊、开关打开。
    // **白名单优先**：不在该 bot 白名单里的用户，命令也不响应（否则白名单外的
    // 人能通过 /new /session 等命令绕过白名单操作绑定）。
    const rawText = typeof message?.content === 'string' ? message.content : ''
    const scopeOfMessage = message?.kind === 'group' ? 'group' : 'c2c'
    const peerId = scopeOfMessage === 'group'
      ? (message?.groupOpenid ?? message?.senderId)
      : message?.senderId
    const conversationKey = typeof peerId === 'string' && peerId ? `${scopeOfMessage}:${peerId}` : ''
    const whitelistBlocked = Array.isArray(botWhitelist) && botWhitelist.length > 0
      && typeof peerId === 'string' && !botWhitelist.includes(peerId)
    // per-bot 命令开关：全局 im.botCommands 与「该机器人的 botCommands」都要开。
    const botCommandsOn = config.botCommands !== false && botEntryOf(botId)?.botCommands !== false
    if (isBotCommandCandidate({ message, config }) && !whitelistBlocked && botCommandsOn
      && conversationKey && typeof onBotCommand === 'function') {
      let handled
      try {
        handled = await onBotCommand({ message, botId, conversationKey, scope: scopeOfMessage })
      } catch (error) {
        warn(`机器人命令执行失败（${botId}）：${error?.message ?? String(error)}`)
      }
      if (handled && typeof handled?.reply === 'string') {
        info(`机器人命令已处理（bot ${botId}）：${rawText.slice(0, 40)}`)
        bucket.lastInbound = {
          at: new Date().toISOString(),
          status: 'command',
          sessionId: handled.sessionId ?? null,
          senderId: message?.senderId,
          msgId: message?.messageId,
          botId,
        }
        saveStats()
        // 命令结果回投给用户（被动回复，带 msgId 不消耗主动额度）；不进模型。
        // **必须走 messages 数组**：sendToTarget 对 text 会过「旁白清洗/分条」
        // （把命令回复里的括号内容当台词旁白删掉），命令回复是系统文本，
        // 应当原样整体发出。
        await sendToTarget({
          botId,
          targetId: peerId,
          scope: scopeOfMessage,
          messages: [handled.reply],
          msgId: message?.messageId,
          reason: 'bot-command',
        })
        return { status: 'command', reply: handled.reply }
      }
    }

    const result = await handleInbound({
      message,
      dedupe,
      bindings,
      config: perBotConfig,
      resolveAgent: resolveAgentFor,
      createSession: (key, msg) => createSessionFor(key, msg, botId),
      // 群聊意愿层：关掉 mentionOnly 后用它决定「这条要不要回」，并做最小间隔冷却。
      willingness: {
        evaluate: ({ key, mentionedBot, content, quotedBot, messageCount, now }) => {
          const cfg = resolveGroupWillingness(perBotConfig?.group?.willingness ?? {})
          if (!cfg.enabled) return { shouldCall: true, reason: 'disabled' }
          const decision = evaluateGroupWillingness(
            willingnessStore.stateOf(key),
            cfg,
            { now, messageCount, content, quotedBot, mentionedBot, lastReplyAt: willingnessStore.lastReplyOf(key) },
          )
          willingnessStore.setState(key, decision.state)
          return decision
        },
      },
      // 必须用 followup 而不是 inject：inject 只把消息塞进上下文、
      // **不唤醒驱动**（dsh-agent 文档原文 "without waking the driver"），
      // 已存在的会话收到 QQ 消息后模型根本不会跑 → 收消息不回复。
      // followup 会唤醒驱动开一个普通回合，让角色真的回应。
      inject: (agent, text) => {
        const id = safeSessionId(agent)
        info(`唤醒会话 ${id}（文本 ${String(text).length} 字）`)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: SOURCE_PLUGIN, plugin: SOURCE_PLUGIN, form: 'notice', summary: 'QQ 私聊消息' },
        }))
        return true
      },
      log: (level, text) => log(level, text),
    })

    // 群聊意愿记账：真的把这条唤起了才消耗意愿 + 刷新冷却水位。
    // 记账放在这里而不是判定处：判定会算上"即将发生的这条"，若最后没唤起
    // （比如 agent 解析失败），意愿就被白白扣掉了。
    if (result?.status === 'delivered' && message?.kind === 'group') {
      const groupKey = `${String(result.conversationKey ?? '')}`
      const wCfg = resolveGroupWillingness(perBotConfig?.group?.willingness ?? {})
      if (wCfg.enabled && groupKey) willingnessStore.noteReply(groupKey, wCfg, Date.now())
    }

    info(`入站路由结果：${result?.status}${result?.reason ? `（${result.reason}）` : ''}${result?.sessionId ? ` session=${result.sessionId}` : ''}`)
    // 记录最近一次入站结果（前端 /interlude im 可见）。
    bucket.lastInbound = {
      at: new Date().toISOString(),
      status: result?.status,
      reason: result?.reason,
      sessionId: result?.sessionId,
      senderId: message?.senderId,
      msgId: message?.messageId,
      botId,
    }
    saveStats()
    if (result.status === 'delivered' && result.sessionId) {
      lastInboundAt.set(result.sessionId, Date.now())
      lastInboundRef.set(result.sessionId, {
        msgId: message?.messageId,
        openid: message?.senderId,
        scope: message?.kind === 'group' ? 'group' : 'c2c',
      })
      invalidateBindings()
    }
    return result
  }

  /** 稳妥取会话 id（不抛错）。 */
  function safeSessionId(agent) {
    try {
      return agent?.session?.id ?? agent?.id ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /* ------------------------------------------------------------ 服务对象 */

  /**
   * 对宿主暴露的服务。
   *
   * 形状与 dsh-im 的 `dshIm` 保持一致（`send` / `listBots` / `listTargets`），
   * 这样 hds-interlude 既有的 `deliverImChunks` 调用点可以原样复用。
   * `send` 必须返回 `{ sent: true }` 才算确认送达——静默成功会让上层
   * 「宁可重试也不假装送达」的记账失效。
   */
  const service = {
    /**
     * 主动投递一段话。
     *
     * @param {string} botId 用哪个机器人发（多 Bot 场景下有意义）。
     * @param {string} targetId 用户 openid。
     * @param {string} text 要发的话（会自动按「一条一事」分条）。
     * @param {object} [options] `{ signal }`。
     * @returns {Promise<{sent: boolean, sentCount?: number, total?: number, error?: string}>}
     */
    async send(botId, targetId, text, options = {}) {
      void options
      const result = await sendToTarget({
        botId,
        targetId: targetIdOf(targetId) ?? targetId,
        scope: scopeOf(targetId),
        text,
        reason: 'interlude:send',
      })
      if (result.ok) return { sent: true, sentCount: result.sentCount, total: result.total }
      // 失败时如实回报错误码，让调用方保留原文重发（不重新生成）。
      return {
        sent: false, sentCount: result.sentCount ?? 0, total: result.total ?? 0,
        error: result.error, remaining: result.remaining,
      }
    },

    /** 列出全部已配置的 bot。 */
    async listBots() {
      return config.bots.map(bot => ({
        id: bot.botId,
        name: bot.alias || bot.botId,
        channel: 'qq',
        connected: Boolean(channels.get(bot.botId)?.bot),
      }))
    },

    /**
     * 列出某个 bot 的投递目标。
     *
     * 与 dsh-im 的差异：dsh-im 把 `conversationKey` 剥掉了（只留
     * `{ enabled, state }`），导致上层无法自动发现绑定。本实现**如实暴露**
     * `conversationKey` 与 `sessionId`。
     */
    async listTargets(botId) {
      const rows = typeof botId === 'string' && botId
        ? bindings.list().filter(item => item.botId === botId)
        : bindings.list()
      return rows.map(item => ({
        id: targetIdOf(item.conversationKey) ?? item.conversationKey,
        botId: item.botId,
        conversationKey: item.conversationKey,
        sessionId: item.sessionId,
        name: item.name,
        enabled: true,
        state: item.botId && channels.get(item.botId)?.bot ? 'connected' : 'disconnected',
      }))
    },

    /** 按会话 id 找投递目标（宿主可直接用，替代旧的磁盘反查）。 */
    resolveBySession(sessionId) {
      return bindingForSession(sessionId)
    },
  }

  /* ------------------------------------------------------------ 生命周期 */

  /**
   * 启动全部 Bot 的通道。
   *
   * 凭据在**启动时**才解析：设置里可能后填，启动时缺不该让插件崩溃——
   * 记一条警告，等 `/interlude im reconnect` 或下次重启再试。
   *
   * 逐个 Bot 启动，单个失败只记进 per-bot 错误表，**不影响其它 Bot**
   * （对齐 dsh-im 的 `initialize()`：`for (const config of ...list())`）。
   *
   * 已有连接在跑时**等它退出再建新连接**（`channel.restart()`）——
   * 否则旧连接的 finally 会把新连接的 started/ready 清掉，
   * 表现就是「重连后一直连接中，永不 READY」。
   */
  async function start() {
    if (!config.enabled) {
      info('IM 通道已禁用（enabled=false），不建立连接。')
      return
    }
    if (config.bots.length === 0) {
      const text = '未配置任何 QQ 机器人（bots 为空且未填 appId），通道不会启动。请在设置里填入 AppID（或扫码绑定）。'
      warn(text)
      recordBotError(config.botId, text)
      return
    }
    for (const bot of config.bots) {
      await startBot(bot)
    }
  }

  /** 启动单个 Bot（缺凭据/失败都只记自己的错误，不打断其它 Bot）。 */
  async function startBot(bot) {
    if (!bot.appId) {
      const text = `未配置 appId（bot ${bot.botId}），该通道不会启动。请在设置里填入 AppID（或扫码绑定）。`
      warn(text)
      recordBotError(bot.botId, text)
      return
    }
    let secret
    try {
      secret = await resolveSecret(ctx, bot.secretRef)
    } catch (error) {
      // 真实原因必须进 lastError：前端据此显示具体问题（凭据未配/为空/
      // 服务不可用），而不是笼统的「可能未配置」猜测。
      const text = `无法解析 AppSecret（bot ${bot.botId}：${error?.message ?? String(error)}），该通道未启动。`
      warn(text)
      recordBotError(bot.botId, text)
      return
    }
    const ch = channelOf(bot.botId)
    if (!ch) return
    ch.appSecret = secret
    // appId / accountId / markdown 也必须在**每次启动时**同步：
    // 它们只在 QqChannel 构造时从 config 快照过一次，而 config 会随设置热更
    // （扫码换绑后 AppID 就变了）。不同步的话，重连会拿旧 AppID 去连新凭据，
    // 表现为「扫码成功了，通道却连不上」。
    ch.appId = bot.appId
    ch.accountId = bot.botId
    ch.markdownSupport = config.markdownSupport
    ch.onMessage((message) => onQqMessage(message, bot.botId))

    // 在跑则重启（等旧连接退出），否则新建。
    const run = ch._run ? ch.restart() : ch.start()
    void run.catch((error) => {
      const text = error instanceof QqCredentialError
        ? `凭据无效（bot ${bot.botId}）：${error.message}`
        : `QQ 通道启动失败（bot ${bot.botId}）：${error?.message ?? String(error)}`
      warn(text)
      recordBotError(bot.botId, text)
    })
    info(`QQ 通道启动中（AppID ${bot.appId}，botId ${bot.botId}${bot.alias ? `，别名 ${bot.alias}` : ''}）。`)
  }

  /** 停止全部通道。 */
  function stop() {
    for (const ch of channels.values()) {
      try { ch.stop() } catch { /* 已停止 */ }
    }
    // 卸载时同步 flush：把尚未刷新的统计一次性落盘，别让进程退出丢数据。
    if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null }
    statsFlushPending = false
    writeStatsNow()
  }

  /**
   * 重连：`[botId]` 只重连指定 Bot，无参重连全部。
   *
   * @param {string} [botId]
   */
  async function reconnect(botId) {
    if (typeof botId === 'string' && botId) {
      const bot = botEntryOf(botId)
      if (!bot) throw new Error(`没有配置 bot ${botId}。已配置：${config.bots.map(b => b.botId).join(', ') || '（无）'}`)
      await startBot(bot)
      return
    }
    await start()
  }

  /**
   * 应用新配置并（需要时）重连。
   *
   * 与 applyConfig 的区别：applyConfig 只更新内存配置、提示需要 reconnect；
   * 这里**同步**把配置推进去，并立刻建连/重连——扫码落地路径用这个，
   * 因为扫码结束后必须让新凭据立即生效，不能等用户手动 reconnect。
   *
   * 为什么**总是** start（而不是看 needsRestart）：
   * 扫码落地前 settingsScope.update 可能已经通过宿主 watch 把配置推进了
   * 通道（appId 已是新值），此时 applyConfig 判定「配置没变化」→
   * needsRestart=false。若据此 return，通道就**从未启动**——表现正是
   * 「扫码后一直未启动、lastError 空」。通道没在跑就必须建连。
   *
   * @param {object} nextRaw 可以是「{ im: {...} }」（扫码落地传的 settings 补丁
   *   形状），也可以是扁平 im 块（watch 回调形状）。统一解包成扁平 im
   *   再交给 applyConfig——后者契约是**扁平 im 块**，传 `{im:{...}}`
   *   会让 appId/secretRef/enabled 读到 undefined。
   * @returns {Promise<{configApplied: boolean, reconnectStarted: boolean}>}
   */
  async function applyConfigAndReconnect(nextRaw) {
    const im = nextRaw && typeof nextRaw === 'object' && nextRaw.im
      ? nextRaw.im
      : nextRaw
    applyConfig(im)
    // 无脑建连：start() 内部自己区分「在跑→restart / 未跑→新建」。
    // 这样无论 config 是否刚被 watch 推进过，扫码后都一定能启动。
    await start()
    return { configApplied: true, reconnectStarted: true }
  }

  /** 首次启动时只读迁移 dsh-im 的遗留绑定，让用户无需重新绑定。 */
  function migrate() {
    if (!config.migrateLegacyBindings) return 0
    const count = migrateLegacyBindings(bindings)
    if (count > 0) info(`已从 dsh-im 遗留数据迁移 ${count} 条绑定。`)
    invalidateBindings()
    return count
  }

  /** 通过 messaging 发一条测试消息（`[botId]` 指定机器人，缺省第一个）。 */
  async function sendTest(targetId, botId) {
    return sendToTarget({ botId, targetId, text: '这是一条来自 DSH 的测试消息。', reason: 'manual-test' })
  }

  /**
   * 配置热更新。
   *
   * 只更新那些「下一次操作读得到」的字段（分条、策略、去重窗口等）。
   * **appId / secretRef / bots 的变更需要重连才生效**——正在跑的 WebSocket 已
   * 绑定旧凭据，原地换值不会让它改换身份，只会让状态与配置不一致。
   * 那种情况下返回 `{ needsRestart: true }`，宿主提示用户 reconnect。
   *
   * **必须独立函数声明**：applyConfigAndReconnect 的闭包也要调用它。
   */
  function applyConfig(nextRaw = {}) {
    const next = resolveConfig(nextRaw)
    const needsRestart = next.appId !== config.appId || next.secretRef !== config.secretRef
      || next.enabled !== config.enabled
      || JSON.stringify(next.bots) !== JSON.stringify(config.bots)
    // **先记下旧 bots**：删除检测要遍历「旧配置里存在、新配置里消失」的 bot，
    // 不能只看 channels Map——没启动过的 bot（如凭据错误从未连上）在 channels 里
    // 没有条目，只看 channels 会漏掉它的绑定清理。
    const previousBots = config.bots
    config = next
    // 去重窗口随配置变化（TTL 变了要立刻生效，不能等重启）。
    dedupe.ttlMs = config.dedupe.ttlMinutes * 60_000
    dedupe.maxEntries = config.dedupe.maxEntries
    // 从配置里消失的 Bot：清掉它的运行时与绑定，避免残留旧连接（D-2 的服务端侧）
    // 和旧会话关系（重新扫码后应开新会话，而不是回到删除前的旧会话）。
    for (const prev of previousBots) {
      if (!botEntryOf(prev.botId)) {
        try { channels.get(prev.botId)?.stop() } catch { /* 已停 */ }
        channels.delete(prev.botId)
        const removed = removeBotBindings(prev.botId)
        if (removed > 0) info(`已从配置删除机器人 ${prev.botId}，清除其 ${removed} 条绑定（重新接入将开新会话）。`)
      }
    }
    if (needsRestart) {
      info('IM 通道的连接参数已变更（appId / secretRef / bots / enabled），需要重连才生效：/interlude im reconnect')
    }
    return { needsRestart }
  }

  return {
    service,
    // 用 getter：applyConfig / applyConfigAndReconnect 会替换内部 config 变量，
    // 这里必须每次读取都拿**当前生效**的配置，否则宿主拿到的是安装时的旧快照
    // （线上症状：扫码后 qqIm.config.appId 仍是空，通道读取不到新 AppID）。
    get config() { return config },
    get stats() { return aggregateStats() },
    /** per-bot 统计明细（状态展示用）。 */
    statsByBot,
    /** per-bot 最近错误（C-2：多 Bot 下「哪个 Bot 挂了」是刚需）。 */
    errorsByBot,
    start,
    stop,
    reconnect,
    migrate,
    sendTest,
    sendToTarget,
    bindingForSession,
    invalidateBindings,
    /** 清除某个 bot 的全部绑定（删除机器人 / 重新接入时用）。 */
    removeBotBindings,
    bindings,
    /**
     * 通道连接状态。
     *
     * 兼容旧调用点的同时暴露 per-bot 明细：顶层 `started/ready/appId/lastError`
     * 是**聚合**值（任一 Bot 就绪即 ready），`bots` 数组逐 Bot 报状态——
     * 「哪个 Bot 挂了、为什么挂」看 `bots[].lastError`。
     */
    status: () => {
      const bots = config.bots.map(bot => {
        const ch = channels.get(bot.botId)
        const st = ch?.status?.() ?? {
          started: false, ready: false,
          appId: bot.appId, accountId: bot.botId, lastError: null,
        }
        return {
          botId: bot.botId,
          alias: bot.alias || '',
          appId: bot.appId,
          started: st.started,
          ready: st.ready,
          // lastError 统一规整成字符串：errorsByBot 存的是 {at, error} 对象，
          // SDK 的 lastError 是字符串——不规整会让前端显示「[object Object]」。
          lastError: normalizeErrorText(errorsByBot.get(bot.botId) ?? st.lastError ?? null),
        }
      })
      return {
        started: bots.some(b => b.started),
        ready: bots.some(b => b.ready),
        appId: bots[0]?.appId ?? '',
        accountId: bots[0]?.botId ?? '',
        lastError: bots.find(b => b.lastError)?.lastError ?? null,
        bots,
      }
    },
    /** 入站消息的最近时间/引用（宿主判断被动回复窗口用）。 */
    lastInboundOf: (sessionId) => ({ at: lastInboundAt.get(sessionId) ?? 0, ref: lastInboundRef.get(sessionId) }),
    /** 标记某会话正在投递（宿主防重入用）。 */
    isDelivering: (sessionId) => {
      const ts = delivering.get(sessionId)
      if (!ts) return false
      if (Date.now() - ts > DELIVERING_TTL_MS) {
        delivering.delete(sessionId)
        return false
      }
      return true
    },
    markDelivering: (sessionId, on) => { if (on) delivering.set(sessionId, Date.now()); else delivering.delete(sessionId) },
    /** 事件窗口上限，供宿主参考。 */
    MAX_TURN_EVENTS,

    /**
     * 配置热更新。
     *
     * 只更新那些「下一次操作读得到」的字段（分条、策略、去重窗口等）。
     * **appId / secretRef / bots 的变更需要重连才生效**——正在跑的 WebSocket
     * 已绑定旧凭据，原地换值不会让它改换身份，只会让状态与配置不一致。
     * 那种情况下返回 `{ needsRestart: true }`，宿主提示用户 reconnect。
     */
    applyConfig,

    /** 应用新配置并立即重连（扫码落地路径用）。 */
    applyConfigAndReconnect,

    /**
     * 新建会话并把首条入站消息带进去。
     *
     * 暴露出来是为了**测试与自检**：`sessionController.create()` 的返回里
     * 没有 live agent（只有 `{ sessionId, agentPreset? }`），必须再 resolve
     * 一次才能真正 followup——这条链路过长、极易写错（线上事故：
     * `created.agent` 恒为 undefined，首条消息从未注入，消息 delivered 却无人回复）。
     */
    createSessionFor,

    /**
     * 直接把一条 SDK 入站消息喂进通道的完整入站处理（含机器人命令拦截）。
     *
     * 暴露出来是为了**测试与自检**：`onQqMessage` 是 SDK 回调的闭包，外部无法
     * 触发；有了它，测试可以注入任意消息验证「命令拦截 / 路由 / 注入」整条链路。
     */
    ingestMessage: onQqMessage,
  }
}


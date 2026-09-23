/**
 * 入站：QQ 私聊消息 → 对应 DSH 会话。
 *
 * 三件事，每一件都对应一个踩过的坑：
 *
 * 1. **幂等** —— SDK 文档明确警告：机器人重连可能导致同一条消息重复回调。
 *    不按 `messageId` 去重的话，网络抖一次用户就会看到角色把同一句话回两遍。
 *    去重表有 TTL（默认 10 分钟）与容量上限，不会无限增长。
 *
 * 2. **绑定发现** —— `conversationKey`（`c2c:<openid>`）反查已绑定的 DSH 会话。
 *    绑定表由 binding.js 自己拥有，**不再依赖 dsh-im 的 sessionSync**（见那边注释
 *    说明为什么那个依赖是个死结）。
 *
 * 3. **未绑定时的抉择** —— 按配置「自动新建会话」或「忽略」。
 *    未绑定**不等于**可以随便塞：没有 sessionId 又不同意新建时，宁可丢掉这条消息
 *    并留下日志，也不要猜一个会话出来——串会话比丢消息严重得多。
 *
 * 本模块的幂等判定与路由决策是纯函数（可单测）；只有 `handleInbound` 触及宿主。
 *
 * @module dsh-hds-interlude/qq-im/inbound
 */

import { humanizeFaces } from './face.js'
import { fallbackSenderName } from './normalize.js'

/** 去重表默认保留时长。够长以覆盖一次重连风暴，够短以免永久占内存。 */
const DEFAULT_TTL_MS = 10 * 60_000

/** 去重表容量上限。超出后按插入顺序淘汰最旧的。 */
const DEFAULT_MAX_ENTRIES = 2_000

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 按 messageId 去重的滑动窗口。
 *
 * 为什么不用「全部 messageId 落盘」：QQ 的消息 id 永不复用，但长期运行会累积
 * 到十几万条——那对去重毫无收益，只是在耗内存。10 分钟的窗口足够覆盖重连
 * 造成的重复回调（重复总是紧跟原消息，不会隔天再来一次）。
 */
export class DedupeWindow {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] 条目存活时长。
   * @param {number} [options.maxEntries] 容量上限。
   * @param {() => number} [options.now] 时钟注入（测试用）。
   */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
    this.maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES
    this.now = typeof options.now === 'function' ? options.now : Date.now
    /** @type {Map<string, number>} messageId → 见到的时刻 */
    this.seen = new Map()
  }

  /** 清掉过期条目。惰性清理，不做定时器。 */
  prune() {
    const cutoff = this.now() - this.ttlMs
    for (const [id, at] of this.seen) {
      if (at >= cutoff) break // Map 保持插入顺序，后面的只会更新
      this.seen.delete(id)
    }
    // 注意：容量裁剪要留出一个空位给**即将插入**的那条，
    // 否则插入后又会超一格（曾经就是这么少的）。
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
  }

  /**
   * 记一次「见到这条消息」。
   *
   * @param {string} messageId
   * @returns {boolean} true = 首次见到（应当处理）；false = 重复（应当丢弃）。
   */
  accept(messageId) {
    if (typeof messageId !== 'string' || !messageId) {
      // 没有 id 就无法去重。**当作首次见到**并放行——丢掉一条真消息，
      // 比冒着不收消息的风险更糟；SDK 保证入站消息总有 id。
      return true
    }
    this.prune()
    const previous = this.seen.get(messageId)
    if (previous !== undefined && this.now() - previous < this.ttlMs) return false
    this.seen.set(messageId, this.now())
    return true
  }

  /** 当前条目数（自检/测试用）。 */
  size() {
    return this.seen.size
  }
}

/**
 * 判定一条群聊消息是否「@了本机器人」——对齐 SDK 的 mentionGate 三信号判定：
 *   ① `rawEventType === 'GROUP_AT_MESSAGE_CREATE'`：QQ 平台权威信号，只在该用户
 *      真的 @了机器人时才投递此事件；
 *   ② `mentions[].is_you === true`：结构化 mention 列表里的服务端标记；
 *   ③ 内容里有 `<@!{appId}>` / `<@{appId}>`：自建/私有域机器人的兜底（可能只收
 *      GROUP_MESSAGE_CREATE 而不是 GROUP_AT_MESSAGE_CREATE）。
 *
 * @param {object} message SDK 入站消息（InboundMessage）。
 * @param {object} [config] 生效配置（含 bots / botId / appId，取当前 bot 的 appId）。
 * @returns {boolean}
 */
export function isGroupMention(message, config = {}) {
  if (message?.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  if (Array.isArray(message?.mentions) && message.mentions.some(m => m?.is_you === true)) return true
  // 内容兜底：用当前 bot 的 appId（多 Bot 先按 botId 找，找不到退回第一个）。
  const bot = Array.isArray(config.bots)
    ? (config.bots.find(b => b?.botId === config.botId) ?? config.bots[0])
    : undefined
  const appId = bot?.appId || config.appId
  const content = String(message?.content ?? '')
  if (appId && (content.includes(`<@!${appId}>`) || content.includes(`<@${appId}>`))) return true
  // ④ 内容以「@角色名」开头：QQ 面板里没把机器人显示成角色名时，用户打的「@江柚」
  // 只是纯文本、不会产生平台提到（无 GROUP_AT_MESSAGE_CREATE / is_you）。按人设名
  // 识别为「在对角色说话」。角色名候选由通道经 config.mentionNames 注入
  // （绑定 name / bot 别名 / bot 人设名），如 '@江柚 你好' / '@江柚在吗'。
  if (Array.isArray(config?.mentionNames) && config.mentionNames.length > 0) {
    const head = String(content).trimStart()
    return config.mentionNames.some(name => {
      const n = typeof name === 'string' ? name.trim() : ''
      return !!n && head.startsWith(`@${n}`)
    })
  }
  return false
}

/**
 * 判定一条入站消息该怎么路由。
 *
 * 纯函数：只读绑定表与配置，不碰宿主。
 *
 * @param {object} input
 * @param {object} input.message SDK 入站消息（`kind` / `senderId` / `content` / `messageId`）。
 * @param {import('./binding.js').BindingStore} input.bindings 绑定表。
 * @param {object} [input.config] 生效配置。
 * @param {boolean} [input.hasSessionLookup=true] 宿主是否支持「按 id 找到/恢复会话」。
 * @param {object} [input.willingness] 群聊意愿层适配器（`{ evaluate(input) }`）。
 *   不传 = 不做意愿判定（行为与加这层之前一致）。由 channel 注入，避免 inbound
 *   直接依赖状态存储（本模块保持「只读绑定表与配置」的纯函数定位）。
 * @returns {{
 *   action: 'deliver'|'create'|'ignore',
 *   conversationKey: string,
 *   sessionId?: string,
 *   reason?: string,
 *   binding?: object,
 * }}
 */
export function routeInbound({ message, bindings, config = {}, hasSessionLookup = true, willingness }) {
  const scope = message?.kind === 'group' ? 'group' : 'c2c'
  const peerId = scope === 'group'
    ? (message?.groupOpenid ?? message?.senderId)
    : message?.senderId

  if (typeof peerId !== 'string' || !peerId) {
    return { action: 'ignore', conversationKey: '', reason: 'no-peer-id' }
  }

  const conversationKey = `${scope}:${peerId}`

  // 群聊默认不收：我们的场景是「用户私聊角色」，群消息会把别处的话题灌进角色会话。
  // 要开是显式配置，不是默认行为。
  if (scope === 'group' && config?.group?.enabled !== true) {
    return { action: 'ignore', conversationKey, reason: 'group-disabled' }
  }

  // 白名单（per-bot）：配了 whitelist（openid 数组）且非空时，只有列表内的用户
  // 能与该机器人交互；不在列表的一律忽略（不注入、不建会话）。空数组 = 不限制。
  if (Array.isArray(config?.whitelist) && config.whitelist.length > 0
    && !config.whitelist.includes(peerId)) {
    return { action: 'ignore', conversationKey, reason: 'not-whitelisted' }
  }

  // 群聊 @门控：QQ 群消息鱼龙混杂，不 @ 机器人就回复会吵到所有人。
  // 判定对齐 SDK 的 mentionGate（GROUP_AT_MESSAGE_CREATE / mentions[].is_you /
  // 内容里的 <@!appId>）。`mentionOnly: false` 才放行所有群消息。
  const mentioned = scope === 'group' && isGroupMention(message, config)
  if (scope === 'group' && config?.group?.mentionOnly !== false && !mentioned) {
    return { action: 'ignore', conversationKey, reason: 'group-not-mentioned' }
  }

  /*
   * 群聊发言意愿与节流（`config.group.willingness`）。
   *
   * 关掉 `mentionOnly` 之后，群里**每条消息**都会触发一次完整主叙事回合
   * （上万 token）。这一层是纯算法判定：按累积意愿 + 阈值概率决定要不要回，
   * 并用最小回复间隔做硬冷却。被 @ 时强制通过。
   *
   * 只在群聊、且显式开启时生效——私聊回合与未开启的安装行为完全不变。
   */
  if (scope === 'group' && willingness) {
    const decision = willingness.evaluate({
      key: conversationKey,
      mentionedBot: mentioned,
      content: String(message?.content ?? ''),
      quotedBot: message?.quotedBot === true,
      messageCount: 1,
      now: typeof config?.now === 'number' ? config.now : Date.now(),
    })
    if (!decision.shouldCall) {
      return { action: 'ignore', conversationKey, reason: `group-willingness-${decision.reason}`, willingness: decision }
    }
  }

  // 多 Bot 场景下绑定键是复合键 `botId\0conversationKey`：不同 Bot 面对同一
  // openid 也是两条独立绑定（openid 虽独立，键仍带 botId，见 binding.js 说明）。
  // config.botId 由通道按「这条消息来自哪个 Bot」注入：精确命中就用它；
  // 精确没有时退回「任意 bot 的该 conversationKey」——绑定指向的是「和谁说话」
  // 的角色会话，换机器人不该把角色会话丢掉（会话真的不可恢复时由 no-agent 兜底重建）。
  const binding = bindings?.get(conversationKey, config?.botId)
    ?? (isNonEmptyString(config?.botId) ? bindings?.get(conversationKey) : undefined)
  if (binding?.sessionId) {
    // 有绑定就投递。**不按 botId 判「旧绑定」**：绑定指向的是「和谁说话」的
    // 会话，换机器人不该把角色会话丢掉——那条会话往往正是用户的角色
    // 预设会话（绑定的 name 就是角色名，例如「江柚」）。
    // 会话真的不可恢复时，由 handleInbound 的 resolveAgent 失败兜底重建（见 ③）。
    return { action: 'deliver', conversationKey, sessionId: binding.sessionId, binding }
  }

  // 没绑定时：允许自动新建才新建（群聊同样支持——被 @ 且未绑定时为该群建会话，
  // 一个群一个会话，群成员共用这个角色）。
  if (config?.autoCreateSession === true && (scope === 'c2c' || scope === 'group')) {
    return { action: 'create', conversationKey, reason: 'unbound-autocreate' }
  }

  return {
    action: 'ignore',
    conversationKey,
    reason: hasSessionLookup ? 'unbound' : 'unbound-no-controller',
  }
}

/**
 * 过滤图片/语音/文件等富文本标签，将它们转换为文本占位符（如 `[图片]`）。
 *
 * 必须在入站前清洗：这些标签通常带有 CDN 链接、`rkey` 签名、base64，
 * 若泄露进模型上下文，既消耗大量 token，又会被模型错误学习从而在回复中
 * 吐出损坏的链接标记。
 *
 * @param {string} text 原始文本。
 * @returns {string} 替换后的文本。
 */
export function sanitizeAttachments(text) {
  if (typeof text !== 'string' || !text) return ''
  return text
    .replace(/<(?:record|audio)\b[^>]*\/?>/gi, '[语音]')
    .replace(/<(?:img|image)\b[^>]*\/?>/gi, '[图片]')
    .replace(/<video\b[^>]*\/?>/gi, '[视频]')
    .replace(/<file\b[^>]*\/?>/gi, (match) => {
      const name = /(?:name|file|title)=["']([^"']+)["']/i.exec(match)?.[1]
      return name ? `[文件：${name}]` : '[文件]'
    })
    .replace(/<\/(?:file|img|image|audio|record|video)>/gi, '')
    .replace(/\[CQ:image,[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:record,[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:file,([^\]]*)\]/gi, (_match, attrs) => {
      const name = /(?:name|file)=([^,\]]+)/i.exec(attrs)?.[1]
      return name ? `[文件：${name}]` : '[文件]'
    })
}

/**
 * 把入站消息整理成注入 DSH 会话的正文。
 *
 * 为什么不原样注入 `msg.content`：群聊里 @机器人 会留下 `<@!xxx>` 之类的标记，
 * 直接给模型看是噪声。同时补一条极简的来源说明，让模型知道「这是聊天软件来的」。
 *
 * @param {object} message SDK 入站消息。
 * @param {object} [options]
 * @param {boolean} [options.includeSource=true] 是否加来源前缀。
 * @returns {string} 注入正文。
 */
export function renderInboundText(message, options = {}) {
  const raw = typeof message?.content === 'string' ? message.content : ''
  // 去掉 @ 提及标记（群聊的 <@!xxx> / <@xxx>，数字或 openid 都可能）与首尾空白。
  let cleaned = raw
    .replace(/<@!?[^\s>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 过滤 CDN 链接等媒体标签
  cleaned = sanitizeAttachments(cleaned)
  // QQ 原生表情是 `[face:14]` 这种标记，直接给模型看等于给一个它不认识的数字。
  // 翻成人话（[微笑]）才读得懂对方发了什么表情。
  cleaned = humanizeFaces(cleaned)
  // 只有表情、没有文字时也要注入——「对方只发了个表情」本身就是一条消息。
  // 但纯图片（无文字无 face）不在这里补文案：图片由收割路径单独处理。
  if (!cleaned) return ''
  if (options.includeSource === false) return cleaned
  // 昵称缺失时**不能**退化成「对方」：群聊里多个人共用一个称呼，模型无法区分
  // 谁是谁，也就无法维持「A 说过什么、B 说过什么」——这正是「群聊不认识人」的
  // 直接症状。用 openid 尾部几位造一个稳定、可区分的称呼兜底。
  // （正常路径上 senderName 已由 normalize.js 归一填好，这里是双保险。）
  const isGroup = message?.kind === 'group'
  const name = typeof message?.senderName === 'string' && message.senderName.trim()
    ? message.senderName.trim()
    : (fallbackSenderName(message?.senderId, isGroup) || '对方')
  // 群聊标注来源为「QQ 群」，让模型知道这条消息来自群聊（一个群共用一个角色会话）。
  const source = isGroup ? '来自 QQ 群' : '来自 QQ'
  return `${name}（${source}）：${cleaned}`
}

/**
 * 处理一条入站消息的完整流程（幂等 → 路由 → 交给宿主注入）。
 *
 * @param {object} options
 * @param {object} options.message SDK 入站消息。
 * @param {DedupeWindow} options.dedupe 去重窗口。
 * @param {import('./binding.js').BindingStore} options.bindings 绑定表。
 * @param {object} [options.config] 生效配置。
 * @param {(sessionId: string) => Promise<object|undefined>} [options.resolveAgent]
 *   按会话 id 找到/恢复 agent。不支持时传 undefined。
 * @param {(conversationKey: string, message: object) => Promise<string|undefined>} [options.createSession]
 *   为未绑定会话新建 DSH 会话，返回新 sessionId。
 * @param {(agent: object, text: string, message: object) => boolean|Promise<boolean>} [options.inject]
 *   把正文注入会话。
 * @param {(level: string, text: string) => void} [options.log] 日志回调。
 * @returns {Promise<{status: string, conversationKey?: string, sessionId?: string, reason?: string}>}
 */
export async function handleInbound(options) {
  const {
    message, dedupe, bindings, config = {}, resolveAgent, createSession, inject, log, willingness,
  } = options
  const say = typeof log === 'function' ? log : () => {}

  // ① 幂等：重连造成的重复回调在这里被挡住。
  if (!dedupe.accept(message?.messageId)) {
    return { status: 'duplicate', reason: 'duplicate-message' }
  }

  const route = routeInbound({
    message,
    bindings,
    config,
    hasSessionLookup: typeof resolveAgent === 'function',
    willingness,
  })

  if (route.action === 'ignore') {
    say('debug', `忽略入站消息（${route.reason}）：${route.conversationKey || '未知来源'}`)
    return { status: 'ignored', conversationKey: route.conversationKey, reason: route.reason }
  }

  const text = renderInboundText(message, { includeSource: config.inboundPrefix !== false })
  if (!text) {
    say('debug', '忽略入站消息：内容为空')
    return { status: 'ignored', conversationKey: route.conversationKey, reason: 'empty-content' }
  }

  let sessionId = route.sessionId
  let agent

  // ② 未绑定 → 新建会话（只有配置允许时才会走到这里）。
  if (route.action === 'create') {
    if (typeof createSession !== 'function') {
      say('warn', `收到未绑定会话的消息但宿主不支持新建会话：${route.conversationKey}`)
      return { status: 'ignored', conversationKey: route.conversationKey, reason: 'no-session-factory' }
    }
    try {
      sessionId = await createSession(route.conversationKey, message)
    } catch (error) {
      say('warn', `新建会话失败（${route.conversationKey}）：${error?.message ?? String(error)}`)
      return { status: 'error', conversationKey: route.conversationKey, reason: 'create-failed' }
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      say('warn', `新建会话没有返回 sessionId：${route.conversationKey}`)
      return { status: 'error', conversationKey: route.conversationKey, reason: 'create-failed' }
    }
    try {
      bindings.set({ conversationKey: route.conversationKey, sessionId, botId: config.botId })
      say('info', `已为 ${route.conversationKey} 自动新建并绑定会话 ${sessionId}`)
    } catch (error) {
      say('warn', `绑定写入失败：${error?.message ?? String(error)}`)
    }
    // 新建出来的会话由调用方的 createSession 负责把首条消息带进去，
    // 这里直接返回，避免同一条消息被注入两次。
    // 状态用 'created' 还是 'delivered' 由调用决定：**都要记入站时间**，
    // 否则交互式回复的 requireInbound 判定（「该会话从 QQ 收过消息」）
    // 永远不成立，角色回复发不回 QQ。
    return { status: 'delivered', conversationKey: route.conversationKey, sessionId }
  }

  // ③ 路由到已有会话。
  if (typeof resolveAgent === 'function') {
    try {
      agent = await resolveAgent(sessionId)
    } catch (error) {
      say('warn', `恢复会话 ${sessionId} 失败：${error?.message ?? String(error)}`)
    }
  }
  if (!agent) {
    // 绑定存在但会话恢复不了（换机器人/旧会话被清/宿主找不到）：
    // 若允许自动建会话，删掉这条失效绑定、重建一个新会话，把消息接住；
    // 否则如实报错（前端「最近入站」会显示 no-agent，指明这个会话救不活）。
    if (config?.autoCreateSession === true && route.conversationKey && typeof createSession === 'function') {
      say('warn', `会话 ${sessionId} 不可恢复，删除旧绑定并为 ${route.conversationKey} 重建…`)
      try { bindings?.remove?.(route.conversationKey, config?.botId) } catch { /* 删不掉也要继续 */ }
      try {
        const fresh = await createSession(route.conversationKey, message)
        if (typeof fresh !== 'string' || !fresh) {
          say('warn', `重建会话失败（${route.conversationKey}）：没有返回 sessionId`)
          return { status: 'error', conversationKey: route.conversationKey, sessionId, reason: 'no-agent' }
        }
        try {
          bindings.set({ conversationKey: route.conversationKey, sessionId: fresh, botId: config.botId })
          say('info', `已为 ${route.conversationKey} 重建并绑定会话 ${fresh}`)
        } catch (error) {
          say('warn', `重建后绑定写入失败：${error?.message ?? String(error)}`)
        }
        // createSession 负责把首条消息带进去；这里按已投递记（同新建分支）。
        return { status: 'delivered', conversationKey: route.conversationKey, sessionId: fresh }
      } catch (error) {
        say('warn', `重建会话失败（${route.conversationKey}）：${error?.message ?? String(error)}`)
        return { status: 'error', conversationKey: route.conversationKey, sessionId, reason: 'recreate-failed' }
      }
    }
    say('warn', `找不到会话 ${sessionId}，消息未送达：${route.conversationKey}`)
    return { status: 'error', conversationKey: route.conversationKey, sessionId, reason: 'no-agent' }
  }

  if (typeof inject !== 'function') {
    return { status: 'error', conversationKey: route.conversationKey, sessionId, reason: 'no-inject' }
  }
  try {
    await inject(agent, text, message)
  } catch (error) {
    say('warn', `注入会话 ${sessionId} 失败：${error?.message ?? String(error)}`)
    return { status: 'error', conversationKey: route.conversationKey, sessionId, reason: 'inject-failed' }
  }

  return { status: 'delivered', conversationKey: route.conversationKey, sessionId }
}

/** 默认 TTL / 容量，供外部构造时引用。 */
export const DEDUPE_DEFAULTS = { ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES }

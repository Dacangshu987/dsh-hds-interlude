/**
 * 通道配置归一。
 *
 * 配置的**声明**在宿主的 `../schema.js`（`Im` 块）——那是唯一的事实来源，
 * 用户在设置界面看到的就是它。本模块只做一件事：把 Schemastery 处理过的
 * 配置**防御性归一**，让通道内部可以无条件信任字段存在。
 *
 * 为什么不在这里再声明一遍 Schema：两份声明必然会漂移，
 * 而漂移的表现是「设置界面里改了不生效」，最难查的那类问题。
 *
 * ## 多 Bot（v2）
 *
 * 配置形态与 dsh-im 对齐：`bots: [{botId, appId, secretRef, alias}]`。
 *   - `botId` / `secretRef` 由 appId 派生（`qq_<sha256前24位>` /
 *     `DSH_QQBOT_APP_SECRET_<大写>`），用户不必起名；
 *   - 顶层 `appId` / `botId` / `secretRef` 保留为**兼容字段**：`bots` 为空且
 *     顶层 `appId` 非空时，自动归一成单条 bots（旧配置一个字段都不用改）。
 *
 * @module dsh-hds-interlude/qq-im/config
 */

import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { defaultStickerDir } from './sticker-store.js'

/**
 * 从 appId 派生 bot 身份（对齐 dsh-im 的 `deriveQqBotIdentity`）。
 *
 * @param {string} appId QQ 开放平台 AppID。
 * @returns {{botId: string, secretRef: string}|undefined} appId 为空时返回 undefined。
 */
export function deriveBotIdentity(appId) {
  const raw = typeof appId === 'string' ? appId.trim() : ''
  if (!raw) return undefined
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24)
  return {
    botId: `qq_${digest}`,
    secretRef: `DSH_QQBOT_APP_SECRET_${digest.toUpperCase()}`,
  }
}

/**
 * 归一一条 bot 配置：缺省字段用派生值补齐；整条无用（无 appId 且无 botId）丢弃。
 *
 * 注意**不用展开运算符透传**（`{...entry}`）：`undefined` 字段混入会让
 * 下游判定误以为「字段缺失」，反而丢配置。
 *
 * @param {object} entry 原始 bot 条目。
 * @returns {{botId: string, appId: string, secretRef: string, alias: string, agentPreset: string, story?: object}|undefined}
 */
export function normalizeBotEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const appId = nonEmpty(entry.appId, '')
  const derived = appId ? deriveBotIdentity(appId) : undefined
  const botId = nonEmpty(entry.botId, '') || derived?.botId || ''
  const secretRef = nonEmpty(entry.secretRef, '') || derived?.secretRef || ''
  // 什么都没有的条目没有意义：既不能派生也没法用。
  if (!appId && !botId) return undefined
  const out = {
    botId,
    appId,
    secretRef: secretRef || 'DSH_QQBOT_APP_SECRET',
    alias: nonEmpty(entry.alias, ''),
    // per-bot 角色：该 bot 自动建会话的默认预设 + 独立人设（缺省继承全局）。
    agentPreset: nonEmpty(entry.agentPreset, ''),
    // per-bot 会话存放工作区（缺省继承全局 im.cwd）。
    cwd: nonEmpty(entry.cwd, ''),
    // per-bot 白名单用户（openid 数组；空 = 不限制）。
    whitelist: Array.isArray(entry.whitelist)
      ? entry.whitelist.map(item => nonEmpty(item, '')).filter(Boolean)
      : [],
    // per-bot 机器人命令开关（缺省开；全局 im.botCommands 也要开）。
    botCommands: entry.botCommands !== false,
  }
  const story = entry.story
  if (story && typeof story === 'object' && !Array.isArray(story)) out.story = story
  return out
}

/**
 * 解析生效的通道配置（缺省合并默认值）。
 *
 * @param {object} [config] 宿主传入的 `config.im`（扁平 im 块）。
 * @returns {object} 归一后的通道配置。
 */
export function resolveConfig(config = {}) {
  const source = config ?? {}
  const dedupe = source.dedupe ?? {}
  const chunking = source.chunking ?? {}
  const interactive = source.interactive ?? {}
  const proactive = source.proactive ?? {}
  const group = source.group ?? {}

  /* ------------------------------------------------ bots 归一（多 Bot 核心） */

  // ① 显式 bots 数组：逐条归一。
  let bots = Array.isArray(source.bots)
    ? source.bots.map(normalizeBotEntry).filter(Boolean)
    : []

  // ② 向后兼容：bots 为空但顶层 appId 非空 → 合成单条。
  if (bots.length === 0 && nonEmpty(source.appId, '')) {
    const derived = deriveBotIdentity(source.appId)
    bots = [{
      botId: nonEmpty(source.botId, '') || derived?.botId || 'qq',
      appId: nonEmpty(source.appId, ''),
      secretRef: nonEmpty(source.secretRef, '') || derived?.secretRef || 'DSH_QQBOT_APP_SECRET',
      alias: nonEmpty(source.alias, ''),
    }]
  }

  // ③ 去重：botId / appId / secretRef 各自唯一（对齐 dsh-im 的 normalizeDocument）。
  // 重复只保留第一条，静默去重（配置页已经是列表编辑，重复多是手工改出来的）。
  {
    const seenBotId = new Set()
    const seenAppId = new Set()
    const seenRef = new Set()
    bots = bots.filter(bot => {
      if (seenBotId.has(bot.botId) || seenAppId.has(bot.appId) || seenRef.has(bot.secretRef)) return false
      seenBotId.add(bot.botId)
      seenAppId.add(bot.appId)
      seenRef.add(bot.secretRef)
      return true
    })
  }

  return {
    enabled: source.enabled !== false,
    // 顶层兼容字段：bots 有内容时以第一条为准（旧调用点仍读这些字段）。
    botId: bots[0]?.botId ?? nonEmpty(source.botId, 'qq'),
    appId: bots[0]?.appId ?? nonEmpty(source.appId, ''),
    secretRef: bots[0]?.secretRef ?? nonEmpty(source.secretRef, 'DSH_QQBOT_APP_SECRET'),
    alias: bots[0]?.alias ?? nonEmpty(source.alias, ''),
    bots,
    markdownSupport: source.markdownSupport === true,
    // QQ 用户端机器人命令（/help /status /new /session /sessionlist），默认开。
    botCommands: source.botCommands !== false,
    // 默认不占用 dshIm 服务名——理由见 index.js 里那段线上事故复盘。
    exposeService: source.exposeService === true,
    // 白名单式判定：任何非 'loose' 的值都按 'strict' 处理。
    // 「配置写错时选更安全的那个」——泄漏是不可逆的，少说一句话是可逆的。
    sayFallback: source.sayFallback === 'loose' ? 'loose' : 'strict',
    sayTool: nonEmpty(source.sayTool, 'interlude_say'),
    imageTool: nonEmpty(source.imageTool, 'interlude_send_image'),
    // 默认开：发表情包是角色表达力的一部分。关掉后收集阶段就会忽略发图调用。
    imagesEnabled: source.imagesEnabled !== false,
    // 表情库目录：留空用默认目录（~/.dsh/media/stickers/）。
    // 解析成绝对路径——相对路径会随进程 cwd 漂移，那是「昨天还能发、今天就找不到」的经典成因。
    stickerDir: resolveStickerDir(source.stickerDir),
    // 用户发来的表情包自动落盘（QQ 图片 URL 会过期，不落盘就复用不了）。
    harvestInbound: source.harvestInbound !== false,
    // QQ 原生 face（[face:14]）双向适配。关掉后 face 会原样透传。
    faceEnabled: source.faceEnabled !== false,
    autoCreateSession: source.autoCreateSession !== false,
    // 新建会话时使用的角色预设 id/名。留空则按绑定里的角色名匹配同名预设。
    agentPreset: nonEmpty(source.agentPreset, ''),
    // 新建会话的工作目录。留空则跟随宿主最近活跃会话的目录（见 channel.js）。
    cwd: nonEmpty(source.cwd, ''),
    migrateLegacyBindings: source.migrateLegacyBindings !== false,
    inboundPrefix: source.inboundPrefix !== false,
    dedupe: {
      ttlMinutes: clampNumber(dedupe.ttlMinutes, 1, 1440, 10),
      maxEntries: clampNumber(dedupe.maxEntries, 10, 100_000, 2000),
    },
    chunking: {
      enabled: chunking.enabled !== false,
      maxChars: clampNumber(chunking.maxChars, 1, 500, 40),
      maxMessages: clampNumber(chunking.maxMessages, 1, 10, 4),
      minIntervalMs: clampNumber(chunking.minIntervalMs, 0, 10_000, 400),
    },
    timeoutMs: clampNumber(source.timeoutMs, 1000, 120_000, 15_000),
    interactive: {
      enabled: interactive.enabled !== false,
      requireInbound: interactive.requireInbound !== false,
      replyWindowMinutes: clampNumber(interactive.replyWindowMinutes, 1, 1440, 30),
    },
    proactive: {
      maxPerDay: clampNumber(proactive.maxPerDay, 1, 200, 30),
      minIntervalMinutes: clampNumber(proactive.minIntervalMinutes, 0, 1440, 1),
    },
    group: { enabled: group.enabled === true, mentionOnly: group.mentionOnly !== false },
    logLevel: ['debug', 'info', 'warn', 'error'].includes(source.logLevel) ? source.logLevel : 'info',
  }
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * 解析表情库目录。
 *
 * 留空 → 默认目录（`~/.dsh/media/stickers/`）。
 * 给了相对路径 → 相对**用户主目录**解析，而不是进程 cwd。
 *
 * 为什么不用 cwd：DSH 的工作目录会随打开的 workspace 变，而表情包是跨项目的
 * 资产。跟着 cwd 走的表现是「在 A 项目能发表情、切到 B 项目就找不到了」，
 * 而且排查时极难意识到是路径基准变了。
 */
function resolveStickerDir(value) {
  const raw = nonEmpty(value, '')
  if (!raw) return defaultStickerDir()
  try {
    // 相对路径以用户主目录为基准（而不是 process.cwd()）。
    // path.resolve 对绝对路径会原样返回，所以两种形态都正确。
    return path.resolve(os.homedir(), raw)
  } catch {
    return defaultStickerDir()
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

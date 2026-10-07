/**
 * QQ 通道 —— **唯一**接触腾讯 SDK 的文件。
 *
 * 为什么集中在一个文件：协议归 SDK（腾讯官方维护），我们只写「接线 + 我们自己的
 * 语义」。将来换渠道（或 SDK 破坏性升级）只改这一个文件，其余模块不感知协议。
 *
 * ## SDK 事实（出自 `@tencent-connect/qqbot-nodejs@1.0.4` 的 USAGE.md）
 *
 * - **纯协议层，不携带业务概念**，定位与 `@line/bot-sdk` 一致；
 * - token 自动获取/缓存/提前 5 分钟刷新，**不需要也不应自行处理**；
 * - `replyTarget` 由 SDK 自动派生；`msgId` 存在 = 被动回复，不存在 = 主动推送；
 * - 支持外部 `AbortSignal` 优雅退出、`sessionPersistence` 跨进程恢复；
 * - 明确提示：**业务侧自己做幂等**，重连可能导致同一条消息重复回调
 *   （这一条由 inbound.js 的 DedupeWindow 负责）；
 * - 断线重连、退避序列、token 失效处理**都在 SDK 内部**，我们不做重连逻辑。
 *
 * 凭据（appId / appSecret）在构造时传入，SDK **从不读环境变量**。
 * 我们这边通过 `ctx.credentials` 解析引用，值不进配置文件。
 *
 * @module dsh-hds-interlude/qq-im/qq
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeImageSource } from './outbound.js'
import { normalizeInboundMessage } from './normalize.js'

/**
 * 把 SDK 的错误翻译成我们自己的错误类型。
 *
 * 为什么要翻译：上层只想知道「该不该重试」「是不是凭据坏了」，
 * 不想依赖 `ApiError` 的具体字段形状——那是 SDK 的私有细节，
 * 升级时可能变。翻译层让上层与 SDK 类型解耦。
 */
export class QqChannelError extends Error {
  /**
   * @param {string} message 人类可读的错误说明。
   * @param {object} [details]
   * @param {string} [details.code] 我们自己的错误码。
   * @param {number} [details.httpStatus] HTTP 状态码（0 = 网络错误/超时）。
   * @param {number} [details.bizCode] QQ 业务错误码。
   * @param {boolean} [details.retryable] 是否值得重试。
   * @param {unknown} [details.cause] 原始错误。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'QqChannelError'
    this.code = details.code ?? 'qq-error'
    this.httpStatus = details.httpStatus ?? 0
    this.bizCode = details.bizCode
    this.retryable = details.retryable ?? false
    this.cause = details.cause
  }
}

/** 凭据缺失/无效——不可重试，必须人工修复。 */
export class QqCredentialError extends QqChannelError {
  constructor(message, details = {}) {
    super(message, { code: 'qq-credentials', retryable: false, ...details })
    this.name = 'QqCredentialError'
  }
}

/**
 * 判断一个 SDK 抛出的错误该不该重试。
 *
 * 判据：
 *   - 网络层（httpStatus 0）与 5xx → 重试；
 *   - 429（限流）→ 重试（但要退避）；
 *   - 401/403 与凭据类业务码 → **不**重试，重试一万次也还是错；
 *   - 其余 4xx（参数/权限类）→ 不重试。
 */
export function classifySdkError(error) {
  const httpStatus = Number(error?.httpStatus ?? 0)
  const bizCode = error?.bizCode

  // 凭据类：AppSecret 错、token 拿不到。
  if (httpStatus === 401 || httpStatus === 403) {
    return new QqCredentialError(`QQ 凭据被拒绝（HTTP ${httpStatus}）：${error?.bizMessage ?? error?.message ?? ''}`, {
      httpStatus, bizCode, cause: error,
    })
  }
  const retryable = httpStatus === 0 || httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600)
  return new QqChannelError(
    `QQ 接口调用失败（HTTP ${httpStatus}${bizCode ? ` / code ${bizCode}` : ''}）：${error?.bizMessage ?? error?.message ?? ''}`,
    { httpStatus, bizCode, retryable, cause: error },
  )
}

/**
 * 一个 QQ 机器人连接。
 *
 * 生命周期：`start()` 阻塞直到 `stop()` 或 signal 中止（SDK 语义），
 * 所以调用方**不要 await 它**——应当在后台跑，并用 `stop()` 收尾。
 */
export class QqChannel {
  /**
   * @param {object} options
   * @param {string} options.appId QQ 开放平台 AppID。
   * @param {string} options.appSecret AppSecret（已解析出的值，不落盘）。
   * @param {string} [options.accountId] 稳定标识（日志/会话持久化用）。
   * @param {boolean} [options.markdownSupport=false] 是否有 markdown 权限。
   * @param {object} [options.logger] SDK logger（{info,error,warn,debug}）。
   * @param {Function} [options.QQBotClass] 注入 SDK 类（测试用，避免真连网）。
   * @param {object} [options.sessionPersistence] 跨进程恢复 session 的钩子。
   */
  constructor(options) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.accountId = options.accountId ?? options.appId
    this.markdownSupport = options.markdownSupport === true
    this.logger = options.logger
    this.QQBotClass = options.QQBotClass
    this.sessionPersistence = options.sessionPersistence

    /** @type {object|undefined} SDK 实例 */
    this.bot = undefined
    /** 消息处理器：`(message) => void|Promise<void>` */
    this.handler = undefined
    this.abort = undefined
    this.started = false
    this.ready = false
    /** 最近一次连接错误（供自检展示）。 */
    this.lastError = null
    /** 当前 start() 运行的 Promise；restart() 用它等待旧连接完全退出。 */
    this._run = null
  }

  /** 懒加载官方 SDK。放在函数里是为了让没装 SDK 时的报错可读。 */
  async loadSdk() {
    if (this.QQBotClass) return this.QQBotClass
    try {
      const mod = await import('@tencent-connect/qqbot-nodejs')
      return mod.QQBot
    } catch (error) {
      throw new QqChannelError(
        `无法加载 @tencent-connect/qqbot-nodejs：${error?.message ?? String(error)}。请先安装该依赖。`,
        { code: 'qq-sdk-missing', retryable: false, cause: error },
      )
    }
  }

  /**
   * 注册入站消息处理器。**只保留一个**——多个处理器会让消息被处理多次。
   * @param {(message: object) => void|Promise<void>} handler
   */
  onMessage(handler) {
    this.handler = handler
  }

  /**
   * 建立连接并开始收事件。**返回的 Promise 会一直挂着**（SDK 语义），
   * 调用方应当 `void channel.start()` 而不是 `await`。
   *
   * 幂等：已在跑时直接返回现有 run（不重复建连）。
   *
   * @param {AbortSignal} [signal] 外部中止信号。
   * @returns {Promise<void>} 连接生命周期结束（stop / 出错退出）时 resolve。
   */
  start(signal) {
    if (this._run) return this._run

    const run = (async () => {
      const QQBotClass = await this.loadSdk()
      const bot = new QQBotClass({
        appId: this.appId,
        appSecret: this.appSecret,
        accountId: this.accountId,
        markdownSupport: this.markdownSupport,
        ...this.logger ? { logger: this.logger } : {},
        ...this.sessionPersistence ? { sessionPersistence: this.sessionPersistence } : {},
      })

      bot.on('ready', () => {
        this.ready = true
        this.lastError = null
      })
      bot.on('resumed', () => {
        this.ready = true
        this.lastError = null
      })
      bot.on('error', (error) => {
        this.lastError = error?.message ?? String(error)
        // SDK 的 WS 会内部重连；这里只记录错误供自检，不打断循环。
      })
      bot.on('message', async (_ctx, message) => {
        // handler 抛错不该让 SDK 的 WS 循环受影响；这里兜住并记日志。
        try {
          // **必须先归一**：SDK 原始事件是 `{ author: { member_openid, username? } }`，
          // 而内部契约是扁平的 `{ senderId, senderName, ... }`。早先原样透传导致
          // `senderName` 永远是 undefined —— 群聊里每个人都渲染成「对方」，
          // 角色因此「不认识人」（详见 normalize.js 的说明）。
          const normalized = normalizeInboundMessage(message, { botSelfId: this.accountId })
          if (!normalized) {
            this.logger?.debug?.(`忽略无法识别的入站事件：${String(message?.id ?? '?')}`)
            return
          }
          // 机器人自己发的消息不是"用户说话"，直接丢——否则会自我循环。
          if (normalized.fromSelf) {
            this.logger?.debug?.('忽略自己发出的消息')
            return
          }
          await this.handler?.(normalized)
        } catch (error) {
          this.logger?.error?.(`处理入站 QQ 消息失败：${error?.message ?? String(error)}`)
        }
      })

      this.bot = bot
      this.abort = new AbortController()
      this.started = true

      // 把外部 signal 接到我们自己的 controller 上。
      if (signal) {
        if (signal.aborted) this.abort.abort()
        else signal.addEventListener('abort', () => this.abort.abort(), { once: true })
      }

      try {
        await bot.start(this.abort.signal)
      } finally {
        // 只有「当前 run」才有权复位状态——restart() 等待旧 run 结束后
        // 会启动新 run；旧 run 的 finally 若又复位 started/ready，
        // 会把新连接的标志清掉（「连接中」卡的根因之一）。
        if (this._run === run) {
          this.bot = undefined
          this.started = false
          this.ready = false
        }
      }
    })()

    this._run = run
    // 生命周期结束即清引用；reject 也得清，否则 restart() 里 await 会一直等。
    run.then(
      () => { if (this._run === run) this._run = null },
      () => { if (this._run === run) this._run = null },
    )
    return run
  }

  /**
   * 停止当前连接。
   *
   * **不**复位 `started`/`ready`——那些由 start() 的 finally 在旧连接真正退出时
   * 复位。先复位会让 restart() 与旧连接产生竞态（新连接建一半，旧的 finally
   * 把标志清掉）。
   */
  stop() {
    try { this.abort?.abort() } catch { /* 已中止 */ }
    try { this.bot?.stop?.() } catch { /* SDK 未就绪 */ }
  }

  /**
   * 停掉旧连接并等它完全退出，再起新连接（换凭据/换配置后重连用）。
   *
   * 之前 channel.js 是「stop() → 等 50ms → start()」，没等旧连接退出；
   * 旧 start 的 finally 会把新连接的 started 清掉，新连接半途而废，
   * 表现就是「扫码后一直连接中，永不 READY」。
   *
   * @param {AbortSignal} [signal] 传给新连接。
   * @returns {Promise<void>} 新连接生命周期结束才 resolve（SDK 语义）。
   */
  async restart(signal) {
    const previous = this._run
    this.stop()
    if (previous) {
      try { await previous } catch { /* 旧连接退出时的错误不算新连接的 */ }
    }
    // 旧 run 的 finally 已跑完（或本就没在跑），现在 started/ready 是干净的。
    return this.start(signal)
  }

  /**
   * 发送一条**主动**文本消息（无 msgId = 主动推送）。
   *
   * 返回 `{ sent: true }` 才表示确认送达——上层据此记账，不接受「静默成功」。
   *
   * @param {string} targetId 用户 openid。
   * @param {string} text 消息正文。
   * @returns {Promise<{sent: boolean, id?: string}>}
   */
  async sendText(targetId, text) {
    if (!this.bot) {
      throw new QqChannelError('QQ 连接尚未启动，无法发送消息。', { code: 'qq-not-started', retryable: true })
    }
    if (typeof targetId !== 'string' || !targetId) {
      throw new QqChannelError('投递目标为空。', { code: 'qq-no-target', retryable: false })
    }
    // 刻意**不传 msgId**：那是被动回复路径（5 分钟窗口内的关联回复）。
    // 主动投递就是要走主动消息路径。
    const target = { scope: this.scopeOf(targetId), targetId: this.peerIdOf(targetId) }
    try {
      const response = await this.bot.sendText(target, String(text ?? ''))
      return { sent: true, id: response?.id }
    } catch (error) {
      throw classifySdkError(error)
    }
  }

  /**
   * 发送一条关联入站消息的回复（有 msgId = 被动回复）。
   *
   * 为什么单列一个方法：交互式回复（用户在 DSH 界面说话、角色回到 QQ）
   * 发生在收到消息之后不久，属于被动回复，**不消耗主动消息额度**。
   * 与主动投递混用一个方法会让额度被无谓地吃掉。
   */
  async replyText(targetId, text, msgId, scope = 'c2c') {
    if (!this.bot) {
      throw new QqChannelError('QQ 连接尚未启动，无法发送消息。', { code: 'qq-not-started', retryable: true })
    }
    try {
      const response = await this.bot.sendText({ scope, targetId, ...msgId ? { msgId } : {} }, String(text ?? ''))
      return { sent: true, id: response?.id }
    } catch (error) {
      throw classifySdkError(error)
    }
  }

  /**
   * 发送一张图片（上传 + 投递，走 SDK 的 sendImage）。
   *
   * 支持两种来源，与 SDK 的 `uploadMedia` 对齐：
   *   - `{ localPath }` —— 本地文件路径；
   *   - `{ url }`       —— http(s) 网络地址（由 QQ 服务器拉取）。
   *
   * 与文本路径一样**返回 `{ sent: true }` 才算送达**：SDK 抛错就直接抛给
   * deliverMessages 的 try/catch，由它决定降级还是整轮失败。
   *
   * @param {string} targetId 用户 openid（可带 `group:` 前缀）。
   * @param {{url?: string, localPath?: string}} source 图片来源。
   * @returns {Promise<{sent: boolean, id?: string}>}
   */
  async sendImage(targetId, source) {
    if (!this.bot) {
      throw new QqChannelError('QQ 连接尚未启动，无法发送图片。', { code: 'qq-not-started', retryable: true })
    }
    if (typeof targetId !== 'string' || !targetId) {
      throw new QqChannelError('投递目标为空。', { code: 'qq-no-target', retryable: false })
    }
    const meta = normalizeImageSource(source)
    if (!meta) {
      throw new QqChannelError('图片来源非法（只接受 http(s) URL 或本地路径）。', { code: 'qq-bad-image-source', retryable: false })
    }
    if (!meta.url && !fs.existsSync(meta.localPath)) {
      throw new QqChannelError(`图片文件不存在：${meta.localPath}`, { code: 'qq-image-not-found', retryable: false })
    }
    // SDK 未暴露 sendImage 时（旧版本/替身）如实报错，而不是静默当成发送成功。
    if (typeof this.bot.sendImage !== 'function') {
      throw new QqChannelError('当前 QQ SDK 不支持发送图片（缺少 sendImage）。', { code: 'qq-image-unsupported', retryable: false })
    }
    const target = { scope: this.scopeOf(targetId), targetId: this.peerIdOf(targetId) }
    try {
      const response = await this.bot.sendImage(target, meta)
      return { sent: true, id: response?.message?.id ?? response?.id }
    } catch (error) {
      throw classifySdkError(error)
    }
  }

  /** 连接状态自检（供 `/qqim status`）。 */
  status() {
    return {
      started: this.started,
      ready: this.ready,
      appId: this.appId,
      accountId: this.accountId,
      lastError: this.lastError,
    }
  }

  /** 投递目标里可能带 scope 前缀（`group:xxx`），解出来。 */
  scopeOf(targetId) {
    return typeof targetId === 'string' && targetId.startsWith('group:') ? 'group' : 'c2c'
  }

  /** 剥掉 scope 前缀，取真正的 openid。 */
  peerIdOf(targetId) {
    return typeof targetId === 'string' && targetId.startsWith('group:')
      ? targetId.slice('group:'.length)
      : targetId
  }
}

/**
 * 从凭据服务解析 QQ AppSecret。
 *
 * **不缓存值**：凭据服务的设计意图就是「每次操作解析一次，轮换后下一个操作即生效，
 * 无需重启」。把 secret 缓存在内存里会把这个特性弄丢，也延长了它停留在进程里的时间。
 *
 * @param {object} ctx Cordis 上下文（需有 `credentials`）。
 * @param {string} ref 环境变量名形式的凭据引用（如 `DSH_QQBOT_APP_SECRET_XXX`）。
 * @returns {Promise<string>} 解析出的 secret。
 * @throws {QqCredentialError} 凭据服务不可用或引用未配置时。
 */
export async function resolveSecret(ctx, ref) {
  if (typeof ref !== 'string' || !ref) {
    throw new QqCredentialError('未配置 AppSecret 的凭据引用。')
  }
  let credentials
  try {
    // 用 ctx.get('credentials') 而不是 ctx.credentials：
    // 本插件不在 inject 里声明 credentials（精简 profile 兼容点），
    // 属性访问会抛错；ctx.get() 对未注册名字返回 undefined。
    // （线上事故：凭据服务「看似可用、实则取不到」，AppSecret 没写进
    //   .credentials.yaml，重连读不到 → QQ 一直连接中。）
    credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials
  } catch {
    credentials = undefined
  }
  if (!credentials || typeof credentials.resolve !== 'function') {
    // 凭据服务不在时，退回读进程环境变量；再没有就直读 DSH 的凭据文件
    // `$DSH_HOME/.credentials.yaml`（标准的凭据落盘位置）——实测凭据已写在
    // 文件里、但凭据服务在该时刻未注册时，不兜底会让机器人一直红点
    // 「凭据服务不可用，且环境变量未设置」，而凭据明明在。
    const fromEnv = process.env[ref]
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv
    const fromFile = readSecretFromCredentialsFile(ref)
    if (fromFile) return fromFile
    throw new QqCredentialError(`凭据服务不可用，且环境变量与 ${ref} 凭据文件均未找到。`)
  }

  let hit
  try {
    // 引用必须符合 POSIX 标识符grammar，否则凭据服务会抛错。
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    hit = await credentials.resolve(credentialRef(ref))
  } catch (error) {
    // 动态导入失败（精简 profile 没装该包）时，用裸字符串再试一次。
    try {
      hit = await credentials.resolve(ref)
    } catch {
      throw new QqCredentialError(`解析凭据 ${ref} 失败：${error?.message ?? String(error)}`, { cause: error })
    }
  }
  if (!hit || typeof hit.value !== 'string' || !hit.value) {
    // 凭据服务说「没有」——最后的兜底同样是直读凭据文件（覆盖服务临时故障）。
    const fromFile = readSecretFromCredentialsFile(ref)
    if (fromFile) return fromFile
    throw new QqCredentialError(`凭据 ${ref} 未配置（或为空值）。请在设置里填入 AppSecret。`)
  }
  return hit.value
}

/**
 * 直读 `$DSH_HOME/.credentials.yaml` 里的一个凭据引用（兜底，只读）。
 *
 * 为什么需要：凭据服务（dsh-credentials）在插件启动/扫码落地后的某个窗口可能
 * 尚未注册或 resolve 失败，但 `.credentials.yaml` 里已经有值——此时不兜底，
 * 机器人会一直红点「凭据服务不可用」，而凭据明明在文件里。
 *
 * 实现是**粗略的 yaml 行匹配**：只认 `  <REF>: <值>` 形式的单行标量，
 * 失败一律返回 undefined（安静退化，绝不让插件的凭据解析抛线外错误）。
 */
function readSecretFromCredentialsFile(ref) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const file = path.join(home, '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf8')
    const pattern = new RegExp(`^\\s*${ref}:\\s*(.+?)\\s*$`, 'm')
    const match = pattern.exec(text)
    if (!match?.[1]) return undefined
    const value = match[1].trim()
    // 去一对引号外壳（yaml 单/双引号）。
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      return value.slice(1, -1)
    }
    return value || undefined
  } catch {
    return undefined
  }
}

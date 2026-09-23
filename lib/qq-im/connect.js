/**
 * QQ 机器人扫码绑定（provisioning）管理器。
 *
 * 复用腾讯官方 `@tencent-connect/qqbot-connector`：它在**本进程内**轮询扫码结果、
 * 二维码过期自动刷新，凭据（AppID / AppSecret / 扫码人 openid）扫码成功后
 * 通过回调交给我们。我们只负责三件事：
 *   1. 把 SDK 回调的授权页 URL 变成二维码图片（data URL）给前端展示；
 *   2. 维护一个可供前端轮询的状态机；
 *   3. 凭据到手后交给宿主落地（写凭据服务 + 更新配置 + 重连通道）。
 *
 * 与 dsh-im 的区别：dsh-im 把 provisioning 拆成 begin/poll/cancel 一组 RPC，
 * 前端参与轮询；这里 SDK 已经把轮询做死在进程内，前端只需「要二维码 →
 * 看状态 → 等结果」，因此状态机更薄。
 *
 * 依赖全部注入（`loadConnector` / `makeQrDataUrl` / `onCredentials`），
 * 状态机本身纯逻辑、可单测，不真实连 QQ。
 *
 * @module dsh-hds-interlude/qq-im/connect
 */

/** 状态机的 phase。前端据此决定展示什么。 */
export const PHASES = ['idle', 'starting', 'qr', 'done', 'failed', 'cancelled']

/** 默认二维码图片生成：用 `qrcode` 包把 URL 转成 data URL。 */
export async function defaultMakeQrDataUrl(url) {
  const mod = await import('qrcode')
  const toDataUrl = mod.default?.toDataURL ?? mod.toDataURL
  return toDataUrl(String(url))
}

/**
 * 创建 provisioning 管理器。
 *
 * @param {object} options
 * @param {(level: string, text: string) => void} [options.log]
 * @param {() => Promise<Function>} [options.loadConnector]
 *   动态加载 `startQrConnect`（注入以便测试不联网）。
 * @param {(url: string) => Promise<string>} [options.makeQrDataUrl]
 *   授权页 URL → 二维码 data URL。抛错只是「图片出不来」，不影响扫码。
 * @param {(creds: {appId: string, appSecret: string, userOpenid?: string}) => Promise<void>} [options.onCredentials]
 *   扫码成功后宿主落地凭据（写凭据服务/配置/重连）。
 * @returns {{
 *   begin: () => Promise<object>,
 *   cancel: () => object,
 *   status: () => object,
 * }}
 */
export function createProvisionManager(options = {}) {
  const log = options.log ?? (() => {})
  const loadConnector = options.loadConnector ?? (async () => {
    const mod = await import('@tencent-connect/qqbot-connector')
    return mod.startQrConnect
  })
  const makeQrDataUrl = options.makeQrDataUrl ?? defaultMakeQrDataUrl
  const onCredentials = options.onCredentials ?? (async () => {})
  /**
   * 读取「当前是否已配置凭据」。重启后扫码流程的内存状态会丢，
   * 但配置（appId/enabled）和凭据服务已持久化——前端据此显示
   * 「已配置 AppID xxx，无需重新扫码」而不是诱导用户重扫。
   * 默认永远认为未配置（纯状态机行为不变）。
   * @type {() => {configured: boolean, appId?: string}|undefined}
   */
  const readConfigured = typeof options.readConfigured === 'function' ? options.readConfigured : undefined

  /** @type {{phase: string, error: string|null, qrDataUrl: string|null, qrUrl: string|null, credentials: object|null, startedAt: number|null, qrRevision: number, lastApply: object|null}} */
  let state = {
    phase: 'idle', error: null, qrDataUrl: null, qrUrl: null,
    credentials: null, startedAt: null, qrRevision: 0,
    /** 最近一次扫码凭据落地报告（写凭据/配置/重连各步成败）。 */
    lastApply: null,
  }
  /** SDK 返回的 stop 函数；null 表示当前无活动流程。 */
  let stopFn = null

  const snapshot = () => {
    // 每次快照都带上「当前配置状态」——它随配置热更，不能缓存。
    const configured = readConfigured ? readConfigured() : undefined
    return configured ? { ...state, configured } : { ...state }
  }
  const replace = (patch) => { state = { ...state, ...patch } }

  /**
   * 把错误压成一行人话，尽量带上底层细节（HTTP 状态 / 腾讯 retcode）。
   * 为什么单独抽出来：扫码失败时用户（或日志）必须能看到「到底哪一环错了」，
   * 而不是一句笼统的 Error。connector 抛的错通常带 cause / statusCode / retcode。
   */
  function describeError(error) {
    if (error === undefined || error === null) return '未知错误'
    if (typeof error === 'string') return error
    const parts = []
    const message = error.message
    if (typeof message === 'string' && message) parts.push(message)
    if (Number.isFinite(error?.statusCode)) parts.push(`HTTP ${error.statusCode}`)
    if (error?.retcode !== undefined && error.retcode !== null) parts.push(`retcode=${error.retcode}`)
    if (error?.cause && typeof error.cause?.message === 'string' && error.cause.message !== message) {
      parts.push(`（原因：${error.cause.message}）`)
    }
    return parts.length ? parts.join(' ') : String(error)
  }

  /**
   * 开始一次扫码绑定。
   *
   * 幂等：已有活动流程时直接返回现有状态（不重新生成、不报错），
   * 与前端「重复点击不捣乱」的预期一致。
   *
   * @returns {Promise<object>} 状态快照；失败时 phase='failed' 且带 error。
   */
  async function begin() {
    if (stopFn) return { ok: true, ...snapshot() }

    replace({
      phase: 'starting', error: null, qrDataUrl: null, qrUrl: null,
      credentials: null, startedAt: Date.now(),
    })

    let startQrConnect
    try {
      startQrConnect = await loadConnector()
    } catch (error) {
      log('warn', `QQ 扫码不可用（connector 未安装？）：${error?.message ?? String(error)}`)
      replace({ phase: 'failed', error: `QQ 扫码组件不可用：${error?.message ?? String(error)}` })
      return { ok: false, ...snapshot() }
    }

    try {
      stopFn = startQrConnect({
        onQrDisplayed: (url) => {
          // 每次显示新码都递增 revision。二维码图片是异步生成的，
          // 必须和「当前 revision」绑定——否则过期自动刷新后，
          // 旧任务的照片可能后到、覆盖新码，用户扫到已过期的任务，
          // 手机上就会显示「连接失败」（任务已不存在）。
          const rev = state.qrRevision + 1
          replace({ phase: 'qr', qrUrl: String(url), qrRevision: rev })
          Promise.resolve(makeQrDataUrl(String(url)))
            .then((dataUrl) => {
              // 只接受「当前 revision」的图片；过期任务的图片直接丢弃。
              if (state.qrRevision === rev) replace({ qrDataUrl: dataUrl })
            })
            .catch((error) => log('warn', `二维码图片生成失败：${error?.message ?? String(error)}`))
        },
        onSuccess: async (credentials) => {
          const creds = Array.isArray(credentials) ? credentials[0] : credentials
          replace({ phase: 'done', credentials: creds ?? null })
          stopFn = null
          try {
            const report = await onCredentials(creds)
            // 把落地报告附到状态上：前端 / /interlude im 据此展示
            // 「写凭据 ✓ / 配置 ✓ / 重连 ✓」或失败原因。
            if (report && typeof report === 'object') replace({ lastApply: report })
          } catch (error) {
            replace({ lastApply: { ok: false, error: String(error?.message ?? error) } })
            log('warn', `扫码凭据落地失败：${error?.message ?? String(error)}`)
          }
        },
        onFailure: (error) => {
          // 尽量把底层原因带出来（HTTP 状态 / 腾讯 retcode），方便用户排查。
          const detail = describeError(error)
          log('warn', `扫码失败：${detail}`)
          replace({ phase: 'failed', error: detail })
          stopFn = null
        },
        onQrExpired: () => {
          // 过期：清掉旧图（防止扫到已失效的码），rev 留给下一次
          // onQrDisplayed（新码就绪）再递增——前端据此提示「请扫新码」。
          replace({ phase: 'qr', qrDataUrl: null })
        },
      }, { displayQrCodeToConsole: false })
      return { ok: true, ...snapshot() }
    } catch (error) {
      log('warn', `启动扫码失败：${describeError(error)}`)
      replace({ phase: 'failed', error: describeError(error) })
      stopFn = null
      return { ok: false, ...snapshot() }
    }
  }

  /** 取消当前扫码流程。 */
  function cancel() {
    if (stopFn) {
      try { stopFn() } catch { /* SDK 未就绪 */ }
      stopFn = null
    }
    replace({ phase: 'cancelled', error: null, qrDataUrl: null, qrUrl: null, credentials: null })
    return { ok: true, ...snapshot() }
  }

  /** 当前状态（前端轮询用）。 */
  function status() {
    return snapshot()
  }

  return { begin, cancel, status }
}
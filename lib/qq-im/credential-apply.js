/**
 * 扫码成功后「凭据落地」的编排。
 *
 * 从 index.js 的闭包里抽出来单独成模块，因为这一步是扫码功能里最容易出错的：
 * 顺序错了（先改配置后写凭据）会让重连读到空的 AppSecret，而三个副作用
 * （凭据服务 / 设置 / 通道重连）各自可能失败，必须分别处理。
 *
 * 全部依赖注入，纯编排、可单测。
 *
 * ## 可观测性
 *
 * 用户问「扫码后是否正常写入」——本模块的每一步都记进返回的 report，
 * 前端 / `/interlude im` 据此展示「写凭据 ✓ / 配置 ✓ / 重连 ✓」或失败原因，
 * 而不是停在「连接中」干等。
 *
 * ## 多 Bot（v2）
 *
 * 配置里已有 `bots` 数组时，扫码的机器人**追加进数组**（或按 appId 覆盖已有
 * 条目），并使用**按 appId 派生的 secretRef**（凭据隔离，对齐 dsh-im）——
 * 否则面板里配好的 bots 会把扫码结果吞掉（顶层 appId 在 bots 非空时不生效）。
 * 仍是单 Bot 旧配置（无 bots 数组）时，行为与改版前完全一致。
 *
 * @module dsh-hds-interlude/qq-im/credential-apply
 */

import { deriveBotIdentity } from './config.js'

/**
 * 执行凭据落地：写凭据服务 → 更新配置 → 重连通道。
 *
 * @param {object} options
 * @param {{appId: string, appSecret: string, userOpenid?: string}} options.creds 扫码结果。
 * @param {object} [options.im] 当前 `im` 配置（读 secretRef / botId）。
 * @param {{set: (ref: unknown, value: string) => Promise<void>}|undefined} options.credentials
 *   凭据服务；undefined 表示不可用（跳过写入并警告）。
 * @param {{update: (patch: object) => Promise<void>}|undefined} options.settingsScope
 *   设置命名空间；undefined 表示不可用（配置不落盘）。
 * @param {{stop?: () => void, start?: () => Promise<void>, applyConfigAndReconnect?: (next: object) => Promise<object>}} options.channel
 *   QQ 通道句柄。扫码落地**必须**用 `applyConfigAndReconnect`：
 *   同步把新配置推进通道并立即重连，否则要等用户手动 reconnect。
 * @param {(level: string, text: string) => void} [options.log]
 * @returns {Promise<{
 *   secretRef: string,
 *   credential: {ok: boolean, error?: string},
 *   config: {ok: boolean, error?: string},
 *   reconnect: {ok: boolean, error?: string, skipped?: string},
 * }>} 每步的成败，供前端展示。
 */
export async function applyScanCredentials({ creds, im, credentials, settingsScope, channel, log = () => {} }) {
  const report = {
    secretRef: 'DSH_QQBOT_APP_SECRET',
    credential: { ok: false },
    config: { ok: false },
    reconnect: { ok: false },
  }
  try {
    if (!creds || typeof creds.appSecret !== 'string' || !creds.appSecret) {
      throw new Error('扫码成功但没有拿到 AppSecret')
    }
    const imCfg = im ?? {}
    // 旧机器人集合：显式 bots 数组优先；没有数组但顶层有 appId 时，把顶层字段
    // 合成一条作为 bots[0] —— **扫码永远是「新增」**：旧机器人必须保留，
    // 新扫的机器人追加进去（或 appId 相同则覆盖那一条 = 重扫同一个 bot）。
    const existingBots = Array.isArray(imCfg.bots) ? imCfg.bots.slice() : []
    const legacyAppId = typeof imCfg.appId === 'string' && imCfg.appId.trim() ? imCfg.appId.trim() : ''
    if (existingBots.length === 0 && legacyAppId) {
      const legacyDerived = deriveBotIdentity(legacyAppId)
      existingBots.push({
        botId: (typeof imCfg.botId === 'string' && imCfg.botId ? imCfg.botId : legacyDerived?.botId) || 'qq',
        appId: legacyAppId,
        secretRef: (typeof imCfg.secretRef === 'string' && imCfg.secretRef ? imCfg.secretRef : legacyDerived?.secretRef) || 'DSH_QQBOT_APP_SECRET',
        alias: typeof imCfg.alias === 'string' ? imCfg.alias : '',
      })
    }
    const appId = String(creds.appId ?? '').trim() || legacyAppId
    const derived = appId ? deriveBotIdentity(appId) : undefined
    const newBot = {
      botId: derived?.botId ?? 'qq',
      appId,
      secretRef: derived?.secretRef ?? 'DSH_QQBOT_APP_SECRET',
      alias: '',
    }
    // 有没有需要保留的旧机器人：有 → 走 bots 数组（追加/覆盖）；没有 → 这就是
    // 第一个 bot，行为与改版前一致（只写顶层字段，不写 bots）。
    const hasExisting = existingBots.length > 0
    const bots = hasExisting
      ? (existingBots.some(bot => bot && bot.appId === appId)
          ? existingBots.map(bot => (bot && bot.appId === appId ? newBot : bot))
          : [...existingBots, newBot])
      : undefined
    // 凭据写入：有旧机器人时写到新 bot 的派生引用（凭据隔离）；第一个 bot 沿用
    // 顶层引用（向后兼容——旧配置的 secretRef 不动）。
    const secretRef = hasExisting
      ? newBot.secretRef
      : (typeof imCfg.secretRef === 'string' && imCfg.secretRef ? imCfg.secretRef : 'DSH_QQBOT_APP_SECRET')
    report.secretRef = secretRef

    // ① 写凭据服务。
    try {
      if (credentials && typeof credentials.set === 'function') {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        await credentials.set(credentialRef(secretRef), creds.appSecret)
        report.credential = { ok: true }
        log('info', `已把 AppSecret 写入凭据服务（${secretRef}）。`)
      } else {
        report.credential = { ok: false, error: '凭据服务不可用（未安装或未注入）——AppSecret 只存在内存里，重启后丢失' }
        log('warn', report.credential.error)
      }
    } catch (error) {
      report.credential = { ok: false, error: String(error?.message ?? error) }
      log('warn', `写入凭据服务失败：${report.credential.error}`)
    }

    // ② 更新配置（保持 sayFallback / chunking 等既有设置不动，只改连接相关）。
    const imPatch = {
      im: {
        enabled: true,
        appId,
        secretRef,
        // 有旧机器人时顶层字段指向新扫的 bot（通道以 bots 数组为准）；
        // 第一个 bot 时沿用显式 botId（向后兼容）。
        botId: hasExisting
          ? newBot.botId
          : (typeof imCfg.botId === 'string' && imCfg.botId ? imCfg.botId : newBot.botId),
        ...(bots ? { bots } : {}),
      },
    }
    // ②′ 被删除的 bot 重新扫码 → 清除它的旧绑定（开新会话，而不是回到删除前的旧会话）。
    // 判定：扫码的 botId 不在当前配置的 bots 里（全新 bot 或曾被删除的 bot）。
    // 已经在配置里的 bot（正常重扫修复）不清绑定，保留会话关系。
    const scannedBotId = derived?.botId ?? newBot.botId
    const isFreshBot = !(Array.isArray(imCfg.bots) && imCfg.bots.some(bot => bot && bot.botId === scannedBotId))
    if (isFreshBot && channel && typeof channel.removeBotBindings === 'function') {
      try {
        // await：removeBotBindings 可能是异步实现（通道侧可能涉及落盘）。
        const removed = Number(await channel.removeBotBindings(scannedBotId)) || 0
        if (removed > 0) {
          log('info', `机器人 ${scannedBotId} 不在当前配置（可能刚被删除），清除其 ${removed} 条旧绑定——重新接入后将从新会话开始。`)
          report.staleBindingsCleared = removed
        }
      } catch (error) {
        log('warn', `清除机器人 ${scannedBotId} 的旧绑定失败：${error?.message ?? String(error)}`)
      }
    }
    try {
      if (settingsScope && typeof settingsScope.update === 'function') {
        await settingsScope.update(imPatch)
        report.config = { ok: true }
      } else {
        report.config = { ok: false, error: '设置命名空间不可用——扫码结果未写入配置' }
        log('warn', report.config.error)
      }
    } catch (error) {
      report.config = { ok: false, error: String(error?.message ?? error) }
      log('warn', `更新配置失败：${report.config.error}`)
    }

    // ③ 重连通道：同步推进配置 + 立即重连。
    // 必须用 applyConfigAndReconnect —— 旧实现「stop 等 50ms 再 start」有竞态：
    // 旧连接 finally 会把新连接标志清掉，表现就是「一直连接中」。
    log('info', `扫码绑定成功（AppID ${creds.appId ?? '—'}），重连 QQ 通道…`)
    try {
      if (channel && typeof channel.applyConfigAndReconnect === 'function') {
        const result = await channel.applyConfigAndReconnect(imPatch)
        report.reconnect = { ok: true, skipped: result.reconnectStarted ? undefined : '配置未变化，无需重连' }
      } else if (channel && typeof channel.start === 'function') {
        // 兜底：没有 applyConfigAndReconnect 的旧实现（测试注入用），
        // 配置已由 settingsScope.update 推进。
        await channel.start()
        report.reconnect = { ok: true }
      } else {
        report.reconnect = { ok: false, error: '通道句柄不可用' }
      }
    } catch (error) {
      report.reconnect = { ok: false, error: String(error?.message ?? error) }
      log('warn', `扫码后重连 QQ 通道失败：${report.reconnect.error}`)
    }

    return report
  } catch (error) {
    // 顶层异常（如 creds 缺 AppSecret）：整步失败。
    const text = String(error?.message ?? error)
    report.credential.error = report.credential.error ?? text
    log('warn', `扫码凭据落地失败：${text}`)
    return report
  }
}
/**
 * 会话 ↔ IM 投递目标 的自动发现。
 *
 * 为什么需要它：
 * dsh-im 对宿主只暴露 `send` / `listBots` / `listTargets`，而 `listTargets` 恰好把
 * 会话双向同步里最关键的 `conversationKey` 剥掉了（只留 `{ enabled, state }`）。
 * 于是「这个 DSH 会话对应哪个 botId/targetId」无法从公开接口问出来——插件只能
 * 要求人工 `/interlude im bind`。一旦忘了配，角色在 IM 会话里的主动开口就等于
 * 在空房间里说话：`agent.followup()` 写出来的话不会回到 IM
 * （dsh-im 的会话同步只推送 origin 为 dsh 的回合）。
 *
 * 而 dsh-im 自己就是靠磁盘上的这份映射把 IM 消息路由进会话的：
 *
 *   $DSH_HOME/integrations/dsh-<channel>/workspaces.json
 *     └─ deliveryTargets[botId][targetId].sessionSync.conversationKey
 *   $DSH_HOME/integrations/dsh-<channel>/{bots,accounts}/<botId>/state.json
 *     └─ sessions[conversationKey] = sessionId
 *
 * 这里只读地把它反查出来：命中即用，文件缺失 / 格式变化 / 权限不足都当作
 * 「没有发现」（绝不猜、绝不写别人的文件）。读取结果带短 TTL 缓存，避免后台
 * 扫描每一轮都去敲磁盘。
 *
 * @module dsh-hds-interlude/im-binding
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 发现结果的缓存有效期：够短以保证新绑定的目标很快生效，够长以避开空转。 */
const CACHE_TTL_MS = 10_000

/** dsh-im 的集成目录名形如 `dsh-qq` / `dsh-weixin`。 */
const CHANNEL_DIR = /^dsh-([a-z][a-z0-9-]{0,31})$/

/** bot 状态文件可能落在两个位置（QQ 用 bots/，微信等用 accounts/）。 */
const STATE_DIRS = ['bots', 'accounts']

/** @type {Map<string, {at: number, bindings: Array<object>}>} */
const cache = new Map()

/** DSH 主目录；与 state.js 的 interludeHome 同源。 */
export function dshHome(home) {
  return home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 扫描 `$DSH_HOME/integrations/*`，列出「已开启会话双向同步」的会话 → 投递目标映射。
 *
 * @param {object} [options]
 * @param {string} [options.home] 覆盖 DSH 主目录（测试注入用）。
 * @returns {Array<{sessionId: string, botId: string, targetId: string, channel: string, name?: string}>}
 */
export function listDiscoveredBindings(options = {}) {
  const home = dshHome(options.home)
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : CACHE_TTL_MS
  const cached = cache.get(home)
  const now = Date.now()
  if (cached && ttl > 0 && now - cached.at < ttl) return cached.bindings

  const bindings = []
  let channelDirs = []
  try {
    channelDirs = fs.readdirSync(path.join(home, 'integrations'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    cache.set(home, { at: now, bindings })
    return bindings
  }

  for (const dirName of channelDirs) {
    const channel = CHANNEL_DIR.exec(dirName)?.[1]
    if (!channel) continue
    const dir = path.join(home, 'integrations', dirName)
    const workspaces = readJson(path.join(dir, 'workspaces.json'))
    const targets = workspaces?.deliveryTargets
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) continue

    for (const [botId, perBot] of Object.entries(targets)) {
      if (!isNonEmptyString(botId) || !perBot || typeof perBot !== 'object' || Array.isArray(perBot)) continue
      // bot 的 state.json 只在第一次用到时读。
      let sessions
      for (const stateDir of STATE_DIRS) {
        const state = readJson(path.join(dir, stateDir, botId, 'state.json'))
        if (state?.sessions && typeof state.sessions === 'object') { sessions = state.sessions; break }
      }
      if (!sessions) continue

      for (const [targetId, target] of Object.entries(perBot)) {
        if (!isNonEmptyString(targetId) || !target || typeof target !== 'object') continue
        const conversationKey = target?.sessionSync?.conversationKey
        if (!isNonEmptyString(conversationKey)) continue
        const sessionId = sessions[conversationKey]
        if (!isNonEmptyString(sessionId)) continue
        bindings.push({
          sessionId,
          botId,
          targetId,
          channel,
          ...isNonEmptyString(target?.name) ? { name: target.name } : {},
        })
      }
    }
  }

  cache.set(home, { at: now, bindings })
  return bindings
}

/**
 * 查一个会话的投递目标。
 *
 * @param {string} sessionId 会话 id（与 `state.key` 同源）。
 * @param {object} [options] 同 {@link listDiscoveredBindings}。
 * @returns {{sessionId: string, botId: string, targetId: string, channel: string, name?: string}|undefined}
 */
export function discoverImBinding(sessionId, options = {}) {
  if (!isNonEmptyString(sessionId)) return undefined
  return listDiscoveredBindings(options).find(binding => binding.sessionId === sessionId)
}

/** 清空缓存（测试用，也让宿主可以在设置变更后强制重读）。 */
export function clearImBindingCache() {
  cache.clear()
}

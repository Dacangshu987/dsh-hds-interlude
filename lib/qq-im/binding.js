/**
 * 会话 ↔ 投递目标绑定：**自己拥有**，不再借用 dsh-im 的 `sessionSync`。
 *
 * ## 为什么这件事值得单独一个文件
 *
 * dsh-im 把两件本来无关的事塞进了同一个字段：
 *   1. 「这个会话的回复要镜像到聊天软件」（会话双向同步）；
 *   2. 「这个会话对应哪个投递目标」（绑定关系）。
 *
 * 而 `sessionSync` 对象的**存在本身就是开关**，没有独立的布尔字段：
 *   - 想关掉镜像 → `setDeliveryTargetSessionSync(..., null)`；
 *   - 这个调用会 **`delete` 整个对象**；
 *   - 于是 `conversationKey` 也没了 → 自动绑定发现失效 → 主动发消息全部
 *     退回被动分支（`reason: no-binding`），消息发不出去。
 *
 * 两件事被**不可分割地耦合**在同一个字段上。这不是配置问题，是设计问题——
 * 而且**没有出路**：要么忍受思考泄漏，要么失去主动投递能力。
 *
 * 自建插件把绑定关系拿回自己手里，这个死结就直接消失了：
 * 绑定与镜像本来就是两件事，这里只负责前者，镜像通道根本不存在。
 *
 * 落盘位置：`$DSH_HOME/integrations/dsh-qq-im/bindings.json`
 * ```json
 * { "version": 2, "bindings": {
 *     "qq_<hash>\u0000c2c:<openid>": { "conversationKey": "c2c:<openid>", "sessionId": "...", "botId": "qq_<hash>", "name": "江柚", "boundAt": "..." }
 * } }
 * ```
 *
 * **v2 主键 = 复合键 `botId\0conversationKey`**（对齐 dsh-im 的
 * `conversationWorkspaceGenerationKey`）：不同 Bot 即使面对同一个
 * conversationKey 也是两条独立绑定，互不覆盖。v1 的键就是 conversationKey
 * 本身，迁移时用「迁移那一刻配置里的 botId」补全并改写为 v2（写回前备份原文件）。
 *
 * 写盘用「临时文件 + 改名」的原子替换，避免半截 JSON 让绑定表整个失效。
 *
 * ## 合并要点
 *
 * `dshHome` 复用 `im-binding.js` 的同名实现，不另起一份——两处若各自演进，
 * 会出现「读绑定看 A 目录、写绑定写 B 目录」这种极难查的分裂。
 *
 * @module dsh-hds-interlude/qq-im/binding
 */

import fs from 'node:fs'
import path from 'node:path'

import { dshHome } from '../im-binding.js'

const BINDINGS_VERSION = 2
const LEGACY_VERSION = 1

/** 把 DSH 主目录再导出一次，方便本目录内其它模块只依赖这里。 */
export { dshHome }

/** 本通道的集成数据目录：`$DSH_HOME/integrations/dsh-qq-im`。 */
export function integrationHome(home) {
  return path.join(dshHome(home), 'integrations', 'dsh-qq-im')
}

/** 绑定表文件路径。 */
export function bindingsFile(home) {
  return path.join(integrationHome(home), 'bindings.json')
}

/**
 * 复合绑定键：`botId \0 conversationKey`。
 *
 * 为什么用 NUL 作分隔符：conversationKey 由 `conversationKeyOf` 校验过
 * （`c2c:<openid>` / `group:<id>`，不含控制字符），所以复合键无歧义——
 * 这正是 dsh-im 的 `bot-workspace-store.mjs:105` 的同一套理由。
 *
 * @param {string} botId
 * @param {string} conversationKey
 * @returns {string}
 */
export function bindingKeyOf(botId, conversationKey) {
  return `${botId}\u0000${conversationKey}`
}

/**
 * 从复合键 `botId\0conversationKey` 反解出 botId。
 * 键里没有 NUL（v1 形态，键就是 conversationKey）时返回 undefined。
 *
 * @param {string} key
 * @returns {string|undefined}
 */
export function botIdOfBinding(key) {
  if (typeof key !== 'string') return undefined
  const index = key.indexOf('\u0000')
  if (index < 0) return undefined
  return key.slice(0, index) || undefined
}

/** 把复合键还原成人类可读形式（日志用）。 */
export function debugKey(key) {
  if (typeof key !== 'string') return String(key)
  const botId = botIdOfBinding(key)
  return botId
    ? `${botId} → ${key.slice(key.indexOf('\u0000') + 1)}`
    : key
}

/** 会话键：`c2c:<openid>`。与 dsh-im 的 conversationKey 同构，便于迁移。 */
export function conversationKeyOf({ scope = 'c2c', targetId } = {}) {
  if (typeof targetId !== 'string' || !targetId) return undefined
  return `${scope}:${targetId}`
}

/** 从 `c2c:<openid>` 反解出 openid。 */
export function targetIdOf(conversationKey) {
  if (typeof conversationKey !== 'string') return undefined
  const index = conversationKey.indexOf(':')
  if (index < 0) return undefined
  const value = conversationKey.slice(index + 1)
  return value || undefined
}

/** 从 `c2c:<openid>` 反解出 scope。 */
export function scopeOf(conversationKey) {
  if (typeof conversationKey !== 'string') return 'c2c'
  const index = conversationKey.indexOf(':')
  return index < 0 ? 'c2c' : conversationKey.slice(0, index) || 'c2c'
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
 * 绑定表：内存镜像 + 磁盘持久化。
 *
 * 设计取舍：**读走内存、写落磁盘**。绑定变更极少（只在收到新会话消息或人工
 * `/qqim bind` 时），而查询每条入站消息都要走一次，所以缓存整表是划算的。
 * 多进程并存不在支持范围内（同一 `$DSH_HOME` 只应有一个 DSH 实例）。
 */
export class BindingStore {
  /**
   * @param {object} [options]
   * @param {string} [options.home] 覆盖 DSH 主目录。
   * @param {string} [options.legacyBotId] v1 → v2 迁移时给无归属旧记录补的 botId。
   */
  constructor(options = {}) {
    this.home = options.home
    this.legacyBotId = options.legacyBotId
    this.file = bindingsFile(this.home)
    /** @type {Map<string, object>} 键 = 复合键（或 v1 遗留的 conversationKey） */
    this.map = new Map()
    this.loaded = false
    this.lastError = null
    /** 本次读盘时发生过 v1 → v2 迁移（供日志/测试确认）。 */
    this.migratedFrom = null
  }

  /**
   * 存储键：有 botId 用复合键，没有（v1 遗留 / 手工绑定）直接以 conversationKey
   * 为键——这样旧测试与旧行为不破坏，而多 Bot 路径永远走复合键。
   */
  storageKeyOf(botId, conversationKey) {
    return isNonEmptyString(botId)
      ? bindingKeyOf(botId, conversationKey)
      : conversationKey
  }

  /** 从磁盘载入（只读一次；文件缺失/损坏都当作空表，绝不猜）。 */
  load() {
    if (this.loaded) return this.map
    this.loaded = true
    const parsed = readJson(this.file)
    const bindings = parsed?.bindings
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return this.map

    // v1 形态：version 不是 2，或键里不含 NUL（键就是 conversationKey）。
    const legacyLayout = parsed?.version !== BINDINGS_VERSION
      || Object.keys(bindings).some(key => !key.includes('\u0000'))

    for (const [key, value] of Object.entries(bindings)) {
      if (!isNonEmptyString(key)) continue
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (!isNonEmptyString(value.sessionId)) continue

      let botId = isNonEmptyString(value.botId) ? value.botId : undefined
      let conversationKey = key
      if (legacyLayout && !key.includes('\u0000')) {
        // v1：键就是 conversationKey，botId 从记录或迁移配置补全。
        this.migratedFrom = this.migratedFrom ?? LEGACY_VERSION
        botId = botId ?? this.legacyBotId
      } else if (key.includes('\u0000')) {
        botId = botIdOfBinding(key) ?? botId
        conversationKey = key.slice(key.indexOf('\u0000') + 1)
      }
      const entry = {
        conversationKey,
        sessionId: value.sessionId,
        botId: isNonEmptyString(botId) ? botId : undefined,
        name: isNonEmptyString(value.name) ? value.name : undefined,
        boundAt: isNonEmptyString(value.boundAt) ? value.boundAt : undefined,
      }
      if (this.migratedFrom === LEGACY_VERSION) entry.migratedFrom = LEGACY_VERSION
      this.map.set(this.storageKeyOf(botId, conversationKey), entry)
    }

    // 迁移落盘：备份原文件后改写为 v2。备份能保证「读错了也能找回」。
    if (this.migratedFrom === LEGACY_VERSION && this.map.size > 0) {
      try {
        const backup = `${this.file}.bak-v1-${Date.now()}`
        fs.copyFileSync(this.file, backup)
        this.persist()
      } catch (error) {
        this.lastError = `v1→v2 迁移落盘失败：${error?.message ?? String(error)}`
      }
    }
    return this.map
  }

  /** 原子落盘：先写临时文件再改名，避免半截 JSON 让整张表失效。 */
  persist() {
    const dir = path.dirname(this.file)
    const tmp = `${this.file}.tmp-${process.pid}`
    const payload = { version: BINDINGS_VERSION, bindings: Object.fromEntries(this.map) }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, this.file)
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      // 别把临时文件留在磁盘上。
      try { fs.unlinkSync(tmp) } catch { /* 清理失败无所谓 */ }
      return false
    }
  }

  /**
   * 按会话键（+ 可选的 botId）查绑定。
   *
   * - **指定了 botId**：只认精确复合键 `botId\0conversationKey`，绝不串号
   *   （A-1：多 Bot 下各自独立）。找不到就是没有，返回 undefined。
   * - **未指定 botId**（旧调用/迁移期）：先找 v1 遗留键（conversationKey 直接作键），
   *   再退回到「任意 bot 里 conversationKey 匹配的第一条」。
   */
  get(conversationKey, botId) {
    if (!isNonEmptyString(conversationKey)) return undefined
    this.load()
    if (isNonEmptyString(botId)) {
      return this.map.get(bindingKeyOf(botId, conversationKey)) ?? undefined
    }
    const legacy = this.map.get(conversationKey)
    if (legacy) return legacy
    for (const binding of this.map.values()) {
      if (binding.conversationKey === conversationKey) return binding
    }
    return undefined
  }

  /** 按 DSH 会话 id 反查绑定（hds-interlude 的投递路径按会话 id 找目标）。 */
  bySessionId(sessionId) {
    if (!isNonEmptyString(sessionId)) return undefined
    for (const binding of this.load().values()) {
      if (binding.sessionId === sessionId) return binding
    }
    return undefined
  }

  /** 按 botId 过滤绑定（缺省全部）。 */
  list(botId) {
    const rows = [...this.load().values()]
    return isNonEmptyString(botId)
      ? rows.filter(item => item.botId === botId)
      : rows
  }

  /**
   * 写入/更新一条绑定并落盘。
   *
   * 幂等：完全相同的绑定不会重复写盘（避免每条入站消息都触发一次磁盘写入）。
   *
   * @returns {{binding: object, changed: boolean, persisted: boolean}}
   */
  set({ conversationKey, sessionId, botId, name }) {
    if (!isNonEmptyString(conversationKey)) throw new TypeError('binding: conversationKey 必填')
    if (!isNonEmptyString(sessionId)) throw new TypeError('binding: sessionId 必填')
    this.load()
    const key = this.storageKeyOf(botId, conversationKey)
    const previous = this.map.get(key)
    const next = {
      conversationKey,
      sessionId,
      botId: isNonEmptyString(botId) ? botId : previous?.botId,
      name: isNonEmptyString(name) ? name : previous?.name,
      boundAt: previous?.boundAt ?? new Date().toISOString(),
    }
    const changed = !previous
      || previous.sessionId !== next.sessionId
      || previous.botId !== next.botId
      || previous.name !== next.name
    if (!changed) return { binding: previous, changed: false, persisted: false }
    this.map.set(key, next)
    const persisted = this.persist()
    return { binding: next, changed: true, persisted }
  }

  /** 删除一条绑定。返回是否真的删掉了。 */
  remove(conversationKey, botId) {
    this.load()
    const key = this.storageKeyOf(botId, conversationKey)
    if (this.map.has(key)) {
      this.map.delete(key)
      this.persist()
      return true
    }
    // 精确键不存在时退回按 conversationKey 找（旧路径/换绑场景）。
    const found = [...this.map.entries()].find(([, b]) => b.conversationKey === conversationKey)
    if (!found) return false
    this.map.delete(found[0])
    this.persist()
    return true
  }

  /** 强制下次访问重新读盘（测试与人工改文件后使用）。 */
  invalidate() {
    this.loaded = false
    this.map = new Map()
    this.migratedFrom = null
  }
}

/**
 * 从 dsh-im 的旧数据里**只读地**迁移绑定。
 *
 * 迁移的意义：`dsh-qq` 的 `workspaces.json` 里已经有
 * `deliveryTargets[botId][targetId].sessionSync.conversationKey`，
 * 而 `bots/<botId>/state.json` 里有 `sessions[conversationKey] = sessionId`。
 * 这两份拼起来正是我们需要的绑定表——照搬即可，用户无需重新绑定。
 *
 * 注意：**只读，绝不写别人的文件**。命中即用，文件缺失 / 格式变化都当作没有。
 * 这是过渡手段；旧数据消失后这个函数就没有存在意义了。
 *
 * @param {object} [options]
 * @param {string} [options.home] 覆盖 DSH 主目录。
 * @param {string} [options.channelDir='dsh-qq'] 集成目录名。
 * @returns {Array<{conversationKey: string, sessionId: string, botId: string, name?: string}>}
 */
export function readLegacyBindings(options = {}) {
  const home = dshHome(options.home)
  const dirName = options.channelDir ?? 'dsh-qq'
  const dir = path.join(home, 'integrations', dirName)
  const workspaces = readJson(path.join(dir, 'workspaces.json'))
  const targets = workspaces?.deliveryTargets
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return []

  const out = []
  for (const [botId, perBot] of Object.entries(targets)) {
    if (!isNonEmptyString(botId) || !perBot || typeof perBot !== 'object' || Array.isArray(perBot)) continue
    // bot 的 state.json 只在第一次用到时读；QQ 用 bots/，其它渠道可能用 accounts/。
    let sessions
    for (const stateDir of ['bots', 'accounts']) {
      const state = readJson(path.join(dir, stateDir, botId, 'state.json'))
      if (state?.sessions && typeof state.sessions === 'object' && !Array.isArray(state.sessions)) {
        sessions = state.sessions
        break
      }
    }
    if (!sessions) continue

    for (const [targetId, target] of Object.entries(perBot)) {
      if (!isNonEmptyString(targetId) || !target || typeof target !== 'object') continue
      const conversationKey = target?.sessionSync?.conversationKey
      if (isNonEmptyString(conversationKey)) {
        const sessionId = sessions[conversationKey]
        if (isNonEmptyString(sessionId)) {
          out.push({
            conversationKey,
            sessionId,
            botId,
            ...isNonEmptyString(target?.name) ? { name: target.name } : {},
          })
          continue
        }
      }
      // 没有 sessionSync 时，退一步用 targetId 当作 openid 拼 conversationKey。
      // dsh-im 的 deliveryTargets 键就是它自己的 targetId（QQ 场景下等于 openid）。
      const sessionId = sessions[`c2c:${targetId}`]
      if (isNonEmptyString(sessionId)) {
        out.push({
          conversationKey: `c2c:${targetId}`,
          sessionId,
          botId,
          ...isNonEmptyString(target?.name) ? { name: target.name } : {},
        })
      }
    }
  }
  return out
}

/**
 * 首次启动时把旧数据灌进我们的绑定表（只在表为空且配置允许时）。
 *
 * @returns {number} 实际迁移的条数。
 */
export function migrateLegacyBindings(store, options = {}) {
  if (store.list().length > 0) return 0
  const legacy = readLegacyBindings(options)
  let migrated = 0
  for (const item of legacy) {
    try {
      store.set(item)
      migrated += 1
    } catch { /* 单条格式不对不影响其它 */ }
  }
  return migrated
}

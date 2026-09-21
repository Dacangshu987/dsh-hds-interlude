/**
 * QQ 用户端机器人命令（对齐 dsh-im 的 /new /session /sessionlist /status /help，
 * 另增 /preset 切换角色预设、/presetlist 列出可用预设）。
 *
 * 由 channel.js 在入站时拦截（私聊、单行、以 / 开头），**不进模型**，
 * 本模块执行并把结果回投给用户。命令操作的是「这条消息所属的 bot + 聊天」。
 *
 * 全部依赖注入（`qqIm` / `listStoredStates` / `storyNameFor` / `listPresets` /
 * `resolvePresetId`），纯逻辑可单测——与 credential-apply.js 同一模式。
 *
 * @module dsh-hds-interlude/qq-im/bot-commands
 */

/**
 * 创建机器人命令处理器。
 *
 * @param {object} deps
 * @param {object} deps.qqIm 通道句柄（config.bots / bindings / createSessionFor /
 *   invalidateBindings / status）。
 * @param {() => Array<{key: string, state: object}>} deps.listStoredStates 列出
 *   幕间会话状态（/sessionlist、/session 的候选来源）。
 * @param {(botId: string) => string|undefined} deps.storyNameFor 某 bot 的角色名
 *   （绑定 name 用）。
 * @param {() => Array<{id: string, name: string}>} [deps.listPresets] 列出可切换的
 *   角色预设（/preset 的列表与序号选择）。缺省时 /preset 提示无预设。
 * @param {(nameOrId: string) => string|undefined} [deps.resolvePresetId] 把角色名
 *   或预设 id 解析成可用预设 id（/preset 按名字/id 匹配）。缺省时只按名字匹配。
 * @returns {(args: object) => Promise<{handled: boolean, reply?: string, sessionId?: string}>}
 */
export function createBotCommandHandler({ qqIm, listStoredStates, storyNameFor, listPresets, resolvePresetId }) {
  return async function handleBotCommand({ message, botId, conversationKey, scope }) {
    const text = String(message?.content ?? '').trim()
    const [verb, ...rest] = text.split(/\s+/)
    const bot = (qqIm.config.bots ?? []).find(b => b.botId === botId)
    const alias = bot?.alias || botId
    const targetId = typeof conversationKey === 'string' && conversationKey.startsWith('c2c:')
      ? conversationKey.slice('c2c:'.length)
      : (typeof conversationKey === 'string' && conversationKey.startsWith('group:')
        ? conversationKey.slice('group:'.length)
        : conversationKey)
    const binding = qqIm.bindings.get(conversationKey, botId)
    const botStatus = (qqIm.status().bots ?? []).find(b => b.botId === botId)
    const reply = (replyText) => ({ handled: true, reply: replyText, sessionId: binding?.sessionId })

    switch (verb) {
      case '/help':
        return reply([
          `${alias} 机器人已连接 DeepSeek Harness（hds-interlude 幕间层）。`,
          '直接发消息即可继续当前会话。可用命令：',
          '  /new                开启一个全新会话',
          '  /sessionlist        列出可绑定的会话',
          '  /session <ID|序号>  把当前聊天绑到指定会话',
          '  /presetlist        列出可用角色预设',
          '  /preset <ID|序号|角色名>  切换角色预设',
          '  /status             查看连接与绑定状态',
          '  /help               显示本帮助',
        ].join('\n'))

      case '/status': {
        const conn = botStatus?.ready ? '已连接' : (botStatus?.started ? '连接中' : '未启动')
        const lines = [`${alias}：${conn}${botStatus?.appId ? `（AppID ${botStatus.appId}）` : ''}`]
        if (binding) {
          lines.push(`当前绑定：会话 ${String(binding.sessionId).slice(0, 20)}…${binding.name ? `（${binding.name}）` : ''}`)
        } else {
          lines.push('当前未绑定会话：直接发消息会自动新建。')
        }
        return reply(lines.join('\n'))
      }

      case '/new': {
        // 对齐 dsh-im /new：清掉当前聊天绑定 → 新建会话 → 绑回。
        const existed = qqIm.bindings.remove(conversationKey, botId)
        qqIm.invalidateBindings()
        const fresh = await qqIm.createSessionFor(
          conversationKey,
          {
            kind: scope === 'group' ? 'group' : 'c2c',
            senderId: targetId,
            content: '（用户用 /new 开启了全新会话）',
            messageId: `interlude-new-${Date.now()}`,
          },
          botId,
        )
        if (typeof fresh === 'string' && fresh) {
          qqIm.bindings.set({ conversationKey, sessionId: fresh, botId, name: storyNameFor(botId) })
          qqIm.invalidateBindings()
          return { handled: true, reply: '已开启全新会话，从这里开始吧。', sessionId: fresh }
        }
        return reply(existed
          ? '已解除原绑定；未能立即新建会话，下一条消息会自动创建。'
          : '已开启新会话（下一条消息会自动创建）。')
      }

      case '/sessionlist': {
        const lines = []
        const seen = new Set()
        for (const item of qqIm.bindings.list()) {
          if (seen.has(item.sessionId)) continue
          seen.add(item.sessionId)
          lines.push(`  [${lines.length}] ${String(item.sessionId).slice(0, 20)}… → ${item.conversationKey}${item.name ? `（${item.name}）` : ''}`)
        }
        for (const { key, state } of listStoredStates()) {
          if (seen.has(key)) continue
          seen.add(key)
          lines.push(`  [${lines.length}] ${String(key).slice(0, 20)}…${state?.continuity ? `（${String(state.continuity).slice(0, 20)}）` : ''}`)
        }
        if (lines.length === 0) lines.push('  （没有可绑定的会话）')
        lines.unshift('可选会话（序号从 0 开始）：')
        lines.push('用 /session <ID|序号> 绑定。')
        return reply(lines.join('\n'))
      }

      case '/session': {
        const want = rest[0]
        if (!want) return reply('用法：/session <会话ID|序号>。先 /sessionlist 查看。')
        const candidates = []
        const seen = new Set()
        for (const item of qqIm.bindings.list()) {
          if (seen.has(item.sessionId)) continue
          seen.add(item.sessionId)
          candidates.push({ sessionId: item.sessionId, title: `→ ${item.conversationKey}` })
        }
        for (const { key, state } of listStoredStates()) {
          if (seen.has(key)) continue
          seen.add(key)
          candidates.push({ sessionId: key, title: state?.continuity || '' })
        }
        let target = null
        if (/^\d+$/.test(want)) {
          target = candidates[Number(want)] ?? null
          if (!target) return reply(`没有序号 ${want} 的会话（可选 0–${candidates.length - 1}）。`)
        } else {
          target = candidates.find(c => c.sessionId === want || c.sessionId.startsWith(want)) ?? null
          if (!target) return reply(`找不到会话 ${want}。用 /sessionlist 查看。`)
        }
        qqIm.bindings.set({ conversationKey, sessionId: target.sessionId, botId, name: storyNameFor(botId) })
        qqIm.invalidateBindings()
        return {
          handled: true,
          reply: `已把当前聊天绑到会话 ${String(target.sessionId).slice(0, 20)}…${target.title ? `（${target.title}）` : ''}。`,
          sessionId: target.sessionId,
        }
      }

      case '/presetlist': {
        // 列出可切换的角色预设（/preset 的可用集合），对齐 /sessionlist 的形态。
        const presets = typeof listPresets === 'function' ? (listPresets() || []) : []
        if (presets.length === 0) {
          return reply('没有可切换的角色预设。先在 DSH 设置 → 幕间系统 → 创作 页保存一个预设。')
        }
        const lines = ['可用角色预设（序号从 0 开始）：']
        for (let i = 0; i < presets.length; i += 1) {
          const p = presets[i] || {}
          const label = p.name || String(p.id).slice(0, 20)
          const extra = String(p.id).length > 28 ? `（${String(p.id).slice(0, 28)}…）` : ''
          lines.push(`  [${i}] ${label}${extra}`)
        }
        lines.push('用 /preset <ID|序号|角色名> 切换（会新建该角色的会话并接管当前聊天）。')
        return reply(lines.join('\n'))
      }

      case '/preset': {
        // 切换角色预设：必须带「ID|序号|角色名」参数；可用列表见 /presetlist。
        // 与 /new 同一套「解绑 → 建会话 → 绑回」。
        const presets = typeof listPresets === 'function' ? (listPresets() || []) : []
        const want = rest[0]
        if (!want) {
          return reply('用法：/preset <ID|序号|角色名>。先发 /presetlist 查看可用角色预设。')
        }
        let target = null
        if (/^\d+$/.test(want)) {
          target = presets[Number(want)] ?? null
          if (!target) return reply(`没有序号 ${want} 的预设（可选 0–${presets.length - 1}）。发 /presetlist 查看。`)
        } else {
          // 先按角色名精确匹配，再按 id 精确/前缀匹配；都不中时退回 resolvePresetId。
          target = presets.find(p => p?.name === want)
            ?? presets.find(p => p?.id === want || (p?.id?.startsWith?.(want) ?? false))
            ?? null
          if (!target && typeof resolvePresetId === 'function') {
            const resolved = resolvePresetId(want)
            if (resolved) target = { id: resolved, name: want }
          }
          if (!target) return reply(`找不到角色预设「${want}」。发 /presetlist 查看可用列表。`)
        }
        // 解绑 → 用该预设新建会话 → 绑回（绑定名 = 新角色名）。
        qqIm.bindings.remove(conversationKey, botId)
        qqIm.invalidateBindings()
        const fresh = await qqIm.createSessionFor(
          conversationKey,
          {
            kind: scope === 'group' ? 'group' : 'c2c',
            senderId: targetId,
            content: `（用户用 /preset 切换到角色「${target.name}」，开启新会话）`,
            messageId: `interlude-preset-${Date.now()}`,
          },
          botId,
          { presetId: target.id },
        )
        if (typeof fresh === 'string' && fresh) {
          qqIm.bindings.set({ conversationKey, sessionId: fresh, botId, name: target.name })
          qqIm.invalidateBindings()
          return { handled: true, reply: `已切换到角色「${target.name}」，从这里开始新的对话吧。`, sessionId: fresh }
        }
        return reply('已解除原绑定；未能立即切换预设，下一条消息会自动创建新会话。')
      }

      default:
        // 未知命令：不进模型，提示 /help（避免把「/xxx」当聊天内容灌给角色）。
        return reply(`不认识命令 ${verb}。发 /help 查看可用命令。`)
    }
  }
}

/**
 * 判定一条入站消息是否「机器人命令候选」。
 *
 * 与 dsh-im 一致：纯文字、单行、以 / 开头。只在私聊（c2c）响应——群聊没有
 * 可靠的「@ 我」信息，避免误触发。
 *
 * @param {object} input
 * @param {object} input.message SDK 入站消息。
 * @param {object} [input.config] 生效配置（botCommands 开关）。
 * @returns {boolean}
 */
export function isBotCommandCandidate({ message, config = {} }) {
  if (config.botCommands === false) return false
  if (message?.kind === 'group') return false
  const text = typeof message?.content === 'string' ? message.content : ''
  // 命令必须顶格（以 / 开头）：前导空白的消息当作普通聊天，避免误触发。
  return text.startsWith('/') && !text.includes('\n')
}

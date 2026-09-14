/**
 * 主动开口的「写回捕获」。
 *
 * 为什么需要这一层：`agent.followup()` 只有唤起、没有回执——它不返回角色写了什么。
 * 而主动回合的文本不会走 IM 投递（dsh-im 的会话同步只推用户在 DSH 里发起的回合），
 * 所以插件必须自己从 session 事件里把这段话取回来，再决定怎么发出去。
 *
 * 提取成独立模块是为了可测：本模块只依赖「事件流 + 一个定时器」，
 * 不需要真实的 agent 就能验证结算时机（turn/end 立即结算、超时兜底、空写回）。
 */

/** 从 assistant 消息的 content 块里取出纯文本。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/** 取会话 id；拿不到就整层静默关闭（不猜、不串会话）。 */
export function sessionIdOf(session) {
  const id = session?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * 安装捕获器。
 *
 * @param {object} ctx Cordis 上下文（需有 `on`）
 * @param {object} [options]
 * @param {string} [options.name] 插件名，仅用于错误信息
 * @returns {{begin: (sessionId: string, waitMs: number) => Promise<string>, dispose: () => void, size: () => number}}
 */
export function installProactiveCapture(ctx, { name = 'hds-interlude' } = {}) {
  /** @type {Map<string, {parts: string[], settle: () => void}>} */
  const captures = new Map()

  const onEvent = (session, event) => {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const capture = captures.get(sessionId)
    if (!capture) return

    if (event?.type === 'assistant/message') {
      // interrupted 的前缀也算数：角色确实说出了这句话。
      const text = textOfContent(event.data?.message?.content)
      if (text) capture.parts.push(text)
      return
    }
    // 主动回合结束就结算，不拖着等超时——否则投递要被拖满 waitForTurnMs。
    if (event?.type === 'turn/end') capture.settle()
  }

  const disposeEvent = typeof ctx?.on === 'function'
    ? ctx.on('session/event', onEvent, { global: true })
    : undefined

  /**
   * 开一个捕获窗口。
   *
   * 同一会话上重复调用会先把上一个窗口结算掉——否则旧窗口会一直挂到超时，
   * 并在下一次 assistant/message 时把两轮的话混在一起。
   *
   * @returns {Promise<string>} 角色这一轮写出的完整文本；超时或空写回返回空串。
   */
  function begin(sessionId, waitMs) {
    if (!sessionId) return Promise.resolve('')

    const previous = captures.get(sessionId)
    if (previous) previous.settle()

    let settled = false
    let timer = null
    let resolveText
    const promise = new Promise((resolve) => { resolveText = resolve })

    const capture = {
      parts: [],
      settle: () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        captures.delete(sessionId)
        resolveText(capture.parts.join('\n').trim())
      },
      // 唤起失败时用：立刻结算成空串并摘掉窗口，别让它挂满超时。
      cancel: () => capture.settle(),
    }

    captures.set(sessionId, capture)
    const wait = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 90_000
    timer = setTimeout(capture.settle, wait)
    // 定时器不该拖住进程退出。
    if (timer && typeof timer.unref === 'function') timer.unref()

    return promise
  }

  return {
    begin,
    size: () => captures.size,
    dispose: () => {
      for (const capture of [...captures.values()]) capture.settle()
      captures.clear()
      disposeEvent?.()
    },
  }
}

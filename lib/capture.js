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

import { imageOfToolCall } from './qq-im/say.js'

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
 * 除了 assistant 正文，还要捕获两类工具调用：
 *   - **`interlude_say`**：要发出去的话（「从根上分离」的关键——正文只当故事）；
 *   - **`interlude_send_image`**：要发出去的**图片/表情包**。
 *
 * 为什么主动路径也要收图片：角色在到点关心、生活推进时「发张表情」是很自然的
 * 表达（"说一句 + 甩张图"）。早先这里只收文本，于是主动回合里模型调了发图工具
 * 也被丢掉——而它自己以为发出去了（工具返回"已记下…将发送"）。
 *
 * @param {object} ctx Cordis 上下文（需有 `on`）
 * @param {object} [options]
 * @param {string} [options.name] 插件名，仅用于错误信息
 * @param {string} [options.sayTool] 发言工具的名字（默认 interlude_say）。
 * @param {string} [options.imageTool] 发图工具的名字（默认 interlude_send_image）。
 * @param {Function} [options.resolveSticker] 表情名 → 本地路径（见 say.js 的说明）。
 * @returns {{begin: (sessionId: string, waitMs: number) => Promise<{text: string, speech: string[], items: Array}>,
 *   dispose: () => void, size: () => number}}
 */
export function installProactiveCapture(ctx, {
  name = 'hds-interlude', sayTool = 'interlude_say', imageTool = 'interlude_send_image', resolveSticker,
} = {}) {
  /** @type {Map<string, {parts: string[], speech: string[], items: Array, settle: () => void}>} */
  const captures = new Map()

  /** 从 tool/call 的 arguments（JSON 字符串）里取出要发出的那几句话。 */
  const speechOfCall = (event) => {
    if (event?.data?.name !== sayTool) return []
    const raw = event.data?.arguments
    if (typeof raw !== 'string' || !raw.trim()) return []
    let parsed
    try { parsed = JSON.parse(raw) } catch { return [] }
    const text = parsed?.text
    if (typeof text !== 'string' || !text.trim()) return []
    // 换行表示另起一条消息——与 IM 的「一条一事」一致。
    return text.split('\n').map(line => line.trim()).filter(Boolean)
  }

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
    if (event?.type === 'tool/call') {
      const speech = speechOfCall(event)
      if (speech.length) {
        capture.speech.push(...speech)
        capture.items.push(...speech)
        return
      }
      // 发图工具：图片条目不参与自言自语闸（那是给文字用的），只进 items。
      const image = imageOfToolCall(event, imageTool, { resolveSticker })
      if (image) capture.items.push(image)
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
   * @returns {Promise<{text: string, speech: string[], items: Array<string|object>}>}
   *   `text` 是这一轮写出的完整正文（含故事，供落盘/判定用）；`speech` 是模型通过
   *   interlude_say 明确要发出去的话；`items` 是**有序**的投递条目表
   *   （文字与图片按调用顺序交错），可直接喂给 `deliverToIm`。
   *   超时或空写回返回空值。
   */
  function begin(sessionId, waitMs) {
    if (!sessionId) return Promise.resolve({ text: '', speech: [], items: [] })

    const previous = captures.get(sessionId)
    if (previous) previous.settle()

    let settled = false
    let timer = null
    let resolveText
    const promise = new Promise((resolve) => { resolveText = resolve })

    const capture = {
      parts: [],
      speech: [],
      items: [],
      settle: () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        captures.delete(sessionId)
        resolveText({
          text: capture.parts.join('\n').trim(),
          speech: [...capture.speech],
          items: [...capture.items],
        })
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

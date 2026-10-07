/**
 * 发言判定层 —— 「什么才算角色说出去的话」的**唯一权威**。
 *
 * 这是整个 IM 通道存在的理由，其余都是接线。
 *
 * ## 为什么需要它
 *
 * 同一个 bug 在旧架构下出现过三次，每次形态不同、位置不同：
 *   ① 模型把思考写成正文 → 到点提醒路径逐字投递；
 *   ② 模型在思考里用引号列候选台词 → 故事续写路径提取误判；
 *   ③ 同上形态 → dsh-im 的 sessionSync 把整段正文镜像出去。
 *
 * 前两次都在补判据。第三次暴露的是结构问题：
 * **「思考」和「要说的话」共用同一个文本通道**，于是任何下游消费者都可能
 * 把思考误当成发言。判据是对文本形态的猜测，而形态是无穷的——
 * 补丁永远追不上模型的下一种写法。
 *
 * ## 本模块的解法
 *
 * 把「说什么」从一个**需要推断**的问题，变成一个**显式声明**的问题：
 *   - 正文（assistant/message）= 故事 / 旁白 / 思考 —— **永不参与投递**；
 *   - `interlude_say` 工具调用 = 真正要说的话 —— **唯一的对外通道**。
 *
 * 规则只有一条：**不调用 interlude_say，就什么都发不出去。**
 *
 * ## 降级策略（`sayFallback`）
 *
 * 必须承认的现实：模型可能忘记调用工具。
 *   - `strict`（默认）：没调工具 → 什么都不发。宁可偶尔少说一句，
 *     也不让思考漏出去。
 *   - `loose`：退回「整行引号」提取 + 自言自语闸。**实测会复现全部三次事故**，
 *     因为它把判据重新放回了链路上（见 test/verify-accidents.mjs）。
 *     只作过渡期观测工具调用率用。
 *
 * ## 与 hds-interlude 已有实现的关系（合并要点）
 *
 * 本模块**不重复实现**下面两件事，而是复用 hds-interlude 里已有的、
 * 经过线上事故打磨的版本：
 *   - `looksLikeSelfNarration` —— 来自 `../story.js`。那边有「整段都是旁白」
 *     「复述了提示词里的内部词汇」「把『要不要开口』当成话题」「第一人称
 *     对自己宣告不发（但有第二人称就放过）」等一批实战判据。
 *   - `cleanImText` / `NARRATION_LINE` —— 来自 `../im.js`。清洗语义必须与
 *     投递前的清洗**完全一致**，否则会出现「提取时判成台词、清洗时又判成旁白」
 *     这种自相矛盾（im.js 的注释专门警告过这件事）。
 *
 * 纯函数、无副作用、可单独测试。
 *
 * @module dsh-hds-interlude/qq-im/say
 */

import { cleanImText } from '../im.js'
import { looksLikeSelfNarration } from '../story.js'
import { looksLikeImageSource, normalizeImageSource } from './outbound.js'

/** 本通道默认的发言工具名。与 hds-interlude 的 interlude_say 对齐。 */
export const DEFAULT_SAY_TOOL = 'interlude_say'

/** 本通道默认的「发表情包」工具名。 */
export const DEFAULT_IMAGE_TOOL = 'interlude_send_image'

/** 支持的语气：strict 只认工具，loose 允许从正文里猜。 */
export const FALLBACK_STRICT = 'strict'
export const FALLBACK_LOOSE = 'loose'

/** 把 hds-interlude 的判据结果原样透出（保持同一份语义，不另起一套）。 */
export { looksLikeSelfNarration }

/**
 * 逐行清洗：删掉旁白、动作、Markdown 包装，只留下「说出口的话」。
 *
 * 直接复用 `im.js` 的 `cleanImText`——**必须**是同一个实现：
 * 上游投递前的清洗与这里的清洗若不一致，同一段文本会在两处得到不同结论。
 *
 * @param {string} input 原始文本。
 * @returns {string} 逐行清理后的文本；空串表示这条不该出现在 IM 里。
 */
export function cleanSayText(input) {
  return cleanImText(input)
}

/**
 * 从一条 `tool/call` 事件的 arguments（JSON 字符串）里取出要发出的话。
 *
 * 这是 strict 模式**唯一**的内容来源。
 *
 * @param {object} event 会话事件（`type === 'tool/call'`）。
 * @param {string} [sayTool] 发言工具名。
 * @returns {string[]} 换行已拆好的台词列表；空数组表示这条调用不是发言/无可发内容。
 */
export function speechOfToolCall(event, sayTool = DEFAULT_SAY_TOOL) {
  if (event?.type !== 'tool/call') return []
  if (event?.data?.name !== sayTool) return []
  const raw = event.data?.arguments
  if (typeof raw !== 'string' || !raw.trim()) return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 参数不是合法 JSON：宁可什么都不发，也不猜。
    return []
  }
  const text = parsed?.text
  if (typeof text !== 'string' || !text.trim()) return []

  // 逐行清洗——**这里是第二道防线**，不是多余的洁癖。
  //
  // 工具通道挡得住「正文泄漏」，但挡不住「模型把思考塞进工具参数」：
  // 它完全可能写 `{ text: "（她犹豫了一下）\n在吗" }`，把旁白连同台词一起提交。
  // 旁白是写给自己的，不该出现在聊天窗口里，所以仍要按同一套语义清洗。
  // （线上事故 ② 的形态正是「思考里用引号列候选台词」，这里是它的近亲。）
  const lines = []
  for (const line of text.split('\n')) {
    const cleaned = cleanImText(line)
    if (!cleaned) continue
    // 换行表示另起一条消息——与 IM 的「一条一事」语义一致。
    for (const part of cleaned.split('\n')) {
      const item = part.trim()
      if (item) lines.push(item)
    }
  }
  return lines
}

/**
 * 从工具调用的 arguments 里取出生文本（只用于判断「模型是否调了工具」）。
 *
 * @returns {string|undefined} 干净的工具参数文本；不是发言调用则为 undefined。
 */
export function sayArgumentOfToolCall(event, sayTool = DEFAULT_SAY_TOOL) {
  if (event?.type !== 'tool/call') return undefined
  if (event?.data?.name !== sayTool) return undefined
  const raw = event.data?.arguments
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.text === 'string' ? parsed.text : undefined
  } catch {
    return undefined
  }
}

/**
 * **本模块的主入口**：从一轮会话事件里判定「这一轮要对用户说什么」。
 *
 * 调用方（通道入口）负责收集事件，本函数负责裁定。纯函数，可单测。
 *
 * @param {object} input
 * @param {Array<object>} input.events 本轮收集到的会话事件（按时间顺序）。
 * @param {string} [input.assistantText] 本轮 assistant 正文（故事/思考）。
 * @param {string} [input.sayFallback] `'strict'`（默认）或 `'loose'`。
 * @param {string} [input.sayTool] 发言工具名，默认 `interlude_say`。
 * @returns {{
 *   messages: string[],
 *   source: 'tool'|'loose-text'|'none',
 *   called: boolean,
 *   leaked: boolean,
 *   reason?: string,
 * }}
 *   `messages` 为空表示这一轮什么都不发。
 *   `called` 是「模型是否调了工具」——用于统计调用率、决定何时切 strict。
 *   `leaked` 只可能出现在 loose 模式（strict 下结构上不可能）。
 */
export function decide({ events = [], assistantText = '', sayFallback = FALLBACK_STRICT, sayTool = DEFAULT_SAY_TOOL } = {}) {
  const mode = sayFallback === FALLBACK_LOOSE ? FALLBACK_LOOSE : FALLBACK_STRICT

  // ① 工具通道优先——**两种模式都先看它**。
  //    这是「显式声明 > 形态猜测」的体现：只要模型说了，就用它说的。
  const fromTool = []
  let called = false
  for (const event of Array.isArray(events) ? events : []) {
    const speech = speechOfToolCall(event, sayTool)
    if (speech.length) {
      called = true
      fromTool.push(...speech)
    } else if (sayArgumentOfToolCall(event, sayTool) !== undefined) {
      // 调了工具但参数为空：仍然算「调过」——影响调用率统计。
      called = true
    }
  }
  if (fromTool.length) {
    return { messages: fromTool, source: 'tool', called: true, leaked: false }
  }

  // ② strict：没有工具调用 → **什么都不发**。这是结构保证，不是判据。
  //    正文（含思考）在这里被完整丢弃——它从来就没进入投递链路。
  if (mode === FALLBACK_STRICT) {
    return { messages: [], source: 'none', called, leaked: false, reason: called ? 'empty-speech' : 'no-tool-call' }
  }

  // ③ loose：过渡期的兼容路径，从正文里猜。
  //    注意这条路径**重新引入了判据**，泄漏风险随之回来——它只该短期存在。
  //    （test/verify-accidents.mjs 实测：三次事故形态在这条路径上全部复现。）
  const cleaned = cleanImText(assistantText)
  if (!cleaned) return { messages: [], source: 'none', called, leaked: false, reason: 'no-content' }

  const lines = []
  for (const line of cleaned.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const verdict = looksLikeSelfNarration(text)
    if (verdict.leak) {
      // 命中自言自语闸：**整轮放弃**，而不是只丢掉这一行。
      // 整段呈现自述口吻时，剩余的行多半也是思考的碎片，
      // 逐行挑挑拣拣正是旧架构反复出错的地方。
      return { messages: [], source: 'none', called, leaked: true, reason: verdict.reason }
    }
    lines.push(text)
  }
  if (!lines.length) return { messages: [], source: 'none', called, leaked: false, reason: 'no-content' }
  return { messages: lines, source: 'loose-text', called, leaked: false }
}

/**
 * 收集一轮会话事件里所有发言调用的文本（供非回合结束路径使用）。
 *
 * @param {Array<object>} events 会话事件列表。
 * @param {string} [sayTool] 发言工具名。
 * @returns {string[]} 台词列表。
 */
export function collectSpeech(events, sayTool = DEFAULT_SAY_TOOL) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    out.push(...speechOfToolCall(event, sayTool))
  }
  return out
}

/**
 * 从一个 `tool/call` 事件里取出要发送的图片。
 *
 * 与 `speechOfToolCall` 同一套哲学：**显式声明**是唯一来源。模型调用
 * `interlude_send_image` 表示「我要发这张图」，参数里给的来源就是它要发的图。
 *
 * 参数形态（任一即可）：
 *   - `{ url: 'https://…' }`           —— 网络图片；
 *   - `{ file_path: 'D:/pics/a.png' }` —— 本地文件；
 *   - `{ image: '…' }`                 —— 兼容别名，按 URL/路径自动判断。
 *
 * **只接受 http(s) 与本地路径**（校验在 outbound.normalizeImageSource）。`file:` /
 * `data:` 一律拒绝：url 会被交给 QQ 服务器拉取，放行它们等于开一个读本机文件的口子。
 *
 * @param {object} event 会话事件（`type === 'tool/call'`）。
 * @param {string} [imageTool] 发图工具名。
 * @param {object} [options]
 * @param {Function} [options.resolveSticker] `(name) => localPath | undefined`。
 *   把 `interlude_send_image({name})` 的**表情名**解析成本地路径。
 *   为什么不在这里直接找：say.js 是纯函数、不认识表情库目录（那要读配置与磁盘）。
 *   不注入 resolver 时，带 name 的调用会被判为无法解析 —— 上层据此**如实报错**，
 *   而不是静默丢弃（静默丢弃正是修这个 bug 之前的症状）。
 * @returns {object|null} `{kind:'image', source}`；不是发图调用/参数非法返回 null。
 */
export function imageOfToolCall(event, imageTool = DEFAULT_IMAGE_TOOL, options = {}) {
  if (event?.type !== 'tool/call') return null
  if (event?.data?.name !== imageTool) return null
  const raw = event.data?.arguments
  if (typeof raw !== 'string' || !raw.trim()) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 参数不是合法 JSON：宁可什么都不发，也不猜。
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  let candidate = parsed.url ?? parsed.file_path ?? parsed.filePath ?? parsed.image ?? parsed.path ?? parsed.source
  // **表情名路径**：工具文档推荐「最省事的用法是只给 name」，而这里原先不认 name，
  // 于是模型按推荐用法调用时图片被静默丢弃（工具还回答说"已记下…将发送"）。
  // 现在用注入的 resolver 把名字翻成路径。
  if (candidate === undefined || candidate === null) {
    const wanted = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (wanted && typeof options.resolveSticker === 'function') {
      try {
        candidate = options.resolveSticker(wanted) ?? null
      } catch {
        candidate = null
      }
    }
    if (candidate === undefined || candidate === null) return null
  }
  const source = normalizeImageSource(
    typeof candidate === 'string'
      ? candidate
      : { url: candidate?.url, localPath: candidate?.localPath ?? candidate?.file_path },
  )
  if (!source) return null
  // 本地路径必须**看起来像图片**。这里挡的是「模型把一段文本当成路径发过来」，
  // 真正存在性检查留给发送时（那时才知道文件在不在，且要给出可读错误）。
  if (!source.url && !looksLikeImageSource(source)) return null
  return { kind: 'image', source }
}

/**
 * 按**模型调用顺序**收集这一轮的发言与图片，产出有序条目列表。
 *
 * 为什么需要有序而不是「文本一堆、图片一堆」：真人聊天里「先甩张图、再补一句」
 * 和「先说一句、再甩张图」是不同的语气。分开收集会把顺序抹平，模型就没法表达
 * 这种节奏。这里的顺序就是事件在会话里的自然顺序。
 *
 * 文本条目是**字符串**（与既有投递链兼容），图片是 `{kind:'image', source}`。
 *
 * @param {Array<object>} events 事件列表。
 * @param {object} [options]
 * @param {string} [options.sayTool] 发言工具名。
 * @param {string} [options.imageTool] 发图工具名。
 * @param {Function} [options.resolveSticker] 表情名 → 本地路径（见 imageOfToolCall）。
 * @returns {{items: Array<string|object>, texts: string[], images: object[]}}
 */
export function collectOrderedItems(events, { sayTool = DEFAULT_SAY_TOOL, imageTool = DEFAULT_IMAGE_TOOL, resolveSticker } = {}) {
  const items = []
  const texts = []
  const images = []
  for (const event of Array.isArray(events) ? events : []) {
    for (const line of speechOfToolCall(event, sayTool)) {
      items.push(line)
      texts.push(line)
    }
    const image = imageOfToolCall(event, imageTool, { resolveSticker })
    if (image) {
      items.push(image)
      images.push(image)
    }
  }
  return { items, texts, images }
}

/**
 * 取出一轮里的所有图片条目（按调用顺序）。
 *
 * @param {Array<object>} events 事件列表。
 * @param {string} [imageTool] 发图工具名。
 * @param {Function} [resolveSticker] 表情名 → 本地路径（见 imageOfToolCall）。
 * @returns {object[]} 图片条目列表。
 */
export function collectImages(events, imageTool = DEFAULT_IMAGE_TOOL, resolveSticker) {
  return collectOrderedItems(events, { imageTool, resolveSticker }).images
}

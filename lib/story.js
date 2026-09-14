/**
 * 故事续写 / 发言 的判定层。
 *
 * 为什么有这一层：
 * 改版之前，「自动生活推进」= 唤起角色 → 角色写一段话 → **整段直投聊天软件**。
 * 于是每 40 分钟，聊天窗口里就会多出一条没头没尾的消息（CONFIGURATION.md 里
 * 记的那个顾虑：「否则每 40 分钟一条无端消息」）。而关掉投递并不能让消息消失，
 * 只会让角色把话说给空气听（session-58be9b68 第 7 轮）。
 *
 * 现在的定位分开了：
 *   - **写故事**：按「写故事间隔」唤起角色续写一段生活，这段文字留在 DSH 会话里，
 *     是叙事（可以有旁白、动作、场景），不发给用户；
 *   - **发消息**：只有在这段续写里**角色确实说了要发给对方的整句话**时，才把它
 *     剥出来投递，并且受「发消息间隔」与每日配额约束。
 *
 * 判定是**确定性的**：不依赖模型记得调用某个工具（本项目线上已经因为「模型偶尔
 * 忘记调 interlude_plan」栽过一次，见 CONFIGURATION.md），只依赖文本本身的形态——
 * 「整行只包含一句用引号括起来的话」算发言，其余算叙事。
 *
 * 与 im.js 的分工：
 *   - story.js 决定「这一轮要不要发、发哪几句」（提取 + 门控）；
 *   - im.js 决定「发出去的话怎么切成一条条短消息」（清洗 + 分条）。
 *
 * 纯函数，无副作用，可单独测试。
 *
 * @module dsh-hds-interlude/story
 */

import { cleanImText, NARRATION_LINE } from './im.js'

/** 成对引号：全角引号、角括号、半角双引号。半角单引号太容易误判（英文缩写、所有格），不收。 */
const QUOTE_PAIRS = [
  ['\u201c', '\u201d'], // “ ”
  ['\u300c', '\u300d'], // 「 」
  ['\u300e', '\u300f'], // 『 』
  ['"', '"'],
]

/** 去掉一层 Markdown 强调标记（**x** / __x__ / *x* / _x_）。 */
const EMPHASIS_WRAP = /^(?:\*\*|__|\*|_)([\s\S]*?)(?:\*\*|__|\*|_)$/

/** 纯装饰行（分隔线）不算叙事内容。 */
const DECORATION = /^\s*[-—–*_=~]{3,}\s*$/

/**
 * 一行是不是「旁白 / 动作」——整行都是括号包着的内容。
 *
 * 只用于混写行的判断：`（她笑了一下）“你回来啦”` 里，前半段是旁白、后半段是台词。
 * 反过来（台词后面接旁白）分不清旁白要不要一起发出去，所以那种一律判成叙事。
 */
function isNarrationPrefix(value) {
  return /^\s*(?:[（(【\[][^）)】\]]*[）)】\]]|[（(【\[][^）)】\]]*)\s*$/.test(value)
}

/** 一行是不是「整句引语」，是就返回引号里的内容。 */
function quotedInner(line) {
  for (const [open, close] of QUOTE_PAIRS) {
    if (line.length > open.length + close.length && line.startsWith(open) && line.endsWith(close)) {
      const inner = line.slice(open.length, line.length - close.length).trim()
      if (inner) return inner
    }
  }
  return undefined
}

/**
 * 判断一行是不是「整句台词」。
 *
 * 允许外面再包一层 Markdown 强调（「**"我到了"**」）。剥壳是**反复**的：
 * 用户实际会写 `**"我到了"**`，而先剥壳再判断引号与「先判断引号」不是等价的——
 * 前者才是这里的顺序。
 *
 * @param {string} raw 原始行。
 * @returns {string|undefined} 台词内容（去掉引号、两端空白后非空）；否则 undefined。
 */
export function extractQuotedLine(raw) {
  if (typeof raw !== 'string') return undefined
  let line = raw.trim()
  if (!line) return undefined

  for (let depth = 0; depth < 2; depth += 1) {
    const direct = quotedInner(line)
    if (direct) return direct
    const wrapped = EMPHASIS_WRAP.exec(line)
    if (!wrapped || !wrapped[1].trim()) return undefined
    line = wrapped[1].trim()
  }
  return quotedInner(line)
}

/**
 * 从一段续写里剥出「角色对用户说的那几句话」。
 *
 * @param {string} text 角色这一轮写出的完整文本。
 * @returns {string[]} 按出现顺序排列的台词；空数组表示这一轮角色只是活着，没有对用户说话。
 */
export function extractSpeech(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const out = []
  // 代码块在聊天里是无意义噪声，也永远不是台词。
  const body = text.replace(/```[\s\S]*?```/g, '')
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const quoted = extractQuotedLine(raw)
    if (quoted) { out.push(quoted); continue }
    // 兜底：模型把台词写在已有旁白行里（「（她笑了一下）"你回来啦"」）。
    // 只认「有旁白在前、引语在末尾」这一种形态——反过来（台词后接旁白）
    // 分不清旁白是不是要被一起发出去，宁可判成叙事。
    const bare = raw.trim()
    if (!bare || DECORATION.test(bare)) continue
    if (bare.startsWith('\u201c') || bare.startsWith('\u300c') || bare.startsWith('"')) continue
    const tail = /[\u201c\u300c"]([^\u201d\u300d"]{1,200})[\u201d\u300d"]\s*$/.exec(bare)
    if (tail && isNarrationPrefix(bare.slice(0, tail.index))) out.push(tail[1].trim())
  }
  return out
}

/**
 * 去掉一段文字里的旁白/动作，看剥干净之后还剩不剩内容。
 *
 * 复用 im.js 的清洗器而不是另写一套：两条路径（续写里的台词提取、投递前的清洗）
 * 对「什么算旁白」必须给出一致的答案，否则会出现「判定有话说、发出去却是空的」。
 *
 * @param {string} content 待判定文本（通常是一句台词）。
 * @returns {string} 剥掉旁白与 Markdown 后剩下的字；空串表示这条其实没话说。
 */
export function speechContentOf(content) {
  return cleanImText(content)
}

/* ------------------------------------------------------ 主动开口的正文净化 */

/**
 * 明显的「模型在对我们说话 / 在自言自语」的痕迹。
 *
 * 起因是线上事故（session-58be9b68 turn 33）：到期待办唤起角色后，它把**思考过程**
 * 写成了正文，四条消息全是「用户也没回消息，那就真睡了……」「但系统说『到期待办
 * 到期了』……不发了。」——没有一句是角色在对用户说话。
 *
 * 提示词已经写明「正文即消息」，但提示词不是保证：本项目在「模型忘了调
 * interlude_plan」上已经栽过一次，结论就是**关键行为要有确定性兜底**。
 * 这里于是做最后一道筛：整段看起来是在对系统说话/解释自己的决定，就不发。
 */
const META_TALK_PATTERNS = [
  /待办/,
  /幕间/,
  /系统说|系统提示|提示词/,
  /不发消息|不用再发|不需要再发|不打扰他了|无需再开口|安静就好/,
  /请自然地开口|时机合适/,
  /（?我(?:决定|应该|觉得|想)不?发/,
  /^用户(?:也)?(?:没|已|还)?/m,
  // 「不需要真的再发消息 / 不用再开口了」这类：把「要不要说话」本身当话题，
  // 人正常聊天不会这么说（他那是在对自己复盘，不是在跟你说话）。
  /不用再开口|不需要再开口|不需要真的再|不用真的再/,
]

/**
 * 「把『这条消息要不要发』当成话题」——一次命中就足够判定为自言自语。
 *
 * 与 META_TALK_PATTERNS 分开，是因为这一类的误伤成本极低（正常人不会这么说话），
 * 而漏判的代价很高（思考过程会被逐字发到聊天窗口里）。
 */
const META_SELF_REFERENTIAL = /(?:这条|本条|这句话)?(?:不需要|不用|不必)(?:真的)?再?发(?:消息)?|(?:不需要|不用)再开口/

/**
 * **第一人称的「我决定不说」**——一次命中即判定，与 META_SELF_REFERENTIAL 同级。
 *
 * 起因是只读核查发现的漏网：`我决定不发了。` 已经被 META_TALK_PATTERNS 的
 * `/（?我(?:决定|应该|觉得|想)不?发/` 命中，却因为「命中不足两处」被放行。
 * 这是打分制对**短句**的结构性漏洞：句子越短、越干脆，越不容易凑够两处。
 *
 * 判据是「**跟自己宣告**」，不是「提到不发」——两者的分界线在于**有没有对听话的人说**：
 *
 *   - `我决定不发了。`                → 裸的自我宣告，没有听众，自言自语。
 *   - `那我不发消息了啊，你别嫌我烦`   → 有第二个人称/呼唤对方，是在**跟人聊天**。
 *
 * 所以要求：命中之后**整段里不能再出现第二人称**（你/您/对方的口吻词）。
 * 这一条是必须的——本项目测试里明确保护着「那我不发消息了啊，你别嫌我烦」
 * 这种正常台词，宁可漏判几条例外，也不能让角色变成哑巴。
 */
const META_SELF_DECISION = /(?:^|[。！？!?\s（(])(?:那|所以|嗯|算了)?(?:我|咱)(?:还是|就|决定|觉得|想|应该)?(?:先)?不(?:发|说|开口|打扰|回)(?:了|吧|啊)?/

/** 第二人称：出现它就说明这句话有听众，是在跟人说话。 */
const HAS_SECOND_PERSON = /你|您|你们/

/**
 * **以「用户」开头**——一次命中即判定。
 *
 * 「用户」是插件视角的称呼，角色对本人说话时绝不会管对方叫「用户」。
 * 它出现在句首，只可能是模型跳出来用第三人称复述我们给它看的东西。
 *
 * 同样提到硬判据，是因为短句会撞上「命中两处」那道门槛：
 * `用户一直没回，可能在忙。` 只命中这一处，打分制放行，但它百分之百是自言自语。
 * 要求出现在**行首**（`^` + `m`），所以「我跟用户…」这类不会误伤。
 */
const META_USER_PERSPECTIVE = /^\s*用户/m

/**
 * 一出现就足以判定为「在对系统说话」的词——正常人不会这么跟人聊天。
 *
 * `待办` 是这里最典型的：它是插件的内部词汇，角色对用户说话时不会用；
 * 它出现在正文里，只可能是模型在复述我们给它的提示词。同类还有「幕间」「提示词」。
 * 单独列出来是因为上面那套「命中两处 + 够长」的打分对短句会漏
 * （「用户没回，那我也不发了。待办的事其实已经说过了。」就是漏网的那句）。
 *
 * `系统说` 曾经是裸的，会把「公司系统说周末要升级」这类**正常聊天**误伤成
 * 自言自语——误伤比漏判更疼，因为静默跳过之后角色直接变哑巴。收紧为
 * 「系统 + 说/提示/让我」这种**插件口吻**才判定：正常聊天里的「系统」
 * 后面接的是「说了算」「说周末」，不会接「我」。
 */
const META_HARD_TELLS = /待办|幕间块|<\/?幕间>|提示词|系统(?:说|提示|让|要求|叫)(?:我|这条|这轮|本)|系统说这/

/**
 * 判断一段主动开口的正文是不是「在对自己/对系统说话」，而不是在对用户说话。
 *
 * 判据刻意保守：默认要求**命中至少两处**明显的元叙述特征——单个词太容易误伤
 * （角色正常地说「我不打扰你了」正是在跟用户说话）。
 *
 * 但有一类例外：**把「要不要说话」本身当成话题**。人正常聊天不会说
 * 「这条不需要真的再发消息，不用再开口了」——那是他在对自己复盘。
 * 这一类单独命中一次就足够。
 *
 * @param {string} text 角色这一轮写出的完整文本。
 * @returns {{leak: boolean, reason?: string}} 判定结果。
 */
export function looksLikeSelfNarration(text) {
  if (typeof text !== 'string' || !text.trim()) return { leak: false }

  // 旁白判定要在清洗**之前**做：cleanImText 会把整行括号旁白整行删掉，
  // 删完之后就再也看不出「这段其实全是内心戏」了。所以先留个原样快照。
  const raw = text.replace(/\r\n?/g, '\n')

  const cleaned = cleanImText(text)
  if (!cleaned) {
    // 洗完之后什么都不剩 = 整段都是旁白/动作/装饰线。
    // 这不是「安静地没话说」，是模型把内心戏写成了正文——同样是自言自语，同样不该发。
    // （原先这里直接 return { leak: false }，纯旁白因此整段被投递出去。）
    return looksLikePureNarration(raw)
      ? { leak: true, reason: `self-narration(整段都是旁白/动作, 无台词, ${raw.trim().length} 字)` }
      : { leak: false }
  }
  const body = cleaned.replace(/\s+/g, ' ').trim()

  const hits = META_TALK_PATTERNS.filter(pattern => pattern.test(body))
  // 插件的内部词汇出现在正文里：只可能是模型在复述我们给它的提示词。
  if (META_HARD_TELLS.test(body)) {
    return { leak: true, reason: `self-narration(复述了提示词里的内部词汇, ${body.length} 字)` }
  }
  // 「这条消息要不要发」被当成话题本身：一次命中即可判定。
  if (META_SELF_REFERENTIAL.test(body)) {
    return { leak: true, reason: `self-narration(把「要不要开口」当成话题, ${body.length} 字)` }
  }
  // 第一人称的「我决定不发了」：短句也会漏，所以一次命中即判定。
  // 但整段里只要有第二人称，就说明它在跟人说话（「那我不发消息了啊，你别嫌我烦」），放过。
  if (META_SELF_DECISION.test(body) && !HAS_SECOND_PERSON.test(body)) {
    return { leak: true, reason: `self-narration(对自己宣告不发, ${body.length} 字)` }
  }
  // 句首的「用户…」：插件视角的称呼，角色不会这么叫对方。
  if (META_USER_PERSPECTIVE.test(body)) {
    return { leak: true, reason: `self-narration(以「用户」指代对方, ${body.length} 字)` }
  }
  // 单条命中不足以判定：正常聊天里「不打扰你了」也是人话。
  if (hits.length < 2) return { leak: false }

  const chattiness = /[?？!！]|啊|吧|呢|吗|了|哦|嗯|哈/.test(body) ? 1 : 0
  const long = body.length >= 40
  if (long || hits.length >= 3) {
    return { leak: true, reason: `self-narration(${hits.length} 处特征, ${body.length} 字)` }
  }
  if (chattiness === 0 && long) return { leak: true, reason: 'self-narration(无聊天口吻)' }
  return { leak: false }
}

/**
 * 判断一段（洗掉旁白之后就什么都不剩的）原文，是不是「整段旁白/内心戏」。
 *
 * 判据刻意保守，**两道都要过**：
 *   1. 每一行都是旁白行（括号/方括号包起来）；
 *   2. 至少要**两行**，或者单行但够长（≥20 字）。
 *
 * 为什么不是「只要有旁白就算」：角色正常写一句 `（今天真累啊，不过还行）`
 * 也是全旁白，但那更可能是「这一轮没话说」而不是自言自语。误伤等于角色不会说话，
 * 所以只在**看得出是在写一段内心戏**（成段的旁白、或足够长的独白）时才判定。
 *
 * @param {string} raw 未经清洗的原文。
 * @returns {boolean}
 */
function looksLikePureNarration(raw) {
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (!lines.every(line => NARRATION_LINE.test(line))) return false
  return lines.length >= 2 || lines.join('').length >= 20
}

/**
 * 把提取到的台词行按「发送间隔」判定这一轮要不要投递。
 *
 * 判定顺序即优先级，任一关不过都只写故事、不打扰用户：
 *   1. 开关：`runtime.autoAdvanceEnabled`（true 才写故事）/ `im.enabled`（true 才允许自动发消息）
 *   2. 绑定：没有聊天软件绑定 → 永远不发（普通 Web 会话没有收件人）
 *   3. 间隔：距上次自动投递不足 `im.messageIntervalMinutes` → 攒着，留给下一次续写
 *   4. 配额：当天主动联系名额用光 → 攒着（到点的承诺型提醒走另一条路，不受这里影响）
 *   5. 台词：这一轮没有台词 → story-only（这正是「只写故事不发消息」那条路径）
 *
 * @param {object} args
 * @param {string} args.text 角色这一轮写出的完整文本。
 * @param {boolean} args.bound 本会话是否绑定了聊天软件。
 * @param {number} [args.lastMessageAt] 上次**自动投递**的时刻（epoch 毫秒）。
 * @param {number} [args.messageIntervalMinutes] 发消息间隔（分钟）。
 * @param {number} [args.reachedOut] 当天已用掉的主动联系名额。
 * @param {number} [args.maxPerDay] 每日主动联系上限。
 * @param {boolean} [args.autoMessageEnabled] 是否允许自动把角色的发言发出去。
 * @param {boolean} [args.advanceEnabled] 是否允许写故事。
 * @param {number} [args.now] 当前时刻（注入以便测试）。
 * @returns {{mode: 'story-only'|'speak'|'skip', messages: string[], reason: string, lines: number, waitedMinutes?: number}}
 *   - `skip`：连故事都不该写（开关关着）；
 *   - `story-only`：写故事，但不发消息；
 *   - `speak`：写故事，并把 `messages` 发出去。
 */
export function decideAdvanceDelivery({
  text,
  bound,
  lastMessageAt = 0,
  messageIntervalMinutes = 120,
  reachedOut = 0,
  maxPerDay = 6,
  autoMessageEnabled = true,
  advanceEnabled = true,
  now = Date.now(),
} = {}) {
  const lines = extractSpeech(text)
  const messages = []
  for (const line of lines) {
    const content = speechContentOf(line)
    if (content) messages.push(content)
  }

  if (!advanceEnabled) {
    return { mode: 'skip', messages: [], reason: 'advance-disabled', lines: lines.length }
  }
  // 台词与门控的顺序很重要：先算出「这一轮有没有话说」，再判发不发。
  // 反过来的话，间隔内的 story-only 会连「有没有话说」都不算，面板上就看不出区别。
  if (!autoMessageEnabled) {
    return { mode: 'story-only', messages, reason: 'auto-message-disabled', lines: lines.length }
  }
  if (!bound) {
    return { mode: 'story-only', messages, reason: 'no-binding', lines: lines.length }
  }
  if (messages.length === 0) {
    return { mode: 'story-only', messages: [], reason: 'no-speech', lines: 0 }
  }

  const intervalMs = Math.max(0, finiteOr(messageIntervalMinutes, 120)) * 60_000
  const since = Number.isFinite(lastMessageAt) && lastMessageAt > 0 ? now - lastMessageAt : Infinity
  if (since < intervalMs) {
    return {
      mode: 'story-only',
      messages,
      reason: 'message-interval',
      lines: lines.length,
      waitedMinutes: Math.floor(since / 60_000),
    }
  }

  if (reachedOut >= maxPerDay) {
    return { mode: 'story-only', messages, reason: 'daily-quota', lines: lines.length }
  }

  return { mode: 'speak', messages, reason: 'speak', lines: lines.length }
}

/** 数字兜底（注意 0 是合法值，不能被吞掉）。 */
function finiteOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

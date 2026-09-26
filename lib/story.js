/**
 * 故事续写 / 发言 的判定层。
 *
 * 为什么有这一层：
 * 改版之前，「自动生活推进」= 唤起角色 → 角色写一段话 → **整段直投聊天软件**。
 * 于是每 40 分钟，聊天窗口里就会多出一条没头没尾的消息（CONFIGURATION.md 里
 * 记的那个顾虑：「否则每 40 分钟一条无端消息」）。而关掉投递并不能让消息消失，
 * 只会让角色把话说给空气听（session-xxx 第 7 轮）。
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
 * 起因是线上事故（session-xxx turn 33）：到期待办唤起角色后，它把**思考过程**
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
// 这个列表服务于下面「打分制」那一关（命中两处以上才算）。
//
// 已知其中三条与下面的硬判据**语义重叠**：
//   `/系统说|系统提示/` → META_HARD_TELLS
//   `/^用户…/m`         → META_USER_PERSPECTIVE
//   `/（?我…不?发/`      → META_SELF_DECISION
// 重叠本身无害（硬判据在前，命中即返回）。**但不要据此断定它们是死代码**：
// 硬判据是后加的，判分那一关在历史上承担过全部判定；保留重叠部分是为了不在
// 收紧判据时同时改变打分口径。真要删，应当连同打分制一起重新评估，
// 而不是单独摘掉几条 —— 那样会在「哪些输入还能走到打分」上引入难以察觉的变化。

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
 * **英文的元叙述判据**——一次命中即判定。
 *
 * 线上事故（回复错乱）：模型把 thinking 写成了英文，整段思考被发进 QQ：
 *
 *     This is story-only mode. The pending item i16 is malformed. I shouldn't
 *     call interlude_say. Just continue the story. Let me write her life...
 *     <timeline_plan>{"beats":[...]}
 *
 * 上面那批判据**全是中文**（待办/幕间/提示词/用户），英文思考一个字都匹配不到，
 * 闸门直接放行。所以必须补一组英文判据——判据的语言要跟着**模型的思考语言**走，
 * 不能假设它永远用中文复盘。
 *
 * 选择保守且专指的词：
 *   - `story-only` / `interlude_say` / `timeline_plan` / `pending item`：插件自己的
 *     内部词汇，角色跟人聊天绝不会说；
 *   - `I should(n't)` / `Let me`（写/继续/想想）/ `the user`：模型自我复盘的口吻。
 */
const META_ENGLISH_INTERNAL = /story[-\s]?only|interlude_say|interlude_send_image|timeline_plan|pending\s?item|pendingitem|self-narration/i

/**
 * 英文自我复盘口吻。**刻意避开自然口语**：
 *   - `Let me know …`（让我知道）是正常英文台词，必须放过——所以 `Let me`
 *     只在**紧接着写/继续/想/检查**这类动作时才判定；
 *   - `I should / I'll / I need to` 只有在**整段没有第二人称**时才判定
 *     （与中文 META_SELF_DECISION 同一思路）：出现 you/your 说明它在跟人说话。
 */
const META_ENGLISH_SELF_TALK = /(?:^|[.!?]\s+|\n\s*)(?:I\s+(?:should|shouldn't|should not|need to|must|can't|cannot)\b|Let me\s+(?:write|continue|think|check|keep|end|make|see\s+(?:what|if))|the user\s+(?:has|is|said|didn't|hasn't|just)\b)/im

/** 第二人称英文：出现它说明有听众，是在跟人说话。 */
const HAS_SECOND_PERSON_EN = /\byou\b|\byour\b|\byou're\b|\byourself\b/i

/**
 * 模型内部结构标记（`<timeline_plan>…</timeline_plan>`、`<thinking>` 等）。
 * 它们属于提示词协议，不是角色说的话；出现即判定为元叙述。
 */
const META_STRUCTURE_TAG = /<\/?(?:timeline_plan|thinking|think|plan|scratchpad|analysis|reasoning)\b/i

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

  // 模型内部结构标记（<timeline_plan> 等）与英文元叙述：都在清洗**之前**判，
  // 因为这些是「模型在对系统说话」的证据，清洗后照样是台词形态，容易漏。
  if (META_STRUCTURE_TAG.test(raw)) {
    return { leak: true, reason: `self-narration(残留模型内部结构标记, ${raw.trim().length} 字)` }
  }
  if (META_ENGLISH_INTERNAL.test(raw)) {
    return { leak: true, reason: `self-narration(英文思考里出现插件内部词汇, ${raw.trim().length} 字)` }
  }
  if (META_ENGLISH_SELF_TALK.test(raw) && !HAS_SECOND_PERSON_EN.test(raw)) {
    return { leak: true, reason: `self-narration(英文自我复盘口吻, ${raw.trim().length} 字)` }
  }

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

  // 英文元叙述 / 结构标记：清洗后仍可能残留（清洗只剥括号旁白与代码块），再判一次。
  if (META_STRUCTURE_TAG.test(body) || META_ENGLISH_INTERNAL.test(body)) {
    return { leak: true, reason: `self-narration(英文思考残留插件内部词汇/结构标记, ${body.length} 字)` }
  }
  if (META_ENGLISH_SELF_TALK.test(body) && !HAS_SECOND_PERSON_EN.test(body)) {
    return { leak: true, reason: `self-narration(英文自我复盘口吻, ${body.length} 字)` }
  }

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
 * @param {string[]} [args.explicitSpeech] 模型通过 `interlude_say` **明确**要发出去的话。
 *   一旦非空，它就是权威——不再从正文里猜（见下方说明）。
 * @returns {{mode: 'story-only'|'speak'|'skip', messages: string[], reason: string, lines: number, waitedMinutes?: number}}
 *   - `skip`：连故事都不该写（开关关着）；
 *   - `story-only`：写故事，但不发消息；
 *   - `speak`：写故事，并把 `messages` 发出去。
 */
export function decideAdvanceDelivery({
  text,
  explicitSpeech = [],
  bound,
  lastMessageAt = 0,
  messageIntervalMinutes = 120,
  reachedOut = 0,
  maxPerDay = 6,
  autoMessageEnabled = true,
  advanceEnabled = true,
  now = Date.now(),
} = {}) {
  // ① 显式发言优先（「从根上分离」的主路径）。
  //
  // 模型调了 interlude_say，那几句话就是它要发出去的。此时**不再看正文**：
  // 思考与发言走的是两条通道，正文里写什么都不会被误当成发言。
  // 这一条从根上消除了「模型把思考写成正文 -> 引号里的候选被当成台词」那类事故。
  //
  // 仍要过自言自语闸：模型有可能在工具参数里也把思考写进去（少见，但发生过）。
  const explicit = (Array.isArray(explicitSpeech) ? explicitSpeech : [])
    .map(line => speechContentOf(String(line ?? '')))
    .filter(Boolean)

  if (explicit.length) {
    if (looksLikeSelfNarration(explicit.join('\n')).leak) {
      return { mode: 'story-only', messages: [], reason: 'self-narration', lines: 0 }
    }
    return gate(explicit, explicit.length, 'explicit')
  }

  // ② 兼容路径：没有显式发言时，仍从正文里按「整行引号」提取。
  // 保留它是为了不一次改动太多——若模型没调工具，行为与之前完全一致。
  // 先过自言自语闸：整段就是在对自己复盘时，一个字都不要发。
  //
  // 线上第二次泄漏（session-xxx，2026-09-15 23:00）：模型把思考过程
  // 写成了正文，但这次它在思考**里**用引号写了几行候选台词：
  //
  //     我组织一下：
  //     “今天不算，说完就睡”
  //     “你倒管起我来了”
  //
  // extractSpeech 只认「整行引号」，于是把这些**思考里的候选**当成了真台词
  // 挑出来发给了用户。用户收到两句莫名其妙的话，来源却是模型的内心独白。
  if (looksLikeSelfNarration(text).leak && advanceEnabled) {
    return { mode: 'story-only', messages: [], reason: 'self-narration', lines: 0 }
  }

  const lines = extractSpeech(text)
  const messages = []
  for (const line of lines) {
    const content = speechContentOf(line)
    if (content) messages.push(content)
  }

  /**
   * 门控：先算「这一轮有没有话说」，再判发不发。两条分支（显式发言 / 兼容提取）共用。
   *
   * @param {string[]} messages 已清洗过的待发内容。
   * @param {number} lineCount 原始台词行数（面板显示用）。
   * @param {string} via 'explicit' | 'extract'，仅进 reason 便于自检。
   */
  function gate(messages, lineCount, via) {
    if (!advanceEnabled) {
      return { mode: 'skip', messages: [], reason: 'advance-disabled', lines: lineCount }
    }
    // 顺序很重要：先算出「这一轮有没有话说」，再判发不发。
    // 反过来的话，间隔内的 story-only 会连「有没有话说」都不算，面板上就看不出区别。
    if (!autoMessageEnabled) {
      return { mode: 'story-only', messages, reason: 'auto-message-disabled', lines: lineCount }
    }
    if (!bound) {
      return { mode: 'story-only', messages, reason: 'no-binding', lines: lineCount }
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
        lines: lineCount,
        waitedMinutes: Math.floor(since / 60_000),
      }
    }

    if (reachedOut >= maxPerDay) {
      return { mode: 'story-only', messages, reason: 'daily-quota', lines: lineCount }
    }

    return { mode: 'speak', messages, reason: via === 'explicit' ? 'speak-explicit' : 'speak', lines: lineCount }
  }

  return gate(messages, lines.length, 'extract')
}

/**
 * 正文补发：模型把话说在正文里、却没调用 `interlude_say` 时，把那些话捞回来。
 *
 * ## 为什么需要
 *
 * 线上故障（session-xxx，turn 65，2026-09-17 01:39）：用户从 QQ 发「睡了？」，
 * 模型写了两行台词（`被你吵醒了` / `你是不打算睡了？` / `怎么了`）作为**正文**，
 * 但没有调用工具。`sayFallback: 'strict'` 下正文不参与投递，于是判定 `no-speech`，
 * 一个字都没发出去 —— 用户看到的是「角色回了，但 QQ 没收到」。
 *
 * `interlude_say` 是模型**可能忘**的动作；而这段正文是它**真的写出来的话**。
 * 承诺漏记已经有 `commitmentBackstop` 兜底，这里按同一条原则办。
 *
 * ## 边界（都必须满足）
 *
 * 1. **只补「没话说」这一种**。调用方只应在 `reason === 'no-speech'` 时调用它；
 *    被间隔 / 配额 / 关开关拦下的那些**不能**补发，否则会把节流整条绕过去。
 * 2. **只认整行引号台词** —— 复用 `extractSpeech` 的既有判据，不新造一套。
 * 3. **必须过自言自语闸**（正文整体 + 捞出来的句子各过一次），
 *    这是本插件出过两次事故的地方，宁可漏发也不能误发。
 *
 * ## ⚠️ 已知覆盖不到的一类（刻意不补，附实测依据）
 *
 * **模型把台词写成不带引号的裸行**时，本函数**捞不出来** —— 而这恰好就是
 * 上面那次线上故障的形态。不是没想到，而是**做不到安全地捞**：
 *
 *     她愣了一下。              ← 叙事
 *     你怎么才回                 ← 台词？
 *     我等你半天了               ← 台词？
 *
 * 这与正常的故事续写（「她把杯子放下，走到窗边。外面下起了小雨……」）
 * 在**文本形态上不可区分**。而 `looksLikeSelfNarration` 也拦不住它：
 * 实测 `我组织一下：\n"今天不算"` 这类「列候选台词」的判定结果是 `leak: false`
 * （那道闸认的是「用户 / 待办 / 系统」这类**元词汇**，不是引号）。
 *
 * 所以对这一类**只记审计，不补发** —— 见 `lib/index.js` 的 `body-speech-missed` 日志。
 * 真正的修法是让模型别再这么写（`renderSpeechModeLine` 已改成说工具，
 * 见 `lib/render.js` 的说明），而不是靠正则去猜。
 *
 * @param {string} text 模型这一轮的正文。
 * @param {string[]} [explicitSpeech] 已从工具收到的发言（**非空时不补发**，避免重复）。
 * @returns {string[]|null} 可补发的台词；不该补发时返回 null。
 */
export function salvageBodySpeech(text, explicitSpeech = []) {
  // 模型已经调过工具：那是权威通道，正文不该再参与（否则会发两遍）。
  if (Array.isArray(explicitSpeech) && explicitSpeech.length > 0) return null
  if (typeof text !== 'string' || !text.trim()) return null

  // 边界 3：自言自语闸先过。整段就是在对自己复盘时，一个字都不要发。
  if (looksLikeSelfNarration(text).leak) return null

  const lines = extractSpeech(text)
  const messages = []
  for (const line of lines) {
    const content = speechContentOf(line)
    if (content) messages.push(content)
  }
  if (messages.length === 0) return null

  // 边界 3 之二：捞出来的这几句本身也要过闸。
  // 正文整体可能不算自言自语，但被抽出来的那几行**可能**恰好是模型的备选台词清单
  // （事故形态②：模型在正文里用引号列候选）。这一句是那道防线的最后一段。
  if (looksLikeSelfNarration(messages.join('\n')).leak) return null

  return messages
}

/**
 * 正文里**看起来有话要说、但捞不出来**时用的审计判据（不投递，只记日志）。
 *
 * 用途：把「模型忘了调工具」这件事变得**可见**。否则它只会表现为
 * 「用户说 QQ 没收到」，而我们这边日志上一片安静 —— 正是这次排查困难的根源。
 *
 * 刻意做得**宽进**（宁可多报也不要漏报）：只要正文非空、
 * 且不是纯旁白/纯元叙述，就认为「可能漏了一次发言」。
 * 它不产生任何投递后果，所以误报的代价只是日志噪音。
 *
 * @param {string} text 模型这一轮的正文。
 * @param {string[]} [explicitSpeech] 已从工具收到的发言。
 * @returns {boolean} 是否疑似「有话没发出去」。
 */
export function looksLikeMissedSpeech(text, explicitSpeech = []) {
  if (Array.isArray(explicitSpeech) && explicitSpeech.length > 0) return false
  if (typeof text !== 'string' || !text.trim()) return false
  if (looksLikeSelfNarration(text).leak) return false
  return true
}

/** 数字兜底（注意 0 是合法值，不能被吞掉）。 */
function finiteOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}


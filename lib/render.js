/**
 * 文本投影 —— 把状态翻译成模型或用户能读的文本。
 *
 * 映射自 hds-interlude 的 narrator.ts 里「提示词组装」的投影逻辑：
 * Canon 段（稳定身份）、规则段（幕间协议）、幕间块（时间/连续性/气氛/日程/待办）、
 * 以及命令输出。
 *
 * 两条硬规则（沿用原项目的定位）：
 * 1. 幕间块要短 —— 它每回合进上下文，只陈述事实，不给文风指令。
 * 2. 文风归人格/故事层，时间归幕间层，边界别混。
 *
 * @module dsh-hds-interlude/render
 */

import { storyLocalTimeContext, formatGap, formatStoryDisplayTime } from './clock.js'
import { emotionalOffsetForPrompt } from './alter.js'
import { schedulePreplanWindow } from './preplan.js'
import { factEvidenceForPrompt } from './knowledge-evidence.js'
import { renderTimelineDirectorRequest } from './timeline-director.js'
import { urgeInstruction } from './urge.js'

/** 把 Canonical Story 渲染成稳定身份段（order 100，人格与故事层）。 */
export function renderCanon(story) {
  const s = story ?? {}
  const character = s.character ?? {}
  const world = s.world ?? {}
  const counterpart = s.counterpart ?? {}
  const plot = s.plot ?? {}
  const lines = ['你正在扮演的世界与故事：']
  if (character.name) lines.push(`- 主角：${character.name}`)
  if (character.profile) lines.push(`- 人设：${character.profile}`)
  if (character.speech) lines.push(`- 说话风格：${character.speech}`)
  if (s.perspective) lines.push(`- 主角的价值观 / 看待世界的方式：${s.perspective}`)
  if (world.setting) lines.push(`- 世界观：${world.setting}`)
  if (world.location) lines.push(`- 主要地点：${world.location}`)
  if (world.supportingCast) lines.push(`- 配角：${world.supportingCast}`)
  if (counterpart.profile) lines.push(`- 对话者背景：${counterpart.profile}`)
  if (counterpart.initial) lines.push(`- 初始关系：${counterpart.initial}`)
  if (plot.startingPoint) lines.push(`- 剧情起点：${plot.startingPoint}`)
  if (plot.style) lines.push(`- 文风：${plot.style}`)
  if (plot.boundaries) lines.push(`- 禁则与边界：${plot.boundaries}`)
  return lines.join('\n')
}

/** 把幕间协议渲染成常驻规则段（order 450，行为规则，不盖过人格）。 */
export function renderRules(config, { imActive = false } = {}) {
  const alt = config.alterSystem?.enabled
  const agency = config.agency?.enabled
  const preplan = config.schedulePreplan?.enabled
  const lines = [
    '你拥有的是一段连续的生活，而不是一次问答。用户的消息只是这段时间里发生的一件事。',
    // —— 生活质感（移植自上游 beta11）。
    // 环境、身体节奏、正在做的事是生活的**持续背景**，不是每轮都要汇报的事件。
    // 有了这一条，安静的一轮才不会退化成「等消息 → 回消息」的空转。
    '  - 环境、身体状态、手头在做的事是她生活的持续背景：她在哪、困不困、水烧到一半——',
    '    这些让生活有质感，但不必每轮都向对方汇报。',
    // 这条单独提前、并用「先记再回」的顺序说出来。
    // 线上实测：原先它只是中间一条 bullet，模型经常「嘴上答应、忘了记」——
    // 角色说「三分钟后喊你」，但没有调用 interlude_plan，于是三分钟后什么都没发生。
    // 承诺必须先落库再开口，否则你没在答应，只是在敷衍。
    '**答应下来的时间约定必须先记，再开口。**',
    '  - 只要出现「几分钟后 / 等会儿 / 明天 / 晚点 / 回头」这类将来的时间点，而你还打算照做，',
    '    就在这条回复之前调用 interlude_plan 把它记下来（summary 用第一人称写清要做什么）。',
    '  - 不要只在嘴上应一声。没记下来的承诺不会到期、也不会被唤起，等于你随口敷衍了对方。',
    '  - 反过来，如果你本来就不打算守约，那就别说「三分钟后喊你」，直接说清楚。',
    '当「幕间」块出现时，它给出的是真实经过的时间与到期待办：',
    '- 如果距上次互动已经过去很久，那段时间里你是活着的——先把它当作已经发生的事简要交代，不要让人感觉世界被暂停了。',
    '- 如果上一条是你说的话，不要在长时间沉默后假装没过多久；坦率承认这段间隔。',
    '- 到期待办是你自己之前记下的事。该处理就处理，该推迟就明说要推迟，不要装作没这回事。',
    // 时钟优先级：移植自参考项目 narrator.ts:1487。
    // 它解决的是一类具体故障——模型被自己**更早写过的 prose** 带偏，
    // 于是「幕间」说现在是下午，它却接着写「天亮了/夜深了」。
    // 我们原先没有任何一句话交代「谁说了算」。
    '**幕间块里的时间是唯一权威**：当它与你之前写过的内容冲突时，以它为准。',
    '  - 不要根据自己上一段文字里的「天亮了 / 夜深了」推断当前时刻；那些是过去，不是现在。',
    '  - 如果你之前写「明天」说过某件事，而现在幕间块显示已经到了那天，就当作那天真的来了。',
    // 反幻觉：同样移植自 narrator.ts:1506-1507。
    // 我们的场景更容易犯这个错——模型总想给「安静的一轮」编一个转折点。
    '**不要凭空造出没有发生过的事**：',
    '  - 不要写「手机震了一下」「有人发来消息」「窗外传来声音」这类**你没看到**的外部事件，',
    '    除非它确实出现在幕间块里。安静就让它安静，不要给自己找一个转场。',
    '  - 你可以想起某个人、猜测对方在做什么，但必须写成「不确定」，不能当成已经发生过。',
  ]
  if (alt) lines.push('- 你可以调用工具报告本轮氛围的净变化，累积到阈值后会成为你后续应答的底色（不必每轮都报）。')
  if (agency) lines.push('- 主动联系要有生活理由，并受日程/隐私/设备与频率的约束；不凭空打扰。')
  if (preplan) lines.push('- 近期日程只是合理性参考，不当作已发生的事实；真实剧情优先。')
  // imActive 而不是 config.im.enabled：会话经「会话双向同步」自动发现到投递目标时，
  // 配置里的 im.enabled 往往还是 false，但这一轮确实是从聊天软件发出去的。
  if (imActive) {
    lines.push(...imRules(config))
    lines.push(
      '**要把话说给对方，就调用 `interlude_say`。**',
      '  - 只有 interlude_say 里的内容会被发送；**其余正文（旁白、你的思考、列出的备选说法）一条都不会发出去**。',
      '  - 「在聊天软件里回复」指的是把话放进 interlude_say，不是把回复写成正文。',
      '  - 想连发几条就把它们分行放进同一个 interlude_say 调用里。',
      '  - 想发图片／表情包就调用 `interlude_send_image`（给 file_path 或 url）。',
      '    **这两个工具的调用先后顺序就是你发送的顺序**——想「先甩张图再补一句」，就先调 interlude_send_image 再调 interlude_say。',
    )
  }
  return lines.join('\n')
}

/**
 * 故事续写场景下的写作规则（IM 规则的口径反过来）。
 *
 * 为什么需要：IM 场景要求「只写你会打出来发出去的字，不要旁白」。但**故事续写**
 * 不是发消息，它就是叙事——把 IM 那套规则原样套上去，故事只会退化成一句句对话，
 * 而这一轮说不定一句话都不该发。两条规则互斥，只能按场景给。
 *
 * 发言方式已经从「整行引号」改成 **interlude_say 工具调用**（从根上分离）：
 * 正文与发言各走一条通道，模型把思考写进正文不会再有任何投递后果。
 *
 * @param {boolean} deliverable 这一轮是否可能发消息（决定要不要交代「怎么发言」）。
 */
export function storyRules(deliverable) {
  const lines = [
    '故事续写不是在发消息，你写下的东西默认只有你自己看得见。',
    '- 该有旁白、动作、环境就写，不必把自己限制成一句一句的话。',
    '- 你在这里写的一切（包括你的思考、纠结、列出的备选台词）**都不会被发送**。',
  ]
  if (deliverable) {
    lines.push(
      '- 想让对方看到什么，就调用 **interlude_say**，把要说的话放进去。',
      '- 正文里写的字**一条都不会发出去**；只有 interlude_say 里的话会。',
      '- 不想说话就别调用它——什么都不发是完全正常的。',
    )
  } else {
    lines.push('- 这一轮不会有任何消息发出去，所以不必写「发给对方」的话，把生活写下去就行。')
  }
  return lines
}

/**
 * IM 场景下的说话方式 —— 「一条一条发」的规则来源。
 *
 * 边界说明：这些是**发送方式**的约束（怎么把话说出去），不是文风或人设指令；
 * 人格与叙事归 story 层，这里不碰。
 */
function imRules(config) {
  const max = config?.im?.chunking?.maxChars ?? 40
  const count = config?.im?.chunking?.maxMessages ?? 4
  return [
    '你在用聊天软件和对方说话，不是在写小说。这意味着：',
    '- 只写你会真正打出来发出去的字。不要写旁白、动作、神态、内心独白，也不要用（…）或 *…* 标注。',
    '- 一条消息只说一件事。正常情况下一条十几个字，长一点的吐槽也就两三句。',
    '- 分开打几条是正常的，像真人聊天那样：可以只发一个语气词，可以一句话说完停一下再补一句。',
    '- 想表达情绪就用话本身和标点，不要解释给读者看。',
    '- 不要用任何 Markdown 标记（**、#、列表、代码块），聊天软件里不会渲染，只会露出符号。',
    // 上限来自平台约束（QQ 对同一条来消息的被动回复上限是 4 条），不是文风偏好。
    `- 一次最多分 ${count} 条、每条约 ${max} 字以内；换行表示另起一条消息，不想分条就不要换行。`,
    // —— 消息感知（移植自上游 beta10「允许主角忽略消息继续生活」）。
    //
    // 为什么必须有这几条：没有它们，模型把每条来消息都当成「必须立刻回」，
    // 于是角色永远在秒回——哪怕她正忙、在睡、在气头上，或者就是不想理。
    // 真实的人不这样；「已读不回」是正常的生活行为，不该被剧本强制成对话机器。
    // 机制的落点：不调用 interlude_say = 这一轮什么都不发，这是**被允许的**。
    '- **不是每条消息都必须立刻回**。你可能正忙、在睡、在想别的事，或者就是不想理——',
    '  这时候这轮就不调用 interlude_say，什么都不发，完全正常。',
    '- **看过不代表要回**。已读不回不需要解释，也不要在心里给自己加戏说「我得回一句」。',
    '- 越重要的事越认真斟酌措辞；闲聊可以随便、可以短、可以只回一个语气词。',
  ]
}

/**
 * IM 场景下给幕间块的附加事实（一行）。由 renderInterludeBlock 追加，
 * 不改变块本身「只陈述事实」的定位。
 */
export function imBlockLine(config, imActive = false) {
  if (!imActive && !config?.im?.enabled) return ''
  const max = config?.im?.chunking?.maxChars ?? 40
  const count = config?.im?.chunking?.maxMessages ?? 4
  return `当前经由聊天软件发送：你的话会被拆成最多 ${count} 条短消息（每条约 ${max} 字以内）。`
}

/**
 * 「这一轮到底发不发」的说话方式，随幕间块一起注入。见 renderSpeechModeLine 的调用点。
 *
 * ## 为什么必须说「工具」而不是「引号」
 *
 * 这一行曾经写的是：
 *
 *     本轮模式：**可能发消息**。单独成行、用引号整句写出来的话会被发出去……
 *
 * 那是**改版前**的规则 —— 当时台词确实是从正文里按「整行引号」提取的。
 * 发言方式后来换成了 `interlude_say` 工具调用（「从根上分离」），
 * 而在 `im.sayFallback: 'strict'` 下，**引号提取完全不参与投递判定**
 * （见 `lib/story.js` 的 `decideAdvanceDelivery`：没有 explicitSpeech 就直接
 * 走 `no-speech`）。
 *
 * 于是出现了一个自相矛盾的提示词：一行告诉模型「用引号写就能发出去」，
 * 而实际投递规则是「不调工具就什么都不会发」。
 *
 * **线上事故**（session-xxx，turn 65，2026-09-17 01:39）：
 * 模型照着这一行写了两条台词（没加引号），一个字都没发出去；
 * 用户看到的是「消息发出去了但对方没收到」。
 *
 * 所以这一行必须和投递规则**同口径**。
 *
 * @param {object} config 生效配置。
 * @param {'speak'|'story-only'} mode 本轮模式（由 story.js 的判定给出）。
 * @returns {string} 一行事实；无法判定时返回空串。
 */
export function renderSpeechModeLine(config, mode) {
  if (mode === 'speak') {
    const max = config?.im?.chunking?.maxChars ?? 40
    const count = config?.im?.chunking?.maxMessages ?? 4
    return `本轮模式：**可能发消息**。要把话说给对方，就调用 **interlude_say**（最多 ${count} 条，每条约 ${max} 字以内）；`
      + '**正文里写的字一条都不会发出去**——想说什么就放进工具里，不想说话就别调用它。'
  }
  if (mode === 'story-only') {
    return '本轮模式：**只写故事**。这一轮不管怎么写，都不会有消息发给对方；'
      + '想留给他/她看的话，先留在故事里，等下一次续写再说。'
  }
  return ''
}

/**
 * 渲染「长期记忆」片段。
 *
 * ## 为什么要注入
 *
 * 在这之前，长期事实**从来没进过提示词**——`interlude_memory` 写进去的东西
 * 只有人工 `/interlude context` 能看见，模型全程不知情。那等于「记了但没人看」，
 * `recall.js` 的词法召回与 `knowledge-evidence` 的认知模式也都跟着失去了下游。
 *
 * ## 三条口径（都是刻意的）
 *
 * 1. **未确认的接触必须显式标注**。`belief`（她的解读）不能和已确认的事实
 *    平铺在一起——那正是「她以为说定了」变成「说定了」的通道。
 *    所以 belief 条目会带上「（她的解读，未获确认）」这类前缀。
 *
 * 2. **不注入全部**。按 `memoryLimit` 截断，且只注入 active 的。
 *    记忆是无界的，上下文预算不是。
 *
 * 3. **空则完全不出现**。没有事实时不写「（无）」这种占位——
 *    那只会教模型「这里应该有点什么」。
 *
 * @param {object} args
 * @param {Array<object>} args.facts 已排序的事实（来自 `rankFacts`）。
 * @param {number} [args.limit] 最多渲染几条。
 * @returns {string} 片段；无内容时返回空串。
 */
export function renderFacts({ facts, limit = 20 } = {}) {
  const list = Array.isArray(facts) ? facts.slice(0, Math.max(0, limit)) : []
  if (!list.length) return ''
  const lines = ['长期记忆（**已确认的事实**与**她的解读**必须分开读）：']
  for (const fact of list) {
    const evidence = factEvidenceForPrompt(fact)
    const mode = evidence.knowledge?.mode ?? 'unclassified'
    const scope = fact.scope ? `［${SCOPE_LABEL[fact.scope] ?? fact.scope}］` : ''
    // 认知模式前缀：只有需要区分的才标。
    // `unclassified` 不标——那是「还没标注」，不是「不可信」，
    // 给它加前缀等于把老数据一律打成可疑。
    const tag = MODE_TAG[mode] ?? ''
    lines.push(`- ${scope}${tag}${fact.content}`)
  }
  return lines.join('\n')
}

/** 事实类别的中文标签。 */
const SCOPE_LABEL = {
  promise: '承诺',
  event: '事件',
  world: '世界',
  relationship: '关系',
  general: '一般',
}

/**
 * 认知模式在提示词里的前缀。
 *
 * 只有**可能被误读成已确认事实**的模式才需要前缀：
 *   - `belief` 是她的解读，写成事实就是失真；
 *   - `proposal` 提了但没回应，写成事实就是「说定了」；
 *   - `conditional` 有条件，忽略条件就是「必然发生」；
 *   - `reported` 是对方说的，与「亲眼所见」可信度不同。
 * `observed` / `confirmed` 本身已是可靠层级，不加前缀反而更干净。
 */
const MODE_TAG = {
  belief: '（她的解读，**未获对方确认**）',
  proposal: '（已提出，**尚未得到回应**）',
  conditional: '（有前置条件，条件未满足前不成立）',
  reported: '（据对方所说）',
}

/**
 * 渲染「幕间」注入块。没有值得说的事实且未开启 alwaysReportTime 时返回空串。
 * @param {object} args
 * @param {number} args.now - epoch 毫秒。
 * @param {string} args.zone - 规范化 IANA 时区。
 * @param {object} args.state - 幕间状态。
 * @param {object} args.config - 生效配置。
 * @param {Array} args.due - 到期待办。
 * @param {boolean} [args.imActive] 本会话是否确实经聊天软件收发。
 * @param {string} [args.extraLine] 附加事实（本轮模式等）；由调用方决定内容。
 * @param {Array<object>} [args.facts] 已排序的长期事实（由调用方按相关度排好）。
 */
export function renderInterludeBlock({ now, zone, state, config, due, imActive = false, extraLine = '', facts = [] }) {
  const local = storyLocalTimeContext(new Date(now), zone)
  const lines = [`<幕间>`]

  // 决定是否注入：① 显式要求每轮报时间；② 距上次互动超过 gapNoticeMinutes；
  // ③ 有实质内容（到期待办 / 连续性 / 气氛底色 / 近期日程 / 附加事实）。
  const gap = Math.max(
    Number.isFinite(state.lastUserAt) ? now - state.lastUserAt : 0,
    Number.isFinite(state.lastAssistantAt) ? now - state.lastAssistantAt : 0,
  )
  const gapNotice = config.gapNoticeMinutes != null && gap >= config.gapNoticeMinutes * 60_000
  const substance = due.length > 0
    || Boolean(state.continuity)
    || Boolean(emotionalOffsetForPrompt(state.alter, config.alterSystem ?? {}))
    || Boolean(extraLine)
    // overlay 也算实质内容：否则「只有设定演化、没有其它事实」的会话
    // 会在下面提前 return ''，刚接上的 overlay 永远注不进去。
    || (Array.isArray(state.overlay) && state.overlay.length > 0)
    || Boolean(schedulePreplanWindow(state.preplan, new Date(now), zone, 12, config.schedulePreplan ?? {}))
    // 长期记忆也算实质内容：否则「只有记忆、没有别的」的会话会被提前 return，
    // 记忆永远注不进去（与 overlay 同理）。
    || (Array.isArray(facts) && facts.length > 0)

  if (!config.alwaysReportTime && !gapNotice && !substance) return ''

  lines.push(`现在是 ${local.local} ${local.weekday}，${local.periodZh}。`)

  // 间隔只在**真的有间隔**时才有信息量。
  //
  // 线上实测（session-xxx）：40 次注入里 17 次写着「距上一条用户消息已过 不到 1 分钟」
  // ——用户刚说完话，模型当然知道「刚刚」，这行等于没说，却每次都进上下文、
  // 并从此刻起被后续每一次请求重发。省掉它不损失任何信息。
  const gapThreshold = Math.max(0, config.gapNoticeMinutes ?? 30) * 60_000
  if (Number.isFinite(state.lastUserAt) && now - state.lastUserAt >= gapThreshold) {
    lines.push(`距上一条用户消息已过 ${formatGap(now - state.lastUserAt)}。`)
  }
  // 「距你上次开口」同一条道理，但它有个额外用途：区分「上一条是我说的」这种情况。
  // 所以门槛取间隔阈值与 1 分钟的较大者——刚说完话的那几轮不必重复念叨。
  if (Number.isFinite(state.lastAssistantAt) && now - state.lastAssistantAt >= Math.max(gapThreshold, 60_000)) {
    lines.push(`距你上次开口已过 ${formatGap(now - state.lastAssistantAt)}。`)
  }

  if (due.length > 0) {
    lines.push('到期待办：')
    for (const intent of due.slice(0, 5)) {
      const overdue = intent.dueAt != null ? formatGap(now - intent.dueAt) : '未知'
      lines.push(`- (${intent.id}) ${intent.summary} —— 已到期 ${overdue}，尚未处理。`)
    }
  }

  const offset = emotionalOffsetForPrompt(state.alter, config.alterSystem ?? {})
  if (offset) {
    lines.push(`气氛底色（${offset.direction === 'serious' ? '偏绷紧' : '偏松弛'}，强度 ${offset.intensity.toFixed(1)}）：${offset.description}`)
  }

  const window = schedulePreplanWindow(state.preplan, new Date(now), zone, 12, config.schedulePreplan ?? {})
  if (window && window.blocks?.length) {
    lines.push('近期日程（参考，非已发生事实）：')
    for (const block of window.blocks.slice(0, 6)) {
      lines.push(`- ${block.date} ${block.start}–${block.end} ${block.label}${block.location ? ` @${block.location}` : ''}`)
    }
  }

  if (state.continuity) {
    lines.push(`连续性：${state.continuity}`)
  }

  // 长期记忆：`interlude_memory` 写进 facts 的东西。
  //
  // 放在连续性之后、overlay 之前：它回答的是「她还记得什么」，
  // 与「反复证据累积出的当下」是两件事，顺序上先事实后状态更好读。
  const factBlock = renderFacts({ facts, limit: config.memoryLimit ?? 20 })
  if (factBlock) lines.push(factBlock)

  // 设定演化（Overlay）：反复出现的证据累积出的**当下状态**。
  //
  // 为什么放在这里：它此前只有写入函数、没有任何写入调用，也没进过提示词——
  // 等于一个永远为空的字段。接上 `interlude_memory` 的 overlay 动作后，
  // 这里负责把它读回上下文，否则「记了但模型看不到」仍然没有意义。
  //
  // 口径对齐上游 narrator.ts:1508：overlay 是「累积出的当下」，
  // **优先级高于最初的设定基线**——两者冲突时以它为准。
  const overlay = Array.isArray(state.overlay) ? state.overlay : []
  if (overlay.length) {
    lines.push('设定演化（由反复出现的证据累积而成，与最初设定冲突时以此为准）：')
    for (const item of overlay.slice(0, 6)) {
      lines.push(`- ${LAYER_LABEL[item.layer] ?? item.layer}：${item.content}`)
    }
  }

  // 刻意**不**在这里放 imBlockLine（「你的话会被拆成最多 4 条短消息」）。
  //
  // 它是**发送方式**的约束，不是这一回合的事实——每轮重复一遍没有任何新信息，
  // 却要在上下文里永久占位并被后续每次请求重发。它已经由 imRules() 在首轮的
  // 规则段里说过一次（见 renderRules），说一次就够。
  if (extraLine) lines.push(extraLine)

  lines.push('</幕间>')
  return lines.join('\n')
}

/** overlay 四个层的中文标签；未知层回退显示原值（不吞信息）。 */
const LAYER_LABEL = {
  character: '角色',
  perspective: '价值观',
  relationship: '关系',
  world: '世界',
}

/**
 * 主动联系唤起时给模型的提示：只给动机，不复述台词。
 *
 * **你写的正文就是发出去的消息本身。** 这条边界必须写清楚，因为它是线上事故的直接原因
 * （session-xxx turn 33）：提示词原先只说「若不便，说明推迟原因即可」，模型于是
 * 把「说明」理解成写一段话——它写下的是**思考过程**（「用户也没回消息，那就真睡了。
 * 不打扰他了……」「但系统说『到期待办到期了』……不发了。」），而这段思考被逐字发到了
 * QQ 里。四条消息里没有一句是角色在对用户说话。
 *
 * 所以这里明说三件事：① 正文即消息；② 只想不说就别输出（有安静的出口），
 * ③ 不要写旁白、心理活动、对自己的解释。
 *
 * @param {object} intent 到期待办。
 * @param {number} now 当前时刻。
 * @param {string} zone 时区。
 * @param {object} state 会话状态。
 */
export function renderProactiveText(intent, now, zone, state) {
  const lines = [`<幕间>`]
  lines.push(`现在是 ${formatStoryDisplayTime(new Date(now), zone)}。`)
  lines.push(`到期待办到期了：(${intent.id}) ${intent.summary}。`)
  // 一次开口里被合并进来的其它待办：同一段话里带过，不要为此再发一条。
  if (intent.bundled?.length) {
    lines.push('另外这几件事也该说了（合在这一次里说掉，不要分成好几条消息）：')
    for (const item of intent.bundled) lines.push(`- (${item.id}) ${item.summary}`)
  }
  if (state.continuity) lines.push(`近期连续性：${state.continuity}`)
  lines.push('')
  lines.push('**要发出去的话，必须调用 `interlude_say`。**')
  lines.push('- 只有 interlude_say 里的话会发给对方；你写在这条提示之外的任何正文都**不会被发送**。')
  lines.push('- 所以不要用正文来表达「我要说什么」——那是给你自己看的，写多了也不会传出去。')
  lines.push('- 像平时聊天那样：短句，一条一件事，想连发几条就用换行分开。')
  lines.push('- 不要写旁白、心理活动、对自己的解释，也不要复述这条提示或提及「待办」「系统」。')
  lines.push('- 若这个时机其实不该开口（比如对方已经睡了、这件事无需再说），就**不要调用它**——')
  lines.push('  什么都不发是完全正常的，这一轮会安静结束；这比写一段「我决定不发了」要好。')
  lines.push('</幕间>')
  return lines.join('\n')
}

/**
 * 人类命令 `/interlude status` 的状态摘要。
 * @param {object} [args.imBinding] 已解析的投递绑定（含自动发现结果），用于如实标注来源。
 */
export function renderStatus({ now, zone, state, config, due, imBinding }) {
  const local = storyLocalTimeContext(new Date(now), zone)
  const story = config.story ?? {}
  const character = story.character ?? {}
  const lines = [
    `[幕间层] 版本状态`,
    `- 主角：${character.name || '（未设定）'}`,
    `- 本地时间：${local.local} ${local.weekday}（${local.periodZh}）`,
    `- 时区：${zone}`,
    `- 回合数：${state.turns ?? 0}`,
    `- 距上条用户消息：${Number.isFinite(state.lastUserAt) ? formatGap(now - state.lastUserAt) : '—'}`,
    `- 距上次开口：${Number.isFinite(state.lastAssistantAt) ? formatGap(now - state.lastAssistantAt) : '—'}`,
    `- 连续性快照：${state.continuity ? '有' : '无'}${state.continuityUpdatedAt ? `（更新于 ${formatStoryDisplayTime(new Date(state.continuityUpdatedAt), zone)}）` : ''}`,
    `- 长期事实：${state.facts?.length ?? 0} 条`,
    `- 设定演化（Overlay）：${state.overlay?.length ?? 0} 项`,
    `- 到期待办：${due.length} 项`,
  ]
  if (due.length) {
    for (const intent of due.slice(0, 10)) {
      lines.push(`    (${intent.id}) ${intent.summary}（${intent.kind}）`)
    }
  }
  const alter = state.alter
  if (alter) {
    lines.push(`- Alter：累计 ${alter.alterValue}，权重 ${alter.alterWeight?.toFixed(2) ?? 0}${alter.emotionalOffset ? `，底色已激活（${alter.emotionalOffset.direction}）` : ''}`)
  }
  if (state.agencyWindow) {
    lines.push(`- Agency：负荷=${state.agencyWindow.activityLoad} 隐私=${state.agencyWindow.privacy} 设备=${state.agencyWindow.deviceAccess}（有效期至 ${formatStoryDisplayTime(new Date(state.agencyWindow.validUntil), zone)}）`)
  }
  const window = schedulePreplanWindow(state.preplan, new Date(now), zone, 12, config.schedulePreplan ?? {})
  if (window) {
    lines.push(`- 近期日程（rev ${window.revision}）：${window.from} → ${window.to}，${window.blocks?.length ?? 0} 段`)
  }
  lines.push(`- 今日已主动联系：${state.reachedOut ?? 0} / ${config.proactive?.maxPerDay ?? 6}`)
  if (config.im?.enabled || imBinding) {
    const binding = imBinding ?? state.imBinding
    const last = state.lastImDelivery
    lines.push(`- IM 直投：${binding
      ? `${binding.source === 'discover' ? '自动发现' : '绑定'} ${binding.botId} / ${binding.targetId}`
      : (config.im?.botId && config.im?.targetId ? `插件配置 ${config.im.botId} / ${config.im.targetId}` : '已启用但未绑定目标')}`)
    lines.push(`- 上次 IM 投递：${last
      ? `${last.ok ? '成功' : '失败'} ${last.sentCount ?? 0}/${last.total ?? 0} 条${last.error ? `（${last.error}）` : ''}`
      : '无'}`)
  }
  const failed = (state.intents ?? []).filter(item => item.status === 'failed')
  if (failed.length) {
    lines.push(`- 主动投递失败：${failed.length} 项（${failed.slice(-3).map(item => `${item.id} ${item.failure ?? ''}`).join('；')}）`)
  }
  return lines.join('\n')
}

/**
 * 自动生活推进唤起时给模型的提示。见 renderAdvanceNotice。
 *
 * @param {boolean} silent 是否只写故事（不发消息）。
 * @param {object} [options]
 * @param {boolean} [options.director=false] 是否请求时间账本（时间导演开启时）。
 * @param {boolean} [options.urge=false] 是否请求 Urge 调度交接。
 */
function advanceNotice(silent, { director = false, urge = false } = {}) {
  const lines = [
    '<幕间>',
    '距上次互动已有一段时间，请续写角色在这段时间里自然发生的生活，并以当前时刻收尾。',
    '',
    '这一轮是**故事续写**：',
    silent
      ? '- 用户不会收到你的任何消息，你写的这段只作为故事留存下来；'
      : '- 如果角色此刻确实想对对方说点什么，就调用 **interlude_say** 把话说出去。',
    silent
      ? '- 所以不要为了「回话」而说话，只写生活在继续发生。'
      : '- 正文（旁白、动作、内心活动、你列出的备选台词）**一条都不会被发送**；只有 interlude_say 里的话会。',
    silent
      ? '- 故事里可以有旁白、动作和环境，把这段时间的生活写扎实。'
      : '- 没有想说的话就别调用它——什么都不发是完全正常的，比硬凑一句好。',
    '- 故事里可以有旁白、动作和环境，不必克制篇幅；把这段时间的生活写扎实。',
    '</幕间>',
  ]
  if (director) lines.push(renderTimelineDirectorRequest())
  if (urge) lines.push(urgeInstruction(true, 'advance'))
  return lines.join('\n')
}

/** 手动推进（/interlude advance）——同样是续写故事，不额外改变发言规则。 */
function manualAdvanceNotice(silent) {
  return [
    '<幕间>',
    '手动推进：请补写从故事游标到现在已发生的生活，自然结束在当前时刻。',
    silent
      ? '只写故事，不必对用户说话。'
      : '想对用户说什么，就调用 interlude_say；正文里写的字都不会被发送。',
    '</幕间>',
  ].join('\n')
}

/**
 * 自动生活推进（续写故事）的唤起文本。
 *
 * 为什么按模式分叉：模型并不知道插件有没有把话发出去。不告诉它，它就会在
 * 「只写故事」的那一轮里对着空气说「在忙吗」——用户什么都没收到，而故事里
 * 却写着它已经问过了，下一次续写就会以「我问过了」为前提继续编。
 * 说清楚这一轮发不发，是让故事与世界保持一致的最小代价。
 *
 * @param {boolean} [silent] true 表示这一轮不会发任何消息。
 */
export function renderAdvanceNotice(silent = false, options = {}) {
  return advanceNotice(silent, options)
}

/** 手动 `/interlude advance` 的唤起文本（见 advanceNotice）。 */
export function renderManualAdvanceNotice(silent = false) {
  return manualAdvanceNotice(silent)
}

/**
 * 把 Canonical Story 渲染成一份自包含的「角色卡」文本，用作 DSH Agent 预设的 persona。
 * 与 renderCanon 不同：这里不是「你正在扮演…」的指令口吻，而是角色卡本体的声明式描述，
 * 选中预设后由 dsh-persona 注入。
 */
export function renderPresetCard(story) {
  const s = story ?? {}
  const c = s.character ?? {}
  const w = s.world ?? {}
  const cp = s.counterpart ?? {}
  const p = s.plot ?? {}
  const lines = ['# 角色卡']
  if (c.name) lines.push(`角色名：${c.name}`)
  if (c.profile) lines.push(`\n角色设定：\n${c.profile}`)
  if (c.speech) lines.push(`\n说话风格：\n${c.speech}`)
  if (s.perspective) lines.push(`\n价值观：\n${s.perspective}`)
  if (w.setting) lines.push(`\n世界观：\n${w.setting}`)
  if (w.location) lines.push(`\n主要地点：${w.location}`)
  if (w.supportingCast) lines.push(`\n配角：\n${w.supportingCast}`)
  if (cp.profile) lines.push(`\n对话者背景：\n${cp.profile}`)
  if (cp.initial) lines.push(`\n初始关系：${cp.initial}`)
  if (p.startingPoint) lines.push(`\n剧情起点：\n${p.startingPoint}`)
  if (p.style) lines.push(`\n文风：${p.style}`)
  if (p.boundaries) lines.push(`\n禁则与边界：\n${p.boundaries}`)
  return lines.join('\n')
}

/**
 * 把「角色卡」文本反解析回 Canonical Story（renderPresetCard 的逆操作）。
 *
 * 用途：读取预设时，老预设没有 `story.json` 快照（那是 2026-09-16 之后才写的），
 * 但 `agent.cordis.yml` 里保存了保存那一刻的角色卡文本——按小节标签切回结构化
 * story，让老预设也能被「读取预设」载入创作表单。
 *
 * @param {string} text renderPresetCard 的输出。
 * @returns {object} story 结构（只含卡片里有内容的字段）。
 */
export function parsePresetCard(text) {
  const out = { character: {}, world: {}, counterpart: {}, plot: {}, keywords: [] }
  const SECTIONS = ['角色名', '角色设定', '说话风格', '价值观', '世界观', '主要地点', '配角', '对话者背景', '初始关系', '剧情起点', '文风', '禁则与边界']
  const re = new RegExp(`^(${SECTIONS.join('|')})：(.*)$`)
  const parts = []
  let current = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('# 角色卡')) continue
    const m = re.exec(line)
    if (m) {
      current = { label: m[1], inline: m[2], valueLines: [] }
      parts.push(current)
    } else if (current) {
      current.valueLines.push(line)
    }
  }
  const valueOf = (part) => {
    if (!part) return ''
    if (part.inline) return part.inline.trim()
    return part.valueLines.join('\n').trim()
  }
  const by = {}
  for (const part of parts) by[part.label] = valueOf(part)
  if (by['角色名']) out.character.name = by['角色名']
  if (by['角色设定']) out.character.profile = by['角色设定']
  if (by['说话风格']) out.character.speech = by['说话风格']
  if (by['价值观']) out.perspective = by['价值观']
  if (by['世界观']) out.world.setting = by['世界观']
  if (by['主要地点']) out.world.location = by['主要地点']
  if (by['配角']) out.world.supportingCast = by['配角']
  if (by['对话者背景']) out.counterpart.profile = by['对话者背景']
  if (by['初始关系']) out.counterpart.initial = by['初始关系']
  if (by['剧情起点']) out.plot.startingPoint = by['剧情起点']
  if (by['文风']) out.plot.style = by['文风']
  if (by['禁则与边界']) out.plot.boundaries = by['禁则与边界']
  return out
}


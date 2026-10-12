/**
 * 模型特化合约 —— 移植自上游 `1.0.1-rc14` 的 `src/specialization.ts`（14KB）。
 *
 * ## 上游做了什么
 *
 * 一个模型的「档位」决定提示词里**给多少约束**：弱模型（flash / lite / mini 系）
 * 约束一多就执行不过来，反而丢关键规则；强模型（claude / gpt）给足了才不出戏。
 * 于是把合约分成三档（`lite` / `standard` / `full`）并按**模型名**自动推断，
 * 再叠加一层**家族块**做最小偏移（长度块 / 打字块替换 + 至多一条新增行）。
 *
 * ## 本仓移植了什么、没移植什么
 *
 * **已移植（推断层，逐字对齐）**：`FAMILY_PATTERNS` / `detectFamily` / `autoTier` /
 * `inferSpecialty`——家族识别顺序、grok→lite、glm(<5)→lite、gemini-flash→lite、
 * 「非 deepseek 且模型名带 flash/lite/mini 词元 → lite」、claude/gpt→full、
 * **未识别家族保守回退 full**（上游原话：避免静默改变现有安装的行为）全部照搬。
 *
 * **已移植（家族块，按本仓口径重写内容）**：上游的 `typed` 块正好对应本仓 rc5/rc7
 * 刚移植的打字/贴图规则，因此按上游「最小偏移」的规矩实现：
 *   - `gemini-flash` → **精简版打字块**（去掉猫贴图例子与延展，补一句"真人打字朴素具体直接"）
 *     + 一条行文基调（对应上游 `EXTRA_GEMINI_FLASH`）；
 *   - `kimi` → 打字块加**矛盾/迟疑**那一段（对应上游 `TYPED_MESSAGES_KIMI` 的插入）；
 *   - `claude` / `glm` → 各一条新增行（对应上游 `EXTRA_CLAUDE` / `EXTRA_GLM`）；
 *   - 其余家族 → 无偏移（`{}`）。
 *
 * **N/A（架构差异）**：
 *   - 上游的 `length` 块是**全局英文文风寄存器**；本仓文风来自角色卡（canon 的
 *     「文风」段），全局再写一层会与人设打架 → 不移植；
 *   - `CONTENT_ONLY_TRANSPORT` / `LITE_*` / JSON 合约那一半是**传输协议**层：
 *     本仓用 `interlude_say` 工具调用发言，没有 JSON `script` 合约 → N/A。
 *
 * ## DSH 侧适配（唯一差别）
 *
 * 上游从**模型中心的连接名**取探测串；DSH 由宿主管模型路由，**插件侧拿不到模型名**。
 * 因此这里把探测串做成用户配置（`specialization.modelProbe`）：填模型名即按上游规则
 * 自动分档；**留空 → 族别 generic → 档位 full**（与上游「未识别家族回退 full」一致，
 * 也就是"不影响现状"的默认）。
 *
 * @module dsh-hds-interlude/specialization
 */

/** 三档合约。 */
export const CONTRACT_TIERS = ['lite', 'standard', 'full']

/** 家族识别表（顺序即优先级，逐字对齐上游）。 */
export const FAMILY_PATTERNS = [
  ['claude', /claude|anthropic/],
  ['gemini-flash', /gemini[^|]*(?:flash|lite)|(?:flash|lite)[^|]*gemini/],
  ['gemini', /gemini/],
  ['gpt', /gpt|^o\d|openai/],
  ['grok', /grok|xai/],
  ['kimi', /kimi|moonshot/],
  ['glm', /glm|zhipu|chatglm/],
  ['deepseek', /deepseek/],
]

/**
 * 按模型名识别家族（首个命中者胜；都不中 → `generic`）。
 *
 * @param {string} probe 模型名（或任何能代表它的字符串）。
 * @returns {string} 家族名。
 */
export function detectFamily(probe) {
  const text = String(probe ?? '').toLowerCase()
  for (const [family, pattern] of FAMILY_PATTERNS) {
    if (pattern.test(text)) return family
  }
  return 'generic'
}

/**
 * 自动档位（与上游 `autoTier` 逐字对齐）。
 *
 * 注意上游的两处例外，照搬：
 *   - **deepseek 不吃 flash→lite 规则**（V4-Flash 的实测数据支持 standard）；
 *   - **glm 只有 5 以前的版本算 lite**（`glm-5` 起走 standard）。
 *
 * @param {string} family 家族名。
 * @param {string} probe 模型名。
 * @returns {'lite'|'standard'|'full'}
 */
export function autoTier(family, probe) {
  const text = String(probe ?? '').toLowerCase()
  if (family === 'grok') return 'lite'
  if (family === 'glm' && !/glm-?[5-9]/.test(text)) return 'lite'
  if (family === 'gemini-flash') return 'lite'
  if (family !== 'deepseek' && /(?:^|[-_.])(?:flash|lite|mini)(?:[-_.]|$)/.test(text)) return 'lite'
  if (family === 'claude' || family === 'gpt') return 'full'
  // 未识别家族（中转别名、自定义模型名很常见）保守回退 full，
  // 避免静默改变现有安装的行为——与上游同一考虑。
  if (family === 'generic') return 'full'
  return 'standard'
}

/**
 * 推断特化档位（对齐上游 `inferSpecialty`）。
 *
 * @param {string} probe 模型名。
 * @param {'auto'|'lite'|'standard'|'full'|'off'} [mode] 档位模式。
 * @returns {{tier: string, family: string, source: 'auto'|'manual', probe: string}}
 */
export function inferSpecialty(probe, mode = 'auto') {
  const family = detectFamily(probe)
  if (mode === 'off') return { tier: 'full', family: 'generic', source: 'manual', probe: String(probe ?? '') }
  if (mode !== 'auto' && CONTRACT_TIERS.includes(mode)) {
    return { tier: mode, family, source: 'manual', probe: String(probe ?? '') }
  }
  return { tier: autoTier(family, probe), family, source: 'auto', probe: String(probe ?? '') }
}

/* ────────────────────────── 家族块（rc50 上游英文原文，逐字对齐） ────────────────────────── */

/**
 * 写作基调（上游 `script/lived-writing.ts` 的 `LIVED_WRITING_PROMPT`，逐字）。
 *
 * 上游注释说明它的来历：「核心写作指导逐字取自 0.1.5-beta3 构建产物
 * （写作基调 + 主角中心事件观），v2 功能合约层保持不变。」
 */
export const LIVED_WRITING_PROMPT = 'Write this as a living stage script in prose: begin from the protagonist’s surroundings, actions, rhythms, practical pressures, inner motives and relationships. Let daily life itself create movement. A user message is one event entering that life; it can matter deeply, lightly, or not yet change anything, but it does not replace the protagonist’s world as the center of the scene.'

/**
 * 打字块：完整版（上游 `TYPED_MESSAGES_BASE`，逐字）。
 *
 * 上游原文出处 `src/specialization.ts`。本仓上一版是中文改写；按「尽量还原上游」
 * 改为**英文原文**——上游的这三档合约是整套英文提示词体系的一部分，
 * 中文混排会与其余英文段落语域不一致。
 */
export const TYPED_MESSAGES_BASE = 'WRITING BELIEVABLE TYPED MESSAGES: In the script, portray online messages as text the character chooses to type, not spoken dialogue transcribed. Keep typing and speaking aloud distinct. Each reply is an independent choice — the number of messages in previous replies does not constrain this one; let this moment alone decide whether she sends one bubble or several. Stickers and emoji-like images are a metalanguage: infer the sender attitude, acknowledgement, hesitation, irony or emotional framing from the concrete image and its conversational context rather than stopping at the depicted subject. A cat sticker may mean "seen" or "confirmed", not that the sender is commenting on a cute cat. Sending the same sticker repeatedly is also an intentional expressive act — insistence, emphasis, playfulness, impatience or deliberate noise.'

/** 精简版打字块（上游 `TYPED_MESSAGES_GEMINI_FLASH`，逐字）。 */
const TYPED_MESSAGES_GEMINI_FLASH = 'WRITING BELIEVABLE TYPED MESSAGES: In the script, portray online messages as text the character chooses to type, not spoken dialogue transcribed. Keep typing and speaking aloud distinct. Each reply is an independent choice — the number of messages in previous replies does not constrain this one. A chat message typed by a real person is plain, specific and direct. Stickers and emoji-like images are a metalanguage: infer the sender attitude, acknowledgement, hesitation, irony or emotional framing from the concrete image and its conversational context rather than stopping at the depicted subject. A cat sticker may mean "seen" or "confirmed". Sending the same sticker repeatedly is also an intentional expressive act.'

/** kimi 版打字块：在上游 `TYPED_MESSAGES_BASE` 里插入「迟疑与矛盾」那段（上游做法逐字）。 */
const TYPED_MESSAGES_KIMI = TYPED_MESSAGES_BASE.replace(
  'Keep typing and speaking aloud distinct.',
  'Keep typing and speaking aloud distinct. In dialogue she may hesitate, change her mind mid-sentence, reply to only part of a message, or leave a thought unfinished; she may react briefly now and give a real answer later, or want two things at once without picking either. A real person does not deliver a settled position on every exchange, and ambivalence is a normal state, not a problem to resolve.',
)

/**
 * 长度块（上游 `LIVED_LENGTH_PROMPT` + 家族覆盖，逐字）。
 *
 * 上游把长度块作为**默认文风寄存器**，家族可替换。本仓上一版把它判为 N/A
 * （理由是「文风来自角色卡，全局再写一层会打架」）——按「尽量还原上游」改为照搬：
 * 上游的 `WRITING STYLE` 段本身也是「用户可配置 + 故事设定覆盖」两层，
 * 与角色卡文风并不冲突（后者作为 `storyStylePrompt` 追加在后面）。
 */
export const LIVED_LENGTH_PROMPT = 'Length follows what actually happens: give actions and shifts of attention room to develop, including during a rapid exchange; a quiet interval has its own occupation, pace and texture, and may carry ordinary life forward to the next meaningful beat. Continue from established circumstances rather than performing the previous passage again.'

const LENGTH_GEMINI_FLASH = 'Length follows what actually happens. Prefer concrete, sensory detail over elevated wording: plain nouns and specific verbs carry the scene; use everyday words unless the moment itself is extraordinary. Choose one specific detail over several general ones; do not stack adjectives or reach for rare, showy vocabulary. Give actions and shifts of attention room to develop, including during a rapid exchange; a quiet interval has its own occupation and texture. Continue from established circumstances rather than performing the previous passage again.'

const LENGTH_CLAUDE = 'Length follows what actually happens: give actions and shifts of attention room to develop, including during a rapid exchange. Ground each passage in concrete sensory detail — what she is physically doing, touching, eating, hearing — rather than in commentary about it; open on her body and her immediate task, and let anything abstract enter only after that anchor. A quiet interval has its own occupation, pace and texture, and may carry ordinary life forward to the next meaningful beat. Continue from established circumstances rather than performing the previous passage again.'

const LENGTH_DEEPSEEK = 'Length follows what actually happens: give actions and shifts of attention room to develop, including during a rapid exchange. Keep the narration plain and concrete: most sentences need no figurative language at all, and a metaphor is occasional rather than a habit — otherwise prefer the unadorned noun, the specific number, the plain verb. In Chinese prose one fitting idiom is enough; never chain four-character idioms. A quiet interval has its own occupation, pace and texture, and may carry ordinary life forward to the next meaningful beat. Continue from established circumstances rather than performing the previous passage again.'

const LENGTH_GROK = 'One scene, one or two things happening. Keep the passage anchored to what is underway right now; finish an action, then let time advance. Do not describe the same moment twice in different words, and keep sentences direct: concrete objects, plain verbs, no decoration.'

const LENGTH_GPT = 'Length follows what actually happens, and each passage keeps moving: finish the thing underway, then let time advance to the next. Do not stretch one short moment into many paragraphs — when nothing new happens, move the clock forward instead; a rapid exchange stays rapid. A quiet interval has its own occupation and texture, briefly told; prefer ending a passage earlier than padding it. Continue from established circumstances rather than performing the previous passage again.'

/** claude 家族行（上游 `EXTRA_CLAUDE`，逐字）。 */
const EXTRA_CLAUDE = 'Scenes do not need tidy closure. Ordinary life leaves small matters unresolved, moods unexplained and conversations unfinished; let a passage end mid-motion when that is where the moment genuinely is. Do not end with a concluding summary sentence, a lesson or a mood label; real daily life simply continues past any single passage.'

/** glm 家族行（上游 `EXTRA_GLM`，逐字）。 */
const EXTRA_GLM = 'Emotional register: let mood follow its actual causes and stay ordinary. Do not drift toward warmth, comfort or reassurance unless the events themselves justify it: no unearned encouragement, no softening a bad mood before the passage ends, no bright side the events did not produce. A neutral or low mood is as common in real life as a good one, and difficult feelings do not need to resolve within the same passage.'

/**
 * DeepSeek 家族行（上游 `EXTRA_DEEPSEEK` 的**架构适配版**）。
 *
 * 上游原文教的是 JSON 传输对象：`interaction` 每回合必需、`reply.mode` 从本轮剧本
 * 决定、`seen` 是必需布尔、历史条目不带该对象形态。本仓没有 JSON 合约——
 * 发言走 `interlude_say` 工具调用。所以这里保留上游的**英文语域与全部语义点**
 * （每回合独立 / 历史不是模板 / 不能因为历史没有就当作可选 / 只从本轮剧本决定），
 * 只把「传输对象」换成「本轮的 interlude_say 调用」。
 *
 * rc50 的上游修订（收窄适用回合）同样保留：只有**可承载回复的回合**才必需，
 * 自主生活推进回合不带传输——除非这一轮真的发了消息。
 */
const EXTRA_DEEPSEEK = 'TRANSPORT IS PER-TURN: on every turn that can carry a reply (user-message, conversation-follow-up, intent-due), sending must happen through this turn\'s own interlude_say call, no matter how many turns came before. Independent-life advance turns send nothing unless a message is genuinely sent now — an advance turn that stays silent is not a missed call. recentScript shows past messages as plain authored text without any tool-call shape — that is history, not a template; never copy its shape or treat the call as optional because history omits it. Decide whether she speaks only from the script you just wrote for this turn.'

/**
 * 家族覆盖表（对齐上游 rc50 的 `familyOverrides`）。
 *
 * 与上一版的差异：
 *   - 新增 `length` 维度（上游 rc14 起就有，本仓上一版判为 N/A）；
 *   - `gemini-flash` **不再**有 `extraAfterPhase`（rc50 删掉了 `EXTRA_GEMINI_FLASH`，
 *     其内容已并入 `LENGTH_GEMINI_FLASH`）；
 *   - `deepseek` 增加 `length: LENGTH_DEEPSEEK`；
 *   - `grok`/`gpt` 增加各自长度块；
 *   - 回到上游的「替换」语义：`kimi` 是替换 `typed`（不是追加）。
 *
 * @param {string} family 家族名。
 * @returns {{length?: string, typed?: string, extraAfterLength?: string, extraAfterPhase?: string}}
 */
export function familyOverrides(family) {
  switch (family) {
    case 'gemini-flash': return { length: LENGTH_GEMINI_FLASH, typed: TYPED_MESSAGES_GEMINI_FLASH }
    case 'claude': return { length: LENGTH_CLAUDE, extraAfterPhase: EXTRA_CLAUDE }
    case 'glm': return { extraAfterPhase: EXTRA_GLM }
    case 'kimi': return { typed: TYPED_MESSAGES_KIMI }
    case 'deepseek': return { length: LENGTH_DEEPSEEK, extraAfterPhase: EXTRA_DEEPSEEK }
    case 'grok': return { length: LENGTH_GROK }
    case 'gpt': return { length: LENGTH_GPT }
    default: return {}
  }
}

/* ──────────────────── LITE / STANDARD 档协议块（上游英文原文） ──────────────────── */

/**
 * 下面这些块在上游属**传输协议层**（JSON `interaction` / `<sep/>`）。
 *
 * 本仓用工具调用发言，**协议句本身不适用**；但其中三条是**与协议无关的语义**，
 * 上游也把它们放在 lite 档里反复强调，本仓同样需要：
 *   - `LITE_INTERVAL`（时间以 interval 为权威，不照抄历史里的时间词）
 *   - `LITE_UNREAD`（收到 ≠ 已读）
 *   - `LITE_NEVER_INVENT`（不得虚构未观察到的事件）
 *   - `LITE_OWNERSHIP`（条目归属标签是权威）
 *   - `LITE_ADMIN_NOTES` / `LITE_WORLD_EVENTS`（两种注入条目的语义）
 *
 * 按「尽量还原上游」，这里保留上游英文原文，供 render 层在对应场景使用；
 * 纯协议句（`CONTENT_ONLY_TRANSPORT` / `LITE_TRANSPORT_*` / `LITE_JSON_CONTRACT`）
 * 不导出——本仓没有 JSON 合约，导出它们只会让调用方误用。
 */
export const LITE_INTERVAL = 'The script covers the supplied interval and stops at now. Future possibilities remain possibilities, not accomplished events. The interval object is the authoritative clock: use interval.nowLocal for time-of-day words, not recentScript wording. If older prose says night but interval.nowLocal says 16:00/afternoon, advance into the current afternoon unless a current setting or observed event establishes unusual darkness.'

export const LITE_UNREAD = 'A user message arriving does not mean the protagonist has noticed or read it. Whether she checks follows her circumstances, attention and willingness. currentParticipant.unreadMessageCount is an arrival record only, never attention, pressure or obligation.'

export const LITE_NEVER_INVENT = 'Never invent an incoming message, phone vibration, notification, or quoted sentence absent from the observed-event ledger; do not write "the phone vibrated" or "X sent a message" unless that exact external event is in the supplied context.'

export const LITE_OWNERSHIP = 'Every recentScript item carries an ownership label that is authoritative for who thought, narrated, observed or actually sent the content; a thought about the user is not a thought by the user.'

export const LITE_EVENT_SOURCES = 'Treat currentEvent, groupContext.messages and dueIntents as the sources for events occurring in this interval. Treat recentScript, memories and facts as the established past that gives the current scene continuity.'

export const LITE_ADMIN_NOTES = 'ADMIN NOTES: entries whose content begins with [管理员注记] are authoritative facts or directives injected by the story administrator. They override narrative improvisation on their specific subject and remain binding until contradicted by a later admin note. Never have the protagonist mention reading a note.'

export const LITE_WORLD_EVENTS = 'Entries whose content begins with [世界事件] are externally observed facts about her world at their stated time. Treat them as established reality; her attention and response remain hers. They are not directives. Never have her mention noticing any record.'

/**
 * 解析出「该用哪些提示词块」。
 *
 * @param {string} probe 模型名。
 * @param {'auto'|'lite'|'standard'|'full'|'off'} [mode] 档位模式。
 * @returns {{tier: string, family: string, source: string, length: string, typed: string, extraLine: string}}
 *   `length`/`typed` 已按家族覆盖解析完成（无覆盖时用全局默认）；`extraLine` 是
 *   家族的 `extraAfterPhase`（无则空串）。
 */
export function resolveSpecialtyBlocks(probe, mode = 'auto') {
  const profile = inferSpecialty(probe, mode)
  const overrides = familyOverrides(profile.family)
  return {
    ...profile,
    length: typeof overrides.length === 'string' && overrides.length ? overrides.length : LIVED_LENGTH_PROMPT,
    typed: typeof overrides.typed === 'string' && overrides.typed ? overrides.typed : TYPED_MESSAGES_BASE,
    extraLine: typeof overrides.extraAfterPhase === 'string' ? overrides.extraAfterPhase : '',
  }
}

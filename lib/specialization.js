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

/* ──────────────────────────────── 家族块（本仓口径的中文内容） ──────────────────────────────── */

/** 完整版打字/贴图块（= 本仓 rc5/rc7 移植的常驻基线）。 */
export const TYPED_FULL = [
  '- **每一轮都是独立的选择**：上一轮发了几条**不约束**这一轮——就按此刻的需要决定。',
  '- 表情包和图片是**元语言**：结合画面与当下语境理解它传达的态度与信息状态',
  '  （可能是「收到/已阅」、迟疑、反讽或者情绪底色），**不要停在画面本身上**——',
  '  一张猫的贴图可能只是「看到了」，而不是在评论这只猫。同一个贴图连发多次同样是',
  '  **有意的表达**（强调、执着、玩闹、不耐烦）。',
].join('\n')

/** 精简版打字/贴图块（对应上游 `TYPED_MESSAGES_GEMINI_FLASH`：更短、更直白、去掉例子延展）。 */
export const TYPED_CONDENSED = [
  '- **每一轮都是独立的选择**：上一轮发了几条**不约束**这一轮。真人打出来的聊天消息是朴素、具体、直接的。',
  '- 表情包和图片是**元语言**：结合画面与当下语境看它的意思，**不要停在画面本身上**；',
  '  同一个贴图连发多次同样是有意的表达。',
].join('\n')

/** kimi 版：在完整版之后补「矛盾与迟疑是正常状态」（对应上游 `TYPED_MESSAGES_KIMI`）。 */
export const TYPED_KIMI_EXTRA = [
  '- 对话里她可以迟疑、说到一半改主意、只回一部分、或者留一个没说完的念头；',
  '  也可以现在先简短应一声、晚点再认真答，或者同时想要两样东西而不选任何一样。',
  '  真人不会在每次交流里都给出定论——**矛盾是正常状态**，不是需要解决的问题。',
].join('\n')

/** 家族覆盖（对齐上游「最小偏移：打字块替换 + 至多一条新增行」）。 */
export function familyOverrides(family) {
  switch (family) {
    case 'gemini-flash':
      return {
        typed: TYPED_CONDENSED,
        extraAfterPhase: '行文基调：具体、不修饰。用具体的动作、物件与感觉呈现事件，不要对发生的事做点评、美化或诗化——事实本身就能撑住那一幕。',
      }
    case 'kimi':
      return { typedExtra: TYPED_KIMI_EXTRA }
    case 'claude':
      return {
        extraAfterPhase: '场景不必有整齐的收尾。日常生活会把小事留着不解决、情绪不解释、对话不说完；该停在一半就停在一半。不要用总结句、教训或情绪标签收尾——真实的日子会越过任何一段继续下去。',
      }
    case 'glm':
      return {
        extraAfterPhase: '情绪基调：让心情跟着它真实的起因走，并保持在普通范围内。除非事件本身支持，不要滑向温情、安慰或安抚——没有凭空的鼓励，不在段末把坏心情抹平，也不给事件本身没产生的光明面。',
      }
    default:
      return {}
  }
}

/**
 * 解析出「该用哪个打字块 + 要不要补一条家族行」。
 *
 * @param {string} probe 模型名。
 * @param {'auto'|'lite'|'standard'|'full'|'off'} [mode] 档位模式。
 * @returns {{tier: string, family: string, source: string, typed: string, extraLine: string}}
 */
export function resolveSpecialtyBlocks(probe, mode = 'auto') {
  const profile = inferSpecialty(probe, mode)
  const overrides = familyOverrides(profile.family)
  const typed = typeof overrides.typed === 'string' && overrides.typed
    ? overrides.typed
    : (overrides.typedExtra ? `${TYPED_FULL}\n${overrides.typedExtra}` : TYPED_FULL)
  return {
    ...profile,
    typed,
    extraLine: typeof overrides.extraAfterPhase === 'string' ? overrides.extraAfterPhase : '',
  }
}

/**
 * 认知证据（Knowledge Evidence）—— 区分「她以为」与「双方确认」。
 * 移植自上游 hds-interlude `src/script/knowledge-evidence.ts`。
 *
 * ## 它解决什么问题
 *
 * 角色最典型的失真不是记错事实，而是**把自己的想法当成已达成的约定**：
 * 「她说好周末来」——可回看原文，那只是她自己的期待，对方从没答应过。
 * 一旦这种"信念"被当成事实写进长期记忆，后面所有推理都建立在假的共识上，
 * 而且**不会报错**——故事照样推进，只是人物关系悄悄失真了。
 *
 * 这里给每条知识标一个**认知模式**，并强制它带上原文证据：
 *
 *     observed → reported → belief → proposal → conditional → confirmed
 *
 * 其中只有 `confirmed` 需要**双向交换证据**（一方提案 + 另一方确认），
 * 且两条都必须来自**真实投递**的条目、来自**不同的人**。
 *
 * ## 一条关键的区分
 *
 * `isDeliveredKind` 把条目分成「真实说出的话」与「叙述散文」。
 * **散文里的一句引号不能确认另一个人的行为**——「她心想：他说过会来」
 * 里的引号只证明她这么想过，不证明他说过。所以叙述条目里的 `confirmation`
 * 会被**降级成** `interpretation`。
 *
 * @module dsh-hds-interlude/knowledge-evidence
 */

import { isDeliveredKind, entryById } from './script-entry.js'

/** 认知模式，从弱到强。 */
export const KNOWLEDGE_MODES = [
  'observed', 'reported', 'belief', 'proposal', 'conditional', 'confirmed', 'unclassified',
]

/** 子句角色。 */
export const CLAUSE_ROLES = ['observation', 'interpretation', 'proposal', 'condition', 'confirmation']

/** 一条知识最多带几条子句（上游 12）。 */
const MAX_CLAUSES = 12
/** 单条引文长度上限（上游 800）。 */
const MAX_QUOTE = 800
/** 关联事实 id 上限（上游 12）。 */
const MAX_RELATED = 12

/**
 * 规范化一条认知证据。
 *
 * ## 校验的是**引用**，不是自然语言的含义
 *
 * 上游原话：`Validate references, not the meaning of natural language.`
 * 我们只检查「这条引文确实在那条条目里」，至于它是否真的构成「确认」，
 * 那是文学判读，不是代码能裁定的。代码只负责把**没有依据的**挡掉。
 *
 * @param {unknown} raw 模型给的 `{ mode, holder?, topic?, clauses: [...] }`。
 * @param {object} ledger 条目账本。
 * @param {number[]} [sourceEntryIds] 允许引用的条目 id（通常是本轮的）。
 * @param {number[]} [relatedFactIds] 关联的长期事实 id。
 * @returns {object} 规范化后的认知证据（永不返回 undefined，最差是 unclassified）。
 */
export function normalizeKnowledgeEvidence(raw, ledger, sourceEntryIds = [], relatedFactIds = []) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const allowed = new Set((sourceEntryIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0))
  const clauses = []

  for (const clause of Array.isArray(value.clauses) ? value.clauses.slice(0, MAX_CLAUSES) : []) {
    if (!clause || typeof clause !== 'object') continue
    const id = Number(clause.sourceEntryId)
    // 必须指向**允许范围内**的条目——否则模型可以引用一段不相干的原文充数。
    if (!allowed.has(id)) continue
    if (!CLAUSE_ROLES.includes(clause.role)) continue
    const entry = entryById(ledger, id)
    if (!entry) continue
    // 引文逐字校验：长度与「确实在该条目里」。
    if (typeof clause.quote !== 'string' || !clause.quote.trim() || clause.quote.length > MAX_QUOTE) continue
    if (!entry.content.includes(clause.quote)) continue

    // **降级规则**：叙述类条目里的「确认」不算确认。
    // 「她心想：他说过会来」只证明她这么想过，不证明他说过。
    const delivered = isDeliveredKind(entry.kind)
    const role = clause.role === 'confirmation' && !delivered ? 'interpretation' : clause.role
    clauses.push({ role, sourceEntryId: id, quote: clause.quote })
  }

  let mode = KNOWLEDGE_MODES.includes(value.mode) ? value.mode : 'unclassified'
  // 没有一条站得住的子句 → 什么都确认不了。
  if (!clauses.length) mode = 'unclassified'

  if (mode === 'confirmed') {
    // `confirmed` 的门槛：**双向交换**。
    // 一方提案（proposal）+ 另一方确认（confirmation），两条都得是真实投递的条目，
    // 来自**不同的人**，且确认发生在提案之后。
    const proposed = clauses.filter(c => c.role === 'proposal')
    const confirmed = clauses.filter(c => c.role === 'confirmation')
    const exchanged = proposed.some(p => confirmed.some(c => {
      const a = entryById(ledger, p.sourceEntryId)
      const b = entryById(ledger, c.sourceEntryId)
      if (!a || !b) return false
      return isDeliveredKind(a.kind) && isDeliveredKind(b.kind)
        && a.kind !== b.kind
        && a.participantId === b.participantId
        && b.id > a.id
    }))
    // 交换不成立：有「条件」子句就降为 conditional，否则退回 unclassified。
    // 刻意**不降成 belief**——belief 是「主观解读」，而这只是「配不上 confirmed」。
    if (!exchanged) mode = clauses.some(c => c.role === 'condition') ? 'conditional' : 'unclassified'
  }

  // 主观解读混进「观察」→ 降为信念。观察是「谁做了什么」，不是「我认为他为什么做」。
  if (mode === 'observed' && clauses.some(c => c.role === 'interpretation')) mode = 'belief'

  const evidence = {
    mode,
    clauses,
    // 防御：`relatedFactIds` 来自模型输出，可能是任意类型。
    relatedFactIds: [...new Set((Array.isArray(relatedFactIds) ? relatedFactIds : []).filter(Number.isSafeInteger))].slice(0, MAX_RELATED),
  }
  // holder 只在信念时有默认值（信念总得有个持有者）；其余情况必须显式给。
  const holder = typeof value.holder === 'string' && value.holder.trim() ? value.holder.trim().slice(0, 127) : undefined
  if (holder) evidence.holder = holder
  else if (mode === 'belief') evidence.holder = 'protagonist'
  // topic 必须真的出现在某条引文里，否则它只是个凭空贴的标签。
  if (typeof value.topic === 'string' && value.topic.length <= 80 && clauses.some(c => c.quote.includes(value.topic))) {
    evidence.topic = value.topic
  }
  return evidence
}

/**
 * 安全地取子句（老数据里可能是 `{}` 或半残对象）。
 *
 * @param {object|undefined} knowledge 认知证据。
 * @returns {Array<object>}
 */
export function knowledgeClauses(knowledge) {
  return Array.isArray(knowledge?.clauses) ? knowledge.clauses : []
}

/**
 * 安全地取关联事实 id。
 *
 * @param {object|undefined} knowledge 认知证据。
 * @returns {number[]}
 */
export function knowledgeRelatedIds(knowledge) {
  return Array.isArray(knowledge?.relatedFactIds) ? knowledge.relatedFactIds : []
}

/**
 * 这条知识能不能支撑「事情已经发生」的判断。
 *
 * 只有 `observed` / `reported` / `confirmed` 算数，且必须**有观察或确认子句**、
 * 且**不含任何主观解读**——一旦混进解读，它就不是「记录」而是「看法」了。
 *
 * @param {object|undefined} knowledge 认知证据。
 * @returns {boolean}
 */
export function supportsRecordedOutcome(knowledge) {
  if (!knowledge) return false
  if (!['observed', 'reported', 'confirmed'].includes(knowledge.mode)) return false
  const clauses = knowledgeClauses(knowledge)
  const hasFact = clauses.some(c => c.role === 'observation' || c.role === 'confirmation')
  const hasInterpretation = clauses.some(c => c.role === 'interpretation')
  return hasFact && !hasInterpretation
}

/**
 * 旧数据（还没有证据字段的年代）的导航线索。
 *
 * 只用来**决定要不要把它捞出来看**，绝不表示「条件成立」或「条件已满足」。
 *
 * @param {string} content 事实内容。
 * @returns {boolean}
 */
export function legacyConditionCue(content) {
  return /前置|前提|门槛|至少|除非/.test(String(content ?? ''))
}

/**
 * 把一条事实整理成**供提示词使用的**证据形态。
 *
 * 关键点：`authority` 字段。
 *   - `belief` → `attributed-belief`：这是**她的解读**，不是已确认的事实；
 *   - 其余 → `derived-record`：来自记录的推导。
 *
 * 下游（提示词）据此决定措辞——是「她以为他在生气」还是「他在生气」。
 *
 * @param {object} fact 长期事实。
 * @returns {object}
 */
export function factEvidenceForPrompt(fact) {
  const raw = fact?.knowledge
  const knowledge = raw && Array.isArray(raw.clauses) ? raw
    : raw && Array.isArray(raw.relatedFactIds) ? { ...raw, clauses: [] }
      : undefined
  return {
    id: fact?.id,
    participantId: fact?.participantId,
    scope: fact?.scope,
    content: fact?.content,
    unresolved: fact?.unresolved,
    status: fact?.status,
    sourceEntryIds: fact?.sourceEntryIds,
    authority: knowledge?.mode === 'belief' ? 'attributed-belief' : 'derived-record',
    knowledge: knowledge ?? { mode: 'unclassified', clauses: [], relatedFactIds: [] },
  }
}

/**
 * 渲染认知证据的提示词片段。
 *
 * 只在模式**确实说明了什么**时才输出——`unclassified` 不占篇幅。
 *
 * @param {object|undefined} knowledge 认知证据。
 * @returns {string} 片段；无可说时返回空串。
 */
export function renderKnowledge(knowledge) {
  if (!knowledge || knowledge.mode === 'unclassified') return ''
  const labels = {
    observed: '已观察到',
    reported: '据对方所说',
    belief: '她的主观解读（**未获对方确认**）',
    proposal: '已提出但未见回应',
    conditional: '有条件的（条件未满足前不成立）',
    confirmed: '双方已确认',
  }
  const label = labels[knowledge.mode]
  if (!label) return ''
  return `认知模式：${label}`
}

/**
 * 供提示词使用的写作框架。
 *
 * 与上游 `KNOWLEDGE_WRITING_FRAME` 同义，但**不照搬**上游那段 Script-First 的
 * 长文——DSH 的口径是「工具化」，只需要说清判据。
 */
export const KNOWLEDGE_WRITING_FRAME = 'EVIDENCE AND EXPECTATION: 原文是唯一的生活底本。'
  + '她的想法、期待与推测属于**她的视角**；已发生的动作属于**做出它的人**。'
  + '记录一条知识时要标明它的认知模式：'
  + 'observed（亲眼所见）/ reported（对方所说）/ belief（她的解读）/ proposal（已提出）/ '
  + 'conditional（有前置条件）/ confirmed（双方确认）。'
  + '**confirmed 必须有双向证据**：一方提案 + 另一方确认，且两条都来自真实说出的话。'
  + '散文里的一句引号只能证明她这么想过，**不能**确认另一个人的行为。'
  + '没被确认的接触应当继续表现为未决——它可以促使她再问一次或私下期待，'
  + '但对方的承诺与时机仍然悬着。沉默可以改变她的心情，不会改变对方答应过什么。'

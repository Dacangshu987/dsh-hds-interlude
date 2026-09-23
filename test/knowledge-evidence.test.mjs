/**
 * 认知证据（`lib/knowledge-evidence.js`）的用例。
 *
 * 这一层防的是角色最典型的失真：**把自己的想法当成已达成的约定**。
 * 所以要钉住的核心不是「函数能跑」，而是：
 *
 *   ① `confirmed` 必须有**双向交换证据**（一方提案 + 另一方确认，
 *      不同的人、确认在后）；
 *   ② 叙述散文里的「确认」**降级**成解读——引号只证明她这么想过；
 *   ③ 主观解读混进「观察」→ 降为信念；
 *   ④ `authority` 要如实标注，下游据此决定措辞。
 *
 * 运行：node test/knowledge-evidence.test.mjs
 */
import assert from 'node:assert/strict'

import {
  normalizeKnowledgeEvidence, knowledgeClauses, knowledgeRelatedIds,
  supportsRecordedOutcome, legacyConditionCue, factEvidenceForPrompt,
  renderKnowledge, KNOWLEDGE_MODES, CLAUSE_ROLES, KNOWLEDGE_WRITING_FRAME,
} from '../lib/knowledge-evidence.js'

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

console.log('认知证据')

/** 一个两方对话的账本：用户提案 → 角色确认。 */
const LEDGER = {
  cursor: 5,
  nextId: 6,
  entries: [
    { id: 1, kind: 'user-message', participantId: 'p1', content: '那周末我来找你吧。', metadata: {} },
    { id: 2, kind: 'character-message', participantId: 'p1', content: '好啊，周末见。', metadata: {} },
    { id: 3, kind: 'script', participantId: 'p1', content: '（她心想：他说过会来的。）', metadata: {} },
    { id: 4, kind: 'user-message', participantId: 'p2', content: '周末我不一定有空。', metadata: {} },
    { id: 5, kind: 'character-message', participantId: 'p2', content: '那我等你消息。', metadata: {} },
  ],
}
const ALL = [1, 2, 3, 4, 5]

/* ------------------------------------------------------ ① confirmed 门槛 */

ok('confirmed：一方提案 + 另一方确认 + 确认在后 → 成立', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [
      { role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' },
      { role: 'confirmation', sourceEntryId: 2, quote: '好啊，周末见' },
    ],
  }, LEDGER, ALL)
  assert.equal(ev.mode, 'confirmed')
  assert.equal(ev.clauses.length, 2)
})

ok('confirmed：只有提案、没有确认 → 不成立', () => {
  // 这是最常见的失真：她提了，就以为说定了。
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [{ role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' }],
  }, LEDGER, ALL)
  assert.notEqual(ev.mode, 'confirmed')
})

ok('confirmed：同一方的「提案+确认」不算交换', () => {
  // 两条都是 user-message（同一种 kind）→ 不是双向交换。
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [
      { role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' },
      { role: 'confirmation', sourceEntryId: 4, quote: '周末我不一定有空' },
    ],
  }, LEDGER, ALL)
  assert.notEqual(ev.mode, 'confirmed')
})

ok('confirmed：确认发生在提案**之前** → 不成立（顺序要讲得通）', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [
      { role: 'proposal', sourceEntryId: 2, quote: '好啊，周末见' },
      { role: 'confirmation', sourceEntryId: 1, quote: '那周末我来找你吧' },
    ],
  }, LEDGER, ALL)
  assert.notEqual(ev.mode, 'confirmed')
})

ok('confirmed：全无子句 → unclassified（什么都确认不了）', () => {
  assert.equal(normalizeKnowledgeEvidence({ mode: 'confirmed' }, LEDGER, ALL).mode, 'unclassified')
})

/* ------------------------------------------------------ ② 叙述不构成确认 */

ok('叙述里的「确认」被降级成解读', () => {
  // 关键区分：「她心想：他说过会来」里的引号只证明**她这么想过**，
  // 不证明他说过。所以 kind='script' 的条目不能充当 confirmation。
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [{ role: 'confirmation', sourceEntryId: 3, quote: '他说过会来的' }],
  }, LEDGER, ALL)
  assert.equal(ev.mode, 'unclassified', '叙述里的确认不该让 confirmed 成立')
  assert.equal(ev.clauses[0].role, 'interpretation', '角色本身应被降级为解读')
})

ok('主观解读混进 observed → 降为 belief', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [
      { role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' },
      { role: 'interpretation', sourceEntryId: 3, quote: '他说过会来的' },
    ],
  }, LEDGER, ALL)
  assert.equal(ev.mode, 'belief', '观察里混了解读就不是纯观察了')
})

ok('纯观察保持 observed', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }],
  }, LEDGER, ALL)
  assert.equal(ev.mode, 'observed')
})

/* ------------------------------------------------------ ③ 引用校验 */

ok('引文对不上 → 该子句被丢弃', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [{ role: 'observation', sourceEntryId: 1, quote: '这句话不在原文里' }],
  }, LEDGER, ALL)
  assert.equal(ev.clauses.length, 0)
  assert.equal(ev.mode, 'unclassified')
})

ok('引用**允许范围之外**的条目 → 丢弃', () => {
  // 否则模型可以引用一段不相干的原文来充数。
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [{ role: 'observation', sourceEntryId: 5, quote: '那我等你消息' }],
  }, LEDGER, [1, 2]) // 只允许 1、2
  assert.equal(ev.clauses.length, 0)
})

ok('引用不存在的条目 → 丢弃', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [{ role: 'observation', sourceEntryId: 999, quote: '随便' }],
  }, LEDGER, [999])
  assert.equal(ev.clauses.length, 0)
})

ok('非法 role / 超长引文 / 空引文 → 丢弃', () => {
  const bad = [
    { role: '外星角色', sourceEntryId: 1, quote: '那周末我来找你吧' },
    { role: 'observation', sourceEntryId: 1, quote: 'x'.repeat(900) },
    { role: 'observation', sourceEntryId: 1, quote: '   ' },
  ]
  const ev = normalizeKnowledgeEvidence({ mode: 'observed', clauses: bad }, LEDGER, ALL)
  assert.equal(ev.clauses.length, 0)
})

ok('部分合法：好的留下，坏的丢掉', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [
      { role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' },
      { role: 'observation', sourceEntryId: 1, quote: '不存在的片段' },
    ],
  }, LEDGER, ALL)
  assert.equal(ev.clauses.length, 1)
})

/* ------------------------------------------------------ ④ conditional 降级 */

ok('confirmed 不成立但有条件子句 → conditional（不是 belief）', () => {
  // belief 是「主观解读」，这里只是「配不上 confirmed」——两者不能混。
  const ev = normalizeKnowledgeEvidence({
    mode: 'confirmed',
    clauses: [
      { role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' },
      { role: 'condition', sourceEntryId: 4, quote: '周末我不一定有空' },
    ],
  }, LEDGER, ALL)
  assert.equal(ev.mode, 'conditional')
})

/* ------------------------------------------------------ ⑤ 持有者与主题 */

ok('belief 默认持有者是主角；其它模式不自动补', () => {
  const belief = normalizeKnowledgeEvidence({
    mode: 'belief',
    clauses: [{ role: 'interpretation', sourceEntryId: 3, quote: '他说过会来的' }],
  }, LEDGER, ALL)
  assert.equal(belief.holder, 'protagonist')

  const observed = normalizeKnowledgeEvidence({
    mode: 'observed',
    clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }],
  }, LEDGER, ALL)
  assert.equal(observed.holder, undefined)
})

ok('显式 holder 优先于默认值', () => {
  const ev = normalizeKnowledgeEvidence({
    mode: 'belief', holder: '林知夏',
    clauses: [{ role: 'interpretation', sourceEntryId: 3, quote: '他说过会来的' }],
  }, LEDGER, ALL)
  assert.equal(ev.holder, '林知夏')
})

ok('topic 必须真的出现在某条引文里（否则只是凭空贴的标签）', () => {
  const good = normalizeKnowledgeEvidence({
    mode: 'observed', topic: '周末',
    clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }],
  }, LEDGER, ALL)
  assert.equal(good.topic, '周末')

  const bad = normalizeKnowledgeEvidence({
    mode: 'observed', topic: '完全无关的标签',
    clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }],
  }, LEDGER, ALL)
  assert.equal(bad.topic, undefined)
})

/* ------------------------------------------------------ ⑥ 鲁棒性 */

ok('畸形输入安全，且永不返回 undefined', () => {
  for (const bad of [undefined, null, 'x', 42, [], { clauses: 'nope' }, { mode: 123 }]) {
    const ev = normalizeKnowledgeEvidence(bad, LEDGER, ALL)
    assert.equal(ev.mode, 'unclassified')
    assert.deepEqual(ev.clauses, [])
  }
})

ok('无账本 / 空账本时不崩', () => {
  assert.equal(normalizeKnowledgeEvidence({ mode: 'observed' }, undefined, ALL).mode, 'unclassified')
  assert.equal(normalizeKnowledgeEvidence({ mode: 'observed' }, { entries: [] }, ALL).mode, 'unclassified')
})

ok('knowledgeClauses / knowledgeRelatedIds 对老数据安全', () => {
  assert.deepEqual(knowledgeClauses(undefined), [])
  assert.deepEqual(knowledgeClauses({}), [])
  assert.deepEqual(knowledgeClauses({ clauses: 'x' }), [])
  assert.deepEqual(knowledgeRelatedIds(undefined), [])
  assert.deepEqual(knowledgeRelatedIds({ relatedFactIds: [1, 2] }), [1, 2])
})

/* ------------------------------------------------------ ⑦ 下游判读 */

ok('supportsRecordedOutcome：只有「记录」类型且不含解读才算数', () => {
  assert.equal(supportsRecordedOutcome({ mode: 'observed', clauses: [{ role: 'observation' }] }), true)
  assert.equal(supportsRecordedOutcome({ mode: 'confirmed', clauses: [{ role: 'confirmation' }] }), true)
  assert.equal(supportsRecordedOutcome({ mode: 'observed', clauses: [{ role: 'interpretation' }] }), false)
  assert.equal(supportsRecordedOutcome({ mode: 'belief', clauses: [{ role: 'observation' }] }), false)
  assert.equal(supportsRecordedOutcome({ mode: 'unclassified', clauses: [] }), false)
  assert.equal(supportsRecordedOutcome(undefined), false)
})

ok('factEvidenceForPrompt：belief 标成 attributed-belief', () => {
  // 下游据此决定措辞：是「她以为他在生气」还是「他在生气」。
  const belief = factEvidenceForPrompt({
    id: 'f1', content: '他在生气', knowledge: { mode: 'belief', clauses: [], relatedFactIds: [] },
  })
  assert.equal(belief.authority, 'attributed-belief')

  const observed = factEvidenceForPrompt({
    id: 'f2', content: '他昨天来了', knowledge: { mode: 'observed', clauses: [], relatedFactIds: [] },
  })
  assert.equal(observed.authority, 'derived-record')
})

ok('factEvidenceForPrompt：没有 knowledge 字段的老事实也能读', () => {
  const legacy = factEvidenceForPrompt({ id: 'f3', content: '老数据' })
  assert.equal(legacy.authority, 'derived-record')
  assert.equal(legacy.knowledge.mode, 'unclassified')
  assert.deepEqual(legacy.knowledge.clauses, [])
})

ok('legacyConditionCue：只作导航，不表示条件成立', () => {
  assert.equal(legacyConditionCue('前提是你要来'), true)
  assert.equal(legacyConditionCue('除非下雨'), true)
  assert.equal(legacyConditionCue('普通内容'), false)
  assert.equal(legacyConditionCue(undefined), false)
})

ok('renderKnowledge：unclassified 不占篇幅', () => {
  assert.equal(renderKnowledge({ mode: 'unclassified', clauses: [] }), '')
  assert.equal(renderKnowledge(undefined), '')
  assert.match(renderKnowledge({ mode: 'belief', clauses: [] }), /未获对方确认/)
  assert.match(renderKnowledge({ mode: 'confirmed', clauses: [] }), /双方已确认/)
})

ok('常量与上游一致', () => {
  assert.deepEqual(KNOWLEDGE_MODES, ['observed', 'reported', 'belief', 'proposal', 'conditional', 'confirmed', 'unclassified'])
  assert.deepEqual(CLAUSE_ROLES, ['observation', 'interpretation', 'proposal', 'condition', 'confirmation'])
})

ok('KNOWLEDGE_WRITING_FRAME：写明 confirmed 需要双向证据', () => {
  assert.match(KNOWLEDGE_WRITING_FRAME, /双向证据/)
  assert.match(KNOWLEDGE_WRITING_FRAME, /不能\*\*确认另一个人的行为|不能\*\*确认/)
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

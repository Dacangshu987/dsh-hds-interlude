/**
 * 长期记忆注入（`renderFacts` + 幕间块）的用例。
 *
 * 这一层的存在理由：在它之前，`interlude_memory` 写进去的长期事实**从来没进过
 * 提示词**——只有人工 `/interlude context` 能看见，模型全程不知情。那等于
 * 「记了但没人看」，`recall.js` 的词法召回与 `knowledge-evidence` 的认知模式
 * 也都跟着失去了下游。
 *
 * 要钉住的三条口径：
 *   ① **她的解读不能和已确认的事实平铺**（那是失真的通道）；
 *   ② 有预算上限，且空时不出现占位；
 *   ③ 相关度真的能把「刚提到的那件事」捞上来。
 *
 * 运行：node test/facts-injection.test.mjs
 */
import assert from 'node:assert/strict'

import { renderFacts, renderInterludeBlock } from '../lib/render.js'
import { emptyState, addFact, rankFacts } from '../lib/state.js'
import { recallFocus } from '../lib/recall.js'

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

console.log('长期记忆注入')

const fact = (id, scope, content, knowledge) => ({ id, scope, content, ...(knowledge ? { knowledge } : {}) })

/* ------------------------------------------------------ ① 认知模式标注 */

ok('未确认的接触被显式标注（belief 不能写成事实）', () => {
  // 这是整条链路的**核心防线**：她以为 ≠ 说定了。
  const text = renderFacts({
    facts: [fact('f1', 'general', '他在生气', { mode: 'belief', clauses: [] })],
  })
  assert.match(text, /她的解读/)
  assert.match(text, /未获对方确认/)
})

ok('proposal（提了没回应）也被标注', () => {
  const text = renderFacts({
    facts: [fact('f1', 'event', '她提过要搬家', { mode: 'proposal', clauses: [] })],
  })
  assert.match(text, /尚未得到回应/)
})

ok('conditional（有前置条件）被标注', () => {
  const text = renderFacts({
    facts: [fact('f1', 'promise', '他会来', { mode: 'conditional', clauses: [] })],
  })
  assert.match(text, /前置条件/)
})

ok('reported（据对方所说）被标注——与亲眼所见可信度不同', () => {
  const text = renderFacts({
    facts: [fact('f1', 'event', '他昨天加班', { mode: 'reported', clauses: [] })],
  })
  assert.match(text, /据对方所说/)
})

/** 取「条目行」（跳过开头那句说明），断言只看条目本身。 */
const itemLines = text => text.split('\n').slice(1)

ok('observed / confirmed 不加前缀（本身已是可靠层级）', () => {
  const text = renderFacts({
    facts: [
      fact('f1', 'event', '他昨天来过', { mode: 'observed', clauses: [] }),
      fact('f2', 'promise', '约好周末见面', { mode: 'confirmed', clauses: [] }),
    ],
  })
  for (const line of itemLines(text)) {
    assert.doesNotMatch(line, /她的解读|未获对方确认|尚未得到回应/, line)
  }
})

ok('老数据（没有认知模式）不被打成可疑', () => {
  // unclassified 是「还没标注」，不是「不可信」。给它加前缀等于让所有历史事实
  // 一夜之间变成"她以为"。
  const text = renderFacts({ facts: [fact('f1', 'world', '老数据')] })
  assert.match(text, /老数据/)
  for (const line of itemLines(text)) {
    assert.doesNotMatch(line, /解读|未获|尚未|前置|据对方/, line)
  }
})

ok('事实类别有中文标签', () => {
  const text = renderFacts({ facts: [fact('f1', 'promise', 'x', { mode: 'confirmed', clauses: [] })] })
  assert.match(text, /［承诺］/)
})

/* ------------------------------------------------------ ② 预算与空值 */

ok('空事实 → 空串（不留「（无）」这种占位）', () => {
  // 占位符只会教模型「这里应该有点什么」。
  assert.equal(renderFacts({ facts: [] }), '')
  assert.equal(renderFacts({}), '')
  assert.equal(renderFacts(), '')
  assert.equal(renderFacts({ facts: null }), '')
})

ok('按 limit 截断（记忆无界，上下文预算有界）', () => {
  const facts = Array.from({ length: 30 }, (_, i) => fact(`f${i}`, 'general', `第${i}条`))
  const text = renderFacts({ facts, limit: 5 })
  assert.equal(text.split('\n').length, 6, `标题 + 5 条，实际 ${text.split('\n').length}`)
  assert.match(text, /第0条/)
  assert.doesNotMatch(text, /第5条/)
})

ok('limit 为 0 / 负数时不崩', () => {
  const facts = [fact('f1', 'general', 'x')]
  assert.equal(renderFacts({ facts, limit: 0 }), '')
  assert.equal(renderFacts({ facts, limit: -1 }), '')
})

/* ------------------------------------------------------ ③ 幕间块整合 */

ok('幕间块在有记忆时会注入「长期记忆」段', () => {
  const state = emptyState()
  const text = renderInterludeBlock({
    now: Date.now(), zone: 'Asia/Shanghai', state, config: {}, due: [],
    facts: [fact('f1', 'promise', '约好周末见面', { mode: 'confirmed', clauses: [] })],
  })
  assert.match(text, /长期记忆/)
  assert.match(text, /约好周末见面/)
})

ok('只有记忆、没有别的实质内容时**也要**注入', () => {
  // 否则「只有记忆」的会话会被提前 return，记忆永远注不进去（overlay 踩过同款坑）。
  const state = emptyState()
  const text = renderInterludeBlock({
    now: Date.now(), zone: 'Asia/Shanghai', state, config: {}, due: [],
    facts: [fact('f1', 'general', '某件事', { mode: 'observed', clauses: [] })],
  })
  assert.notEqual(text, '')
  assert.match(text, /某件事/)
})

ok('没有记忆时幕间块里不出现「长期记忆」段', () => {
  const state = emptyState()
  const text = renderInterludeBlock({
    now: Date.now(), zone: 'Asia/Shanghai', state, config: { alwaysReportTime: true }, due: [], facts: [],
  })
  assert.doesNotMatch(text, /长期记忆/)
})

ok('按 config.memoryLimit 截断', () => {
  const state = emptyState()
  const facts = Array.from({ length: 20 }, (_, i) => fact(`f${i}`, 'general', `记忆${i}`, { mode: 'observed', clauses: [] }))
  const text = renderInterludeBlock({
    now: Date.now(), zone: 'Asia/Shanghai', state, config: { memoryLimit: 3 }, due: [], facts,
  })
  assert.match(text, /记忆0/)
  assert.doesNotMatch(text, /记忆3/)
})

/* ------------------------------------------------------ ④ 相关度真的生效 */

ok('相关度能把「刚提到的那件事」从后排捞上来', () => {
  // 只按「重要度 + 新旧」排的话，高重要度的旧事实会永远压过昨天刚聊到的细节。
  const state = emptyState()
  const now = Date.now()
  addFact(state, { scope: 'general', content: '最近项目很忙，在赶进度', importance: 0.95 }, now)
  addFact(state, { scope: 'general', content: '家里养了只猫叫豆豆', importance: 0.9 }, now)
  addFact(state, { scope: 'general', content: '周末常去公园散步', importance: 0.2 }, now)

  const byImportance = rankFacts(state, 20, now).map(f => f.content.slice(0, 4))
  assert.equal(byImportance[0], '最近项目', '不查询时，仍按重要度排')

  const byRecall = rankFacts(state, 20, now, { query: recallFocus('公园散步怎么样') }).map(f => f.content.slice(0, 4))
  assert.equal(byRecall[0], '周末常去', `相关的应浮上来，实际：${byRecall}`)
})

ok('recallFocus 拼出查询串；无输入时为空', () => {
  assert.match(recallFocus('在吗', ['喝水']), /在吗/)
  assert.equal(recallFocus(undefined, []), '')
})

/* ------------------------------------------------------ ⑤ 端到端（渲染层） */

ok('端到端：写入 → 排序 → 渲染，认知模式一路保留', () => {
  const state = emptyState()
  const now = Date.now()
  addFact(state, {
    scope: 'promise', content: '约好周末见面', importance: 0.9,
    knowledge: { mode: 'confirmed', clauses: [{ role: 'confirmation', quote: '好啊' }] },
  }, now)
  addFact(state, {
    scope: 'general', content: '他好像不太高兴', importance: 0.9,
    knowledge: { mode: 'belief', clauses: [{ role: 'interpretation', quote: '她心想' }] },
  }, now)

  const facts = rankFacts(state, 20, now)
  const text = renderFacts({ facts })
  // 一条是已确认的事实、一条是她的解读——两者必须读起来不同。
  assert.match(text, /约好周末见面/)
  assert.match(text, /他好像不太高兴/)
  assert.match(text, /她的解读/)
  const confirmedLine = text.split('\n').find(l => l.includes('约好周末见面'))
  const beliefLine = text.split('\n').find(l => l.includes('他好像不太高兴'))
  assert.doesNotMatch(confirmedLine, /解读/, '已确认的不该带解读前缀')
  assert.match(beliefLine, /解读/, '解读必须带前缀')
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

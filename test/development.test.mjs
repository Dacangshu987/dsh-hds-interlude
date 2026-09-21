/**
 * 人格演化门控（`lib/development.js`）的用例。
 *
 * 这一层防的是**性格急变**：模型很容易把一次单独互动（甚至一句玩笑）就上升成
 * 「她的性格变了」。所以要钉住的是：
 *
 *   ① 维度必须在**白名单**内（不猜、不纠正）；
 *   ② 必须跨 **≥2 个不同场景**才够格；
 *   ③ 一次完成场景**只贡献一次**，无论写了多长、来回多少轮；
 *   ④ 互动复核要求回应发生在反馈**之后**，且引用都真实存在。
 *
 * 运行：node test/development.test.mjs
 */
import assert from 'node:assert/strict'

import {
  developmentDimension, developmentScenes, promptReadyDevelopment,
  interactionEvidence, reviewedDevelopmentSupport, developmentContextQuery,
  DEVELOPMENT_DIMENSIONS, DEVELOPMENT_FRAME,
} from '../lib/development.js'

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

console.log('人格演化门控')

/* ------------------------------------------------------ ① 维度白名单 */

ok('developmentDimension：剥掉一层前缀（traits / character.traits）', () => {
  assert.equal(developmentDimension('character', 'traits'), 'traits')
  assert.equal(developmentDimension('character', 'character.traits'), 'traits')
})

ok('developmentDimension：**只剥一层**，三层写法不认（与上游一致）', () => {
  // 上游的正则是 `^(development|character|perspective|relationship|world)\.`，
  // 只去掉**一个**前导段。所以 `development.character.traits` 剥完剩下
  // `character.traits`，不在白名单里 → undefined。
  // 这是上游的既有行为（差分核验里已比对过），刻意不"顺手修好"：
  // 放宽它等于接受更多写法，而白名单的意义正是**只认确定的形状**。
  assert.equal(developmentDimension('character', 'development.character.traits'), undefined)
})

ok('developmentDimension：白名单外的维度一律 undefined（不猜、不纠正）', () => {
  for (const [target, path] of [
    ['character', 'nonsense'],
    ['character', 'values'],        // values 属于 perspective，不属于 character
    ['perspective', 'traits'],
    ['world', 'trust'],
    ['bogus', 'traits'],
    ['character', ''],
  ]) {
    assert.equal(developmentDimension(target, path), undefined, `${target}.${path}`)
  }
})

ok('白名单内容与上游一致', () => {
  assert.deepEqual(DEVELOPMENT_DIMENSIONS, {
    character: ['traits', 'preferences', 'coping'],
    perspective: ['values', 'interpretation'],
    relationship: ['trust', 'closeness', 'boundaries'],
    world: ['established'],
  })
})

/* ------------------------------------------------------ ② 跨场景计数 */

ok('developmentScenes：不同 frameId 算不同场景', () => {
  assert.equal(developmentScenes([
    { id: 1, kind: 'script', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', metadata: { frameId: 'f2' } },
  ]), 2)
})

ok('developmentScenes：同一场景写十条也只算一个（关键）', () => {
  // 上游原话：One completed scene contributes once regardless of prose length or turns.
  // 若这里按「条目数」算，模型只要在同一个场景里多写几句就能刷够两个场景。
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, kind: 'script', metadata: { frameId: 'f1' } }))
  assert.equal(developmentScenes(many), 1)
})

ok('developmentScenes：sceneCheckpoint 优先于 frameId', () => {
  const entries = [
    { id: 1, kind: 'script', metadata: { frameId: 'f1', sceneCheckpoint: { sceneId: 7, firstEntryId: 1, lastEntryId: 2 } } },
    { id: 2, kind: 'script', metadata: { frameId: 'f1' } },
  ]
  assert.equal(developmentScenes(entries), 1)
})

ok('developmentScenes：只数 script 条目（对话不算场景）', () => {
  assert.equal(developmentScenes([
    { id: 1, kind: 'user-message', metadata: { frameId: 'f9' } },
    { id: 2, kind: 'script', metadata: {} },
  ]), 0)
})

ok('developmentScenes：空/畸形输入安全', () => {
  assert.equal(developmentScenes([]), 0)
  assert.equal(developmentScenes(undefined), 0)
  assert.equal(developmentScenes([null, 'x']), 0)
})

/* ------------------------------------------------------ ③ 提案是否够格 */

ok('promptReadyDevelopment：applied 直接放行', () => {
  assert.equal(promptReadyDevelopment({ status: 'applied', sourceEntryIds: [] }, []), true)
})

ok('promptReadyDevelopment：跨两个场景才放行', () => {
  const entries = [
    { id: 1, kind: 'script', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', metadata: { frameId: 'f2' } },
  ]
  assert.equal(promptReadyDevelopment({ status: 'proposed', sourceEntryIds: [1, 2] }, entries), true)
})

ok('promptReadyDevelopment：同一场景内不够格', () => {
  const entries = [
    { id: 1, kind: 'script', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', metadata: { frameId: 'f1' } },
  ]
  assert.equal(promptReadyDevelopment({ status: 'proposed', sourceEntryIds: [1, 2] }, entries), false)
})

ok('promptReadyDevelopment：只引用了没溯源的老条目 → 不够格', () => {
  const entries = [{ id: 1, kind: 'script', metadata: {} }]
  assert.equal(promptReadyDevelopment({ status: 'proposed', sourceEntryIds: [1] }, entries), false)
})

ok('promptReadyDevelopment：空/畸形输入安全', () => {
  assert.equal(promptReadyDevelopment(undefined, []), false)
  assert.equal(promptReadyDevelopment({ status: 'proposed' }, undefined), false)
})

/* ------------------------------------------------------ ④ 互动证据链 */

const CONV = [
  { id: 1, kind: 'character-message', participantId: 'p1', content: '今天怎么样' },
  { id: 2, kind: 'user-message', participantId: 'p1', content: '还行' },
  { id: 3, kind: 'script', participantId: 'p1', content: '（她松了口气。）' },
  { id: 4, kind: 'character-message', participantId: 'p1', content: '那就好' },
  { id: 5, kind: 'user-message', participantId: 'p1', content: '你呢' },
  { id: 6, kind: 'script', participantId: 'p2', content: '（别人写的一段。）' },
]

ok('interactionEvidence：串起「此前沟通 → 反馈 → 解读/回应」', () => {
  const chains = interactionEvidence(CONV)
  const first = chains.find(c => c.feedbackEntryId === 2)
  assert.equal(first.priorCommunicationEntryId, 1, '应找到反馈前的最后一次沟通')
  assert.deepEqual(first.interpretationEntryIds, [3], '随后的散文是解读')
  assert.deepEqual(first.responseEntryIds, [4], '随后的角色消息是回应')
})

ok('interactionEvidence：只管同一参与者，不把别人的话算进来', () => {
  const chains = interactionEvidence(CONV)
  const second = chains.find(c => c.feedbackEntryId === 5)
  assert.ok(!second.responseEntryIds.includes(6), 'p2 的条目不该进 p1 的链')
})

ok('interactionEvidence：畸形输入安全', () => {
  assert.deepEqual(interactionEvidence(undefined), [])
  assert.deepEqual(interactionEvidence([]), [])
})

/* ------------------------------------------------------ ⑤ 复核 */

ok('reviewedDevelopmentSupport：证据齐全且回应在后 → 支持', () => {
  const draft = {
    sourceEntryIds: [2, 4],
    interactionReview: { outcome: 'supported', feedbackEntryIds: [2], responseEntryIds: [4] },
  }
  assert.equal(reviewedDevelopmentSupport(draft, CONV, 'p1'), true)
})

ok('reviewedDevelopmentSupport：outcome 不是 supported → 不支持', () => {
  const draft = {
    sourceEntryIds: [2, 4],
    interactionReview: { outcome: 'unsupported', feedbackEntryIds: [2], responseEntryIds: [4] },
  }
  assert.equal(reviewedDevelopmentSupport(draft, CONV, 'p1'), false)
})

ok('reviewedDevelopmentSupport：引用不在 sourceEntryIds 里 → 不支持', () => {
  const draft = {
    sourceEntryIds: [2],
    interactionReview: { outcome: 'supported', feedbackEntryIds: [2], responseEntryIds: [4] },
  }
  assert.equal(reviewedDevelopmentSupport(draft, CONV, 'p1'), false)
})

ok('reviewedDevelopmentSupport：回应在反馈**之前** → 不支持', () => {
  // 拿着旧回应给新反馈背书，是最容易混进来的一种伪证据。
  const draft = {
    sourceEntryIds: [1, 2],
    interactionReview: { outcome: 'supported', feedbackEntryIds: [2], responseEntryIds: [1] },
  }
  assert.equal(reviewedDevelopmentSupport(draft, CONV, 'p1'), false)
})

ok('reviewedDevelopmentSupport：参与者对不上 → 不支持', () => {
  const draft = {
    sourceEntryIds: [2, 4],
    interactionReview: { outcome: 'supported', feedbackEntryIds: [2], responseEntryIds: [4] },
  }
  assert.equal(reviewedDevelopmentSupport(draft, CONV, 'p9'), false)
})

ok('reviewedDevelopmentSupport：空/畸形输入安全', () => {
  assert.equal(reviewedDevelopmentSupport(undefined, CONV, 'p1'), false)
  assert.equal(reviewedDevelopmentSupport({ sourceEntryIds: [] }, CONV, 'p1'), false)
})

/* ------------------------------------------------------ ⑥ 查询串 */

ok('developmentContextQuery：有用户消息时优先用它', () => {
  assert.equal(developmentContextQuery('在吗', ['待办'], CONV), '在吗')
})

ok('developmentContextQuery：安静的一轮退回「待办 + 最近原文」', () => {
  const q = developmentContextQuery(undefined, ['喝水'], CONV)
  assert.match(q, /喝水/)
  assert.match(q, /别人写的一段|她松了口气/, '应带上最近的散文作为相关度查询')
})

ok('developmentContextQuery：都用做查询，不当成新证据', () => {
  // 说明性用例：函数只产出字符串，不写任何状态。
  const before = JSON.stringify(CONV)
  developmentContextQuery(undefined, ['x'], CONV)
  assert.equal(JSON.stringify(CONV), before, '不该改动条目')
})

ok('DEVELOPMENT_FRAME：写明「至少两个场景」这条规矩', () => {
  assert.match(DEVELOPMENT_FRAME, /至少两个不同场景|跨越至少两个/)
  assert.match(DEVELOPMENT_FRAME, /一次互动最多只算一个场景/)
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

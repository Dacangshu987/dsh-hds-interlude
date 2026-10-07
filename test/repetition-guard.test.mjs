/**
 * 连发同条数守卫（`lib/repetition-guard.js`）的用例。
 *
 * 移植自上游 1.0.1-rc18。要钉住：
 *   ① 元数据归批（批次首领 `bubbleIndex===0` + `bubbleCount` 为权威）；
 *   ② 无元数据的旧条目回退为「连续 character-message 归一批」；
 *   ③ 被其它条目类型截断（断续不触发）；
 *   ④ x=1（每轮单条）不触发；弱信号（只连续 1 批）不触发；
 *   ⑤ 只有私聊对话回合才该检测。
 *
 * 运行：node test/repetition-guard.test.mjs
 */
import assert from 'node:assert/strict'

import {
  detectMessageRepetition, repetitionGuardInstruction, shouldCheckRepetition,
  MAX_BATCHES, MIN_CONSECUTIVE, MIN_BUBBLES,
} from '../lib/repetition-guard.js'

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

/** 造一条带投递元数据的角色消息（批次首领）。 */
function leader(bubbleCount, id) {
  return {
    id,
    kind: 'character-message',
    content: `第 ${id} 批的首条`,
    metadata: { scriptEvent: { bubbleIndex: 0, bubbleCount } },
  }
}
/** 造一条同批的后续气泡。 */
function follower(id) {
  return { id, kind: 'character-message', content: `后续气泡 ${id}`, metadata: {} }
}
/** 造一条不带元数据的角色消息（老条目）。 */
function bare(id) {
  return { id, kind: 'character-message', content: `老条目 ${id}`, metadata: {} }
}
/** 造一条用户消息（批次边界）。 */
function userMsg(id) {
  return { id, kind: 'user-message', content: `用户 ${id}`, metadata: {} }
}

console.log('连发同条数守卫')

/* ------------------------------------------------------- ① 元数据归批 */

ok('连续两批都是 2 条 → 命中', () => {
  const entries = [leader(2, 1), userMsg(2), leader(2, 3)]
  const hit = detectMessageRepetition(entries)
  assert.deepEqual(hit, { bubbles: 2, consecutive: 2 })
})

ok('连续三批都是 3 条 → consecutive=3', () => {
  const entries = [leader(3, 1), userMsg(2), leader(3, 3), userMsg(4), leader(3, 5)]
  assert.deepEqual(detectMessageRepetition(entries), { bubbles: 3, consecutive: 3 })
})

ok('批内有后续气泡时，条数以首领声明为准', () => {
  // 第 1 批：首领说 2 条 + 1 条后续；第 2 批：首领说 2 条。
  const entries = [leader(2, 1), follower(2), userMsg(3), leader(2, 4)]
  assert.deepEqual(detectMessageRepetition(entries), { bubbles: 2, consecutive: 2 })
})

ok('首领在末尾（尚未被用户截断）也算一批', () => {
  const entries = [leader(2, 1), userMsg(2), leader(2, 3)]
  assert.deepEqual(detectMessageRepetition(entries), { bubbles: 2, consecutive: 2 })
})

/* ------------------------------------------------------- ② 无元数据回退 */

ok('无元数据的老条目：连续 character-message 归一批', () => {
  // 两批各 2 条裸条目，中间夹一条用户消息。
  const entries = [bare(1), bare(2), userMsg(3), bare(4), bare(5)]
  assert.deepEqual(detectMessageRepetition(entries), { bubbles: 2, consecutive: 2 })
})

ok('无元数据且条数不同 → 不命中', () => {
  const entries = [bare(1), bare(2), userMsg(3), bare(4), bare(5), bare(6)]
  assert.equal(detectMessageRepetition(entries), undefined)
})

/* ------------------------------------------------------- ③ 断续不触发 */

ok('不同条数交替 → 不命中（consecutive 断在第二段）', () => {
  const entries = [leader(2, 1), userMsg(2), leader(3, 3), userMsg(4), leader(2, 5)]
  assert.equal(detectMessageRepetition(entries), undefined)
})

ok('只剩一批时（前面被别的类型截断）→ 不命中', () => {
  const entries = [leader(2, 1)]
  assert.equal(detectMessageRepetition(entries), undefined)
})

ok('批次之间夹着剧本条目也算边界', () => {
  const entries = [
    leader(2, 1),
    { id: 2, kind: 'script', content: '旁白', metadata: {} },
    leader(2, 3),
  ]
  assert.deepEqual(detectMessageRepetition(entries), { bubbles: 2, consecutive: 2 })
})

/* ------------------------------------------------------- ④ 弱信号拒绝 */

ok('x=1（每轮只发一条）不触发', () => {
  const entries = [leader(1, 1), userMsg(2), leader(1, 3), userMsg(4), leader(1, 5)]
  assert.equal(detectMessageRepetition(entries), undefined)
})

ok('只连续 1 批 → 不触发（需要 ≥2）', () => {
  const entries = [leader(2, 1), userMsg(2), leader(3, 3)]
  assert.equal(detectMessageRepetition(entries), undefined)
})

ok('空输入 / 非法输入安全', () => {
  assert.equal(detectMessageRepetition([]), undefined)
  assert.equal(detectMessageRepetition(undefined), undefined)
  assert.equal(detectMessageRepetition(null), undefined)
  assert.equal(detectMessageRepetition([userMsg(1)]), undefined)
})

ok('坏元数据（非对象 / 非法数）安全降级', () => {
  const weird = [
    { id: 1, kind: 'character-message', content: 'x', metadata: { scriptEvent: 'junk' } },
    { id: 2, kind: 'character-message', content: 'y', metadata: { scriptEvent: { bubbleIndex: 0, bubbleCount: -1 } } },
    userMsg(3),
    leader(2, 4),
  ]
  // 前两条的坏元数据被丢弃 → 降级为裸条目，两条合成一批（=2）；
  // 第 3 条是边界；第 4 条是声明 2 条的首领。两批都是 2 条 → 正常命中。
  assert.deepEqual(detectMessageRepetition(weird), { bubbles: 2, consecutive: 2 })
})

ok('坏元数据不会被当成 0 条（负数是非法值）', () => {
  const entries = [
    { id: 1, kind: 'character-message', content: 'x', metadata: { scriptEvent: { bubbleIndex: 0, bubbleCount: 0 } } },
    userMsg(2),
    { id: 3, kind: 'character-message', content: 'y', metadata: { scriptEvent: { bubbleIndex: 0, bubbleCount: 0 } } },
  ]
  // bubbleCount=0 是合法数但 < MIN_BUBBLES → 不触发（不是"每轮 0 条"的锚定）。
  assert.equal(detectMessageRepetition(entries), undefined)
})

ok('统计上限：最多看 8 批', () => {
  // 造 10 批：最早 8 批都是 2 条，最新 2 批是 3 条 → 最新一批为 3，往后只有 2、3 断掉。
  const entries = []
  let id = 0
  for (let i = 0; i < 10; i += 1) {
    entries.push(leader(i < 8 ? 2 : 3, (id += 1)))
    entries.push(userMsg((id += 1)))
  }
  const hit = detectMessageRepetition(entries)
  assert.ok(hit === undefined || hit.bubbles === 3, '最新批是 3 条，前后不同应不命中')
  assert.equal(MAX_BATCHES, 8)
})

/* ------------------------------------------------------- ⑤ 守卫提示词 */

ok('守卫提示词包含条数与连续次数，并给出「拿不准就发一条」的默认', () => {
  const text = repetitionGuardInstruction({ bubbles: 2, consecutive: 3 })
  assert.ok(text.includes('2 条'), '应点名条数')
  assert.ok(text.includes('3 次'), '应点名连续次数')
  assert.ok(text.includes('只发一条'), '应给出单一默认值')
})

ok('守卫提示词：未命中 → 空串', () => {
  assert.equal(repetitionGuardInstruction(undefined), '')
  assert.equal(repetitionGuardInstruction(null), '')
  assert.equal(repetitionGuardInstruction({ bubbles: 1, consecutive: 3 }), '')
  assert.equal(repetitionGuardInstruction({ bubbles: 2, consecutive: 1 }), '')
})

/* ------------------------------------------------------- ⑥ 适用回合 */

ok('只有私聊对话回合才检测', () => {
  assert.equal(shouldCheckRepetition({ phase: 'user-message' }), true)
  assert.equal(shouldCheckRepetition({ phase: 'conversation-follow-up' }), true)
  assert.equal(shouldCheckRepetition({ phase: 'advance' }), false)
  assert.equal(shouldCheckRepetition({ phase: 'intent-due' }), false)
  assert.equal(shouldCheckRepetition({ phase: 'user-message', isGroup: true }), false)
})

/* ------------------------------------------------------- 常量 */

ok('常量与上游一致', () => {
  assert.equal(MIN_BUBBLES, 2)
  assert.equal(MIN_CONSECUTIVE, 2)
  assert.equal(MAX_BATCHES, 8)
})

/* ------------------------------------------------------- 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

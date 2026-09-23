/**
 * 生活交接（`lib/life-handoff.js`）的用例。
 *
 * 这一层守住的是「场景状态不能凭空变」——所有位置/活动/在场的声明都必须自带
 * **能逐字对上的原文引文**，否则整项丢弃。所以要钉住的不是「函数能跑」，而是：
 *
 *   ① 引文对不上 → 整项丢弃（不是「保留一个没依据的值」）；
 *   ② `presence` 是**完整名单**；显式 `names: []` 表示「确实一个人」，
 *      而**不给 presence** 表示「这次没说」——两者不能混；
 *   ③ 场景转换会顶掉**所有**本地占用，且理由要如实写成「被新交接取代」，
 *      而不是「察觉到对方离开」；
 *   ④ 任何畸形输入都不抛错。
 *
 * 运行：node test/life-handoff.test.mjs
 */
import assert from 'node:assert/strict'

import {
  normalizeLifeHandoff, isGroundedQuote, supersedesLocalOccupancy,
  applyPresence, sceneAnchor, resolvedLabels, LIFE_HANDOFF_FRAME,
} from '../lib/life-handoff.js'

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

/** 一段典型的续写散文，作为所有校验的原文依据。 */
const PROSE = [
  '（她把水壶放到灶上，拧开火。）',
  '（回到客厅时，林知夏正坐在沙发上看书。）',
  '（后来两个人一起下楼，去了便利店。）',
  '（屋里只剩她一个人，安安静静的。）',
].join('\n')

console.log('生活交接')

/* ------------------------------------------------------ ① 引文校验 */

ok('isGroundedQuote：逐字包含才算数', () => {
  assert.equal(isGroundedQuote('她把水壶放到灶上', PROSE), true)
  assert.equal(isGroundedQuote('她把水壶放到锅里', PROSE), false, '改一个字就不算')
})

ok('isGroundedQuote：忽略空白差异、不做模糊匹配', () => {
  assert.equal(isGroundedQuote('她把水壶 放到灶上', PROSE), false, '多一个空格也不算')
  assert.equal(isGroundedQuote('她 把 水壶 放到 灶上', PROSE), false)
})

ok('isGroundedQuote：长度边界（<2 太易误命中，>500 是预算防线）', () => {
  assert.equal(isGroundedQuote('她', PROSE), false, '单字过短')
  assert.equal(isGroundedQuote('x'.repeat(501), PROSE), false, '超长')
  assert.equal(isGroundedQuote(undefined, PROSE), false)
  assert.equal(isGroundedQuote('她把水壶放到灶上', ''), false, '原文为空时无依据')
})

/* ------------------------------------------------------ ② 位置/活动 */

ok('normalizeLifeHandoff：place 需要 value + 逐字引文', () => {
  const h = normalizeLifeHandoff({ place: { value: '厨房', quote: '她把水壶放到灶上' } }, PROSE)
  assert.deepEqual(h.place, { value: '厨房', quote: '她把水壶放到灶上' })
})

ok('normalizeLifeHandoff：引文对不上 → **整项丢弃**，不保留裸值', () => {
  // 关键：不能因为「value 看起来合理」就留下它——那就等于接受了没有依据的声明。
  const h = normalizeLifeHandoff({ place: { value: '厨房', quote: '这句话不在原文里' } }, PROSE)
  assert.equal(h, undefined, '没有任何可信内容时整个交接应为 undefined')
})

ok('normalizeLifeHandoff：value 为空/超长时丢弃该项', () => {
  assert.equal(normalizeLifeHandoff({ place: { value: '   ', quote: '她把水壶放到灶上' } }, PROSE), undefined)
  assert.equal(normalizeLifeHandoff({ place: { value: 'x'.repeat(200), quote: '她把水壶放到灶上' } }, PROSE), undefined)
})

ok('normalizeLifeHandoff：place 与 activity 可同时成立', () => {
  const h = normalizeLifeHandoff({
    place: { value: '厨房', quote: '她把水壶放到灶上' },
    activity: { value: '烧水', quote: '拧开火' },
  }, PROSE)
  assert.equal(h.place.value, '厨房')
  assert.equal(h.activity.value, '烧水')
})

/* ------------------------------------------------------ ③ presence 语义 */

ok('presence：名单里每个名字都必须出现在引文里', () => {
  assert.equal(normalizeLifeHandoff({ presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } }, PROSE).presence.names[0], '林知夏')
  // 引文没提到的人不能塞进名单——那不叫有依据。
  assert.equal(normalizeLifeHandoff({ presence: { names: ['林知夏', '张三'], quote: '林知夏正坐在沙发上看书' } }, PROSE), undefined)
})

ok('presence：**显式空名单**是合法的，表示「确实一个人」', () => {
  const h = normalizeLifeHandoff({ presence: { names: [], quote: '屋里只剩她一个人' } }, PROSE)
  assert.deepEqual(h.presence.names, [], '空名单 + 引文 = 有依据的独处')
})

ok('presence：名字去重', () => {
  const h = normalizeLifeHandoff({ presence: { names: ['林知夏', '林知夏'], quote: '林知夏正坐在沙发上看书' } }, PROSE)
  assert.deepEqual(h.presence.names, ['林知夏'])
})

ok('presence：names 不是数组 / quote 对不上时整项丢弃', () => {
  assert.equal(normalizeLifeHandoff({ presence: { names: '林知夏', quote: '林知夏正坐在沙发上看书' } }, PROSE), undefined)
  assert.equal(normalizeLifeHandoff({ presence: { names: ['林知夏'], quote: '不存在' } }, PROSE), undefined)
})

/* ------------------------------------------------------ ④ transition / resolved */

ok('transition：只认引文，表示「明确发生了本地场景转换」', () => {
  assert.deepEqual(normalizeLifeHandoff({ transition: { quote: '回到客厅时' } }, PROSE).transition, { quote: '回到客厅时' })
  assert.equal(normalizeLifeHandoff({ transition: { quote: '凭空写的转换' } }, PROSE), undefined)
})

ok('resolvedDetails：label + 引文，两者都要', () => {
  const h = normalizeLifeHandoff({ resolvedDetails: [{ label: '烧水', quote: '拧开火' }] }, PROSE)
  assert.deepEqual(h.resolvedDetails, [{ label: '烧水', quote: '拧开火' }])
})

ok('resolvedDetails：全部没通过时返回 undefined（刻意偏离上游）', () => {
  // 上游会把「过滤后是空数组」也当成有效交接（`{resolvedDetails: []}` 是 truthy 的），
  // 于是**一个字都没验证通过的交接会被当成存在**。本模块返回 undefined，
  // 让调用方明确知道「这一轮没有可信的场景转换」。
  assert.equal(normalizeLifeHandoff({ resolvedDetails: [{ label: '烧水', quote: '不存在' }] }, PROSE), undefined)
  assert.equal(normalizeLifeHandoff({ resolvedDetails: [{ label: 'x'.repeat(100), quote: '拧开火' }] }, PROSE), undefined)
})

/* ------------------------------------------------------ ⑤ 鲁棒性 */

ok('畸形输入一律降级为 undefined，不抛错', () => {
  for (const bad of [undefined, null, 'string', 42, [], { place: 'not-an-object' }, { presence: null }]) {
    assert.equal(normalizeLifeHandoff(bad, PROSE), undefined, JSON.stringify(bad))
  }
  // 原文本身坏掉也要安全
  assert.equal(normalizeLifeHandoff({ place: { value: '厨房', quote: '她把水壶放到灶上' } }, undefined), undefined)
})

/* ------------------------------------------------------ ⑥ 顶掉本地占用 */

ok('supersedesLocalOccupancy：转换 / 换地方 / 给了 presence 都算', () => {
  assert.equal(supersedesLocalOccupancy({ transition: { quote: 'x' } }), true)
  assert.equal(supersedesLocalOccupancy({ place: { value: '厨房', quote: 'x' } }, '客厅'), true, '地方变了')
  assert.equal(supersedesLocalOccupancy({ place: { value: '客厅', quote: 'x' } }, '客厅'), false, '地方没变')
  assert.equal(supersedesLocalOccupancy({ presence: { names: [], quote: 'x' } }), true, '显式给了名单就算')
})

ok('supersedesLocalOccupancy：**没给** presence 不算（那是「没说」，不是「一个人」）', () => {
  assert.equal(supersedesLocalOccupancy({ activity: { value: '烧水', quote: 'x' } }), false)
  assert.equal(supersedesLocalOccupancy(undefined), false)
})

/* ------------------------------------------------------ ⑦ 应用到名单 */

ok('applyPresence：转换时原有的人整体转 off-scene，理由如实写', () => {
  const before = [{ name: '林知夏', status: 'present', sourceEntryIds: [1] }]
  const handoff = normalizeLifeHandoff({ place: { value: '厨房', quote: '她把水壶放到灶上' } }, PROSE)
  const after = applyPresence(before, handoff, 42, { currentPlace: '客厅', now: '2026-01-01T00:00:00.000Z' })
  const lin = after.find(x => x.name === '林知夏')
  assert.equal(lin.status, 'off-scene')
  assert.equal(lin.sourceEntryIds[0], 42, '要记下是哪条条目导致的')
  // 这句话会被拼进提示词。**不能**出现「离开 / 走了」这类「角色观察到的行为」的措辞——
  // 事实只是「本地占用被新交接取代」。混起来模型会以为她「看见」对方走了。
  assert.ok(/递补|取代/.test(lin.basis), lin.basis)
  assert.ok(!/离开|走了|离去/.test(lin.basis), `不该读成观察到离开：${lin.basis}`)
})

ok('applyPresence：明确在场的人被置为 present，依据是那条引文', () => {
  const handoff = normalizeLifeHandoff({ presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } }, PROSE)
  const after = applyPresence([], handoff, 7, { now: '2026-01-01T00:00:00.000Z' })
  assert.equal(after[0].name, '林知夏')
  assert.equal(after[0].status, 'present')
  assert.equal(after[0].basis, '林知夏正坐在沙发上看书', '依据就是引文本身')
})

ok('applyPresence：显式空名单 = 所有人都 off-scene（独处）', () => {
  const before = [{ name: '林知夏', status: 'present' }]
  const handoff = normalizeLifeHandoff({ presence: { names: [], quote: '屋里只剩她一个人' } }, PROSE)
  const after = applyPresence(before, handoff, 9, { now: '2026-01-01T00:00:00.000Z' })
  assert.equal(after.every(x => x.status === 'off-scene'), true)
})

ok('applyPresence：不顶掉时名单原样返回，且**不就地修改**', () => {
  const before = [{ name: '林知夏', status: 'present' }]
  const snapshot = JSON.stringify(before)
  const handoff = normalizeLifeHandoff({ activity: { value: '烧水', quote: '拧开火' } }, PROSE)
  const after = applyPresence(before, handoff, 3, {})
  assert.deepEqual(after, before)
  assert.equal(JSON.stringify(before), snapshot, '不该改到调用方的数组')
  assert.notEqual(after, before, '应返回一份新数组')
})

ok('applyPresence：无交接时原样返回', () => {
  const before = [{ name: 'A', status: 'present' }]
  assert.deepEqual(applyPresence(before, undefined, 1, {}), before)
})

ok('applyPresence：名片上限 8 张，保留最新的', () => {
  const before = Array.from({ length: 12 }, (_, i) => ({ name: `人${i}`, status: 'present' }))
  const handoff = normalizeLifeHandoff({ presence: { names: [], quote: '屋里只剩她一个人' } }, PROSE)
  const after = applyPresence(before, handoff, 1, { now: '2026-01-01T00:00:00.000Z', limit: 8 })
  assert.equal(after.length, 8)
})

/* ------------------------------------------------------ ⑧ 锚点 / 已完成 / 提示词 */

ok('sceneAnchor：优先取 activity（比 place 更能说明此刻在做什么）', () => {
  const h = normalizeLifeHandoff({
    place: { value: '厨房', quote: '她把水壶放到灶上' },
    activity: { value: '烧水', quote: '拧开火' },
  }, PROSE)
  assert.equal(sceneAnchor(h, 12), '原文 #12：拧开火')
})

ok('sceneAnchor：没有 activity 时退回 place；都没有则 undefined', () => {
  const h = normalizeLifeHandoff({ place: { value: '厨房', quote: '她把水壶放到灶上' } }, PROSE)
  assert.equal(sceneAnchor(h, 5), '原文 #5：她把水壶放到灶上')
  assert.equal(sceneAnchor(undefined, 5), undefined)
})

ok('resolvedLabels：取出已完成的标签集合', () => {
  const h = normalizeLifeHandoff({ resolvedDetails: [{ label: '烧水', quote: '拧开火' }] }, PROSE)
  const labels = resolvedLabels(h)
  assert.equal(labels.has('烧水'), true)
  assert.equal(labels.has('别的'), false)
  assert.equal(resolvedLabels(undefined).size, 0)
})

ok('LIFE_HANDOFF_FRAME：说明了「不给 presence ≠ 一个人」这条关键区别', () => {
  // 这是最容易误用的一处：模型会以为「不报 presence」就是独处。
  assert.ok(/omitting presence means "not stated", not "alone"/.test(LIFE_HANDOFF_FRAME))
  assert.ok(/COMPLETE local roster/.test(LIFE_HANDOFF_FRAME), '要说明是完整名单')
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

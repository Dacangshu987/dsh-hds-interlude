/**
 * 投递账本（`lib/delivery-ledger.js`）的用例。
 *
 * 移植自上游 `src/script/delivery-ledger.ts`（1.0.0-beta3-m6 / beta4-m7）。
 * 要钉住：
 *   ① 段 → 行动状态聚合（delivered/partial/failed/cancelled 判定）；
 *   ② delivered 是终态——后续记账错误不得降级已送达的话；
 *   ③ 防御读取：损坏数组/非法段不抛错；
 *   ④ 幂等更新：状态与原因相同不产生新版本。
 *
 * 运行：node test/delivery-ledger.test.mjs
 */
import assert from 'node:assert/strict'

import {
  segmentsFromMessages, aggregateDeliveryStatus, createDeliveryAction,
  normalizeDeliveries, updateDeliveryAction, appendDeliveryAction, deliveryReality,
} from '../lib/delivery-ledger.js'

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

console.log('投递账本（Delivery Ledger）')

/* ------------------------------------------------------------ ① 建段 */

ok('segmentsFromMessages：文本与图片各自成段', () => {
  const segments = segmentsFromMessages(['你好', { kind: 'image', assetId: 'a1' }, '再见'])
  assert.equal(segments.length, 3)
  assert.equal(segments[0].kind, 'message')
  assert.equal(segments[0].status, 'pending')
  assert.equal(segments[1].kind, 'local-media')
  assert.equal(segments[1].content, 'a1')
})

ok('segmentsFromMessages：内容截断到 200 字符', () => {
  const segments = segmentsFromMessages(['x'.repeat(500)])
  assert.equal(segments[0].content.length, 200)
})

ok('segmentsFromMessages：非法输入安全', () => {
  assert.deepEqual(segmentsFromMessages(undefined), [])
  assert.deepEqual(segmentsFromMessages(null), [])
  assert.deepEqual(segmentsFromMessages('not-array'), [])
})

/* ------------------------------------------------------------ ② 状态聚合 */

ok('aggregateDeliveryStatus：全 pending → pending', () => {
  assert.equal(aggregateDeliveryStatus([
    { status: 'pending' }, { status: 'pending' },
  ]), 'pending')
})

ok('aggregateDeliveryStatus：全 delivered → delivered', () => {
  assert.equal(aggregateDeliveryStatus([
    { status: 'delivered' }, { status: 'delivered' },
  ]), 'delivered')
})

ok('aggregateDeliveryStatus：部分成功 → partial（不是 failed）', () => {
  assert.equal(aggregateDeliveryStatus([
    { status: 'delivered' }, { status: 'failed' },
  ]), 'partial')
  assert.equal(aggregateDeliveryStatus([
    { status: 'delivered' }, { status: 'cancelled' },
  ]), 'partial')
})

ok('aggregateDeliveryStatus：有 pending 未成功 → pending', () => {
  assert.equal(aggregateDeliveryStatus([
    { status: 'pending' }, { status: 'failed' },
  ]), 'pending')
})

ok('aggregateDeliveryStatus：全 failed → failed；全 cancelled → cancelled', () => {
  assert.equal(aggregateDeliveryStatus([{ status: 'failed' }, { status: 'failed' }]), 'failed')
  assert.equal(aggregateDeliveryStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled')
})

ok('aggregateDeliveryStatus：空数组 → pending', () => {
  assert.equal(aggregateDeliveryStatus([]), 'pending')
})

/* ------------------------------------------------------------ ③ create / normalize */

ok('createDeliveryAction：自动聚合状态并盖时间戳', () => {
  const action = createDeliveryAction({
    id: 'd1',
    entryId: 42,
    at: '2026-09-01T00:00:00.000Z',
    reason: '到点提醒',
    segments: [
      { index: 0, kind: 'message', content: 'a', status: 'pending' },
      { index: 1, kind: 'message', content: 'b', status: 'pending' },
    ],
  })
  assert.equal(action.status, 'pending')
  assert.equal(action.entryId, 42)
  assert.equal(action.updatedAt, '2026-09-01T00:00:00.000Z')
})

ok('normalizeDeliveries：损坏项丢弃、id 去重、限量', () => {
  const list = normalizeDeliveries([
    null,
    { id: 'a', segments: [{ index: 0, content: 'x', status: 'delivered' }] },
    { id: 'a', segments: [{ index: 0, content: 'dup', status: 'pending' }] },
    'junk',
  ], 10)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'a')
  assert.equal(list[0].status, 'delivered')
})

ok('normalizeDeliveries：无 id 丢弃', () => {
  assert.deepEqual(normalizeDeliveries([{ segments: [] }]), [])
  assert.deepEqual(normalizeDeliveries(undefined), [])
  assert.deepEqual(normalizeDeliveries(null), [])
})

/* ------------------------------------------------------------ ④ 更新语义 */

ok('updateDeliveryAction：更新段状态并重算行动状态', () => {
  const base = [
    createDeliveryAction({
      id: 'd1',
      at: '2026-09-01T00:00:00.000Z',
      segments: [
        { index: 0, kind: 'message', content: 'a', status: 'pending' },
        { index: 1, kind: 'message', content: 'b', status: 'pending' },
      ],
    }),
  ]
  const next = updateDeliveryAction(base, { id: 'd1', segmentIndex: 0 }, 'delivered', new Date('2026-09-01T00:00:01.000Z'))
  assert.ok(next, '有变化应返回新数组')
  assert.equal(next[0].segments[0].status, 'delivered')
  assert.equal(next[0].segments[0].completedAt, '2026-09-01T00:00:01.000Z')
  assert.equal(next[0].status, 'partial', '部分成功')
  const final = updateDeliveryAction(next, { id: 'd1', segmentIndex: 1 }, 'delivered', new Date('2026-09-01T00:00:02.000Z'))
  assert.equal(final[0].status, 'delivered')
})

ok('updateDeliveryAction：delivered 是终态，不被降级', () => {
  const base = [
    createDeliveryAction({
      id: 'd1',
      at: '2026-09-01T00:00:00.000Z',
      segments: [{ index: 0, kind: 'message', content: '话', status: 'pending' }],
    }),
  ]
  const delivered = updateDeliveryAction(base, { id: 'd1', segmentIndex: 0 }, 'delivered', new Date())
  const downgraded = updateDeliveryAction(delivered, { id: 'd1', segmentIndex: 0 }, 'failed', new Date(), '晚到的记账错误')
  // 已送达是终态：第二次更新无变化，返回 undefined；原数组里仍为 delivered。
  assert.equal(downgraded, undefined)
  assert.equal(delivered[0].segments[0].status, 'delivered', '已送达不被降级')
})

ok('updateDeliveryAction：相同状态与原因 → 幂等，返回 undefined', () => {
  const base = [
    createDeliveryAction({
      id: 'd1',
      at: '2026-09-01T00:00:00.000Z',
      segments: [{ index: 0, kind: 'message', content: 'a', status: 'pending' }],
    }),
  ]
  const once = updateDeliveryAction(base, { id: 'd1', segmentIndex: 0 }, 'failed', new Date(), '连接超时')
  const twice = updateDeliveryAction(once, { id: 'd1', segmentIndex: 0 }, 'failed', new Date(), '连接超时')
  assert.equal(twice, undefined, '状态与原因相同不产生新版本')
})

ok('updateDeliveryAction：找不到引用 → undefined', () => {
  const base = [createDeliveryAction({ id: 'd1', segments: [] })]
  assert.equal(updateDeliveryAction(base, { id: 'nope', segmentIndex: 0 }, 'delivered', new Date()), undefined)
  assert.equal(updateDeliveryAction(undefined, { id: 'd1', segmentIndex: 0 }, 'delivered', new Date()), undefined)
})

/* ------------------------------------------------------------ ⑤ append */

ok('appendDeliveryAction：追加并限量', () => {
  const a = createDeliveryAction({ id: 'a', segments: [] })
  const b = createDeliveryAction({ id: 'b', segments: [] })
  const list = appendDeliveryAction(appendDeliveryAction([], a, 1), b, 1)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'b')
})

ok('appendDeliveryAction：同 id 幂等跳过', () => {
  const a = createDeliveryAction({ id: 'a', segments: [] })
  const list = appendDeliveryAction([], a, 10)
  assert.equal(appendDeliveryAction(list, a, 10).length, 1)
})

/* ------------------------------------------------- ⑥ 交付现实视图（上游 delivery-reality.ts） */

/** 造一条账：`statuses` 逐段给状态。 */
const acted = (id, entryId, statuses, participantId) => createDeliveryAction({
  id,
  entryId,
  ...(participantId ? { participantId } : {}),
  segments: statuses.map((status, index) => ({ index, kind: 'message', content: `第${index}句`, status })),
})

ok('deliveryReality：只有「有未送达段」的事件才出现（全送达的不占篇幅）', () => {
  const list = [
    acted('a1', 1, ['delivered', 'delivered']),
    acted('a2', 2, ['delivered', 'pending']),
    acted('a3', 3, ['delivered', 'cancelled']),
  ]
  const views = deliveryReality(list, undefined)
  assert.deepEqual(views.map(v => v.actionId), ['a2', 'a3'], '全送达的 a1 不出现')
})

ok('deliveryReality：段状态映射成交付现实措辞', () => {
  const views = deliveryReality([
    acted('a1', 1, ['pending']),
    acted('a2', 2, ['failed']),
    acted('a3', 3, ['cancelled']),
    acted('a4', 4, ['delivered', 'pending']),
  ], undefined)
  const outcomes = views.flatMap(v => v.segments.map(s => s.outcome))
  assert.ok(outcomes.includes('not-confirmed'), 'pending → not-confirmed')
  assert.ok(outcomes.includes('delivery-not-confirmed-after-error'), 'failed → 出错后未确认')
  assert.ok(outcomes.includes('cancelled'), 'cancelled → 原样')
  assert.ok(outcomes.includes('delivered'), '已送达的段也如实带出（好让模型别重复）')
})

ok('deliveryReality：空段但有事件记录 → 如实给一条「没有记录到外发动作」', () => {
  const views = deliveryReality([{ id: 'z1', entryId: 9, segments: [] }], undefined)
  assert.equal(views.length, 1)
  assert.equal(views[0].communicationOutcome, 'no-outgoing-action-recorded')
  assert.deepEqual(views[0].segments, [])
  // 连 entryId 都没有的空账：没什么可说的，不产生条目。
  assert.equal(deliveryReality([{ id: 'z2', segments: [] }], undefined).length, 0)
})

ok('deliveryReality：按关系过滤（不共享细节时不带别的参与者）', () => {
  const list = [acted('x1', 1, ['pending'], 'OTHER'), acted('x2', 2, ['pending'], 'U1')]
  assert.deepEqual(deliveryReality(list, 'U1').map(v => v.actionId), ['x2'], '只看这一关系')
  assert.deepEqual(deliveryReality(list, 'U1', true).map(v => v.actionId), ['x1', 'x2'], '共享细节时放行')
  // 没有 participantId 的账不受这道筛选影响（本仓的常态）。
  assert.equal(deliveryReality([acted('n1', 1, ['pending'])], 'U1').length, 1)
})

ok('deliveryReality：只取最近 limit 条，坏输入不抛错', () => {
  const list = [acted('a1', 1, ['pending']), acted('a2', 2, ['pending']), acted('a3', 3, ['pending'])]
  assert.deepEqual(deliveryReality(list, undefined, false, 2).map(v => v.actionId), ['a2', 'a3'], '取最近的')
  assert.equal(deliveryReality(list, undefined, false, 0).length, 3, 'limit 0 回默认')
  assert.deepEqual(deliveryReality(null, undefined), [], 'null 安全')
  assert.deepEqual(deliveryReality([null, 42, 'x'], undefined), [], '坏条目跳过')
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

/**
 * 投递幂等（`lib/qq-im/outbound.js`「投递幂等」段）的用例。
 *
 * 移植自上游 `1.0.1-rc33` 的 P1-1 修复（业务幂等键跨 deliveryId 去重）。
 * 本仓等价场景：主动投递部分成功 → `pendingText/pendingRemaining` 续发
 * 同一段内容时，已确认送达（或歧义失败疑似送达）的条目不再真发。
 *
 * 要钉住：
 *   ① 键推导：显式键 > remainingKeys > 前缀+序号；序号锚定整批（跨尝试稳定）；
 *   ② 窗口：TTL 内命中、过期作废、容量淘汰；
 *   ③ deliverMessages：确认送达记窗口；窗口命中不真发但计入 sentCount；
 *      歧义失败（超时/未确认）把在发条目标「疑似已送达」；确定失败不标；
 *   ④ 口径：宁可少发一条，不给用户重复消息。
 *
 * 运行：node test/delivery-idempotency.test.mjs
 */
import assert from 'node:assert/strict'
import {
  isAmbiguousDeliveryError, deriveItemKeys, DeliveredIntentWindow, deliverMessages,
} from '../lib/qq-im/outbound.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
async function checkAsync(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('投递幂等（rc33 P1-1 移植）')

/* ─────────────────── ① 歧义判定 ─────────────────── */

check('isAmbiguousDeliveryError：未确认/超时算歧义；取消/结构化错误/无目标不算', () => {
  assert.equal(isAmbiguousDeliveryError('delivery-not-confirmed'), true)
  assert.equal(isAmbiguousDeliveryError('request-timeout'), true)
  assert.equal(isAmbiguousDeliveryError('TimedOut'), true)
  assert.equal(isAmbiguousDeliveryError(undefined), true, '无错误码的失败按歧义处理（结果不可知）')
  assert.equal(isAmbiguousDeliveryError('cancelled'), false)
  assert.equal(isAmbiguousDeliveryError('no-target'), false)
  assert.equal(isAmbiguousDeliveryError('no-messages'), false)
  assert.equal(isAmbiguousDeliveryError('im-unavailable'), false)
  assert.equal(isAmbiguousDeliveryError('rate-limited'), false, 'SDK 结构化错误 = 确定失败')
})

/* ─────────────────── ② 键推导 ─────────────────── */

check('deriveItemKeys：前缀 + 整批序号；remainingKeys 优先于序号', () => {
  assert.deepEqual(deriveItemKeys(['a', 'b'], { intentPrefix: 'T1' }), ['T1:0', 'T1:1'])
  // 续发场景：baseIndex 续接上一轮，或直接用上一轮保存的原键。
  assert.deepEqual(deriveItemKeys(['c', 'd'], { intentPrefix: 'T1', baseIndex: 2 }), ['T1:2', 'T1:3'])
  assert.deepEqual(
    deriveItemKeys(['c', 'd'], { intentPrefix: 'T1', remainingKeys: ['T1:2', 'T1:3'] }),
    ['T1:2', 'T1:3'],
    '原键优先——续发时键必须跨尝试稳定',
  )
  // 续发模式：键比条目短 → 尾部空串（不去重也绝不猜键，猜键会与首轮碰撞）。
  assert.deepEqual(
    deriveItemKeys(['c', 'd', 'e'], { intentPrefix: 'T1', remainingKeys: ['T1:2'] }),
    ['T1:2', '', ''],
  )
  // 对象条目上的显式 intentKey 最高优先（上游形态：eventId:bubbleIndex）。
  assert.deepEqual(
    deriveItemKeys([{ intentKey: 'evt-9:0' }, 'x'], { intentPrefix: 'T1' }),
    ['evt-9:0', 'T1:1'],
  )
  assert.deepEqual(deriveItemKeys(['a'], {}), [''], '无前缀且无显式键 → 空串占位（不启用幂等）')
})

/* ─────────────────── ③ 窗口 ─────────────────── */

check('DeliveredIntentWindow：TTL 内命中、过期作废、容量淘汰', () => {
  let now = 1_000_000
  const w = new DeliveredIntentWindow({ ttlMs: 1000, maxEntries: 3, now: () => now })
  w.mark('a')
  assert.equal(w.has('a'), true)
  now += 999
  assert.equal(w.has('a'), true, 'TTL 边界内仍命中')
  now += 2
  assert.equal(w.has('a'), false, '过期作废')
  w.mark('k1'); w.mark('k2'); w.mark('k3'); w.mark('k4')
  assert.equal(w.has('k1'), false, '容量淘汰最旧的')
  assert.equal(w.has('k4'), true)
  assert.equal(w.has(''), false, '空键不进窗口')
  assert.equal(w.has(undefined), false)
})

/* ─────────────────── ④ deliverMessages 幂等行为 ─────────────────── */

await checkAsync('确认送达 → 记入窗口；返回 sentKeys', async () => {
  const w = new DeliveredIntentWindow()
  const result = await deliverMessages({
    send: async () => ({ sent: true }),
    targetId: 'U', messages: ['一', '二'],
    chunking: { minIntervalMs: 0 },
    intentKeys: ['T1:0', 'T1:1'],
    deliveredWindow: w,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.sentKeys, ['T1:0', 'T1:1'])
  assert.equal(w.has('T1:0'), true)
  assert.equal(w.has('T1:1'), true)
})

await checkAsync('窗口命中 → 不真发但计入 sentCount（口径：宁可少发不重复）', async () => {
  const w = new DeliveredIntentWindow()
  w.mark('T1:0')
  const sent = []
  const result = await deliverMessages({
    send: async (_t, text) => { sent.push(text); return { sent: true } },
    targetId: 'U', messages: ['一', '二'],
    chunking: { minIntervalMs: 0 },
    intentKeys: ['T1:0', 'T1:1'],
    deliveredWindow: w,
  })
  assert.equal(result.ok, true, '跳过已送达条目后整批仍算成功')
  assert.deepEqual(sent, ['二'], '「一」已被窗口拦下，不再真发')
  assert.equal(result.sentCount, 2, '用户视角两条都已送达')
})

await checkAsync('歧义失败（未确认）→ 在发条目标疑似已送达；重发时被拦', async () => {
  const w = new DeliveredIntentWindow()
  let calls = 0
  const first = await deliverMessages({
    send: async () => {
      calls += 1
      if (calls === 2) return {} // 第二条：消息可能已经到了，但没有明确确认
      return { sent: true }
    },
    targetId: 'U', messages: ['一', '二', '三'],
    chunking: { minIntervalMs: 0 },
    intentKeys: ['T1:0', 'T1:1', 'T1:2'],
    deliveredWindow: w,
  })
  assert.equal(first.ok, false)
  assert.equal(first.error, 'delivery-not-confirmed')
  assert.equal(first.ambiguous, true, '未确认属于歧义失败')
  assert.equal(w.has('T1:0'), true, '已确认的第 1 条在窗口')
  assert.equal(w.has('T1:1'), true, '在发的第 2 条按「疑似已送达」保守入窗')
  assert.equal(w.has('T1:2'), false, '还没轮到的第 3 条不标')

  // 续发（用上一轮返回的 remaining + 原键）：第 2 条被拦，只有第 3 条真发。
  const sent = []
  const second = await deliverMessages({
    send: async (_t, text) => { sent.push(text); return { sent: true } },
    targetId: 'U', messages: first.remaining,
    chunking: { minIntervalMs: 0 },
    intentKeys: first.remainingKeys,
    deliveredWindow: w,
  })
  assert.equal(second.ok, true)
  assert.deepEqual(sent, ['三'], '「二」疑似已送达不重发——这就是 rc33 要堵的重复消息')
  assert.equal(second.sentCount, 2)
})

await checkAsync('确定失败（rate-limited）→ 不标疑似已送达，重发安全', async () => {
  const w = new DeliveredIntentWindow()
  let calls = 0
  const first = await deliverMessages({
    send: async () => {
      calls += 1
      if (calls === 1) return { sent: true }
      throw Object.assign(new Error('boom'), { code: 'rate-limited' })
    },
    targetId: 'U', messages: ['一', '二'],
    chunking: { minIntervalMs: 0 },
    intentKeys: ['T2:0', 'T2:1'],
    deliveredWindow: w,
  })
  assert.equal(first.ok, false)
  assert.equal(first.ambiguous, false)
  assert.equal(w.has('T2:1'), false, '连接被拒 = 消息一定没到，不入窗')
  // 重发：第 1 条被窗口拦（已确认），第 2 条正常重发。
  const sent = []
  const second = await deliverMessages({
    send: async (_t, text) => { sent.push(text); return { sent: true } },
    targetId: 'U', messages: first.remaining,
    chunking: { minIntervalMs: 0 },
    intentKeys: first.remainingKeys,
    deliveredWindow: w,
  })
  assert.deepEqual(sent, ['二'], '确定失败的条目要真正重发（不能误拦）')
})

await checkAsync('无键调用方行为字节不变（向后兼容）', async () => {
  const result = await deliverMessages({
    send: async () => { throw Object.assign(new Error('x'), { code: 'rate-limited' }) },
    targetId: 'U', messages: ['一'],
    chunking: { minIntervalMs: 0 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.ambiguous, undefined, '不带键时不附带幂等字段')
  assert.deepEqual(result.remaining, ['一'], 'remaining 语义照旧：含失败条目本身')
})

await checkAsync('取消：确定没发，不标疑似已送达', async () => {
  const w = new DeliveredIntentWindow()
  const controller = new AbortController()
  controller.abort()
  const result = await deliverMessages({
    send: async () => ({ sent: true }),
    targetId: 'U', messages: ['一'],
    chunking: { minIntervalMs: 0 },
    intentKeys: ['T3:0'],
    deliveredWindow: w,
    signal: controller.signal,
  })
  assert.equal(result.error, 'cancelled')
  assert.equal(result.ambiguous, false)
  assert.equal(w.has('T3:0'), false)
})

console.log(`\n投递幂等：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

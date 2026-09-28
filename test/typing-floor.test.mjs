/**
 * 打字节奏与**首条发言打字时间下限**测试。
 *   移植自上游 `1.0.1-rc21`（`typingDelay` + 首条 floor）与其沿用的既有参数
 *   （`typingBaseDelaySeconds` / `typingCharactersPerSecond` / `typingMaxDelaySeconds`
 *   / `typingJitterRatio`，上游默认 1s / 8 cps / 12s / 0.3）。
 *
 * 覆盖：
 *   A. `typingDelayMs` 数学：基础 + 字数/速度、按 max 截断、抖动幅度、可注入随机源；
 *   B. `firstMessageTypingFloorMs`：快返回补足 / 慢返回立即发 / 缺起点不等待 /
 *      时钟偏差防御（不回放大）；
 *   C. `resolveChunking` 默认值与夹取（与上游默认逐字一致）；
 *   D. `deliverMessages` 端到端：首条补足等待、慢返回不等待、分段打字间隔、
 *      等待可被 signal 打断。
 *
 * 运行：node test/typing-floor.test.mjs
 */
import assert from 'node:assert/strict'
import {
  typingDelayMs,
  firstMessageTypingFloorMs,
  resolveChunking,
  deliverMessages,
} from '../lib/qq-im/outbound.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('打字节奏与首条下限（rc21 移植）')

/* ───────────────────── A. typingDelayMs 数学 ───────────────────── */

await check('基础 + 字数/速度，按 max 截断（上游公式）', () => {
  const cfg = { typingBaseDelaySeconds: 1, typingCharactersPerSecond: 8, typingMaxDelaySeconds: 12, typingJitterRatio: 0 }
  assert.equal(typingDelayMs(0, cfg, () => 0.5), 1000, '零字 → 基础 1s')
  assert.equal(typingDelayMs(8, cfg, () => 0.5), 2000, '8 字 @8cps → 1s + 1s')
  assert.equal(typingDelayMs(40, cfg, () => 0.5), 6000, '40 字 → 1 + 5 = 6s')
  // 超过 max 截断：1000 字 → 1 + 125 = 126s → 截到 12s
  assert.equal(typingDelayMs(1000, cfg, () => 0.5), 12000)
})

await check('抖动 ±ratio（可注入随机源），且不为负', () => {
  const cfg = { typingBaseDelaySeconds: 1, typingCharactersPerSecond: 10, typingMaxDelaySeconds: 12, typingJitterRatio: 0.3 }
  const base = 1000 + 10 * 100 // 10 字 @10cps → 2s
  assert.equal(typingDelayMs(10, cfg, () => 0.5), base, '中位 = 不偏')
  assert.equal(typingDelayMs(10, cfg, () => 0), Math.round(base * 0.7), '下界 -30%')
  assert.equal(typingDelayMs(10, cfg, () => 1), Math.round(base * 1.3), '上界 +30%')
  // 极端参数也不会算出负数
  assert.ok(typingDelayMs(0, { ...cfg, typingBaseDelaySeconds: 0, typingJitterRatio: 0.5 }, () => 0) >= 0)
})

/* ───────────────── B. 首条下限语义 ───────────────── */

await check('快返回 → 补足到打字时长；慢返回 → 立即发', () => {
  const cfg = { typingBaseDelaySeconds: 1, typingCharactersPerSecond: 8, typingMaxDelaySeconds: 12, typingJitterRatio: 0 }
  const now = 1_000_000
  // 目标 1 + 16/8 = 3s；模型只花了 500ms → 还需 2.5s
  assert.equal(firstMessageTypingFloorMs('x'.repeat(16), now - 500, cfg, now, () => 0.5), 2500)
  // 模型花了 5s（超过 3s）→ 立即发
  assert.equal(firstMessageTypingFloorMs('x'.repeat(16), now - 5000, cfg, now, () => 0.5), 0)
})

await check('缺起点不等待；时钟偏差不回放大（elapsed 以 0 为下限）', () => {
  const cfg = { typingBaseDelaySeconds: 1, typingCharactersPerSecond: 8, typingMaxDelaySeconds: 12, typingJitterRatio: 0 }
  const now = 1_000_000
  assert.equal(firstMessageTypingFloorMs('x'.repeat(16), undefined, cfg, now, () => 0.5), 0)
  assert.equal(firstMessageTypingFloorMs('x'.repeat(16), Number.NaN, cfg, now, () => 0.5), 0)
  // 起点在未来（时钟偏差）：不得算出比目标更长的等待
  assert.equal(firstMessageTypingFloorMs('x'.repeat(16), now + 10_000, cfg, now, () => 0.5), 3000)
})

/* ───────────────── C. 配置默认值与夹取 ───────────────── */

await check('resolveChunking 默认值与上游一致：1s / 8cps / 12s / 0.3', () => {
  const cfg = resolveChunking({})
  assert.equal(cfg.typingBaseDelaySeconds, 1)
  assert.equal(cfg.typingCharactersPerSecond, 8)
  assert.equal(cfg.typingMaxDelaySeconds, 12)
  assert.equal(cfg.typingJitterRatio, 0.3)
  // 夹取
  const clamped = resolveChunking({ chunking: { typingBaseDelaySeconds: 999, typingCharactersPerSecond: 0, typingMaxDelaySeconds: -5, typingJitterRatio: 9 } })
  assert.equal(clamped.typingBaseDelaySeconds, 60)
  assert.equal(clamped.typingCharactersPerSecond, 1)
  assert.equal(clamped.typingMaxDelaySeconds, 0)
  assert.equal(clamped.typingJitterRatio, 0.5)
})

/* ───────────────── D. deliverMessages 端到端 ───────────────── */

const fastChunking = { typingBaseDelaySeconds: 0, typingCharactersPerSecond: 100, typingMaxDelaySeconds: 12, typingJitterRatio: 0, minIntervalMs: 0 }
const sent = []
const fakeSend = async (peer, chunk) => { sent.push({ peer, chunk, at: Date.now() }); return { sent: true } }

await check('首条：快返回补足打字下限后再发', async () => {
  sent.length = 0
  const started = Date.now()
  const result = await deliverMessages({
    send: fakeSend, targetId: 'u1', messages: ['x'.repeat(40)],  // 40 字 @100cps → 0.4s
    chunking: fastChunking, requestStartedAt: started,
  })
  const elapsed = Date.now() - started
  assert.equal(result.ok, true)
  assert.equal(result.sentCount, 1)
  assert.ok(elapsed >= 350, `应补足到约 400ms，实际 ${elapsed}ms`)
})

await check('首条：模型已花掉足够时间 → 立即发', async () => {
  sent.length = 0
  const started = Date.now()
  const result = await deliverMessages({
    send: fakeSend, targetId: 'u1', messages: ['x'.repeat(40)],
    chunking: fastChunking, requestStartedAt: started - 5000,
  })
  assert.equal(result.ok, true)
  assert.ok(Date.now() - started < 200, '慢返回不该再等')
})

await check('分段：等待打字时长（minIntervalMs 作为下限）', async () => {
  sent.length = 0
  const started = Date.now()
  const result = await deliverMessages({
    send: fakeSend, targetId: 'u1', messages: ['a', 'b'.repeat(30)],  // 第二段 0.3s
    chunking: fastChunking,
  })
  assert.equal(result.sentCount, 2)
  assert.ok(Date.now() - started >= 250, '第二段应等待打字时长约 300ms')
  // minIntervalMs 更大时以它为准
  sent.length = 0
  const t2 = Date.now()
  await deliverMessages({ send: fakeSend, targetId: 'u1', messages: ['a', 'b'], chunking: { ...fastChunking, minIntervalMs: 300 } })
  assert.ok(Date.now() - t2 >= 280, 'minIntervalMs 应作为下限生效')
})

await check('等待可被 signal 打断（新用户消息插话，上游 shouldCancel 语义）', async () => {
  sent.length = 0
  const controller = new AbortController()
  const started = Date.now()
  const pending = deliverMessages({
    send: fakeSend, targetId: 'u1', messages: ['x'.repeat(500)],  // 5s 下限
    chunking: { ...fastChunking, typingMaxDelaySeconds: 5 }, signal: controller.signal, requestStartedAt: started,
  })
  await sleep(80)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error, 'cancelled')
  assert.ok(Date.now() - started < 1000, '打断后不该继续等满 5s')
  assert.equal(result.sentCount, 0)
})

console.log(`\n打字节奏与首条下限：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

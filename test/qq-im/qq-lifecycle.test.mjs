/**
 * QqChannel 生命周期测试——「扫码后一直连接中」的修复核心。
 *
 * 线上 bug：旧实现 `stop() → 等 50ms → start()` 没有等旧连接退出；
 * 旧 start 的 finally 会把新连接的 started/ready 清掉，于是：
 *   - 新连接建一半，标志被清 → started/ready 永远对不上 →「连接中」卡死。
 *
 * 修复：`restart()` 先 stop 旧连接、await 旧 run 完全退出，再起新 run；
 * `start()` 幂等且只有「当前 run」有权复位状态。
 *
 * 用假 QQBotClass 驱动，不联网。
 */
import assert from 'node:assert/strict'

import { QqChannel } from '../../lib/qq-im/qq.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/** 记录每个 bot 实例的生命周期；start 的 promise 可手动 resolve。 */
function makeFakeSdk() {
  const instances = []
  let instSeq = 0
  class FakeQQBot {
    constructor(opts) {
      this.opts = opts
      this.seq = ++instSeq
      this.listeners = {}
      this.stopped = false
      this._startPromise = null
      this._resolveStart = null
      instances.push(this)
    }
    on(evt, fn) { this.listeners[evt] = fn }
    emit(evt, data) { this.listeners[evt]?.(data) }
    async start(signal) {
      this._startPromise = new Promise((resolve) => { this._resolveStart = resolve })
      signal?.addEventListener?.('abort', () => this._resolveStart?.(), { once: true })
      await this._startPromise
    }
    stop() { this.stopped = true; this._resolveStart?.() }
  }
  return { FakeQQBot, instances }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('QqChannel 生命周期')

await check('start 后挂在 run 上，ready 事件置位；stop 后 run 结束、状态复位', async () => {
  const { FakeQQBot, instances } = makeFakeSdk()
  const ch = new QqChannel({ appId: 'a', appSecret: 's', QQBotClass: FakeQQBot })
  const run = ch.start()
  await sleep(10)
  assert.equal(ch.started, true, 'start 后应 started')
  assert.equal(ch.ready, false, '还没 READY')

  instances[0].emit('ready', {})
  assert.equal(ch.ready, true, 'READY 后 ready 应变 true')

  ch.stop()
  await run
  assert.equal(ch.started, false, 'stop 后 started 应变 false')
  assert.equal(ch.ready, false, 'stop 后 ready 应变 false')
  assert.equal(ch.bot, undefined, 'bot 引用应清理')
})

await check('start 幂等：重复调用返回同一 run，不重复建连', async () => {
  const { FakeQQBot, instances } = makeFakeSdk()
  const ch = new QqChannel({ appId: 'a', appSecret: 's', QQBotClass: FakeQQBot })
  const r1 = ch.start()
  const r2 = ch.start()
  await sleep(10)
  assert.equal(r1, r2, '重复 start 应返回同一 run')
  assert.equal(instances.length, 1, '只应建一个 bot')
  ch.stop(); await r1
})

await check('restart：stop 旧连接并等退出，再起新连接（竞态修复核心）', async () => {
  const { FakeQQBot, instances } = makeFakeSdk()
  const ch = new QqChannel({ appId: 'a', appSecret: 's', QQBotClass: FakeQQBot })

  // 第一段连接。
  const run1 = ch.start()
  await sleep(10)
  assert.equal(instances.length, 1, '第一段应建一个 bot')
  instances[0].emit('ready', {})
  assert.equal(ch.ready, true)

  // restart：换 appSecret 重连。
  ch.appSecret = 's2'
  const run2 = ch.restart()
  await sleep(10)
  assert.equal(instances.length, 2, 'restart 应新建 bot')
  assert.equal(instances[0].stopped, true, '旧 bot 应被 stop')
  // 关键：restart 若没等旧 run 退出，旧 finally 会把 started 清掉。
  // 正确实现：restart 等旧 run 结束，此刻 started 属于新连接。
  assert.equal(ch.started, true, '新连接应 started')
  assert.equal(ch.ready, false, '新连接还没 READY（旧连接的 finally 不得残留）')

  instances[1].emit('ready', {})
  assert.equal(ch.ready, true, '新连接 READY')

  // 收尾：停掉第二段，run2 才结束。
  ch.stop()
  await run2
  assert.equal(ch.started, false)
})

await check('restart 时若旧 run 已在跑，新 run 启动前旧标志已被清干净', async () => {
  const { FakeQQBot, instances } = makeFakeSdk()
  const ch = new QqChannel({ appId: 'a', appSecret: 's', QQBotClass: FakeQQBot })
  const run1 = ch.start()
  await sleep(10)
  instances[0].emit('ready', {})

  // 立刻 restart（不停顿），模拟「扫码成功后马上重连」。
  const run2 = ch.restart()
  await sleep(20)
  assert.equal(instances[0].stopped, true, '旧 bot 应被 stop')
  assert.equal(instances.length, 2, '应已建新 bot')
  assert.equal(ch.started, true, '新连接标志在（没被旧 finally 清掉）')
  assert.equal(ch.ready, false)

  instances[1].emit('ready', {})
  await sleep(0)
  assert.equal(ch.ready, true, '新连接就绪')
  ch.stop(); await run2; await run1
})

console.log(`\nQqChannel 生命周期：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
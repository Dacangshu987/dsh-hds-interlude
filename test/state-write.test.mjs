/**
 * 落盘：同步语义 + 失败可见性 + 每 key 临界区（P0）的用例。
 *
 * ## 这个测试要证明什么
 *
 * 改之前 `saveState` 是「同步写 + `catch {}`」，真正的问题是**静默**：
 * 写失败没有任何痕迹，而丢的可能是 `delivered` 标记 → 重复投递。
 *
 * 本轮同时确立了两条**必须守住**的语义：
 *   ① `saveState` 仍然是**同步**的 —— 写完当 tick 就能读到（既有 36 处
 *      调用点与多个既有用例都依赖这一点，不能被悄悄改成异步）；
 *   ② 失败时**有日志 + 计数**，且**不抛错**（不打断对话）；
 *   ③ `withStateLock` 能让同一 key 的「读→改→写」不交叠。
 *
 * ## 为什么用临时 DSH_HOME
 *
 * `interludeHome()` 读 `process.env.DSH_HOME`。用例必须与真实的
 * `~/.dsh/hds-interlude` 隔离，否则会污染用户状态。
 *
 * @module dsh-hds-interlude/test/state-write.test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-interlude-p0-'))
process.env.DSH_HOME = TMP_HOME

const { saveState, loadState, writeHealth, resetWriteHealth, interludeHome, withStateLock, emptyState, foldFromLog } =
  await import('../lib/state.js')

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('落盘：同步语义、失败可见性、临界区')

/* ------------------------------------------------ ① 同步语义（回归防线） */

await ok('saveState 是同步的：写完当 tick 就能读到', () => {
  const key = 'k-sync'
  saveState(key, { version: 1, marker: 'a' })
  // 不 await、不 setTimeout —— 直接读
  assert.equal(loadState(key).marker, 'a')
})

await ok('返回值带 ok:true（便于调用方在需要时检查）', () => {
  const result = saveState('k-ret', { version: 1 })
  assert.equal(result.ok, true)
})

await ok('状态里被回填 sessionId（后台扫描靠它认领冷会话）', () => {
  saveState('k-stamp', { version: 1 })
  assert.equal(loadState('k-stamp').sessionId, 'k-stamp')
})

await ok('连续同步写入：最后一次胜出', () => {
  const key = 'k-lastwins'
  for (let i = 1; i <= 10; i++) saveState(key, { version: 1, seq: i })
  assert.equal(loadState(key).seq, 10)
})

await ok('不残留 .tmp 文件（原子替换成立）', () => {
  saveState('k-tmp', { version: 1 })
  const leftovers = fs.readdirSync(interludeHome()).filter(f => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

/* ------------------------------------------------ ② 失败可见性（本轮核心） */

await ok('落盘失败时：返回 ok:false、计数增长、有 warn 日志、且不抛错', () => {
  resetWriteHealth()
  const key = 'k-fail'
  // 把目标文件换成**目录**，让 renameSync 必定失败
  const file = path.join(interludeHome(), `${key}.json`)
  fs.mkdirSync(file, { recursive: true })

  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let threw = null
  let result = null
  try {
    result = saveState(key, { version: 1 })
  } catch (error) {
    threw = error
  } finally {
    console.warn = origWarn
    fs.rmSync(file, { recursive: true, force: true })
  }

  assert.equal(threw, null, '落盘失败**不应**抛错 —— 否则会打断对话')
  assert.equal(result.ok, false, '应返回 ok:false')
  assert.ok(result.error instanceof Error, '应带上 error')
  assert.ok(
    warnings.some(w => w.includes('状态落盘失败')),
    `应有 warn 日志（这是「不再静默」的证据），实际：${JSON.stringify(warnings)}`,
  )
  assert.equal(writeHealth().byKey[key], 1, '该 key 的失败计数应为 1')
})

await ok('失败之后，后续写入仍能成功（不污染状态）', () => {
  const key = 'k-recover'
  const file = path.join(interludeHome(), `${key}.json`)
  fs.mkdirSync(file, { recursive: true })
  assert.equal(saveState(key, { version: 1, marker: 'bad' }).ok, false)
  fs.rmSync(file, { recursive: true, force: true })
  assert.equal(saveState(key, { version: 1, marker: 'good' }).ok, true)
  assert.equal(loadState(key).marker, 'good')
})

await ok('writeHealth 能汇总多 key 的失败数', () => {
  resetWriteHealth()
  for (const key of ['k-h1', 'k-h2']) {
    const file = path.join(interludeHome(), `${key}.json`)
    fs.mkdirSync(file, { recursive: true })
    saveState(key, { version: 1 })
    fs.rmSync(file, { recursive: true, force: true })
  }
  const health = writeHealth()
  assert.equal(health.failures, 2)
  assert.equal(health.byKey['k-h1'], 1)
  assert.equal(health.byKey['k-h2'], 1)
})

/* ------------------------------------------------ ③ 每 key 临界区 */

await ok('withStateLock：同一 key 的临界区按调用顺序串行执行', async () => {
  const order = []
  const jobs = []
  for (let i = 1; i <= 5; i++) {
    jobs.push(withStateLock('k-lock1', async () => {
      order.push(`start${i}`)
      await new Promise(r => setTimeout(r, 5))
      order.push(`end${i}`)
    }))
  }
  await Promise.all(jobs)
  // 串行意味着不会出现 start1,start2,...,end1,end2 这种交叠
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3', 'start4', 'end4', 'start5', 'end5'])
})

await ok('withStateLock：不同 key 之间可并行（不互相阻塞）', async () => {
  const order = []
  const slow = withStateLock('k-lockA', async () => {
    order.push('A-start')
    await new Promise(r => setTimeout(r, 20))
    order.push('A-end')
  })
  const fast = withStateLock('k-lockB', async () => {
    order.push('B-start')
    order.push('B-end')
  })
  await Promise.all([slow, fast])
  // B 不应等 A —— 它应插在 A 的等待期间完成
  assert.deepEqual(order, ['A-start', 'B-start', 'B-end', 'A-end'])
})

await ok('withStateLock：包住读改写，消除丢失更新', async () => {
  const key = 'k-race'
  saveState(key, { version: 1, counter: 0 })
  // 10 个并发「读 → 改 → 写」，若不串行，后写的会覆盖先写的
  await Promise.all(Array.from({ length: 10 }, () => withStateLock(key, async () => {
    const state = loadState(key)
    await new Promise(r => setTimeout(r, 1))
    state.counter = (state.counter ?? 0) + 1
    saveState(key, state)
  })))
  assert.equal(loadState(key).counter, 10, '10 次并发自增应全部生效')
})

await ok('withStateLock：单次任务抛错不打断后续任务', async () => {
  const key = 'k-lockerr'
  const bad = withStateLock(key, async () => { throw new Error('boom') })
  await assert.rejects(bad, /boom/)
  const good = await withStateLock(key, async () => 'recovered')
  assert.equal(good, 'recovered', '链上失败不应污染后续任务')
})

/* ------------------------------------------------ ④ 读盘不吞字段（回归） */

await ok('读盘不吞掉运行期写入的字段（extensions 兜底桶回归）', async () => {
  // 回归：`loadState` 曾把「不在 emptyState 里的键」**只**挪进 `extensions`。
  // `lastAdvanceDelivery` / `lastImDelivery` / `advanceMode` 只由 index.js 在
  // 运行期写入、从没登记过，于是**每次读盘都读不回来**：盘上明明有，读出来却是
  // undefined。表现是「投递自检回执永远为空」，而日志一片安静。
  const key = 'k-runtime-fields'
  saveState(key, {
    version: 1,
    lastAdvanceDelivery: { mode: 'speak', reason: 'speak' },
    lastImDelivery: { ok: true, sentCount: 1 },
    advanceMode: 'story-only',
  })
  const back = loadState(key)
  assert.equal(back.lastAdvanceDelivery?.mode, 'speak', 'lastAdvanceDelivery 必须读得回来')
  assert.equal(back.lastImDelivery?.ok, true, 'lastImDelivery 必须读得回来')
  assert.equal(back.advanceMode, 'story-only', 'advanceMode 必须读得回来')
})

await ok('未知键：顶层保留的同时也进 extensions（两头都不丢）', async () => {
  const key = 'k-unknown-key'
  saveState(key, { version: 1, someFutureField: { a: 1 } })
  const back = loadState(key)
  assert.deepEqual(back.someFutureField, { a: 1 }, '顶层应保留（不与旧行为冲突）')
  assert.deepEqual(back.extensions?.someFutureField, { a: 1 }, 'extensions 兜底桶也应有一份')
})

/* ------------------------------------------------ ⑤ 条目账本落盘（地基） */

const { appendEntry, verifyQuote } = await import('../lib/script-entry.js')

await ok('条目账本：落盘→读回后 id、正文、发号器都不变', async () => {
  const key = 'k-ledger-roundtrip'
  const state = emptyState()
  appendEntry(state.ledger, { kind: 'user-message', content: '明天下午三点在楼下等你。' })
  appendEntry(state.ledger, { kind: 'script', content: '（她把手机扣在枕边。）' })
  saveState(key, state)

  const back = loadState(key)
  assert.equal(back.ledger.entries.length, 2, '两条都要读回来')
  assert.equal(back.ledger.entries[0].content, '明天下午三点在楼下等你。')
  assert.equal(back.ledger.nextId, 3, '发号器必须跟着回来，否则新条目会撞 id')
  assert.equal(verifyQuote(back.ledger, 1, '明天下午三点').ok, true, '读回来后逐字校验仍然成立')
})

await ok('条目账本：损坏的值降级成空账本，不抛错', async () => {
  const key = 'k-ledger-broken'
  // 直接写一个坏掉的 ledger 字段（模拟旧版本文件 / 手改坏了）。
  const state = { ...emptyState(), ledger: '这不是账本' }
  saveState(key, state)
  const back = loadState(key)
  assert.ok(Array.isArray(back.ledger.entries), '应降级成合法的空账本')
  assert.deepEqual(back.ledger.entries, [])
})

await ok('条目账本：超上限被裁剪，但**发号器不回退**', async () => {
  const key = 'k-ledger-prune'
  const state = emptyState()
  // 造 450 条（超过默认 400 上限）。
  for (let i = 0; i < 450; i++) appendEntry(state.ledger, { kind: 'script', content: `第${i}段` })
  saveState(key, state)

  const back = loadState(key)
  assert.ok(back.ledger.entries.length <= 400, `实际 ${back.ledger.entries.length}`)
  // 关键：裁剪之后新条目不能撞上仍被引用的旧 id。
  const fresh = appendEntry(back.ledger, { kind: 'script', content: '新的' })
  assert.ok(fresh.id > 450, `新 id 应大于 450，实际 ${fresh.id}`)
  const ids = back.ledger.entries.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不该有重复')
})

/* ------------------------------------------------ ⑥ 日志回退保留账本 */

await ok('日志回退（会话被压缩/重置）时账本必须保留', async () => {
  // 回归：`foldFromLog` 在 cursor > total（日志回退）时会重建状态。
  // 若忘了把 ledger 列进保留清单，一次日志压缩就会让所有 sourceEntryIds 悬空——
  // 溯源全部变成谎言，而且**不会报错**。
  const key = 'k-ledger-rollback'
  const state = emptyState()
  appendEntry(state.ledger, { kind: 'script', content: '回退前写下的内容' })
  state.lastSeenSeq = 999
  saveState(key, state)

  const agent = {
    session: { seq: 3, eventAt: () => undefined },
  }
  const folded = foldFromLog(agent, loadState(key))
  assert.equal(folded.ledger.entries.length, 1, '账本不该被日志回退清掉')
  assert.equal(folded.ledger.entries[0].content, '回退前写下的内容')
  assert.equal(folded.ledger.nextId, 2, '发号器也要保留')
})

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n✅ 全部通过（${passed} 项）`)

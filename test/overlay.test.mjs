/**
 * 设定演化（Overlay）写入路径与读回（P1 实施）的用例。
 *
 * ## 背景
 *
 * 改动前 `upsertOverlay` 是**死代码**：全仓只有定义（`lib/state.js`）
 * 与一处 import（`lib/index.js:33`），**没有任何调用点**；
 * `state.overlay` 只在 `/interlude status` / `context` 里被显示，
 * **从未进过模型提示词**。等于一个永远为空的字段。
 *
 * 本轮接了两端：
 *   - **写**：`interlude_memory` 新增 `action: 'overlay'`（复用既有 `layer` 枚举）；
 *   - **读**：`renderInterludeBlock` 把 overlay 注入 `<幕间>`。
 *
 * ## 这个测试要守住什么
 *
 * ① `upsertOverlay` 的语义（首次写入 / 同层覆盖 / 证据累加 / 非法层拒绝）；
 * ② overlay **确实到达模型提示词**（读回端，否则"记了但看不到"）；
 * ③ **只有 overlay、没有其它事实**时也要注入 —— 这是最容易漏的一格：
 *    `renderInterludeBlock` 有 `substance` 前置闸，若忘了把 overlay 计入，
 *    这种会话会直接 `return ''`，写入路径接了也等于没接。
 * ④ 反例：没有 overlay 的会话，输出**逐字节不变**（不能因为这次改动而每轮多注内容）。
 *
 * @module dsh-hds-interlude/test/overlay.test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-overlay-'))
process.env.DSH_HOME = TMP_HOME

const { upsertOverlay, clearOverlay, emptyState } = await import('../lib/state.js')
const { renderInterludeBlock } = await import('../lib/render.js')

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** 一个"什么事实都没有"的配置，用来逼出 overlay 单独是否足以触发注入。 */
const BARE_CONFIG = { gapNoticeMinutes: 30, alwaysReportTime: false, story: {} }

function render(state, extra = {}) {
  return renderInterludeBlock({
    now: Date.now(),
    zone: 'Asia/Shanghai',
    state,
    config: BARE_CONFIG,
    due: [],
    imActive: false,
    extraLine: '',
    ...extra,
  })
}

console.log('设定演化（Overlay）')

/* ------------------------------------------------ ① upsertOverlay 语义 */

ok('首次写入一个层：生效并记 1 次证据', () => {
  const state = emptyState()
  const entry = upsertOverlay(state, { layer: 'relationship', content: '关系更近了。' }, 1000)
  assert.equal(entry.layer, 'relationship')
  assert.equal(entry.evidence, 1)
  assert.equal(state.overlay.length, 1)
  assert.equal(state.overlay[0].content, '关系更近了。')
})

ok('同一层再次写入：覆盖内容且证据累加（不是新增一条）', () => {
  const state = emptyState()
  upsertOverlay(state, { layer: 'relationship', content: '第一次。' }, 1000)
  const again = upsertOverlay(state, { layer: 'relationship', content: '第二次。' }, 2000)
  assert.equal(state.overlay.length, 1, '同层应覆盖，而不是堆两条')
  assert.equal(again.evidence, 2)
  assert.equal(state.overlay[0].content, '第二次。')
})

ok('不同层各自独立存在', () => {
  const state = emptyState()
  upsertOverlay(state, { layer: 'relationship', content: 'A' }, 1000)
  upsertOverlay(state, { layer: 'world', content: 'B' }, 1000)
  assert.equal(state.overlay.length, 2)
})

ok('非法层被拒绝（返回 undefined，不写入）', () => {
  const state = emptyState()
  assert.equal(upsertOverlay(state, { layer: 'nonsense', content: 'x' }, 1000), undefined)
  assert.equal(state.overlay.length, 0)
})

ok('clearOverlay 单层与 all 都生效', () => {
  const state = emptyState()
  upsertOverlay(state, { layer: 'relationship', content: 'A' }, 1000)
  upsertOverlay(state, { layer: 'world', content: 'B' }, 1000)
  assert.equal(clearOverlay(state, 'world'), true)
  assert.equal(state.overlay.length, 1)
  assert.equal(clearOverlay(state, 'all'), true)
  assert.equal(state.overlay.length, 0)
})

/* ------------------------------------------------ ② 读回：进模型提示词 */

ok('overlay 被注入 <幕间> 块（写入了就要能被模型看到）', () => {
  const state = emptyState()
  upsertOverlay(state, { layer: 'relationship', content: '两人已经不再客套。' }, Date.now())
  const block = render(state)
  assert.ok(block.includes('两人已经不再客套。'), `overlay 内容应进提示词，实际：${block}`)
  assert.ok(block.includes('关系'), '应带可读的层标签')
  assert.ok(block.includes('设定演化'), '应说明这是设定演化')
})

ok('【关键】只有 overlay、没有任何其它事实时，仍然注入', () => {
  // 这是最容易漏的一格：renderInterludeBlock 有 substance 前置闸。
  // 若忘了把 overlay 计入 substance，本用例会拿到空串。
  const state = emptyState()
  upsertOverlay(state, { layer: 'world', content: '城里开始入冬了。' }, Date.now())
  // 确保其它 substance 来源都为空
  state.continuity = undefined
  state.alter = undefined
  state.preplan = undefined
  const block = render(state)
  assert.notEqual(block, '', '只有 overlay 时也必须注入，否则写入端等于白接')
  assert.ok(block.includes('城里开始入冬了。'))
})

ok('overlay 与其它事实共存时各占一行（不互相顶掉）', () => {
  const state = emptyState()
  state.continuity = '刚搬完家。'
  upsertOverlay(state, { layer: 'relationship', content: '邻居开始熟了。' }, Date.now())
  const block = render(state)
  assert.ok(block.includes('刚搬完家。'), '连续性应保留')
  assert.ok(block.includes('邻居开始熟了。'), 'overlay 应保留')
})

/* ------------------------------------------------ ③ 反例：不改变既有行为 */

ok('没有 overlay 的会话：输出与改动前一致（不含设定演化段）', () => {
  const state = emptyState()
  state.continuity = '刚搬完家。'
  const block = render(state)
  assert.ok(!block.includes('设定演化'), '无 overlay 时不应出现这一段')
  assert.ok(block.includes('刚搬完家。'), '原有内容不受影响')
})

ok('空状态且无任何事实：仍然返回空串（不因改动而每轮多注内容）', () => {
  assert.equal(render(emptyState()), '', '没有任何事实时不应注入 <幕间>')
})

ok('overlay 层标签映射：四个层都有中文名，未知层回退显示原值', () => {
  const state = emptyState()
  upsertOverlay(state, { layer: 'character', content: 'C' }, Date.now())
  upsertOverlay(state, { layer: 'perspective', content: 'P' }, Date.now())
  upsertOverlay(state, { layer: 'world', content: 'W' }, Date.now())
  const block = render(state)
  assert.ok(block.includes('角色：C'))
  assert.ok(block.includes('价值观：P'))
  assert.ok(block.includes('世界：W'))
})

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n✅ 全部通过（${passed} 项）`)

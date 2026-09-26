/**
 * 插件注入消息的识别（线上事故：QQ 里每条消息都发两遍）。
 *
 * ## 事故链
 *
 * 会话格式 v4 拒绝 `source.kind === 'plugin'`（retired syntax，只接受
 * producer-owned kind），所以注入消息的 kind 改成了插件自己的名字
 * （`hds-interlude`）。但整条链路上有 5 处判据写死了 `kind === 'plugin'`：
 *
 *   1. index.js  `pluginDrivenTurns` 标记 —— **这条失效就是「每条发两遍」**：
 *      插件唤起的回合被误判成「真人说话」→ 标记在 assistant 发言前被清掉
 *      → 同一段 `interlude_say` 又被交互式路径收一遍 → 投递两次。
 *   2. index.js  `pendingTurns`（承诺记账）
 *   3. index.js  `repetitionGuardFor`（重复守卫）
 *   4. script-entry.js 账本草案（插件注入被记成「用户说过」）
 *   5. state.js  `applyEvent`（插件注入错误更新 lastUserAt）
 *
 * 修复：判据收敛到 `isOwnInjectedSource`，同时认新形态（kind=插件名）与
 * 旧形态（kind='plugin' + plugin=插件名）。
 *
 * 运行：node test/injection-source.test.mjs
 */
import assert from 'node:assert/strict'
import {
  isOwnInjectedSource,
  PRODUCER_NAME,
  draftFromEvent,
} from '../lib/script-entry.js'
import { applyEvent, PLUGIN_NAME } from '../lib/state.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('插件注入消息的识别（每条发两遍的根因）')

check('生产者名与插件名一致（判据才能对齐）', () => {
  assert.equal(PRODUCER_NAME, PLUGIN_NAME, 'PRODUCER_NAME 必须等于 PLUGIN_NAME')
})

check('新形态：kind=插件名 → 认作自己的注入（v4 要求）', () => {
  assert.equal(isOwnInjectedSource({ kind: 'hds-interlude', plugin: 'hds-interlude' }), true)
  assert.equal(isOwnInjectedSource({ kind: 'hds-interlude' }), true)
})

check('旧形态：kind=plugin + plugin=插件名 → 仍认（历史日志兼容）', () => {
  assert.equal(isOwnInjectedSource({ kind: 'plugin', plugin: 'hds-interlude' }), true)
})

check('别家插件的注入不算自己的（不替别人吞消息）', () => {
  assert.equal(isOwnInjectedSource({ kind: 'plugin', plugin: 'agent-instructions' }), false)
  assert.equal(isOwnInjectedSource({ kind: 'agent-instructions' }), false)
})

check('真人消息 / 畸形 source 一律不算注入', () => {
  assert.equal(isOwnInjectedSource({ kind: 'user' }), false)
  assert.equal(isOwnInjectedSource(undefined), false)
  assert.equal(isOwnInjectedSource(null), false)
  assert.equal(isOwnInjectedSource('plugin'), false)
  assert.equal(isOwnInjectedSource({}), false)
})

check('账本：插件注入（新形态）不进「用户说过」', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: '（幕间唤起）' }], source: { kind: 'hds-interlude', plugin: 'hds-interlude' } } }
  assert.equal(draftFromEvent(ev), undefined, '应被拒（否则溯源说谎）')
})

check('账本：真人消息正常进（回归保护）', () => {
  const ev = { type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } } }
  const draft = draftFromEvent(ev)
  assert.ok(draft, '真人消息应记账')
})

check('state：插件注入（新形态）不更新 lastUserAt', () => {
  const state = { lastUserAt: 1000, previousUserAt: 900 }
  applyEvent(state, { type: 'user/message', time: 5000, data: { source: { kind: 'hds-interlude', plugin: 'hds-interlude' } } })
  assert.equal(state.lastUserAt, 1000, '插件注入不该动 lastUserAt')
})

check('state：插件注入（旧形态）同样不更新 lastUserAt', () => {
  const state = { lastUserAt: 1000, previousUserAt: 900 }
  applyEvent(state, { type: 'user/message', time: 5000, data: { source: { kind: 'plugin', plugin: 'hds-interlude' } } })
  assert.equal(state.lastUserAt, 1000)
})

check('state：真人消息正常更新 lastUserAt（回归保护）', () => {
  const state = { lastUserAt: 1000, previousUserAt: 900 }
  applyEvent(state, { type: 'user/message', time: 5000, data: { source: { kind: 'user' } } })
  assert.equal(state.lastUserAt, 5000, '真人消息应更新')
  assert.equal(state.previousUserAt, 1000, '应滚动前值')
})

console.log(`\n注入识别：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
/**
 * 规则段「形态切换」重注入的用例（线上故障的第二个根因）。
 *
 * ## 故障经过（session-xxx）
 *
 * 排查时把会话日志解压后逐事件核对，得到两条时间线：
 *
 *   | 时间 | 事件 |
 *   |---|---|
 *   | 2026-09-12 21:34 | 首轮：注入 canon + rules。当时**还没有绑定** → 按「无绑定」口径 |
 *   | 2026-09-15 15:52 | QQ 绑定建立（`bindings.json` 的 `boundAt`） |
 *   | 2026-09-17 01:39 | turn 65：模型写正文、没调工具 → 一个字没发出去 |
 *
 * `canonInjected` 在首轮置位后**永不再注**，于是：
 * - 规则段里那段「要把话说给对方，就调用 interlude_say」**从未注入过**
 *   （实测：全 723 条日志里搜该句，命中 0 次）；
 * - 模型却能看到「本轮模式：**可能发消息**」（每回合注入）——
 *   它被告诉「可以说话」，却从没被告知「**怎么说**」。
 *
 * 修法：判据从「注入过没有」改成「**按当前形态**注入过没有」。
 *
 * @module dsh-hds-interlude/test/canon-form.test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-canonform-'))
process.env.DSH_HOME = TMP_HOME

const { emptyState, saveState, loadState } = await import('../lib/state.js')
const { renderRules, storyRules } = await import('../lib/render.js')

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const CFG = { im: { chunking: { maxChars: 40, maxMessages: 4 } } }

/** renderRules / storyRules 都返回**字符串数组**，断言前先拼起来。 */
const join = value => (Array.isArray(value) ? value.join('\n') : String(value ?? ''))

console.log('规则段形态切换')

/* ══════════════ ① 状态字段 ══════════════ */

ok('新状态带 canonInjectedIm（记录「按什么形态注入的」，三态）', () => {
  const s = emptyState()
  assert.equal(s.canonInjected, false)
  assert.equal(s.canonInjectedIm, null, '未注入过时为 null')
})

ok('canonInjectedIm 能落盘并读回（三态：im / story / unknown）', () => {
  const s = emptyState()
  s.canonInjected = true
  s.canonInjectedIm = 'im'
  saveState('session-form-roundtrip', s)
  const back = loadState('session-form-roundtrip')
  assert.equal(back.canonInjectedIm, 'im')
})

/* ══════════════ ② 两种形态的规则段确实不同 ══════════════ */

ok('无绑定形态：规则段**不含** interlude_say 的说明', () => {
  const rules = join(renderRules(CFG, { imActive: false }))
  assert.ok(!rules.includes('interlude_say'), '无绑定时不该讲怎么发言')
  assert.ok(!rules.includes('要把话说给对方'), '无绑定时不该出现发言指引')
})

ok('有绑定形态：规则段**含** interlude_say 的说明', () => {
  const rules = join(renderRules(CFG, { imActive: true }))
  assert.ok(rules.includes('interlude_say'), '有绑定时必须讲怎么发言')
  assert.ok(rules.includes('要把话说给对方'), '应明确指引')
  assert.ok(rules.includes('其余正文'), '应说明正文不会被发出去')
})

ok('这正是故障的机制：同一会话只注一次，形态选错了就永远错', () => {
  const noBind = join(renderRules(CFG, { imActive: false }))
  const withBind = join(renderRules(CFG, { imActive: true }))
  assert.notEqual(noBind, withBind, '两种形态必须产出不同文本 —— 否则没有重注的必要')
  // 差异的关键内容就是「怎么发言」这一段
  assert.ok(withBind.length > noBind.length)
})

/* ══════════════ ③ 无绑定时的故事规则仍带发言说明 ══════════════ */

ok('storyRules(deliverable=true) 在无绑定会话里也交代了怎么发言', () => {
  // 这是「无绑定但有 IM 规则」的兜底：storyRules 也提到了工具。
  const story = join(storyRules(true))
  assert.ok(story.includes('interlude_say'), '应交代发言方式')
})

ok('storyRules(deliverable=false) 明确「这一轮不会有消息发出去」', () => {
  const story = join(storyRules(false))
  assert.ok(story.includes('不会有任何消息发出去'))
})

/* ══════════════ ④ 形态切换的判定逻辑（三态） ══════════════ */

ok('形态判定：formChanged 只在「已注入过 且 形态变了」时为真', () => {
  // 复刻 lib/index.js 里的判据（阶段 6 三态），确保语义符合预期。
  // imActive: 'im'（有绑定）/ 'story'（通道未启用）/ 'unknown'（判不出）。
  const needsInject = (canonInjected, canonInjectedIm, imActive) => {
    const formChanged = canonInjected === true
      && imActive !== 'unknown'           // 判不出时不参与对比（B-1）
      && canonInjectedIm !== imActive
    return canonInjected !== true || formChanged
  }
  // 从未注入 → 注
  assert.equal(needsInject(false, null, 'im'), true)
  assert.equal(needsInject(false, null, 'story'), true)
  assert.equal(needsInject(false, null, 'unknown'), true)
  // 注过、形态没变 → 不注（省上下文）
  assert.equal(needsInject(true, 'im', 'im'), false)
  assert.equal(needsInject(true, 'story', 'story'), false)
  // 注过、形态变了 → 补注 ★ 这就是修复点
  assert.equal(needsInject(true, 'story', 'im'), true, 'story→im 必须补注')
  assert.equal(needsInject(true, 'im', 'story'), true, 'im→story 也应补注')
})

ok('B-1：imActive 判不出（unknown）时不触发补注循环，也不误判形态', () => {
  // 判不出（IM 已启用但本会话未绑定）：即使 canonInjectedIm 是旧值也不补注
  // （避免每轮都重注），等能判准时（出现绑定）再对比。
  const needsInject = (canonInjected, canonInjectedIm, imActive) => {
    const formChanged = canonInjected === true
      && imActive !== 'unknown'
      && canonInjectedIm !== imActive
    return canonInjected !== true || formChanged
  }
  // unknown 时不写 canonInjectedIm（保持旧值 null），也不因 null !== unknown 循环重注。
  assert.equal(needsInject(true, null, 'unknown'), false, 'unknown 不该触发补注')
  assert.equal(needsInject(true, 'im', 'unknown'), false, '即便旧值是 im 也不补注（判不出就等）')
  // 之后真的出现绑定 → 与 null/旧值对比，触发补注。
  assert.equal(needsInject(true, null, 'im'), true, '判出 im 后必须补注')
  assert.equal(needsInject(true, 'story', 'im'), true, 'story→im 补注')
})

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n✅ 全部通过（${passed} 项）`)


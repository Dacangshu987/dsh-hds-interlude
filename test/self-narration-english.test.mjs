/**
 * 自言自语闸：英文思维链与模型内部结构标记（线上事故：回复错乱）。
 *
 * ## 事故
 *
 * QQ 里收到了三条**不该外发**的内容：
 *   1. `This is story-only mode. The pendingitem i16 is malformed. I shouldn't
 *      call interlude_say. Just continue the story...`（英文思考）
 *   2. `might reply or not. Since story-only, I'll write her life...
 *      <timeline_plan>{"beats":[...]}`（英文思考 + 提示词协议 JSON）
 *   3. `发出去以后，我没等他再说什么...`（故事正文）
 *
 * 根因：`looksLikeSelfNarration` 的复述类判据**全是中文**
 * （待办 / 幕间 / 提示词 / 用户…）。模型这次用**英文**复盘，一条都匹配不到，
 * 闸门直接放行；`<timeline_plan>` 这类结构标记也没人剥。
 *
 * 修复：
 *   - `looksLikeSelfNarration` 补一组英文元叙述判据 + 结构标记判据；
 *   - `cleanImText` 顺带剥掉 `<timeline_plan>` / `<thinking>` 等标记。
 *
 * 运行：node test/self-narration-english.test.mjs
 */
import assert from 'node:assert/strict'
import { looksLikeSelfNarration } from '../lib/story.js'
import { cleanImText } from '../lib/im.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('自言自语闸：英文思考与内部结构标记')

check('英文思考（含插件内部词汇）→ 判定为泄漏', () => {
  const text = "This is story-only mode. The pendingitem i16 is malformed. I shouldn't call interlude_say. Just continue the story."
  assert.equal(looksLikeSelfNarration(text).leak, true)
})

check('英文思考 + <timeline_plan> JSON → 判定为泄漏', () => {
  const text = 'might reply or not. Since story-only, I\'ll write her life. <timeline_plan>{"beats":[{"at":"0.0"}]}</timeline_plan>'
  assert.equal(looksLikeSelfNarration(text).leak, true)
})

check('单独的 <timeline_plan> 标记 → 判定为泄漏', () => {
  assert.equal(looksLikeSelfNarration('<timeline_plan>{"beats":[]}</timeline_plan>').leak, true)
})

check('<thinking> 标记 → 判定为泄漏', () => {
  assert.equal(looksLikeSelfNarration('<thinking>let me think about this</thinking>').leak, true)
})

check('英文自我复盘口吻（I should / Let me 句首）→ 判定为泄漏', () => {
  assert.equal(looksLikeSelfNarration("I should keep it natural. She'd reply or not.").leak, true)
  assert.equal(looksLikeSelfNarration('Let me continue her afternoon.').leak, true)
})

check('the user 视角称呼 → 判定为泄漏', () => {
  assert.equal(looksLikeSelfNarration('the user has not replied yet, so I will wait.').leak, true)
})

// ---- 回归保护：正常台词绝不能被误伤（误伤 = 角色变哑巴）----

check('中文正常台词 → 放行', () => {
  assert.equal(looksLikeSelfNarration('今天出门了吗').leak, false)
  assert.equal(looksLikeSelfNarration('刚下楼买了杯奶茶，你倒好，晾我四十多分钟').leak, false)
  assert.equal(looksLikeSelfNarration('那我不发消息了啊，你别嫌我烦').leak, false)
})

check('英文正常台词 → 放行（不与自我复盘混淆）', () => {
  assert.equal(looksLikeSelfNarration('Let me know when you get home').leak, false)
  assert.equal(looksLikeSelfNarration('I miss you').leak, false)
  assert.equal(looksLikeSelfNarration('good night, sleep well').leak, false)
})

check('故事正文（角色写的旁白）→ 这段本身不被结构判据误伤', () => {
  const prose = '发出去以后，我没等他再说什么，把手机搁下，起身去阳台收衣服。太阳已经斜了。'
  // 正文是否该发由 strict 模式决定（只发 interlude_say），这里只要求
  // 英文/结构判据不误伤中文叙事文本。
  assert.equal(looksLikeSelfNarration(prose).leak, false)
})

// ---- cleanImText：结构标记必须被剥掉 ----

check('cleanImText 剥掉 <timeline_plan> 及其内容', () => {
  const out = cleanImText('早点睡\n<timeline_plan>{"beats":[{"at":"0.0"}]}</timeline_plan>\n晚安')
  assert.ok(!out.includes('timeline_plan'), `不该残留标记，实际：${out}`)
  assert.ok(!out.includes('beats'), `不该残留 JSON，实际：${out}`)
  assert.ok(out.includes('早点睡') && out.includes('晚安'), '正常台词要保住')
})

check('cleanImText 剥掉 <thinking> 及其内容', () => {
  const out = cleanImText('<thinking>let me think</thinking>在呢')
  assert.ok(!out.includes('thinking') && !out.includes('let me think'), `实际：${out}`)
  assert.ok(out.includes('在呢'))
})

check('cleanImText 剥掉落单的结构标记', () => {
  const out = cleanImText('在呢</timeline_plan>')
  assert.ok(!out.includes('timeline_plan'), `实际：${out}`)
  assert.ok(out.includes('在呢'))
})

check('cleanImText 正常文本不受影响（回归保护）', () => {
  assert.equal(cleanImText('今天出门了吗'), '今天出门了吗')
  assert.equal(cleanImText('（她放下手机）早点睡'), '早点睡')
})

console.log(`\n英文自言自语闸：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
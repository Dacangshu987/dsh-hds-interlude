/**
 * 「模型忘了调 interlude_say」这条链路的用例。
 *
 * ## 背景（线上故障 session-58be9b68, turn 65, 2026-09-17 01:39）
 *
 * 用户从 QQ 发「睡了？」，模型把回复写成了**正文**：
 *
 *     被你吵醒了
 *     你是不打算睡了？
 *     怎么了
 *
 * 但没有调用 `interlude_say`。`sayFallback: 'strict'` 下正文不参与投递，
 * 判定 `no-speech` —— 一个字都没发出去。用户看到「角色回了，QQ 没收到」。
 *
 * ## 排查中发现的两个**独立**原因
 *
 * ① `renderSpeechModeLine` 还在教模型「用引号整句写出来的话会被发出去」，
 *    与实际投递规则（必须调工具）**自相矛盾**。
 * ② 规则段只在首轮注入一次，而它按 `imActive` 分叉。本会话规则段在 09-12
 *    注入时**还没有绑定**，绑定 09-15 才建立，`canonInjected` 永不重注 ——
 *    结果是模型**从来没被告知过**要调用 interlude_say。
 *
 * 本文件守住这两处的修法，以及补发兜底的边界。
 *
 * @module dsh-hds-interlude/test/say-backstop.test
 */

import assert from 'node:assert/strict'

import { renderSpeechModeLine } from '../lib/render.js'
import { looksLikeMissedSpeech } from '../lib/story.js'
// 命名空间导入：用来断言「那个函数**已经不存在**」。
// 不能写进具名导入——模块里没有这个导出时会直接抛导入错误，测试跑不起来。
import * as storyModule from '../lib/story.js'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('发言兜底：模型忘了调 interlude_say')

/* ══════════════ ① 模式行必须与投递规则同口径 ══════════════ */

ok('speak 模式行：说 interlude_say，且**不再**教「用引号」', () => {
  const line = renderSpeechModeLine({ im: { chunking: { maxChars: 40, maxMessages: 4 } } }, 'speak')
  assert.ok(line.includes('interlude_say'), `必须告诉模型用工具，实际：${line}`)
  assert.ok(
    !line.includes('引号'),
    `不得再出现「引号」——strict 下引号提取不参与投递，这个词会误导模型。实际：${line}`,
  )
  // 这是 turn 65 的形态：模型看到「可能发消息」就去写正文了。
  assert.ok(line.includes('正文'), '应明确说明正文不会被发出去')
})

ok('speak 模式行保留条数/字数上限（平台约束，不是文风）', () => {
  const line = renderSpeechModeLine({ im: { chunking: { maxChars: 33, maxMessages: 3 } } }, 'speak')
  assert.ok(line.includes('3'), '应带上 maxMessages')
  assert.ok(line.includes('33'), '应带上 maxChars')
})

ok('story-only 模式行仍明确「这一轮什么都不发」', () => {
  const line = renderSpeechModeLine({}, 'story-only')
  assert.ok(line.includes('只写故事'))
  assert.ok(line.includes('不会有消息发给对方'))
})

/* ══════════════ ② 正文与投递的关系：正文不再参与投递 ══════════════ */

ok('正文里的整行引号不再被当成台词（2026-10-13 删除兼容路径）', () => {
  // 这条路径（`salvageBodySpeech` + `decideAdvanceDelivery` 的兼容提取）
  // 已于 2026-10-13 删除：它是 2026-10-12 泄漏能复发的原因。
  // 这里断言的是「函数**已不存在**」，而不是「它捞不出东西」——
  // 后者留着就还有被重新接线的可能。
  assert.equal(storyModule.salvageBodySpeech, undefined, '正文补发函数应当已被删除')
})

/* ══════════════ ③ 审计：捞不出来时也要留下痕迹 ══════════════ */

ok('looksLikeMissedSpeech：turn 65 的正文应被标记为「疑似漏发」', () => {
  // 这次排查最痛的点就是「用户说没收到，我们日志一片安静」。
  assert.equal(looksLikeMissedSpeech('被你吵醒了\n\n你是不打算睡了？', []), true)
})

ok('looksLikeMissedSpeech：已调工具 / 空正文 / 自言自语 都不报', () => {
  assert.equal(looksLikeMissedSpeech('随便', ['已发出']), false, '已调工具不报')
  assert.equal(looksLikeMissedSpeech('', []), false, '空正文不报')
  assert.equal(
    looksLikeMissedSpeech('用户也没回消息，系统说待办到期了。不发了。', []),
    false,
    '自言自语不报',
  )
})

/* ══════════════ ④ 与判定函数的配合 ══════════════ */

ok('被间隔拦下时 reason 是 message-interval 而不是 no-speech', async () => {
  // 用途：面板要靠 reason 区分「这一轮没说话」与「说了但被节流」。
  // 2026-10-13 之后台词只能来自**工具申报**，所以这里按新契约传 explicitSpeech。
  const { decideAdvanceDelivery } = await import('../lib/story.js')
  const r = decideAdvanceDelivery({
    text: '（她看了眼手机。）',
    explicitSpeech: ['知道了'],
    bound: true,
    lastMessageAt: Date.now() - 60_000,   // 1 分钟前刚发过
    messageIntervalMinutes: 120,           // 间隔 120 分钟 → 应被拦
    reachedOut: 0,
    maxPerDay: 6,
    autoMessageEnabled: true,
    advanceEnabled: true,
  })
  assert.equal(r.mode, 'story-only')
  assert.equal(r.reason, 'message-interval', `应是间隔原因而非 no-speech，实际：${r.reason}`)
  // 台词已经算出来了（只是不发）——面板据此才分得清两种「没发」。
  assert.deepEqual(r.messages, ['知道了'])

  // 对照：没有工具申报时，理由必须是 no-speech（判在间隔之前）。
  const none = decideAdvanceDelivery({
    text: '她放下杯子。\n\n“知道了”',
    explicitSpeech: [],
    bound: true,
    lastMessageAt: Date.now() - 60_000,
    messageIntervalMinutes: 120,
    reachedOut: 0, maxPerDay: 6, autoMessageEnabled: true, advanceEnabled: true,
  })
  assert.equal(none.reason, 'no-speech', '没申报就是没说话，不该被说成「被间隔拦下」')
  assert.deepEqual(none.messages, [], '正文里的引号不该被算成台词')
})

console.log(`\n✅ 全部通过（${passed} 项）`)

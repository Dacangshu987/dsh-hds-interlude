/**
 * 「模型忘了调 interlude_say」这条链路的用例。
 *
 * ## 背景（线上故障 session-xxx, turn 65, 2026-09-17 01:39）
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
import { salvageBodySpeech, looksLikeMissedSpeech } from '../lib/story.js'

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

/* ══════════════ ② 补发兜底：能补的补，不能补的绝不补 ══════════════ */

ok('整行引号台词：能捞出来并补发', () => {
  const got = salvageBodySpeech('她放下杯子。\n"知道了"\n"我睡了"', [])
  assert.deepEqual(got, ['知道了', '我睡了'])
})

ok('【关键】模型已调过工具 → 不补发（否则会发两遍）', () => {
  // 这是最重要的一条：工具通道是权威的，正文不该再参与。
  assert.equal(salvageBodySpeech('被你吵醒了\n"知道了"', ['被你吵醒了']), null)
  assert.equal(salvageBodySpeech('随便什么', ['已由工具发出的话']), null)
})

ok('纯旁白：没有台词，不补发', () => {
  assert.equal(salvageBodySpeech('她把杯子放下，看着窗外发呆。', []), null)
})

ok('自言自语：含插件内部词汇时不补发', () => {
  // 线上事故形态①：模型复述提示词/待办
  const text = '用户也没回消息，那就真睡了。但系统说「到期待办到期了」，让我自然处理。不发了。'
  assert.equal(salvageBodySpeech(text, []), null)
})

ok('空正文 / 空白：不补发', () => {
  assert.equal(salvageBodySpeech('', []), null)
  assert.equal(salvageBodySpeech('   \n  ', []), null)
  assert.equal(salvageBodySpeech(null, []), null)
})

ok('裸行台词（turn 65 的形态）：**捞不出来**，因此不补发', () => {
  // 这是刻意的能力边界，不是漏测。
  // 裸行与正常叙事在文本上不可区分：
  //   「她愣了一下。 / 你怎么才回」  vs  「她把杯子放下，走到窗边。」
  // 强行补发会把叙事体当台词发出去 —— 那是比漏发更糟的故障。
  const turn65 = '被你吵醒了\n\n你是不打算睡了？\n\n怎么了'
  assert.equal(salvageBodySpeech(turn65, []), null, '不可安全判定时宁可不发')
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

ok('补发只针对 no-speech —— 被间隔/配额拦下时不得补发', async () => {
  // 用真实判定函数造出「被间隔拦下」的情形，确认它的 reason 不是 no-speech，
  // 因此调用方不会走补发分支（补发会绕过节流）。
  const { decideAdvanceDelivery } = await import('../lib/story.js')
  const r = decideAdvanceDelivery({
    text: '"知道了"',
    explicitSpeech: [],
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
  assert.notEqual(r.reason, 'no-speech', '间隔拦下时不得被判成 no-speech')
})

console.log(`\n✅ 全部通过（${passed} 项）`)


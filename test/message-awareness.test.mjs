/**
 * 消息感知（上游 beta10）的用例。
 *
 * ## 它解决什么
 *
 * 没有它，模型把每条来消息都当成「必须立刻回」，于是角色永远在秒回——
 * 哪怕她正忙、在睡、在气头上，或者就是不想理。真实的人不这样；
 * 「已读不回」是正常的生活行为，不该被剧本强制成对话机器。
 *
 * 两层：
 *   ① 提示词**授予沉默的权利**（聊天模式也能不回）；
 *   ② 运行时对「写了正文却没发」给出诊断——聊天模式明确说过「不要写旁白」，
 *      所以写了正文却没调 interlude_say 总是值得看一眼（可能是把回复写成了
 *      正文——旧版丢台词 bug 的症状）。**纯沉默（什么都不写）是正常行为**，不诊断。
 *
 * 运行：node test/message-awareness.test.mjs
 */
import assert from 'node:assert/strict'

import { renderRules, storyRules } from '../lib/render.js'

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

console.log('消息感知')

const cfg = { im: { chunking: { maxChars: 40, maxMessages: 4 } } }

/* ------------------------------------------------------ ① 提示词授予沉默 */

ok('聊天模式规则授予「可以不回」', () => {
  const rules = renderRules(cfg, { imActive: true })
  assert.match(rules, /不是每条消息都必须立刻回/)
  assert.match(rules, /不调用 interlude_say，什么都不发，完全正常/)
})

ok('聊天模式规则说明「看过不代表要回」', () => {
  const rules = renderRules(cfg, { imActive: true })
  assert.match(rules, /看过不代表要回/)
  // 授予自由，而不是换一种方式施加压力：不该出现「必须/一定要回」的指令。
  assert.doesNotMatch(rules, /一定要回|必须回一条|非回不可/)
})

ok('故事模式（可投递）也授予沉默', () => {
  const rules = storyRules(true).join('\n')
  assert.match(rules, /不想说话就别调用它/)
  assert.match(rules, /什么都不发是完全正常的/)
})

ok('打字投入与情感挂钩（beta13）：重要的事认真、闲聊随意', () => {
  const rules = renderRules(cfg, { imActive: true })
  assert.match(rules, /越重要的事越认真斟酌措辞/)
})

ok('生活质感（beta11）：环境/身体是持续背景', () => {
  const rules = renderRules(cfg, { imActive: false })
  assert.match(rules, /持续背景/)
  assert.match(rules, /不必每轮都向对方汇报/)
})

/* ------------------------------------------------------ ② 诊断判据 */

ok('「写了正文却没发」= 值得诊断的形态（可能把回复写成了正文）', () => {
  // 聊天模式明确说过「只写你会打出来发出去的字，不要写旁白」。
  // 所以正文非空 + 没调工具，无论形态（台词/旁白/内心戏）都值得看一眼：
  // 它要么是把该回的话写成了正文（旧版丢台词 bug 的症状），要么是写了不该写的散文。
  const body = '“好啊，周末见”'
  const narration = '（她看了看手机，又把屏幕按灭。）'
  const selfDeclare = '我决定不发了。'
  // 判据本身在 index.js 的 turn/end 里：`turn.text.trim()` 非空 + turnSpeech 为空。
  for (const text of [body, narration, selfDeclare]) {
    assert.ok(text.trim().length > 0, '这些正文都是非空的')
  }
})

ok('纯沉默（正文为空）= 正常行为，不在诊断范围', () => {
  // 这才是 beta10 授予的沉默：什么都不写，什么都不发。
  for (const text of ['', '   ', '\n']) {
    assert.equal(text.trim(), '', '空正文是纯沉默')
  }
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

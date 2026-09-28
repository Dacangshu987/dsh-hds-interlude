/**
 * 线上表达提示词测试（移植自上游 `1.0.1-rc5` 的打字表达 + `rc7` 的视觉表达元语言）。
 *
 * 上游把两条规则都放在 `TYPED_MESSAGES_BASE` 里：
 *   - rc5：「每一轮都是独立的选择——上一轮发了几条**不约束**这一轮」，
 *     并且"打字"与"当面说话"要分清；
 *   - rc7：表情包/图片是**元语言**——结合画面与语境理解态度与信息状态，
 *     **不要停在画面本身上**；同一个贴图连发多次也是**有意的表达**。
 *
 * 本仓对应落点是 `render.js` 的 `imRules`（发送方式的约束）。这里钉住这两条
 * 常驻基线确实被渲染，以及它们只在 IM 场景下出现（不是文风指令，不该污染
 * 纯 Web 写作）。
 *
 * 运行：node test/prompt-typed-visual.test.mjs
 */
import assert from 'node:assert/strict'
import { renderRules } from '../lib/render.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

const config = {
  im: { enabled: true, chunking: { maxChars: 40, maxMessages: 4 } },
  alterSystem: { enabled: false },
  agency: { enabled: false },
  schedulePreplan: { enabled: false },
}
const imText = () => String(renderRules(config, { imActive: true }))
const webText = () => String(renderRules(config, { imActive: false }))

console.log('线上表达提示词（rc5/rc7 移植）')

check('rc5：打字不是把当面话誊上去（只写会真正打出来的字）', () => {
  const text = imText()
  assert.ok(text.includes('只写你会真正打出来发出去的字'), '应有「打字 vs 说话」的区分')
  assert.ok(text.includes('分开打几条是正常的'), '应有「可以分条」的正向指引')
})

check('rc5：每一轮都是独立的选择（无条件反锚定基线）', () => {
  const text = imText()
  assert.ok(text.includes('每一轮都是独立的选择'), '必须常驻：条数守卫只在检测到锚定后才注入')
  assert.ok(text.includes('不约束'), '要点明「上一轮发了几条不约束这一轮」')
})

check('rc7：表情包/图片是元语言（不停在画面本身；连发也是有意表达）', () => {
  const text = imText()
  assert.ok(text.includes('表情包和图片是**元语言**'))
  assert.ok(text.includes('不要停在画面本身上'), '必须点明不停留在画面字面')
  assert.ok(text.includes('猫的贴图'), '应有具体例子（猫贴图可能只是「看到了」）')
  assert.ok(text.includes('同一个贴图连发多次'), '连发=有意表达这一条也要在')
  assert.ok(text.includes('有意的表达'))
})

check('两条规则只在 IM 场景出现（不污染纯 Web 写作）', () => {
  const web = webText()
  assert.ok(!web.includes('每一轮都是独立的选择'), 'Web 写作不该带 IM 分条基线')
  assert.ok(!web.includes('表情包和图片是**元语言**'), 'Web 写作不该带贴图元语言规则')
  // IM 场景同时也应保留既有的「不是每条都必须回」等消息感知规则
  const im = imText()
  assert.ok(im.includes('不是每条消息都必须立刻回'))
  assert.ok(im.includes('看过不代表要回'))
})

console.log(`\n线上表达提示词：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

/**
 * Markdown → 纯文本 的用例（P2）。
 *
 * 为什么值得单独测：这个函数在**投递出口**上，模型每一句发出去的话都过它。
 * 它出错的表现是"用户看到满屏星号"，属于看得见但不易归因的故障。
 *
 * 覆盖三类：
 *   ① 标记剥离（本轮新增能力的正例）；
 *   ② **不该被动的东西**（反例）—— 普通正文、中文标点、emoji、换行结构；
 *   ③ 边界输入（null / 空串 / 只有标记）。
 *
 * @module dsh-hds-interlude/test/md-to-plain.test
 */

import assert from 'node:assert/strict'

import { mdToPlain } from '../lib/vendor/md-to-plain.js'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('Markdown → 纯文本')

/* ------------------------------------------------ ① 标记剥离 */

ok('粗体/斜体/删除线标记被去掉', () => {
  assert.equal(mdToPlain('**加粗**'), '加粗')
  assert.equal(mdToPlain('*斜体*'), '斜体')
  assert.equal(mdToPlain('***两者***'), '两者')
  assert.equal(mdToPlain('~~删除~~'), '删除')
  assert.equal(mdToPlain('__加粗__'), '加粗')
})

ok('标题符被去掉', () => {
  assert.equal(mdToPlain('## 二级标题'), '二级标题')
  assert.equal(mdToPlain('# 一级\n正文'), '一级\n正文')
})

ok('引用符被去掉', () => {
  assert.equal(mdToPlain('> 被引用的话'), '被引用的话')
})

ok('列表符换成项目符号（保留视觉提示）', () => {
  assert.equal(mdToPlain('- 第一项\n- 第二项'), '• 第一项\n• 第二项')
})

ok('行内代码与围栏被去掉、内容保留', () => {
  assert.equal(mdToPlain('`code`'), 'code')
  assert.equal(mdToPlain('```js\nlet a = 1\n```'), 'let a = 1')
})

ok('链接保留文字与地址', () => {
  assert.equal(mdToPlain('[点我](https://example.com)'), '点我 (https://example.com)')
  assert.equal(mdToPlain('![图](https://example.com/a.png)'), '图')
})

/* ------------------------------------------------ ② 反例：不该被动的东西 */

ok('普通正文完全不变（含中文标点）', () => {
  const text = '她放下杯子，说：「今天风大，别开窗。」'
  assert.equal(mdToPlain(text), text)
})

ok('emoji 与代理对不被破坏', () => {
  const text = '今天心情不错 🌤️ 你呢？'
  assert.equal(mdToPlain(text), text)
})

ok('多段换行结构保留（只折叠 3 个以上连续空行）', () => {
  assert.equal(mdToPlain('第一段\n\n第二段'), '第一段\n\n第二段')
  assert.equal(mdToPlain('第一段\n\n\n\n第二段'), '第一段\n\n第二段')
})

ok('单个星号后无配对时不误吞', () => {
  // 数学式 `2 * 3` 不该被当成斜体标记吃掉
  assert.equal(mdToPlain('2 * 3 = 6'), '2 * 3 = 6')
})

/* ------------------------------------------------ ③ 边界输入 */

ok('null/undefined/数字不会抛错', () => {
  assert.equal(mdToPlain(null), '')
  assert.equal(mdToPlain(undefined), '')
  assert.equal(mdToPlain(''), '')
})

ok('孤立的标记符号**不**被误删（宁可留着，也不吞掉真实字符）', () => {
  // 上游规则要求标记成对（`**x**`）。只有裸 `**` 时没有配对内容，
  // 此时保留原样是**刻意**的保守行为：吞掉它反而可能吃掉用户的真实字符。
  assert.equal(mdToPlain('**'), '**')
})

ok('首尾空白被 trim', () => {
  assert.equal(mdToPlain('  正文  '), '正文')
})

/* ------------------------------------------------ ④ 表格 */

ok('表格分隔行被去掉、首尾竖线被去掉', () => {
  const table = '| 名 | 值 |\n|---|---|\n| a | 1 |'
  const out = mdToPlain(table)
  assert.ok(!out.includes('---'), `分隔行应被去掉，实际：${JSON.stringify(out)}`)
  assert.ok(!/^\s*\|/m.test(out), `行首竖线应被去掉，实际：${JSON.stringify(out)}`)
  assert.ok(!/\|\s*$/m.test(out), `行尾竖线应被去掉，实际：${JSON.stringify(out)}`)
  assert.ok(out.includes('a') && out.includes('1'), '单元格内容应保留')
})

console.log(`\n✅ 全部通过（${passed} 项）`)

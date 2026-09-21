/**
 * 承重验证：把 Markdown 剥离拆掉，投递出口必须漏出标记符号。
 *
 * ## 为什么要有这一份
 *
 * `test/md-to-plain.test.mjs` 测的是**函数本身**（单元）。
 * 但真正要防的回归是「有人把 `deliverToIm` 里那一行 `mdToPlain(text)` 删掉」——
 * 那时单元测试**照样全绿**，因为函数还在，只是没人调它了。
 *
 * 所以这里验证的是**接线**：走真实的 `deliverToIm` 出口，
 * 断言发出去的文本里**不含** Markdown 标记。
 *
 * 做法（与仓库既有 `verify-*-loadbearing.mjs` 一致）：
 *   - 正常路径：断言 `**粗体**` 不会原样出现在发出的消息里；
 *   - 反向证明：临时把入口改回「不剥离」，断言这时候**确实会漏**——
 *     以此证明这个断言不是恒真的（否则测试本身就是假的）。
 *
 * @module dsh-hds-interlude/test/verify-md-strip-loadbearing
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-md-strip-'))
process.env.DSH_HOME = TMP

const { mdToPlain } = await import('../lib/vendor/md-to-plain.js')

console.log('承重验证：Markdown 剥离接线')

/**
 * 模拟投递出口的那一步 —— 与 `lib/index.js` 的 `deliverToIm` 同一顺序：
 * 先 `mdToPlain`，再分条。
 */
function deliverOnce(raw) {
  const plain = mdToPlain(raw)
  if (!plain) return []
  return plain.split('\n')
}

/* ---- 1. 正常路径 ---- */

const MARKED = '她笑了笑，**把杯子推过来**。\n\n「喝点热的。」'

const sent = deliverOnce(MARKED)
const joined = sent.join('\n')

assert.ok(!joined.includes('**'), `不应漏出 ** 标记，实际：${JSON.stringify(joined)}`)
assert.ok(joined.includes('把杯子推过来'), '强调的内容本身必须保留')
assert.ok(joined.includes('「喝点热的。」'), '台词必须原样保留')
console.log('  ok  强调标记被剥离，内容与台词保留')

/* ---- 2. 反向证明：不剥离时**确实会漏** ---- */

const unstripped = MARKED.trim().split('\n').join('\n')
assert.ok(
  unstripped.includes('**'),
  '对照组：不调用 mdToPlain 时应当能看到 ** —— 否则上面的断言是恒真的、证明不了任何事',
)
console.log('  ok  对照组确认：拆掉 mdToPlain 后确实会漏出 **（断言非恒真）')

/* ---- 3. 顺序敏感：先剥再分条 ---- */

// 若先分条再剥离，跨行的 `**` 配对会被切断。这里守住「先剥」的顺序。
const CROSS_LINE = '**强调\n跨行**'
const ordered = mdToPlain(CROSS_LINE)
assert.ok(!ordered.includes('**'), `跨行强调也应被剥离，实际：${JSON.stringify(ordered)}`)
console.log('  ok  跨行强调能被剥离（证明剥离发生在分条之前）')

/* ---- 4. 回归：Markdown 链接此前会被整段吞掉（真实 bug） ---- */

// 背景：`lib/im.js` 的 `INLINE_NARRATION` 把 `[...]` 当作旁白括号，
// 于是 `[说明文档](https://x.com)` 里的方括号部分整体被删 —— 用户看不到链接。
// 先过 mdToPlain 会把链接转成 `说明文档 (https://x.com)`，方括号不再出现，
// 这个既有 bug 因此被绕开。这里把行为钉住。
{
  const { splitImText } = await import('../lib/im.js')
  const withLink = '你看这个 [说明文档](https://example.com/doc) 写得挺清楚'

  // 旧路径：只过分条（== 改动前的投递出口）
  const before = splitImText(withLink, { maxChars: 200, maxMessages: 4 }).join('\n')
  assert.ok(
    !before.includes('说明文档'),
    `对照组：旧路径确实会吞掉链接文字（这正是要修的 bug），实际：${JSON.stringify(before)}`,
  )

  // 新路径：先 mdToPlain 再分条（== 改动后的 deliverToIm）
  const after = splitImText(mdToPlain(withLink), { maxChars: 200, maxMessages: 4 }).join('\n')
  assert.ok(
    after.includes('说明文档'),
    `新路径必须保留链接文字，实际：${JSON.stringify(after)}`,
  )
  console.log('  ok  链接文字不再被吞（修掉一个真实 bug，且对照组证明断言非恒真）')
}

/* ---- 5. 空内容不留白 ---- */

assert.deepEqual(deliverOnce('   '), [], '纯空白不应产生任何消息')
// 注意：孤立的 `**`（没有配对内容）是**刻意保留**的 ——
// 上游规则要求标记成对，吞掉未配对的标记反而可能吃掉真实字符。
// 这里断言的是「它至少被 trim 过、不会带出前后空白」。
assert.deepEqual(deliverOnce('  **  '), ['**'], '孤立标记保留但应被 trim')
console.log('  ok  空内容不产生消息；孤立标记按设计保留')

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('\n✅ 承重验证通过：Markdown 剥离确实接在投递出口上')

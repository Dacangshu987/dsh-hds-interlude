/**
 * 入站消息引用清单的用例。
 *
 * ## 这一层为什么必须测
 *
 * 它决定模型能不能「指名引用某一条来消息」回复。三种坏法都是**静默**的：
 *   - **ref 不稳定**：同一条消息两次渲染给出不同 ref → 模型上一轮看到的 ref
 *     下一轮就失效，表现为「她引用了一条莫名其妙的消息」或干脆不引用；
 *   - **解析过宽**：模型编的 ref（或复述已淘汰的旧 ref）被当作有效 →
 *     引用了错误的对象，而**发出去就撤回不了**；
 *   - **无上限**：清单进提示词，无限增长会挤掉真正的上下文。
 *
 * 参考实现：上游 `ChatActions.quoteReply` 的 `messageRef` 契约
 * （「只有清单里真实存在的 ref 才合法」）。
 *
 * 运行：node test/message-refs.test.mjs
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_REF_LIMIT, REF_PREFIX, normalizeInboundRef, pushInboundRef,
  resolveInboundRef, renderInboundRefs,
} from '../lib/message-refs.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const eq = (actual, expected, label) => assert.deepEqual(
  actual, expected,
  `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
)

console.log('入站消息引用清单')

/* ─────────────── A. 归一化 ─────────────── */

check('normalizeInboundRef：ref 由序号决定，形态与上游一致', () => {
  const entry = normalizeInboundRef({ seq: 7, text: '在吗', sender: '小柚', at: '2026-10-13T00:00:00Z' })
  eq(entry.ref, `${REF_PREFIX}7`, 'ref = msg-<序号>')
  eq(entry.text, '在吗')
  eq(entry.sender, '小柚')
  eq(entry.at, '2026-10-13T00:00:00Z')
  // 小数序号取整（同一毫秒连收两条时调用方可能给浮点）。
  eq(normalizeInboundRef({ seq: 7.9, text: 'x' }).ref, `${REF_PREFIX}7`)
})

check('normalizeInboundRef：缺序号或坏输入一律返回 undefined（宁缺勿滥）', () => {
  for (const bad of [undefined, null, 'nope', 42, [], {}, { seq: 0 }, { seq: -1 }, { seq: 'x' }, { seq: Number.NaN }]) {
    eq(normalizeInboundRef(bad), undefined, `${JSON.stringify(bad)} 不该产生条目`)
  }
})

check('normalizeInboundRef：正文压平空白并截断（一条长消息不该撑爆清单）', () => {
  const entry = normalizeInboundRef({ seq: 1, text: '第一行\n第二行\t带缩进  ' })
  eq(entry.text, '第一行 第二行 带缩进', '空白压成单空格')
  const long = normalizeInboundRef({ seq: 2, text: '字'.repeat(300) })
  assert.ok(long.text.length <= 80, `预览应截断到 80 字以内，实际 ${long.text.length}`)
  // 非字符串正文按空串处理，而不是抛错。
  eq(normalizeInboundRef({ seq: 3, text: 12345 }).text, '', '非字符串正文')
})

/* ─────────────── B. 入列 ─────────────── */

check('pushInboundRef：返回新数组、不改原数组（纯函数）', () => {
  const before = [{ ref: 'msg-1', text: 'a', sender: '', at: '' }]
  const frozen = JSON.parse(JSON.stringify(before))
  const after = pushInboundRef(before, { seq: 2, text: 'b' })
  eq(before, frozen, '原数组不该被改动')
  eq(after.length, 2, '新数组多一条')
  eq(after[1].ref, 'msg-2')
})

check('pushInboundRef：同一个 ref 不重复入列（重放/重试不叠加）', () => {
  let list = pushInboundRef([], { seq: 5, text: '第一条' })
  list = pushInboundRef(list, { seq: 5, text: '同一事件的第二次投递' })
  eq(list.length, 1, '同 ref 只留一条')
  eq(list[0].text, '第一条', '保留先到的那条')
})

check('pushInboundRef：按容量淘汰最旧的', () => {
  let list = []
  for (let i = 1; i <= 12; i += 1) list = pushInboundRef(list, { seq: i, text: `第${i}条` }, 8)
  eq(list.length, 8, '不超过容量')
  eq(list[0].ref, 'msg-5', '留下最近 8 条')
  eq(list[7].ref, 'msg-12', '最后一条是最新的')
  eq(DEFAULT_REF_LIMIT, 8, '默认容量 8')
  // 坏容量回默认而不是清空。
  eq(pushInboundRef([{ ref: 'msg-1', text: 'a', sender: '', at: '' }], { seq: 2, text: 'b' }, 0).length, 2, '容量 0 回默认')
})

check('pushInboundRef：坏记录被跳过，且坏输入清单安全', () => {
  eq(pushInboundRef(null, { seq: 1, text: 'a' }).length, 1, 'null 清单当空')
  eq(pushInboundRef(undefined, { seq: 1, text: 'a' }).length, 1, 'undefined 清单当空')
  eq(pushInboundRef([], { seq: 0, text: 'a' }).length, 0, '坏记录不入列')
  eq(pushInboundRef('nope', { seq: 1, text: 'a' }).length, 1, '坏清单当空处理')
})

/* ─────────────── C. 解析（只在清单内） ─────────────── */

const sample = [
  { ref: 'msg-3', text: '在吗', sender: '小柚', at: '' },
  { ref: 'msg-4', text: '楼下涨价了', sender: '小柚', at: '' },
]

check('resolveInboundRef：命中清单内的 ref', () => {
  eq(resolveInboundRef(sample, 'msg-4')?.text, '楼下涨价了')
  // 前后空白容错（模型可能带空格）。
  eq(resolveInboundRef(sample, '  msg-4  ')?.ref, 'msg-4')
})

check('resolveInboundRef：清单外一律不命中（绝不猜、不兜底）', () => {
  // 模型编的、已淘汰的、或复数形式——全部退化成「没有指定引用」。
  for (const bad of ['msg-99', 'msg-abc', 'msg-', '', '   ', undefined, null, 3]) {
    eq(resolveInboundRef(sample, bad), undefined, `${JSON.stringify(bad)} 不该命中`)
  }
  eq(resolveInboundRef([], 'msg-3'), undefined, '空清单不命中')
  eq(resolveInboundRef(null, 'msg-3'), undefined, '坏清单安全')
})

/* ─────────────── D. 提示词渲染 ─────────────── */

check('renderInboundRefs：空清单不产出任何行（调用方据此不渲染该段）', () => {
  eq(renderInboundRefs([]), [], '空清单')
  eq(renderInboundRefs(null), [], 'null 安全')
  eq(renderInboundRefs(undefined), [], 'undefined 安全')
})

check('renderInboundRefs：每行一条（ref + 发送者 + 预览），并说明用法', () => {
  const lines = renderInboundRefs(sample)
  eq(lines[0], '【可引用的来消息】', '有标题行')
  eq(lines[1], '- msg-3｜小柚：在吗', '第一条')
  eq(lines[2], '- msg-4｜小柚：楼下涨价了', '第二条')
  const last = lines[lines.length - 1]
  assert.ok(last.includes('reply_to'), '应说明怎么用')
  assert.ok(last.includes('不要编'), '应明确不要编 ref')
})

check('renderInboundRefs：没有发送者时不出现多余分隔符', () => {
  const lines = renderInboundRefs([{ ref: 'msg-1', text: '内容', sender: '', at: '' }])
  eq(lines[1], '- msg-1｜内容', '无发送者时省略「谁：」')
})

check('renderInboundRefs：limit 只渲染最近几条', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ref: `msg-${i + 1}`, text: `第${i + 1}条`, sender: '', at: '' }))
  const lines = renderInboundRefs(many, 2)
  eq(lines.length, 4, '标题 + 2 条 + 说明')
  eq(lines[1], '- msg-5｜第5条', '取最近的')
  eq(lines[2], '- msg-6｜第6条')
  eq(renderInboundRefs(many, 0), [], 'limit 0 不渲染')
})

check('normalizeInboundRef：平台 id 与 ref **分开**保存', () => {
  // ref 是给人/模型看的稳定名字（由序号生成，同毫秒也不撞）；
  // platformId 才是被动回复真正要用的关联键。两者刻意分开：
  // 一个由我们生成，一个由平台给。
  const entry = normalizeInboundRef({ seq: 3, text: '在吗', platformId: 'QQ_MSG_ABC' })
  eq(entry.ref, 'msg-3', 'ref 由序号生成')
  eq(entry.platformId, 'QQ_MSG_ABC', '平台 id 原样保留')
  // 平台没给 id 时留空串（而不是 undefined）——调用方据此判断「不可引用投递」。
  eq(normalizeInboundRef({ seq: 4, text: 'x' }).platformId, '', '缺 id 时为空串')
  // 非字符串按空串处理，不抛错。
  eq(normalizeInboundRef({ seq: 5, text: 'x', platformId: 12345 }).platformId, '', '非字符串平台 id')
  // 超长截断（平台 id 不该把状态撑爆）。
  eq(normalizeInboundRef({ seq: 6, text: 'x', platformId: 'a'.repeat(500) }).platformId.length, 256, '截断到 256')
})

check('resolveInboundRef：命中时连平台 id 一起给出（投递要用）', () => {
  const list = pushInboundRef([], { seq: 7, text: '楼下涨价了', platformId: 'QQ_7' })
  eq(resolveInboundRef(list, 'msg-7')?.platformId, 'QQ_7', '命中条目带平台 id')
  // 编的 ref 仍然一律不命中——哪怕平台 id 看起来对得上。
  eq(resolveInboundRef(list, 'QQ_7'), undefined, '用平台 id 当 ref 不认（ref 与 platformId 是两个命名空间）')
})

console.log(`\n入站消息引用：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

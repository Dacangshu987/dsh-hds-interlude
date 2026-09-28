/**
 * QQ 合并转发读取测试（移植自上游 `1.0.1-rc6` 的 `src/forward-message.ts`）。
 *
 * 覆盖：
 *   A. 预算规整（默认 30 / 8000 / 3，夹取范围与上游一致）；
 *   B. 资源 id 提取（元素形态 attrs/data、CQ 码形态、去重、长度上限）；
 *   C. 归一化渲染：节点标题、发送者/QQ 标注、各段文字化、嵌套深度上限、
 *      节点与字符预算触顶后**如实标注截断**；
 *   D. 可注入取数：无 fetcher 退化为占位（不漏裸标记）、fetcher 抛错如实回报、
 *      递归取嵌套、剩余预算受限。
 *
 * 运行：node test/forward-message.test.mjs
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_FORWARD_LIMITS,
  forwardReadLimits,
  extractForwardIds,
  normalizeForwardMessages,
  readForwardContent,
  fetchForwardNodes,
} from '../lib/forward-message.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('合并转发读取（rc6 移植）')

/* ───────────────────────── A. 预算 ───────────────────────── */

await check('预算默认值与夹取（30 / 8000 / 3，范围与上游一致）', () => {
  assert.deepEqual(forwardReadLimits(), DEFAULT_FORWARD_LIMITS)
  assert.deepEqual(forwardReadLimits(undefined), { maxNodes: 30, maxCharacters: 8000, maxDepth: 3 })
  assert.deepEqual(forwardReadLimits({ maxNodes: 0, maxCharacters: 1, maxDepth: 99 }), { maxNodes: 1, maxCharacters: 500, maxDepth: 8 })
  assert.deepEqual(forwardReadLimits({ maxNodes: 999, maxCharacters: 999999, maxDepth: -1 }), { maxNodes: 100, maxCharacters: 32000, maxDepth: 0 })
  // 注意上游 clampInt 的口径：`Number(null) === 0` 是**有限数**，因此 null 走夹取（→ 下限 500）
  // 而不是回退默认值；只有 NaN（如 'x'）才回退。
  assert.deepEqual(forwardReadLimits({ maxNodes: 'x', maxCharacters: null, maxDepth: NaN }), { maxNodes: 30, maxCharacters: 500, maxDepth: 3 })
})

/* ───────────────────────── B. id 提取 ───────────────────────── */

await check('元素形态：attrs / data 里的 id、res_id、forward_id 都能抽到', () => {
  assert.deepEqual(extractForwardIds([{ type: 'forward', data: { id: 'A1' } }]), ['A1'])
  assert.deepEqual(extractForwardIds([{ type: 'forward', attrs: { res_id: 'A2' } }]), ['A2'])
  assert.deepEqual(extractForwardIds([{ type: 'forward', data: { forward_id: 'A3' } }]), ['A3'])
  // 递归到 children（数组与单元素两种形态）
  assert.deepEqual(extractForwardIds([{ type: 'text', children: [[{ type: 'forward', data: { id: 'A4' } }]] }]), ['A4'])
  assert.deepEqual(extractForwardIds([{ type: 'text', children: [{ type: 'forward', data: { id: 'A5' } }] }]), ['A5'])
  // 大小写不敏感
  assert.deepEqual(extractForwardIds([{ type: 'Forward', data: { id: 'A6' } }]), ['A6'])
})

await check('CQ 码形态 + 字符串标签形态 + 去重 + 超长 id 丢弃', () => {
  assert.deepEqual(extractForwardIds('[CQ:forward,id=CQ1]'), ['CQ1'])
  assert.deepEqual(extractForwardIds('[CQ:forward,res_id=CQ2]'), ['CQ2'])
  assert.deepEqual(extractForwardIds('前缀[CQ:forward,id=CQ3]后缀'), ['CQ3'])
  // 字符串里的标签形态（SDK 有时把富文本原文直接给成字符串）
  assert.deepEqual(extractForwardIds('看这个<forward id="T1"/>然后呢'), ['T1'])
  assert.deepEqual(extractForwardIds('<forward res_id="T2"/>'), ['T2'])
  assert.deepEqual(extractForwardIds("<forward forward_id='T3'/>"), ['T3'])
  assert.deepEqual(extractForwardIds('[CQ:forward,id=X][CQ:forward,id=X]<forward id="X"/>'), ['X'], '同一 id 只留一次')
  assert.deepEqual(extractForwardIds(`[CQ:forward,id=${'z'.repeat(600)}]`), [], '超 512 字丢弃')
  assert.deepEqual(extractForwardIds('没有转发'), [])
  assert.deepEqual(extractForwardIds(undefined), [])
})

/* ───────────────────────── C. 归一化渲染 ───────────────────────── */

await check('节点标题与各段文字化（text/at/reply/图片/语音/视频/文件/未知）', () => {
  const out = normalizeForwardMessages([
    { nickname: '小鹿', user_id: 10086, message: [
      { type: 'text', data: { text: '你看这个' } },
      { type: 'at', data: { name: '江柚' } },
      { type: 'reply', data: { id: 'R1' } },
      { type: 'image', data: {} },
      { type: 'record', data: {} },
      { type: 'video', data: {} },
      { type: 'file', data: { name: '报告.pdf' } },
      { type: 'markdown', data: {} },
    ] },
    { sender: { nickname: '阿岚', user_id: 7 }, message: [{ type: 'text', data: { text: '嗯' } }] },
  ])
  assert.ok(out.content.startsWith('[合并转发内容｜节点数 2]'), out.content.slice(0, 40))
  assert.ok(out.content.includes('[节点 1｜小鹿（10086）]'))
  assert.ok(out.content.includes('[节点 2｜阿岚（7）]'))
  assert.ok(out.content.includes('你看这个'))
  assert.ok(out.content.includes('[@江柚]'))
  assert.ok(out.content.includes('[回复消息 R1]'))
  for (const token of ['[图片]', '[语音]', '[视频]', '[文件：报告.pdf]', '[未支持的消息类型：markdown]']) {
    assert.ok(out.content.includes(token), `缺少 ${token}`)
  }
  assert.equal(out.nodeCount, 2)
  assert.equal(out.truncated, false)
})

await check('节点预算：超过 maxNodes 即停并标注截断', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ nickname: `n${i}`, message: [{ type: 'text', data: { text: `m${i}` } }] }))
  const out = normalizeForwardMessages(nodes, { maxNodes: 3 })
  assert.equal(out.nodeCount, 3)
  assert.equal(out.truncated, true)
  assert.ok(out.content.includes('[合并转发内容已按安全预算截断]'))
  assert.ok(!out.content.includes('m3'), '第 4 个节点不该出现')
})

await check('字符预算：超预算即截断并带 [截断] 标注', () => {
  const nodes = [{ nickname: 'n', message: [{ type: 'text', data: { text: 'x'.repeat(2000) } }] }]
  const out = normalizeForwardMessages(nodes, { maxCharacters: 600 })
  assert.ok(out.content.length <= 700, `实际长度 ${out.content.length}`)
  assert.ok(out.content.includes('[截断]'))
  assert.equal(out.truncated, true)
})

await check('嵌套转发：达到深度上限时显式说明（不递归展开）', () => {
  const nodes = [{ nickname: 'n', message: [{ type: 'forward', data: { id: 'N1' } }] }]
  const shallow = normalizeForwardMessages(nodes, { maxDepth: 0 })
  assert.ok(shallow.content.includes('[嵌套合并转发，已达到深度上限｜N1]'))
  assert.equal(shallow.forwardCount, 1)
  const deep = normalizeForwardMessages(nodes, { maxDepth: 3 })
  assert.ok(deep.content.includes('[嵌套合并转发｜资源 N1；需要递归读取]'))
  // 缺资源标识的两种分支各自如实说明
  assert.ok(normalizeForwardMessages([{ message: [{ type: 'forward', data: {} }] }], { maxDepth: 3 }).content.includes('资源标识缺失'))
  assert.ok(normalizeForwardMessages([{ message: [{ type: 'forward', data: {} }] }], { maxDepth: 0 }).content.includes('[嵌套合并转发，已达到深度上限]'))
})

/* ───────────────────────── D. 可注入取数 ───────────────────────── */

await check('无 fetcher → 占位降级且标记 failed（不漏裸标记）', async () => {
  const result = await readForwardContent({ content: '[CQ:forward,id=F1]' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-fetcher')
  assert.deepEqual(result.ids, ['F1'])
  assert.equal(result.failed, true)
  assert.ok(result.content.startsWith('[合并转发内容'), '仍应给出可读占位而不是裸 id')
})

await check('无 id → 直接回报 no-forward-id', async () => {
  const result = await readForwardContent({ content: '普通消息', fetchNodes: async () => [] })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-forward-id')
})

await check('有 fetcher → 读取并归一化；fetcher 抛错如实回报', async () => {
  const ok = await readForwardContent({
    content: [{ type: 'forward', data: { id: 'F2' } }],
    fetchNodes: async (id) => {
      assert.equal(id, 'F2')
      return [{ nickname: '小鹿', user_id: 1, message: [{ type: 'text', data: { text: '在吗' } }] }]
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.nodeCount, 1)
  assert.ok(ok.content.includes('在吗'))

  const bad = await readForwardContent({
    ids: ['F3'],
    fetchNodes: async () => { throw new Error('接口超时') },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, '接口超时')
  assert.equal(bad.failed, true)
})

await check('递归取嵌套节点，且受剩余预算限制', async () => {
  const calls = []
  const fetchNodes = async (id) => {
    calls.push(id)
    if (id === 'TOP') {
      return [{ nickname: 'a', message: [
        { type: 'text', data: { text: '外层' } },
        { type: 'forward', data: { id: 'NEST' } },
      ] }]
    }
    return Array.from({ length: 20 }, (_, i) => ({ nickname: 'b', message: [{ type: 'text', data: { text: `内层${i}` } }] }))
  }
  const nodes = await fetchForwardNodes(fetchNodes, 'TOP', { maxNodes: 30, maxCharacters: 8000, maxDepth: 3 }, 0)
  assert.deepEqual(calls, ['TOP', 'NEST'], '应递归取嵌套')
  assert.ok(nodes.length <= 11, `嵌套最多并入 10 条（实际 ${nodes.length}）`)
  assert.ok(nodes.length > 1, '嵌套内容应被并入')
  // 深度到顶则不递归
  calls.length = 0
  await fetchForwardNodes(fetchNodes, 'TOP', { maxNodes: 30, maxCharacters: 8000, maxDepth: 0 }, 0)
  assert.deepEqual(calls, ['TOP'], '深度为 0 时不该递归')
})

await check('入站清洗：裸转发标记不漏进上下文（带 id 时保留可读标注）', async () => {
  const { sanitizeAttachments } = await import('../lib/qq-im/inbound.js')
  assert.equal(sanitizeAttachments('<forward id="F9"/>'), '[合并转发：F9]')
  assert.equal(sanitizeAttachments('<forward/>'), '[合并转发]')
  assert.equal(sanitizeAttachments('[CQ:forward,id=CQ9]'), '[合并转发：CQ9]')
  assert.equal(sanitizeAttachments('[CQ:forward,res_id=CQ10]'), '[合并转发：CQ10]')
  assert.equal(sanitizeAttachments('看这个<forward id="F1"/>然后呢'), '看这个[合并转发：F1]然后呢')
  // 与其他附件共存时互不干扰
  const mixed = sanitizeAttachments('<img src="http://cdn/x"/><forward id="F2"/><file name="a.pdf"/>')
  assert.equal(mixed, '[图片][合并转发：F2][文件：a.pdf]')
})

/* ───────────────── E. 入站读取回路（占位 → 真实正文） ───────────────── */

await check('applyForwardRead：无转发资源 → 原样返回（零开销）', async () => {
  const { applyForwardRead } = await import('../lib/qq-im/inbound.js')
  let called = false
  const out = await applyForwardRead('普通消息', { content: '普通消息' }, {
    readForward: async () => { called = true; return { ok: true, content: 'x' } },
  })
  assert.equal(out, '普通消息')
  assert.equal(called, false, '没有转发资源就不该调取数通道')
})

await check('applyForwardRead：无通道 → 保留占位并记 debug；读取成功 → 替换占位', async () => {
  const { applyForwardRead } = await import('../lib/qq-im/inbound.js')
  const logs = []
  const message = { content: '看这个<forward id="F1"/>然后呢' }
  const text = '看这个[合并转发：F1]然后呢'
  // ① 无通道
  const kept = await applyForwardRead(text, message, { log: (level, m) => logs.push(`${level}:${m}`) })
  assert.equal(kept, text)
  assert.ok(logs.some((l) => l.startsWith('debug:')), '应记一条 debug')
  // ② 有通道 → 替换（保持位置）
  const replaced = await applyForwardRead(text, message, {
    readForward: async ({ ids, limits }) => {
      assert.deepEqual(ids, ['F1'])
      assert.equal(limits.maxNodes, 30, '应带上默认预算')
      return { ok: true, content: '[合并转发内容｜节点数 1]\n[节点 1｜小鹿（1）]\n在吗' }
    },
  })
  assert.ok(replaced.startsWith('看这个[合并转发内容'), replaced)
  assert.ok(replaced.endsWith('然后呢'), '占位两侧的原文必须保留')
  assert.ok(replaced.includes('在吗'))
})

await check('applyForwardRead：读取失败/抛错 → 保留占位（不阻断回合）', async () => {
  const { applyForwardRead } = await import('../lib/qq-im/inbound.js')
  const message = { content: '<forward id="F2"/>' }
  const text = '[合并转发：F2]'
  const failed = await applyForwardRead(text, message, { readForward: async () => ({ ok: false, error: 'no-fetcher' }) })
  assert.equal(failed, text)
  const threw = await applyForwardRead(text, message, { readForward: async () => { throw new Error('接口超时') } })
  assert.equal(threw, text)
  // 直接返回渲染文本也接受
  const direct = await applyForwardRead(text, message, { readForward: async () => '渲染好的正文' })
  assert.equal(direct, '渲染好的正文')
})

console.log(`\n合并转发读取：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

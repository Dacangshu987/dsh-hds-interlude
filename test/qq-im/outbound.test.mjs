/**
 * outbound.js 的测试：分条、投递记账、部分成功、重试语义。
 */
import assert from 'node:assert/strict'

import {
  splitOutboundText, deliverMessages, resolveChunking, resolveTimeout, buildReceipt, finiteOr,
} from '../../lib/qq-im/outbound.js'

let passed = 0
function check(label, fn) { fn(); passed += 1 }
async function checkAsync(label, fn, timeoutMs = 30000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT: "${label}" 超过 ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    await Promise.race([fn(), timeout]);
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

/* ------------------------------------------------------------ 分条 */

check('按句末标点切条', () => {
  eq(splitOutboundText('在吗？今天好累啊。'), ['在吗？', '今天好累啊。'], '应当按句号问号切开')
})

check('长句按软标点在字数内断开', () => {
  const out = splitOutboundText('今天加班到十点才回家，路上还下雨了，伞也没带。', { maxChars: 12 })
  for (const item of out) {
    assert.ok(item.length <= 12 || out.length === 1, `每条不该超过 12 字：${item}`)
  }
})

check('条数上限：不丢内容，多余的字并进前面的条', () => {
  const out = splitOutboundText('一。二。三。四。五。六。', { maxChars: 50, maxMessages: 2 })
  eq(out.length, 2, '应当压到 2 条')
  // 关键：内容不能丢。
  const joined = out.join('')
  for (const ch of '一二三四五六') {
    assert.ok(joined.includes(ch), `内容不能丢字：缺 ${ch}`)
  }
})

check('空输入不产生消息', () => {
  eq(splitOutboundText(''), [], '空串应当返回空数组')
  eq(splitOutboundText('   '), [], '纯空白应当返回空数组')
  eq(splitOutboundText(undefined), [], 'undefined 应当返回空数组')
})

check('不会把 emoji 劈成两半', () => {
  const out = splitOutboundText('好好好😀😀😀', { maxChars: 4 })
  for (const item of out) {
    // 半个代理对会出现孤立的高/低位。
    assert.ok(!/[\uD800-\uDBFF]$/.test(item), `不该以孤立高位结束：${item}`)
    assert.ok(!/^[\uDC00-\uDFFF]/.test(item), `不该以孤立低位开始：${item}`)
  }
})

/* ------------------------------------------------------------ 投递记账 */

await checkAsync('全部成功 → ok:true 且 sentCount 正确', async () => {
  const sent = []
  const result = await deliverMessages({
    send: async (targetId, text) => { sent.push(text); return { sent: true } },
    targetId: 'USER',
    messages: ['一', '二'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, true, '应当成功')
  eq(result.sentCount, 2, '应当送出 2 条')
  eq(sent, ['一', '二'], '应当按顺序发送')
  eq(result.receipt.ok, true, '回执应当记成功')
})

await checkAsync('第二条失败 → ok:false，sentCount 是已确认条数', async () => {
  let calls = 0
  const result = await deliverMessages({
    send: async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('boom'), { code: 'rate-limited' })
      return { sent: true }
    },
    targetId: 'USER',
    messages: ['一', '二', '三'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, false, '部分失败不该算成功')
  eq(result.sentCount, 1, '应当只确认 1 条')
  eq(result.error, 'rate-limited', '应当带上错误码')
  // 重试语义的支点：remaining 是**原文**，调用方据此重发同一段而不是重新生成。
  eq(result.remaining, ['二', '三'], 'remaining 应当是尚未送出的原文')
})

await checkAsync('静默返回（没有 sent:true）一律当作未确认', async () => {
  const result = await deliverMessages({
    send: async () => ({}), // 服务没有明确确认
    targetId: 'USER',
    messages: ['一'],
    chunking: { minIntervalMs: 0 },
  })
  eq(result.ok, false, '没有明确确认不该算送达')
  eq(result.error, 'delivery-not-confirmed', '应当报未确认')
})

await checkAsync('缺目标 / 缺 send / 空消息都如实回报', async () => {
  const noTarget = await deliverMessages({ send: async () => ({ sent: true }), targetId: '', messages: ['一'] })
  eq(noTarget.error, 'no-target', '缺目标应当报错')

  const noSend = await deliverMessages({ send: undefined, targetId: 'U', messages: ['一'] })
  eq(noSend.error, 'im-unavailable', '缺 send 应当报错')

  const noMessages = await deliverMessages({ send: async () => ({ sent: true }), targetId: 'U', messages: [] })
  eq(noMessages.error, 'no-messages', '空消息应当报错')
})

await checkAsync('已中止的信号 → 不发送', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  const result = await deliverMessages({
    send: async () => { called = true; return { sent: true } },
    targetId: 'U',
    messages: ['一'],
    chunking: { minIntervalMs: 0 },
    signal: controller.signal,
  })
  eq(called, false, '已中止就不该再发')
  eq(result.error, 'cancelled', '应当报取消')
})

/* ------------------------------------------------------------ 配置解析 */

check('resolveChunking 夹到合法范围', () => {
  const cfg = resolveChunking({ maxChars: 9999, maxMessages: 0, minIntervalMs: -5 })
  eq(cfg.maxChars, 500, 'maxChars 应当夹到 500')
  eq(cfg.maxMessages, 1, 'maxMessages 应当夹到 1')
  eq(cfg.minIntervalMs, 0, 'minIntervalMs 应当夹到 0')
})

check('resolveChunking 默认值', () => {
  const cfg = resolveChunking({})
  eq(cfg.maxChars, 40, '默认 40 字')
  eq(cfg.maxMessages, 4, '默认 4 条')
  eq(cfg.enabled, true, '默认启用分条')
})

check('finiteOr 把 0 当合法值', () => {
  eq(finiteOr(0, 99), 0, '0 是合法值')
  eq(finiteOr(undefined, 99), 99, 'undefined 用默认')
  eq(finiteOr('abc', 99), 99, '非数字用默认')
})

check('resolveTimeout 夹到 1s~120s', () => {
  eq(resolveTimeout({ timeoutMs: 10 }), 1000, '下限 1 秒')
  eq(resolveTimeout({ timeoutMs: 999_999 }), 120_000, '上限 120 秒')
})

check('buildReceipt 形状正确', () => {
  const receipt = buildReceipt({ ok: true, sentCount: 2, total: 2 }, { targetId: 'U' })
  eq(receipt.ok, true, 'ok 应当透传')
  eq(receipt.sentCount, 2, 'sentCount 应当透传')
  eq(receipt.targetId, 'U', '附加字段应当合并')
})

console.log(`outbound.test.mjs：${passed} 项通过`)

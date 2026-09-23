/**
 * IM 分条器测试 —— 覆盖「一条一条发」真正会出问题的地方：
 * 旁白别漏出去、每条别太长、条数别超、内容别丢。
 *
 * 运行：node test/im.test.mjs
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import {
  cleanImText, splitImText, resolveImChunking, resolveImBinding, deliverImChunks, resolveImService,
} from '../lib/im.js'

let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

async function testAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

/* --------------------------------------------------------------- 清理 */

test('cleanImText：整行旁白被剔除', () => {
  const input = '（把手机往桌上一扣，忍了两分钟）\n在吗\n（盯着屏幕看了三秒）'
  assert.equal(cleanImText(input), '在吗')
})

test('cleanImText：行内旁白被剔除', () => {
  assert.equal(cleanImText('今天累死了（其实也没那么累）'), '今天累死了')
})

test('cleanImText：*动作* 被剔除', () => {
  assert.equal(cleanImText('*伸了个懒腰* 醒了'), '醒了')
})

test('cleanImText：星号动作在句中也不留残渣', () => {
  assert.equal(cleanImText('我*刚刚*才到家'), '我才到家')
})

test('cleanImText：Markdown 标记被清掉', () => {
  assert.equal(cleanImText('## 标题\n**很累**\n- 一条'), '标题\n很累\n一条')
})

test('cleanImText：代码块整体丢弃', () => {
  assert.equal(cleanImText('看这个\n```js\nconst a = 1\n```\n好了'), '看这个\n好了')
})

test('cleanImText：成对引号外壳被剥掉', () => {
  assert.equal(cleanImText('“我到家了”'), '我到家了')
})

test('cleanImText：分隔线丢弃', () => {
  assert.equal(cleanImText('说完了\n---\n就这样'), '说完了\n就这样')
})

test('cleanImText：纯旁白输入返回空串（表示不该发）', () => {
  assert.equal(cleanImText('（她沉默了很久，不知道该说什么）'), '')
})

test('cleanImText：正常内容原样保留', () => {
  assert.equal(cleanImText('今天不想加班\n周报还差一半'), '今天不想加班\n周报还差一半')
})

/* --------------------------------------------------------------- 分条 */

test('splitImText：短句各自成条', () => {
  const text = '在吗\n我摸鱼呢\n楼下那家面馆涨价了'
  assert.deepEqual(splitImText(text), ['在吗', '我摸鱼呢', '楼下那家面馆涨价了'])
})

test('splitImText：长行按句号切', () => {
  const text = '今天真的累死了。周报改了六遍。王姐还说我不够细。'
  assert.deepEqual(splitImText(text), ['今天真的累死了。', '周报改了六遍。', '王姐还说我不够细。'])
})

test('splitImText：旁白不进结果', () => {
  const text = '（看了眼手机）\n你晚上干嘛\n（其实想让他打电话）'
  assert.deepEqual(splitImText(text), ['你晚上干嘛'])
})

test('splitImText：每条不超过 maxChars', () => {
  const text = '这是一句非常长的话'.repeat(6)
  const out = splitImText(text, { maxChars: 10, maxMessages: 99 })
  assert.ok(out.length > 1, '应该被拆开')
  for (const message of out) {
    assert.ok(message.length <= 10, `「${message}」长度 ${message.length} 超过 10`)
  }
})

test('splitImText：maxChars 内优先在逗号处断', () => {
  const out = splitImText('今天天气不错，我下楼走了两圈，顺便买了瓶水', { maxChars: 12, maxMessages: 99 })
  for (const message of out) {
    assert.ok(message.length <= 12, `「${message}」超长`)
    assert.ok(!message.startsWith('，'), `「${message}」以逗号开头`)
  }
})

test('splitImText：超出 maxMessages 时合并而不是丢弃', () => {
  const text = '一\n二\n三\n四\n五\n六'
  const out = splitImText(text, { maxMessages: 3 })
  assert.equal(out.length, 3)
  const joined = out.join('')
  for (const piece of ['一', '二', '三', '四', '五', '六']) {
    assert.ok(joined.includes(piece), `丢失了「${piece}」`)
  }
})

test('splitImText：默认 maxMessages=4 上限生效', () => {
  const out = splitImText('一\n二\n三\n四\n五\n六\n七\n八')
  assert.ok(out.length <= 4, `实际 ${out.length} 条`)
})

test('splitImText：空输入与纯空白返回空数组', () => {
  assert.deepEqual(splitImText(''), [])
  assert.deepEqual(splitImText('   \n  \n'), [])
  assert.deepEqual(splitImText(null), [])
})

test('splitImText：超长无标点文本仍能切分', () => {
  const out = splitImText('啊'.repeat(100), { maxChars: 15, maxMessages: 9 })
  assert.ok(out.length > 1)
  for (const message of out) assert.ok(message.length <= 15)
})

test('splitImText：emoji 不会被切坏（不产生孤立代理项）', () => {
  const out = splitImText('今天好开心😀😀😀真的', { maxChars: 5, maxMessages: 9 })
  for (const message of out) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(message), '出现了孤立的高位代理项')
    assert.ok(!/^[\uDC00-\uDFFF]/.test(message), '出现了孤立的低位代理项')
  }
})

/* ----------------------------------------------------------- 配置解析 */

test('resolveImChunking：缺省值', () => {
  assert.deepEqual(resolveImChunking({}), { maxChars: 40, maxMessages: 4, minIntervalMs: 400 })
})

test('resolveImChunking：越界被夹紧', () => {
  const resolved = resolveImChunking({ chunking: { maxChars: 99999, maxMessages: 0, minIntervalMs: -5 } })
  assert.equal(resolved.maxChars, 500)
  assert.equal(resolved.maxMessages, 1)
  assert.equal(resolved.minIntervalMs, 0)
})

test('resolveImBinding：会话绑定优先于配置', () => {
  const binding = resolveImBinding(
    { imBinding: { botId: 'b1', targetId: 't1' } },
    { im: { enabled: true, botId: 'b2', targetId: 't2' } },
  )
  assert.deepEqual(binding, { botId: 'b1', targetId: 't1', source: 'session' })
})

test('resolveImBinding：未启用配置时不再回退到配置值', () => {
  assert.equal(resolveImBinding({}, { im: { enabled: false, botId: 'b', targetId: 't' } }), undefined)
})

test('resolveImBinding：都没有时返回 undefined', () => {
  assert.equal(resolveImBinding({}, { im: {} }), undefined)
  assert.equal(resolveImBinding({}, {}), undefined)
})

/* --------------------------------------------------------------- 投递 */

await testAsync('deliverImChunks：逐条发送且条数正确', async () => {
  const calls = []
  const result = await deliverImChunks({
    service: { send: async (botId, targetId, text) => { calls.push([botId, targetId, text]); return { sent: true } } },
    binding: { botId: 'b', targetId: 't' },
    messages: ['一', '二', '三'],
    chunking: { minIntervalMs: 0 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.sentCount, 3)
  assert.deepEqual(calls, [['b', 't', '一'], ['b', 't', '二'], ['b', 't', '三']])
})

await testAsync('deliverImChunks：中途失败即停并如实报告', async () => {
  let count = 0
  const result = await deliverImChunks({
    service: {
      send: async () => {
        count += 1
        if (count === 2) { const error = new Error('boom'); error.code = 'delivery-failed'; throw error }
        return { sent: true }
      },
    },
    binding: { botId: 'b', targetId: 't' },
    messages: ['一', '二', '三'],
    chunking: { minIntervalMs: 0 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.sentCount, 1, '只应记录已成功的那一条')
  assert.equal(result.error, 'delivery-failed')
  assert.equal(count, 2, '失败后不应继续发送第三条')
})

await testAsync('deliverImChunks：sent!==true 视为未确认', async () => {
  const result = await deliverImChunks({
    service: { send: async () => ({ sent: false }) },
    binding: { botId: 'b', targetId: 't' },
    messages: ['一'],
    chunking: { minIntervalMs: 0 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'delivery-not-confirmed')
})

await testAsync('deliverImChunks：投递服务缺失时报错而不抛异常', async () => {
  const result = await deliverImChunks({
    service: undefined, binding: { botId: 'b', targetId: 't' }, messages: ['一'], chunking: {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dsh-im-unavailable')
})

await testAsync('deliverImChunks：空消息列表不算成功', async () => {
  const result = await deliverImChunks({
    service: { send: async () => ({ sent: true }) },
    binding: { botId: 'b', targetId: 't' }, messages: [], chunking: {},
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-messages')
})

await testAsync('deliverImChunks：条间间隔真的生效', async () => {
  const stamps = []
  await deliverImChunks({
    service: { send: async () => { stamps.push(Date.now()); return { sent: true } } },
    binding: { botId: 'b', targetId: 't' },
    messages: ['一', '二'],
    chunking: { minIntervalMs: 120 },
  })
  assert.ok(stamps[1] - stamps[0] >= 100, `间隔只有 ${stamps[1] - stamps[0]}ms`)
})

/* ------------------------------------------------------------ 端到端 */

test('端到端：模型典型输出 → 可直接发送的短消息', () => {
  const modelOutput = [
    '（把耳机摘了，靠在地铁门边上）',
    '"在吗"',
    '',
    '（等了两分钟）',
    '',
    '"我摸鱼跟你说句话 别揭发我"',
    '"楼下那家面馆涨价了 一碗小馄饨从12变15"',
    '"就离谱"',
  ].join('\n')

  const out = splitImText(modelOutput)
  assert.deepEqual(out, [
    '在吗',
    '我摸鱼跟你说句话 别揭发我',
    '楼下那家面馆涨价了 一碗小馄饨从12变15',
    '就离谱',
  ])
  for (const message of out) {
    assert.ok(!message.includes('（'), `漏出旁白：${message}`)
    assert.ok(!message.includes('"'), `漏出引号：${message}`)
  }
})

/* ------------------------------------------------ 服务访问：跨作用域必须走 get() */

/**
 * 线上真实故障（session-xxx）：
 * dsh-im 明明加载着、QQ 消息收得到，插件却报「dsh-im 未加载」，
 * 到点的提醒全部退回被动分支、只留在 DSH 里发不出去。
 *
 * 根因：dsh-im 在**它自己的 ctx** 上 `provide('dshIm', …)`，
 * 而 `ctx.dshIm` 属性访问只认本插件自己 inject 过的服务名 —— 对本插件**永远抛错**。
 * 正确读法是 `ctx.get('dshIm')`（查 root 的 isolate 注册表，跨兄弟作用域有效）。
 */
console.log('\nIM 服务访问（跨 ctx 作用域）')
await testAsync('dsh-im 在兄弟 ctx 注册时，resolveImService 仍能拿到', async () => {
  const root = new Context()
  root.provide('agents', { get: () => undefined })
  // 模拟 dsh-im：在**自己的** ctx 上 provide
  root.plugin({ name: 'im', inject: [], apply(c) { c.provide('dshIm', { send: () => {} }) } })

  let seen
  root.plugin({
    name: 'reader',
    inject: ['agents'],
    apply(c) { setTimeout(() => { seen = resolveImService(c) }, 60) },
  })
  await new Promise(r => setTimeout(r, 200))

  assert.ok(seen, '应能拿到服务——这正是线上发不出去的原因')
  assert.equal(typeof seen.send, 'function')
  await root.stop?.()
})

await testAsync('属性访问 ctx.dshIm 在这种情形下确实会抛（记录这条 Cordis 语义）', async () => {
  const root = new Context()
  root.provide('agents', { get: () => undefined })
  root.plugin({ name: 'im', inject: [], apply(c) { c.provide('dshIm', { send: () => {} }) } })

  let propResult
  root.plugin({
    name: 'reader',
    inject: ['agents'],
    apply(c) {
      setTimeout(() => {
        try { propResult = typeof c.dshIm?.send } catch (e) { propResult = 'THREW' }
      }, 60)
    },
  })
  await new Promise(r => setTimeout(r, 200))
  assert.equal(propResult, 'THREW', '若这里变成 function，说明 Cordis 语义变了，注释需要更新')
  await root.stop?.()
})

await testAsync('没有 dsh-im 时返回 undefined，且不抛错', async () => {
  const root = new Context()
  root.provide('agents', { get: () => undefined })
  let v
  root.plugin({ name: 'reader', inject: ['agents'], apply(c) { v = resolveImService(c) } })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(v, undefined)
  await root.stop?.()
})

await testAsync('服务晚到（启动那一瞬还没有）不抛错，之后能拿到', async () => {
  const root = new Context()
  root.provide('agents', { get: () => undefined })
  let early = 'unset'
  let later
  root.plugin({ name: 'reader', inject: ['agents'], apply(c) {
    early = resolveImService(c)
    setTimeout(() => { later = resolveImService(c) }, 150)
  } })
  root.plugin({ name: 'im', inject: [], apply(c) { setTimeout(() => c.provide('dshIm', { send: () => {} }), 60) } })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(early, undefined, '启动那一瞬拿不到是正常的，但绝不能抛错')
  assert.ok(later, '服务就绪后必须能拿到——到点投递发生在几分钟之后')
  await root.stop?.()
})

console.log(`\nIM 分条：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exitCode = 1


/**
 * 群聊三项修复的验证：
 *   ① **认识人**：SDK 事件归一后，不同群成员能被区分（而不是都叫「对方」）；
 *   ② **意愿判定**：关掉 mentionOnly 后，不是每条群消息都触发；
 *   ③ **冷却**：距上次发言不足间隔时不回；被 @ 仍回。
 *
 * 用真插件的路由函数 + 真意愿层跑，把「一条群消息最终会不会唤起角色」摆出来。
 *
 * 运行：node test/verify-group-chat.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { caseDir } from './helpers/tmp.mjs'

const HOME = caseDir('group-verify')
process.env.DSH_HOME = HOME

const { normalizeInboundMessage, fallbackSenderName } = await import('../lib/qq-im/normalize.js')
const { renderInboundText, routeInbound } = await import('../lib/qq-im/inbound.js')
const { BindingStore } = await import('../lib/qq-im/binding.js')
const { GroupWillingnessStore, evaluateGroupWillingness, resolveGroupWillingness } = await import('../lib/group-willingness.js')

let passed = 0
let failed = 0
function step(label, ok, detail = '') {
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `\n      ${detail}` : ''}`)
}

const GROUP = 'G123456'
const CONV = `group:${GROUP}`
const T0 = 1_800_000_000_000

console.log('群聊三项修复验证\n')

/* ============================================ ① 认识人 */

console.log('【①】群聊认识人（SDK 事件归一）')

const alice = normalizeInboundMessage({
  id: 'm1', content: '晚上一起吃饭吗', group_openid: GROUP,
  author: { member_openid: 'ALICE00112233' },
})
const bob = normalizeInboundMessage({
  id: 'm2', content: '我也去', group_openid: GROUP,
  author: { member_openid: 'BOBBY44556677', username: '小明' },
})
const carol = normalizeInboundMessage({
  id: 'm3', content: '算我一个', group_openid: GROUP,
  author: { member_openid: 'CAROL88990011' },
})

step('SDK 的 member_openid 被映射成 senderId', alice?.senderId === 'ALICE00112233', `senderId=${alice?.senderId}`)
step('SDK 没给昵称时造出可区分的称呼', alice?.senderName === '群友2233', `senderName=${alice?.senderName}`)
step('SDK 给了昵称就用真实昵称', bob?.senderName === '小明', `senderName=${bob?.senderName}`)

const lines = [alice, bob, carol].map((m) => renderInboundText(m))
lines.forEach((l) => console.log(`      → ${l}`))
step('三个人长得不一样（修复前都叫「对方」）',
  new Set(lines.map((l) => l.split('（')[0])).size === 3,
  `实际 ${new Set(lines.map((l) => l.split('（')[0])).size} 种称呼`)
step('群聊标明来源为「来自 QQ 群」', lines.every((l) => l.includes('来自 QQ 群')))
step('机器人自己发的消息被识别（不该当用户输入）',
  normalizeInboundMessage({ id: 'x', content: 'hi', group_openid: GROUP, author: { member_openid: 'SELF' } }, { botSelfId: 'SELF' })?.fromSelf === true)
step('私聊（SDK 无 username 字段）也能兜底区分', (() => {
  const c = normalizeInboundMessage({ id: 'y', content: '你好', author: { user_openid: 'USERXX998877' } })
  return c?.senderName === '对方8877'
})(), '')
step('无法识别的事件返回 undefined（不猜）', normalizeInboundMessage({ foo: 1 }) === undefined)

/* ============================================ ② 意愿判定 */

console.log('\n【②】群聊发言意愿（关掉 @门控 后不再每条都回）')

const bindings = new BindingStore({ home: HOME })
bindings.set({ conversationKey: CONV, sessionId: 'session-group', botId: 'qq_bot', name: '群角色' })

const groupConfig = {
  group: { enabled: true, mentionOnly: false, willingness: { enabled: true, threshold: 0.24, baseGain: 0.12, minReplyIntervalSeconds: 120 } },
  botId: 'qq_bot',
}
const store = new GroupWillingnessStore()
const willAdapter = {
  evaluate: ({ key, mentionedBot, content, quotedBot, messageCount, now }) => {
    const cfg = resolveGroupWillingness(groupConfig.group.willingness)
    const d = evaluateGroupWillingness(store.stateOf(key), cfg, {
      now, messageCount, content, quotedBot, mentionedBot, lastReplyAt: store.lastReplyOf(key),
    })
    store.setState(key, d.state)
    return d
  },
}
const groupMsg = (content, extra = {}) => normalizeInboundMessage({
  id: `g${Math.random()}`, content, group_openid: GROUP,
  author: { member_openid: 'ALICE00112233' }, ...extra,
})

/** 跑一条群消息，返回路由结果。 */
function routeOne(msg, now) {
  return routeInbound({
    message: msg,
    bindings,
    config: { ...groupConfig, now },
    hasSessionLookup: true,
    willingness: willAdapter,
  })
}

// 连发 10 条普通群消息（没人 @ 机器人）。
const outcomes = []
for (let i = 0; i < 10; i += 1) {
  const r = routeOne(groupMsg(`随便聊聊第 ${i} 句`), T0 + i * 1000)
  outcomes.push(r.action === 'deliver' ? 'regard' : r.reason)
}
const triggered = outcomes.filter((o) => o === 'regard').length
console.log(`      10 条普通消息 → 触发 ${triggered} 次：${JSON.stringify(outcomes)}`)
step('不是每条都触发（10 条里明显少于 10 次）', triggered < 10,
  `触发了 ${triggered} 次`)
step('被拦住时给出可读原因（不是笼统 ignore）',
  outcomes.some((o) => String(o).startsWith('group-willingness-')),
  outcomes.find((o) => String(o).startsWith('group-willingness-')) ?? '(无)')

// @ 机器人：必须回。
const mentioned = routeOne(groupMsg('@机器人 在吗', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), T0 + 20_000)
step('@ 机器人时强制放行（绕过意愿与冷却）', mentioned.action === 'deliver',
  `action=${mentioned.action} reason=${mentioned.reason ?? '—'}`)

/* ============================================ ③ 冷却 */

console.log('\n【③】冷却：多少时间内限制回复')

// 记一次发言（进入冷却）。
const cfg = resolveGroupWillingness(groupConfig.group.willingness)
store.noteReply(CONV, cfg, T0 + 30_000)
step('刚发过言 → 冷却期内不回', (() => {
  const r = routeOne(groupMsg('又有人说话'), T0 + 31_000)
  return r.action !== 'deliver' && String(r.reason).includes('cooldown')
})(), (() => {
  const r = routeOne(groupMsg('又有人说话'), T0 + 31_000)
  return `reason=${r.reason}`
})())
step('过了冷却 → 恢复判定', (() => {
  const r = routeOne(groupMsg('过了两分钟'), T0 + 30_000 + 121_000)
  return r.action === 'deliver' || !String(r.reason).includes('cooldown')
})())
step('冷却期内被 @ 仍然回', (() => {
  store.noteReply(CONV, cfg, T0 + 200_000)
  const r = routeOne(groupMsg('@机器人', { rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), T0 + 201_000)
  return r.action === 'deliver'
})())

/* ============================================ 关闭时行为不变 */

console.log('\n【④】未开启意愿时行为与之前一致')
step('willingness 关闭 → 每条都放行（不引入额外门槛）', (() => {
  const offBindings = new BindingStore({ home: caseDir('group-off') })
  offBindings.set({ conversationKey: CONV, sessionId: 'session-group', botId: 'qq_bot', name: '群角色' })
  const r = routeInbound({
    message: groupMsg('普通消息'),
    bindings: offBindings,
    config: { group: { enabled: true, mentionOnly: false }, botId: 'qq_bot', now: T0 },
    hasSessionLookup: true,
  })
  return r.action === 'deliver'
})())
step('mentionOnly 默认开启时，未 @ 的消息仍被 @门控 拦下', (() => {
  const r = routeInbound({
    message: groupMsg('没 @ 机器人'),
    bindings,
    config: { group: { enabled: true }, botId: 'qq_bot', now: T0 },
    hasSessionLookup: true,
  })
  return r.action === 'ignore' && r.reason === 'group-not-mentioned'
})())

console.log(`\n验证结束：${passed} 项符合预期，${failed} 项不符合`)
fs.rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

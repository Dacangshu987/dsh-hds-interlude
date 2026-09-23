/**
 * inbound.js 的测试：幂等、TTL、路由决策。
 */
import assert from 'node:assert/strict'

import {
  DedupeWindow, routeInbound, renderInboundText, handleInbound, DEDUPE_DEFAULTS, isGroupMention,
} from '../../lib/qq-im/inbound.js'
import { BindingStore } from '../../lib/qq-im/binding.js'
import { caseDir } from '../helpers/tmp.mjs'

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

/** 一个临时的绑定表（不污染真实数据）。 */
function tempStore(suffix = 'inbound') {
  return new BindingStore({ home: caseDir(`inbound-${suffix}`) })
}

/* ------------------------------------------------------------ 幂等窗口 */

check('首次见到 → true，第二次 → false', () => {
  const w = new DedupeWindow({ ttlMs: 60_000 })
  eq(w.accept('m1'), true, '首次应当放行')
  eq(w.accept('m1'), false, '重复应当拦下')
  eq(w.accept('m2'), true, '不同 id 应当放行')
})

check('超过 TTL 后同一条可以再次通过', () => {
  let now = 0
  const w = new DedupeWindow({ ttlMs: 1000, now: () => now })
  eq(w.accept('m1'), true, '首次放行')
  now = 500
  eq(w.accept('m1'), false, 'TTL 内重复拦下')
  now = 1500
  eq(w.accept('m1'), true, 'TTL 之后应当放行（消息 id 不会复用，这里只是防内存泄漏）')
})

check('没有 messageId 时放行（不猜）', () => {
  const w = new DedupeWindow()
  eq(w.accept(undefined), true, '没有 id 无法去重，应当放行而不是丢掉真消息')
  eq(w.accept(''), true, '空 id 同上')
})

check('容量上限：超出后淘汰最旧的', () => {
  const w = new DedupeWindow({ ttlMs: 60_000, maxEntries: 3 })
  for (const id of ['a', 'b', 'c', 'd']) w.accept(id)
  assert.ok(w.size() <= 3, `条目数不该超过上限：${w.size()}`)
})

check('DEDUPE_DEFAULTS 导出合理', () => {
  eq(DEDUPE_DEFAULTS.ttlMs, 10 * 60_000, '默认 10 分钟')
  eq(DEDUPE_DEFAULTS.maxEntries, 2000, '默认 2000 条')
})

/* ------------------------------------------------------------ 路由 */

check('已绑定会话 → deliver', () => {
  const store = tempStore('route1')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: {},
  })
  eq(route.action, 'deliver', '应当投递到已绑定会话')
  eq(route.sessionId, 'sess-1', '应当带上会话 id')
})

check('未绑定 + autoCreateSession → create', () => {
  const store = tempStore('route2')
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'NEW', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: true },
  })
  eq(route.action, 'create', '应当自动新建')
})

check('未绑定 + 不自动新建 → ignore', () => {
  const store = tempStore('route3')
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'NEW', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: false },
  })
  eq(route.action, 'ignore', '不自动新建时应当忽略')
  eq(route.reason, 'unbound', '原因应当是未绑定')
})

check('群聊默认忽略', () => {
  const store = tempStore('route4')
  const route = routeInbound({
    message: { kind: 'group', senderId: 'U1', groupOpenid: 'G1', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: true },
  })
  eq(route.action, 'ignore', '群聊默认不该收')
  eq(route.conversationKey, 'group:G1', '会话键应当用群 openid')
})

check('群聊显式开启 + @机器人 → 投递（mentionOnly 默认开）', () => {
  const store = tempStore('route5')
  store.set({ conversationKey: 'group:G1', sessionId: 'sess-g', botId: 'qq' })
  const route = routeInbound({
    message: {
      kind: 'group', senderId: 'U1', groupOpenid: 'G1', messageId: 'm1',
      mentions: [{ is_you: true }],
    },
    bindings: store,
    config: { group: { enabled: true } },
  })
  eq(route.action, 'deliver', '开启且 @ 后群聊应当投递')
  eq(route.sessionId, 'sess-g', '应当路由到群会话')
})

check('群聊开启但未 @机器人 → 忽略（mentionOnly 默认开）', () => {
  const store = tempStore('route5b')
  store.set({ conversationKey: 'group:G1', sessionId: 'sess-g', botId: 'qq' })
  const route = routeInbound({
    message: { kind: 'group', senderId: 'U1', groupOpenid: 'G1', messageId: 'm1' },
    bindings: store,
    config: { group: { enabled: true } },
  })
  eq(route.action, 'ignore', '未 @ 时应忽略')
  eq(route.reason, 'group-not-mentioned', '原因应为未提及机器人')
})

check('群聊开启 + mentionOnly:false → 未 @ 也投递', () => {
  const store = tempStore('route5c')
  store.set({ conversationKey: 'group:G1', sessionId: 'sess-g', botId: 'qq' })
  const route = routeInbound({
    message: { kind: 'group', senderId: 'U1', groupOpenid: 'G1', messageId: 'm1' },
    bindings: store,
    config: { group: { enabled: true, mentionOnly: false } },
  })
  eq(route.action, 'deliver', '关闭 @ 门控后未 @ 也投递')
})

check('群聊开启 + 未绑定 + 被 @ + autoCreate → 为该群建会话', () => {
  const store = tempStore('route5d')
  const route = routeInbound({
    message: {
      kind: 'group', senderId: 'U1', groupOpenid: 'G1', messageId: 'm1',
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    },
    bindings: store,
    config: { group: { enabled: true }, autoCreateSession: true },
  })
  eq(route.action, 'create', '被 @ 且未绑定时应为群建会话')
  eq(route.conversationKey, 'group:G1', '会话键应为群 openid')
})

check('isGroupMention 三信号判定（事件 / is_you / 内容里的 <@!appId>）', () => {
  eq(isGroupMention({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), true, 'QQ 权威事件算 @')
  eq(isGroupMention({ kind: 'group', mentions: [{ is_you: true }] }), true, 'is_you 算 @')
  eq(isGroupMention({ kind: 'group', content: '<@!1234567>你好' }, { appId: '1234567' }), true, '内容里的 appId 兜底算 @')
  eq(isGroupMention({ kind: 'group', content: '你好' }, { appId: '1234567' }), false, '没 @ 不算')
  eq(isGroupMention({ kind: 'group', mentions: [{ member_openid: 'x' }] }), false, '@了别人不算')
})

check('isGroupMention 按人设名识别「@角色名」文本提到（mentionNames 第 4 信号）', () => {
  eq(isGroupMention({ kind: 'group', content: '@江柚 你好' }, { mentionNames: ['江柚'] }), true, '以 @角色名 开头算')
  eq(isGroupMention({ kind: 'group', content: '@江柚在吗' }, { mentionNames: ['江柚'] }), true, '@角色名后直接接话也算')
  eq(isGroupMention({ kind: 'group', content: '  @江柚 下午好' }, { mentionNames: ['江柚'] }), true, '前导空白后 @ 算')
  eq(isGroupMention({ kind: 'group', content: '@阿澈 在吗' }, { mentionNames: ['江柚'] }), false, '@别人不算')
  eq(isGroupMention({ kind: 'group', content: '你好 @江柚' }, { mentionNames: ['江柚'] }), false, '@ 不在开头不算（避免误伤群里闲聊）')
  eq(isGroupMention({ kind: 'group', content: '@江 在吗' }, { mentionNames: ['江柚'] }), false, '前缀不完整不算')
})

check('renderInboundText：群聊来源前缀「来自 QQ 群」并去掉 @ 标记', () => {
  const text = renderInboundText({
    kind: 'group',
    senderName: '小明',
    content: '<@!3859577528758149125>在吗，江柚',
  })
  eq(text, '小明（来自 QQ 群）：在吗，江柚', '应去 @ 标记并标注 QQ 群来源')
})

check('没有 peer id → ignore', () => {
  const store = tempStore('route6')
  const route = routeInbound({ message: { kind: 'c2c' }, bindings: store, config: {} })
  eq(route.action, 'ignore', '没有来源应当忽略')
  eq(route.reason, 'no-peer-id', '原因应当是缺 peer id')
})

check('绑定属于旧 bot → 仍然投递（不因换机器人丢掉角色会话）', () => {
  // 绑定指向的是「和谁说话」的角色会话（name 就是角色名），换机器人
  // 不该把它丢掉。会话真的不可恢复时，由 handleInbound 的 no-agent
  // 兜底重建（见后面的用例），而不是在路由层就丢弃。
  const store = tempStore('route-stale')
  store.set({
    conversationKey: 'c2c:U1',
    sessionId: 'session-old-stale',
    botId: 'qq_3f66e09b0b914aaf77304dba',
  })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: true, botId: 'qq' },
  })
  eq(route.action, 'deliver', '有绑定就投递（优先复用角色会话）')
  eq(route.sessionId, 'session-old-stale', '应当投递到绑定里的会话')
})

check('绑定 botId 为空（无归属信息）→ 照常投递', () => {
  const store = tempStore('route-nobotid')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1' })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: true, botId: 'qq' },
  })
  eq(route.action, 'deliver', '没有 botId 的旧绑定不知道归属，按既有行为投递')
})

/* ------------------------------------------------------------ 白名单（per-bot） */

check('白名单：不在列表的用户忽略（not-whitelisted），不建会话不注入', () => {
  const store = tempStore('wl1')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U2', messageId: 'm1' },
    bindings: store,
    config: { whitelist: ['U1'], autoCreateSession: true },
  })
  eq(route.action, 'ignore', '非白名单用户应忽略')
  eq(route.reason, 'not-whitelisted', '原因指明白名单')
})

check('白名单：列表内用户正常路由', () => {
  const store = tempStore('wl2')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: { whitelist: ['U1'] },
  })
  eq(route.action, 'deliver', '白名单内用户照常投递')
})

check('白名单为空数组 → 不限制', () => {
  const store = tempStore('wl3')
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U9', messageId: 'm1' },
    bindings: store,
    config: { whitelist: [], autoCreateSession: true },
  })
  eq(route.action, 'create', '空白名单等同不限制')
})

check('未配置 whitelist 字段 → 不限制', () => {
  const store = tempStore('wl4')
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U9', messageId: 'm1' },
    bindings: store,
    config: { autoCreateSession: true },
  })
  eq(route.action, 'create', '无 whitelist 字段等同不限制')
})

/* ------------------------------------------------------------ 正文渲染 */

check('剥掉 QQ 的 @ 标记', () => {
  eq(renderInboundText({ senderName: '江柚', content: '<@!123456> 在吗' }, { includeSource: false }), '在吗', '应当剥掉 @ 标记')
})

check('加来源前缀', () => {
  eq(renderInboundText({ senderName: '江柚', content: '在吗' }), '江柚（来自 QQ）：在吗', '应当带来源')
})

check('空内容返回空串', () => {
  eq(renderInboundText({ content: '   ' }), '', '纯空白应当返回空串')
  eq(renderInboundText({ content: '<@!123>' }), '', '只有 @ 标记应当返回空串')
})

/* ------------------------------------------------------------ 端到端 */

await checkAsync('重复消息只注入一次', async () => {
  const store = tempStore('e2e1')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const dedupe = new DedupeWindow({ ttlMs: 60_000 })
  let injected = 0
  const run = () => handleInbound({
    message: { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'SAME' },
    dedupe, bindings: store, config: {},
    resolveAgent: async () => ({ inject: () => { injected += 1 } }),
    inject: (agent) => { agent.inject(); return true },
  })
  const first = await run()
  const second = await run()
  eq(first.status, 'delivered', '首次应当投递')
  eq(second.status, 'duplicate', '第二次应当是重复')
  eq(injected, 1, '只该注入一次')
})

await checkAsync('找不到会话时如实报错，不假装送达', async () => {
  const store = tempStore('e2e2')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-gone', botId: 'qq' })
  const result = await handleInbound({
    message: { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' },
    dedupe: new DedupeWindow(), bindings: store, config: {},
    resolveAgent: async () => undefined,
    inject: () => true,
  })
  eq(result.status, 'error', '找不到会话应当是错误')
  eq(result.reason, 'no-agent', '原因应当是 no-agent')
})

await checkAsync('no-agent + 自动新建开启 → 删旧绑定、重建并投递（线上事故的恢复路径）', async () => {
  // 线上症状：绑定指向旧 bot 的会话（session-gone 恢复不了）→ 每次都 no-agent。
  // 修复：autoCreateSession 开启时，删除失效绑定、重建新会话并把消息接住。
  const store = tempStore('e2e-stale')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'session-gone', botId: 'qq_oldbot' })
  let recreated = 0
  const result = await handleInbound({
    message: { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' },
    dedupe: new DedupeWindow(), bindings: store,
    config: { autoCreateSession: true },
    resolveAgent: async () => undefined,
    createSession: async () => { recreated += 1; return 'sess-fresh' },
    inject: () => true,
  })
  eq(result.status, 'delivered', '重建后应视为已投递')
  eq(result.sessionId, 'sess-fresh', '应当返回新会话 id')
  eq(recreated, 1, '应重建一次会话')
  eq(store.get('c2c:U1')?.sessionId, 'sess-fresh', '绑定应更新为新会话')
  eq(store.get('c2c:U1')?.botId, undefined, '绑定 botId 未提供时保持 undefined（不影响行为）')
})

await checkAsync('no-agent + 重建失败 → 如实报错 recreate-failed', async () => {
  const store = tempStore('e2e-stale2')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'session-gone', botId: 'qq_oldbot' })
  const result = await handleInbound({
    message: { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' },
    dedupe: new DedupeWindow(), bindings: store,
    config: { autoCreateSession: true },
    resolveAgent: async () => undefined,
    createSession: async () => { throw new Error('create boom') },
    inject: () => true,
  })
  eq(result.status, 'error', '重建失败应当是错误')
  eq(result.reason, 'recreate-failed', '原因应当指明重建失败')
})

await checkAsync('未绑定 + 自动新建 → 建立绑定', async () => {
  const store = tempStore('e2e3')
  const result = await handleInbound({
    message: { kind: 'c2c', senderId: 'NEWUSER', content: '你好', messageId: 'm1' },
    dedupe: new DedupeWindow(), bindings: store,
    config: { autoCreateSession: true },
    resolveAgent: async () => undefined,
    createSession: async () => 'sess-new',
    inject: () => true,
  })
  eq(result.status, 'delivered', '新建会话后应视为已投递（交互式回复依赖 lastInbound 标记）')
  eq(store.get('c2c:NEWUSER')?.sessionId, 'sess-new', '应当落盘绑定')
})

await checkAsync('注入抛错时如实报错', async () => {
  const store = tempStore('e2e4')
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const result = await handleInbound({
    message: { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' },
    dedupe: new DedupeWindow(), bindings: store, config: {},
    resolveAgent: async () => ({ inject: () => {} }),
    inject: () => { throw new Error('inject boom') },
  })
  eq(result.status, 'error', '注入失败应当是错误')
  eq(result.reason, 'inject-failed', '原因应当是 inject-failed')
})

console.log(`inbound.test.mjs：${passed} 项通过`)

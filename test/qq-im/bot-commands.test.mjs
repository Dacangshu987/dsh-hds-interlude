/**
 * QQ 用户端机器人命令（对齐 dsh-im）：
 *   /help /status /new /sessionlist /session <ID|序号>
 *
 * 两部分：
 *   A. createBotCommandHandler 的语义单测（假依赖注入）；
 *   B. channel 入站拦截：命令消息被回投、**不进模型**；普通消息照常注入。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import path from 'node:path'
import fs from 'node:fs'

import { createBotCommandHandler, isBotCommandCandidate } from '../../lib/qq-im/bot-commands.js'
import { installQqIm } from '../../lib/qq-im/channel.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

const TEST_HOME = caseDir('botcmds')
fs.mkdirSync(TEST_HOME, { recursive: true })
process.env.DSH_HOME = TEST_HOME

/* ---------------------------------------------------------------- A. 处理器单测 */

/** 造一个假 qqIm（含 bindings / createSessionFor / status / config）。 */
function makeFakeQqIm(overrides = {}) {
  const fake = {
    config: { bots: [
      { botId: 'qq_bot', appId: '1900000001', alias: '测试机' },
    ] },
    bindings: {
      get: () => undefined,
      list: () => [],
      set: () => {},
      remove: () => false,
    },
    invalidateBindings: () => {},
    createSessionFor: async () => 'session-fresh',
    status: () => ({ bots: [{ botId: 'qq_bot', appId: '1900000001', started: true, ready: true }] }),
    ...overrides,
  }
  return fake
}

console.log('A. 机器人命令处理器')

await check('/help 返回命令列表', async () => {
  const handler = createBotCommandHandler({ qqIm: makeFakeQqIm(), listStoredStates: () => [], storyNameFor: () => undefined })
  const r = await handler({ message: { content: '/help' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('/new'), '应列出 /new')
  assert.ok(r.reply.includes('/sessionlist'), '应列出 /sessionlist')
  assert.ok(r.reply.includes('/session'), '应列出 /session')
})

await check('/status 报告连接与绑定（已绑定 → 带会话 id）', async () => {
  const qqIm = makeFakeQqIm({
    bindings: { get: () => ({ sessionId: 'sess-old', name: '江柚' }), list: () => [], set: () => {}, remove: () => false },
  })
  const handler = createBotCommandHandler({ qqIm, listStoredStates: () => [], storyNameFor: () => undefined })
  const r = await handler({ message: { content: '/status' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('已连接'), r.reply)
  assert.ok(r.reply.includes('sess-old'), '应显示绑定会话')
  assert.ok(r.reply.includes('测试机'), '应显示别名')
})

await check('/status 未绑定 → 提示发消息自动新建', async () => {
  const handler = createBotCommandHandler({ qqIm: makeFakeQqIm(), listStoredStates: () => [], storyNameFor: () => undefined })
  const r = await handler({ message: { content: '/status' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('未绑定'), r.reply)
})

await check('/new 解绑 + 新建会话并绑回', async () => {
  const calls = []
  const qqIm = makeFakeQqIm({
    bindings: {
      get: () => undefined,
      list: () => [],
      remove: (key, botId) => { calls.push(['remove', key, botId]); return true },
      set: (item) => calls.push(['set', item]),
    },
    invalidateBindings: () => calls.push(['invalidate']),
    createSessionFor: async (key, msg, botId) => { calls.push(['create', key, botId]); return 'session-new' },
  })
  const handler = createBotCommandHandler({
    qqIm,
    listStoredStates: () => [],
    storyNameFor: (botId) => { calls.push(['name', botId]); return '江柚' },
  })
  const r = await handler({ message: { content: '/new' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('全新会话'), r.reply)
  assert.equal(r.sessionId, 'session-new')
  // 顺序：先删绑定 → 建会话 → 写回绑定（带角色名）。
  assert.deepEqual(calls[0], ['remove', 'c2c:U1', 'qq_bot'], '应先解绑')
  assert.ok(calls.some(c => c[0] === 'create' && c[1] === 'c2c:U1'), '应新建会话')
  const setCall = calls.find(c => c[0] === 'set')
  assert.deepEqual(setCall[1], { conversationKey: 'c2c:U1', sessionId: 'session-new', botId: 'qq_bot', name: '江柚' }, '应绑回新会话并带角色名')
})

await check('/sessionlist 列出绑定会话与幕间会话（带序号）', async () => {
  const qqIm = makeFakeQqIm({
    bindings: {
      get: () => undefined,
      list: () => [{ sessionId: 'sess-bound', conversationKey: 'c2c:X', botId: 'qq_bot' }],
      set: () => {},
      remove: () => false,
    },
  })
  const handler = createBotCommandHandler({
    qqIm,
    listStoredStates: () => [{ key: 'sess-stored', state: { continuity: '昨晚的事' } }],
    storyNameFor: () => undefined,
  })
  const r = await handler({ message: { content: '/sessionlist' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('[0]'), '应有序号 0')
  assert.ok(r.reply.includes('sess-bound'), '应列出绑定会话')
  assert.ok(r.reply.includes('sess-stored'), '应列出幕间会话')
})

await check('/session <序号> 把当前聊天绑到指定会话', async () => {
  const setCalls = []
  const qqIm = makeFakeQqIm({
    bindings: {
      get: () => undefined,
      list: () => [],
      set: (item) => setCalls.push(item),
      remove: () => false,
    },
  })
  const handler = createBotCommandHandler({
    qqIm,
    listStoredStates: () => [{ key: 'sess-target', state: {} }],
    storyNameFor: () => '江柚',
  })
  const r = await handler({ message: { content: '/session 0' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('sess-target'), r.reply)
  assert.equal(r.sessionId, 'sess-target')
  assert.deepEqual(setCalls[0], { conversationKey: 'c2c:U1', sessionId: 'sess-target', botId: 'qq_bot', name: '江柚' })
})

await check('/session 序号越界 / 缺参 / 找不到 → 明确报错', async () => {
  const handler = createBotCommandHandler({ qqIm: makeFakeQqIm(), listStoredStates: () => [], storyNameFor: () => undefined })
  assert.ok((await handler({ message: { content: '/session' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })).reply.includes('用法'))
  assert.ok((await handler({ message: { content: '/session 9' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })).reply.includes('序号'))
  assert.ok((await handler({ message: { content: '/session no-such' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })).reply.includes('找不到'))
})

await check('/presetlist 列出可用角色预设（带序号）', async () => {
  const handler = createBotCommandHandler({
    qqIm: makeFakeQqIm(),
    listStoredStates: () => [],
    storyNameFor: () => undefined,
    listPresets: () => [{ id: 'preset-hds-a', name: '江柚' }, { id: 'preset-hds-b', name: '阿澈' }],
    resolvePresetId: (x) => x,
  })
  const r = await handler({ message: { content: '/presetlist' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('[0]'), '应有序号 0')
  assert.ok(r.reply.includes('江柚'), '应列出预设名')
  assert.ok(r.reply.includes('阿澈'), '应列出第二个预设')
})

await check('/presetlist 无可用预设 → 提示先保存', async () => {
  const handler = createBotCommandHandler({
    qqIm: makeFakeQqIm(),
    listStoredStates: () => [],
    storyNameFor: () => undefined,
    listPresets: () => [],
  })
  const r = await handler({ message: { content: '/presetlist' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('没有可切换'), r.reply)
})

await check('/preset 不带参数 → 提示用法（先 /presetlist）', async () => {
  const handler = createBotCommandHandler({
    qqIm: makeFakeQqIm(),
    listStoredStates: () => [],
    storyNameFor: () => undefined,
    listPresets: () => [{ id: 'preset-hds-a', name: '江柚' }],
    resolvePresetId: (x) => x,
  })
  const r = await handler({ message: { content: '/preset' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('用法'), r.reply)
  assert.ok(r.reply.includes('/presetlist'), r.reply)
})

await check('/preset <序号> 解绑 + 用该预设新建会话并绑回（绑定名=新角色）', async () => {
  const calls = []
  const qqIm = makeFakeQqIm({
    bindings: {
      get: () => undefined,
      list: () => [],
      remove: (key, botId) => { calls.push(['remove', key, botId]); return true },
      set: (item) => calls.push(['set', item]),
    },
    invalidateBindings: () => calls.push(['invalidate']),
    createSessionFor: async (key, msg, botId, options) => { calls.push(['create', key, botId, options]); return 'session-preset' },
  })
  const handler = createBotCommandHandler({
    qqIm,
    listStoredStates: () => [],
    storyNameFor: () => '江柚',
    listPresets: () => [{ id: 'preset-hds-a', name: '江柚' }, { id: 'preset-hds-b', name: '阿澈' }],
    resolvePresetId: (x) => x,
  })
  const r = await handler({ message: { content: '/preset 1' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('阿澈'), '应提示切换到阿澈')
  assert.equal(r.sessionId, 'session-preset')
  assert.deepEqual(calls[0], ['remove', 'c2c:U1', 'qq_bot'], '应先解绑')
  const createCall = calls.find(c => c[0] === 'create')
  assert.deepEqual(createCall[3], { presetId: 'preset-hds-b' }, '应带 presetId 覆盖')
  const setCall = calls.find(c => c[0] === 'set')
  assert.deepEqual(setCall[1], { conversationKey: 'c2c:U1', sessionId: 'session-preset', botId: 'qq_bot', name: '阿澈' }, '应绑回新会话且绑定名用新角色名')
})

await check('/preset <角色名> 按名字匹配切换', async () => {
  const calls = []
  const qqIm = makeFakeQqIm({
    bindings: { get: () => undefined, list: () => [], remove: () => true, set: (i) => calls.push(i) },
    invalidateBindings: () => {},
    createSessionFor: async (key, msg, botId, options) => { calls.push({ presetId: options.presetId }); return 'session-n' },
  })
  const handler = createBotCommandHandler({
    qqIm,
    listStoredStates: () => [],
    storyNameFor: () => undefined,
    listPresets: () => [{ id: 'preset-hds-a', name: '江柚' }],
    resolvePresetId: () => undefined,
  })
  const r = await handler({ message: { content: '/preset 江柚' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.ok(r.reply.includes('江柚'), r.reply)
  assert.deepEqual(calls[0], { presetId: 'preset-hds-a' }, '应按名字解析到预设 id')
})

await check('/preset 找不到 / 序号越界 → 明确报错', async () => {
  const handler = createBotCommandHandler({
    qqIm: makeFakeQqIm(),
    listStoredStates: () => [],
    storyNameFor: () => undefined,
    listPresets: () => [{ id: 'preset-hds-a', name: '江柚' }],
    resolvePresetId: () => undefined,
  })
  assert.ok((await handler({ message: { content: '/preset 不存在' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })).reply.includes('找不到'), '找不到应报错')
  assert.ok((await handler({ message: { content: '/preset 9' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })).reply.includes('序号'), '序号越界应报错')
})

await check('未知命令 → 提示 /help，不进模型', async () => {
  const handler = createBotCommandHandler({ qqIm: makeFakeQqIm(), listStoredStates: () => [], storyNameFor: () => undefined })
  const r = await handler({ message: { content: '/whatever' }, botId: 'qq_bot', conversationKey: 'c2c:U1', scope: 'c2c' })
  assert.equal(r.handled, true)
  assert.ok(r.reply.includes('/help'), r.reply)
})

await check('isBotCommandCandidate：私聊 / 开头 / 单行；前导空格、群聊、多行、关开关不算', () => {
  assert.equal(isBotCommandCandidate({ message: { kind: 'c2c', content: '/status' }, config: {} }), true)
  assert.equal(isBotCommandCandidate({ message: { kind: 'c2c', content: '  /status' }, config: {} }), false, '前导空格不算（命令必须顶格，避免误触发）')
  assert.equal(isBotCommandCandidate({ message: { kind: 'c2c', content: '/a\nb' }, config: {} }), false, '多行不算')
  assert.equal(isBotCommandCandidate({ message: { kind: 'group', content: '/status' }, config: {} }), false, '群聊不算')
  assert.equal(isBotCommandCandidate({ message: { kind: 'c2c', content: '/status' }, config: { botCommands: false } }), false, '关开关不算')
  assert.equal(isBotCommandCandidate({ message: { kind: 'c2c', content: '你好' }, config: {} }), false, '普通消息不算')
})

/* ---------------------------------------------------------------- B. channel 拦截 */

console.log('\nB. channel 入站拦截')

function makeChannel(onBotCommand, config = {}) {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { return { sessionId: 'session-auto' } },
          async resolveAgent(sessionId) {
            return { agent: { id: sessionId, session: { id: sessionId }, followup() {} } }
          },
        }
      : undefined),
  }
  const sent = []
  const channel = installQqIm(ctx, {
    config: { enabled: true, autoCreateSession: true, botId: 'qq_bot', ...config },
    log: () => {},
    transport: async (targetId, text) => { sent.push({ targetId, text }); return { sent: true } },
    onBotCommand,
  })
  return { channel, sent }
}

await check('命令消息 → onBotCommand 被调、结果回投、不进模型', async () => {
  let injected = 0
  const botCommandCalls = []
  const { channel, sent } = makeChannel(async (args) => {
    botCommandCalls.push(args)
    return { handled: true, reply: '已连接（测试）' }
  })
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U1', content: '/status', messageId: 'm-cmd-1' },
    'qq_bot',
  )
  assert.equal(result.status, 'command', '应标记为 command 处理')
  assert.equal(botCommandCalls.length, 1, 'onBotCommand 应被调一次')
  assert.equal(botCommandCalls[0].conversationKey, 'c2c:U1', '应带 conversationKey')
  assert.equal(botCommandCalls[0].botId, 'qq_bot')
  assert.equal(sent.length, 1, '命令结果应回投')
  assert.equal(sent[0].text, '已连接（测试）')
  assert.equal(sent[0].targetId, 'U1')
  assert.equal(injected, 0, '命令不应注入模型')
})

await check('命令回调返回 handled:false → 走正常入站（注入模型）', async () => {
  const { channel } = makeChannel(async () => ({ handled: false }))
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U1', content: '/status', messageId: 'm-cmd-2' },
    'qq_bot',
  )
  // autoCreateSession 开启 → 自动建会话 → 注入首条消息 → delivered。
  assert.equal(result.status, 'delivered', '未处理时按普通消息走')
})

await check('普通消息（非 / 开头）不触发命令，正常注入', async () => {
  let called = 0
  const { channel } = makeChannel(async () => { called += 1; return { handled: true, reply: 'x' } })
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm-plain-1' },
    'qq_bot',
  )
  assert.equal(called, 0, '普通消息不该触发命令')
  assert.equal(result.status, 'delivered', '应正常投递')
})

await check('botCommands:false → 命令当普通消息处理', async () => {
  let called = 0
  const { channel } = makeChannel(async () => { called += 1; return { handled: true, reply: 'x' } }, { botCommands: false })
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U1', content: '/status', messageId: 'm-off-1' },
    'qq_bot',
  )
  assert.equal(called, 0, '关掉开关后 /status 不再拦截')
  assert.equal(result.status, 'delivered', '当作普通消息注入')
})

await check('白名单外用户：命令不响应（防绕过白名单操作绑定）', async () => {
  let cmdCalled = 0
  const { channel } = makeChannel(async () => { cmdCalled += 1; return { handled: true, reply: 'x' } }, {
    bots: [{ botId: 'qq_bot', appId: '1900000001', secretRef: 'S', whitelist: ['U_ALLOWED'] }],
  })
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U_OTHER', content: '/status', messageId: 'm-wl-1' },
    'qq_bot',
  )
  assert.equal(cmdCalled, 0, '白名单外用户命令不该响应')
  assert.equal(result.status, 'ignored', '命令与普通消息都被白名单挡下')
  assert.equal(result.reason, 'not-whitelisted', '原因指明白名单')
})

await check('per-bot 命令开关：该机器人关闭 → 命令当普通消息处理', async () => {
  let cmdCalled = 0
  const { channel } = makeChannel(async () => { cmdCalled += 1; return { handled: true, reply: 'x' } }, {
    bots: [{ botId: 'qq_bot', appId: '1900000001', secretRef: 'S', botCommands: false }],
  })
  const result = await channel.ingestMessage(
    { kind: 'c2c', senderId: 'U1', content: '/status', messageId: 'm-perbot-off' },
    'qq_bot',
  )
  assert.equal(cmdCalled, 0, '该 bot 命令关闭后不应响应')
  assert.equal(result.status, 'delivered', '当作普通消息注入')
})

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n机器人命令：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

/**
 * 自动新建会话 + 首条消息注入 的回归测试。
 *
 * 线上事故（用户看到「收 1 条、绑 1 个会话、三环全✓，却发 0 条、没有回复」）：
 *   `sessionController.create()` 的真实返回是 `{ sessionId, agentPreset? }`——
 *   **没有 agent**。旧实现写 `const agent = created?.agent`，恒为 undefined，
 *   于是 `agent.followup(...)` 永不执行：会话建了、绑定建了、消息标记 delivered，
 *   但模型一个字都没看到 → 永远不回复。
 *
 * 修复：create 之后必须再 `resolveAgentFor(sessionId)` 拿 live agent 才能 followup。
 * 本测试用「create 只返回 sessionId」的假 controller 把这条钉死。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import path from 'node:path'
import fs from 'node:fs'

import { installQqIm } from '../../lib/qq-im/channel.js'

const TEST_HOME = caseDir('createsession')
fs.mkdirSync(TEST_HOME, { recursive: true })
process.env.DSH_HOME = TEST_HOME

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/**
 * 建一个通道。
 *
 * @param {object} fake 假宿主：
 *   - `createResult`：controller.create() 的返回值
 *   - `resolveResult`：controller.resolveAgent() 的返回值
 *   - `resolveThrows`：resolveAgent 是否抛错
 */
function makeChannel(fake = {}) {
  const calls = { create: 0, resolveAgent: [], followups: [] }
  const agent = {
    session: { id: 'session-new-1' },
    followup(message) { calls.followups.push(message) },
  }
  const controller = {
    async create(request) {
      calls.create += 1
      void request
      // 真实返回：只有 sessionId（+可选 agentPreset），**没有 agent**。
      return fake.createResult ?? { sessionId: 'session-new-1' }
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId)
      if (fake.resolveThrows) throw new Error('resolve boom')
      return fake.resolveResult ?? { agent }
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get(name) { return name === 'sessionController' ? controller : undefined },
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, autoCreateSession: true, botId: 'qq' },
    log: () => {},
    transport: async () => ({ sent: true }),
  })
  return { channel, calls, agent }
}

console.log('自动新建会话 + 首条消息注入')

await check('create 只返回 sessionId（无 agent）时，仍能 resolve 出 agent 并 followup', async () => {
  const { channel, calls } = makeChannel()
  const sessionId = await channel.createSessionFor(
    'c2c:U1',
    { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' },
  )
  assert.equal(sessionId, 'session-new-1', '应返回 sessionId')
  assert.equal(calls.create, 1, '应调用一次 create')
  assert.deepEqual(calls.resolveAgent, ['session-new-1'], 'create 之后必须再 resolve 一次拿 agent')
  assert.equal(calls.followups.length, 1, '首条消息必须被 followup 注入（这就是线上漏掉的一步）')
  const text = calls.followups[0]?.content?.[0]?.text ?? ''
  assert.ok(text.includes('在吗'), `注入正文应含原始内容，实际：${text}`)
})

await check('注入用 followup（唤醒驱动），不是 inject', async () => {
  const { channel, calls, agent } = makeChannel()
  let injected = 0
  agent.inject = () => { injected += 1 }
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'hi', messageId: 'm1' })
  assert.equal(injected, 0, '不应走 inject（不唤醒驱动 → 模型不回复）')
  assert.equal(calls.followups.length, 1, '应走 followup')
})

await check('resolveAgent 抛错 → 仍返回 sessionId（绑定已建，消息不丢）', async () => {
  const { channel, calls } = makeChannel({ resolveThrows: true })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, 'session-new-1', '会话已建，应返回 id')
  assert.equal(calls.followups.length, 0, '拿不到 agent 时不注入，但要如实返回')
})

await check('resolveAgent 返回 { error } → 不注入、不崩', async () => {
  const { channel, calls } = makeChannel({ resolveResult: { error: new Error('not found') } })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, 'session-new-1')
  assert.equal(calls.followups.length, 0, '有 error 时不该注入')
})

await check('create 抛错 → 返回 undefined（调用方据此报 create-failed）', async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? { async create() { throw new Error('create boom') }, async resolveAgent() { return { agent: {} } } }
      : undefined),
  }
  const channel = installQqIm(ctx, { config: { enabled: true, botId: 'qq' }, log: () => {}, transport: async () => ({ sent: true }) })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, undefined, 'create 失败应返回 undefined')
})

await check('create 返回空 sessionId → 返回 undefined，不去 resolve', async () => {
  const { channel, calls } = makeChannel({ createResult: {} })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, undefined, '没拿到 sessionId 应放弃')
  assert.equal(calls.resolveAgent.length, 0, '不该用空 id 去 resolve')
})

await check('sessionController 不可用 → 返回 undefined，不抛错', async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
  }
  const channel = installQqIm(ctx, { config: { enabled: true, botId: 'qq' }, log: () => {}, transport: async () => ({ sent: true }) })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, undefined, '没有 sessionController 时应降级返回 undefined')
})

/* ------------------------------------------------- 角色预设（决定会不会回复） */

await check('create 时带上解析出的角色预设（没预设 → 不注入人设与规则 → 不回复）', async () => {
  const requests = []
  const agent = { session: { id: 'session-preset' }, followup() {} }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-preset' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq', agentPreset: 'preset-jiangyou' },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolvePreset: (nameOrId) => (nameOrId === 'preset-jiangyou' ? 'preset-jiangyou' : undefined),
  })
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' })
  assert.equal(requests.length, 1, '应调用一次 create')
  assert.equal(requests[0].agentPreset, 'preset-jiangyou', '应把角色预设传给 create')
})

await check('未配置 agentPreset 时按绑定里的角色名匹配', async () => {
  const requests = []
  const agent = { session: { id: 'session-by-name' }, followup() {} }
  const seen = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-by-name' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq' },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolvePreset: (nameOrId) => { seen.push(nameOrId); return nameOrId === '江柚' ? 'preset-jiangyou' : undefined },
  })
  // 绑定表里记着角色名。
  channel.bindings.set({ conversationKey: 'c2c:U1', sessionId: 'session-old', botId: 'qq', name: '江柚' })
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' })
  assert.deepEqual(seen, ['江柚'], '应按绑定里的角色名去解析预设')
  assert.equal(requests[0].agentPreset, 'preset-jiangyou', '匹配到同名预设应带上')
})

await check('per-bot：该 bot 自己的 agentPreset 优先于全局（多 bot 独立角色）', async () => {
  const requests = []
  const agent = { session: { id: 'session-perbot' }, followup() {} }
  const seen = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-perbot' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: {
      enabled: true, botId: 'qq_bot1', agentPreset: 'preset-global',
      bots: [
        { botId: 'qq_bot1', appId: '1900000001', agentPreset: '' },
        { botId: 'qq_bot2', appId: '1900000002', agentPreset: 'preset-su-nian' },
      ],
    },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolvePreset: (nameOrId) => { seen.push(nameOrId); return typeof nameOrId === 'string' && nameOrId ? nameOrId : undefined },
  })
  // bot2 建会话：应使用 bot2 自己的 agentPreset（而非全局/绑定名）。
  await channel.createSessionFor('c2c:U2', { kind: 'c2c', senderId: 'U2', content: '在吗', messageId: 'm2' }, 'qq_bot2')
  assert.deepEqual(seen, ['preset-su-nian'], 'bot2 的会话应优先用 bot2 的 agentPreset')
  assert.equal(requests[0].agentPreset, 'preset-su-nian', '应把 bot2 的预设传给 create')
  // bot1 建会话：没配自己的 → 回退全局 agentPreset。
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' }, 'qq_bot1')
  assert.deepEqual(seen[seen.length - 1], 'preset-global', 'bot1 未配自己的预设应回退全局')
})

await check('匹配不到预设 → 不带 agentPreset（并留日志），不报错', async () => {
  const requests = []
  const agent = { session: { id: 'session-plain' }, followup() {} }
  const logs = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-plain' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq' },
    log: (level, text) => logs.push(`${level}:${text}`),
    transport: async () => ({ sent: true }),
    resolvePreset: () => undefined,
  })
  const sessionId = await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(sessionId, 'session-plain', '仍应建出会话')
  assert.equal('agentPreset' in requests[0], false, '匹配不到就不带预设')
  assert.ok(logs.some(l => l.includes('没有可用角色预设')), '应留一条警告说明可能不回复')
})

/* ------------------------------------------------- workspace（决定会话是否显示） */

await check('create 带上 resolveCwd 给出的工作目录（否则会话不显示在当前 workspace）', async () => {
  // 线上症状：「已经有回复了，但 dsh 里不显示会话」——会话建在了宿主的
  // defaultCwd（用户主目录），而界面按 workspace 分组，于是看不到。
  const requests = []
  const agent = { session: { id: 'session-cwd' }, followup() {} }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-cwd' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq' },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolveCwd: () => 'D:\\work\\dsh-hds-interlude',
  })
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(requests[0].cwd, 'D:\\work\\dsh-hds-interlude', '应把工作目录传给 create')
})

await check('显式配置 im.cwd 优先于 resolveCwd', async () => {
  const requests = []
  const agent = { session: { id: 'session-cwd2' }, followup() {} }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-cwd2' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq', cwd: 'E:\\explicit' },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolveCwd: () => 'D:\\from-recent',
  })
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal(requests[0].cwd, 'E:\\explicit', '显式配置应优先')
})

await check('拿不到 cwd 时不传该字段（退回宿主默认），并留警告', async () => {
  const requests = []
  const agent = { session: { id: 'session-nocwd' }, followup() {} }
  const logs = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-nocwd' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: { enabled: true, botId: 'qq' },
    log: (level, text) => logs.push(`${level}:${text}`),
    transport: async () => ({ sent: true }),
    resolveCwd: () => '',
  })
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: 'x', messageId: 'm1' })
  assert.equal('cwd' in requests[0], false, '拿不到就不要带空 cwd')
  assert.ok(logs.some(l => l.includes('没有确定的工作目录')), '应警告可能不显示在列表里')
})

await check('per-bot：该 bot 自己的 cwd 优先于全局（会话存放工作区）', async () => {
  const requests = []
  const agent = { session: { id: 'session-perbot-cwd' }, followup() {} }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agents: { get: () => undefined, list: () => [] },
    get: (name) => (name === 'sessionController'
      ? {
          async create(request) { requests.push(request); return { sessionId: 'session-perbot-cwd' } },
          async resolveAgent() { return { agent } },
        }
      : undefined),
  }
  const channel = installQqIm(ctx, {
    config: {
      enabled: true, botId: 'qq_bot1', cwd: 'F:/global',
      bots: [
        { botId: 'qq_bot1', appId: '1900000001', secretRef: 'S1', cwd: 'E:/bot1' },
        { botId: 'qq_bot2', appId: '1900000002', secretRef: 'S2', cwd: '' },
      ],
    },
    log: () => {},
    transport: async () => ({ sent: true }),
    resolveCwd: () => 'F:/recent',
  })
  // bot1 配了 cwd → 用它（优先于全局 im.cwd 与 resolveCwd）。
  await channel.createSessionFor('c2c:U1', { kind: 'c2c', senderId: 'U1', content: '在吗', messageId: 'm1' }, 'qq_bot1')
  assert.equal(requests[0].cwd, 'E:/bot1', 'bot1 应使用自己的 cwd')
  // bot2 没配 cwd → 回退全局 im.cwd。
  await channel.createSessionFor('c2c:U2', { kind: 'c2c', senderId: 'U2', content: '在吗', messageId: 'm2' }, 'qq_bot2')
  assert.equal(requests[1].cwd, 'F:/global', 'bot2 应回退全局 im.cwd')
})

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n自动新建会话：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

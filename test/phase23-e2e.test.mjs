/**
 * 端到端核验：三套新机制（场景帧 / 认知证据 / 演化门控）在**真插件**里跑起来
 * 是什么样，以及它们是否真的接进了提示词。
 *
 * 单测验的是纯函数；这一层回答的是：
 *   - 场景帧真的会随证据重投影吗？
 *   - 认知证据真的落进了长期事实、且读回来仍带着 mode 吗？
 *   - 单次互动的 overlay 真的被门控拦住了吗？
 *   - 场景帧 / 交付现实真的出现在注入给模型的幕间块里吗？
 *
 * 运行：node test/phase23-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-phase23-e2e', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, loadState, emptyState } = await import('../lib/state.js')

const PRESET = 'preset-phase23'
fs.mkdirSync(path.join(TEST_HOME, '.agent-presets', PRESET), { recursive: true })
fs.writeFileSync(path.join(TEST_HOME, '.agent-presets', PRESET, 'preset.yml'), 'name: phase23\n')

const SESSION = 'session-phase23'
let ok = true
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok  ${label}`) }
  catch (e) { ok = false; console.log(`  FAIL ${label}\n       ${e?.message ?? e}`) }
}

console.log('Phase 2/3 端到端')

/** 起一个真插件实例。events 会作为会话日志（供记账）。 */
async function boot({ events = [], statePatch = {}, keepState = false } = {}) {
  // keepState：保留上一次写下的状态文件，用于「盘上的事实能否被读回来」这类用例。
  // 默认清盘——多数用例需要一个干净的起点，残留会串台。
  if (!keepState) fs.rmSync(path.join(TEST_HOME, 'hds-interlude'), { recursive: true, force: true })
  const registered = new Map()
  const registeredCommands = new Map()
  const agent = {
    id: SESSION,
    session: {
      id: SESSION,
      header: { id: SESSION, agentPreset: PRESET },
      seq: events.length,
      eventAt: index => events[index],
    },
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => agent, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: t => { registered.set(t.name, t); return () => {} } })
  ctx.provide('commands', { register: c => { registeredCommands.set(c.name, c); return () => {} } })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })
  ctx.provide('webServer', { register: () => {} })
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('sessionController', { async resolveAgent() { return agent } })

  // keepState 时基于**盘上已有的**状态继续，而不是把它覆盖成一份新的空状态。
  // 踩过的坑：这里无条件 `saveState(new emptyState())`，于是上一个用例写下的
  // facts 立刻被抹掉，「重开读回事实」的用例永远看不到它们（假红）。
  const state = keepState ? loadState(SESSION) : emptyState()
  state.canonInjected = true
  state.roleplay = true
  Object.assign(state, statePatch)
  saveState(SESSION, state)

  const fiber = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { restWindows: [] } }))
  if (fiber && typeof fiber.then === 'function') await fiber

  const exec = { agent }
  /** 跑一次 `/interlude <verb>`，把回复文本取出来。 */
  const runCommand = async verb => {
    const command = registeredCommands.get('interlude')
    if (!command) return ''
    const result = await command.handler({ rawInput: verb, agent, session: agent.session })
    return typeof result === 'string' ? result : (result?.text ?? JSON.stringify(result ?? ''))
  }
  const runPreStep = async () => {
    const decision = await ctx.waterfall?.('agent/pre-step',
      { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }))
    return decision ? decision.messages.map(m => m.content.map(b => b.text).join('')).join('\n') : ''
  }
  return { ctx, registered, exec, state, runPreStep, runCommand }
}

const USER_EVENT = text => ({ type: 'user/message', time: 1_700_000_000_000, data: { content: [{ type: 'text', text }] } })
const SCRIPT_EVENT = text => ({ type: 'assistant/message', time: 1_700_000_010_000, data: { message: { content: [{ type: 'text', text }] } } })
/** `interlude_say` 工具调用 —— 只有它算「角色真实说出的话」（character-message）。 */
const SAY_EVENT = text => ({
  type: 'tool/call',
  time: 1_700_000_020_000,
  data: { turn: 1, step: 1, callId: 'say_1', name: 'interlude_say', arguments: JSON.stringify({ text }) },
})

/* ============================ ① 场景帧 ============================ */

await check('跑一轮 pre-step 后，条目账本记账并投影出场景帧', async () => {
  const events = [
    USER_EVENT('那周末我来找你吧。'),
    SCRIPT_EVENT('（她把手机放下，走到窗边。）\n\n“好啊，周末见”'),
  ]
  const { ctx, runPreStep } = await boot({ events })
  await runPreStep()

  const after = loadState(SESSION)
  assert.equal(after.ledger.entries.length, 2, `账本应有 2 条：${after.ledger.entries.length}`)
  // 这一轮没有交接，所以 scenePresence 为空 → 帧里没有可投影的字段。
  // 帧的**投影能力**由下一个用例（给了在场名单）验证。
  assert.ok(after.sceneFrame === null || typeof after.sceneFrame === 'object')
  await ctx.stop?.()
})

await check('有在场证据时，帧里出现 presentPeople 且带溯源', async () => {
  const events = [SCRIPT_EVENT('（回到客厅时，林知夏正坐在沙发上看书。）')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()

  // 用真实工具写下在场名单（引文必须对得上原文）
  const tool = registered.get('interlude_handoff')
  await tool.execute({ presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } }, exec)

  // 再跑一次 pre-step 触发重投影
  await runPreStep()
  const after = loadState(SESSION)
  assert.ok(after.sceneFrame, '应有场景帧')
  assert.deepEqual(after.sceneFrame.presentPeople, ['林知夏'], JSON.stringify(after.sceneFrame))
  assert.ok(after.sceneFrame.sources.presentPeople?.length, 'presentPeople 必须带溯源')
  await ctx.stop?.()
})

await check('场景帧与对话突发真的注入进幕间块', async () => {
  const events = [SCRIPT_EVENT('（回到客厅时，林知夏正坐在沙发上看书。）')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()
  const tool = registered.get('interlude_handoff')
  await tool.execute({ presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } }, exec)

  const injected = await runPreStep()
  assert.match(injected, /物理在场：林知夏/, `注入里应出现场景帧，实际：\n${injected}`)
  await ctx.stop?.()
})

/* ============================ ② 认知证据 ============================ */

await check('认知证据：双方确认的约定被标成 confirmed 并落进事实', async () => {
  // 关键：角色「真的说出来」的话走 interlude_say（→ character-message），
  // 而不是 assistant/message 的正文（→ script 叙述）。
  // 这个区分正是 confirmed 能不能成立的前提——散文里的引号不算确认。
  const events = [
    USER_EVENT('那周末我来找你吧。'),
    SCRIPT_EVENT('（她低头想了想。）'),
    SAY_EVENT('好啊，周末见'),
  ]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()

  const after0 = loadState(SESSION)
  const kinds = after0.ledger.entries.map(e => `${e.id}:${e.kind}`)
  assert.deepEqual(kinds, ['1:user-message', '2:script', '3:character-message'],
    `kind 应严格区分叙述与发言，实际：${kinds}`)

  const ids = after0.ledger.entries.map(e => e.id)
  const memory = registered.get('interlude_memory')
  const out = await memory.execute({
    action: 'add',
    scope: 'promise',
    content: '约好周末见面',
    knowledge: {
      mode: 'confirmed',
      clauses: [
        { role: 'proposal', sourceEntryId: ids[0], quote: '那周末我来找你吧' },
        { role: 'confirmation', sourceEntryId: ids[2], quote: '好啊，周末见' },
      ],
    },
  }, exec)
  assert.match(out, /confirmed/, out)

  const after = loadState(SESSION)
  const fact = after.facts.at(-1)
  assert.equal(fact.knowledge.mode, 'confirmed', JSON.stringify(fact.knowledge))
  assert.equal(fact.knowledge.clauses.length, 2)
  await ctx.stop?.()
})

await check('认知证据：**叙述里的台词不算确认**（这是 core 防线）', async () => {
  // 同样的两句引文，但「好啊，周末见」写在正文里、没走 interlude_say。
  // 旁白里的引号只证明她这么写过，不证明她说出去了。
  const events = [
    USER_EVENT('那周末我来找你吧。'),
    SCRIPT_EVENT('（她心想，那就说“好啊，周末见”好了。）'),
  ]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()
  const ids = loadState(SESSION).ledger.entries.map(e => e.id)

  const memory = registered.get('interlude_memory')
  const out = await memory.execute({
    action: 'add', scope: 'promise', content: '约好周末见面',
    knowledge: {
      mode: 'confirmed',
      clauses: [
        { role: 'proposal', sourceEntryId: ids[0], quote: '那周末我来找你吧' },
        { role: 'confirmation', sourceEntryId: ids[1], quote: '好啊，周末见' },
      ],
    },
  }, exec)

  const after = loadState(SESSION)
  assert.notEqual(after.facts.at(-1).knowledge.mode, 'confirmed',
    `叙述里的引号不该让 confirmed 成立，实际：${after.facts.at(-1).knowledge.mode}｜${out}`)
  await ctx.stop?.()
})

await check('认知证据：只有提案时**不会**被标成 confirmed（核心防线）', async () => {
  const events = [USER_EVENT('那周末我来找你吧。')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()

  const after0 = loadState(SESSION)
  const ids = after0.ledger.entries.map(e => e.id)
  const memory = registered.get('interlude_memory')
  const out = await memory.execute({
    action: 'add',
    scope: 'promise',
    content: '她以为说定了周末见面',
    knowledge: {
      mode: 'confirmed',
      clauses: [{ role: 'proposal', sourceEntryId: ids[0], quote: '那周末我来找你吧' }],
    },
  }, exec)

  const after = loadState(SESSION)
  const fact = after.facts.at(-1)
  assert.notEqual(fact.knowledge.mode, 'confirmed',
    `只有提案不该成立 confirmed，实际：${fact.knowledge.mode}｜回执：${out}`)
  await ctx.stop?.()
})

await check('认知证据：引文对不上时退化成 unclassified，并如实告知', async () => {
  const events = [USER_EVENT('那周末我来找你吧。')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()
  const ids = loadState(SESSION).ledger.entries.map(e => e.id)

  const memory = registered.get('interlude_memory')
  const out = await memory.execute({
    action: 'add', scope: 'event', content: '编造的确认',
    knowledge: { mode: 'confirmed', clauses: [{ role: 'confirmation', sourceEntryId: ids[0], quote: '根本不存在的一句话' }] },
  }, exec)
  assert.match(out, /证据不足|unclassified/, out)

  const after = loadState(SESSION)
  assert.equal(after.facts.at(-1).knowledge.mode, 'unclassified')
  await ctx.stop?.()
})

/* ============================ ③ 演化门控 ============================ */

await check('演化门控：单次互动不足以改长期设定（被拦下并说明理由）', async () => {
  const events = [SCRIPT_EVENT('（她今天心情很好。）')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()

  const memory = registered.get('interlude_memory')
  const out = await memory.execute({
    action: 'overlay', layer: 'character', dimension: 'traits', content: '她变得很开朗',
  }, exec)
  assert.match(out, /暂未采纳|两个不同场景/, out)

  const after = loadState(SESSION)
  assert.deepEqual(after.overlay, [], '不该写进 overlay')
  await ctx.stop?.()
})

await check('演化门控：维度必须在白名单内，否则明确报错', async () => {
  const { ctx, registered, exec } = await boot({ events: [SCRIPT_EVENT('（随便写点什么。）')] })
  const memory = registered.get('interlude_memory')
  await assert.rejects(
    () => Promise.resolve(memory.execute({ action: 'overlay', layer: 'character', dimension: '星座观', content: 'x' }, exec)),
    /dimension/,
  )
  await ctx.stop?.()
})

/* ============================ ④ 交付现实 ============================ */

await check('交付现实：投递失败时，提示词里明确说「没有送达」', async () => {
  const events = [SCRIPT_EVENT('（她看了看手机。）')]
  const { ctx, runPreStep } = await boot({
    events,
    // 造一个失败的投递回执
    statePatch: { lastImDelivery: { at: new Date().toISOString(), ok: false, sentCount: 0, total: 2, error: 'timeout' } },
  })
  const injected = await runPreStep()
  assert.match(injected, /没有送达/, `应注入交付现实，实际：\n${injected}`)
  await ctx.stop?.()
})

await check('交付现实：投递成功时不注入（成功是默认预期，不该占篇幅）', async () => {
  const events = [SCRIPT_EVENT('（她看了看手机。）')]
  const { ctx, runPreStep } = await boot({
    events,
    statePatch: { lastImDelivery: { at: new Date().toISOString(), ok: true, sentCount: 2, total: 2, error: null } },
  })
  const injected = await runPreStep()
  assert.doesNotMatch(injected, /交付现实/, `成功时不该注入，实际：\n${injected}`)
  await ctx.stop?.()
})

await check('交付现实：部分送达要如实说清送出去几条', async () => {
  const events = [SCRIPT_EVENT('（她看了看手机。）')]
  const { ctx, runPreStep } = await boot({
    events,
    statePatch: { lastImDelivery: { at: new Date().toISOString(), ok: false, sentCount: 1, total: 3, error: 'partial' } },
  })
  const injected = await runPreStep()
  assert.match(injected, /1\/3/, `应说明部分送达，实际：\n${injected}`)
  await ctx.stop?.()
})

/* ============================ ⑤ 余波 ============================ */

await check('活跃剧情余波：注入进幕间块；已过期的余波不注入', async () => {
  const events = [SCRIPT_EVENT('（她还在想昨天那场争执。）')]
  const { ctx, runPreStep } = await boot({
    events,
    statePatch: {
      activeConsequences: [
        { id: 'c1', content: '昨天的争执让她说话更小心', status: 'active', sourceEntryIds: [] },
        { id: 'c2', content: '已经过去的事', status: 'expired', sourceEntryIds: [] },
      ],
    },
  })
  const injected = await runPreStep()
  assert.match(injected, /昨天的争执/, '生效中的余波应注入')
  assert.doesNotMatch(injected, /已经过去的事/, '过期的余波不该注入')
  await ctx.stop?.()
})

/* ============================ ⑥ 长期记忆注入 ============================ */

await check('长期记忆：写入的 facts 真的出现在注入给模型的幕间块里', async () => {
  // 回归：在这之前 facts **从来没进过提示词**——只有人工 /interlude context
  // 能看见，模型全程不知情。那等于「记了但没人看」。
  const events = [USER_EVENT('最近怎么样'), SCRIPT_EVENT('（她想了想。）')]
  const { ctx, registered, exec, runPreStep } = await boot({ events })
  await runPreStep()

  const memory = registered.get('interlude_memory')
  await memory.execute({ action: 'add', scope: 'promise', content: '约好周末一起去看展' }, exec)

  const injected = await runPreStep()
  assert.match(injected, /长期记忆/, `应注入长期记忆段，实际：\n${injected}`)
  assert.match(injected, /约好周末一起去看展/, `事实内容应在注入里，实际：\n${injected}`)
  await ctx.stop?.()
})

await check('长期记忆：**她的解读**在提示词里被显式标注（核心防线）', async () => {
  const events = [USER_EVENT('在吗'), SCRIPT_EVENT('（她放下手机。）')]
  const { ctx, runPreStep } = await boot({ events })
  await runPreStep()

  // 直接造两条不同认知模式的事实，验渲染口径。
  const state = loadState(SESSION)
  state.facts.push({
    id: 'f-belief', scope: 'general', content: '他好像不太高兴',
    status: 'active', importance: 0.9, confidence: 0.9,
    knowledge: { mode: 'belief', clauses: [], relatedFactIds: [] },
  })
  state.facts.push({
    id: 'f-confirmed', scope: 'promise', content: '约好周末见面',
    status: 'active', importance: 0.9, confidence: 0.9,
    knowledge: { mode: 'confirmed', clauses: [], relatedFactIds: [] },
  })
  // 只改盘上的 facts 不够——插件持有的是内存里的那份 state。
  // 所以带着盘上的状态**重开一次**，让它读回来（keepState 保留刚才写的文件）。
  saveState(SESSION, state)
  await ctx.stop?.()

  const { ctx: ctx2, runPreStep: run2 } = await boot({ events, keepState: true })
  const injected = await run2()
  const beliefLine = injected.split('\n').find(l => l.includes('他好像不太高兴'))
  const confirmedLine = injected.split('\n').find(l => l.includes('约好周末见面'))
  assert.ok(beliefLine, `解读那条应出现：\n${injected}`)
  assert.ok(confirmedLine, `已确认那条应出现：\n${injected}`)
  assert.match(beliefLine, /她的解读|未获对方确认/, '解读必须被标注，不能与事实平铺')
  assert.doesNotMatch(confirmedLine, /解读/, '已确认的不该带解读前缀')
  await ctx2.stop?.()
})

await check('长期记忆：相关的那条会被捞到前面（词法召回接线）', async () => {
  const events = [USER_EVENT('公园那边怎么样'), SCRIPT_EVENT('（她想了想。）')]
  const { ctx, runPreStep } = await boot({ events })
  await runPreStep()
  const state = loadState(SESSION)
  // 一条很重要但无关，一条次要但正中当下话题。
  state.facts.push({
    id: 'f-important', scope: 'general', content: '最近项目很忙在赶进度',
    status: 'active', importance: 0.95, confidence: 0.95,
    knowledge: { mode: 'observed', clauses: [], relatedFactIds: [] },
  })
  state.facts.push({
    id: 'f-relevant', scope: 'general', content: '周末常去公园散步',
    status: 'active', importance: 0.2, confidence: 0.5,
    knowledge: { mode: 'observed', clauses: [], relatedFactIds: [] },
  })
  saveState(SESSION, state)
  await ctx.stop?.()

  const { ctx: ctx2, runPreStep: run2 } = await boot({ events, keepState: true })
  const injected = await run2()
  const lines = injected.split('\n').filter(l => l.includes('最近项目') || l.includes('周末常去'))
  assert.equal(lines.length, 2, `两条都该出现：${JSON.stringify(lines)}`)
  assert.match(lines[0], /周末常去/, `相关的那条应排在前面，实际顺序：${JSON.stringify(lines)}`)
  await ctx2.stop?.()
})

await check('长期记忆：没有事实时不在幕间块里留占位', async () => {
  const events = [USER_EVENT('在吗')]
  const { ctx, runPreStep } = await boot({ events })
  const injected = await runPreStep()
  assert.doesNotMatch(injected, /长期记忆/, `没有事实时不该出现该段：\n${injected}`)
  await ctx.stop?.()
})

/* ============================ ⑦ 退避 / 熔断 ============================ */

await check('熔断状态落盘并读回（DSH 重启后不会重新烧 token）', async () => {
  const events = [SCRIPT_EVENT('（她想了想。）')]
  const { ctx, runPreStep } = await boot({ events })
  await runPreStep()

  // 造 6 次连续失败 → 熔断
  const state = loadState(SESSION)
  const { recordDirectorFailure, createTimelineGuard } = await import('../lib/timeline-guard.js')
  state.timelineGuard = createTimelineGuard()
  for (let i = 0; i < 6; i++) recordDirectorFailure(state.timelineGuard, { now: 1000, from: 0 })
  saveState(SESSION, state)
  await ctx.stop?.()

  const back = loadState(SESSION)
  assert.equal(back.timelineGuard.failures, 6, '失败计数必须落盘')
  assert.ok(back.timelineGuard.backoff, '退避时间必须落盘')
})

await check('/interlude context 能看到账本与熔断状态', async () => {
  const events = [USER_EVENT('在吗'), SAY_EVENT('在的')]
  const { ctx, runPreStep, runCommand } = await boot({ events })
  await runPreStep()
  const out = await runCommand('context')
  assert.match(out, /条目账本/, `应展示账本概览：\n${out}`)
  assert.match(out, /user-message|character-message/, `应展示最近条目类型：\n${out}`)
  await ctx.stop?.()
})

await check('续写书签：注入里要求「不要重述」且只给指针', async () => {
  const events = [USER_EVENT('在吗'), SCRIPT_EVENT('（她放下手机，走到窗边。）')]
  const { ctx, runPreStep } = await boot({ events })
  await runPreStep()
  const injected = await runPreStep()
  assert.match(injected, /续写位置/, `应注入续写书签：\n${injected}`)
  assert.match(injected, /不要重述/, '应明确要求不要重述')
  await ctx.stop?.()
})

/* ============================ ⑧ 消息感知（beta10） ============================ */

/** 直接往会话事件流里发一轮「用户来消息 → 模型写正文 → 回合结束」。 */
async function emitTurn(ctx, { body, say = null } = {}) {
  const logs = []
  const origLog = console.log
  console.log = (...args) => { logs.push(args.map(String).join(' ')); origLog(...args) }
  try {
    ctx.emit('session/event', { id: SESSION }, { type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } })
    if (body) {
      ctx.emit('session/event', { id: SESSION }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: body }] } } })
    }
    if (say) {
      ctx.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { name: 'interlude_say', arguments: JSON.stringify({ text: say }) } })
    }
    ctx.emit('session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 1 } })
    await new Promise(r => setTimeout(r, 20))
  } finally {
    console.log = origLog
  }
  return logs.join('\n')
}

await check('写了正文却没调工具 → 有诊断（可能把回复写成了正文）', async () => {
  const { ctx } = await boot({ events: [] })
  const logs = await emitTurn(ctx, { body: '（她看了一眼消息，没动。）' })
  assert.match(logs, /写了正文但未调 interlude_say/, `应有诊断：\n${logs}`)
  await ctx.stop?.()
})

await check('调了 interlude_say → 没有诊断（正常回复）', async () => {
  const { ctx } = await boot({ events: [] })
  const logs = await emitTurn(ctx, { body: '（她想了想。）', say: '在的，刚忙完' })
  assert.doesNotMatch(logs, /写了正文但未调 interlude_say/, `正常回复不该诊断：\n${logs}`)
  await ctx.stop?.()
})

await check('纯沉默（什么都没写）→ 没有诊断（beta10 授予的自由）', async () => {
  const { ctx } = await boot({ events: [] })
  const logs = await emitTurn(ctx, {})  // 只有用户消息 + turn/end，模型什么都没写
  assert.doesNotMatch(logs, /写了正文但未调 interlude_say/, `纯沉默不该诊断：\n${logs}`)
  await ctx.stop?.()
})

console.log(ok ? '\n✅ Phase 2/3 端到端通过' : '\n❌ 有问题')
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(ok ? 0 : 1)

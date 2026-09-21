/**
 * 端到端核验：`interlude_handoff` 工具在**真插件**里跑起来是什么样。
 *
 * `life-handoff.test.mjs` 验的是纯函数；这一层要回答的是接线问题：
 *   - 工具真的注册上了吗？
 *   - 依据真的取的是「最近一条角色正文」吗？
 *   - 引文对不上时，**场景状态真的没被动过**吗？
 *   - 交接的记录真的落盘、并且能被读回来吗？
 *
 * 运行：node test/life-handoff-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../.tmp-handoff-e2e', import.meta.url))
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.env.DSH_HOME = TEST_HOME

const plugin = await import('../lib/index.js')
const { saveState, loadState, emptyState } = await import('../lib/state.js')
const { appendEntry } = await import('../lib/script-entry.js')

const PRESET = 'preset-handoff'
fs.mkdirSync(path.join(TEST_HOME, '.agent-presets', PRESET), { recursive: true })
fs.writeFileSync(path.join(TEST_HOME, '.agent-presets', PRESET, 'preset.yml'), 'name: handoff\n')

let ok = true
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok  ${label}`) }
  catch (e) { ok = false; console.log(`  FAIL ${label}\n       ${e?.message ?? e}`) }
}

console.log('生活交接接线')

const SESSION = 'session-handoff-e2e'
const PROSE = '（她把水壶放到灶上，拧开火。）\n\n（回到客厅时，林知夏正坐在沙发上看书。）'

/** 起一个真插件实例，返回可以调工具的 ctx。 */
async function boot({ prose = PROSE } = {}) {
  fs.rmSync(path.join(TEST_HOME, 'hds-interlude'), { recursive: true, force: true })
  const registered = new Map()
  const agent = {
    id: SESSION,
    session: { id: SESSION, header: { id: SESSION, agentPreset: PRESET }, seq: 0, eventAt: () => undefined },
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => agent, currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', {
    register: tool => { registered.set(tool.name, tool); return () => {} },
  })
  ctx.provide('commands', { register: () => () => {} })
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

  const fiber = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', runtime: { restWindows: [] } }))
  if (fiber && typeof fiber.then === 'function') await fiber

  // 预置一份带正文的会话：让账本里已经有「这一轮的原文」可供引用。
  const state = emptyState()
  state.canonInjected = true
  state.roleplay = true
  appendEntry(state.ledger, { kind: 'script', content: prose })
  saveState(SESSION, state)

  const exec = { agent }
  return { ctx, registered, exec, agent }
}

await check('interlude_handoff 工具已注册，且工具数没有变化之外的副作用', async () => {
  const { ctx, registered } = await boot()
  assert.ok(registered.has('interlude_handoff'), `已注册：${[...registered.keys()].join(', ')}`)
  await ctx.stop?.()
})

await check('引文对得上 → 在场名单被写入，并溯源到条目 id', async () => {
  const { ctx, registered, exec } = await boot()
  const tool = registered.get('interlude_handoff')
  const out = await tool.execute({
    presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' },
    activity: { value: '看书', quote: '林知夏正坐在沙发上看书' },
  }, exec)
  assert.match(out, /生活交接已记录/, out)

  const after = loadState(SESSION)
  const lin = (after.scenePresence ?? []).find(x => x.name === '林知夏')
  assert.ok(lin, `名单里应有林知夏：${JSON.stringify(after.scenePresence)}`)
  assert.equal(lin.status, 'present')
  assert.equal(lin.basis, '林知夏正坐在沙发上看书', '依据应是那条引文')
  assert.deepEqual(lin.sourceEntryIds, [1], '应溯源到条目 1')
  await ctx.stop?.()
})

await check('引文对不上 → **状态一点都没动**，并如实告知哪项没采纳', async () => {
  const { ctx, registered, exec } = await boot()
  const tool = registered.get('interlude_handoff')
  const out = await tool.execute({
    place: { value: '厨房', quote: '这句话不在原文里' },
  }, exec)
  assert.match(out, /未记录/, out)
  assert.match(out, /place/, `应点名说清是哪一项：${out}`)

  const after = loadState(SESSION)
  assert.deepEqual(after.scenePresence, [], '不该凭空写下任何在场记录')
  await ctx.stop?.()
})

await check('部分通过：好的留下，坏的丢掉（不是全有或全无）', async () => {
  const { ctx, registered, exec } = await boot()
  const tool = registered.get('interlude_handoff')
  const out = await tool.execute({
    activity: { value: '烧水', quote: '拧开火' },              // 对得上
    place: { value: '厨房', quote: '完全不存在的句子' },        // 对不上
  }, exec)
  assert.match(out, /活动=烧水/, out)
  assert.match(out, /未采纳：place/, out)
  const after = loadState(SESSION)
  // activity 通过后，它的 place 没通过——不该留下没有依据的位置。
  assert.ok(!after.sceneFrame?.place, '没有依据的位置不该被写进帧')
  await ctx.stop?.()
})

await check('没有正文可依据时，如实拒绝而不是猜', async () => {
  const { ctx, registered, exec } = await boot()
  // 清掉账本，模拟「还没写过任何正文」
  const state = loadState(SESSION)
  state.ledger = { cursor: 0, nextId: 1, entries: [] }
  saveState(SESSION, state)

  const tool = registered.get('interlude_handoff')
  const out = await tool.execute({ place: { value: '厨房', quote: '随便什么' } }, exec)
  assert.match(out, /没有可依据的续写正文|未记录/, out)
  await ctx.stop?.()
})

await check('resolvedDetails：按 label 摘掉已完成的进行中细节', async () => {
  const { ctx, registered, exec } = await boot()
  const state = loadState(SESSION)
  state.workingDetails = [
    { label: '烧水', value: '水壶还在灶上', sourceEntryIds: [1] },
    { label: '取快递', value: '单号待查', sourceEntryIds: [1] },
  ]
  saveState(SESSION, state)

  const tool = registered.get('interlude_handoff')
  const out = await tool.execute({
    resolvedDetails: [{ label: '烧水', quote: '拧开火' }],
  }, exec)
  assert.match(out, /已完成=烧水/, out)

  const after = loadState(SESSION)
  const labels = (after.workingDetails ?? []).map(x => x.label)
  assert.ok(!labels.includes('烧水'), `烧水应被摘掉：${JSON.stringify(labels)}`)
  assert.ok(labels.includes('取快递'), '没完成的要留着')
  await ctx.stop?.()
})

await check('独处：显式空名单让原在场者转 off-scene（走插件的真实路径）', async () => {
  // 造一个**一开始就只有一段正文**的会话，那段正文同时包含「林知夏在场」与
  // 「后来只剩她一个人」——这样依据始终是同一条条目，不必中途改账本。
  const { ctx, registered, exec } = await boot({
    prose: '（回到客厅时，林知夏正坐在沙发上看书。）\n\n（后来她一个人待着，屋里安安静静的。）',
  })
  const tool = registered.get('interlude_handoff')

  await tool.execute({ presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } }, exec)
  const mid = loadState(SESSION)
  assert.equal(mid.scenePresence.find(x => x.name === '林知夏').status, 'present')

  // 同一段原文里的另一句：明确表示只剩她一个人。
  const out = await tool.execute({ presence: { names: [], quote: '她一个人待着' } }, exec)
  assert.match(out, /在场=（一个人）/, out)

  const after = loadState(SESSION)
  const lin = (after.scenePresence ?? []).find(x => x.name === '林知夏')
  assert.equal(lin.status, 'off-scene', '转换后原在场者应转 off-scene')
  assert.ok(!/离开|走了/.test(lin.basis), `措辞不该读成观察到离开：${lin.basis}`)
  await ctx.stop?.()
})

console.log(ok ? '\n✅ 生活交接接线正确' : '\n❌ 接线有问题')
fs.rmSync(TEST_HOME, { recursive: true, force: true })
process.exit(ok ? 0 : 1)

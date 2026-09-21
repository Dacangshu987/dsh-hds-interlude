/**
 * 后端核验：预设的保存 / 读取 / 列表路由。
 *
 * 覆盖新增的「读取预设」链路：
 *   1. POST /api/hds-interlude/presets 保存预设 → 磁盘生成 `story.json` 快照；
 *   2. GET  /api/hds-interlude/preset?id=… 把该快照取回（读取预设的数据源）；
 *   3. GET  /api/hds-interlude/presets 列表包含它；
 *   4. 读取不存在的预设 / 非法 id → 如实报错（不越权读任意目录）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-preset', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

// 预写绑定表：给「解绑端点」用例备一条绑定（插件加载时通道会读入）。
const bindDir = path.join(TEST_HOME, 'integrations', 'dsh-qq-im')
fs.mkdirSync(bindDir, { recursive: true })
fs.writeFileSync(path.join(bindDir, 'bindings.json'), JSON.stringify({
  version: 2,
  bindings: {
    'qq_bot\u0000c2c:BOUND1': {
      conversationKey: 'c2c:BOUND1', sessionId: 'session-bound', botId: 'qq_bot',
    },
  },
}, null, 2), 'utf8')

const mod = await import('../lib/index.js')

const captured = []
const routes = {}
const ctx = new Context()
ctx.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
ctx.provide('systemPrompt', { section: () => () => {} })
ctx.provide('tools', { register: () => () => {} })
ctx.provide('commands', { register: () => () => {} })
ctx.provide('settings', {
  register(ns, schema, options) {
    const resolveImpl = () => schema(options?.base ?? {})
    return { get: resolveImpl, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})
ctx.provide('webServer', {
  register(route) {
    captured.push(route)
    if (route.path === '/api/hds-interlude/presets' || route.path === '/api/hds-interlude/preset'
      || route.path === '/api/hds-interlude/qq-im/unbind' || route.path === '/api/hds-interlude/fs/list') {
      routes[route.path] = route.handler
    }
  },
})

const fiber = ctx.plugin(mod.default ?? mod, { timeZone: 'Asia/Shanghai' })
if (fiber && typeof fiber.then === 'function') await fiber
await new Promise((r) => setTimeout(r, 50))

function fakeRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code },
    end(text) { this.body = text },
  }
}

/** 造一个带 body 的 POST 请求对象（readBody 用 on('data')/on('end')）。 */
function fakeReq(method, url, body) {
  const buf = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method,
    url,
    on(evt, cb) {
      if (evt === 'data' && buf) cb(buf)
      if (evt === 'end') cb()
    },
  }
}

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
async function checkAsync(label, fn, timeoutMs = 30000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TIMEOUT: "${label}" 超过 ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    await Promise.race([fn(), timeout]);
    passed += 1; console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

console.log('预设保存 / 读取 / 列表（后端路由）')

let savedId = null
let savedName = null

await checkAsync('POST /presets 保存预设 → 返回 id，磁盘生成 story.json 快照', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](fakeReq('POST', '/api/hds-interlude/presets', { name: '雨夜测试' }), res)
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.ok(parsed.preset?.id?.startsWith('preset-hds-'), `id 应带前缀：${parsed.preset?.id}`)
  savedId = parsed.preset.id
  savedName = parsed.preset.name
  // 快照落盘：story.json 存在且是合法 JSON 对象。
  const storyFile = path.join(TEST_HOME, '.agent-presets', savedId, 'story.json')
  assert.ok(fs.existsSync(storyFile), '应生成 story.json')
  const story = JSON.parse(fs.readFileSync(storyFile, 'utf8'))
  assert.equal(typeof story, 'object')
  assert.ok(!Array.isArray(story), 'story 应是对象')
})

await checkAsync('POST /presets 带 body.story → 保存的是传进来的草稿（创作页「新建预设」）', async () => {
  const draft = { character: { name: '草稿角色', profile: '来自草稿', speech: '短' } }
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](fakeReq('POST', '/api/hds-interlude/presets', { name: '草稿预设', story: draft }), res)
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  const id = parsed.preset.id
  // 读回该预设：story 应是草稿内容（不是全局 story）。
  const res2 = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${id}`), res2)
  const back = JSON.parse(res2.body)
  assert.equal(back.story?.character?.name, '草稿角色', '应保存草稿 story')
  assert.ok(String(back.story?.character?.profile).includes('来自草稿'), 'profile 应来自草稿')
})

await checkAsync('GET /preset?id=… 读回同一份 story（读取预设的数据源）', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${savedId}`), res)
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.equal(typeof parsed.story, 'object')
  // 与默认 story 至少同构：有 character 块。
  assert.ok(parsed.story?.character, '应含 character')
})

await checkAsync('PUT /presets 更新预设：修改的 story 直接对该预设生效', async () => {
  // 载入预设 → 修改主角名 → 保存 → PUT 更新该预设。
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](
    fakeReq('PUT', '/api/hds-interlude/presets', {
      id: savedId,
      story: { character: { name: '改名后', profile: '改过的新设定', speech: '' } },
    }),
    res,
  )
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.preset.id, savedId)

  // 读回：预设内容已更新（含 agent.cordis.yml 角色卡）。
  const res2 = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${savedId}`), res2)
  const back = JSON.parse(res2.body)
  assert.equal(back.story?.character?.name, '改名后', '预设 story 应被更新')
  const cardFile = path.join(TEST_HOME, '.agent-presets', savedId, 'agent.cordis.yml')
  assert.ok(fs.readFileSync(cardFile, 'utf8').includes('改名后'), '角色卡也应更新')
})

await check('PUT /presets 缺 id → 400；不存在 → 404', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](fakeReq('PUT', '/api/hds-interlude/presets', { name: 'x' }), res)
  assert.equal(res.status, 400, `缺 id 应 400，实际 ${res.status}`)
  const res2 = fakeRes()
  await routes['/api/hds-interlude/presets'](
    fakeReq('PUT', '/api/hds-interlude/presets', { id: 'preset-hds-no-such', name: 'x' }),
    res2,
  )
  assert.equal(res2.status, 404, `不存在应 404，实际 ${res2.status}`)
})

await checkAsync('GET /presets 列表包含刚保存的预设', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](fakeReq('GET', '/api/hds-interlude/presets'), res)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.ok(Array.isArray(parsed.presets))
  const hit = parsed.presets.find(p => p.id === savedId)
  assert.ok(hit, '列表应包含刚保存的预设')
  assert.equal(hit.name, savedName)
})

await checkAsync('PUT /presets 只传 name → 仅重命名，内容不动', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](
    fakeReq('PUT', '/api/hds-interlude/presets', { id: savedId, name: '改名后的预设' }),
    res,
  )
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  assert.equal(JSON.parse(res.body).preset.name, '改名后的预设')
  // 内容未被改：story 仍是之前 PUT 写入的「改名后」。
  const res2 = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${savedId}`), res2)
  assert.equal(JSON.parse(res2.body).story?.character?.name, '改名后', '只改名不应动 story')
  // 列表里名字已更新、带 updatedAt。
  const res3 = fakeRes()
  await routes['/api/hds-interlude/presets'](fakeReq('GET', '/api/hds-interlude/presets'), res3)
  const hit = JSON.parse(res3.body).presets.find(p => p.id === savedId)
  assert.equal(hit.name, '改名后的预设', '列表名字应更新')
  assert.ok(Number.isFinite(hit.updatedAt), '列表应带 updatedAt')
})

await check('GET /preset 缺 id → 400', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', '/api/hds-interlude/preset'), res)
  assert.equal(res.status, 400, `应 400，实际 ${res.status}`)
})

await check('GET /preset 不存在/非法 id → 404（不越权读任意目录）', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', '/api/hds-interlude/preset?id=preset-hds-no-such'), res)
  assert.equal(res.status, 404, `应 404，实际 ${res.status}`)
  const res2 = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${encodeURIComponent('../../etc/passwd')}`), res2)
  assert.equal(res2.status, 404, `非法 id 应 404，实际 ${res2.status}`)
})

await check('GET /preset 前缀+穿越 id → 404（不越权读预设目录之外）', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](
    fakeReq('GET', `/api/hds-interlude/preset?id=${encodeURIComponent('preset-hds-../../../etc/passwd')}`),
    res,
  )
  assert.equal(res.status, 404, `前缀+穿越 id 应 404，实际 ${res.status}`)
})

await checkAsync('DELETE /presets 前缀+穿越 id → 不删除预设目录之外的目标', async () => {
  // 造一个预设目录之外的「受害者」目录：`preset-hds-../victim-dir` 若被当路径拼接，
  // 会穿越出 .agent-presets 并递归删除它。校验它必须安然无恙。
  const victim = path.join(TEST_HOME, 'victim-dir')
  fs.mkdirSync(victim, { recursive: true })
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'x', 'utf8')
  const res = fakeRes()
  await routes['/api/hds-interlude/presets'](
    fakeReq('DELETE', '/api/hds-interlude/presets', { id: 'preset-hds-../victim-dir' }),
    res,
  )
  assert.ok(fs.existsSync(path.join(victim, 'keep.txt')), '越界目标目录不应被删除')
})

await check('POST /preset → 405（读取端点只读）', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('POST', '/api/hds-interlude/preset', { id: savedId }), res)
  assert.equal(res.status, 405, `应 405，实际 ${res.status}`)
})

/* ---------------- 老预设兼容：无 story.json 时从 agent.cordis.yml 反解析 ---------------- */

await checkAsync('老预设（无 story.json）→ 从 agent.cordis.yml 角色卡反解析出 story', async () => {
  // 模拟 story.json 机制（2026-09-16）之前保存的预设：只有 agent.cordis.yml + preset.yml。
  const legacyId = 'preset-hds-legacy'
  const legacyDir = path.join(TEST_HOME, '.agent-presets', legacyId)
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'preset.yml'), 'name: "江柚"\ndescription: "🎭 幕间系统预设"\n', 'utf8')
  fs.writeFileSync(path.join(legacyDir, 'agent.cordis.yml'), [
    '# 幕间系统预设生成',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |-',
    '      # 角色卡',
    '      角色名：江柚',
    '',
    '      角色设定：',
    '      22岁，运营。',
    '',
    '      说话风格：',
    '      短句。',
    '',
    '      剧情起点：',
    '      某个雨夜。',
    '',
    '- id: tool-web',
    "  name: '@deepseek-ai/dsh-tool-web'",
    '',
  ].join('\n'), 'utf8')

  const res = fakeRes()
  await routes['/api/hds-interlude/preset'](fakeReq('GET', `/api/hds-interlude/preset?id=${legacyId}`), res)
  assert.equal(res.status, 200, `老预设应可读取，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  const story = parsed.story
  assert.equal(story.character?.name, '江柚', '主角名应反解析出来')
  assert.ok(String(story.character?.profile).includes('22岁，运营。'), '角色设定应反解析出来')
  assert.ok(String(story.character?.speech).includes('短句。'), '说话风格应反解析出来')
  assert.ok(String(story.plot?.startingPoint).includes('某个雨夜。'), '剧情起点应反解析出来')
})

await check('parsePresetCard：renderPresetCard 的逆操作（roundtrip）', async () => {
  const { renderPresetCard, parsePresetCard } = await import('../lib/render.js')
  const story = {
    character: { name: '阿澈', profile: '程序员', speech: '直白' },
    perspective: '理性',
    world: { setting: '都市', location: '上海', supportingCast: '同事' },
    counterpart: { profile: '朋友', initial: '熟悉' },
    plot: { startingPoint: '入职第一天', style: '职场日常', boundaries: '不写血腥' },
  }
  const back = parsePresetCard(renderPresetCard(story))
  assert.equal(back.character.name, '阿澈')
  assert.equal(back.character.profile, '程序员')
  assert.equal(back.character.speech, '直白')
  assert.equal(back.perspective, '理性')
  assert.equal(back.world.setting, '都市')
  assert.equal(back.world.location, '上海')
  assert.equal(back.counterpart.profile, '朋友')
  assert.equal(back.plot.startingPoint, '入职第一天')
  assert.equal(back.plot.boundaries, '不写血腥')
})

/* ---------------- 解绑端点（机器人卡片二级面板「投递目标」用） ---------------- */

await checkAsync('POST /api/hds-interlude/qq-im/unbind 解绑一条投递目标', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/qq-im/unbind'](
    fakeReq('POST', '/api/hds-interlude/qq-im/unbind', { botId: 'qq_bot', conversationKey: 'c2c:BOUND1' }),
    res,
  )
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.removed, true, '应真的删掉一条绑定')
  // 再解绑同一条 → removed 应为 false（已不存在）。
  const res2 = fakeRes()
  await routes['/api/hds-interlude/qq-im/unbind'](
    fakeReq('POST', '/api/hds-interlude/qq-im/unbind', { botId: 'qq_bot', conversationKey: 'c2c:BOUND1' }),
    res2,
  )
  const again = JSON.parse(res2.body)
  assert.equal(again.removed, false, '重复解绑应为 false')
})

await check('POST unbind 缺参 → 400；非 POST → 405', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/qq-im/unbind'](fakeReq('POST', '/api/hds-interlude/qq-im/unbind', { botId: 'qq_bot' }), res)
  assert.equal(res.status, 400, `缺 conversationKey 应 400，实际 ${res.status}`)
  const res2 = fakeRes()
  await routes['/api/hds-interlude/qq-im/unbind'](fakeReq('GET', '/api/hds-interlude/qq-im/unbind'), res2)
  assert.equal(res2.status, 405, `非 POST 应 405，实际 ${res2.status}`)
})

/* ---------------- 目录选择器端点（工作区选择） ---------------- */

await checkAsync('POST /api/hds-interlude/fs/list 列出目录（不含文件）', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/fs/list'](fakeReq('POST', '/api/hds-interlude/fs/list', { path: TEST_HOME }), res)
  assert.equal(res.status, 200, `应 200，实际 ${res.status}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.path, TEST_HOME, '应返回规范化路径')
  assert.ok(Array.isArray(parsed.entries), 'entries 应为数组')
  assert.ok(parsed.entries.some(e => e.name === '.agent-presets'), '应列出子目录（含隐藏 .agent-presets）')
  assert.ok(parsed.entries.every(e => !e.path.includes('\n')), '路径不该含换行')
  // 快速访问（资源管理器侧边栏）：至少含「主目录」，且路径都存在。
  assert.ok(Array.isArray(parsed.quick), 'quick 应为数组')
  assert.ok(parsed.quick.some(q => q.name === '主目录'), '快速访问应含主目录')
  for (const q of parsed.quick) assert.ok(fs.existsSync(q.path), `快速访问路径应存在：${q.name}`)
})

await check('fs/list 不存在的路径 → ok:false 带错误信息；非 POST → 405', async () => {
  const res = fakeRes()
  await routes['/api/hds-interlude/fs/list'](fakeReq('POST', '/api/hds-interlude/fs/list', { path: 'Z:/no/such/dir-xyz' }), res)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, false, '不存在应报错')
  assert.ok(String(parsed.error).includes('无法读取目录'), '应说明原因')
  const res2 = fakeRes()
  await routes['/api/hds-interlude/fs/list'](fakeReq('GET', '/api/hds-interlude/fs/list'), res2)
  assert.equal(res2.status, 405, `非 POST 应 405，实际 ${res2.status}`)
})

await ctx.stop?.()
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n预设路由核验：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

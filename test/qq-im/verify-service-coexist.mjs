/**
 * 验证修复：两种加载顺序下都**不能崩**。
 *
 * 这是对线上事故（01:22 / 01:23 两次启动后崩溃）的回归验证。
 */
import { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_HOME = fileURLToPath(new URL('../../.tmp-dsh-home-race', import.meta.url))
process.env.DSH_HOME = TEST_HOME
fs.rmSync(TEST_HOME, { recursive: true, force: true })
fs.mkdirSync(TEST_HOME, { recursive: true })

const plugin = await import('../../lib/index.js')

/** dsh-im 的替身：没有防护，名字被占就抛（与真实实现一致）。 */
const fakeDshIm = {
  name: 'fake-dsh-im',
  apply(c) {
    c.provide('dshIm', { who: 'dsh-im', send: async () => ({ sent: true }) })
  },
}

function makeCtx() {
  const c = new Context()
  c.provide('agents', { get: () => undefined, currentInitiator: () => undefined })
  c.provide('systemPrompt', { section: () => () => {} })
  c.provide('tools', { register: () => () => {} })
  c.provide('commands', { register: () => () => {} })
  c.provide('webServer', { register: () => {} })
  c.provide('credentials', { resolve: async () => undefined })
  c.provide('settings', {
    register: (ns, schema, o) => ({ get: () => schema(o?.base ?? {}), watch: () => () => {}, update: async () => {}, replace: async () => {} }),
  })
  return c
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let failures = 0
function expect(label, ok, detail) {
  if (ok) console.log(`  ✓ ${label}`)
  else { failures += 1; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

/* ---------------------------------------------------------------- 顺序 1 */
console.log('顺序 1：hds-interlude 先，dsh-im 后（**线上崩的就是这个顺序**）')
{
  const ctx = makeCtx()
  let crashed = null
  try {
    const a = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', im: { enabled: false } }))
    if (a?.then) await a
    const b = ctx.plugin(fakeDshIm)
    if (b?.then) await b
    await sleep(30)
  } catch (error) {
    crashed = error.message
  }
  expect('没有崩溃', crashed === null, crashed)
  expect('dsh-im 拿到了 dshIm（本插件默认不占用该名字）', ctx.get('dshIm')?.who === 'dsh-im',
    `实际持有者：${ctx.get('dshIm')?.who}`)
  await ctx.stop?.()
}

/* ---------------------------------------------------------------- 顺序 2 */
console.log('\n顺序 2：dsh-im 先，hds-interlude 后')
{
  const ctx = makeCtx()
  let crashed = null
  try {
    const a = ctx.plugin(fakeDshIm)
    if (a?.then) await a
    const b = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', im: { enabled: false } }))
    if (b?.then) await b
    await sleep(30)
  } catch (error) {
    crashed = error.message
  }
  expect('没有崩溃', crashed === null, crashed)
  expect('dsh-im 保有 dshIm', ctx.get('dshIm')?.who === 'dsh-im',
    `实际持有者：${ctx.get('dshIm')?.who}`)
  await ctx.stop?.()
}

/* ---------------------------------------------------------------- 顺序 3 */
console.log('\n顺序 3：只有 hds-interlude（日常情形）')
{
  const ctx = makeCtx()
  const a = ctx.plugin(plugin, plugin.Config({ timeZone: 'Asia/Shanghai', im: { enabled: false } }))
  if (a?.then) await a
  await sleep(30)
  expect('默认**不**占用 dshIm（这是本轮修复的核心）', ctx.get('dshIm') === undefined,
    `实际：${ctx.get('dshIm')}`)
  await ctx.stop?.()
}

/* ---------------------------------------------------------------- 顺序 4 */
console.log('\n顺序 4：显式打开 im.exposeService，且无人竞争')
{
  const ctx = makeCtx()
  const a = ctx.plugin(plugin, plugin.Config({
    timeZone: 'Asia/Shanghai',
    im: { enabled: false, exposeService: true },
  }))
  if (a?.then) await a
  await sleep(30)
  expect('注册了 dshIm 兼容出口', Boolean(ctx.get('dshIm')), `实际：${ctx.get('dshIm')}`)
  expect('服务形状与 dsh-im 一致（send/listBots/listTargets）',
    typeof ctx.get('dshIm')?.send === 'function'
    && typeof ctx.get('dshIm')?.listBots === 'function'
    && typeof ctx.get('dshIm')?.listTargets === 'function',
    JSON.stringify(Object.keys(ctx.get('dshIm') ?? {})))
  await ctx.stop?.()
}

/* ---------------------------------------------------------------- 顺序 5 */
console.log('\n顺序 5：显式打开 exposeService，但 dsh-im 已先占（必须让位、不能崩）')
{
  const ctx = makeCtx()
  let crashed = null
  try {
    const a = ctx.plugin(fakeDshIm)
    if (a?.then) await a
    const b = ctx.plugin(plugin, plugin.Config({
      timeZone: 'Asia/Shanghai',
      im: { enabled: false, exposeService: true },
    }))
    if (b?.then) await b
    await sleep(30)
  } catch (error) {
    crashed = error.message
  }
  expect('没有崩溃', crashed === null, crashed)
  expect('dsh-im 保有名字，本插件让位', ctx.get('dshIm')?.who === 'dsh-im',
    `实际持有者：${ctx.get('dshIm')?.who}`)
  await ctx.stop?.()
}

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log()
if (failures > 0) {
  console.error(`并存验证失败：${failures} 项不符合预期。`)
  process.exit(1)
}
console.log('两种加载顺序下都不崩；本插件可靠让位。')

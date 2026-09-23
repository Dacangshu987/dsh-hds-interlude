/**
 * 表情库 HTTP 路由核验：列表、缩略图、路径不越界。
 *
 * 用**真实的 apply()**（index.js）+ 假宿主，把 webServer.register 捕获成注册表，
 * 再按真实 webServer 的匹配语义调 handler——测的是真路由，不是替身。
 *
 * 与 verify-qr-route.test.mjs 同一套做法。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-sticker-route-'))

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

const plugin = await import('../lib/index.js')
const ROOT = fileURLToPath(new URL('..', import.meta.url))

function makeHost() {
  const exact = new Map()
  const prefixes = new Map()
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined, list: () => [], currentInitiator: () => undefined })
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('webServer', {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
    },
  })
  ctx.provide('credentials', { set: async () => {}, resolve: async () => undefined })
  ctx.provide('settings', {
    register: (ns, schema, options) => ({
      get: () => schema(options?.base ?? {}),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  })
  return { ctx, exact, prefixes }
}

async function callHandler(route, method, url) {
  const chunks = []
  const res = {
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(body) { chunks.push(body ?? '') },
    write(chunk) { chunks.push(chunk) },
  }
  await route.handler({ method, url }, res)
  const raw = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))
  return { status: res._status, headers: res._headers, raw }
}

const host = makeHost()
const fiber = host.ctx.plugin(plugin, plugin.Config({ enabled: true, im: { enabled: true } }))
await fiber

check('表情库相关路由已注册', () => {
  assert.ok(host.exact.has('/api/hds-interlude/stickers'), '应当注册表情库列表路由')
  assert.ok(host.exact.has('/api/hds-interlude/sticker-file'), '应当注册缩略图路由')
})

// 造几张图。
const stickerDir = path.join(process.env.DSH_HOME, 'media', 'stickers')
fs.mkdirSync(path.join(stickerDir, 'mine'), { recursive: true })
fs.mkdirSync(path.join(stickerDir, 'from-USER1234'), { recursive: true })
fs.writeFileSync(path.join(stickerDir, 'mine', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
fs.writeFileSync(path.join(stickerDir, 'from-USER1234', 'b.gif'), Buffer.from([0x47, 0x49, 0x46, 1, 2]))
fs.writeFileSync(path.join(stickerDir, 'mine', 'readme.txt'), 'not an image')

const listRoute = host.exact.get('/api/hds-interlude/stickers')
const fileRoute = host.exact.get('/api/hds-interlude/sticker-file')

await checkAsync('列表返回表情、忽略非图片', async () => {
  const r = await callHandler(listRoute, 'GET', '/api/hds-interlude/stickers')
  eq(r.status, 200, '应当 200')
  const body = JSON.parse(r.raw.toString())
  eq(body.ok, true, 'ok')
  eq(body.stickers.length, 2, '只应当列出两张图片（readme.txt 不算）')
  eq(body.stats.total, 2, '统计一致')
})

await checkAsync('列表项带可直接用的 thumb 地址', async () => {
  const r = await callHandler(listRoute, 'GET', '/api/hds-interlude/stickers')
  const body = JSON.parse(r.raw.toString())
  for (const s of body.stickers) {
    assert.ok(typeof s.thumb === 'string' && s.thumb.includes('/api/hds-interlude/sticker-file'),
      `每条都应当带 thumb：${JSON.stringify(s)}`)
  }
})

await checkAsync('缩略图按内容类型返回图片字节', async () => {
  const r = await callHandler(fileRoute, 'GET', '/api/hds-interlude/sticker-file?i=0')
  eq(r.status, 200, '应当 200')
  assert.ok(String(r.headers?.['content-type'] ?? '').startsWith('image/'),
    `content-type 应当是图片：${r.headers?.['content-type']}`)
  assert.ok(r.raw.length > 0, '应当有内容')
})

await checkAsync('缩略图越界下标 → 404（不读目录外文件）', async () => {
  const r = await callHandler(fileRoute, 'GET', '/api/hds-interlude/sticker-file?i=999')
  eq(r.status, 404, '越界应当 404')
  const r2 = await callHandler(fileRoute, 'GET', '/api/hds-interlude/sticker-file?i=-1')
  eq(r2.status, 404, '负数应当 404')
  const r3 = await callHandler(fileRoute, 'GET', '/api/hds-interlude/sticker-file?i=abc')
  eq(r3.status, 404, '非数字应当 404')
})

await checkAsync('**安全**：缩略图不接受任意路径（只能按表情库下标取）', async () => {
  // 路由刻意只认 dir + 下标，不接受 file 路径参数——这样请求方无法用它读
  // 表情目录之外的任何文件。这里验证传一个 file 参数不会生效。
  const r = await callHandler(fileRoute, 'GET',
    `/api/hds-interlude/sticker-file?i=0&file=${encodeURIComponent(path.join(ROOT, 'package.json'))}`)
  eq(r.status, 200, '仍然按 i=0 取表情库里的第一张')
  const text = r.raw.toString('utf8')
  assert.ok(!text.includes('"name": "dsh-hds-interlude"'), '不该返回任意文件的真实内容')
})

await checkAsync('列表：目录不存在时安全返回空库', async () => {
  const r = await callHandler(listRoute, 'GET', '/api/hds-interlude/stickers?dir=' + encodeURIComponent(path.join(process.env.DSH_HOME, 'nope')))
  eq(r.status, 200, '不存在的目录不该 500')
  const body = JSON.parse(r.raw.toString())
  eq(body.stickers, [], '应当返回空列表')
})

// 清理
try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`表情库路由：通过 ${passed} 项`)

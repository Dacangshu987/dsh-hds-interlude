/**
 * configEditor 适配层（新宿主 dsh-settings ≥0.1.7）：`ctx.settings.register` 不存在了，
 * 设置写入改用 `ctx.configEditor` 直写。本测试验证适配层的形状与深合并语义。
 *
 * 背景（线上症状）：扫码绑定「✗ 更新配置（设置命名空间不可用）」，设置页保存
 * 「保存失败：设置命名空间不可用」。
 *
 * 根因：老宿主提供 `ctx.settings.register(ns, Config, ...)`，返回带 get/watch/update
 * 的 scope；新版 SettingsForms 服务**没有 register**（只有 configure/describe/update/
 * replace/mutate），而新版 update 又只接受 `.volatile()` 字段（会把字段解析成包装对象，
 * 破坏插件内部 `current().story` 这类读取）。所以插件改用更底层的 configEditor 直写。
 *
 * 运行：node test/settings-config-editor.test.mjs
 */
import assert from 'node:assert/strict'
import { createConfigEditorScope } from '../lib/index.js'

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

/** 造一个带 entries/edit 的假 configEditor：edit 把「当前值 + 合并」记下来。 */
function fakeConfigEditor() {
  let raw = { enabled: true, story: { character: { name: '水濑' } }, im: { appId: '' } }
  const edits = []
  return {
    edits,
    entries: () => [{ options: { id: 'hds-interlude' } }],
    async edit(entry, change) {
      const next = change(raw, { enabled: true })
      edits.push(next)
      raw = next
    },
    _read: () => raw,
  }
}

/** 宿主没有 settings.register、有 configEditor 时：scope 应被创建且写盘生效。 */
await check('无 register + 有 configEditor → scope 非空，update 深合并并触发 watch', async () => {
  const editor = fakeConfigEditor()
  let current = { enabled: true, story: { character: { name: '水濑' } }, im: { appId: '' } }
  const ctx = { get: (name) => (name === 'configEditor' ? editor : undefined) }
  const scope = createConfigEditorScope(ctx, 'hds-interlude', () => current)

  assert.ok(scope, 'scope 应被创建')
  assert.equal(typeof scope.get, 'function')
  assert.equal(typeof scope.update, 'function')
  assert.equal(typeof scope.replace, 'function')

  const seen = []
  const off = scope.watch(next => seen.push(next))

  await scope.update({ im: { appId: '1905583221', secretRef: 'DSH_QQBOT_APP_SECRET' } })
  // 深合并：story 保留，im 新增字段，enabled 保留。
  const merged = editor.edits.at(-1)
  assert.equal(merged.story.character.name, '水濑', 'story 不应被覆盖')
  assert.equal(merged.enabled, true, 'enabled 不应被覆盖')
  assert.equal(merged.im.appId, '1905583221', 'im.appId 应写入')
  assert.equal(merged.im.secretRef, 'DSH_QQBOT_APP_SECRET', 'im.secretRef 应写入')
  // watch 收到的最新值 = 当前 + overlay。
  assert.equal(seen.at(-1)?.im?.appId, '1905583221', 'watch 应收到合并后的最新值')

  // replace：以继承层为底，section 覆盖（对齐 SettingsForms.replace）。
  await scope.replace({ im: { enabled: true, appId: 'X', secretRef: 'R' } })
  assert.equal(editor.edits.at(-1).im.appId, 'X')
  assert.equal(editor.edits.at(-1).enabled, true, '继承层字段保留')

  off()
})

await check('无 configEditor（精简宿主）→ scope 为 null，调用方退回静态配置', () => {
  const ctx = { get: () => undefined }
  const scope = createConfigEditorScope(ctx, 'hds-interlude', () => ({}))
  assert.equal(scope, null)
})

await check('ctx 没有 get 方法 → 不抛错，scope 为 null', () => {
  const scope = createConfigEditorScope({}, 'hds-interlude', () => ({}))
  assert.equal(scope, null)
})

await check('entry 找不到时 update 抛可读错误', async () => {
  const editor = fakeConfigEditor()
  editor.entries = () => []
  const scope = createConfigEditorScope({ get: () => editor }, 'hds-interlude', () => ({}))
  await assert.rejects(() => scope.update({ im: { appId: '1' } }), /找不到插件配置条目/)
})

console.log(`\nconfigEditor 适配层：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
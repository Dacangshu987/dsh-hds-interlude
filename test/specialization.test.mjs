/**
 * 模型特化推断层测试（移植自上游 `1.0.1-rc14` 的 `src/specialization.ts`）。
 *
 * 覆盖：
 *   A. `detectFamily`：8 个家族的识别模式与**顺序**（gemini-flash 先于 gemini、
 *      claude 先于 gpt 等），以及未识别 → generic；
 *   B. `autoTier`：grok→lite、glm(<5)→lite、gemini-flash→lite、
 *      「非 deepseek + flash/lite/mini 词元」→lite、claude/gpt→full、
 *      generic→full、其余→standard，**含两处上游例外**
 *      （deepseek 不吃 flash→lite；glm-5 起不算 lite）；
 *   C. `inferSpecialty`：auto / 手动档位 / off 三种模式与 source 标记；
 *   D. 家族块最小偏移：gemini-flash 换精简打字块 + 一条家族行；
 *      kimi 在完整块后补矛盾段；claude/glm 各一条家族行；其余家族无偏移；
 *   E. 渲染落地：imRules 里确实用了对应版本，且**至多一条**新增行。
 *
 * 运行：node test/specialization.test.mjs
 */
import assert from 'node:assert/strict'
import {
  detectFamily, autoTier, inferSpecialty, familyOverrides, resolveSpecialtyBlocks,
  TYPED_FULL, TYPED_CONDENSED, TYPED_KIMI_EXTRA, FAMILY_PATTERNS,
} from '../lib/specialization.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('模型特化（rc14 移植）')

/* ─────────────────── A. 家族识别 ─────────────────── */

check('detectFamily：八个家族 + generic，且顺序与上游一致', () => {
  assert.equal(detectFamily('claude-sonnet-4'), 'claude')
  assert.equal(detectFamily('anthropic/claude-3'), 'claude')
  assert.equal(detectFamily('gemini-3-flash'), 'gemini-flash')
  assert.equal(detectFamily('gemini-2.5-lite-preview'), 'gemini-flash')
  assert.equal(detectFamily('gemini-3-pro'), 'gemini')
  assert.equal(detectFamily('gpt-5'), 'gpt')
  assert.equal(detectFamily('openai/o4-mini'), 'gpt')
  assert.equal(detectFamily('grok-4'), 'grok')
  assert.equal(detectFamily('moonshot-v1'), 'kimi')
  assert.equal(detectFamily('glm-4.6'), 'glm')
  assert.equal(detectFamily('chatglm3'), 'glm')
  assert.equal(detectFamily('deepseek-v4-flash'), 'deepseek')
  assert.equal(detectFamily('my-local-model'), 'generic')
  assert.equal(detectFamily(''), 'generic')
  assert.equal(detectFamily(undefined), 'generic')
  // 顺序断言：flash 变体必须先于裸 gemini；claude 必须先于 anthropic/gpt 的宽匹配
  assert.equal(FAMILY_PATTERNS[0][0], 'claude')
  assert.ok(FAMILY_PATTERNS.findIndex(([f]) => f === 'gemini-flash') < FAMILY_PATTERNS.findIndex(([f]) => f === 'gemini'))
})

/* ─────────────────── B. 自动档位 ─────────────────── */

check('autoTier：家族与词元规则（含 deepseek / glm-5 两处例外）', () => {
  assert.equal(autoTier('grok', 'grok-4'), 'lite')
  assert.equal(autoTier('glm', 'glm-4.6'), 'lite')
  assert.equal(autoTier('glm', 'glm-5'), 'standard', 'glm-5 起不算 lite（上游例外）')
  assert.equal(autoTier('glm', 'chatglm-9'), 'standard')
  assert.equal(autoTier('gemini-flash', 'gemini-3-flash'), 'lite')
  assert.equal(autoTier('kimi', 'kimi-lite-v2'), 'lite', '非 deepseek + lite 词元 → lite')
  assert.equal(autoTier('kimi', 'moonshot-v1-mini'), 'lite')
  assert.equal(autoTier('deepseek', 'deepseek-v4-flash'), 'standard', 'deepseek 不吃 flash→lite（上游例外）')
  assert.equal(autoTier('claude', 'claude-sonnet'), 'full')
  assert.equal(autoTier('gpt', 'gpt-5'), 'full')
  assert.equal(autoTier('generic', 'my-local-model'), 'full', '未识别家族保守回退 full')
  assert.equal(autoTier('gemini', 'gemini-3-pro'), 'standard')
  assert.equal(autoTier('kimi', 'moonshot-v1'), 'standard')
  // 词元边界：`flashlight` 这类不该命中
  assert.equal(autoTier('kimi', 'flashlight-model'), 'standard')
  assert.equal(autoTier('kimi', 'kimi.flash.x'), 'lite', '点分/横线也算词元边界')
})

/* ─────────────────── C. 推断模式 ─────────────────── */

check('inferSpecialty：auto / 手动 / off', () => {
  assert.deepEqual(inferSpecialty('gemini-3-flash'), { tier: 'lite', family: 'gemini-flash', source: 'auto', probe: 'gemini-3-flash' })
  assert.deepEqual(inferSpecialty('claude-sonnet', 'standard'), { tier: 'standard', family: 'claude', source: 'manual', probe: 'claude-sonnet' })
  assert.deepEqual(inferSpecialty('claude-sonnet', 'off'), { tier: 'full', family: 'generic', source: 'manual', probe: 'claude-sonnet' })
  // 非法 mode 当 auto
  assert.equal(inferSpecialty('grok-4', 'bogus').tier, 'lite')
  // 空的探测串 → generic → full（默认不影响现状）
  assert.deepEqual(inferSpecialty(''), { tier: 'full', family: 'generic', source: 'auto', probe: '' })
})

/* ─────────────────── D. 家族块最小偏移 ─────────────────── */

check('familyOverrides：最小偏移（打字块替换 + 至多一条新增行）', () => {
  const flash = familyOverrides('gemini-flash')
  assert.equal(flash.typed, TYPED_CONDENSED, 'gemini-flash 应换精简打字块')
  assert.ok(flash.extraAfterPhase, '并补一条行文基调')
  const kimi = familyOverrides('kimi')
  assert.equal(kimi.typed, undefined, 'kimi 不替换整块，只在完整块后补一段')
  assert.equal(kimi.typedExtra, TYPED_KIMI_EXTRA)
  for (const family of ['claude', 'glm']) {
    const o = familyOverrides(family)
    assert.ok(o.extraAfterPhase, `${family} 应有一条家族行`)
    assert.equal(o.typed, undefined, `${family} 不该整块替换`)
  }
  for (const family of ['gemini', 'gpt', 'grok', 'deepseek', 'generic', 'nope']) {
    assert.deepEqual(familyOverrides(family), {}, `${family} 应无偏移`)
  }
})

check('resolveSpecialtyBlocks：打字块选择与家族行至多一条', () => {
  const flash = resolveSpecialtyBlocks('gemini-3-flash')
  assert.equal(flash.tier, 'lite')
  assert.equal(flash.typed, TYPED_CONDENSED)
  assert.ok(flash.extraLine.includes('行文基调'))
  const claude = resolveSpecialtyBlocks('claude-sonnet')
  assert.equal(claude.tier, 'full')
  assert.equal(claude.typed, TYPED_FULL, 'claude 用完整打字块')
  assert.ok(claude.extraLine.includes('场景不必有整齐的收尾'))
  const kimi = resolveSpecialtyBlocks('moonshot-v1')
  assert.ok(kimi.typed.startsWith(TYPED_FULL), 'kimi = 完整块 + 矛盾段')
  assert.ok(kimi.typed.includes('矛盾是正常状态'))
  assert.equal(kimi.extraLine, '', 'kimi 不该再有第二条新增行')
  const generic = resolveSpecialtyBlocks('')
  assert.equal(generic.tier, 'full')
  assert.equal(generic.typed, TYPED_FULL)
  assert.equal(generic.extraLine, '')
})

/* ─────────────────── E. 渲染落地 ─────────────────── */

const { renderRules } = await import('../lib/render.js')
const render = (specialization) => String(renderRules({
  im: { enabled: true, chunking: { maxChars: 40, maxMessages: 4 } },
  specialization,
  alterSystem: { enabled: false }, agency: { enabled: false }, schedulePreplan: { enabled: false },
}, { imActive: true }))

check('渲染：留空 = 完整打字块、无家族行（默认不影响现状）', () => {
  const text = render(undefined)
  assert.ok(text.includes('一张猫的贴图可能只是「看到了」'), '完整块应含猫贴图例子')
  assert.ok(!text.includes('行文基调：具体、不修饰'))
  assert.ok(!text.includes('矛盾是正常状态'))
})

check('渲染：gemini-flash → 精简块 + 家族行；且没有第二条新增行', () => {
  const text = render({ mode: 'auto', modelProbe: 'gemini-3-flash' })
  assert.ok(text.includes('真人打出来的聊天消息是朴素、具体、直接的'), '应使用精简版')
  assert.ok(!text.includes('一张猫的贴图可能只是「看到了」'), '精简版不带猫贴图延展')
  assert.ok(text.includes('行文基调：具体、不修饰'))
  assert.ok(!text.includes('场景不必有整齐的收尾'), '不该混入别的家族行')
})

check('渲染：claude 只补一条家族行；kimi 补矛盾段', () => {
  const claude = render({ mode: 'auto', modelProbe: 'claude-sonnet-4' })
  assert.ok(claude.includes('场景不必有整齐的收尾'))
  assert.ok(claude.includes('一张猫的贴图可能只是「看到了」'), 'claude 用完整打字块')
  const kimi = render({ mode: 'auto', modelProbe: 'moonshot-v1' })
  assert.ok(kimi.includes('矛盾是正常状态'))
  assert.ok(!kimi.includes('场景不必有整齐的收尾'))
})

console.log(`\n模型特化：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

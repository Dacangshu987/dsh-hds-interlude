/**
 * 日志内容脱敏与配置归一化的用例。
 *
 * ## 这一层为什么必须测
 *
 * 它的两个开关是**隐私开关**，上游默认都是关的。坏起来的方向很糟：
 * 把「默认关」写错成「默认开」（例如用 `!== false` 而不是 `=== true`），
 * 私聊内容就会静默地开始进日志——而这**不会报错**，只在别人看到日志时才暴露。
 * 所以这里每个方向都要钉：默认必须关、显式开才开、关掉时事件仍在但不带内容。
 *
 * 参考实现：上游 `1.0.1-rc50` 的 `Logging` 段（`src/logging.ts`）。
 *
 * 运行：node test/logging.test.mjs
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_LOGGING_CONFIG, resolveLoggingConfig, logPreview, describeWithPreview,
  normalizeBlindMode, blindModeEnabled, silenceCommandReceipt,
} from '../lib/logging.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const eq = (actual, expected, label) => assert.deepEqual(
  actual, expected,
  `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
)

console.log('日志脱敏')

/* ─────────────── A. 默认值（隐私开关必须默认关） ─────────────── */

check('默认值与上游一致：两个内容开关默认**关**', () => {
  eq(DEFAULT_LOGGING_CONFIG.logScriptPreview, false, '剧本预览默认关')
  eq(DEFAULT_LOGGING_CONFIG.logMessageContent, false, '消息内容默认关')
  eq(DEFAULT_LOGGING_CONFIG.level, 'info', '级别默认 info')
  eq(DEFAULT_LOGGING_CONFIG.previewLength, 500, '预览默认 500')
  // 空配置 / 坏配置都必须是「关」。
  for (const input of [undefined, null, {}, 'nope', 42, []]) {
    const cfg = resolveLoggingConfig(input)
    eq(cfg.logScriptPreview, false, `${JSON.stringify(input)} 应默认关（剧本）`)
    eq(cfg.logMessageContent, false, `${JSON.stringify(input)} 应默认关（消息）`)
  }
})

check('两个内容开关只有**显式 true** 才开', () => {
  const on = resolveLoggingConfig({ logging: { logScriptPreview: true, logMessageContent: true } })
  eq(on.logScriptPreview, true, '显式 true 开')
  eq(on.logMessageContent, true, '显式 true 开')
  // 真值但不是 true 的写法不算开——避免「字符串 true」「1」这类误开。
  for (const bad of ['true', 1, 'yes', {}]) {
    const cfg = resolveLoggingConfig({ logging: { logMessageContent: bad } })
    eq(cfg.logMessageContent, false, `${JSON.stringify(bad)} 不该算开`)
  }
})

/* ─────────────── B. 预览产出 ─────────────── */

check('logPreview：开关关着时返回空串（不是原文、也不是省略号）', () => {
  const cfg = resolveLoggingConfig({})
  eq(logPreview('她说了一句私聊内容', cfg), '', '消息：默认关')
  eq(logPreview('正文片段', cfg, 'script'), '', '剧本：默认关')
  eq(logPreview('', cfg), '', '空串仍是空串')
  eq(logPreview(undefined, cfg), '', 'undefined 安全')
  eq(logPreview(null, cfg), '', 'null 安全')
})

check('logPreview：开关打开后按种类分流（剧本与消息各自独立）', () => {
  const onlyMessage = resolveLoggingConfig({ logging: { logMessageContent: true } })
  assert.ok(logPreview('消息', onlyMessage, 'message').length > 0, '消息开关开着 → 出内容')
  eq(logPreview('正文', onlyMessage, 'script'), '', '剧本开关仍关 → 不出内容')
  const onlyScript = resolveLoggingConfig({ logging: { logScriptPreview: true } })
  assert.ok(logPreview('正文', onlyScript, 'script').length > 0, '剧本开关开着 → 出内容')
  eq(logPreview('消息', onlyScript, 'message'), '', '消息开关仍关 → 不出内容')
})

check('logPreview：压平换行（换行会把一条日志拆成多行）', () => {
  const cfg = resolveLoggingConfig({ logging: { logMessageContent: true } })
  eq(logPreview('第一行\n第二行\t带缩进', cfg), '第一行 第二行 带缩进', '空白压成单空格')
  eq(logPreview('  前后有空白  ', cfg), '前后有空白', '首尾去空白')
})

check('logPreview：按 previewLength 截断并加省略号', () => {
  const cfg = resolveLoggingConfig({ logging: { logMessageContent: true, previewLength: 50 } })
  const long = '字'.repeat(200)
  const out = logPreview(long, cfg)
  eq(out.length, 51, '50 个字符 + 一个省略号')
  assert.ok(out.endsWith('…'), '应以省略号收尾')
  // 恰好不超长时不加省略号。
  const exact = '字'.repeat(50)
  eq(logPreview(exact, cfg), exact, '正好等于上限不截断')
})

check('previewLength 夹到 50–4000，坏值回默认', () => {
  eq(resolveLoggingConfig({ logging: { previewLength: 1 } }).previewLength, 50, '下限 50')
  eq(resolveLoggingConfig({ logging: { previewLength: 99999 } }).previewLength, 4000, '上限 4000')
  eq(resolveLoggingConfig({ logging: { previewLength: 'x' } }).previewLength, 500, '坏值回默认')
  eq(resolveLoggingConfig({ logging: { previewLength: 120.6 } }).previewLength, 121, '取整')
})

/* ─────────────── C. 组合输出与级别兼容 ─────────────── */

check('describeWithPreview：关着时保留事件描述、只去掉内容', () => {
  const off = resolveLoggingConfig({})
  eq(
    describeWithPreview('角色会话写了正文但未调 interlude_say：s1', '私聊正文', off),
    '角色会话写了正文但未调 interlude_say：s1',
    '整条日志不该消失（否则排查时只剩一片安静）',
  )
  const on = resolveLoggingConfig({ logging: { logMessageContent: true } })
  eq(
    describeWithPreview('事件：s1', '内容', on),
    '事件：s1（预览：内容）',
    '开着时带上内容',
  )
})

check('级别归一化：logging.level 优先，兼容旧名 logLevel', () => {
  eq(resolveLoggingConfig({}).level, 'info', '默认')
  eq(resolveLoggingConfig({ logLevel: 'warn' }).level, 'warn', '旧名生效')
  eq(resolveLoggingConfig({ logLevel: 'warn', logging: { level: 'debug' } }).level, 'debug', 'logging 优先')
  eq(resolveLoggingConfig({ logging: { level: 'silent' } }).level, 'silent', '上游多一个 silent')
  eq(resolveLoggingConfig({ logging: { level: 'nope' } }).level, 'info', '坏值回默认')
})

check('其余字段：合法值保留，坏值回默认', () => {
  eq(resolveLoggingConfig({ logging: { verbosity: 'diagnostic' } }).verbosity, 'diagnostic')
  eq(resolveLoggingConfig({ logging: { verbosity: 'nope' } }).verbosity, 'standard')
  eq(resolveLoggingConfig({ logging: { format: 'compact' } }).format, 'compact')
  eq(resolveLoggingConfig({ logging: { colorTheme: 'light' } }).colorTheme, 'light')
  // 默认 true 的三项：显式 false 必须生效。
  eq(resolveLoggingConfig({ logging: { colors: false } }).colors, false, 'colors 可关')
  eq(resolveLoggingConfig({ logging: { kaomoji: false } }).kaomoji, false, 'kaomoji 可关')
  eq(resolveLoggingConfig({}).colors, true, '缺省为真')
})

/* ─────────────── D. 失明模式（沉浸运行） ─────────────── */

check('失明模式：默认关，且只有**显式 true** 才开', () => {
  eq(normalizeBlindMode({}).enabled, false, '默认关')
  eq(blindModeEnabled({}), false, '判定默认关')
  for (const input of [undefined, null, {}, 'nope', 42]) {
    eq(blindModeEnabled(input), false, `${JSON.stringify(input)} 应判为关`)
  }
  eq(blindModeEnabled({ blindMode: { enabled: true } }), true, '新名开启')
  // 真值但不是 true 的写法不算开——这是「静默一切」的开关，不能误开。
  for (const bad of ['true', 1, 'yes', {}]) {
    eq(blindModeEnabled({ blindMode: { enabled: bad } }), false, `${JSON.stringify(bad)} 不该算开`)
  }
})

check('失明模式：旧名 blackBox 任一为 true 即启用（上游兼容读旧配置）', () => {
  eq(blindModeEnabled({ blackBox: true }), true, '只写旧名也算开')
  eq(blindModeEnabled({ blindMode: { enabled: true }, blackBox: false }), true, '只写新名也算开')
  eq(blindModeEnabled({ blindMode: { enabled: true }, blackBox: true }), true, '都写')
  eq(blindModeEnabled({ blackBox: false }), false, '旧名 false 不算开')
  // 旧名同样只认显式 true。
  eq(blindModeEnabled({ blackBox: 1 }), false, '旧名非 true 不算开')
})

check('失明模式：心跳间隔夹到 1–1440，坏值回默认 10', () => {
  eq(normalizeBlindMode({}).healthReportMinutes, 10, '默认 10')
  eq(normalizeBlindMode({ blindMode: { healthReportMinutes: 0 } }).healthReportMinutes, 1, '下限 1')
  eq(normalizeBlindMode({ blindMode: { healthReportMinutes: 9999 } }).healthReportMinutes, 1440, '上限 1440')
  eq(normalizeBlindMode({ blindMode: { healthReportMinutes: 'x' } }).healthReportMinutes, 10, '坏值回默认')
  eq(normalizeBlindMode({ blindMode: { healthReportMinutes: 30 } }).healthReportMinutes, 30, '合法值保留')
  eq(normalizeBlindMode(null).enabled, false, '坏输入安全')
})

check('回执静默：非失明时原样返回，失明时只换文本', () => {
  const original = { kind: 'success', text: '详细回执' }
  eq(silenceCommandReceipt(original, false), original, '非失明模式原样透传（同一个对象）')
  const silenced = silenceCommandReceipt(original, true)
  assert.ok(silenced.text.includes('失明模式'), '失明模式换成静默提示')
  assert.ok(!silenced.text.includes('详细回执'), '不该泄漏原回执内容')
})

check('回执静默：**错误仍按错误返回**（否则失败会看起来像成功但没说）', () => {
  for (const kind of ['error']) {
    const out = silenceCommandReceipt({ kind, text: '失败了' }, true)
    eq(out.kind, 'error', '错误 kind 必须保留')
    assert.ok(out.text.includes('失明模式'), '文本仍换成提示')
  }
  // 非错误一律归为 success；缺 kind / 裸 undefined 也按 success 处理。
  eq(silenceCommandReceipt({ text: 'x' }, true).kind, 'success', '缺 kind 按成功')
  eq(silenceCommandReceipt(undefined, true).kind, 'success', 'undefined 安全')
  eq(silenceCommandReceipt(null, true).kind, 'success', 'null 安全')
  // 自定义提示可覆盖。
  eq(silenceCommandReceipt({ kind: 'success' }, true, '自定义').text, '自定义')
})

console.log(`\n日志脱敏：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

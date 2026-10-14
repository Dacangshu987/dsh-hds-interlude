/**
 * 配置面描述层（`lib/panel-schema.js`）的用例 —— rc52 面板重设计第 1 阶段。
 *
 * 这一层的价值全在**两条不变量**上，所以测试也主要钉它们：
 *   ① 每个 schema 段都必须有面板映射（否则 `planPanel` 抛错，不允许静默丢配置项）；
 *   ② 每个字段都要能推出一个控件类型（不能出现「画不出来」的字段）。
 *
 * 运行：node test/panel-schema.test.mjs
 */

import assert from 'node:assert/strict'

import { Config } from '../lib/schema.js'
import {
  describeConfig, planPanel, PANEL_SECTIONS, UPSTREAM_SECTION_ORDER,
} from '../lib/panel-schema.js'

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

const sections = describeConfig(Config)
const panel = planPanel(sections)

console.log('配置面描述层')

check('describeConfig：段数与 schema 顶层键数一致，且每段都有 fields 数组', () => {
  assert.equal(sections.length, Object.keys(Config({})).length, '段数应与顶层键数一致')
  assert.ok(sections.length >= 20, `段数偏少：${sections.length}`)
  for (const s of sections) {
    assert.ok(Array.isArray(s.fields), `${s.key} 缺 fields`)
  }
})

check('planPanel 不抛错 ⇒ 每个 schema 段都有面板映射（核心不变量）', () => {
  // planPanel 在遇到未映射的段时会抛；能走到这里就说明映射是完整的。
  const keys = new Set(panel.map((s) => s.key))
  for (const s of sections) assert.ok(keys.has(s.key), `${s.key} 没进面板结构`)
})

check('planPanel：未映射的段**必须抛错**（静默丢配置项是不可接受的）', () => {
  assert.throws(
    () => planPanel([{ key: '没映射过的段', fields: [] }]),
    /没有面板映射/,
    '未映射的段应抛错',
  )
})

check('控件类型推导：boolean→checkbox / number→number / union→select / object→group', () => {
  const find = (key, path) => {
    const section = sections.find((s) => s.key === key)
    let list = section.fields
    const parts = path.split('.')
    let node = null
    for (const part of parts) {
      node = list.find((f) => f.key === part)
      list = node?.fields ?? []
    }
    return node
  }
  assert.equal(find('weather', 'enabled').control, 'checkbox')
  assert.equal(find('weather', 'latitude').control, 'number')
  assert.equal(find('logging', 'level').control, 'select', '枚举应是下拉')
  assert.equal(find('presetSync', 'enabled').control, 'checkbox')
  assert.equal(find('im', 'dedupe').control, 'group', '深一层的对象作为整块')
})

check('字段带出默认值，且默认值与 schema 一致（不是猜的）', () => {
  const weather = sections.find((s) => s.key === 'weather')
  const byKey = Object.fromEntries(weather.fields.map((f) => [f.key, f]))
  const real = Config({}).weather
  assert.equal(byKey.enabled.default, real.enabled)
  assert.equal(byKey.latitude.default, real.latitude)
  assert.equal(byKey.cadenceMinutes.default, real.cadenceMinutes)
  assert.equal(byKey.skipFantasyWorld.default, real.skipFantasyWorld)
})

check('planPanel：按上游段顺序排队，自建段排在最后', () => {
  const orders = panel.map((s) => s.order)
  const sorted = [...orders].sort((a, b) => a - b)
  assert.deepEqual(orders, sorted, '应按上游顺序排序')
  // 排最后的应该是上游没有对应段的那些。
  const tail = panel.slice(-3).map((s) => s.key)
  for (const key of tail) {
    const up = PANEL_SECTIONS[key].upstream
    assert.ok(up === null || !UPSTREAM_SECTION_ORDER.includes(up), `${key} 不该排在末尾`)
  }
})

check('档位编号只给精确对应上游的段（自建段不贴编号）', () => {
  for (const s of panel) {
    if (s.own === true) assert.equal(s.numbered, false, `${s.key} 是自建段，不该有编号`)
  }
  // weather / presetSync 是上一轮刚对齐的上游段，应当有编号。
  assert.equal(panel.find((s) => s.key === 'weather').numbered, true)
  assert.equal(panel.find((s) => s.key === 'presetSync').numbered, true)
})

check('上游段顺序表包含本仓尚未实现的段（差距是显式的，不是被忘记）', () => {
  // 这些是上游有、本仓没有的：留着才看得见差距。
  for (const key of ['model', 'onebot', 'browser', 'qzone', 'sharedStory', 'chatActions']) {
    assert.ok(UPSTREAM_SECTION_ORDER.includes(key), `${key} 应留在上游顺序表里`)
  }
})

console.log(`\n配置面描述层：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

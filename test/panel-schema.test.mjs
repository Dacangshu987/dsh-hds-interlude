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
  describeConfig, planPanel, panelDescriptor, autoSections,
  getAt, setAt, mergeInto, PANEL_SECTIONS, UPSTREAM_SECTION_ORDER,
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

/* ───────── 服务端描述符（发给前端的那份） ───────── */

check('panelDescriptor：**可 JSON 传输**（前端要跨进程拿它）', () => {
  const d = panelDescriptor(Config)
  const json = JSON.stringify(d)
  assert.ok(json.length > 1000, `描述符太小，可能没带上字段：${json.length}`)
  const back = JSON.parse(json)
  assert.equal(back.sections.length, d.sections.length, '往返后段数不变')
  assert.equal(back.custom.length, d.custom.length)
  // 关键：往返后每个段的字段数与默认值都得还在——有函数/undefined 就会丢。
  for (const section of d.sections) {
    const same = back.sections.find((s) => s.key === section.key)
    assert.equal(same.fields.length, section.fields.length, `${section.key} 字段数往返不一致`)
    for (const f of section.fields) {
      const f2 = same.fields.find((x) => x.key === f.key)
      assert.ok(f2, `${section.key}.${f.key} 往返后丢了`)
      assert.equal(f2.control, f.control, `${section.key}.${f.key} 控件类型往返不一致`)
      assert.deepEqual(f2.default, f.default, `${section.key}.${f.key} 默认值往返不一致`)
    }
  }
})

check('panelDescriptor：自带自定义白名单与上游顺序表', () => {
  const d = panelDescriptor(Config)
  assert.ok(Array.isArray(d.custom) && d.custom.length >= 5, '应有自定义区块白名单')
  assert.ok(d.custom.includes('扫码绑定'), '扫码绑定必须手写')
  assert.ok(d.custom.includes('实时日志'), '实时日志必须手写')
  assert.deepEqual(d.upstreamOrder, UPSTREAM_SECTION_ORDER, '应带上游顺序表')
  assert.equal(d.version, 1, '带版本号，便于前端兼容')
})

check('自定义白名单与 schema 段**不重叠**（同一个区块不能两处都画）', () => {
  const d = panelDescriptor(Config)
  const schemaKeys = new Set(d.sections.map((s) => s.key))
  const overlap = d.custom.filter((name) => schemaKeys.has(name))
  assert.deepEqual(overlap, [], `这些名字既是 schema 段又在自定义白名单里：${JSON.stringify(overlap)}`)
})

/* ───────── 路径读写与深合并（生成式渲染的读写底座） ───────── */

check('getAt / setAt：按路径读写，且**不改原对象**（React 要靠新引用判等）', () => {
  const cfg = { weather: { latitude: 1, enabled: false }, logging: { level: 'info' } }
  assert.equal(getAt(cfg, 'weather.latitude'), 1)
  assert.equal(getAt(cfg, 'weather.nope'), undefined, '断在中途返回 undefined')
  assert.equal(getAt(cfg, 'nope.deep.deeper'), undefined, '根就不存在也不抛')
  assert.equal(getAt(cfg, ''), undefined)

  const next = setAt(cfg, 'weather.latitude', 42)
  assert.equal(getAt(next, 'weather.latitude'), 42)
  assert.equal(getAt(cfg, 'weather.latitude'), 1, '原对象不得被改')
  assert.notEqual(next, cfg, '必须返回新引用')
  assert.notEqual(next.weather, cfg.weather, '沿途对象也应是新的')

  // 顶层路径与中间层缺失的情况
  assert.equal(getAt(setAt(cfg, 'logging.level', 'warn'), 'logging.level'), 'warn')
  assert.equal(getAt(setAt({}, 'a.b.c', 1), 'a.b.c'), 1, '中间层缺失时自动建')
})

check('mergeInto：深合并，数组**整体替换**（不逐项合并）', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: true }
  const merged = mergeInto(base, { a: { y: 9 }, list: [3] })
  assert.deepEqual(merged, { a: { x: 1, y: 9 }, list: [3], keep: true })
  assert.equal(base.a.y, 2, '原对象不得被改')
  assert.deepEqual(merged.list, [3], '数组整体替换')
  // 一边不是对象时不硬合并（否则会把 42 展开成 {}）。
  assert.equal(mergeInto({ a: 42 }, { a: { b: 1 } }).a.b, 1)
  assert.equal(mergeInto({ a: { b: 1 } }, { a: 42 }).a, 42)
})

check('autoSections：只挑**没有手写实现**的段（手写段不许被重复画一遍）', () => {
  const d = panelDescriptor(Config)
  assert.equal(autoSections(d, d.sections.map((s) => s.key)).length, 0, '全都手写时就该没有自动段')
  const onlyOne = autoSections(d, d.sections.map((s) => s.key).filter((k) => k !== 'weather'))
  assert.deepEqual(onlyOne.map((s) => s.key), ['weather'], '只留下没手写的那个')
})

console.log(`\n配置面描述层：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

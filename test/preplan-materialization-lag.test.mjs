/**
 * Schedule Preplan 物化滞后防线测试（移植自上游 `1.0.1-rc13`）。
 *
 * 上游缺陷：每日审查 / 退避 / 推迟都可能让 `materializedDays` 的
 * [今天, 明天] 槽位缺失，而窗口计算只取 dayOffset 0..1 ——
 * 于是窗口**静默变空**：模型以为她没有日程，既不报错也不留痕。
 * 修复：取窗口前先本地无模型重物化一次（锚定今天）。
 *
 * 本仓实现刻意只**在内存里**重算（`schedulePreplanWindow` 同时被提示词渲染路径
 * 调用，从渲染里写状态会让纯投影带上副作用）；可观测结果与上游一致：
 * 窗口不再凭空变空。这里钉住该行为与「未滞后时零改动」两条。
 *
 * 运行：node test/preplan-materialization-lag.test.mjs
 */
import assert from 'node:assert/strict'
import { schedulePreplanWindow, materializeSchedulePreplan, resolveSchedulePreplanConfig } from '../lib/preplan.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

const TZ = 'Asia/Shanghai'
const WEEK = {
  monday: [{ id: 'm1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
  tuesday: [{ id: 't1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
  wednesday: [{ id: 'w1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
  thursday: [{ id: 'th1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
  friday: [{ id: 'f1', start: '09:00', end: '12:00', label: '上课', kind: 'fixed' }],
  saturday: [{ id: 'sa1', start: '10:00', end: '12:00', label: '打工', kind: 'fixed' }],
  sunday: [{ id: 'su1', start: '10:00', end: '12:00', label: '打工', kind: 'fixed' }],
}
const regime = (from) => ({ id: 'week', label: '日常', from, weekly: WEEK })

console.log('Schedule Preplan 物化滞后（rc13 移植）')

check('物化滞后（缺 [今天,明天]）→ 本地重物化，窗口不再静默变空', () => {
  // 今天 = 2026-09-11（周五）；materializedDays 只有上周的旧日子
  const now = new Date('2026-09-11T01:00:00Z') // 09:00 本地
  const record = {
    storyId: 's', timezone: TZ, revision: 1,
    regimes: [regime('2026-09-01')], exceptions: [],
    materializedDays: [{ date: '2026-09-04', blocks: [{ id: 'old', start: '10:00', end: '11:00', label: '旧日程' }] }],
  }
  const window = schedulePreplanWindow(record, now, TZ, 12, resolveSchedulePreplanConfig({}))
  assert.ok(window, '仍应给出窗口')
  assert.ok(window.blocks.length > 0, '重物化后窗口不该为空（这正是 rc13 修的缺陷）')
  assert.ok(window.blocks.some((b) => b.label === '上课'), `应含周五的「上课」，实际 ${JSON.stringify(window.blocks.map((b) => b.label))}`)
  // 纯函数：不得修改传入的 record
  assert.equal(record.materializedDays.length, 1, '不得就地修改 record（渲染路径只读）')
})

check('未滞后（已含今天或明天）→ 用既有物化天，零改动', () => {
  const now = new Date('2026-09-11T01:00:00Z')
  const record = {
    storyId: 's', timezone: TZ, revision: 1,
    regimes: [regime('2026-09-01')], exceptions: [],
    materializedDays: [{ date: '2026-09-11', blocks: [{ id: 'b', start: '10:00', end: '11:00', label: '例会' }] }],
  }
  const window = schedulePreplanWindow(record, now, TZ, 12, resolveSchedulePreplanConfig({}))
  assert.equal(window.blocks.length, 1)
  assert.equal(window.blocks[0].label, '例会', '不该被重物化的默认日程顶掉')
})

check('重物化结果仍覆盖不到今天（无匹配 regime）→ 沿用原数据、不抛错', () => {
  const now = new Date('2026-09-11T01:00:00Z')
  const record = {
    storyId: 's', timezone: TZ, revision: 1,
    regimes: [{ id: 'past', label: '过去的规律', from: '2026-08-01', to: '2026-08-31', weekly: WEEK }],
    exceptions: [],
    materializedDays: [],
  }
  const window = schedulePreplanWindow(record, now, TZ, 12, resolveSchedulePreplanConfig({}))
  assert.ok(window, '即便重物化也覆盖不到，也应给出（空）窗口而不是抛错')
  assert.deepEqual(window.blocks, [])
})

check('重物化函数本身：锚定今天能产出今天与明天', () => {
  const days = materializeSchedulePreplan([regime('2026-09-01')], [], '2026-09-11', 2)
  assert.deepEqual(days.map((d) => d.date), ['2026-09-11', '2026-09-12'])
})

console.log(`\nSchedule Preplan 物化滞后：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

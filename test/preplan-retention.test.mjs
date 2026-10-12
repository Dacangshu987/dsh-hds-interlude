/**
 * Schedule Preplan 保留策略与跨夜日程（移植自上游 `1.0.1-rc50`）。
 *
 * 上游 rc50 修了两类真实缺陷：
 *
 *   ① **跨夜安排午夜后消失**：`materializeSchedulePreplan` 从 `offset=0`（只今天）
 *      开始物化，值夜班（23:00–次日 07:00）/通宵出行在今天凌晨从日程里凭空消失；
 *      `schedulePreplanWindow` 又只接受 dayOffset 0..1，昨日段的剩余区间同样进不来。
 *   ② **今天的计划被未来阶段挤掉**：`regimes.slice(-6)` 按数组末位截断——
 *      模型新排一条未来阶段，就把今天的阶段挤出保留集；exceptions 的
 *      `slice(-30)` 同理。
 *
 * 保留策略走 `applySchedulePreplanProposal` 的 `extend` 路径（与每日审查一致）：
 * 既有记录原样带过 + 提议增量合并，最能反映线上真实形态。
 *
 * 运行：node test/preplan-retention.test.mjs
 */
import assert from 'node:assert/strict'
import {
  applySchedulePreplanProposal, materializeSchedulePreplan, schedulePreplanWindow, resolveSchedulePreplanConfig,
} from '../lib/preplan.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('Schedule Preplan 保留策略与跨夜（rc50 移植）')

const TZ = 'Asia/Shanghai'
const cfg = (over = {}) => resolveSchedulePreplanConfig({ horizonDays: 7, ...over })
const blk = (id, start, end, label = id, kind = 'fixed') => ({ id, start, end, label, kind })
const regime = (id, from, weekly = {}) => ({ id, label: id, from, weekly, sourceEntryIds: [1] })
/** `extend` 提议：只带增量（不触发 replace 的证据来源门槛）。 */
const extend = (regimes = [], exceptions = []) => ({ outcome: 'extend', reason: 'test', sourceEntryIds: [1], regimes, exceptions })
const evidence = [{ id: 1 }]

/* ─────────────── ① 跨夜安排 ─────────────── */

check('跨夜班次：昨日段在今天凌晨仍进入 12 小时窗口（rc50 核心）', () => {
  const night = regime('night', '2026-09-01', { monday: [blk('n1', '23:00', '07:00', '夜班')] })
  // 2026-09-08（周二）02:00 本地 —— 周一晚上的班次仍在进行中。
  const now = new Date('2026-09-07T18:00:00Z')
  const days = materializeSchedulePreplan([night], [], '2026-09-08', 2)
  assert.equal(days[0].date, '2026-09-07', '物化结果必须含昨日')
  const window = schedulePreplanWindow({
    storyId: 's', timezone: TZ, revision: 1, regimes: [night], exceptions: [], materializedDays: days,
  }, now, TZ, 12, cfg())
  assert.ok(window)
  assert.ok(window.blocks.some(b => b.label === '夜班'), `凌晨应看到昨晚的夜班，实际：${JSON.stringify(window.blocks)}`)
})

check('跨夜班次：昨天早已结束的普通块不会渗进窗口', () => {
  const classDay = regime('week', '2026-09-01', { monday: [blk('m1', '09:00', '12:00', '上课')] })
  const now = new Date('2026-09-07T18:00:00Z') // 09-08 02:00
  const days = materializeSchedulePreplan([classDay], [], '2026-09-08', 2)
  const window = schedulePreplanWindow({
    storyId: 's', timezone: TZ, revision: 1, regimes: [classDay], exceptions: [], materializedDays: days,
  }, now, TZ, 12, cfg())
  assert.ok(window)
  assert.ok(!window.blocks.some(b => b.label === '上课'), '周一上午的课在周二凌晨早结束了，不该出现')
})

/* ─────────────── ② 保留策略（regimes） ─────────────── */

check('保留策略：新加未来阶段不会把今天的阶段挤掉（rc50）', () => {
  const now = new Date('2026-09-11T02:00:00Z') // 09-11 10:00
  // 既有记录：今天生效的规律 + 5 条未来阶段。
  const current = {
    storyId: 's', revision: 3, timezone: TZ, validFrom: '2026-09-11', validThrough: '2026-09-17',
    lastReviewedLocalDate: '2026-09-10', lastEvidenceEntryId: 1, reviewReason: 'seed',
    regimes: [
      regime('r-today', '2026-09-01', { friday: [blk('f1', '20:00', '22:00', '今天的事')] }),
      ...Array.from({ length: 5 }, (_, i) => regime(`r-f${i}`, `2026-09-${20 + i}`, {})),
    ],
    exceptions: [], materializedDays: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  // 又新增 3 条更远的未来阶段 → 旧实现 slice(-6) 会把 r-today 挤出去。
  const record = applySchedulePreplanProposal(
    current,
    extend(Array.from({ length: 3 }, (_, i) => regime(`r-n${i}`, `2026-10-0${i + 1}`, {}))),
    evidence, '2026-09-11', TZ, cfg(), now,
  )
  assert.ok(record.regimes.some(r => r.id === 'r-today'), '今天生效的阶段必须留在保留集里')
  const today = record.materializedDays.find(d => d.date === '2026-09-11')
  assert.ok(today, '今天必须物化出来')
  assert.equal(today.blocks[0].label, '今天的事', '今天的日程块不能丢')
})

check('保留策略：未来阶段有数量上限（不会无限增长）', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const current = {
    storyId: 's', revision: 1, timezone: TZ, validFrom: '2026-09-11', validThrough: '2026-09-17',
    lastReviewedLocalDate: '2026-09-10', lastEvidenceEntryId: 1, reviewReason: 'seed',
    regimes: Array.from({ length: 12 }, (_, i) => regime(`r-f${String(i).padStart(2, '0')}`, `2026-09-${String(20 + i).padStart(2, '0')}`, {})),
    exceptions: [], materializedDays: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const record = applySchedulePreplanProposal(current, extend([]), evidence, '2026-09-11', TZ, cfg(), now)
  assert.ok(record.regimes.length <= 6, `未来阶段应被裁到 6 条以内，实际 ${record.regimes.length}`)
})

check('保留策略：已过期的历史阶段被裁掉（不留无用数据）', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const current = {
    storyId: 's', revision: 1, timezone: TZ, validFrom: '2026-09-11', validThrough: '2026-09-17',
    lastReviewedLocalDate: '2026-09-10', lastEvidenceEntryId: 1, reviewReason: 'seed',
    regimes: [
      { id: 'r-old', label: 'r-old', from: '2026-08-01', to: '2026-08-31', weekly: {}, sourceEntryIds: [1] },
      regime('r-today', '2026-09-01', { friday: [blk('f1', '20:00', '22:00')] }),
    ],
    exceptions: [], materializedDays: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const record = applySchedulePreplanProposal(current, extend([]), evidence, '2026-09-11', TZ, cfg(), now)
  assert.ok(!record.regimes.some(r => r.id === 'r-old'), '8 月就结束的阶段不该还占着名额')
  assert.ok(record.regimes.some(r => r.id === 'r-today'), '今天生效的留着')
})

/* ─────────────── ③ 保留策略（exceptions） ─────────────── */

check('保留策略：今天的例外不被大量未来例外挤掉', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const ex = (date, label) => ({ date, mode: 'replace', reason: label, blocks: [blk(`x-${date}`, '10:00', '11:00', label)], sourceEntryIds: [1] })
  const current = {
    storyId: 's', revision: 1, timezone: TZ, validFrom: '2026-09-11', validThrough: '2026-09-17',
    lastReviewedLocalDate: '2026-09-10', lastEvidenceEntryId: 1, reviewReason: 'seed',
    regimes: [regime('r-today', '2026-09-01', { friday: [blk('f1', '20:00', '22:00')] })],
    exceptions: [ex('2026-09-11', '今天改约')],
    materializedDays: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const record = applySchedulePreplanProposal(current, extend([], []), evidence, '2026-09-11', TZ, cfg(), now)
  assert.ok(record.exceptions.some(e => e.date === '2026-09-11'), '今天的例外必须保留')
  const today = record.materializedDays.find(d => d.date === '2026-09-11')
  assert.equal(today.blocks[0].label, '今天改约')
})

/* ─────────────── ④ 空提议判定 ─────────────── */

check('只有一次性安排（无重复规律）不算空提议——不能被整批丢弃（rc50）', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const exceptions = [{ date: '2026-09-11', mode: 'replace', reason: '今天请假', blocks: [blk('x', '10:00', '11:00', '休息')], sourceEntryIds: [1] }]
  const record = applySchedulePreplanProposal(
    undefined, { outcome: 'replace', reason: '只有一次性安排', sourceEntryIds: [1], regimes: [], exceptions },
    evidence, '2026-09-11', TZ, cfg(), now,
  )
  assert.ok(record, '不应返回 undefined（不能把只有一次性安排的提议当空提议丢弃）')
  assert.equal(record.exceptions.length, 1, '一次性安排应落盘')
  assert.equal(record.regimes.length, 0, '没有重复规律是合法的')
  const today = record.materializedDays.find(d => d.date === '2026-09-11')
  assert.ok(today, '今天必须物化出来')
  assert.equal(today.blocks[0].label, '休息')
})

check('真的什么都没有（无规律、无例外、无旧记录）→ 落一条空结论，等新证据', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const record = applySchedulePreplanProposal(
    undefined, { outcome: 'replace', reason: '没有日程证据', sourceEntryIds: [1], regimes: [], exceptions: [] },
    evidence, '2026-09-11', TZ, cfg(), now,
  )
  assert.ok(record)
  assert.equal(record.revision, 1)
  assert.deepEqual(record.regimes, [])
  assert.deepEqual(record.exceptions, [])
  assert.equal(record.lastEvidenceEntryId, 1)
})

console.log(`\nSchedule Preplan 保留策略：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

/**
 * 用户报时提取测试（上游 `1.0.1-rc13` 修复项：中文钟点「八点半」）。
 *
 * 覆盖面：
 *   A. `chineseClockNumber`：个位（八→8）、十（十→10）、十几（十一→11）、
 *      二十几（二十三→23）、无法解析 → undefined；
 *   B. 数字钟点：`18:30` / `18：30` / `18.30` / `6点30` / `6点半`；
 *   C. 歧义消解：带「下午/晚上」+12；裸钟点取**离当前故事时钟更近**的解释；
 *   D. 时段词映射（8/9/12/15/18/20）；
 *   E. **rc13 的核心断言**：`八点半` → 08:30（不是 08:00）；`八点` → 08:00；
 *   F. relation 判定（past / future / current，相对故事时钟）；
 *   G. 去重、上限 4 条、非法值丢弃、时区生效、空输入。
 *
 * 运行：node test/user-reported-times.test.mjs
 */
import assert from 'node:assert/strict'
import { extractUserReportedTimes, chineseClockNumber, PERIOD_HOURS, MAX_USER_REPORTED_TIMES } from '../lib/user-reported-times.js'
import { localClockMinutes, calendarDayKey } from '../lib/clock.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}
const TZ = 'Asia/Shanghai'
const clock = { localClockMinutes, calendarDayKey }
const run = (text, isoLocal) => extractUserReportedTimes(text, new Date(isoLocal), TZ, clock)
const times = (list) => list.map((f) => f.localTime.slice(11))

console.log('用户报时提取（rc13 移植）')

/* ─────────────────── A. 中文数字 ─────────────────── */

check('chineseClockNumber：个位/十/十几/二十几/无法解析', () => {
  assert.equal(chineseClockNumber('八'), 8)
  assert.equal(chineseClockNumber('两'), 2)
  assert.equal(chineseClockNumber('十'), 10)
  assert.equal(chineseClockNumber('十一'), 11)
  assert.equal(chineseClockNumber('二十三'), 23)
  assert.equal(chineseClockNumber('三十'), 30)
  assert.equal(chineseClockNumber('abc'), undefined)
  assert.equal(chineseClockNumber('八七'), undefined)
  assert.equal(chineseClockNumber(''), undefined)
  assert.equal(chineseClockNumber('八九十'), undefined)
})

/* ─────────────────── B. 数字钟点 ─────────────────── */

check('数字钟点：冒号/中文冒号/点号/「N点M分」/「N点半」', () => {
  assert.deepEqual(times(run('我18:30下班', '2026-09-28T10:00:00+08:00')), ['18:30'])
  assert.deepEqual(times(run('我18：30下班', '2026-09-28T10:00:00+08:00')), ['18:30'])
  assert.deepEqual(times(run('我18.30下班', '2026-09-28T10:00:00+08:00')), ['18:30'])
  // 上游口径：中文数字钟点分支**不做** 12 小时消歧（只有数字分支做），
  // 所以「六点三十」是 06:30；数字形态「18点30」本来就是 24 小时制。
  assert.deepEqual(times(run('六点三十开会', '2026-09-28T10:00:00+08:00')), ['06:30'])
  assert.deepEqual(times(run('18点30开会', '2026-09-28T10:00:00+08:00')), ['18:30'])
  // 数字裸钟点走「离当前故事时钟更近」的消歧：上午 10 点收到「6点半」→ 06:30
  assert.deepEqual(times(run('6点半开会', '2026-09-28T10:00:00+08:00')), ['06:30'])
  assert.deepEqual(times(run('6点半开会', '2026-09-28T18:00:00+08:00')), ['18:30'])
})

/* ─────────────────── C. 歧义消解 ─────────────────── */

check('带「下午/晚上」前缀 → 小时 +12；早上/上午不加', () => {
  // 注意：时段词分支还会**另补一条**同时刻的时段事实（statement 不同，故不会被
  // 去重掉——上游同样如此），断言时按去重后的钟点比较。
  const uniq = (list) => [...new Set(times(list))]
  assert.deepEqual(uniq(run('下午3点开会', '2026-09-28T10:00:00+08:00')), ['15:00'])
  assert.deepEqual(uniq(run('晚上8点见', '2026-09-28T10:00:00+08:00')), ['20:00'])
  // 时段词锚点与显式钟点**都会**留下：早上(8:00 锚点) + 7点 → 两条
  assert.deepEqual(uniq(run('早上7点跑步', '2026-09-28T10:00:00+08:00')), ['07:00', '08:00'])
  // 已经是 24 小时制就不再加
  assert.deepEqual(uniq(run('下午15点开会', '2026-09-28T10:00:00+08:00')), ['15:00'])
  // 去重键是「钟点 + 原话片段」：短句里时段词与显式钟点的原话片段相同，
  // 于是被折叠成一条——这是上游的既有口径（不是丢事实）。
  assert.equal(run('下午3点开会', '2026-09-28T10:00:00+08:00').length, 1)
})

check('裸钟点取**离当前故事时钟更近**的解释（上游 12 小时歧义规则）', () => {
  // 上午 9 点收到「6.30」→ 早上 06:30 更近（不是 18:30）
  assert.deepEqual(times(run('6.30见', '2026-09-28T09:00:00+08:00')), ['06:30'])
  // 傍晚 18 点收到「6.30」→ 18:30 更近
  assert.deepEqual(times(run('6.30见', '2026-09-28T18:00:00+08:00')), ['18:30'])
})

/* ─────────────────── D. 时段词 ─────────────────── */

check('时段词 → 代表性钟点（上游表 8/9/12/15/18/20）', () => {
  assert.deepEqual(PERIOD_HOURS, { 早上: 8, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20 })
  assert.deepEqual(times(run('中午一起吃饭', '2026-09-28T09:00:00+08:00')), ['12:00'])
  assert.deepEqual(times(run('傍晚散步', '2026-09-28T09:00:00+08:00')), ['18:00'])
})

/* ─────────────────── E. rc13 核心断言 ─────────────────── */

check('rc13 修复：中文钟点「八点半」→ 08:30，「八点」→ 08:00', () => {
  assert.deepEqual(times(run('我八点半开会', '2026-09-28T06:00:00+08:00')), ['08:30'],
    '此前被解析成 8:00 —— 这正是 rc13 修的缺陷')
  assert.deepEqual(times(run('我八点开会', '2026-09-28T06:00:00+08:00')), ['08:00'])
  assert.deepEqual(times(run('九点十五分到', '2026-09-28T06:00:00+08:00')), ['09:15'])
  assert.deepEqual(times(run('十点半睡', '2026-09-28T06:00:00+08:00')), ['10:30'])
  assert.deepEqual(times(run('二十三点睡', '2026-09-28T06:00:00+08:00')), ['23:00'])
})

/* ─────────────────── F. relation ─────────────────── */

check('relation 相对故事时钟：past / future / current', () => {
  const past = run('我八点半开会', '2026-09-28T10:00:00+08:00')
  assert.equal(past[0].relation, 'past')
  const future = run('我八点半开会', '2026-09-28T06:00:00+08:00')
  assert.equal(future[0].relation, 'future')
  const current = run('我八点整开会', '2026-09-28T08:00:00+08:00')
  assert.equal(current[0].relation, 'current')
  // localTime 带故事日期
  assert.equal(future[0].localTime.slice(0, 10), '2026-09-28')
})

/* ─────────────────── G. 边界 ─────────────────── */

check('去重 / 上限 4 条 / 非法值丢弃 / 空输入', () => {
  // 同一句话里同一钟点只记一次
  const dup = run('八点半开会，八点半见', '2026-09-28T06:00:00+08:00')
  assert.equal(dups(dup), 1)
  function dups(list) { return list.filter((f) => f.localTime.endsWith('08:30')).length }
  // 上限
  const many = run('1点2点3点4点5点6点各一次', '2026-09-28T00:00:00+08:00')
  assert.ok(many.length <= MAX_USER_REPORTED_TIMES, `最多 ${MAX_USER_REPORTED_TIMES} 条，实际 ${many.length}`)
  // 非法小时/分钟被丢弃
  assert.deepEqual(times(run('25:99开会', '2026-09-28T06:00:00+08:00')), [])
  assert.deepEqual(times(run('99点开会', '2026-09-28T06:00:00+08:00')), [])
  // 空输入
  assert.deepEqual(run('', '2026-09-28T06:00:00+08:00'), [])
  assert.deepEqual(extractUserReportedTimes(undefined, new Date(), TZ, clock), [])
})

check('时区生效：同一时刻在不同故事时区算出不同 relation', () => {
  // UTC 下 02:00 时，「八点半」是未来；Shanghai 下是 10:00（已过去）
  const at = new Date('2026-09-28T02:00:00Z')
  const utc = extractUserReportedTimes('我八点半开会', at, 'UTC', clock)
  const sha = extractUserReportedTimes('我八点半开会', at, 'Asia/Shanghai', clock)
  assert.equal(utc[0].relation, 'future')
  assert.equal(sha[0].relation, 'past')
})

check('缺时钟工具 → 明确抛错（不静默算错）', () => {
  assert.throws(() => extractUserReportedTimes('八点半', new Date(), TZ), /clock/)
})

console.log(`\n用户报时提取：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

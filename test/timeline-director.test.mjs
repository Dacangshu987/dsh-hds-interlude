/**
 * 时间导演主体（`lib/timeline-director.js`）的用例。
 *
 * 移植自上游 `src/service.ts` 的 `normalizeTimelinePlan` /
 * `describeTimelinePlanRejection`（DSH 形态：从捕获文本解析账本块）。
 * 要钉住：
 *   ① 只解析狭窄的账本形状——未知字段与空计划在成为世界状态来源之前被丢弃；
 *   ② at 宽容解析（数字/数字字符串/百分比），kind 近义映射；
 *   ③ beats 上限 4、carry 上限 4、summary 裁剪；
 *   ④ 账本块从正文剥离后正文保持原样。
 *
 * 运行：node test/timeline-director.test.mjs
 */
import assert from 'node:assert/strict'

import {
  normalizeTimelinePlan, coerceTimelinePosition, coerceTimelineKind,
  describeTimelinePlanRejection, renderTimelineDirectorRequest,
  parseTimelinePlanFromText, renderTimelineLedgerLine,
} from '../lib/timeline-director.js'

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

console.log('时间导演主体')

/* ------------------------------------------------------------ ① 位置/类型宽容解析 */

ok('coerceTimelinePosition：数字 / 字符串 / 百分比', () => {
  assert.equal(coerceTimelinePosition(0.5), 0.5)
  assert.equal(coerceTimelinePosition('0.5'), 0.5)
  assert.equal(coerceTimelinePosition('50%'), 0.5)
  assert.equal(coerceTimelinePosition('150%'), 1, '超过 100% 视为百分数折算后收敛到 1')
  assert.equal(coerceTimelinePosition(-1), 0, '收敛到 [0,1]')
  assert.equal(coerceTimelinePosition('abc'), Number.NaN)
  assert.equal(coerceTimelinePosition(undefined), Number.NaN)
})

ok('coerceTimelineKind：近义映射到三值，未知回退 activity', () => {
  assert.equal(coerceTimelineKind('scene'), 'activity')
  assert.equal(coerceTimelineKind('event'), 'activity')
  assert.equal(coerceTimelineKind('thought'), 'thought')
  assert.equal(coerceTimelineKind('心情'), 'thought')
  assert.equal(coerceTimelineKind('状态'), 'state')
  assert.equal(coerceTimelineKind('未来'), 'activity', '未知回退 activity')
  assert.equal(coerceTimelineKind(42), '')
})

/* ------------------------------------------------------------ ② 规范化 */

ok('normalizeTimelinePlan：合法账本通过（排序 + 裁剪）', () => {
  const plan = normalizeTimelinePlan({
    beats: [
      { at: '80%', kind: 'event', summary: '出门' },
      { at: 0.2, kind: 'thought', summary: '想起昨天的话' },
      { at: '50%', kind: 'scene', summary: '回到家' },
    ],
    carry: ['晚上有雨', '电脑没关'],
  })
  assert.ok(plan)
  assert.deepEqual(plan.beats.map((b) => b.at), [0.2, 0.5, 0.8], '按 at 升序')
  assert.deepEqual(plan.beats.map((b) => b.kind), ['thought', 'activity', 'activity'])
  assert.deepEqual(plan.carry, ['晚上有雨', '电脑没关'])
})

ok('normalizeTimelinePlan：空 beats / 缺 beats → undefined', () => {
  assert.equal(normalizeTimelinePlan({}), undefined)
  assert.equal(normalizeTimelinePlan({ beats: [] }), undefined)
  assert.equal(normalizeTimelinePlan({ beats: 'nope' }), undefined)
  assert.equal(normalizeTimelinePlan(null), undefined)
})

ok('normalizeTimelinePlan：节点缺字段被丢弃，全丢 → undefined', () => {
  assert.equal(normalizeTimelinePlan({ beats: [{ at: 'x', kind: 'y' }] }), undefined)
  assert.equal(normalizeTimelinePlan({ beats: [{ at: 0.5 }] }), undefined)
})

ok('normalizeTimelinePlan：超过 4 个节点裁剪到 4', () => {
  const beats = Array.from({ length: 8 }, (_, i) => ({ at: i / 10, kind: 'activity', summary: `s${i}` }))
  const plan = normalizeTimelinePlan({ beats })
  assert.equal(plan.beats.length, 4)
})

ok('normalizeTimelinePlan：summary 裁剪到 240', () => {
  const plan = normalizeTimelinePlan({ beats: [{ at: 0.5, kind: 'activity', summary: 'x'.repeat(300) }] })
  assert.equal(plan.beats[0].summary.length, 240)
})

ok('normalizeTimelinePlan：carry 裁剪/过滤/上限 4', () => {
  const plan = normalizeTimelinePlan({
    beats: [{ at: 0.5, kind: 'activity', summary: 's' }],
    carry: ['a'.repeat(300), '', 42, 'b', 'c', 'd', 'e'],
  })
  assert.deepEqual(plan.carry, ['a'.repeat(180), 'b', 'c', 'd'])
})

/* ------------------------------------------------------------ ③ 拒绝诊断 */

ok('describeTimelinePlanRejection：逐步给出原因', () => {
  assert.equal(describeTimelinePlanRejection('junk'), '返回不是 JSON 对象')
  assert.equal(describeTimelinePlanRejection({}), '缺少 beats 数组')
  assert.equal(describeTimelinePlanRejection({ beats: [] }), 'beats 为空数组（模型未产出任何节点）')
  const detail = describeTimelinePlanRejection({ beats: [{ at: 'bad', kind: 'activity', summary: 's' }] })
  assert.ok(detail.includes('无法解析'), 'at 解析失败要写明')
})

/* ------------------------------------------------------------ ④ 提示与解析 */

ok('renderTimelineDirectorRequest：包含 JSON 契约与 <timeline_plan> 标签', () => {
  const text = renderTimelineDirectorRequest()
  assert.ok(text.includes('<timeline_plan>'))
  assert.ok(text.includes('"beats"'))
  assert.ok(text.includes('"activity|thought|state"'))
})

ok('parseTimelinePlanFromText：提取块并剥离，正文原样', () => {
  const body = '她推开门，屋里灯还亮着。'
  const text = `<timeline_plan>{"beats":[{"at":"0.5","kind":"scene","summary":"回到家"}]}</timeline_plan>\n${body}`
  const { plan, body: rest, raw } = parseTimelinePlanFromText(text)
  assert.ok(plan)
  assert.equal(plan.beats.length, 1)
  assert.equal(rest, body, '正文保持原样')
  assert.ok(raw)
})

ok('parseTimelinePlanFromText：无块 → plan undefined、正文原样', () => {
  const { plan, body, raw } = parseTimelinePlanFromText('纯正文没有账本')
  assert.equal(plan, undefined)
  assert.equal(body, '纯正文没有账本')
  assert.equal(raw, undefined)
})

ok('parseTimelinePlanFromText：块内非法 JSON → raw 带 _unparsed、plan undefined', () => {
  const { plan, body, raw } = parseTimelinePlanFromText('<timeline_plan>{"beats":[{"at":"x"</timeline_plan>\n正文')
  assert.equal(plan, undefined)
  assert.equal(body, '正文')
  assert.ok(raw._unparsed)
})

ok('parseTimelinePlanFromText：块解析成功但内容非法 → plan undefined、块仍剥离', () => {
  const { plan, body } = parseTimelinePlanFromText('<timeline_plan>{"beats":[]}</timeline_plan>\n正文')
  assert.equal(plan, undefined)
  assert.equal(body, '正文')
})

ok('renderTimelineLedgerLine：账本投影为一行；空账本为空串', () => {
  const line = renderTimelineLedgerLine({
    beats: [{ at: 0.5, kind: 'activity', summary: '出门散步' }],
    carry: ['晚上有雨'],
  })
  assert.ok(line.includes('50% activity: 出门散步'))
  assert.ok(line.includes('Carry: 晚上有雨'))
  assert.equal(renderTimelineLedgerLine(undefined), '')
  assert.equal(renderTimelineLedgerLine({ beats: [] }), '')
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

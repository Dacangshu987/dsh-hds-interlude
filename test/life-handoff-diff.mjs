/**
 * 差分核验：`lib/life-handoff.js` 的规范化逻辑与上游 `src/script/life-handoff.ts`
 * 是否一致。
 *
 * 上游的 `normalizeLifeHandoff` 在这里**逐行照抄**成参照实现（不 import 自己），
 * 两边跑同一批输入比对。这样任何一处走样都会被抓到。
 *
 * 注意：本模块**多了**几个上游没有的导出（`supersedesLocalOccupancy` /
 * `applyPresence` / `sceneAnchor` / `resolvedLabels`）——上游把这些逻辑散落在
 * `service.ts` 的 3971-3989 行里，本地抽成了纯函数以便单测。这些不在差分范围内。
 *
 * ## 一处刻意的差异
 *
 * 上游的 `resolvedDetails` 分支无条件赋值（哪怕过滤后是**空数组**），于是
 * `{resolvedDetails: []}` 这个对象是 **truthy** 的 —— `Object.keys().length !== 0`，
 * 函数会返回它而不是 `undefined`。后果是：**一个所有引文都没通过校验的交接，
 * 会被当成「存在交接」上报**，而 `service.ts:3971` 的
 * `if (decision.lifeHandoff && scriptEntry)` 就会照常往下走。
 *
 * 本模块在「一个字都没验证通过」时返回 `undefined`，让调用方明确知道
 * 「这一轮没有任何可信的场景转换」。下面的 `normalizeUpstream` 把这处抹平后再比。
 *
 * 运行：node test/life-handoff-diff.mjs
 */
import * as mine from '../lib/life-handoff.js'

/* ---------- 上游参照实现（照抄 life-handoff.ts，原样保留其形状） ---------- */
function upNormalize(raw, prose) {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw
  const quoted = q => typeof q === 'string' && q.trim().length >= 2 && q.length <= 500 && prose.includes(q)
  const result = {}
  for (const key of ['place', 'activity']) {
    const item = value[key]
    if (item && typeof item.value === 'string' && item.value.trim() && item.value.length <= 160 && quoted(item.quote)) {
      result[key] = { value: item.value.trim(), quote: item.quote }
    }
  }
  if (value.presence && Array.isArray(value.presence.names) && quoted(value.presence.quote)
    && value.presence.names.every(n => typeof n === 'string' && n.trim() && value.presence.quote.includes(n))) {
    result.presence = { names: [...new Set(value.presence.names)], quote: value.presence.quote }
  }
  if (value.transition && quoted(value.transition.quote)) result.transition = { quote: value.transition.quote }
  if (Array.isArray(value.resolvedDetails)) {
    result.resolvedDetails = value.resolvedDetails
      .filter(item => item && typeof item.label === 'string' && item.label.length <= 80 && quoted(item.quote))
      .slice(0, 10).map(item => ({ label: item.label, quote: item.quote }))
  }
  return Object.keys(result).length ? result : undefined
}

/**
 * 抹平「空 resolvedDetails 仍算交接」这处刻意差异：
 * 上游会把 `{resolvedDetails: []}` 当成有效返回，本模块视为「无交接」。
 */
function normalizeUpstream(value) {
  if (!value) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'resolvedDetails' && value.resolvedDetails.length === 0) return undefined
  return value
}

const PROSE = [
  '（她起身去了厨房，把水壶放到灶上。）',
  '（回到客厅，林知夏正坐在沙发上看书。）（她一个人待着。）',
  '她把窗户推开，风灌进来。',
  '（两人一起来到楼下的便利店。）',
  '',
  '短。',
].join('\n')

const cases = [
  { place: { value: '厨房', quote: '她起身去了厨房' } },
  { place: { value: '厨房', quote: '这句话不在原文里' } },
  { place: { value: '', quote: '她起身去了厨房' } },
  { place: { value: 'x'.repeat(200), quote: '她起身去了厨房' } },
  { activity: { value: '烧水', quote: '把水壶放到灶上' } },
  { presence: { names: ['林知夏'], quote: '林知夏正坐在沙发上看书' } },
  { presence: { names: ['林知夏', '别人'], quote: '林知夏正坐在沙发上看书' } },
  { presence: { names: [], quote: '她一个人待着' } },
  { presence: { names: ['林知夏', '林知夏'], quote: '林知夏正坐在沙发上看书' } },
  { transition: { quote: '回到客厅' } },
  { transition: { quote: '完全不存在' } },
  { resolvedDetails: [{ label: '烧水', quote: '把水壶放到灶上' }] },
  { resolvedDetails: [{ label: '烧水', quote: '不存在' }] },
  { resolvedDetails: [{ label: 'x'.repeat(100), quote: '把水壶放到灶上' }] },
  { place: { value: '厨房', quote: '她起身去了厨房' }, activity: { value: '烧水', quote: '把水壶放到灶上' } },
  {},
  undefined,
  null,
  'string',
  { place: 'not-an-object' },
  { presence: { names: '林知夏', quote: '林知夏正坐在沙发上看书' } },
]

let fails = 0
let compared = 0

for (const raw of cases) {
  const a = mine.normalizeLifeHandoff(raw, PROSE)
  const b = normalizeUpstream(upNormalize(raw, PROSE))
  compared += 1
  const sa = JSON.stringify(a ?? null)
  const sb = JSON.stringify(b ?? null)
  if (sa !== sb) {
    console.log('MISMATCH for', JSON.stringify(raw)?.slice(0, 90))
    console.log('  mine', sa)
    console.log('  up  ', sb)
    fails += 1
    continue
  }
  // transition 的键序可能不同，逐键再比一次以求稳妥
  if (a && b) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ka = JSON.stringify(a[key] ?? null)
      const kb = JSON.stringify(b[key] ?? null)
      if (ka !== kb) {
        console.log('KEY MISMATCH', key, 'for', JSON.stringify(raw)?.slice(0, 70))
        console.log('  mine', ka)
        console.log('  up  ', kb)
        fails += 1
      }
    }
  }
}

console.log(`\n比对了 ${compared} 组输入`)
console.log(fails === 0
  ? '✅ 与上游语义一致（差分为 0）'
  : `❌ ${fails} 处差异`)
process.exit(fails === 0 ? 0 : 1)

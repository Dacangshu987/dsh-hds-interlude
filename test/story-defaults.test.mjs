/**
 * 剧本起点与上游 `StoryDefaults` 的对齐用例。
 *
 * ## 这个测试要证明什么
 *
 * 上游 `StoryDefaults` 是**扁平 12 字段**；本仓历史上是三层嵌套
 * （`character` / `world` / `counterpart` / `plot`），全仓约 78 处读取点依赖嵌套形态。
 *
 * 全量扁平化要改 15 个文件，风险与收益不成比例。采用的折中是：
 *
 *   - **配置面暴露上游扁平名**（便于上游形状的配置直接可用，前端也照上游命名）；
 *   - **内部读取仍是嵌套形态** —— 由 `normalizeStory()` 做双向翻译。
 *
 * 这一层坏起来是**静默**的：翻译错了不会抛错，只会让角色的名字、关系或文风
 * 悄无声息地变成空——用户那边表现为「我明明配了，她怎么不记得我是谁」。
 * 所以两个方向都要钉住。
 *
 * 另外两个字段是**上游有、本仓原先没有**的能力，也在这里钉住：
 *   - `perspectives[]`：多条独立价值观，**进提示词时保持独立条目不合并**
 *   - `supplementaryFacts[]`：补充事实，作为初始长期事实注入
 *
 * 运行：node test/story-defaults.test.mjs
 */

import assert from 'node:assert/strict'

import Schema from '@deepseek-ai/schemastery'

import { normalizeStory, renderCanon } from '../lib/render.js'
import { Story as StorySchema } from '../lib/schema.js'

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

/* ─────────────────── A. 上游扁平形态 → 内部嵌套形态 ─────────────────── */

console.log('剧本起点：上游 StoryDefaults 对齐')

check('上游扁平名全部被认识（12 个字段一个不落）', () => {
  const n = normalizeStory({
    characterName: '江柚',
    characterProfile: '设计师，作息乱。',
    perspective: '不相信空头承诺。',
    perspectives: ['对熟人反而更客气', '有话直说但不伤人'],
    supplementaryFacts: ['怕黑', '左耳有点背'],
    userProfile: '老同学，做游戏。',
    relationship: '熟悉但近来联系不多。',
    world: '2026 年的杭州。',
    supportingCast: '小鹿：同事。',
    location: '城西。',
    style: '克制写实。',
  })
  assert.equal(n.character.name, '江柚', 'characterName')
  assert.equal(n.character.profile, '设计师，作息乱。', 'characterProfile')
  assert.equal(n.perspective, '不相信空头承诺。', 'perspective')
  assert.deepEqual(n.perspectives, ['对熟人反而更客气', '有话直说但不伤人'], 'perspectives')
  assert.deepEqual(n.supplementaryFacts, ['怕黑', '左耳有点背'], 'supplementaryFacts')
  assert.equal(n.counterpart.profile, '老同学，做游戏。', 'userProfile → counterpart.profile')
  assert.equal(n.counterpart.initial, '熟悉但近来联系不多。', 'relationship → counterpart.initial')
  assert.equal(n.world.setting, '2026 年的杭州。', 'world → world.setting')
  assert.equal(n.world.supportingCast, '小鹿：同事。', 'supportingCast')
  assert.equal(n.world.location, '城西。', 'location')
  assert.equal(n.plot.style, '克制写实。', 'style → plot.style')
})

check('旧嵌套形态原样可用（不停用既有配置）', () => {
  const n = normalizeStory({
    character: { name: '阿柚', profile: '老形态人设', speech: '口头禅' },
    world: { setting: '老世界', location: '老地点', supportingCast: '老配角' },
    counterpart: { profile: '老对手', initial: '老关系' },
    plot: { startingPoint: '老起点', style: '老文风', boundaries: '老禁则', keywords: ['加班'] },
  })
  assert.equal(n.character.name, '阿柚')
  assert.equal(n.character.speech, '口头禅', '本仓专有字段：说话风格')
  assert.equal(n.world.setting, '老世界')
  assert.equal(n.world.supportingCast, '老配角')
  assert.equal(n.counterpart.profile, '老对手')
  assert.equal(n.counterpart.initial, '老关系')
  assert.equal(n.plot.startingPoint, '老起点')
  assert.equal(n.plot.style, '老文风')
  assert.equal(n.plot.boundaries, '老禁则')
  assert.deepEqual(n.plot.keywords, ['加班'])
})

check('两种形态混用：上游名优先，旧名回退', () => {
  const n = normalizeStory({
    characterName: '上游名',
    character: { name: '旧名', profile: '旧人设', speech: '旧说话风格' },
    world: { setting: '旧世界' }, // 对象 → 旧形态
  })
  assert.equal(n.character.name, '上游名', '同名字段以上游名优先')
  assert.equal(n.character.profile, '旧人设', '上游没给的字段回退旧名')
  assert.equal(n.character.speech, '旧说话风格', '本仓专有字段照常取')
  assert.equal(n.world.setting, '旧世界')
})

check('world 是字符串时等价于 setting（上游形态）', () => {
  assert.equal(normalizeStory({ world: '2026 年杭州' }).world.setting, '2026 年杭州')
  // 字符串与对象并存时（不该发生，但要可预测）：对象形态优先。
  assert.equal(
    normalizeStory({ world: { setting: '对象形态' } }).world.setting,
    '对象形态',
  )
})

check('空值与坏输入安全：不抛错，产出可直接渲染的嵌套空壳', () => {
  for (const bad of [undefined, null, 'not-an-object', 42, [], { character: 'bad' }, { world: 7 }]) {
    const n = normalizeStory(bad)
    assert.ok(n && typeof n === 'object', '归一化必须返回对象')
    assert.equal(typeof n.character.name, 'string')
    assert.equal(typeof n.world.setting, 'string')
    assert.equal(typeof n.plot.style, 'string')
    assert.ok(Array.isArray(n.perspectives))
    assert.ok(Array.isArray(n.supplementaryFacts))
    assert.ok(Array.isArray(n.plot.keywords))
  }
})

check('默认主角名与默认文风：上游默认值被保留', () => {
  const n = normalizeStory({})
  assert.equal(n.character.name, 'Unnamed character', '未命名主角用上游默认名')
  assert.equal(n.plot.style, '现实主义日常叙事，情绪克制，关系变化缓慢而具体。', '默认文风')
})

check('数组字段剔除空项（用户留空行不该变成空条目）', () => {
  const n = normalizeStory({ perspectives: ['有效', '', '   ', null, 42], supplementaryFacts: ['  '] })
  assert.deepEqual(n.perspectives, ['有效'])
  assert.deepEqual(n.supplementaryFacts, [])
})

/* ─────────────────── B. 渲染落地 ─────────────────── */

check('renderCanon：直接吃上游扁平形态也能渲染身份段', () => {
  const text = renderCanon({
    characterName: '江柚',
    characterProfile: '设计师',
    world: '2026 年杭州',
    location: '城西',
    userProfile: '老同学',
    relationship: '熟悉但近来联系不多',
    style: '克制写实',
  })
  assert.ok(text.includes('- 主角：江柚'))
  assert.ok(text.includes('- 人设：设计师'))
  assert.ok(text.includes('- 世界观：2026 年杭州'))
  assert.ok(text.includes('- 主要地点：城西'))
  assert.ok(text.includes('- 对话者背景：老同学'))
  assert.ok(text.includes('- 初始关系：熟悉但近来联系不多'))
  assert.ok(text.includes('- 文风：克制写实'))
})

check('renderCanon：多条价值观保持**独立条目**、不合并（上游口径）', () => {
  const text = renderCanon({
    characterName: '江柚',
    perspectives: ['不相信空头承诺', '对熟人反而更客气'],
    supplementaryFacts: ['怕黑', '左耳有点背'],
  })
  const lines = text.split('\n')
  assert.ok(lines.includes('- 主角的价值观（独立条目）：不相信空头承诺'), '第一条独立成行')
  assert.ok(lines.includes('- 主角的价值观（独立条目）：对熟人反而更客气'), '第二条独立成行')
  assert.ok(lines.includes('- 补充事实：怕黑'))
  assert.ok(lines.includes('- 补充事实：左耳有点背'))
  // 不能把两条拼成一段。
  assert.ok(!lines.some(l => l.includes('不相信空头承诺') && l.includes('对熟人反而更客气')), '不该合并')
})

/* ─────────────────── C. schema 接受两种形态 ─────────────────── */

const parseStory = (input) => Schema(StorySchema)(input)

check('schema：上游扁平字段可解析，两个新数组默认空数组', () => {
  const parsed = parseStory({
    characterName: '江柚',
    world: '2026 年杭州',
    perspectives: ['A', 'B'],
    supplementaryFacts: ['怕黑'],
  })
  assert.equal(parsed.characterName, '江柚')
  assert.equal(parsed.world, '2026 年杭州', 'world 保持字符串（上游形态）')
  assert.deepEqual(parsed.perspectives, ['A', 'B'])
  assert.deepEqual(parsed.supplementaryFacts, ['怕黑'])
  const empty = parseStory({})
  assert.deepEqual(empty.perspectives, [])
  assert.deepEqual(empty.supplementaryFacts, [])
})

check('schema：world 默认是**对象**形态（约 78 处读取点直接读 world.setting）', () => {
  const parsed = parseStory({})
  assert.equal(typeof parsed.world, 'object')
  assert.equal(parsed.world.setting, '', '默认值必须是可读的对象，不能是 undefined')
  assert.equal(parsed.world.location, '')
  assert.equal(parsed.world.supportingCast, '')
  // 对象形态照旧。
  assert.equal(parseStory({ world: { setting: '老世界' } }).world.setting, '老世界')
})

console.log(`\n剧本起点对齐：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

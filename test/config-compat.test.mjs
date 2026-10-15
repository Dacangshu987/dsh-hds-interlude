/**
 * 配置改名兼容层（`lib/config-compat.js`）的用例 —— 第 3 阶段的安全前提。
 *
 * 这一层存在的唯一理由：**用户 profile 里已经有旧写法，改名不能让它失效**。
 * 所以测试的重点不是「函数会不会算」，而是**两种写法会不会得到同一个结果**。
 *
 * 运行：node test/config-compat.test.mjs
 */

import assert from 'node:assert/strict'

import { RENAMED_KEYS, normalizeConfigAliases, readAliased } from '../lib/config-compat.js'

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

const STORY = { character: { name: '大傻鱼', profile: '蓝发蓝瞳的鲸鱼娘' }, plot: { style: '日常互怼' } }

console.log('配置改名兼容层')

check('只写旧名（用户 profile 现状）→ 新名也被填上，且值一致', () => {
  const out = normalizeConfigAliases({ story: STORY, timeZone: 'Asia/Shanghai' })
  assert.deepEqual(out.storyDefaults, STORY, '新名应被填上')
  assert.deepEqual(out.story, STORY, '旧名保留')
  assert.equal(out.timeZone, 'Asia/Shanghai', '其它键不受影响')
})

check('只写新名（改完之后）→ 旧名也被填上，旧读取点照常工作', () => {
  const out = normalizeConfigAliases({ storyDefaults: STORY })
  assert.deepEqual(out.story, STORY, '旧名应被填上（迁移期旧读取点还在）')
  assert.deepEqual(out.storyDefaults, STORY)
})

check('两个都写且冲突 → **新名赢**，并把旧名对齐（不留两处不一致）', () => {
  const out = normalizeConfigAliases({ story: { character: { name: '旧的' } }, storyDefaults: STORY })
  assert.deepEqual(out.storyDefaults, STORY, '新名赢')
  assert.deepEqual(out.story, STORY, '旧名被对齐成新名的值——不能留下两个不一致的副本')
})

check('两个都没写 → 不凭空造键（否则会给下游一个空对象、掩盖「没配置」）', () => {
  const out = normalizeConfigAliases({ timeZone: 'UTC' })
  assert.equal('story' in out, false)
  assert.equal('storyDefaults' in out, false)
})

check('不修改入参（配置对象在别处还在用）', () => {
  const input = { story: STORY }
  const snapshot = JSON.stringify(input)
  normalizeConfigAliases(input)
  assert.equal(JSON.stringify(input), snapshot, '入参被改了')
})

check('幂等：归一化两次与一次结果相同', () => {
  const once = normalizeConfigAliases({ story: STORY })
  const twice = normalizeConfigAliases(once)
  assert.deepEqual(twice, once)
})

check('坏输入不抛（配置可能来自 YAML 的任意形态）', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    const out = normalizeConfigAliases(bad)
    assert.equal(typeof out, 'object', `${JSON.stringify(bad)} 应回空对象`)
  }
})

check('readAliased：新名优先、回退旧名、都没有返回 undefined', () => {
  assert.deepEqual(readAliased({ storyDefaults: STORY }, 'story'), STORY)
  assert.deepEqual(readAliased({ story: STORY }, 'story'), STORY)
  assert.deepEqual(readAliased({ story: STORY, storyDefaults: STORY }, 'story'), STORY)
  assert.equal(readAliased({}, 'story'), undefined)
  // 未登记的键按原样读（不静默返回 undefined，否则调用方会以为「没配置」）。
  assert.equal(readAliased({ other: 1 }, 'other'), 1)
})

check('带 defaults：**旧名是用户写的、新名只是 schema 默认值** → 用旧名（不能压掉用户配置）', () => {
  // 这是实测踩到的坑：改名后配置里只有旧名时，宿主会给新名填上默认值——
  // 简单规则「新名赢」会拿默认值把用户真正的配置压掉（主角名变成 Unnamed character）。
  const defaults = { story: { character: { name: 'Unnamed character' } }, storyDefaults: { character: { name: 'Unnamed character' } } }
  const out = normalizeConfigAliases(
    { story: { character: { name: '大傻鱼' } }, storyDefaults: { character: { name: 'Unnamed character' } } },
    { defaults },
  )
  assert.equal(out.story.character.name, '大傻鱼', '用户写的旧名必须赢')
  assert.equal(out.storyDefaults.character.name, '大傻鱼', '并把旧名对齐')
})

check('带 defaults：新名是用户写的、旧名是默认值 → 用新名', () => {
  const defaults = { story: { v: 'd' }, storyDefaults: { v: 'd' } }
  const out = normalizeConfigAliases({ story: { v: 'd' }, storyDefaults: { v: 'n' } }, { defaults })
  assert.equal(out.story.v, 'n')
  assert.equal(out.storyDefaults.v, 'n')
})

check('带 defaults：两个都不是默认值 → 仍是新名赢（改名后的规范名优先）', () => {
  const defaults = { story: { v: 'd' }, storyDefaults: { v: 'd' } }
  const out = normalizeConfigAliases({ story: { v: 'old' }, storyDefaults: { v: 'new' } }, { defaults })
  assert.equal(out.storyDefaults.v, 'new')
  assert.equal(out.story.v, 'new')
})

check('不带 defaults：退回「新名优先」（调用方明确知道没有默认值填充时可用）', () => {
  const out = normalizeConfigAliases({ story: { v: 'old' }, storyDefaults: { v: 'new' } })
  assert.equal(out.story.v, 'new')
})

check('改名对表是唯一来源（键名只在这里出现一次）', () => {
  assert.deepEqual(Object.keys(RENAMED_KEYS), ['story'])
  assert.equal(RENAMED_KEYS.story, 'storyDefaults')
})

console.log(`\n配置改名兼容层：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

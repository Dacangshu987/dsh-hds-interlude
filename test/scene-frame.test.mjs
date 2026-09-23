/**
 * 确定性场景帧（`lib/scene-frame.js`）的用例。
 *
 * 这一层守住的是三条铁律（文件头注释里有详细理由）：
 *   ① 不调用模型、**不用时间改变帧身份**；
 *   ② 每轮从事实源重新投影，不在旧帧上增量修改；
 *   ③ **没有溯源的字段一律不出现**。
 *
 * 运行：node test/scene-frame.test.mjs
 */
import assert from 'node:assert/strict'

import {
  projectSceneFrame, sceneFrameProvenanceErrors, renderSceneFrame,
  stableId, dialogueTopicKeys, isConversationalFollowUp, resolveDialogueBurst,
  renderDialogueBurst, SCENE_FRAME_FIELDS,
} from '../lib/scene-frame.js'

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

console.log('确定性场景帧')

/* ------------------------------------------------------ ① 帧身份 */

ok('帧身份只由「故事 + 场景」决定，与时间无关', () => {
  // 这是铁律 1：用时间参与身份，每轮都会「变成一个新帧」，
  // 对话突发的连续性判定就会永远失败。
  const a = projectSceneFrame({ storyId: 's1', sceneId: 3, now: '2020-01-01T00:00:00.000Z' })
  const b = projectSceneFrame({ storyId: 's1', sceneId: 3, now: '2030-01-01T00:00:00.000Z' })
  assert.equal(a.id, b.id)
})

ok('不同故事 / 不同场景 → 不同帧 id', () => {
  const base = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  assert.notEqual(base.id, projectSceneFrame({ storyId: 's2', sceneId: 1 }).id)
  assert.notEqual(base.id, projectSceneFrame({ storyId: 's1', sceneId: 2 }).id)
})

ok('stableId：同输入同结果，不同输入不同结果', () => {
  assert.equal(stableId('frame', 'a', 'b'), stableId('frame', 'a', 'b'))
  assert.notEqual(stableId('frame', 'a', 'b'), stableId('frame', 'a', 'c'))
  assert.notEqual(stableId('frame', 'a'), stableId('burst', 'a'), '前缀要参与')
})

/* ------------------------------------------------------ ② 溯源铁律 */

ok('没有溯源的字段一律不出现（铁律 3）', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    // 在场的人没有 sourceEntryIds → 不该进帧
    scenePresence: [{ name: '无名氏', status: 'present' }],
    workingDetails: [{ label: '烧水', value: '在灶上' }],
  })
  assert.deepEqual(frame.presentPeople, [])
  assert.deepEqual(frame.openMotions, [])
  assert.equal(frame.place, undefined)
})

ok('有值必有源：sceneFrameProvenanceErrors 恒为空', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    now: '2026-01-01T00:00:00.000Z',
    scenePresence: [{ name: '林知夏', status: 'present', sourceEntryIds: [3] }],
    workingDetails: [{ label: '烧水', value: '水壶在灶上', sourceEntryIds: [2] }],
    agencyWindow: { deviceAccess: 'available', privacy: 'private', activityLoad: 'free', sourceEntryIds: [4] },
  })
  assert.deepEqual(sceneFrameProvenanceErrors(frame), [])
})

ok('provenanceErrors 能抓出「有值无源」的伪造帧', () => {
  // 这个守卫是用来证明投影逻辑没漏记溯源的——它得真的会响。
  const fake = { id: 'f', place: '厨房', presentPeople: [], openMotions: [], openTopics: [], sources: {}, sourceEntryIds: [] }
  const errors = sceneFrameProvenanceErrors(fake)
  assert.deepEqual(errors, ['place has no source entry'])
})

ok('sourceEntryIds 是各字段溯源的并集（去重升序）', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    scenePresence: [{ name: 'A', status: 'present', sourceEntryIds: [5, 3] }],
    workingDetails: [{ label: 'x', value: 'y', sourceEntryIds: [3, 9] }],
  })
  assert.deepEqual(frame.sourceEntryIds, [3, 5, 9])
})

/* ------------------------------------------------------ ③ 在场投影 */

ok('只有 present 的人进 presentPeople', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    scenePresence: [
      { name: '在场者', status: 'present', sourceEntryIds: [1] },
      { name: '离场者', status: 'off-scene', sourceEntryIds: [1] },
    ],
  })
  assert.deepEqual(frame.presentPeople, ['在场者'])
})

ok('早于本地边界的在场记录作废（换地方后旧名单失效）', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    previousFrame: { localBoundaryEntryId: 10 },
    scenePresence: [
      { name: '旧的', status: 'present', sourceEntryIds: [5] },   // 边界之前
      { name: '新的', status: 'present', sourceEntryIds: [12] },  // 边界之后
    ],
  })
  assert.deepEqual(frame.presentPeople, ['新的'])
  assert.equal(frame.localBoundaryEntryId, 10, '边界要跨轮继承')
})

ok('visibleEntryIds 给了就要求溯源落在窗口内', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    visibleEntryIds: [7],
    scenePresence: [
      { name: '窗口内', status: 'present', sourceEntryIds: [7] },
      { name: '窗口外', status: 'present', sourceEntryIds: [99] },
    ],
  })
  assert.deepEqual(frame.presentPeople, ['窗口内'])
})

/* ------------------------------------------------------ ④ 行动窗口投影 */

ok('agencyWindow 投影成 attention / deviceAccess / privacy', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    agencyWindow: { activityLoad: 'occupied', deviceAccess: 'limited', privacy: 'shared', sourceEntryIds: [4] },
  })
  assert.equal(frame.attention, 'occupied')
  assert.equal(frame.deviceAccess, 'limited')
  assert.equal(frame.privacy, 'shared')
})

ok('没有溯源的 agencyWindow 不投影（不凭空给状态）', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    agencyWindow: { activityLoad: 'free', deviceAccess: 'available', privacy: 'private' },
  })
  assert.equal(frame.attention, undefined)
  assert.equal(frame.deviceAccess, undefined)
})

/* ------------------------------------------------------ ⑤ 渲染 */

ok('renderSceneFrame：只渲染有值的字段', () => {
  const frame = projectSceneFrame({
    storyId: 's1',
    scenePresence: [{ name: '林知夏', status: 'present', sourceEntryIds: [3] }],
    workingDetails: [{ label: '烧水', value: '水壶在灶上', sourceEntryIds: [2] }],
  })
  const text = renderSceneFrame(frame)
  assert.match(text, /物理在场：林知夏/)
  assert.match(text, /进行中：烧水：水壶在灶上/)
  assert.doesNotMatch(text, /地点/, '没有地点就不该出现这一行')
})

ok('renderSceneFrame：空帧返回空串（不留占位符让模型填空）', () => {
  assert.equal(renderSceneFrame(projectSceneFrame({ storyId: 's1' })), '')
  assert.equal(renderSceneFrame(undefined), '')
  assert.equal(renderSceneFrame(null), '')
})

/* ------------------------------------------------------ ⑥ 话题键与承接 */

ok('dialogueTopicKeys：中文走二字符 shingle 并哈希', () => {
  const keys = dialogueTopicKeys('今天天气')
  assert.equal(keys.length, 3, `实际 ${keys.length}`)
  for (const k of keys) assert.match(k, /^topic:/, '必须是哈希键——私密原文不该进持久状态')
})

ok('dialogueTopicKeys：同样输入产生同样键（可跨轮比较）', () => {
  assert.deepEqual(dialogueTopicKeys('今天天气'), dialogueTopicKeys('今天天气'))
})

ok('isConversationalFollowUp：承接词开头算同一段对话', () => {
  // 没有这一条，「那今天呢」会因为字面词元对不上而被判成换了话题。
  for (const t of ['那今天呢', '所以呢', '然后我就走了', '但是', '嗯', '']) {
    assert.equal(isConversationalFollowUp(t), true, t)
  }
})

ok('isConversationalFollowUp：以「我/你」开头也算承接（可能是在接话）', () => {
  // 上游的正则包含 我/你 —— 这是刻意的「宁可算作同一段对话」：
  // 判错成换话题会把一段连续的对话切碎，而判错成承接只是少切一次，代价小得多。
  assert.equal(isConversationalFollowUp('我们聊聊别的吧'), true)
  assert.equal(isConversationalFollowUp('你上次说的那个'), true)
})

ok('isConversationalFollowUp：完全无关的开头才算新话题', () => {
  assert.equal(isConversationalFollowUp('中午吃面条'), false)
  assert.equal(isConversationalFollowUp('周末去爬山'), false)
})

/* ------------------------------------------------------ ⑦ 对话突发 */

ok('突发：同一帧且话题未断 → 沿用同一个突发', () => {
  const frame = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const first = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', { topicText: '今天天气' })
  const next = resolveDialogueBurst(frame, first, '2026-01-01T00:05:00.000Z', { topicText: '今天天气不错' })
  assert.equal(next.id, first.id, '同一段对话应沿用同一个 id')
  assert.equal(next.startedAt, first.startedAt, '起始时间不该被刷新')
})

ok('突发：结构性边界会开一个新突发', () => {
  const frame = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const first = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', { topicText: '今天天气' })
  const next = resolveDialogueBurst(frame, first, '2026-01-01T00:01:00.000Z', { topicText: '今天天气', boundary: true })
  assert.notEqual(next.id, first.id, '边界必须切开新突发')
})

ok('突发：换了场景帧 → 新突发', () => {
  const f1 = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const f2 = projectSceneFrame({ storyId: 's1', sceneId: 2 })
  const first = resolveDialogueBurst(f1, undefined, '2026-01-01T00:00:00.000Z', {})
  const next = resolveDialogueBurst(f2, first, '2026-01-01T00:01:00.000Z', {})
  assert.notEqual(next.id, first.id)
})

ok('突发：**时间流逝本身不会**开新突发（铁律 1）', () => {
  const frame = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const first = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', {})
  const muchLater = resolveDialogueBurst(frame, first, '2026-01-01T03:00:00.000Z', {})
  assert.equal(muchLater.id, first.id, '三小时过去仍是同一段对话')
})

ok('突发：承接词能救回「字面词元不同但确实是接着说」的情况', () => {
  const frame = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const first = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', { topicText: '今天天气' })
  const next = resolveDialogueBurst(frame, first, '2026-01-01T00:01:00.000Z', { topicText: '那我们出去走走吧' })
  assert.equal(next.id, first.id, '承接词开头应算同一段对话')
})

ok('突发：scope 不同 → 新突发（关系/群/生活分支要分开）', () => {
  const frame = projectSceneFrame({ storyId: 's1', sceneId: 1 })
  const first = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', { scope: 'c2c:U1' })
  const other = resolveDialogueBurst(frame, first, '2026-01-01T00:01:00.000Z', { scope: 'group:G9' })
  assert.notEqual(other.id, first.id)
})

ok('突发：scope 被哈希后存储（不落私密标识）', () => {
  const frame = projectSceneFrame({ storyId: 's1' })
  const burst = resolveDialogueBurst(frame, undefined, '2026-01-01T00:00:00.000Z', { scope: 'c2c:USER_SECRET' })
  assert.match(burst.scopeKey, /^scope:/)
  assert.ok(!JSON.stringify(burst).includes('USER_SECRET'), '原始标识不该出现在状态里')
})

ok('renderDialogueBurst：给出已持续时长（分钟取整）', () => {
  const burst = { id: 'b', frameId: 'f', startedAt: '2026-01-01T00:00:00.000Z', sourceEntryIds: [] }
  assert.match(renderDialogueBurst(burst, '2026-01-01T00:05:00.000Z'), /约 5 分钟/)
  assert.match(renderDialogueBurst(burst, '2026-01-01T00:32:00.000Z'), /约 32 分钟/)
  assert.equal(renderDialogueBurst(undefined, '2026-01-01T00:00:00.000Z'), '')
  assert.equal(renderDialogueBurst({ startedAt: 'not-a-date' }, '2026-01-01T00:00:00.000Z'), '')
})

ok('SCENE_FRAME_FIELDS 覆盖上游全部字段', () => {
  assert.deepEqual(SCENE_FRAME_FIELDS, [
    'place', 'presentPeople', 'ongoingActivity', 'postureOrMotion', 'attention',
    'deviceAccess', 'privacy', 'affectiveBaseline', 'openMotions', 'openTopics', 'narrativeFocus',
  ])
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

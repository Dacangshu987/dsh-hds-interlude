/**
 * Phase 4 四个模块的用例：
 *   - `timeline-guard.js`：退避与熔断（**不做会烧 token** 的那条）
 *   - `continuation.js`：续写书签 + 复用诊断
 *   - `episode-index.js`：情节索引
 *   - `intent-lifecycle.js`：意图生命周期
 *
 * 运行：node test/phase4.test.mjs
 */
import assert from 'node:assert/strict'

import {
  createTimelineGuard, normalizeTimelineGuard, timelineDirectorAllowed,
  recordDirectorFailure, recordDirectorSuccess, timelineDirectorFused,
  describeTimelineGuard, needsTimelineDirector,
  RETRY_BACKOFF_BASE_MS, DIRECTOR_FUSE_THRESHOLD, DIRECTOR_FUSE_COOLDOWN_MS,
} from '../lib/timeline-guard.js'
import {
  continuationBookmark, renderContinuationBookmark, proseReuseObservation, shouldWarnProseReuse,
} from '../lib/continuation.js'
import {
  buildEpisodeIndex, episodeExcerpt, groundedEpisodeTags, episodeTagScore,
} from '../lib/episode-index.js'
import {
  liveNarrativeIntents, consumedLiveIntentIds, isDerivedIntent, isConsumableIntent,
  DERIVED_INTENT_TYPES,
} from '../lib/intent-lifecycle.js'

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

console.log('Phase 4')

const T0 = 1_700_000_000_000

/* ==================== ① 时间导演：退避与熔断 ==================== */

ok('新守卫：允许调用', () => {
  const g = createTimelineGuard()
  assert.deepEqual(timelineDirectorAllowed(g, { now: T0, from: T0 }), { allowed: true, failures: 0 })
})

ok('失败后退避：**同一个窗口**在退避期内被挡住', () => {
  // 上游的理由：后台扫描三分钟一轮，故事游标没动时重试必然还是同一个结果——
  // 纯烧 token。
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  const blocked = timelineDirectorAllowed(g, { now: T0 + 1000, from: T0 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'backoff')
})

ok('失败后退避：**换了窗口**就放行（那是新的工作）', () => {
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  assert.equal(timelineDirectorAllowed(g, { now: T0 + 1000, from: T0 + 60_000 }).allowed, true)
})

ok('退避到期后放行', () => {
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  assert.equal(timelineDirectorAllowed(g, { now: T0 + RETRY_BACKOFF_BASE_MS + 1, from: T0 }).allowed, true)
})

ok('退避是**指数**增长', () => {
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  const first = g.backoff.until - T0
  recordDirectorFailure(g, { now: T0, from: T0 })
  const second = g.backoff.until - T0
  assert.ok(second > first, `第二次应更长：${first} → ${second}`)
  assert.equal(first, RETRY_BACKOFF_BASE_MS)
  assert.equal(second, RETRY_BACKOFF_BASE_MS * 2)
})

ok('退避上限不超过熔断冷却（否则熔断形同虚设）', () => {
  const g = createTimelineGuard()
  for (let i = 0; i < 20; i++) recordDirectorFailure(g, { now: T0, from: T0 })
  assert.ok(g.backoff.until - T0 <= DIRECTOR_FUSE_COOLDOWN_MS,
    `退避 ${g.backoff.until - T0} 不该超过冷却 ${DIRECTOR_FUSE_COOLDOWN_MS}`)
})

ok('连续失败到阈值 → 熔断', () => {
  const g = createTimelineGuard()
  for (let i = 0; i < DIRECTOR_FUSE_THRESHOLD; i++) {
    recordDirectorFailure(g, { now: T0 + i, from: T0 + i * 60_000 })
  }
  assert.equal(timelineDirectorFused(g), DIRECTOR_FUSE_THRESHOLD)
})

ok('熔断后**连换了窗口也挡住**（否则每来一个新窗口就重试一次）', () => {
  // 这是熔断与普通退避的关键差别。
  const g = createTimelineGuard()
  for (let i = 0; i < DIRECTOR_FUSE_THRESHOLD; i++) {
    recordDirectorFailure(g, { now: T0 + i, from: T0 + i * 60_000 })
  }
  const blocked = timelineDirectorAllowed(g, { now: T0 + 1000, from: T0 + 999_999 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'fused')
})

ok('熔断冷却到期后自动解除（重试一次完整路径）', () => {
  const g = createTimelineGuard()
  // 注意冷却从**最后一次失败**起算，所以这里统一用同一个 now，
  // 让"什么时候到期"有确定的答案（踩过：之前用递增的 now，算式就对不上了）。
  for (let i = 0; i < DIRECTOR_FUSE_THRESHOLD; i++) {
    recordDirectorFailure(g, { now: T0, from: T0 + i * 60_000 })
  }
  const until = g.backoff.until
  assert.equal(timelineDirectorAllowed(g, { now: until - 1, from: T0 }).allowed, false, '冷却内应挡住')
  assert.equal(timelineDirectorAllowed(g, { now: until + 1, from: T0 }).allowed, true, '冷却后应放行')
})

ok('成功一次 → **清空**失败计数与退避', () => {
  // 否则偶发抖动会慢慢攒到熔断。
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  recordDirectorFailure(g, { now: T0, from: T0 })
  recordDirectorSuccess(g)
  assert.equal(g.failures, 0)
  assert.equal(g.backoff, null)
  assert.equal(timelineDirectorFused(g), undefined)
})

ok('未到阈值的失败不算熔断', () => {
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  assert.equal(timelineDirectorFused(g), undefined)
})

ok('normalizeTimelineGuard：坏值降级，不抛错', () => {
  for (const bad of [undefined, null, 'x', 42, [], { failures: -1 }, { failures: 1.5 }, { backoff: 'x' }, { backoff: { from: 5, until: 1 } }]) {
    const g = normalizeTimelineGuard(bad)
    assert.ok(Number.isSafeInteger(g.failures) && g.failures >= 0, JSON.stringify(bad))
    assert.ok(g.backoff === null || (Number.isFinite(g.backoff.from) && g.backoff.until >= g.backoff.from), JSON.stringify(bad))
  }
})

ok('describeTimelineGuard：熔断/退避都有可读描述，正常时为空', () => {
  assert.equal(describeTimelineGuard(createTimelineGuard(), T0), '')
  const g = createTimelineGuard()
  recordDirectorFailure(g, { now: T0, from: T0 })
  assert.match(describeTimelineGuard(g, T0 + 1000), /退避中/)
  for (let i = 0; i < DIRECTOR_FUSE_THRESHOLD; i++) recordDirectorFailure(g, { now: T0, from: T0 })
  assert.match(describeTimelineGuard(g, T0 + 1000), /熔断/)
})

/* ==================== ② 时间导演路由 ==================== */

const dayKey = (ms, tz) => new Date(ms).toISOString().slice(0, 10) + tz
const clockMinutes = ms => Math.floor(ms / 60_000) % 1440
const route = (phase, from, now, schedule = null) =>
  needsTimelineDirector({ phase, from, now, timezone: 'Z', schedule, dayKey, clockMinutes })

ok('needsTimelineDirector：user-message 永远不需要（用户刚说话，时间没流动）', () => {
  assert.equal(route('user-message', T0, T0 + 10 * 3600_000), false)
})

ok('needsTimelineDirector：advance 阶段总是需要', () => {
  assert.equal(route('advance', T0, T0 + 1000), true)
})

ok('needsTimelineDirector：间隔超过 20 分钟需要', () => {
  assert.equal(route('conversation-follow-up', T0, T0 + 5 * 60_000), false)
  assert.equal(route('conversation-follow-up', T0, T0 + 25 * 60_000), true)
})

ok('needsTimelineDirector：跨本地日历日需要', () => {
  assert.equal(route('conversation-follow-up', T0, T0 + 25 * 3600_000), true)
})

ok('needsTimelineDirector：日程边界落在区间内需要', () => {
  // 短对话本来不需要，但一个已知的日程边界压在这个区间里，就必须要。
  const from = Date.parse('2026-01-01T02:00:00.000Z')
  const now = from + 5 * 60_000
  const schedule = { blocks: [{ date: dayKey(now, 'Z'), start: '02:00', end: '02:03' }] }
  assert.equal(route('conversation-follow-up', from, now, schedule), true)
})

/* ==================== ③ 续写书签 ==================== */

const entries = [
  { id: 1, kind: 'script', participantId: 'p', occurredAt: new Date(T0).toISOString(), content: '（她走进厨房。）', metadata: {} },
  { id: 2, kind: 'user-message', participantId: 'p', occurredAt: new Date(T0 + 60_000).toISOString(), content: '在吗', metadata: {} },
]

ok('continuationBookmark：指向最后一段已完成原文的**端点**', () => {
  const b = continuationBookmark({ entries, from: T0 + 30_000, now: T0 + 120_000 })
  assert.equal(b.lastScript.entryId, 1)
  assert.equal(b.originalEndpoint.entryId, 1)
  assert.equal(b.originalEndpoint.characterOffset, '（她走进厨房。）'.length)
})

ok('continuationBookmark：新事件**只记 id**，不复制原文', () => {
  // 复制会让同一段对话在上下文里出现两遍，模型容易当成"又发生了一次"。
  const b = continuationBookmark({ entries, from: T0 + 30_000, now: T0 + 120_000 })
  assert.deepEqual(b.newEventEntryIds, [2])
  assert.ok(!JSON.stringify(b).includes('在吗'), '不该把原文搬进书签')
})

ok('continuationBookmark：from 之前的用户消息进 recentCommunications（不重复计）', () => {
  const b = continuationBookmark({ entries, from: T0 + 120_000, now: T0 + 180_000 })
  assert.deepEqual(b.newEventEntryIds, [], 'from 之后没有新消息')
  assert.ok(b.recentCommunications.some(r => r.entryId === 2))
})

ok('continuationBookmark：空账本安全', () => {
  const b = continuationBookmark({ entries: [], from: T0, now: T0 })
  assert.equal(b.lastScript, undefined)
  assert.deepEqual(b.newEventEntryIds, [])
  assert.equal(b.writingStart, 'after-last-completed-passage')
})

ok('renderContinuationBookmark：明确要求「不要重述」', () => {
  const b = continuationBookmark({ entries, from: T0 + 30_000, now: T0 + 120_000 })
  const text = renderContinuationBookmark(b)
  assert.match(text, /不要重述/)
  assert.match(text, /entry:1/)
})

ok('renderContinuationBookmark：空书签返回空串', () => {
  assert.equal(renderContinuationBookmark(undefined), '')
  assert.equal(renderContinuationBookmark({}), '')
})

/* ==================== ④ 复用诊断 ==================== */

ok('proseReuseObservation：整段照抄 → 1', () => {
  const text = '甲'.repeat(100)
  assert.equal(proseReuseObservation(text, text), 1)
})

ok('proseReuseObservation：**短句不计**（「在吗」重复是正常的）', () => {
  // 上游明确：identical short questions must never be treated as a fault.
  assert.equal(proseReuseObservation('在吗', '在吗'), 0)
  assert.equal(proseReuseObservation('甲'.repeat(39), '甲'.repeat(39)), 0)
})

ok('proseReuseObservation：完全不同 → 0', () => {
  assert.equal(proseReuseObservation('甲'.repeat(60), '乙'.repeat(60)), 0)
})

ok('proseReuseObservation：重叠窗口不重复计', () => {
  // 逐字符滑窗会让同一段命中被反复累计，结果 >1。这里必须封顶在 1。
  const text = '丙'.repeat(200)
  assert.ok(proseReuseObservation(text, text) <= 1)
})

ok('shouldWarnProseReuse：只在高重合时提醒，且只是"值得看一眼"', () => {
  assert.equal(shouldWarnProseReuse(0.9), true)
  assert.equal(shouldWarnProseReuse(0.4), false)
  assert.equal(shouldWarnProseReuse(Number.NaN), false)
  assert.equal(shouldWarnProseReuse(0.5), true, '恰好到门槛应提醒')
})

/* ==================== ⑤ 情节索引 ==================== */

ok('buildEpisodeIndex：同一 frameId 归为一组', () => {
  const idx = buildEpisodeIndex([
    { id: 1, kind: 'script', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', participantId: 'p', metadata: { frameId: 'f1' } },
  ])
  assert.deepEqual(idx.get(1), [1, 2])
  assert.deepEqual(idx.get(2), [1, 2])
})

ok('buildEpisodeIndex：不同 frameId 分开', () => {
  const idx = buildEpisodeIndex([
    { id: 1, kind: 'script', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', participantId: 'p', metadata: { frameId: 'f2' } },
  ])
  assert.deepEqual(idx.get(1), [1])
  assert.deepEqual(idx.get(2), [2])
})

ok('buildEpisodeIndex：不同参与者的同帧**不合并**', () => {
  // 群里两个人各自的场景不该被并成一段情节。
  const idx = buildEpisodeIndex([
    { id: 1, kind: 'script', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', participantId: 'q', metadata: { frameId: 'f1' } },
  ])
  assert.deepEqual(idx.get(1), [1])
  assert.deepEqual(idx.get(2), [2])
})

ok('buildEpisodeIndex：没有帧的老条目各自成单点锚', () => {
  const idx = buildEpisodeIndex([
    { id: 1, kind: 'script', participantId: 'p', metadata: {} },
    { id: 2, kind: 'script', participantId: 'p', metadata: {} },
  ])
  assert.deepEqual(idx.get(1), [1])
  assert.deepEqual(idx.get(2), [2])
})

ok('buildEpisodeIndex：场景检查点优先于 frameId', () => {
  const idx = buildEpisodeIndex([
    { id: 1, kind: 'script', participantId: 'p', metadata: { frameId: 'f1', sceneCheckpoint: { sceneId: 7, firstEntryId: 1, lastEntryId: 2 } } },
    { id: 2, kind: 'script', participantId: 'p', metadata: { frameId: 'f1' } },
  ])
  assert.deepEqual(idx.get(1), [1, 2])
})

ok('buildEpisodeIndex：空/畸形输入安全', () => {
  assert.equal(buildEpisodeIndex([]).size, 0)
  assert.equal(buildEpisodeIndex(undefined).size, 0)
  assert.equal(buildEpisodeIndex([null, 'x', {}]).size, 0)
})

ok('episodeExcerpt：以命中为锚，带上邻居', () => {
  const rows = [
    { id: 1, kind: 'script', content: '第一段。', occurredAt: 't1', metadata: {} },
    { id: 2, kind: 'script', content: '第二段有公园。', occurredAt: 't2', metadata: {} },
    { id: 3, kind: 'script', content: '第三段。', occurredAt: 't3', metadata: {} },
  ]
  const ex = episodeExcerpt(rows, 2, { budget: 4000 })
  assert.deepEqual(ex.sourceEntryIds, [1, 2, 3], '锚点与左右邻居都该在')
  assert.match(ex.content, /第二段有公园/)
})

ok('episodeExcerpt：标注归属与节选（不让下游以为拿到全文）', () => {
  const rows = [
    { id: 1, kind: 'script', content: '甲'.repeat(500), occurredAt: 't1', metadata: {} },
  ]
  const ex = episodeExcerpt(rows, 1, { budget: 100, queryKeys: ['甲'] })
  assert.match(ex.content, /主角叙述/)
  assert.match(ex.content, /entry:1/)
  assert.match(ex.content, /节选/, '超预算必须标注是节选')
})

ok('episodeExcerpt：锚点不存在返回 undefined', () => {
  assert.equal(episodeExcerpt([{ id: 1, kind: 'script', content: 'x', metadata: {} }], 99), undefined)
  assert.equal(episodeExcerpt([], 1), undefined)
})

ok('episodeExcerpt：sourceEntryIds 只描述**结果里真的有**的条目', () => {
  // 这是上游的明确要求：不能把被省略的部分也算进溯源。
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, kind: 'script', content: '丙'.repeat(300), occurredAt: `t${i}`, metadata: {},
  }))
  const ex = episodeExcerpt(rows, 3, { budget: 700 })
  for (const id of ex.sourceEntryIds) {
    assert.ok(ex.content.includes(`entry:${id}`), `entry:${id} 应出现在内容里`)
  }
})

ok('groundedEpisodeTags：只保留逐字落在原文里的标签', () => {
  const tags = groundedEpisodeTags('林知夏在厨房烧水', {
    people: ['林知夏', '不存在的人'], places: ['厨房'], topics: ['没有这个词'],
  })
  assert.deepEqual(tags.people, ['林知夏'])
  assert.deepEqual(tags.places, ['厨房'])
  assert.equal(tags.topics, undefined)
})

ok('groundedEpisodeTags：太短/太长/非字符串都过滤', () => {
  const tags = groundedEpisodeTags('内容 abcdefg', { people: ['a', 'x'.repeat(200), 42, null, 'abc'] })
  assert.deepEqual(tags.people, ['abc'])
})

ok('episodeTagScore：命中即 0.8，否则 0', () => {
  assert.equal(episodeTagScore('今天去公园', ['公园']), 0.8)
  assert.equal(episodeTagScore('今天去公园', ['图书馆']), 0)
  assert.equal(episodeTagScore('x', []), 0)
})

/* ==================== ⑥ 意图生命周期 ==================== */

ok('liveNarrativeIntents：排除有自己执行器的类型', () => {
  // 不排除的话，模型一轮没提到它们就会被判成"已消费"而**静默消失**。
  const list = [
    { id: 'a', type: 'reminder' },
    { id: 'b', type: 'split-message' },
    { id: 'c', type: 'browser-research' },
    { id: 'd', type: 'proactive-check' },
    { id: 'e', type: 'active-consequence' },
  ]
  assert.deepEqual(liveNarrativeIntents(list).map(i => i.id), ['a'])
})

ok('consumedLiveIntentIds：承诺型**不能**被消费', () => {
  // 它是一条真实承诺，只能靠到期投递或显式关闭结清。
  const list = [{ id: 'a', type: 'reminder' }, { id: 'b', type: 'follow-up-commitment' }]
  assert.deepEqual(consumedLiveIntentIds(list), ['a'])
})

ok('isDerivedIntent / isConsumableIntent 与列表一致', () => {
  for (const type of DERIVED_INTENT_TYPES) {
    assert.equal(isDerivedIntent({ type }), true, type)
    assert.equal(isConsumableIntent({ type }), false, type)
  }
  assert.equal(isConsumableIntent({ type: 'follow-up-commitment' }), false)
  assert.equal(isConsumableIntent({ type: 'reminder' }), true)
  assert.equal(isConsumableIntent(undefined), false)
})

ok('空/畸形输入安全', () => {
  assert.deepEqual(liveNarrativeIntents(undefined), [])
  assert.deepEqual(consumedLiveIntentIds(null), [])
  assert.deepEqual(liveNarrativeIntents([null, undefined]).length, 0)
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

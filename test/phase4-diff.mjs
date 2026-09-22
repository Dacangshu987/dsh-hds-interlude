/**
 * 差分核验：`continuation.js` / `episode-index.js` / `intent-lifecycle.js` /
 * `timeline-guard.js` 的移植是否与上游语义一致。
 *
 * 上游逻辑在本文件内**逐行照抄**成参照实现（不 import 自己）。
 *
 * 运行：node test/phase4-diff.mjs
 */
import { continuationBookmark, proseReuseObservation } from '../lib/continuation.js'
import { buildEpisodeIndex, episodeExcerpt, groundedEpisodeTags, episodeTagScore } from '../lib/episode-index.js'
import { liveNarrativeIntents, consumedLiveIntentIds } from '../lib/intent-lifecycle.js'
import { needsTimelineDirector } from '../lib/timeline-guard.js'

let fails = 0
const check = (label, ok, detail) => {
  if (ok) return
  fails += 1
  console.log(`MISMATCH ${label}`)
  if (detail) console.log(`  ${detail}`)
}

/* ============== ① continuation：书签 + 复用诊断 ============== */

// 上游 continuationBookmark（照抄；Date 换成 ISO 字符串比较）
function upBookmark(entries, from, now) {
  const at = e => Date.parse(e.occurredAt)
  const visible = entries.filter(e => at(e) <= now)
  const lastScript = visible.filter(e => e.kind === 'script' && at(e) <= from).at(-1)
  const reference = e => ({ entryId: e.id, kind: e.kind, participantId: e.participantId, occurredAt: e.occurredAt })
  return {
    establishedThrough: new Date(from).toISOString(),
    ...(lastScript ? { lastScript: reference(lastScript) } : {}),
    writingStart: 'after-last-completed-passage',
    ...(lastScript ? { originalEndpoint: { entryId: lastScript.id, characterOffset: lastScript.content.length } } : {}),
    newEventEntryIds: visible.filter(e => e.kind === 'user-message' && at(e) > from).map(e => e.id),
    recentCommunications: visible.filter(e => (e.kind !== 'user-message' || at(e) <= from)
      && ['user-message', 'character-message', 'character-group-message', 'character-platform-action'].includes(e.kind))
      .slice(-4).map(reference),
  }
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const mk = (id, kind, minutes, content = 'x') => ({
  id, kind, participantId: 'p', occurredAt: new Date(T0 + minutes * 60_000).toISOString(), content,
})
const BOOK_CASES = [
  { entries: [], from: T0, now: T0 },
  { entries: [mk(1, 'script', 0, 'abc')], from: T0 + 60_000, now: T0 + 120_000 },
  { entries: [mk(1, 'script', 0), mk(2, 'user-message', 1), mk(3, 'user-message', 2)], from: T0, now: T0 + 300_000 },
  { entries: [mk(1, 'script', 0), mk(2, 'user-message', 1), mk(3, 'character-message', 2)], from: T0 + 30_000, now: T0 + 300_000 },
  { entries: [mk(1, 'script', 10)], from: T0, now: T0 + 60_000 }, // script 在 from 之后
]
for (let i = 0; i < BOOK_CASES.length; i++) {
  const { entries, from, now } = BOOK_CASES[i]
  const mine = continuationBookmark({ entries, from, now })
  const up = upBookmark(entries, from, now)
  // 上游含 character-platform-action，本地没有该 kind——单独比对共有键
  const keys = ['establishedThrough', 'writingStart', 'newEventEntryIds', 'lastScript', 'originalEndpoint']
  for (const k of keys) {
    check(`bookmark case ${i} .${k}`, JSON.stringify(mine[k]) === JSON.stringify(up[k]),
      `${JSON.stringify(mine[k])} vs ${JSON.stringify(up[k])}`)
  }
}

// 上游 proseReuseObservation（照抄）
function upReuse(previous, next, width = 40) {
  if (previous.length < width || next.length < width) return 0
  const spans = new Set()
  for (let i = 0; i <= previous.length - width; i++) spans.add(previous.slice(i, i + width))
  let covered = 0
  let end = 0
  for (let i = 0; i <= next.length - width; i++) {
    if (!spans.has(next.slice(i, i + width))) continue
    covered += Math.max(0, i + width - Math.max(end, i))
    end = i + width
  }
  return covered / next.length
}

const A40 = '甲'.repeat(50)
const REUSE_CASES = [
  ['', ''],
  ['短', '短'],
  [A40, A40],
  [A40, `${A40}尾巴`],
  [`前缀${A40}`, A40],
  ['完全不同的一段文字内容内容内容内容内容内容内容内容内容内容', '另外一段文字内容内容内容内容内容内容内容内容内容内容'],
  [A40, A40.slice(0, 39)],
]
for (let i = 0; i < REUSE_CASES.length; i++) {
  const [p, n] = REUSE_CASES[i]
  check(`reuse case ${i}`, proseReuseObservation(p, n) === upReuse(p, n),
    `${proseReuseObservation(p, n)} vs ${upReuse(p, n)}`)
}

/* ============== ② episode-index ============== */

// 上游 buildEpisodeIndex（照抄）
function upBuild(rows) {
  const groups = new Map()
  const checkpoints = rows.map(([, row]) => row.checkpoint).filter(item => !!item
    && Number.isSafeInteger(item.firstEntryId) && Number.isSafeInteger(item.lastEntryId))
  for (const [id, row] of rows) {
    const checkpoint = checkpoints.find(item => id >= item.firstEntryId && id <= item.lastEntryId)
    const key = JSON.stringify([row.participantId, checkpoint ? `scene:${checkpoint.sceneId}` : row.frameId || `entry:${id}`])
    const ids = groups.get(key) ?? []
    ids.push(id)
    groups.set(key, ids)
  }
  const byEntry = new Map()
  for (const ids of groups.values()) for (const id of ids) byEntry.set(id, ids)
  return byEntry
}

// 把本地 entries 形态转成上游 rows 形态
const toRows = entries => entries.map(e => [e.id, {
  content: e.content, occurredAt: e.occurredAt, participantId: e.participantId ?? '', kind: e.kind,
  frameId: e.metadata?.frameId, checkpoint: e.metadata?.sceneCheckpoint,
}])

const EP_CASES = [
  [],
  [{ id: 1, kind: 'script', content: 'a', participantId: 'p', metadata: {} }],
  [
    { id: 1, kind: 'script', content: 'a', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', content: 'b', participantId: 'p', metadata: { frameId: 'f1' } },
  ],
  [
    { id: 1, kind: 'script', content: 'a', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', content: 'b', participantId: 'p', metadata: { frameId: 'f2' } },
  ],
  [
    { id: 1, kind: 'script', content: 'a', participantId: 'p', metadata: { sceneCheckpoint: { sceneId: 7, firstEntryId: 1, lastEntryId: 2 } } },
    { id: 2, kind: 'script', content: 'b', participantId: 'p', metadata: { frameId: 'f1' } },
  ],
  [
    { id: 1, kind: 'script', content: 'a', participantId: 'p', metadata: { frameId: 'f1' } },
    { id: 2, kind: 'script', content: 'b', participantId: 'q', metadata: { frameId: 'f1' } },
  ],
]
for (let i = 0; i < EP_CASES.length; i++) {
  const rows = toRows(EP_CASES[i])
  const mine = buildEpisodeIndex(EP_CASES[i])
  const up = upBuild(rows)
  const mineSorted = [...mine.entries()].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]).sort((a, b) => a[0] - b[0])
  const upSorted = [...up.entries()].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]).sort((a, b) => a[0] - b[0])
  check(`episodeIndex case ${i}`, JSON.stringify(mineSorted) === JSON.stringify(upSorted),
    `${JSON.stringify(mineSorted)} vs ${JSON.stringify(upSorted)}`)
}

// groundedEpisodeTags（照抄）
function upTags(content, draft) {
  const result = {}
  for (const key of ['people', 'places', 'objects', 'topics', 'commitments', 'outcomes', 'dates']) {
    const values = draft[key]
    if (!Array.isArray(values)) continue
    const grounded = [...new Set(values.filter(v => typeof v === 'string'
      && v.trim().length >= 2 && v.length <= 100 && content.includes(v)))].slice(0, 8)
    if (grounded.length) result[key] = grounded
  }
  return result
}
const TAG_CASES = [
  ['林知夏在厨房烧水', { people: ['林知夏'], places: ['厨房'], topics: ['不存在'] }],
  ['林知夏在厨房烧水', { people: ['a'], places: ['x'.repeat(200)] }],
  ['短', { people: ['短'] }],
  ['林知夏', {}],
  ['林知夏林知夏', { people: ['林知夏', '林知夏'] }],
]
for (let i = 0; i < TAG_CASES.length; i++) {
  const [c, d] = TAG_CASES[i]
  check(`tags case ${i}`, JSON.stringify(groundedEpisodeTags(c, d)) === JSON.stringify(upTags(c, d)),
    `${JSON.stringify(groundedEpisodeTags(c, d))} vs ${JSON.stringify(upTags(c, d))}`)
}

check('episodeTagScore 与上游一致', episodeTagScore('今天去公园', ['公园']) === 0.8
  && episodeTagScore('今天去公园', ['无关']) === 0
  && episodeTagScore('x', []) === 0)

/* ============== ③ intent-lifecycle ============== */

const upLive = intents => intents.filter(i => !['split-message', 'browser-research', 'proactive-check', 'active-consequence'].includes(i.type))
const upConsumed = intents => upLive(intents).filter(i => i.type !== 'follow-up-commitment').map(i => i.id)

const INTENT_CASES = [
  [],
  [{ id: 'a', type: 'reminder' }],
  [{ id: 'a', type: 'split-message' }, { id: 'b', type: 'reminder' }],
  [{ id: 'a', type: 'follow-up-commitment' }, { id: 'b', type: 'reminder' }],
  [{ id: 'a', type: 'active-consequence' }, { id: 'b', type: 'follow-up-commitment' }],
  [{ id: 'a', type: 'browser-research' }, { id: 'b', type: 'proactive-check' }],
]
for (let i = 0; i < INTENT_CASES.length; i++) {
  const list = INTENT_CASES[i]
  check(`liveIntents case ${i}`,
    JSON.stringify(liveNarrativeIntents(list).map(x => x.id)) === JSON.stringify(upLive(list).map(x => x.id)))
  check(`consumedIds case ${i}`,
    JSON.stringify(consumedLiveIntentIds(list)) === JSON.stringify(upConsumed(list)),
    `${JSON.stringify(consumedLiveIntentIds(list))} vs ${JSON.stringify(upConsumed(list))}`)
}

/* ============== ④ timeline routing ============== */

// 上游 needsTimelineDirector（照抄，用注入的 dayKey/clockMinutes 等价物）
function upNeeds(phase, from, now, timezone, schedule, dayKey, clockMinutes) {
  if (phase === 'user-message') return false
  if (phase === 'advance' || now - from > 20 * 60_000) return true
  if (dayKey(from, timezone) !== dayKey(now, timezone)) return true
  const start = clockMinutes(from, timezone)
  const end = clockMinutes(now, timezone)
  return !!schedule?.blocks.some(block => block.date === dayKey(now, timezone)
    && [block.start, block.end].some(clock => {
      const [hour, minute] = clock.split(':').map(Number)
      return hour * 60 + minute > start && hour * 60 + minute <= end
    }))
}

const dayKey = (ms, tz) => new Date(ms).toISOString().slice(0, 10) + tz
const clockMinutes = ms => Math.floor(ms / 60_000) % 1440

const ROUTE_CASES = [
  ['user-message', T0, T0 + 3600_000, null],
  ['advance', T0, T0 + 60_000, null],
  ['conversation-follow-up', T0, T0 + 5 * 60_000, null],
  ['conversation-follow-up', T0, T0 + 30 * 60_000, null],
  ['conversation-follow-up', T0, T0 + 25 * 3600_000, null],
]
for (let i = 0; i < ROUTE_CASES.length; i++) {
  const [phase, from, now, schedule] = ROUTE_CASES[i]
  const args = { phase, from, now, timezone: 'Z', schedule, dayKey, clockMinutes }
  check(`needsTimelineDirector case ${i}`,
    needsTimelineDirector(args) === upNeeds(phase, from, now, 'Z', schedule, dayKey, clockMinutes))
}

console.log(fails === 0 ? '\n✅ 四份移植与上游语义一致' : `\n❌ ${fails} 处差异`)
process.exit(fails === 0 ? 0 : 1)

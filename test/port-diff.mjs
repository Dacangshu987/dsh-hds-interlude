/**
 * 差分核验：`scene-frame.js` / `knowledge-evidence.js` / `development.js`
 * 三份移植是否与上游语义一致。
 *
 * 上游逻辑在本文件内**逐行照抄**成参照实现（不 import 自己）。凡本地刻意偏离的
 * 地方，都在对应的 `normalize*` 里抹平并注明理由。
 *
 * 运行：node test/port-diff.mjs
 */
import * as sf from '../lib/scene-frame.js'
import * as ke from '../lib/knowledge-evidence.js'
import * as dv from '../lib/development.js'

let fails = 0
const check = (label, ok, detail) => {
  if (ok) return
  fails += 1
  console.log(`MISMATCH ${label}`)
  if (detail) console.log(`  ${detail}`)
}

/* ==================================================================
 * ① scene-frame：stableId / 话题键 / 承接词 / 突发边界
 * ================================================================== */

// 上游 stableId（同样的 sha256 取 18 位）
import { createHash } from 'node:crypto'
const upStableId = (prefix, ...parts) =>
  `${prefix}:${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 18)}`

check('stableId 与上游一致', sf.stableId('frame', 'a', 'b') === upStableId('frame', 'a', 'b'),
  `${sf.stableId('frame', 'a', 'b')} vs ${upStableId('frame', 'a', 'b')}`)

// 上游 dialogueTopicKeys
function upTopicKeys(text) {
  const normalized = text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
  if (!normalized) return []
  const raw = /[\u3400-\u9fff]/u.test(normalized)
    ? Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2))
    : (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  const uniq = [...new Set(raw.map(v => upStableId('topic', v)))]
  return uniq.slice(-12)
}

for (const t of ['今天天气怎么样', 'hello world foo', '那今天呢', '', '混合 mixed 内容', 'a', '看看这个怎么说']) {
  const a = JSON.stringify(sf.dialogueTopicKeys(t))
  const b = JSON.stringify(upTopicKeys(t))
  check(`dialogueTopicKeys(${JSON.stringify(t)})`, a === b, `${a}\n  vs ${b}`)
}

// 上游 isConversationalFollowUp
const upFollowUp = text => {
  const n = text.trim()
  if (!n) return true
  return /^(那|这|所以|然后|但是|可是|怎么|为什么|你|我|刚才|昨天|前面|不是|对啊|嗯|啊)/u.test(n)
}
for (const t of ['那今天呢', '所以呢', '然后我就走了', '完全无关的话', '', '嗯', '  那  ']) {
  check(`isConversationalFollowUp(${JSON.stringify(t)})`, sf.isConversationalFollowUp(t) === upFollowUp(t))
}

/* ==================================================================
 * ② knowledge-evidence：模式判定 + confirmed 双向交换
 * ================================================================== */

// 构造一个内存账本，模拟条目
function mkLedger(rows) {
  return { cursor: rows.length, nextId: rows.length + 1, entries: rows }
}
const L = mkLedger([
  { id: 1, kind: 'user-message', participantId: 'p1', content: '那周末我来找你吧。', metadata: {} },
  { id: 2, kind: 'character-message', participantId: 'p1', content: '好啊，周末见。', metadata: {} },
  { id: 3, kind: 'script', participantId: 'p1', content: '（她心想：他说过会来的。）', metadata: {} },
  { id: 4, kind: 'user-message', participantId: 'p2', content: '周末我不一定有空。', metadata: {} },
  { id: 5, kind: 'script', participantId: 'p1', content: '（她看了看窗外，天气不错。）', metadata: {} },
])

// 上游 normalizeKnowledgeEvidence（照抄）
function upNormalize(raw, entries, sourceEntryIds, relatedFactIds = []) {
  const modes = ['observed', 'reported', 'belief', 'proposal', 'conditional', 'confirmed', 'unclassified']
  const roles = ['observation', 'interpretation', 'proposal', 'condition', 'confirmation']
  const value = raw && typeof raw === 'object' ? raw : {}
  const byId = new Map(entries.filter(e => sourceEntryIds.includes(e.id)).map(e => [e.id, e]))
  const clauses = []
  for (const clause of Array.isArray(value.clauses) ? value.clauses.slice(0, 12) : []) {
    const entry = byId.get(clause && clause.sourceEntryId)
    if (!entry || !roles.includes(clause.role) || typeof clause.quote !== 'string'
      || !clause.quote.trim() || clause.quote.length > 800 || !entry.content.includes(clause.quote)) continue
    const delivered = ['user-message', 'character-message', 'group-message', 'character-group-message'].includes(entry.kind)
    clauses.push({ role: clause.role === 'confirmation' && !delivered ? 'interpretation' : clause.role, sourceEntryId: entry.id, quote: clause.quote })
  }
  let mode = modes.includes(value.mode || '') ? value.mode : 'unclassified'
  if (!clauses.length) mode = 'unclassified'
  if (mode === 'confirmed') {
    const proposed = clauses.filter(c => c.role === 'proposal')
    const confirmed = clauses.filter(c => c.role === 'confirmation')
    const exchanged = proposed.some(p => confirmed.some(c => {
      const a = byId.get(p.sourceEntryId), b = byId.get(c.sourceEntryId)
      return ['user-message', 'character-message'].includes(a.kind) && ['user-message', 'character-message'].includes(b.kind)
        && a.kind !== b.kind && a.participantId === b.participantId && b.id > a.id
    }))
    if (!exchanged) mode = clauses.some(c => c.role === 'condition') ? 'conditional' : 'unclassified'
  }
  if (mode === 'observed' && clauses.some(c => c.role === 'interpretation')) mode = 'belief'
  return { mode, clauses }
}

const keCases = [
  { mode: 'confirmed', clauses: [{ role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' }, { role: 'confirmation', sourceEntryId: 2, quote: '好啊，周末见' }] },
  // 只有提案，没有确认 → 不该是 confirmed
  { mode: 'confirmed', clauses: [{ role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' }] },
  // 同一方自查自答（都是 user-message）→ 交换不成立
  { mode: 'confirmed', clauses: [{ role: 'proposal', sourceEntryId: 1, quote: '那周末我来找你吧' }, { role: 'confirmation', sourceEntryId: 4, quote: '周末我不一定有空' }] },
  // 叙述里的「确认」要被降级成 interpretation
  { mode: 'confirmed', clauses: [{ role: 'confirmation', sourceEntryId: 3, quote: '他说过会来的' }] },
  { mode: 'observed', clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }, { role: 'interpretation', sourceEntryId: 3, quote: '他说过会来的' }] },
  { mode: 'observed', clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }] },
  { mode: 'belief', clauses: [{ role: 'interpretation', sourceEntryId: 3, quote: '他说过会来的' }] },
  { mode: 'conditional', clauses: [{ role: 'condition', sourceEntryId: 4, quote: '周末我不一定有空' }] },
  // 引文对不上 → 整条丢弃 → unclassified
  { mode: 'confirmed', clauses: [{ role: 'proposal', sourceEntryId: 1, quote: '这句话不在原文里' }] },
  // 引用了不在允许范围内的条目
  { mode: 'observed', clauses: [{ role: 'observation', sourceEntryId: 5, quote: '她看了看窗外' }] },
  { mode: 'nonsense-mode', clauses: [{ role: 'observation', sourceEntryId: 1, quote: '那周末我来找你吧' }] },
  {},
  null,
]

for (let i = 0; i < keCases.length; i++) {
  const raw = keCases[i]
  const allowed = [1, 2, 3, 4]
  const mine = ke.normalizeKnowledgeEvidence(raw, L, allowed)
  const up = upNormalize(raw, L.entries, allowed)
  check(`knowledge case ${i} (${JSON.stringify(raw)?.slice(0, 60)})`,
    mine.mode === up.mode && JSON.stringify(mine.clauses) === JSON.stringify(up.clauses),
    `mode ${mine.mode} vs ${up.mode} | clauses ${JSON.stringify(mine.clauses)} vs ${JSON.stringify(up.clauses)}`)
}

// supportsRecordedOutcome
const upSupports = k => ['observed', 'reported', 'confirmed'].includes(k.mode)
  && k.clauses.some(c => c.role === 'observation' || c.role === 'confirmation')
  && !k.clauses.some(c => c.role === 'interpretation')
for (const k of [
  { mode: 'observed', clauses: [{ role: 'observation' }] },
  { mode: 'observed', clauses: [{ role: 'interpretation' }] },
  { mode: 'belief', clauses: [{ role: 'observation' }] },
  { mode: 'confirmed', clauses: [{ role: 'confirmation' }] },
  { mode: 'unclassified', clauses: [] },
]) {
  check(`supportsRecordedOutcome(${k.mode})`, ke.supportsRecordedOutcome(k) === upSupports(k))
}

// legacyConditionCue
for (const t of ['前提是你要来', '至少三天', '普通内容', '']) {
  check(`legacyConditionCue(${t})`, ke.legacyConditionCue(t) === /前置|前提|门槛|至少|除非/.test(t))
}

/* ==================================================================
 * ③ development：维度白名单 + 跨场景计数
 * ================================================================== */

const upDimension = (target, path) => {
  const dimensions = {
    character: ['traits', 'preferences', 'coping'],
    perspective: ['values', 'interpretation'],
    relationship: ['trust', 'closeness', 'boundaries'],
    world: ['established'],
  }
  const normalized = path.trim().replace(/^(development|character|perspective|relationship|world)\./, '')
  return dimensions[target]?.includes(normalized) ? normalized : undefined
}

for (const [target, path] of [
  ['character', 'traits'], ['character', 'character.traits'], ['character', 'development.character.traits'],
  ['character', 'nonsense'], ['relationship', 'trust'], ['world', 'established'],
  ['perspective', 'values'], ['character', ' trust'], ['bogus', 'traits'],
]) {
  check(`developmentDimension(${target}, ${path})`,
    dv.developmentDimension(target, path) === upDimension(target, path),
    `${dv.developmentDimension(target, path)} vs ${upDimension(target, path)}`)
}

// developmentScenes（照抄上游）
function upScenes(entries) {
  const checkpoints = entries.flatMap(entry => {
    const cp = entry.metadata?.sceneCheckpoint
    return cp && typeof cp === 'object' ? [cp] : []
  })
  const scenes = new Set()
  const frameScenes = new Map()
  for (const entry of entries) {
    const cp = checkpoints.find(item => Number.isSafeInteger(item.sceneId)
      && entry.id >= item.firstEntryId && entry.id <= item.lastEntryId)
    if (cp && typeof entry.metadata?.frameId === 'string') frameScenes.set(entry.metadata.frameId, `scene:${cp.sceneId}`)
  }
  for (const entry of entries.filter(e => e.kind === 'script')) {
    const cp = checkpoints.find(item => Number.isSafeInteger(item.sceneId)
      && entry.id >= item.firstEntryId && entry.id <= item.lastEntryId)
    const frame = entry.metadata?.frameId
    if (cp) scenes.add(`scene:${cp.sceneId}`)
    else if (typeof frame === 'string' && frame) scenes.add(frameScenes.get(frame) ?? frame)
  }
  return scenes.size
}

const sceneCases = [
  [],
  [{ id: 1, kind: 'script', metadata: {} }],
  [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }],
  [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }, { id: 2, kind: 'script', metadata: { frameId: 'f1' } }],
  [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }, { id: 2, kind: 'script', metadata: { frameId: 'f2' } }],
  [{ id: 1, kind: 'script', metadata: { sceneCheckpoint: { sceneId: 7, firstEntryId: 1, lastEntryId: 3 } } }],
  [
    { id: 1, kind: 'script', metadata: { frameId: 'f1', sceneCheckpoint: { sceneId: 1, firstEntryId: 1, lastEntryId: 2 } } },
    { id: 2, kind: 'script', metadata: { frameId: 'f1' } },
  ],
  [{ id: 1, kind: 'user-message', metadata: { frameId: 'f9' } }],
]
for (let i = 0; i < sceneCases.length; i++) {
  const e = sceneCases[i]
  check(`developmentScenes case ${i}`, dv.developmentScenes(e) === upScenes(e),
    `${dv.developmentScenes(e)} vs ${upScenes(e)}`)
}

// promptReadyDevelopment
for (const [status, ids, entries] of [
  ['applied', [1], [{ id: 1, kind: 'script', metadata: {} }]],
  ['proposed', [1], [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }]],
  ['proposed', [1, 2], [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }, { id: 2, kind: 'script', metadata: { frameId: 'f2' } }]],
  ['proposed', [1, 2], [{ id: 1, kind: 'script', metadata: { frameId: 'f1' } }, { id: 2, kind: 'script', metadata: { frameId: 'f1' } }]],
]) {
  const cand = { status, sourceEntryIds: ids }
  const sources = new Set(ids)
  const upReady = status === 'applied' ? true : upScenes(entries.filter(e => sources.has(e.id))) >= 2
  check(`promptReadyDevelopment(${status}, ${ids})`, dv.promptReadyDevelopment(cand, entries) === upReady,
    `${dv.promptReadyDevelopment(cand, entries)} vs ${upReady}`)
}

/* ==================================================================
 * ④ scene-frame 投影：字段必须有溯源
 * ================================================================== */

const frame = sf.projectSceneFrame({
  storyId: 's1',
  now: '2026-01-01T00:00:00.000Z',
  scenePresence: [
    { name: '林知夏', status: 'present', sourceEntryIds: [3] },
    { name: '路人', status: 'off-scene', sourceEntryIds: [3] },
  ],
  workingDetails: [{ label: '烧水', value: '水壶在灶上', sourceEntryIds: [2] }],
  agencyWindow: { deviceAccess: 'available', privacy: 'private', activityLoad: 'free', sourceEntryIds: [4] },
})
check('投影后无溯源违规', sf.sceneFrameProvenanceErrors(frame).length === 0, JSON.stringify(sf.sceneFrameProvenanceErrors(frame)))
check('off-scene 的人不进 presentPeople', JSON.stringify(frame.presentPeople) === JSON.stringify(['林知夏']), JSON.stringify(frame.presentPeople))
check('sourceEntryIds 是各字段的并集', JSON.stringify(frame.sourceEntryIds) === JSON.stringify([2, 3, 4]), JSON.stringify(frame.sourceEntryIds))

// 帧身份必须与时间无关（铁律 1）
const f1 = sf.projectSceneFrame({ storyId: 's1', now: '2026-01-01T00:00:00.000Z' })
const f2 = sf.projectSceneFrame({ storyId: 's1', now: '2030-06-06T12:00:00.000Z' })
check('帧身份与时间无关', f1.id === f2.id, `${f1.id} vs ${f2.id}`)

console.log(fails === 0 ? '\n✅ 三份移植与上游语义一致' : `\n❌ ${fails} 处差异`)
process.exit(fails === 0 ? 0 : 1)

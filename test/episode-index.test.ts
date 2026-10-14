import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEpisodeIndex, episodeExcerpt, EpisodeSource } from '../src/script/episode-index'
import { deliveryReality } from '../src/script/delivery-reality'
import { compileNarrativeContext } from '../src/script/context-compiler'

const row = (content: string, participantId = 'a', frameId = 'scene:1'): EpisodeSource => ({
  content, participantId, frameId, occurredAt: '2026-09-05T00:00:00Z', kind: 'script',
})

test('episode navigation rebuilds identically and never groups separate relationships or scenes', () => {
  const rows: Array<[number, EpisodeSource]> = [[1, row('出发')], [2, row('抵达')], [3, row('秘密', 'b')], [4, row('新场景', 'a', 'scene:2')]]
  assert.deepEqual(buildEpisodeIndex(rows), buildEpisodeIndex(JSON.parse(JSON.stringify(rows))))
  assert.deepEqual(buildEpisodeIndex(rows).get(1), [1, 2])
  assert.deepEqual(buildEpisodeIndex(rows).get(3), [3])
})

test('long preceding prose cannot displace the recall hit and source ids reflect included text', () => {
  const rows: Array<[number, EpisodeSource]> = [[1, row('旧'.repeat(5000))], [2, row('取餐码8914')], [3, row('取走奶茶')]]
  const excerpt = episodeExcerpt(rows, 2, 200)!
  assert.match(excerpt.content, /取餐码8914/)
  assert.ok(excerpt.sourceEntryIds.includes(2))
  assert.ok(excerpt.sourceEntryIds.includes(3))
  assert.ok(!excerpt.sourceEntryIds.includes(1))
  assert.equal(rows[0][1].content.length, 5000)
})

test('delivery reality preserves prose and distinguishes unconfirmed receipt from cancellation', () => {
  const entry: any = { id: 1, kind: 'script', content: '她发了两句话。', metadata: { commitId: 'c', deliveryActions: [{ commitId: 'c', eventId: 'e', segments: [
    { kind: 'message', content: '第一句', status: 'delivered' },
    { kind: 'message', content: '第二句', status: 'pending' },
  ] }] } }
  const before = JSON.stringify(entry)
  const result = deliveryReality([entry])
  assert.equal(result[0].segments[1].outcome, 'not-confirmed')
  assert.equal(JSON.stringify(entry), before)
  assert.equal(deliveryReality([{ ...entry, kind: 'user-message' }]).length, 0)
})

test('compiled writing context excludes legacy rhythm directives and carries execution evidence', () => {
  const result = compileNarrativeContext({ chatRhythm: { drift: '强制三段' }, deliveryReality: [{ sourceEntryId: 1 }] }, undefined, undefined)
  assert.doesNotMatch(JSON.stringify(result), /强制三段|chatRhythm/)
  assert.deepEqual(result.ongoingThreads.deliveryReality, [{ sourceEntryId: 1 }])
})

test('checkpoint provenance groups legacy original entries without merging relationships', () => {
  const rows: Array<[number, EpisodeSource]> = [
    [1, { ...row('起点'), frameId: undefined }],
    [2, { ...row('结束'), frameId: undefined, checkpoint: { sceneId: 7, firstEntryId: 1, lastEntryId: 3 } }],
    [3, { ...row('另一关系', 'b'), frameId: undefined }],
  ]
  assert.deepEqual(buildEpisodeIndex(rows).get(1), [1, 2])
  assert.deepEqual(buildEpisodeIndex(rows).get(3), [3])
})

test('cross-relationship action text stays out of delivery reality unless sharing is enabled', () => {
  const entry: any = { id: 1, kind: 'script', metadata: { commitId: 'c', deliveryActions: [{
    commitId: 'c', participantId: 'b', eventId: 'e', segments: [{ kind: 'message', content: '私密行动', status: 'pending' }],
  }] } }
  assert.deepEqual(deliveryReality([entry], 'a', false), [])
  assert.equal(deliveryReality([entry], 'b', false).length, 1)
})

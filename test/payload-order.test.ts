import assert from 'node:assert/strict'
import test from 'node:test'
import { systemPrompt, toPromptPayload } from '../src/narrator'
import { emptyStorySetting, emptyStoryState, InterludeStory, NarrativeRequest, ScriptEntry } from '../src/types'

const now = new Date('2026-08-30T11:22:00.000Z')

function story(): InterludeStory {
  return {
    id: 'story', platform: 'onebot', selfId: 'bot', userId: '', channelId: '', status: 'active',
    setting: emptyStorySetting(),
    state: { ...emptyStoryState(), continuitySnapshot: { current: '在房间', next: [], recent: [], salient: [] } },
    cursorAt: now, createdAt: now, updatedAt: now,
  }
}

function entry(id: number, kind: string, content: string, offsetMinutes: number): ScriptEntry {
  const occurredAt = new Date(now.getTime() - offsetMinutes * 60_000)
  const actor = kind === 'script' ? 'narrator' : kind === 'intent-cancelled' ? 'system' : 'character'
  return { id, storyId: 'story', participantId: 'participant', kind, actor, content, occurredAt, metadata: {}, createdAt: occurredAt }
}

function request(recentEntries: ScriptEntry[], userMessage?: string, overrides: Partial<NarrativeRequest> = {}): NarrativeRequest {
  return {
    phase: 'user-message', story: story(), from: now, now, userMessage, participant: null,
    participants: [], shareParticipantDetails: false, dueIntents: [], activeConsequences: [], supersededIntents: [],
    memories: [], recentEntries, ...overrides,
  }
}

function commonPrefixLength(left: string, right: string) {
  let index = 0
  const limit = Math.min(left.length, right.length)
  while (index < limit && left[index] === right[index]) index++
  return index
}

test('eligible group targets survive both payload orders without copying group history', () => {
  const targets = [{ participantId: 'group:12345', groupId: '12345', label: '技术群' }]
  for (const cacheFirst of [false, true]) {
    const payload = toPromptPayload(request([], '去技术群发个消息', { availableGroupTargets: targets }), { cacheFirst }) as any
    assert.deepEqual(payload.ongoingThreads.availableGroupTargets, targets)
    assert.equal(payload.incomingEvent.groupContext, undefined)
    assert.deepEqual((toPromptPayload(request([]), { cacheFirst }) as any).ongoingThreads.availableGroupTargets, [])
  }
  const prompt = systemPrompt('user-message', '', '', '', '', '')
  assert.match(prompt, /interaction describes ONLY messages to the current private participant/)
  assert.match(prompt, /A promise to send later is not a completed send/)
  assert.match(prompt, /crossConversationActions/)
})

test('both payload modes use the seven-part script continuation scaffold', () => {
  const req = request([entry(1, 'character-message', '拿到了。确实挺大杯。', 50)], '你健忘吗')
  const legacy = toPromptPayload(req) as Record<string, unknown>
  const explicitOff = toPromptPayload(req, { cacheFirst: false }) as Record<string, unknown>
  assert.deepEqual(Object.keys(explicitOff), Object.keys(legacy))
  assert.deepEqual(Object.keys(legacy), [
    'storyIdentity', 'relevantEstablishedEpisodes', 'currentSceneEvidence', 'ongoingThreads',
    'availableNearFuture', 'incomingEvent', 'authoringWindow',
  ])
  assert.equal('recentExchange' in (legacy as any).relevantEstablishedEpisodes, false)
})

test('cache-first puts stable blocks first and per-turn fields beside the decision point', () => {
  const req = request([entry(1, 'character-message', '拿到了。确实挺大杯。', 50)], '你健忘吗')
  const payload = toPromptPayload(req, { cacheFirst: true }) as Record<string, unknown>
  const keys = Object.keys(payload)
  assert.deepEqual(keys, [
    'storyIdentity', 'relevantEstablishedEpisodes', 'currentSceneEvidence', 'ongoingThreads',
    'availableNearFuture', 'incomingEvent', 'authoringWindow',
  ])
  const established = payload.relevantEstablishedEpisodes as Record<string, unknown>
  assert.equal(Object.keys(established)[0], 'recentScript')
  assert.ok('recentExchange' in established)
  assert.ok('interval' in (payload.authoringWindow as Record<string, unknown>))
})

test('recentExchange anchors only transport exchanges, excludes the live message and never repeats script prose', () => {
  const req = request([
    entry(1, 'user-message', '旧的一句', 240),
    entry(2, 'character-message', '拿到了。确实挺大杯。', 200),
    entry(3, 'script', '剧'.repeat(900), 150),
    entry(4, 'character-message', '嗯。', 100),
    entry(5, 'user-message', '你健忘吗', 5),
  ], '你健忘吗')
  const payload = toPromptPayload(req, { cacheFirst: true }) as any
  const items = payload.relevantEstablishedEpisodes.recentExchange
  assert.equal(items.length, 3)
  const received = items.find((item: any) => item.content === '拿到了。确实挺大杯。')
  assert.equal(received?.tag, 'protagonist')
  assert.ok(!JSON.stringify(items).includes('你健忘吗'))
  assert.ok(!JSON.stringify(items).includes('剧'.repeat(20)), '剧本文字不应进入 transport 尾部锚点')
  const total = items.reduce((sum: number, item: any) => sum + item.content.length, 0)
  assert.ok(total <= 1_600)
  assert.ok(items.some((item: any) => item.content.includes('旧的一句')), '跳过剧本文字后，最近三条真实收发消息应补足尾部块')
})

test('consecutive user turns keep append-only history at the cacheable front of the compiled context', () => {
  const longScript = '剧'.repeat(3_000)
  const turnOne = request([
    entry(1, 'script', longScript, 60),
    entry(2, 'character-message', '拿到了。', 55),
    entry(3, 'user-message', '在吗', 50),
  ], '在吗')
  const turnTwo = request([
    entry(1, 'script', longScript, 60),
    entry(2, 'character-message', '拿到了。', 55),
    entry(3, 'user-message', '在吗', 50),
    entry(4, 'script', '后续剧情。', 10),
    entry(5, 'character-message', '嗯。', 8),
    entry(6, 'user-message', '吃饭没', 5),
  ], '吃饭没', { from: new Date(now.getTime() - 6 * 60_000) })

  const cacheOne = JSON.stringify(toPromptPayload(turnOne, { cacheFirst: true }))
  const cacheTwo = JSON.stringify(toPromptPayload(turnTwo, { cacheFirst: true }))
  const cachePrefix = commonPrefixLength(cacheOne, cacheTwo)
  // 分叉点恰好是 recentScript 数组的收口：追加式历史让旧内容全部留在缓存前缀内。
  const historyEnd = cacheOne.indexOf('],"sceneContext"')
  assert.ok(cachePrefix >= historyEnd - 1, '前缀分叉点不得早于对话史数组结束')
  assert.ok(cachePrefix >= cacheOne.length * 0.5, `cache-first 前缀命中过短: ${cachePrefix}/${cacheOne.length}`)
  assert.ok(cachePrefix < cacheOne.indexOf('"currentSceneEvidence"'), '分叉点应位于当前场景证据视图之前')

  const legacyOne = JSON.stringify(toPromptPayload(turnOne))
  const legacyTwo = JSON.stringify(toPromptPayload(turnTwo))
  assert.ok(commonPrefixLength(legacyOne, legacyTwo) >= legacyOne.indexOf('],"sceneContext"') - 1)
  assert.ok(cacheOne.length < legacyOne.length, 'compact tags should keep cache-first payload smaller')
})

test('group turns keep recentExchange empty because groupContext already ends near the decision point', () => {
  const req = request([entry(1, 'group-message', '群里说话', 5)], undefined, {
    groupContext: { groupId: '111', channelId: '111', label: '群', purpose: '闲聊', characterRole: '群友', messages: [] },
  })
  const payload = toPromptPayload(req, { cacheFirst: true }) as any
  assert.deepEqual(payload.relevantEstablishedEpisodes.recentExchange, [])
})

test('compact tags collapse kind/actor triples and keep group and action distinctions', () => {
  const req = request([
    entry(1, 'character-message', 'a', 50),
    entry(2, 'character-group-message', 'b', 49),
    entry(3, 'character-platform-action', 'c', 48),
    entry(4, 'script', 'd', 47),
    entry(5, 'user-message', 'e', 46),
    entry(6, 'group-message', 'f', 45),
    entry(7, 'intent-cancelled', 'g', 44),
  ], '当前消息')
  const payload = toPromptPayload(req, { cacheFirst: true }) as any
  assert.deepEqual(payload.relevantEstablishedEpisodes.recentScript.map((item: any) => item.tag), [
    'protagonist', 'protagonist(group)', 'protagonist(action)', 'protagonist-narration', 'user', 'group-member', 'system',
  ])
  assert.ok(payload.relevantEstablishedEpisodes.recentScript.every((item: any) => !('participantId' in item)))
})

test('participantId survives only when the history actually spans several branches', () => {
  const same = [entry(1, 'user-message', 'a', 50), entry(2, 'character-message', 'b', 49)]
  const payloadSame = toPromptPayload(request(same, 'x'), { cacheFirst: true }) as any
  assert.ok(payloadSame.relevantEstablishedEpisodes.recentScript.every((item: any) => !('participantId' in item)))
  const mixed = [...same]
  mixed[1] = { ...mixed[1], participantId: 'onebot:bot:222' }
  const payloadMixed = toPromptPayload(request(mixed, 'x'), { cacheFirst: true }) as any
  assert.ok(payloadMixed.relevantEstablishedEpisodes.recentScript.every((item: any) => item.participantId === 'participant' || item.participantId === 'onebot:bot:222'))
})

test('the ownership legend matches the payload mode', () => {
  const args = ['user-message', '', '', '', '', ''] as const
  const legacy = systemPrompt(...args)
  const compact = systemPrompt(...args, false, false, false, false, false, undefined, false, undefined, false, false, true)
  assert.match(legacy, /ownership label is authoritative/)
  assert.doesNotMatch(legacy, /compact tag/)
  assert.match(compact, /compact tag that is authoritative/)
  assert.match(compact, /protagonist\(group\)/)
  assert.match(compact, /protagonist\(action\)/)
})

test('workingDetails, recalledScript and previousScenes ride the payload in the right zones', () => {
  const req = request([entry(1, 'user-message', '在吗', 5)], '在吗', {
    workingDetails: [{ label: '奶茶取餐码', value: '8914', expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), createdAt: now.toISOString() }],
    recalledHistory: [{ id: 99, occurredAt: '2026-08-30T10:00:00.000Z', content: '拿到了。确实挺大杯。' }],
    sceneContext: { scene: null, arc: null, previousScenes: [{ startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T10:30:00.000Z', summary: '上一场景摘要' }] },
  })
  const legacy = toPromptPayload(req) as any
  assert.equal(legacy.ongoingThreads.workingDetails[0].value, '8914')
  assert.equal(legacy.relevantEstablishedEpisodes.recalledScript[0].id, 99)
  assert.equal(legacy.relevantEstablishedEpisodes.sceneContext.previousScenes[0].summary, '上一场景摘要')
  const cache = toPromptPayload(req, { cacheFirst: true }) as any
  assert.equal(cache.ongoingThreads.workingDetails[0].value, '8914')
  assert.equal(cache.relevantEstablishedEpisodes.recalledScript[0].id, 99)
  assert.equal(cache.incomingEvent.event.content, '在吗')
})

test('the fixed contract documents the three memory blocks', () => {
  const prompt = systemPrompt('user-message', '', '', '', '', '')
  assert.match(prompt, /previousScenes, when supplied/)
  assert.match(prompt, /workingDetails, when supplied/)
  assert.match(prompt, /recalledScript, when supplied/)
})

test('the fixed contract explains recentExchange only for cache-first payloads', () => {
  const args = ['user-message', '', '', '', '', ''] as const
  const plain = systemPrompt(...args)
  const cacheAware = systemPrompt(...args, false, false, false, false, false, undefined, false, undefined, false, false, true)
  assert.doesNotMatch(plain, /recentExchange/)
  assert.match(cacheAware, /recentExchange at the end duplicates the tail of recentScript/)
})

/**
 * 剧本条目账本（`lib/script-entry.js`）的用例。
 *
 * 这一层是 Phase 2/3 的地基（scene-frame / knowledge-evidence / life-handoff /
 * development 全都靠它），所以要钉住的不是「函数能跑」，而是几条**一旦破掉就会
 * 让溯源变成谎言**的不变式：
 *
 *   ① id 全局单调递增，且**永不重用**（复用会让旧 sourceEntryIds 指向别的正文）；
 *   ② 裁剪只删条目、不动发号器（否则删一批之后新条目会撞上旧 id）；
 *   ③ 逐字校验是**严格包含**，不做同义、模糊、纠错；
 *   ④ 任何损坏输入都降级成空账本，绝不抛错（持久化问题不该打断回合）。
 *
 * 运行：node test/script-entry.test.mjs
 */
import assert from 'node:assert/strict'

import {
  ENTRY_KINDS, DELIVERED_KINDS, createLedger, normalizeLedger, normalizeEntry,
  appendEntry, entryById, entriesAfter, recentEntries, validEntryIds,
  verifyQuote, groundedIds, pruneLedger, isDeliveredKind,
  recordEvent, recordFromLog, draftFromEvent, textOfContent,
} from '../lib/script-entry.js'

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

console.log('剧本条目账本')

/* ------------------------------------------------------ ① id 不变式 */

ok('appendEntry：id 从 1 开始且严格递增', () => {
  const ledger = createLedger()
  const a = appendEntry(ledger, { kind: 'script', content: '第一段' })
  const b = appendEntry(ledger, { kind: 'script', content: '第二段' })
  assert.equal(a.id, 1)
  assert.equal(b.id, 2)
})

ok('id 永不重用：删掉末尾条目后，新条目拿到更大的 id', () => {
  // 这是整套溯源的地基。若这里退化成「按数组长度发号」，
  // 删掉一条再追加就会撞上已存在的 id —— 旧的 sourceEntryIds 会指向另一段正文。
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'script', content: 'A' })
  const b = appendEntry(ledger, { kind: 'script', content: 'B' })
  const beforeDelete = b.id
  ledger.entries = ledger.entries.filter(x => x.id !== b.id) // 手工删掉最后一条
  const c = appendEntry(ledger, { kind: 'script', content: 'C' })
  assert.ok(c.id > beforeDelete, `新 id 应大于被删的 ${beforeDelete}，实际 ${c.id}`)
  assert.equal(entryById(ledger, beforeDelete), undefined, '被删的 id 不该复活')
  assert.equal(entryById(ledger, c.id).content, 'C', '新 id 指向新内容')
})

ok('pruneLedger：只删条目，不回退发号器', () => {
  const ledger = createLedger()
  for (let i = 0; i < 10; i++) appendEntry(ledger, { kind: 'script', content: `第${i}段` })
  const nextIdBefore = ledger.nextId
  const removed = pruneLedger(ledger, 3)
  assert.equal(removed, 7)
  assert.equal(ledger.entries.length, 3)
  assert.equal(ledger.nextId, nextIdBefore, '裁剪不该动 nextId')
  const fresh = appendEntry(ledger, { kind: 'script', content: '新的' })
  assert.equal(fresh.id, nextIdBefore, '裁剪后新条目接着发号，不撞旧 id')
})

ok('裁剪保留的是**最新的**几条', () => {
  const ledger = createLedger()
  for (let i = 1; i <= 10; i++) appendEntry(ledger, { kind: 'script', content: `第${i}段` })
  pruneLedger(ledger, 3)
  assert.deepEqual(ledger.entries.map(e => e.id), [8, 9, 10])
})

/* ------------------------------------------------------ ② 规范化 / 降级 */

ok('normalizeLedger：任何损坏输入都降级成空账本，不抛错', () => {
  for (const bad of [undefined, null, 0, 'x', [], { entries: 'nope' }, { entries: [null, 1, 'a'] }]) {
    const ledger = normalizeLedger(bad)
    assert.deepEqual(ledger.entries, [], JSON.stringify(bad))
    assert.ok(ledger.nextId >= 1)
  }
})

ok('normalizeLedger：丢弃无 id / 无正文的条目，保留合法的', () => {
  const ledger = normalizeLedger({
    entries: [
      { id: 1, kind: 'script', content: '合法' },
      { kind: 'script', content: '没有 id' },
      { id: 2, kind: 'script', content: '   ' },
      { id: 3, kind: 'script', content: '' },
      null,
    ],
  })
  assert.deepEqual(ledger.entries.map(e => e.content), ['合法'])
})

ok('normalizeLedger：nextId 不会低于已有最大 id + 1', () => {
  // 旧版本文件可能没有 nextId，或被手改坏。若照抄一个偏小的值，
  // 下一条新条目就会撞上已有 id。
  const ledger = normalizeLedger({ nextId: 1, entries: [{ id: 7, kind: 'script', content: 'x' }] })
  assert.equal(ledger.nextId, 8)
})

ok('normalizeEntry：未知 kind 退化成 script，不丢正文', () => {
  const entry = normalizeEntry({ id: 1, kind: '外星类型', content: '正文' })
  assert.equal(entry.kind, 'script')
  assert.equal(entry.content, '正文')
})

ok('normalizeEntry：metadata 循环引用不炸，降级成空对象', () => {
  const circular = {}
  circular.self = circular
  const entry = normalizeEntry({ id: 1, kind: 'script', content: 'x', metadata: circular })
  assert.deepEqual(entry.metadata, {})
})

ok('normalizeEntry：超长 metadata 丢弃，不撑爆状态文件', () => {
  const huge = { blob: 'x'.repeat(9000) }
  const entry = normalizeEntry({ id: 1, kind: 'script', content: 'x', metadata: huge })
  assert.deepEqual(entry.metadata, {})
})

/* ------------------------------------------------------ ③ 追加的边界 */

ok('appendEntry：空白正文不产生条目（也不消耗 id）', () => {
  const ledger = createLedger()
  assert.equal(appendEntry(ledger, { kind: 'script', content: '   ' }), undefined)
  assert.equal(appendEntry(ledger, { kind: 'script' }), undefined)
  assert.equal(ledger.entries.length, 0)
  assert.equal(appendEntry(ledger, { kind: 'script', content: '有内容' }).id, 1, 'id 不该被空写入消耗')
})

ok('appendEntry：正文超长被截断而不是无限增长', () => {
  const ledger = createLedger()
  const entry = appendEntry(ledger, { kind: 'script', content: 'x'.repeat(99999) })
  assert.ok(entry.content.length <= 8000, `实际 ${entry.content.length}`)
})

ok('appendEntry：默认 occurredAt 是合法 ISO 时间', () => {
  const ledger = createLedger()
  const entry = appendEntry(ledger, { kind: 'script', content: 'x' })
  assert.ok(!Number.isNaN(Date.parse(entry.occurredAt)), entry.occurredAt)
})

/* ------------------------------------------------------ ④ 读取语义 */

ok('entriesAfter：游标分页，严格大于游标且升序', () => {
  const ledger = createLedger()
  for (let i = 1; i <= 5; i++) appendEntry(ledger, { kind: 'script', content: `第${i}` })
  const page = entriesAfter(ledger, 2, 2)
  assert.deepEqual(page.map(e => e.id), [3, 4], '应为 (2, +∞) 的前 2 条')
})

ok('recentEntries：按 id 降序（与上游 desc 一致）', () => {
  const ledger = createLedger()
  for (let i = 1; i <= 5; i++) appendEntry(ledger, { kind: 'script', content: `第${i}` })
  assert.deepEqual(recentEntries(ledger, 3).map(e => e.id), [5, 4, 3])
})

ok('validEntryIds / entryById：非整数输入安全', () => {
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'script', content: 'x' })
  assert.equal(entryById(ledger, 'abc'), undefined)
  assert.equal(entryById(ledger, null), undefined)
  assert.equal(entryById(ledger, 1.5), undefined)
  assert.deepEqual([...validEntryIds(ledger)], [1])
})

/* ------------------------------------------------------ ⑤ 逐字校验（地基） */

ok('verifyQuote：原文里逐字找得到才算数', () => {
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'user-message', content: '明天下午三点在楼下等你。' })
  assert.equal(verifyQuote(ledger, 1, '明天下午三点').ok, true)
  assert.equal(verifyQuote(ledger, 1, '明天下午四点').ok, false, '改一个字就不算引用')
})

ok('verifyQuote：不做同义/模糊判断（宁可判无证据，也不替模型圆场）', () => {
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'script', content: '她答应明天早点睡。' })
  // 换一种说法、换个近义词，都不算数——引用必须是**原文片段**。
  assert.equal(verifyQuote(ledger, 1, '她同意早点休息').ok, false)
  assert.equal(verifyQuote(ledger, 1, '明天早点睡').ok, true, '连续的原文片段应通过')
})

ok('verifyQuote：区分「条目不存在」与「引用对不上」', () => {
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'script', content: '正文' })
  assert.equal(verifyQuote(ledger, 999, '正文').reason, 'entry-not-found')
  assert.equal(verifyQuote(ledger, 1, '不存在的片段').reason, 'quote-not-in-entry')
  assert.equal(verifyQuote(ledger, 1, '   ').reason, 'empty-quote')
})

ok('verifyQuote：超长引文被拒（预算防线）', () => {
  const ledger = createLedger()
  appendEntry(ledger, { kind: 'script', content: 'x'.repeat(1000) })
  assert.equal(verifyQuote(ledger, 1, 'x'.repeat(900)).reason, 'quote-too-long')
})

/* ------------------------------------------------------ ⑥ 锚定过滤 */

ok('groundedIds：只留下**确实存在**的 id，去重升序', () => {
  const ledger = createLedger()
  for (let i = 1; i <= 3; i++) appendEntry(ledger, { kind: 'script', content: `第${i}` })
  assert.deepEqual(groundedIds(ledger, [3, 1, 1, 99, 'x', null, 2]), [1, 2, 3])
})

ok('groundedIds：非数组安全返回空', () => {
  const ledger = createLedger()
  for (const bad of [undefined, null, 'x', 42, {}]) assert.deepEqual(groundedIds(ledger, bad), [])
})

ok('groundedIds：超过上限时保留**最大**的那些（离当下最近）', () => {
  const ledger = createLedger()
  for (let i = 1; i <= 30; i++) appendEntry(ledger, { kind: 'script', content: `第${i}` })
  const ids = groundedIds(ledger, Array.from({ length: 30 }, (_, i) => i + 1), 5)
  assert.deepEqual(ids, [26, 27, 28, 29, 30])
})

/* ------------------------------------------------------ ⑦ kind 语义 */

ok('isDeliveredKind：只有「真实说出的话」才算投递', () => {
  // 这个区分是认知证据的地基：叙述散文里的一句引号**不能**确认另一个人的行为。
  assert.equal(isDeliveredKind('user-message'), true)
  assert.equal(isDeliveredKind('character-message'), true)
  assert.equal(isDeliveredKind('group-message'), true)
  assert.equal(isDeliveredKind('character-group-message'), true)
  assert.equal(isDeliveredKind('script'), false, '叙述散文不是投递')
  assert.equal(isDeliveredKind('不存在'), false)
})

ok('kind 常量与上游一致', () => {
  assert.deepEqual(ENTRY_KINDS, ['script', 'user-message', 'character-message', 'group-message', 'character-group-message'])
  assert.equal(DELIVERED_KINDS.length, 4)
})

/* ------------------------------------------------------ ⑧ 事件 → 条目 */

const evUser = text => ({ type: 'user/message', time: 1000, data: { content: [{ type: 'text', text }] } })
const evAssistant = text => ({ type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text }] } } })

ok('draftFromEvent：用户消息→user-message，角色正文→script', () => {
  assert.equal(draftFromEvent(evUser('在吗'), {}).kind, 'user-message')
  assert.equal(draftFromEvent(evAssistant('（她放下手机。）'), {}).kind, 'script')
})

ok('draftFromEvent：插件自己的注入**不**记成用户说话', () => {
  // 记进去会让「用户说过」变成假的——那是系统提示，不是谁说的话。
  const injected = { type: 'user/message', data: { content: [{ type: 'text', text: '（幕间唤起）' }], source: { kind: 'plugin', plugin: 'hds-interlude' } } }
  assert.equal(draftFromEvent(injected, {}), undefined)
})

ok('draftFromEvent：无正文的控制事件不进账本', () => {
  assert.equal(draftFromEvent({ type: 'turn/end' }, {}), undefined)
  assert.equal(draftFromEvent(evUser(''), {}), undefined)
  assert.equal(draftFromEvent({ type: 'assistant/message', data: { message: { content: [] } } }, {}), undefined)
})

ok('draftFromEvent：interlude_say 才记成 character-message（真实说出的话）', () => {
  // 这是认知证据的地基：DSH 里「写出的正文」与「发出去的话」是两件事。
  // assistant/message → script（叙述），interlude_say → character-message（真说了）。
  const say = {
    type: 'tool/call',
    data: { name: 'interlude_say', arguments: JSON.stringify({ text: '好啊，周末见' }) },
  }
  const draft = draftFromEvent(say, {})
  assert.equal(draft.kind, 'character-message')
  assert.equal(draft.content, '好啊，周末见')
})

ok('draftFromEvent：其它工具调用不进账本', () => {
  for (const name of ['interlude_memory', 'interlude_plan', 'interlude_handoff', 'other_tool']) {
    assert.equal(draftFromEvent({ type: 'tool/call', data: { name, arguments: '{}' } }, {}), undefined, name)
  }
})

ok('draftFromEvent：interlude_say 参数坏掉时安全跳过', () => {
  for (const args of ['{坏 JSON', null, undefined, JSON.stringify({ text: '  ' }), JSON.stringify({})]) {
    assert.equal(draftFromEvent({ type: 'tool/call', data: { name: 'interlude_say', arguments: args } }, {}), undefined, String(args))
  }
})

ok('recordFromLog：一轮对话按顺序产出条目', () => {
  const state = { ledger: createLedger() }
  const events = [evUser('在吗'), evAssistant('（她放下手机。）\n\n“在的”'), { type: 'turn/end' }]
  const created = recordFromLog(state, { total: events.length, eventAt: i => events[i] })
  assert.deepEqual(created.map(e => e.kind), ['user-message', 'script'])
  assert.deepEqual(created.map(e => e.id), [1, 2])
})

ok('recordFromLog：**幂等**——重复折叠不产生重复条目', () => {
  // 这是本模块最重要的性质：foldFromLog 每个 pre-step / 每次工具调用都会跑，
  // 若「见事件就追加」，同一句话会在账本里出现很多遍。
  const state = { ledger: createLedger() }
  const events = [evUser('在吗'), evAssistant('“在的”')]
  const first = recordFromLog(state, { total: events.length, eventAt: i => events[i] })
  assert.equal(first.length, 2)
  for (let i = 0; i < 5; i++) {
    const again = recordFromLog(state, { total: events.length, eventAt: i => events[i] })
    assert.equal(again.length, 0, `第 ${i + 2} 次折叠不该再产出条目`)
  }
  assert.equal(state.ledger.entries.length, 2, '账本里始终只有两条')
  assert.equal(state.ledger.nextId, 3, 'id 不该被空折叠消耗')
})

ok('recordFromLog：日志增长后只记新增的那一段', () => {
  const state = { ledger: createLedger() }
  const events = [evUser('第一句'), evAssistant('第一段正文')]
  recordFromLog(state, { total: events.length, eventAt: i => events[i] })
  // 日志继续增长
  events.push(evUser('第二句'), evAssistant('第二段正文'))
  const created = recordFromLog(state, { total: events.length, eventAt: i => events[i] })
  assert.deepEqual(created.map(e => e.content), ['第二句', '第二段正文'])
  assert.equal(state.ledger.entries.length, 4)
})

ok('recordEvent：游标不因「事件不产条目」而卡住', () => {
  // 若遇到 turn/end 就不推进游标，之后每个事件都会被反复重扫。
  const ledger = createLedger()
  const position = { seq: 0 }
  recordEvent(ledger, { type: 'turn/end' }, { seq: 1 })
  assert.equal(ledger.cursor, 1, '不产条目也要推进游标')
  const entry = recordEvent(ledger, evUser('在吗'), { seq: 2 })
  assert.ok(entry, '后续事件仍应被正常记录')
})

ok('recordFromLog：参与人/作者被带进条目', () => {
  const state = { ledger: createLedger() }
  const events = [evUser('在吗')]
  recordFromLog(state, { total: 1, eventAt: i => events[i], participantId: 'qq_bot', actor: 'user' })
  assert.equal(state.ledger.entries[0].participantId, 'qq_bot')
  assert.equal(state.ledger.entries[0].actor, 'user')
})

ok('recordFromLog：超上限时裁剪，且用日志里的真实时间', () => {
  const state = { ledger: createLedger() }
  const events = Array.from({ length: 20 }, (_, i) => evUser(`第${i}句`))
  recordFromLog(state, { total: events.length, eventAt: i => events[i], limit: 5 })
  assert.equal(state.ledger.entries.length, 5)
  assert.deepEqual(state.ledger.entries.map(e => e.content), ['第15句', '第16句', '第17句', '第18句', '第19句'])
  assert.equal(state.ledger.entries[0].occurredAt, new Date(1000).toISOString(), '应用事件时间而非当前时间')
})

ok('recordFromLog：非日志派生的字段坏掉也降级，不抛错', () => {
  const state = { ledger: '坏掉的' }
  const events = [evUser('在吗')]
  const created = recordFromLog(state, { total: 1, eventAt: i => events[i] })
  assert.equal(created.length, 1, '坏账本应被重建后照常记录')
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

/**
 * rc50 移植的第二批：全局事实主体澄清、情节索引查找优化、DeepSeek 家族行收窄。
 *
 * 运行：node test/rc50-batch.test.mjs
 */
import assert from 'node:assert/strict'
import { factEvidenceForPrompt, KNOWLEDGE_WRITING_FRAME } from '../lib/knowledge-evidence.js'
import { buildEpisodeIndex } from '../lib/episode-index.js'
import { familyOverrides } from '../lib/specialization.js'

let passed = 0
let failed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

console.log('rc50 第二批：事实主体 / 索引查找 / 家族行')

/* ───────── ① 全局事实主体澄清 ───────── */

check('factEvidenceForPrompt：不再投影 participantId（主体写回正文）', () => {
  const fact = {
    id: 7, participantId: 'p-abc', scope: 'event', content: '小林说他准备出门',
    unresolved: false, status: 'active', sourceEntryIds: [1],
    knowledge: { mode: 'reported', clauses: [{ role: 'observation', sourceEntryId: 1, quote: '准备出门' }] },
  }
  const view = factEvidenceForPrompt(fact)
  assert.equal(view.participantId, undefined, '不该再带 participantId（上游 rc50）')
  assert.equal(view.id, 7)
  assert.equal(view.content, '小林说他准备出门', '正文照旧透传')
  assert.equal(view.authority, 'derived-record')
})

check('factEvidenceForPrompt：belief 仍标 attributed-belief（认知区分不受影响）', () => {
  const view = factEvidenceForPrompt({
    id: 8, scope: 'relationship', content: '她觉得小林在生气',
    knowledge: { mode: 'belief', clauses: [] },
  })
  assert.equal(view.authority, 'attributed-belief')
  assert.equal(view.participantId, undefined)
})

check('事实写作契约：明确要求相关人写进正文、且点出反例', () => {
  assert.ok(KNOWLEDGE_WRITING_FRAME.includes('全局叙事材料'), '应说明事实是全局材料')
  assert.ok(KNOWLEDGE_WRITING_FRAME.includes('小林说他准备出门'), '应给合格示例')
  assert.ok(KNOWLEDGE_WRITING_FRAME.includes('他说他准备出门'), '应给不合格反例')
})

/* ───────── ② 情节索引：二分查找与重叠回退 ───────── */

const at = (id, cp, frameId) => ({ id, participantId: '', metadata: cp ? { sceneCheckpoint: cp } : frameId ? { frameId } : {} })

check('buildEpisodeIndex：不相交检查点按区间分组（二分路径）', () => {
  const entries = [
    at(1, { sceneId: 1, firstEntryId: 1, lastEntryId: 3 }),
    at(2, { sceneId: 1, firstEntryId: 1, lastEntryId: 3 }),
    at(3, { sceneId: 1, firstEntryId: 1, lastEntryId: 3 }),
    at(4, { sceneId: 2, firstEntryId: 4, lastEntryId: 6 }),
    at(5, { sceneId: 2, firstEntryId: 4, lastEntryId: 6 }),
  ]
  const index = buildEpisodeIndex(entries)
  assert.deepEqual(index.get(1), [1, 2, 3], '同场景归一组')
  assert.deepEqual(index.get(4), [4, 5], '下一个场景另起一组')
  assert.notEqual(index.get(1), index.get(4))
})

check('buildEpisodeIndex：区间外的条目退化成单点锚', () => {
  const entries = [at(9, { sceneId: 1, firstEntryId: 1, lastEntryId: 3 })]
  const index = buildEpisodeIndex(entries)
  assert.deepEqual(index.get(9), [9], '9 不在 [1,3] 里 → 单点')
})

check('buildEpisodeIndex：检查点重叠时保留 first-match 语义（不因二分改变结果）', () => {
  // 重叠：A [1,5] 与 B [3,8]。id=4 两段都命中——旧实现取**先出现的** A。
  const entries = [
    at(1, { sceneId: 10, firstEntryId: 1, lastEntryId: 5 }),
    at(4, { sceneId: 20, firstEntryId: 3, lastEntryId: 8 }),
    at(6, { sceneId: 20, firstEntryId: 3, lastEntryId: 8 }),
  ]
  const index = buildEpisodeIndex(entries)
  const groupOf4 = index.get(4)
  const groupOf1 = index.get(1)
  assert.deepEqual(groupOf4, groupOf1 === groupOf4 ? groupOf1 : groupOf4)
  // id=4 应落进 scene:10（first-match），而不是 scene:20。
  assert.deepEqual(index.get(4), [1, 4], '重叠时取先出现的检查点（与优化前一致）')
  assert.deepEqual(index.get(6), [6], 'id=6 只命中 B → 自己在 B 组')
})

check('buildEpisodeIndex：无检查点时按 frameId 分组（原行为不变）', () => {
  const entries = [at(1, undefined, 'f1'), at(2, undefined, 'f1'), at(3, undefined, 'f2')]
  const index = buildEpisodeIndex(entries)
  assert.deepEqual(index.get(1), [1, 2])
  assert.deepEqual(index.get(3), [3])
})

check('buildEpisodeIndex：空/损坏输入安全', () => {
  assert.equal(buildEpisodeIndex([]).size, 0)
  assert.equal(buildEpisodeIndex(undefined).size, 0)
  assert.equal(buildEpisodeIndex([{ id: 'x' }, null]).size, 0)
})

/* ───────── ③ DeepSeek 家族行收窄（rc50） ───────── */

check('DeepSeek 家族行：收窄成「确实要说话的回合」才必需（rc50）', () => {
  const line = familyOverrides('deepseek').extraAfterPhase
  assert.ok(line.includes('本轮若确实要对她说话'), '应限定适用回合')
  assert.ok(line.includes('自主生活推进'), '应明确豁免自主推进回合')
  assert.ok(line.includes('本来就没有可发的话'), '应说明"没发"不等于漏发')
  // 原有语义不能丢。
  assert.ok(line.includes('interlude_say'))
  assert.ok(line.includes('不是模板'))
  assert.ok(line.includes('安静结束'))
})

console.log(`\nrc50 第二批：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

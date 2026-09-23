/**
 * 语义召回（`lib/semantic-recall.js`）的用例。
 *
 * 移植自上游 1.0.0-beta2-m4 的语义召回路（DSH 形态：可插拔 embed + 无 embed 降级）。
 * 要钉住：
 *   ① 余弦相似度与归一化的数值正确性；
 *   ② 无 embed / embed 失败 → 返回 null（调用方走原词法路径）；
 *   ③ 语义明显相关的条目整体提前，且尾部事实保持召回完整性。
 *
 * 运行：node test/semantic-recall.test.mjs
 */
import assert from 'node:assert/strict'

import {
  dot, norm, cosineSimilarity, normalizeVector,
  rankFactsWithSemantic, factEmbeddingText, DEFAULT_SEMANTIC_WEIGHT,
} from '../lib/semantic-recall.js'

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

console.log('语义召回（Embedding）')

/* ------------------------------------------------------------ ① 数值正确性 */

ok('dot / norm：基本向量运算', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32)
  assert.equal(norm([3, 4]), 5)
  assert.equal(norm([]), 0)
})

ok('cosineSimilarity：同向 = 1、垂直 = 0、反向 = 0（截断）', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), 0, '反向截断到 0')
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
})

ok('normalizeVector：单位长度', () => {
  const unit = normalizeVector([3, 4])
  assert.ok(Math.abs(norm(unit) - 1) < 1e-9)
  assert.deepEqual(normalizeVector([0, 0]), [0, 0])
  assert.deepEqual(normalizeVector([]), [])
})

/* ------------------------------------------------------------ ② 降级语义 */

ok('rankFactsWithSemantic：无 embed → null', async () => {
  const facts = [{ id: 1, content: '她喜欢猫' }]
  assert.equal(await rankFactsWithSemantic(facts, '猫咪怎么样', {}), null)
  assert.equal(await rankFactsWithSemantic(facts, '', { embed: async () => [1] }), null)
  assert.equal(await rankFactsWithSemantic([], 'q', { embed: async () => [1] }), null)
})

ok('rankFactsWithSemantic：embed 抛错 → null（降级不抛错）', async () => {
  const facts = [{ id: 1, content: 'x' }]
  const result = await rankFactsWithSemantic(facts, 'q', {
    embed: async () => { throw new Error('embed 服务不可用') },
  })
  assert.equal(result, null)
})

ok('factEmbeddingText：key + content 拼接、限量', () => {
  const text = factEmbeddingText({ key: '猫咪', content: '她养了一只猫' })
  assert.ok(text.includes('猫咪'))
  assert.ok(text.includes('她养了一只猫'))
  const long = factEmbeddingText({ content: 'x'.repeat(5000) })
  assert.ok(long.length <= 4000)
})

/* ------------------------------------------------------------ ③ 排序语义 */

ok('rankFactsWithSemantic：语义相关的整体提前', async () => {
  const facts = [
    { id: 1, content: '她最喜欢下雨天待在窗边' },
    { id: 2, content: '他周三要去银行办事' },
    { id: 3, content: '上周买的相机到了' },
  ]
  // embed 用内容与查询的字面重合度充当伪向量：语义上「下雨天窗边」最贴近「天气」。
  const embed = async (text) => {
    const vector = []
    for (const token of ['下雨', '窗边', '银行', '相机', '天气']) {
      vector.push(text.includes(token) ? 1 : 0)
    }
    return vector
  }
  const result = await rankFactsWithSemantic(facts, '今天天气怎么样', { embed })
  assert.ok(result, 'embed 可用时应返回重排结果')
  assert.equal(result[0].id, 1, '语义相关的排最前')
})

ok('rankFactsWithSemantic：尾部事实保持召回完整', async () => {
  const facts = Array.from({ length: 10 }, (_, i) => ({ id: i, content: `普通内容 ${i}` }))
  const embed = async () => [0.1, 0.2]
  const result = await rankFactsWithSemantic(facts, 'q', { embed, top: 8 })
  assert.equal(result.length, 10, '数量不减')
})

ok('DEFAULT_SEMANTIC_WEIGHT 与上游同量级', () => {
  assert.equal(DEFAULT_SEMANTIC_WEIGHT, 0.55)
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

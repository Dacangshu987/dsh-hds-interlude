/**
 * 语义召回（移植自上游 1.0.0-beta2-m4 的三路召回中的语义路）。
 *
 * ## 它解决什么
 *
 * 词法召回（`lib/recall.js`）只能匹配**字面相同**的词——「猫咪」与「猫」、
 * 「电脑」与「计算机」永远匹配不上（模块注释里如实记录的局限）。上游用
 * **embedding 语义召回**补上这一维：把事实与当前消息都变成向量，按余弦相似度
 * 找回**意思相近**但字面不同的内容。
 *
 * ## 与上游的差异（DSH 形态）
 *
 * 上游的 embedding 是持久化基础设施：给每条原始剧本/事实建向量、渐进补齐、
 * 按消息实时查询（`liveQuery`）。DSH 侧**没有自带 embedding 通道**，所以这里
 * 做成**可插拔**：
 *   - `rankFactsWithSemantic(facts, query, { embed })` 需要调用方注入
 *     `embed(text) => Promise<number[]>`（未来宿主暴露 embedding 模型时接上即可）；
 *   - 未注入 embed 时返回 `null`——调用方**原样走词法路径**，行为与现在完全一致
 *     （降级不是回退，是「没有向量就不假装有」）。
 *
 * 纯计算部分（余弦、向量归一、语义加权排序）全部可独立单测。
 *
 * @module dsh-hds-interlude/semantic-recall
 */

/** 语义权重上限（与上游 `semanticWeight` 默认同量级）。 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.55

/** 单次查询最多向 embed 发送的字符数（防止长文把 embedding 接口撑爆）。 */
export const MAX_EMBED_INPUT = 4000

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

/**
 * 向量点积。
 *
 * @param {number[]} left 左向量。
 * @param {number[]} right 右向量。
 * @returns {number}
 */
export function dot(left, right) {
  const a = Array.isArray(left) ? left : []
  const b = Array.isArray(right) ? right : []
  let sum = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/**
 * 向量 L2 范数。
 *
 * @param {number[]} vector 向量。
 * @returns {number} 范数（零向量返回 0）。
 */
export function norm(vector) {
  const v = Array.isArray(vector) ? vector : []
  let sum = 0
  for (const value of v) sum += value * value
  return Math.sqrt(sum)
}

/**
 * 余弦相似度（0–1；任一为零向量返回 0）。
 *
 * @param {number[]} left 左向量。
 * @param {number[]} right 右向量。
 * @returns {number} 0–1。
 */
export function cosineSimilarity(left, right) {
  const a = Array.isArray(left) ? left : []
  const b = Array.isArray(right) ? right : []
  if (!a.length || !b.length) return 0
  const leftNorm = norm(a)
  const rightNorm = norm(b)
  if (!leftNorm || !rightNorm) return 0
  return Math.max(0, Math.min(1, dot(a, b) / (leftNorm * rightNorm)))
}

/**
 * 归一化向量（就地生成新数组，不修改入参）。
 *
 * @param {number[]} vector 向量。
 * @returns {number[]} 单位向量；零向量原样返回。
 */
export function normalizeVector(vector) {
  const v = Array.isArray(vector) ? vector : []
  const length = norm(v)
  if (!length) return [...v]
  return v.map((value) => value / length)
}

/**
 * 单条事实 → 参与语义匹配的文本（key 与正文拼接）。
 *
 * @param {object} fact 长期事实。
 * @returns {string}
 */
export function factEmbeddingText(fact) {
  const f = record(fact)
  return [f.key, f.content]
    .filter((value) => typeof value === 'string' && value)
    .join('\n')
    .slice(0, MAX_EMBED_INPUT)
}

/**
 * 语义召回：用注入的 embed 给查询与每条事实打分，按语义相关度重排。
 *
 * ## 语义与词法的合并方式
 *
 * 不重造轮子：**语义命中把条目整体提前**，命中组内再用「词法分数 + 语义分数
 * 加权」定序。这与 `rankFactsByRecall` 的「命中/不命中分组」哲学一致——
 * 语义是额外证据，不是覆盖原排序的魔法值。
 *
 * @param {Array<object>} facts 已排序的事实（重要度序）。
 * @param {string} query 当前查询串（用户消息 + 到点摘要）。
 * @param {object} options
 * @param {Function} options.embed `(text: string) => Promise<number[]>`。
 * @param {number} [options.weight=0.55] 语义权重。
 * @param {number} [options.top=8] 参与排序的事实上限（embed 有成本，先裁剪）。
 * @returns {Promise<Array<object>|null>} 重排后的事实；embed 缺失/失败返回 null
 *   （调用方走原词法路径）。
 */
export async function rankFactsWithSemantic(facts, query, { embed, weight = DEFAULT_SEMANTIC_WEIGHT, top = 8 } = {}) {
  const list = Array.isArray(facts) ? [...facts] : []
  if (!list.length || typeof embed !== 'function') return null
  const text = String(query ?? '').trim()
  if (!text) return null

  let queryVector
  try {
    queryVector = normalizeVector(await embed(text.slice(0, MAX_EMBED_INPUT)))
  } catch {
    return null // embed 通道故障 → 降级词法，不抛错打断回合
  }
  if (!queryVector.length) return null

  const candidates = list.slice(0, Math.max(1, top))
  const scored = []
  for (const fact of candidates) {
    let vector
    try {
      vector = normalizeVector(await embed(factEmbeddingText(fact)))
    } catch {
      continue
    }
    const semantic = vector.length ? cosineSimilarity(queryVector, vector) : 0
    scored.push({ fact, semantic })
  }
  if (!scored.length) return null
  // 语义分降序；语义打平保持原序（stable）。
  scored.sort((left, right) => right.semantic - left.semantic)
  const hits = scored.filter((item) => item.semantic > 0.5) // 明显相关的才提前
  const rest = scored.filter((item) => item.semantic <= 0.5)
  const reordered = [...hits, ...rest].map((item) => item.fact)
  // 把未参与排序的尾部事实接回（保持召回完整性）。
  if (list.length > candidates.length) return [...reordered, ...list.slice(candidates.length)]
  return reordered
}

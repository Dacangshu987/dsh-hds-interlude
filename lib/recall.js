/**
 * 零依赖词法召回导航（移植自上游 hds-interlude `src/script/recall-navigation.ts`）。
 *
 * ## 这个模块解决什么
 *
 * 长期记忆（facts）在会话变长之后会越攒越多，而**注入预算是固定的**。原先只能靠
 * 「重要度 + 新旧」排序 —— 那对「用户刚刚提到的那件事」完全无感：一条三个月前
 * 的高重要度事实，永远压过昨天刚聊到的细节。
 *
 * 这里补上**词法相关度**这一维：拿当前这句话去和每条事实做轻量匹配。刻意用
 * 纯算法（CJK 二字符滑动 shingle + 字母数字词），不引入向量库：
 *   - 没有额外依赖与网络调用，冷会话磁盘扫描也能跑；
 *   - 结果**可解释**（命中哪些 key 一眼看得见），便于排查；
 *   - 召回是**导航**，不是证据：它只决定「把哪条拿出来看」，不改变事实本身。
 *
 * ## 与上游的差异
 *
 * 上游的 `originalWindow` 是为一整篇连续散文（`recentScript`）找窗口用的；DSH 的
 * 记忆单位是**一条条 fact**，所以这里只移植「怎么打分」与「怎么找窗口」两件事，
 * 并补一个直接面向 fact 列表的 `rankFactsByRecall`。
 *
 * @module dsh-hds-interlude/lib/recall
 */

/** 单块最大字符数；句子边界优先，超长句才硬切。 */
const CHUNK_BUDGET = 700

/**
 * 把一段文本切成用于匹配的词元（keys）。
 *
 * 规则：
 *   - 拉丁字母/数字：取长度 ≥2 的连续串（`hello`、`v2`）；
 *   - CJK：**二字符滑动窗口**（「今天天气」→ 今天/天天/天气）。
 *     为什么不用单字：单字命中率过高（「的」「是」到处都是），会把排序冲垮；
 *     为什么不用分词：那要引入词典依赖，且中文分词在短句上并不稳。
 *
 * ## 已知局限（**如实记录，不要当成 bug 去"修"**）
 *
 * 二字符 shingle 要求**至少两个字完全一致**才能匹配。于是：
 *   - 「猫咪」与「猫」**完全不匹配**（前者 key 是 猫咪，后者只有一个字，不成键）；
 *   - 「电脑」与「计算机」这种同义不同词也匹配不上。
 *
 * 这是纯词法方案的固有代价，上游同样如此。它的定位是**便宜的导航**：
 * 命中就提前，没命中就退回原排序，不会给出错误结论。
 * 真要解决同义/近义，得上 embedding 或同义词表——那是另一件事，别在这里悄悄加。
 *
 * @param {string} text 待提取文本。
 * @returns {string[]} 去重后的词元。
 */
export function recallKeys(text) {
  const normalized = String(text ?? '').toLowerCase()
  if (!normalized) return []
  const words = normalized.match(/[a-z0-9]{2,}/g) ?? []
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2))
  }
  return [...new Set(words)]
}

/**
 * 把原文切成带词元索引的块（span）。
 *
 * **句子边界保护**：按 `。！？\n` 切，而不是按固定字数硬切。条件句被切断会读出
 * 相反的意思（「如果你方便的话」/「我就不过去了」被切成两块，后半句看起来像
 * 单独的决定）。只有在单句本身就超过预算时才硬切。
 *
 * @param {string} content 原文。
 * @returns {Array<{start: number, end: number, keys: Set<string>}>} 块列表。
 */
export function indexOriginal(content) {
  const text = String(content ?? '')
  const spans = []
  const sentences = [...text.matchAll(/[^。！？\n]+[。！？\n]*|[。！？\n]+/g)]
  let start = 0
  let end = 0
  const emit = (from, to) => {
    if (to > from) spans.push({ start: from, end: to, keys: new Set(recallKeys(text.slice(from, to))) })
  }
  const flush = () => {
    emit(start, end)
    start = end
  }
  for (const sentence of sentences) {
    if (end > start && end - start + sentence[0].length > CHUNK_BUDGET) flush()
    end = sentence.index + sentence[0].length
    // 单个句子本身就超预算时的**兜底硬切**。
    //
    // 上游没做这一步：一整段没有句号的文本（模型完全可能写出来——连续对白、
    // 不分段的独白）会变成**一个** 900+ 字的巨块，分块等于没分：`scoreOriginal`
    // 只能整块命中或不命中，`originalWindow` 也永远退化到硬截。
    // 这里按预算切开，保证「块」始终是个有界的检索单位。
    while (end - start > CHUNK_BUDGET) {
      emit(start, start + CHUNK_BUDGET)
      start += CHUNK_BUDGET
    }
  }
  flush()
  return spans
}

/**
 * 在已索引的块里找与查询最匹配的那一块。
 *
 * 打分是**覆盖率**（命中 key 数 / 查询 key 总数），不是命中次数——否则一段反复
 * 出现「今天」的文本会靠数量压过长尾但更相关的匹配。
 *
 * @param {string[]} keys 查询词元。
 * @param {Array<{keys: Set<string>}>} spans 已索引的块。
 * @returns {{score: number, index: number}} 得分与最佳块下标（无命中时 index=0）。
 */
export function scoreOriginal(keys, spans) {
  let score = 0
  let index = 0
  if (!Array.isArray(keys) || !keys.length || !Array.isArray(spans) || !spans.length) {
    return { score, index }
  }
  for (let i = 0; i < spans.length; i++) {
    let hit = 0
    for (const key of keys) if (spans[i].keys.has(key)) hit += 1
    const value = hit / keys.length
    if (value > score) {
      score = value
      index = i
    }
  }
  return { score, index }
}

/**
 * 在预算内取出一个原文窗口（以最佳块为锚，尽量带上相邻句）。
 *
 * 返回的是一段**节选**，不是完整记录——调用方需要知道这一点，否则会把「没被
 * 选中的部分」当成不存在。`truncated` 就是给这个用途的。
 *
 * @param {string} content 原文。
 * @param {Array<{start: number, end: number}>} spans 已索引的块。
 * @param {number} index 锚点块下标。
 * @param {number} budget 字符预算。
 * @param {string[]} [queryKeys] 查询词元（用于把窗口往命中处收）。
 * @returns {{content: string, start: number, end: number, truncated: boolean}}
 */
export function originalWindow(content, spans, index, budget, queryKeys = []) {
  const text = String(content ?? '')
  const limit = Math.max(0, Number(budget) || 0)
  if (text.length <= limit) return { content: text, start: 0, end: text.length, truncated: false }
  const anchor = spans?.[index]
  if (!anchor) {
    return { content: text.slice(0, limit), start: 0, end: Math.min(limit, text.length), truncated: true }
  }
  let start = anchor.start
  let end = anchor.end
  // 锚点块本身超预算：把它往查询词出现的位置收，而不是一律从头截。
  if (end - start > limit && queryKeys.length) {
    const lower = text.toLowerCase()
    const offsets = queryKeys
      .map(key => lower.indexOf(key, anchor.start))
      .filter(offset => offset >= start && offset < end)
    if (offsets.length) {
      const hit = Math.min(...offsets)
      start = Math.max(start, Math.min(hit - Math.floor(limit / 3), end - limit))
    }
  }
  // 邻居能整块塞进预算就一起带上，保证条件句与它的结论同框。
  for (const neighbor of [spans[index - 1], spans[index + 1]]) {
    if (neighbor && Math.max(end, neighbor.end) - Math.min(start, neighbor.start) <= limit) {
      start = Math.min(start, neighbor.start)
      end = Math.max(end, neighbor.end)
    }
  }
  // 单句超长时明确标注是节选，而不是假装完整。
  const hardEnd = Math.min(end, start + limit)
  return { content: text.slice(start, hardEnd), start, end: hardEnd, truncated: hardEnd < text.length }
}

/**
 * 用当前这句话 + 到点摘要，拼出用于召回的查询串。
 *
 * @param {string|undefined} message 用户这条消息。
 * @param {string[]} [topics] 待办/主题摘要。
 * @param {string[]} [intentSummaries] 意图摘要。
 * @returns {string} 查询串。
 */
export function recallFocus(message, topics = [], intentSummaries = []) {
  const cues = [...new Set([...intentSummaries, ...topics].map(s => String(s ?? '').trim()).filter(Boolean))].slice(0, 6)
  const head = typeof message === 'string' ? message.trim().slice(0, 400) : ''
  return [head, ...cues.map(s => s.slice(0, 80))].filter(Boolean).join('\n')
}

/**
 * 给一条 fact 算词法相关度（0–1）。
 *
 * 取内容与 key 两个字段的最大值：事实的 `key` 往往是「怎么称呼这件事」，
 * 比正文更容易命中用户的用词。
 *
 * @param {object} fact 长期事实。
 * @param {Set<string>|string[]} queryKeys 查询词元。
 * @returns {number} 0–1 的相关度。
 */
export function recallRelevance(fact, queryKeys) {
  const keys = queryKeys instanceof Set ? queryKeys : new Set(queryKeys ?? [])
  if (!keys.size) return 0
  const haystack = [fact?.key, fact?.content]
    .filter(value => typeof value === 'string' && value)
    .join('\n')
  if (!haystack) return 0
  const own = new Set(recallKeys(haystack))
  let hit = 0
  for (const key of keys) if (own.has(key)) hit += 1
  return hit / keys.size
}

/**
 * 按「相关度优先、再看原排序」重排一批 fact。
 *
 * ## 为什么是「保底 + 证据」而不是加权平均
 *
 * 试过两种写法，都有坑，记在这里免得再走一遍：
 *
 * 1. **加权平均** `base*(1-w) + relevance*w`：排在最前那条的 base 恒为 1.0，
 *    而相关度要拿命中的。3 条事实、w=0.35 时，末位即使相关度满分也只有
 *    `0*0.65 + 1*0.35 = 0.35`，仍输给首位毫不相关的 0.65 —— 「召回」等于没做。
 *
 * 2. **乘数削弱** `base*(1-w*relevance)`：相关度只削弱 base。但**排最后那条的
 *    base 恰好是 0**，`0 × 任何数 = 0`，永远翻不了身 —— 而"排最后"恰恰是最需要
 *    被召回救回来的位置。
 *
 * 症结是把两件事混在一个式子里。它们性质不同：
 *   - 原排序是**保底**：没有词法信号时该怎么办；
 *   - 相关度是**证据**：它明确知道这条与当前这句话有关。
 *
 * 所以分开处理：保底分压到一个**不会归零的窄区间**（0.5–1.0），相关度作为
 * **加法项**直接抬升。
 *
 * 3. **加法项仍不够（第三次踩坑）**：宽 0.5 的保底区间意味着**部分命中**
 *    （相关度 0.5）恰好只能追平首位的 1.0——于是并列，再由原位置决定胜负，
 *    召回等于没做。实际情形：「公园散步怎么样」命中 3/6 个词元（0.5），
 *    而首位那条毫不相关的事实 base=1.0，两者打平。
 *
 * 最终采用**两级排序**：先按「有没有相关度」分组，组内再按分数。
 * 这样任何**确实命中**的条目都排在没命中的之前，命中程度只在命中组内部比较。
 * 这正是我们真正想要的语义：「相关的优先，不相关的保持原顺序」。
 *
 * @param {Array<object>} facts 已按重要度排好序的事实。
 * @param {string} query 查询串（通常来自 {@link recallFocus}）。
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.keys] 直接给定词元，免去重复提取。
 * @returns {Array<object>} 重排后的事实（不改原数组）。
 */
export function rankFactsByRecall(facts, query, { keys } = {}) {
  const list = Array.isArray(facts) ? [...facts] : []
  const queryKeys = keys ?? new Set(recallKeys(query))
  if (!queryKeys.size || !list.length) return list
  const total = list.length
  const scored = list.map((fact, position) => {
    // 保底分：把原始次序压进 0.5–1.0，只用于**命中组内部**的次序。
    // 下限不取 0 是刻意的（归零会让末位翻不了身），但因为它只影响组内次序，
    // 具体取值不再敏感。
    const base = total <= 1 ? 1 : 1 - 0.5 * (position / (total - 1))
    const relevance = recallRelevance(fact, queryKeys)
    return { fact, position, relevance, score: base + relevance }
  })
  scored.sort((left, right) => {
    // 第一级：**命中与不命中分组**。
    // 这是关键——只靠分数相加时，部分命中（0.5）会与首位的保底分（1.0）打平，
    // 于是并列后由原位置决定胜负，召回形同虚设。
    const leftHit = left.relevance > 0 ? 1 : 0
    const rightHit = right.relevance > 0 ? 1 : 0
    if (leftHit !== rightHit) return rightHit - leftHit
    // 第二级：组内按分数（命中组里更相关的在前；不命中组里保持原重要度次序）。
    return right.score - left.score || left.position - right.position
  })
  return scored.map(item => item.fact)
}

/**
 * 零依赖词法召回（`lib/recall.js`）的用例。
 *
 * 移植自上游 hds-interlude `src/script/recall-navigation.ts`。这一层要钉住三件事：
 *   ① 算法语义与上游一致（键提取 / 分块 / 打分 / 开窗）；
 *   ② 中文靠二字符 shingle、英文数字靠词，别退化成「单字命中」把排序冲垮；
 *   ③ 为 DSH 的记忆单位（一条条 fact）补的 `rankFactsByRecall` 真的有效。
 *
 * 运行：node test/recall.test.mjs
 */
import assert from 'node:assert/strict'

import {
  recallKeys, indexOriginal, scoreOriginal, originalWindow, recallFocus,
  recallRelevance, rankFactsByRecall,
} from '../lib/recall.js'

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

console.log('零依赖词法召回')

/* ------------------------------------------------------------ ① 键提取 */

ok('recallKeys：英文/数字取长度 ≥2 的词', () => {
  assert.deepEqual(recallKeys('hello world v2 a').sort(), ['hello', 'v2', 'world'])
})

ok('recallKeys：中文用二字符滑动窗口，不是单字', () => {
  assert.deepEqual(recallKeys('今天天气').sort(), ['今天', '天天', '天气'])
  // 关键回归：绝不能出现单字（会把排序冲垮）
  for (const key of recallKeys('今天天气')) assert.equal(key.length, 2, `不该有单字键：${key}`)
})

ok('recallKeys：中英混排各走各的规则', () => {
  const keys = recallKeys('v2 版本更新了')
  assert.ok(keys.includes('v2'), '英数词保留')
  assert.ok(keys.includes('版本'), '中文二字符')
})

ok('recallKeys：空输入/非字符串安全', () => {
  assert.deepEqual(recallKeys(''), [])
  assert.deepEqual(recallKeys(undefined), [])
  assert.deepEqual(recallKeys(null), [])
})

ok('recallKeys：结果去重', () => {
  const keys = recallKeys('今天今天今天')
  assert.equal(keys.length, new Set(keys).size, '不该有重复键')
})

/* ------------------------------------------------------------ ② 分块 */

ok('indexOriginal：按句子边界分块，条件句不被切断', () => {
  // 这是这个函数存在的理由：条件与结论必须留在同一块。
  const text = '如果你方便的话，我就不过去了。明天再说。'
  const spans = indexOriginal(text)
  const first = text.slice(spans[0].start, spans[0].end)
  assert.ok(first.includes('如果你方便的话') && first.includes('我就不过去了'),
    `条件句被切断了：${JSON.stringify(first)}`)
})

ok('indexOriginal：块之间连续且覆盖全文（不丢字）', () => {
  const text = '第一句。第二句！第三句？'
  const spans = indexOriginal(text)
  assert.equal(spans[0].start, 0)
  assert.equal(spans.at(-1).end, text.length)
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].start, spans[i - 1].end, '块之间不该有缝或重叠')
  }
  assert.equal(spans.map(s => text.slice(s.start, s.end)).join(''), text, '拼起来应等于原文')
})

ok('indexOriginal：单句超预算才硬切（700 字）', () => {
  const long = `${'啊'.repeat(900)}。`
  const spans = indexOriginal(long)
  assert.ok(spans.length >= 2, '超长单句应被切开')
  assert.ok(spans[0].end - spans[0].start <= 700, '切出来的块不该超预算')
})

ok('indexOriginal：空串安全返回空数组', () => {
  assert.deepEqual(indexOriginal(''), [])
  assert.deepEqual(indexOriginal(undefined), [])
})

/* ------------------------------------------------------------ ③ 打分 */

ok('scoreOriginal：命中越多分越高', () => {
  const spans = indexOriginal('今天天气不错。我们去公园散步吧。')
  const hit = scoreOriginal(recallKeys('公园散步'), spans)
  const miss = scoreOriginal(recallKeys('完全无关的内容'), spans)
  assert.ok(hit.score > 0, '相关查询应有分')
  assert.equal(miss.score, 0, '无关查询应为 0')
})

ok('scoreOriginal：覆盖率而非命中次数（长文本不靠数量取胜）', () => {
  // 一块里「今天」出现很多次、另一块精确覆盖查询的两个词。
  // 用覆盖率时后者胜；用次数前者会赢——这正是要防的。
  const spans = [
    { keys: new Set(['今天']) },
    { keys: new Set(['明天', '早睡']) },
  ]
  const result = scoreOriginal(['明天', '早睡'], spans)
  assert.equal(result.index, 1, '应选覆盖率更高的那块')
  assert.equal(result.score, 1)
})

ok('scoreOriginal：无词元/无块时返回 0 且不越界', () => {
  assert.deepEqual(scoreOriginal([], indexOriginal('abc')), { score: 0, index: 0 })
  assert.deepEqual(scoreOriginal(['a'], []), { score: 0, index: 0 })
  assert.deepEqual(scoreOriginal(null, null), { score: 0, index: 0 })
})

/* ------------------------------------------------------------ ④ 开窗 */

ok('originalWindow：原文没超预算就整段返回', () => {
  const text = '很短的一段话。'
  const spans = indexOriginal(text)
  const w = originalWindow(text, spans, 0, 1000)
  assert.equal(w.content, text)
  assert.equal(w.truncated, false, '完整返回不该标截断')
})

ok('originalWindow：超预算时以命中块为锚，并标注是节选', () => {
  const text = `${'前'.repeat(400)}。目标句在这里。${'后'.repeat(400)}。`
  const spans = indexOriginal(text)
  const keys = recallKeys('目标句')
  const { index } = scoreOriginal(keys, spans)
  const w = originalWindow(text, spans, index, 60, keys)
  assert.ok(w.content.includes('目标句'), `应围绕命中处取窗，实际：${JSON.stringify(w.content)}`)
  assert.equal(w.truncated, true, '超预算必须明确标成节选，别让调用方以为拿到了全文')
})

ok('originalWindow：预算内会带上相邻句（条件与结论同框）', () => {
  const text = '如果你方便的话。我就不过去了。其它无关内容在这里占位。'
  const spans = indexOriginal(text)
  const keys = recallKeys('方便')
  const { index } = scoreOriginal(keys, spans)
  const w = originalWindow(text, spans, index, 200, keys)
  assert.ok(w.content.includes('如果你方便的话') && w.content.includes('我就不过去了'),
    `相邻句该一起带出来：${JSON.stringify(w.content)}`)
})

ok('originalWindow：预算为 0 时安全返回空，不抛错', () => {
  const text = '一些内容。'
  const w = originalWindow(text, indexOriginal(text), 0, 0)
  assert.equal(w.content, '')
  assert.equal(w.truncated, true)
})

ok('originalWindow：没有锚点时退化成从头截，不崩', () => {
  const text = 'abcdefg'
  const w = originalWindow(text, [], 99, 3)
  assert.equal(w.content, 'abc')
  assert.equal(w.truncated, true)
})

/* ------------------------------------------------------------ ⑤ 查询串 */

ok('recallFocus：合并消息与摘要，去重并限量', () => {
  const focus = recallFocus('她今天提到公园', ['公园', '早睡'], ['早睡'])
  assert.ok(focus.includes('她今天提到公园'))
  assert.equal(focus.split('\n').filter(l => l === '公园').length, 1, '不该重复')
})

ok('recallFocus：无输入时返回空串', () => {
  assert.equal(recallFocus(undefined), '')
  assert.equal(recallFocus('', [], []), '')
})

/* ------------------------------------------------------------ ⑥ fact 相关度 */

ok('recallRelevance：key 与 content 都参与匹配', () => {
  const fact = { key: '公园', content: '她周末喜欢去公园散步' }
  assert.ok(recallRelevance(fact, recallKeys('公园')) > 0, 'key 应能命中')
  assert.ok(recallRelevance(fact, recallKeys('散步')) > 0, 'content 应能命中')
  assert.equal(recallRelevance(fact, recallKeys('完全无关')), 0)
})

ok('recallRelevance：无查询词元时返回 0（不做无依据的加权）', () => {
  assert.equal(recallRelevance({ content: '任意' }, new Set()), 0)
  assert.equal(recallRelevance({ content: '任意' }, []), 0)
})

ok('recallRelevance：空事实安全', () => {
  assert.equal(recallRelevance({}, recallKeys('公园')), 0)
  assert.equal(recallRelevance(null, recallKeys('公园')), 0)
})

/* ------------------------------------------------------------ ⑦ 重排 */

ok('rankFactsByRecall：相关的被提前（原排序里它在后面）', () => {
  const facts = [
    { key: '工作', content: '最近项目很忙' },
    { key: '宠物', content: '家里养了只猫' },
    { key: '公园', content: '周末常去公园散步' },
  ]
  const ranked = rankFactsByRecall(facts, '公园散步')
  assert.equal(ranked[0].key, '公园', `相关的应排最前：${ranked.map(f => f.key)}`)
})

ok('rankFactsByRecall：不修改传入的数组', () => {
  const facts = [{ key: 'a', content: 'x' }, { key: '公园', content: 'y' }]
  const snapshot = facts.map(f => f.key)
  rankFactsByRecall(facts, '公园')
  assert.deepEqual(facts.map(f => f.key), snapshot, '不该就地改动调用方的数组')
})

ok('rankFactsByRecall：无查询时保持原顺序（不做无依据扰动）', () => {
  const facts = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  assert.deepEqual(rankFactsByRecall(facts, '').map(f => f.key), ['a', 'b', 'c'])
  assert.deepEqual(rankFactsByRecall(facts, undefined).map(f => f.key), ['a', 'b', 'c'])
})

ok('rankFactsByRecall：**部分命中**也能排到不相关的前面（两级排序）', () => {
  // 第三次踩坑的回归。曾经用「保底分 + 相关度」相加：
  // 首位那条不相关的事实保底 1.0，而部分命中（3/6 = 0.5）加保底 0.5 恰好也是 1.0，
  // 并列之后由原位置决定胜负——召回形同虚设。
  // 现在先按「有没有命中」分组，任何确实命中的都排在没命中的之前。
  const facts = [
    { key: '无关但重要', content: '最近项目很忙' },
    { key: '无关二', content: '家里养了只猫' },
    { key: '相关但次要', content: '周末常去公园散步' },
  ]
  const ranked = rankFactsByRecall(facts, '公园散步怎么样')
  assert.equal(ranked[0].key, '相关但次要', `部分命中也要浮上来：${ranked.map(f => f.key)}`)
})

ok('rankFactsByRecall：命中组内部按相关度排', () => {
  const facts = [
    { key: '弱', content: '公园' },
    { key: '强', content: '公园散步' },
  ]
  const ranked = rankFactsByRecall(facts, '公园散步')
  assert.equal(ranked[0].key, '强', `命中更多的在前：${ranked.map(f => f.key)}`)
})

ok('rankFactsByRecall：空列表/非数组安全', () => {
  assert.deepEqual(rankFactsByRecall([], '公园'), [])
  assert.deepEqual(rankFactsByRecall(null, '公园'), [])
})

/* ------------------------------------------------------------ ⑧ 已知局限 */

ok('已知局限：单个汉字不成键，所以「猫咪」匹配不到「猫」', () => {
  // 这是纯词法方案的**固有代价**，不是 bug：二字符 shingle 要求至少两字相同。
  // 把它钉住，是为了防止有人"顺手"改成单字匹配——那会把「的」「是」这类
  // 高频字放进词元表，直接冲垮整个排序。
  assert.deepEqual(recallKeys('猫'), [], '单个汉字不成键')
  assert.equal(recallRelevance({ content: '家里养了只猫叫豆豆' }, recallKeys('猫咪')), 0)
  // 但两个字的词是能匹配上的——这是它能用的前提。
  assert.ok(recallRelevance({ content: '家里养了只猫叫豆豆' }, recallKeys('豆豆')) > 0,
    '完全一致的二字词应能命中')
})

ok('已知局限：同义不同词匹配不上（不做同义词猜测）', () => {
  // 「电脑」与「计算机」在词法上毫无重叠。宁可召回不到，也不要靠猜。
  assert.equal(recallRelevance({ content: '她的电脑坏了' }, recallKeys('计算机')), 0)
})

console.log(failed === 0
  ? `\n✅ 全部通过（${passed} 项）`
  : `\n❌ 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

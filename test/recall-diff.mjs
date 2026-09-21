/**
 * 差分核验：`lib/recall.js` 的移植函数与上游 `recall-navigation.ts` 语义是否一致。
 *
 * 做法：把上游逻辑**逐行照抄**成本文件内的参照实现（而不是 import 自己），
 * 两边跑同一批输入比对结果。这样任何一处走样都会被抓到。
 *
 * ## 一处刻意的差异
 *
 * `indexOriginal` 比上游多做一件事：**单个句子超预算时也按 700 字硬切**。
 * 上游对「一整段没有句号的长文本」只产出一个巨块，分块等于没分（`scoreOriginal`
 * 只能整块命中或不命中，`originalWindow` 永远退化到硬截）。
 * 这一处差异是有意的，下面用 `normalize` 把超预算块抹平后再比较。
 *
 * 运行：node test/recall-diff.mjs
 */
import * as mine from '../lib/recall.js'

/* ---------- 上游参照实现（照抄 recall-navigation.ts） ---------- */
function upKeys(text) {
  const n = text.toLowerCase()
  const w = n.match(/[a-z0-9]{2,}/g) ?? []
  for (const r of n.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < r.length - 1; i++) w.push(r.slice(i, i + 2))
  }
  return [...new Set(w)]
}

function upIndex(c) {
  const sp = []
  const sents = [...c.matchAll(/[^。！？\n]+[。！？\n]*|[。！？\n]+/g)]
  let s = 0
  let e = 0
  const push = () => { if (e > s) sp.push({ start: s, end: e, keys: new Set(upKeys(c.slice(s, e))) }); s = e }
  for (const t of sents) {
    if (e > s && e - s + t[0].length > 700) push()
    e = t.index + t[0].length
  }
  push()
  return sp
}

function upScore(keys, spans) {
  let score = 0
  let index = 0
  if (!keys.length) return { score, index }
  for (let i = 0; i < spans.length; i++) {
    const v = keys.reduce((n, k) => n + Number(spans[i].keys.has(k)), 0) / keys.length
    if (v > score) { score = v; index = i }
  }
  return { score, index }
}

function upWindow(c, spans, idx, budget, qk = []) {
  if (c.length <= budget) return { content: c, start: 0, end: c.length }
  const a = spans[idx]
  if (!a) return { content: c.slice(0, budget), start: 0, end: Math.min(budget, c.length) }
  let s = a.start
  let e = a.end
  if (e - s > budget && qk.length) {
    const lo = c.toLowerCase()
    const off = qk.map(k => lo.indexOf(k, a.start)).filter(o => o >= s && o < e)
    if (off.length) { const h = Math.min(...off); s = Math.max(s, Math.min(h - Math.floor(budget / 3), e - budget)) }
  }
  for (const nb of [spans[idx - 1], spans[idx + 1]]) {
    if (nb && Math.max(e, nb.end) - Math.min(s, nb.start) <= budget) { s = Math.min(s, nb.start); e = Math.max(e, nb.end) }
  }
  e = Math.min(e, s + budget)
  return { content: c.slice(s, e), start: s, end: e }
}

/**
 * 把上游结果改写成「本模块应有的形态」，只抹平那两处**刻意**的差异：
 *
 *   ① 超预算的单块按 700 字硬切（上游不切）；
 *   ② 硬切后剩下的尾巴与其后续句子**合并**（避免产出长度只有几个字的孤儿块）。
 *
 * 第 ② 点不是随手加的：`[700,901]` 这种 201 字的尾巴如果独立成块，它的词元集合
 * 与「和后面那句合起来」并不一样，会直接改变 `scoreOriginal` 的选择。既然本模块
 * 的行为是「不留孤儿块」，参照实现就得按同一口径改写，否则比的是两个问题。
 */
function normalize(spans, text) {
  const out = []
  const consumed = new Set()
  for (const sp of spans) {
    if (consumed.has(sp.start)) continue
    if (sp.end - sp.start <= 700) { out.push(sp); continue }
    let from = sp.start
    while (sp.end - from > 700) {
      out.push({ start: from, end: from + 700, keys: new Set(mine.recallKeys(text.slice(from, from + 700))) })
      from += 700
    }
    // 尾巴：与紧随其后的句子合并，避免产出孤儿块（理由见上）。
    const next = spans.find(x => x.start === sp.end)
    const to = next ? next.end : sp.end
    out.push({ start: from, end: to, keys: new Set(mine.recallKeys(text.slice(from, to))) })
    if (next) consumed.add(next.start)
  }
  return out
}

const samples = [
  '今天天气不错。我们去公园散步吧！你觉得呢？',
  'hello world, this is a v2 test with 中文 mixed in。',
  '如果你方便的话，我就不过去了。',
  '短句。',
  '',
  `${'A'.repeat(900)}。结束。`,
  '她说：「明天要早睡」。然后又说了一遍明天要早睡。',
  '第一句。第二句！第三句？第四句。',
]

const queries = ['公园', '明天早睡', 'v2 test', '不存在的东西', '', '方便', '第一句']
let fails = 0

for (const s of samples) {
  const aKeys = JSON.stringify(mine.recallKeys(s))
  const bKeys = JSON.stringify(upKeys(s))
  if (aKeys !== bKeys) { console.log('KEYS MISMATCH', JSON.stringify(s.slice(0, 40))); fails += 1 }

  const ia = mine.indexOriginal(s)
  const ib = normalize(upIndex(s), s)
  const sa = JSON.stringify(ia.map(x => ({ start: x.start, end: x.end, keys: [...x.keys].sort() })))
  const sb = JSON.stringify(ib.map(x => ({ start: x.start, end: x.end, keys: [...x.keys].sort() })))
  if (sa !== sb) {
    console.log('INDEX MISMATCH', JSON.stringify(s.slice(0, 40)))
    console.log('  mine', sa.slice(0, 160))
    console.log('  up  ', sb.slice(0, 160))
    fails += 1
  }

  for (const q of queries) {
    const ka = mine.recallKeys(q)
    const kb = upKeys(q)
    const ra = mine.scoreOriginal(ka, ia)
    const rb = upScore(kb, ib)
    if (ra.score !== rb.score || ra.index !== rb.index) {
      console.log('SCORE MISMATCH', JSON.stringify(s.slice(0, 30)), JSON.stringify(q), ra, rb)
      fails += 1
    }
    for (const budget of [10, 50, 700, 5000]) {
      const wa = mine.originalWindow(s, ia, ra.index, budget, ka)
      const wb = upWindow(s, ib, rb.index, budget, kb)
      if (wa.content !== wb.content || wa.start !== wb.start || wa.end !== wb.end) {
        console.log('WINDOW MISMATCH', JSON.stringify(s.slice(0, 30)), JSON.stringify(q), budget)
        console.log('  mine', JSON.stringify(wa))
        console.log('  up  ', JSON.stringify(wb))
        fails += 1
      }
    }
  }
}

console.log(fails === 0
  ? '\n✅ 与上游语义一致（差异已抹平，差分为 0）'
  : `\n❌ ${fails} 处差异`)
process.exit(fails === 0 ? 0 : 1)

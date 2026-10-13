/**
 * 共同作品（Shared Works）纯函数层的用例。
 *
 * ## 这一层为什么值得测
 *
 * 它守着**用户亲手写的东西**，坏起来的方向都很糟：
 *   - **键撞车**：作品键由 `[storyId, participantId]` 哈希而来。若改用字符串拼接，
 *     `('a','bc')` 与 `('ab','c')` 会撞成同一件作品——两个人看到对方的文本。
 *   - **坏数据被当成空文档**：存量形状不兼容时若不报错而是「当作空的」，
 *     下一次写入就会**覆盖掉用户的作品**。上游对此的原话是
 *     「畸形/未知的形状是错误，绝不是可以覆盖的空文档」。
 *   - **剪错东西**：终态条目该按滚动窗口剪（防止无限增长），但**未决**提案与
 *     **运行中**任务绝不能剪——那是用户还没处理、或还在跑的东西。
 *
 * 参考实现：上游 `1.0.1-rc50` 的 `src/works.ts`。
 *
 * 运行：node test/works.test.mjs
 */

import assert from 'node:assert/strict'

import {
  KEEP_TERMINAL, WORK_LIMITS, workKey, parseWorkEdit, parseWorkGenerationRequest,
  decodeWorkRow, pruneTerminalProposals, pruneTerminalJobs, pruneRevisions,
  splitDumpParts, WORK_INSTRUCTION, ASYNC_WORK_INSTRUCTION,
} from '../lib/works.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const eq = (actual, expected, label) => assert.deepEqual(
  actual, expected,
  `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
)
const throws = (fn, label) => {
  let threw = false
  try { fn() } catch { threw = true }
  assert.ok(threw, label)
}

console.log('共同作品（纯函数层）')

/* ─────────────── A. 作品键 ─────────────── */

check('workKey：不同参数不同键，且**拼接不撞车**', () => {
  eq(workKey('s1', 'U1').length, 64, 'sha256 十六进制')
  assert.notEqual(workKey('s1', 'U1'), workKey('s1', 'U2'), '参与者不同 → 键不同')
  assert.notEqual(workKey('s1', 'U1'), workKey('s2', 'U1'), '故事不同 → 键不同')
  // 这条是上 JSON 数组而不是拼接的理由：拼接会让这两对撞成同一个键。
  assert.notEqual(workKey('a', 'bc'), workKey('ab', 'c'), '拼接歧义不该撞键')
  // 同一对参数永远同一个键（可复现）。
  eq(workKey('s1', 'U1'), workKey('s1', 'U1'), '稳定')
  // 坏输入不抛错。
  eq(workKey(undefined, undefined).length, 64, '坏输入也能算（当作空串）')
})

/* ─────────────── B. 入参校验 ─────────────── */

check('parseWorkEdit：三个字段都必须是有界非空文本', () => {
  const ok = parseWorkEdit({ baseRevisionId: 'r1', content: '正文', reason: '改一处' })
  eq(ok, { baseRevisionId: 'r1', content: '正文', reason: '改一处' }, '合法入参原样返回')
  // 越界**报错**而不是截断——这是用户的作品内容，静默截断等于悄悄弄坏它。
  throws(() => parseWorkEdit({ baseRevisionId: 'r1', content: '', reason: 'x' }), '空正文应报错')
  throws(() => parseWorkEdit({ baseRevisionId: 'r1', content: '   ', reason: 'x' }), '纯空白应报错')
  throws(() => parseWorkEdit({ baseRevisionId: 'r1', content: 'x'.repeat(WORK_LIMITS.content + 1), reason: 'x' }), '正文超长应报错')
  throws(() => parseWorkEdit({ baseRevisionId: 'r'.repeat(101), content: 'x', reason: 'y' }), '基础版本超长应报错')
  throws(() => parseWorkEdit({ baseRevisionId: 'r1', content: 'x', reason: 'y'.repeat(501) }), '理由超长应报错')
  throws(() => parseWorkEdit({ baseRevisionId: 'r1', content: 123, reason: 'y' }), '非字符串应报错')
  // 坏输入（非对象 / 数组）也要报错而不是当成空。
  for (const bad of [undefined, null, 'nope', 42, []]) {
    throws(() => parseWorkEdit(bad), `${JSON.stringify(bad)} 应报错`)
  }
})

check('parseWorkGenerationRequest：基础版本 + 创作意图', () => {
  eq(
    parseWorkGenerationRequest({ baseRevisionId: 'r1', brief: '写一段关于雨的' }),
    { baseRevisionId: 'r1', brief: '写一段关于雨的' },
    '合法入参',
  )
  throws(() => parseWorkGenerationRequest({ baseRevisionId: 'r1', brief: '' }), '空意图应报错')
  throws(() => parseWorkGenerationRequest({ baseRevisionId: 'r1', brief: 'x'.repeat(WORK_LIMITS.brief + 1) }), '意图超长应报错')
  throws(() => parseWorkGenerationRequest(null), 'null 应报错')
})

/* ─────────────── C. 存量数据形状校验 ─────────────── */

const goodRow = () => ({
  generation: 1,
  state: {
    schemaVersion: 1,
    head: 'r1',
    revisions: [{ id: 'r1', content: '初稿' }],
    proposals: [{ id: 'p1', content: '改后', status: 'pending' }],
  },
})

check('decodeWorkRow：合法形状通过，并返回**深拷贝**（改副本不影响原数据）', () => {
  const row = goodRow()
  const decoded = decodeWorkRow(row)
  eq(decoded.state.head, 'r1', '内容一致')
  assert.notEqual(decoded, row, '不是同一个对象')
  decoded.state.revisions[0].content = '被改过'
  eq(row.state.revisions[0].content, '初稿', '原数据不受影响')
})

check('decodeWorkRow：不兼容的形状**报错**，绝不当作空文档', () => {
  // 上游原话：畸形/未知的形状是错误，绝不是可以覆盖的空文档。
  // 这条最要紧——当作空文档处理，下一次写入就会覆盖掉用户的作品。
  const bad = [
    undefined, null, {},
    { generation: 1, state: {} },
    { generation: 1, state: { schemaVersion: 2, head: 'r1', revisions: [{ id: 'r1', content: 'a' }], proposals: [] } },
    // head 指向不存在的修订（作品「断头」）
    { generation: 1, state: { schemaVersion: 1, head: 'zz', revisions: [{ id: 'r1', content: 'a' }], proposals: [] } },
    // 没有任何修订
    { generation: 1, state: { schemaVersion: 1, head: 'r1', revisions: [], proposals: [] } },
    // generation 不是安全整数
    { generation: 1.5, state: { schemaVersion: 1, head: 'r1', revisions: [{ id: 'r1', content: 'a' }], proposals: [] } },
    // 提案状态非法
    { generation: 1, state: { schemaVersion: 1, head: 'r1', revisions: [{ id: 'r1', content: 'a' }], proposals: [{ id: 'p', content: 'c', status: 'weird' }] } },
  ]
  for (const row of bad) {
    throws(() => decodeWorkRow(row), `坏形状应报错：${JSON.stringify(row)?.slice(0, 40)}`)
  }
})

check('decodeWorkRow：任务数组也校验（状态白名单与条数上限）', () => {
  const withJob = (job) => ({
    generation: 1,
    state: {
      schemaVersion: 1, head: 'r1',
      revisions: [{ id: 'r1', content: 'a' }], proposals: [],
      jobs: [job],
    },
  })
  const okJob = { id: 'j1', brief: 'b', baseRevisionId: 'r1', status: 'running' }
  eq(decodeWorkRow(withJob(okJob)).state.jobs.length, 1, '合法任务通过')
  for (const status of ['running', 'completed', 'failed', 'cancelled']) {
    eq(decodeWorkRow(withJob({ ...okJob, status })).state.jobs[0].status, status, `${status} 合法`)
  }
  throws(() => decodeWorkRow(withJob({ ...okJob, status: 'weird' })), '非法任务状态应报错')
  throws(() => decodeWorkRow(withJob({ ...okJob, id: 1 })), '任务 id 非字符串应报错')
})

/* ─────────────── D. 滚动窗口剪除 ─────────────── */

check('pruneTerminalProposals：只剪**已决**的，未决一个都不动', () => {
  const mk = (terminalCount, pendingCount) => ({
    proposals: [
      ...Array.from({ length: terminalCount }, (_, i) => ({ id: `t${i}`, status: 'accepted' })),
      ...Array.from({ length: pendingCount }, (_, i) => ({ id: `p${i}`, status: 'pending' })),
    ],
  })
  // 恰好等于上限：不剪。
  const exact = mk(KEEP_TERMINAL, 3)
  eq(pruneTerminalProposals(exact), 0, '等于上限不剪')
  eq(exact.proposals.length, KEEP_TERMINAL + 3, '条数不变')
  // 超出：剪掉最旧的终态，保留最近的 KEEP_TERMINAL 条终态。
  const over = mk(KEEP_TERMINAL + 5, 3)
  eq(pruneTerminalProposals(over), 5, '剪 5 条')
  eq(over.proposals.length, KEEP_TERMINAL + 3, '剩 上限+未决')
  eq(over.proposals.filter(p => p.status === 'pending').length, 3, '未决全在')
  eq(over.proposals.filter(p => p.status !== 'pending').length, KEEP_TERMINAL, '终态留下上限条')
  // 留下的必须是**最近**的（剪最旧）。
  assert.ok(over.proposals.some(p => p.id === `t${KEEP_TERMINAL + 4}`), '最新的终态应在')
  assert.ok(!over.proposals.some(p => p.id === 't0'), '最旧的终态应被剪')
})

check('pruneTerminalJobs：只剪**已结束**的，运行中一个都不动', () => {
  // 注意：实现是**重新赋值 `state.jobs`**（与提案那条一致），所以要断言状态对象，
  // 而不是最初那个数组引用——后者会一直指着旧数组。
  const state = {
    jobs: [
      ...Array.from({ length: KEEP_TERMINAL + 4 }, (_, i) => ({ id: `d${i}`, status: 'completed' })),
      { id: 'run1', status: 'running' },
    ],
  }
  eq(pruneTerminalJobs(state), 4, '剪 4 条已结束的')
  eq(state.jobs.length, KEEP_TERMINAL + 1, '剩 上限+运行中')
  eq(state.jobs.filter(j => j.status === 'running').length, 1, '运行中的还在')
  // 没有 jobs 时不抛错。
  eq(pruneTerminalJobs({}), 0, '无 jobs')
  eq(pruneTerminalJobs(undefined), 0, '坏输入安全')
})

check('pruneRevisions：只淘汰最旧的，且剪到与 decode 的上限一致', () => {
  const revisions = Array.from({ length: WORK_LIMITS.revisions + 6 }, (_, i) => ({ id: `r${i}`, content: 'x' }))
  eq(pruneRevisions({ revisions }), 6, '剪 6 条')
  eq(revisions.length, WORK_LIMITS.revisions, '与 decode 的硬校验对齐')
  // 剪完必须仍然能被 decode 接受（否则刚剪完的数据就不合法了）。
  const decoded = decodeWorkRow({
    generation: 1,
    state: { schemaVersion: 1, head: revisions[revisions.length - 1].id, revisions, proposals: [] },
  })
  eq(decoded.state.revisions.length, WORK_LIMITS.revisions, '剪后仍合法')
  // 不超上限时不动。
  const small = [{ id: 'r1', content: 'x' }]
  eq(pruneRevisions({ revisions: small }), 0, '不超上限不剪')
})

/* ─────────────── E. 导出转储分段 ─────────────── */

check('splitDumpParts：按长度切且**保留原文**（拼接即得完整文本）', () => {
  eq(splitDumpParts('短文本', 2400), ['短文本'], '不超长原样返回')
  const long = 'a'.repeat(5000)
  const parts = splitDumpParts(long, 2400)
  eq(parts.map(p => p.length), [2400, 2400, 200], '按上限切')
  eq(parts.join(''), long, '拼接回原文，一个字节都不差')
  // 边界：正好等于上限时不分段。
  eq(splitDumpParts('a'.repeat(2400), 2400).length, 1, '正好等于上限不分段')
  // 坏输入安全。
  eq(splitDumpParts('abc', 0), ['abc'], '上限 0 回默认')
  eq(splitDumpParts(undefined), [''], 'undefined 当空串')
})

/* ─────────────── F. 提示词常量 ─────────────── */

check('两段作品提示词在位，且各自的要点不丢', () => {
  // 同步版：内容是**不可信的创作材料**，提案只是**尝试**，只有用户能接受或驳回。
  assert.ok(WORK_INSTRUCTION.startsWith('COMMON TEXT WORK (optional):'))
  assert.ok(WORK_INSTRUCTION.includes('untrusted creative material'), '标明材料不可信')
  assert.ok(WORK_INSTRUCTION.includes('only an attempted proposal'), '提案只是尝试')
  assert.ok(WORK_INSTRUCTION.includes('Only the user can accept or reject'), '只有用户能接受或驳回')
  assert.ok(WORK_INSTRUCTION.includes('Omit workProposal during ordinary conversation'), '平常对话不必提案')
  // 异步版：只给意图，草稿交给独立写手。
  assert.ok(ASYNC_WORK_INSTRUCTION.startsWith('COMMON TEXT WORK (optional, separate writer):'))
  assert.ok(ASYNC_WORK_INSTRUCTION.includes('workRequest'), '异步版用 workRequest')
  assert.ok(ASYNC_WORK_INSTRUCTION.includes('keep the full draft for that writer'), '当场不要写草稿')
  assert.ok(ASYNC_WORK_INSTRUCTION.includes('No external file is sent'), '明确不发外部文件')
  // 两段是不同的口径，不能混。
  assert.notEqual(WORK_INSTRUCTION, ASYNC_WORK_INSTRUCTION)
})

console.log(`\n共同作品：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

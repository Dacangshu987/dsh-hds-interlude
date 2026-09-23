/**
 * 侧端 JSON 任务共享通道（`lib/side-task.js`）的用例。
 *
 * 移植自上游 `src/narrator.ts` 的 `sideTaskJson`（1.0.1-beta5-ostt）。
 * 要钉住：
 *   ① 多文本字段宽容提取（content/reasoning_content 等）；
 *   ② 首次不可解析（Unterminated/invalid JSON）时自动去掉 max_tokens 重试一次；
 *   ③ 成功路径零额外请求；非重试特征错误不重试。
 *
 * 运行：node test/side-task.test.mjs
 */
import assert from 'node:assert/strict'

import {
  chatTextCandidates, isSideTaskRetryable, sideTaskJson, parseJsonOrThrow,
} from '../lib/side-task.js'

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

console.log('sideTaskJson 思考预算通道')

/* ------------------------------------------------------------ ① 多字段提取 */

ok('chatTextCandidates：content/reasoning_content 都提取', () => {
  const response = {
    choices: [{ message: { content: '{"a":1}', reasoning_content: '思考中…' } }],
  }
  const candidates = chatTextCandidates(response)
  assert.ok(candidates.includes('{"a":1}'))
  assert.ok(candidates.includes('思考中…'))
})

ok('chatTextCandidates：逐字段尝试（content 无效时 reasoning 可解析）', () => {
  const response = {
    choices: [{ message: { content: '这是一段占位说明', reasoning_content: '{"ok":true}' } }],
  }
  const candidates = chatTextCandidates(response)
  assert.ok(candidates.includes('{"ok":true}'))
})

ok('chatTextCandidates：空/非对象安全', () => {
  assert.deepEqual(chatTextCandidates(undefined), [])
  assert.deepEqual(chatTextCandidates(null), [])
  assert.deepEqual(chatTextCandidates('plain'), [])
  assert.deepEqual(chatTextCandidates({}), [])
})

ok('chatTextCandidates：去空去重', () => {
  const response = {
    choices: [{ message: { content: 'x', reasoning_content: 'x' } }],
  }
  assert.deepEqual(chatTextCandidates(response), ['x'])
})

/* ------------------------------------------------------------ ② 可重试特征 */

ok('isSideTaskRetryable：Unterminated / invalid JSON / Unexpected token / empty response', () => {
  assert.equal(isSideTaskRetryable(new Error('Unterminated string at position 21')), true)
  assert.equal(isSideTaskRetryable(new Error('provider returned invalid JSON')), true)
  assert.equal(isSideTaskRetryable(new Error('Unexpected token } in JSON')), true)
  assert.equal(isSideTaskRetryable(new Error('provider returned an empty response.')), true)
  assert.equal(isSideTaskRetryable(new Error('timeout after 30s')), false)
  assert.equal(isSideTaskRetryable(new Error('401 unauthorized')), false)
  assert.equal(isSideTaskRetryable('not an error object'), false)
})

/* ------------------------------------------------------------ ③ 通道行为 */

ok('sideTaskJson：成功路径零重试', async () => {
  let calls = 0
  const result = await sideTaskJson({
    task: 'Alter 分析',
    run: async (capped) => {
      calls += 1
      return JSON.stringify({ shift: 3 })
    },
    parse: (text) => JSON.parse(text),
  })
  assert.deepEqual(result, { shift: 3 })
  assert.equal(calls, 1, '成功路径不多发请求')
})

ok('sideTaskJson：首次不可解析 → 去 cap 重试一次', async () => {
  const calls = []
  const result = await sideTaskJson({
    task: '时间导演',
    run: async (capped) => {
      calls.push(capped)
      if (capped) return '{"beats":[{"at":"0.5","kind":"scene","sum'
      return '{"beats":[{"at":"0.5","kind":"scene","summary":"回家"}]}'
    },
    parse: (text) => JSON.parse(text),
  })
  assert.ok(result.beats)
  assert.deepEqual(calls, [true, false], '先带 cap 再不带 cap')
})

ok('sideTaskJson：非重试错误不重试', async () => {
  let calls = 0
  await assert.rejects(
    sideTaskJson({
      task: '压缩',
      run: async () => {
        calls += 1
        throw new Error('http 500')
      },
      parse: (text) => JSON.parse(text),
    }),
    /http 500/,
  )
  assert.equal(calls, 1, '非重试特征不重试')
})

ok('sideTaskJson：重试仍失败则抛出', async () => {
  await assert.rejects(
    sideTaskJson({
      task: 'Alter 分析',
      run: async () => '{"broken":',
      parse: (text) => JSON.parse(text),
    }),
    /invalid JSON|Unexpected|Unterminated/,
  )
})

ok('sideTaskJson：空响应触发重试特征', async () => {
  const calls = []
  await assert.rejects(
    sideTaskJson({
      task: 'Overlay 整理',
      run: async () => {
        calls.push(1)
        return ''
      },
      parse: (text) => JSON.parse(text),
    }),
    /empty response|invalid JSON|Unexpected|Unterminated/,
  )
  assert.equal(calls.length, 2, '空响应也重试一次')
})

ok('sideTaskJson：warn 回调收到重试日志', async () => {
  const warns = []
  await sideTaskJson({
    task: '日程预排',
    run: async (capped) => capped ? '{"day":' : '{"day":1}',
    parse: (text) => JSON.parse(text),
    warn: (message) => warns.push(message),
  })
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('日程预排'))
})

/* ------------------------------------------------------------ ④ 解析工具 */

ok('parseJsonOrThrow：合法 JSON 直接返回', () => {
  assert.deepEqual(parseJsonOrThrow('{"a":1}', '测试'), { a: 1 })
})

ok('parseJsonOrThrow：非法 JSON 抛可重试特征错误', () => {
  assert.throws(() => parseJsonOrThrow('{"a":', '测试'), /invalid JSON/)
  assert.throws(() => parseJsonOrThrow('', '测试'), /empty response/)
})

/* ------------------------------------------------------------ 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

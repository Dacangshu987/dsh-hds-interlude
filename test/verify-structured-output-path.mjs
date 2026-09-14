/**
 * 验证「工具即结构化输出」这条路真的通：
 *   ① 工具参数里的数组/枚举能被编译成 JSON Schema 并校验；
 *   ② execute 里能拿到 exec（进而在真实运行时拿到 concludeTurn）。
 *
 * 运行：node test/verify-structured-output-path.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'

let ok = true
const check = (label, fn) => {
  try { fn(); console.log(`  ok  ${label}`) }
  catch (e) { ok = false; console.log(`  FAIL ${label}\n       ${e?.message ?? e}`) }
}

console.log('工具即结构化输出：可行性探针')

let captured = null
/** 参数 spec（与 defineTool 用的是同一份；validateArgs 收它而不是收 tool）。 */
const SPEC = {
  lines: {
    type: 'array',
    required: true,
    description: '要发出去的每一句，一条一个元素。',
    items: { type: 'string' },
  },
  mode: { type: 'string', enum: ['send', 'silent'], description: '要不要真的发出去。' },
}
const tool = defineTool({
  name: 'probe_say',
  description: '当你想对用户说话时调用；不调用表示这一轮不说话。',
  parameters: SPEC,
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  execute(args, exec) {
    captured = { args, hasConcludeTurn: typeof exec?.concludeTurn, hasDefer: typeof exec?.deferContext }
    if (typeof exec?.concludeTurn === 'function') exec.concludeTurn()
    return '已记下。'
  },
})

check('defineTool 编译出正确的 JSON Schema（数组 + 枚举 + required）', () => {
  const schema = tool.parameters
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.lines.type, 'array')
  assert.equal(schema.properties.lines.items.type, 'string')
  assert.deepEqual(schema.properties.mode.enum, ['send', 'silent'])
  assert.deepEqual(schema.required, ['lines'])
})

check('合法参数能通过校验', () => {
  // validateArgs(spec, args) → 返回「违规路径列表」，空数组 = 合法
  const violations = validateArgs(SPEC, { lines: ['在忙吗', '我先睡了'], mode: 'send' })
  assert.deepEqual(violations, [], `合法参数不该有违规：${JSON.stringify(violations)}`)
})

check('非法参数被拒绝（这就是「强制 schema」的意义）', () => {
  assert.ok(validateArgs(SPEC, { lines: '在忙吗', mode: 'send' }).length > 0, 'lines 给了字符串应被拒')
  assert.ok(validateArgs(SPEC, { mode: 'send' }).length > 0, '缺少 required 的 lines 应被拒')
  assert.ok(validateArgs(SPEC, { lines: ['x'], mode: 'nonsense' }).length > 0, 'mode 超出 enum 应被拒')
  assert.ok(validateArgs(SPEC, { lines: [123], mode: 'send' }).length > 0, '数组元素类型不对应被拒')
})

check('execute 能拿到 exec，且 concludeTurn 是可调用的', async () => {
  // 直接调用 execute，模拟运行时传入的 exec
  const fakeExec = { concludeTurn: () => { fakeExec.__concluded = true }, deferContext: () => {} }
  const out = tool.execute({ lines: ['在忙吗'], mode: 'send' }, fakeExec)
  assert.equal(out, '已记下。')
  assert.equal(fakeExec.__concluded, true, 'concludeTurn 应当被调用')
  assert.equal(captured.hasConcludeTurn, 'function')
})

check('工具能注册进真实 Cordis 上下文', () => {
  const ctx = new Context()
  const seen = []
  ctx.provide('tools', { register: def => (seen.push(def), () => {}) })
  ctx.tools.register(tool)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'probe_say')
})

console.log(ok ? '\n✅ 「工具即结构化输出」这条路是通的' : '\n❌ 有环节不通')
process.exit(ok ? 0 : 1)

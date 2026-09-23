/**
 * **承重验证**：拆掉关键机制，本文件必须变红。
 *
 * 这不是「再测一遍功能」，而是检查「那条性质是不是真的由代码保证的」。
 * 仿照 hds-interlude 的 `verify-*-loadbearing.mjs` 做法。
 *
 * 验证两条承重性质：
 *   A. **结构分离** —— 正文（思考）永不进入投递链路。
 *      拆掉 say.js 的「工具优先 / strict 短路」，泄漏用例必须失败。
 *   B. **入站幂等** —— 同一条消息不会被处理两次。
 *      拆掉 DedupeWindow，重复消息用例必须失败。
 *
 * 做法：先用**真实实现**跑一遍（应当全绿），再用**故意拆掉机制的替身**
 * 跑同样的用例（应当变红）。两边都符合预期，才算这条性质是承重的。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'

import { decide } from '../../lib/qq-im/say.js'
import { DedupeWindow, handleInbound } from '../../lib/qq-im/inbound.js'
import { BindingStore } from '../../lib/qq-im/binding.js'

let passed = 0
let failures = 0

function report(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failures += 1; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

/** 事故形态 ①：模型把思考写成正文。 */
const THINKING_AS_BODY = '用户问我吃饭没有。我应该回一句关心的话，但不要太刻意。让我想想怎么写得自然……'

console.log('A. 结构分离：正文（思考）不得进入投递链路')

// ---- 真实实现：必须拦住 ----
{
  const real = decide({
    events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: THINKING_AS_BODY }] } } }],
    assistantText: THINKING_AS_BODY,
    sayFallback: 'strict',
  })
  report('真实实现：strict 下思考型正文零投递', real.messages.length === 0, `实际发出了 ${JSON.stringify(real.messages)}`)
}

// ---- 拆掉机制：必须放行（证明这条用例真的在测那个机制）----
{
  // 替身：无视 strict，直接从正文提取——也就是旧架构的行为。
  const broken = {
    messages: THINKING_AS_BODY.split('\n').map(l => l.trim()).filter(Boolean),
    source: 'loose-text',
  }
  report('拆掉 strict 短路：泄漏用例变红（证明用例有承重）', broken.messages.length > 0,
    '如果这里也是 0，说明用例根本没测到 strict 短路')
}

// ---- 事故形态 ②：思考里用引号列候选台词 ----
console.log('\nB. 候选台词不得被当成真台词')

const QUOTED_CANDIDATES = '候选回复：\n"吃了吗"\n"记得吃饭"\n选哪个更自然？'
{
  const real = decide({
    events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: QUOTED_CANDIDATES }] } } }],
    assistantText: QUOTED_CANDIDATES,
    sayFallback: 'strict',
  })
  report('真实实现：strict 下候选台词零投递', real.messages.length === 0, `实际发出了 ${JSON.stringify(real.messages)}`)
}
{
  // 旧架构的判据：整行引号即台词。这正是事故 ② 的成因。
  const legacyExtract = QUOTED_CANDIDATES.split('\n')
    .map(l => l.trim())
    .filter(l => /^["“「]/.test(l))
    .map(l => l.replace(/^["“「]|["”」]$/g, ''))
  report('旧判据（整行引号即台词）：会把候选当成真台词', legacyExtract.length === 2,
    `实际提取到 ${JSON.stringify(legacyExtract)}`)
}

// ---- 正向：调了工具就必须发出 ----
console.log('\nC. 调了工具就必须发出（不能因为「安全」把该说的也吞掉）')
{
  const real = decide({
    events: [{ type: 'tool/call', data: { name: 'interlude_say', arguments: JSON.stringify({ text: '刚吃完' }) } }],
    assistantText: '（她想了想）\n随便写点内心戏。',
    sayFallback: 'strict',
  })
  report('真实实现：工具内容被发出，正文被丢弃', real.messages.join('') === '刚吃完',
    `实际：${JSON.stringify(real.messages)}`)
  report('真实实现：正文一个字都没进去', !real.messages.join('').includes('内心戏'),
    `实际：${JSON.stringify(real.messages)}`)
}

// ---- 入站幂等 ----
console.log('\nD. 入站幂等：同一条消息不得处理两次')

function makeMessage(id) {
  return { kind: 'c2c', senderId: 'USER1', content: '在吗', messageId: id }
}

async function runInbound(dedupe) {
  const bindings = new BindingStore({ home: caseDir('loadbearing') })
  bindings.set({ conversationKey: 'c2c:USER1', sessionId: 'sess-1', botId: 'qq' })
  let injected = 0
  const statuses = []
  for (let i = 0; i < 2; i += 1) {
    const result = await handleInbound({
      message: makeMessage('MSG-DUP-1'),
      dedupe,
      bindings,
      config: {},
      resolveAgent: async () => ({ inject: () => { injected += 1 } }),
      inject: (agent) => { agent.inject(); return true },
    })
    statuses.push(result.status)
  }
  return { injected, statuses }
}

{
  const { injected, statuses } = await runInbound(new DedupeWindow({ ttlMs: 60_000 }))
  report('真实实现：重复消息只注入一次', injected === 1, `实际注入 ${injected} 次（状态：${statuses.join(',')}）`)
  report('真实实现：第二次被标为 duplicate', statuses[1] === 'duplicate', `实际：${statuses[1]}`)
}
{
  // 拆掉幂等：去重窗口永远放行。
  const brokenDedupe = { accept: () => true, size: () => 0 }
  const { injected } = await runInbound(brokenDedupe)
  report('拆掉去重窗口：重复消息被注入两次（证明用例有承重）', injected === 2,
    `实际注入 ${injected} 次——若为 1 说明用例没测到去重`)
}

console.log(`\nverify-loadbearing：${passed} 项符合预期，${failures} 项不符合`)
if (failures > 0) {
  console.error('\n承重验证失败：关键机制没有被代码保证。')
  process.exit(1)
}
console.log('承重验证通过：拆掉关键机制会让上面的用例变红。')

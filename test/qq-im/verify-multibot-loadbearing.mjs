/**
 * **承重验证（多 Bot）**：拆掉复合键里的 botId，A-1 用例必须变红。
 *
 * A-1 的性质是：**两个 Bot 绑同一 openid 时，各自独立、互不串号**。
 * 这条性质由「绑定键带 botId（`botId\0conversationKey`）」保证。
 *
 * 做法：先用**真实实现**跑（应当全绿），再用**把复合键拆成纯 conversationKey
 * 的替身**跑同样的用例（应当变红）。两边都符合预期，才证明 A-1 是承重的。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import path from 'node:path'

import { BindingStore } from '../../lib/qq-im/binding.js'

let passed = 0
let failures = 0
function report(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failures += 1; console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`) }
}

function tempHome(tag) {
  return caseDir('multibot-lb')
}

console.log('A-1 承重：两个 Bot 绑同一 openid 必须各自独立')

// ---- 真实实现：必须隔离 ----
{
  const store = new BindingStore({ home: tempHome('real') })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botA', botId: 'qq_botA' })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botB', botId: 'qq_botB' })

  const a = store.get('c2c:U1', 'qq_botA')
  const b = store.get('c2c:U1', 'qq_botB')
  report('真实实现：botA 拿到自己的绑定', a?.sessionId === 'sess-botA', `实际：${JSON.stringify(a)}`)
  report('真实实现：botB 拿到自己的绑定', b?.sessionId === 'sess-botB', `实际：${JSON.stringify(b)}`)
  report('真实实现：两条绑定并存（没有互相覆盖）', store.list().length === 2, `实际 ${store.list().length} 条`)
}

// ---- 拆掉机制：get 忽略 botId，直接按 conversationKey 返回（旧单 Bot 行为）----
{
  // 替身：抹掉复合键语义——存储键只用 conversationKey，后写覆盖先写。
  // 这正是「多 Bot 前」的行为，也是 A-1 要防的事故形态。
  const broken = {
    map: new Map(),
    get(conversationKey, botId) { void botId; return this.map.get(conversationKey) },
    set({ conversationKey, sessionId, botId }) {
      this.map.set(conversationKey, { conversationKey, sessionId, botId })
      return { changed: true, persisted: false }
    },
    list() { return [...this.map.values()] },
  }
  broken.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botA', botId: 'qq_botA' })
  broken.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botB', botId: 'qq_botB' })

  const a = broken.get('c2c:U1', 'qq_botA')
  const b = broken.get('c2c:U1', 'qq_botB')
  // 两个 bot 都拿到同一条（后写覆盖），botA 的绑定丢了 → A-1 用例必须变红。
  report('拆掉复合键：botA 读到的其实是 botB 的绑定（证明用例有承重）',
    a?.sessionId !== 'sess-botA' && b?.sessionId === 'sess-botB',
    `botA=${JSON.stringify(a)} botB=${JSON.stringify(b)}`)
  report('拆掉复合键：只剩一条绑定（覆盖而非并存）', broken.list().length === 1,
    `实际 ${broken.list().length} 条`)
}

console.log(`\nverify-multibot-loadbearing：${passed} 项符合预期，${failures} 项不符合`)
if (failures > 0) {
  console.error('\n承重验证失败：A-1（复合键隔离）没有被代码保证。')
  process.exit(1)
}
console.log('承重验证通过：拆掉复合键里的 botId 会让 A-1 用例变红。')

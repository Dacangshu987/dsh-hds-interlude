/**
 * 验证「故事不发、只有角色说的话才发」这组用例是**承重**的。
 *
 * ## 为什么必要
 *
 * 这段代码的坏法**不抛错、不写日志、turn/end 照常 completed**：角色照样在说话，
 * 只有聊天软件那头的内容不对——要么多了一条没头没尾的旁白，要么少了一句该说的话。
 * 没有承重验证，一次「顺手改回去」不会被任何人发现。
 *
 * ## 手法
 *
 * 在**沙箱副本**里注入 buggy 版本，跑用例看它们是否变红。
 * 真实源码全程只读（理由见 test/_loadbearing-sandbox.mjs）。
 *
 * ## 与前一版的差别（2026-10-13 重写）
 *
 * 前一版有四个场景，其中三个围绕「**从正文提取台词**」——而那条通路已按上游口径
 * **删除**（`decideAdvanceDelivery` 不再读正文，`salvageBodySpeech` 也已移除）。
 * 围绕已删除机制做的承重验证是**假验证**：锚点找不到就报「结构已变」，
 * 但就算找到了，它验证的也是一种不可能再发生的坏法。
 *
 * 重写后只保留两个**仍然成立**的场景，且都直接对应线上事故形态：
 *   ① 让自动推进把**正文**当消息投递（2026-10-12 事故的形态）
 *   ② 让发消息间隔失效（「每 40 分钟一条无端消息」的形态）
 *
 * 自言自语那道闸由 `verify-self-narration-loadbearing.mjs` 单独负责。
 *
 * 用法：node test/verify-story-split-loadbearing.mjs
 */
import { createSandbox } from './_loadbearing-sandbox.mjs'

const sandbox = createSandbox()
const originalIndex = sandbox.read('lib/index.js')

/** 跑一个测试文件，返回红掉的用例行。 */
const runTests = (file) => sandbox.run(file)

/*
 * 锚点一律用**正则**并容忍 CRLF：本仓源码是 CRLF 行尾，写死 `\n` 会匹配不上
 * （踩过：报「结构已变」，其实是行尾不同）。匹配不上时如实报错而不是静默跳过。
 */

/** 场景一：把**正文**当成要发出去的内容（2026-10-12 事故的形态）。 */
function makeSendBodyIndex(src) {
  // 自动推进那次投递：正常走 decision.messages（只含工具申报的台词），
  // 这里改成整段正文。
  const re = /(\.\.\.\(orderedWithImages \? \{ items: orderedWithImages \} : \{ text: )decision\.messages\.join\('\\n'\)( \}\),)/
  if (!re.test(src)) return null
  return src.replace(re, "$1written$2")
}

/**
 * 场景二：让「发消息间隔」这一关失效（每轮有话就发）。
 *
 * **两处都要拆**才算真的不管间隔：唤起前的预判（`storyMessageGate`），
 * 以及写完之后那道复核（`decideAdvanceDelivery`）。只拆一处，另一处仍会把消息拦住，
 * 于是场景二**假绿**——踩过。
 *
 * 复核这处的锚点还必须**带上前一行 `lastMessageAt`**：
 * `messageIntervalMinutes: cfg.im?...` 这个片段在 index.js 里出现**两次**
 * （另一处是设置页状态卡片，改了不影响投递），只按片段替换会命中错的那一处。
 */
function makeIgnoreIntervalIndex(src) {
  const pre = /const preGating = storyMessageGate\(state, cfg, now, Boolean\(binding && service\)\)/
  if (!pre.test(src)) return null
  const withPre = src.replace(pre, "const preGating = { allowed: true, reason: 'speak' }")
  const re = /( {6}lastMessageAt: state\.lastAutoMessageAt \?\? 0,\r?\n {6}messageIntervalMinutes: )cfg\.im\?\.messageIntervalMinutes \?\? 120(,)/
  if (!re.test(withPre)) return null
  return withPre.replace(re, '$10$2')
}

let ok = true

try {
  // ── 场景一：正文当消息投递 ─────────────────────────────────────
  const sendBody = makeSendBodyIndex(originalIndex)
  if (!sendBody) {
    console.error('无法注入「正文当消息投递」（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/index.js', sendBody)
  console.log('场景一：让自动推进把**正文**当消息投递…\n')
  const redsOne = runTests('test/proactive-cold.test.mjs').concat(runTests('test/story.test.mjs'))
  for (const line of redsOne) console.log('  ' + line)
  // 必须有用例真的红掉——否则说明没有测试在管这件事。
  const onePass = redsOne.length >= 1
  console.log(`  → 红掉 ${redsOne.length} 条`)
  if (!onePass) ok = false

  // ── 场景二：无视发消息间隔 ─────────────────────────────────────
  sandbox.write('lib/index.js', originalIndex)
  const noInterval = makeIgnoreIntervalIndex(originalIndex)
  if (!noInterval) {
    console.error('无法让间隔失效（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/index.js', noInterval)
  console.log('\n场景二：让「发消息间隔」失效（每轮有话就发）…\n')
  const redsTwo = runTests('test/proactive-cold.test.mjs').concat(runTests('test/story.test.mjs'))
  for (const line of redsTwo) console.log('  ' + line)
  const twoPass = redsTwo.some(line => line.includes('发消息间隔'))
  console.log(`  → 红掉 ${redsTwo.length} 条`)
  if (!twoPass) ok = false

  console.log('')
  console.log(ok
    ? '✅ 测试确实在检验「故事只留在 DSH，只有角色说的话才发出去」'
    : '❌ 测试是摆设')
  process.exit(ok ? 0 : 1)
} finally {
  sandbox.cleanup()
}

/**
 * 验证「故事不发、只有台词才发」这组用例是**承重**的。
 *
 * 手法：把 lib/index.js 改回改版前的行为——角色写什么就整段投出去——
 * 跑 proactive-cold.test.mjs 与 story.test.mjs，看用例是否变红。
 *
 * 这一层为什么必要：这段代码的坏法**不抛错、不写日志、turn/end 照常 completed**。
 * 角色照样在说话，只有聊天软件那头的内容不对——要么多了一条没头没尾的旁白，
 * 要么少了一句该说的话。没有承重验证，一次「顺手改回去」不会被任何人发现。
 *
 * 用法：node test/verify-story-split-loadbearing.mjs
 */
import fs from 'node:fs'
import { createSandbox } from './_loadbearing-sandbox.mjs'

/**
 * 注入与运行都在**沙箱副本**里做，真实源码全程只读。
 * 理由见 test/_loadbearing-sandbox.mjs 的模块注释（就地改写扛不住 SIGKILL）。
 */
const sandbox = createSandbox()
const originalIndex = sandbox.read('lib/index.js')
const originalStory = sandbox.read('lib/story.js')

/** 跑一个测试文件，返回红掉的用例行。 */
const runTests = (file) => sandbox.run(file)

/** 改版前的行为：整段写回直接投递（不问有没有台词、不带图）。 */
function makeSendWholeStoryIndex(src) {
  // 锚点跟着实现走：投递现在按「有没有图」在 items / text 之间选，所以固定的
  // 整段字符串不再是稳定锚点。这里改成「定位那次 deliverToIm 调用、整段替换」，
  // 注入的 buggy 版本仍然表达「整段原样投递」这个旧行为。
  const startMarker = '    const delivered = await deliverToIm({\n      key, state, cfg,'
  const start = src.indexOf(startMarker)
  if (start < 0) return null
  const end = src.indexOf('\n    })', start)
  if (end < 0) return null
  const buggy = "    const delivered = await deliverToIm({\n      key, state, cfg, text: written, reason: '自动生活推进',\n    })"
  return src.slice(0, start) + buggy + src.slice(end + '\n    })'.length)
}

/** 只把「间隔」这一关拆掉：让它每次都发。 */
function makeIgnoreIntervalIndex(src) {
  const marker = "    const preGating = storyMessageGate(state, cfg, now, Boolean(binding && service))"
  if (!src.includes(marker)) return null
  return src.replace(marker, "    const preGating = { allowed: true, reason: 'speak' }")
}

/**
 * 同样只拆间隔，但拆的是「写完之后那道复核」。
 *
 * 锚点必须带上前面那行 lastMessageAt —— 光看 messageIntervalMinutes 会先命中
 * 设置页状态卡片里的同名读取（那里改了不影响投递），于是场景二假绿。
 */
function makeIgnoreIntervalInDecision(src) {
  const marker = "      lastMessageAt: state.lastAutoMessageAt ?? 0,\n      messageIntervalMinutes: cfg.im?.messageIntervalMinutes ?? 120,"
  if (!src.includes(marker)) return null
  return src.replace(marker, "      lastMessageAt: state.lastAutoMessageAt ?? 0,\n      messageIntervalMinutes: 0,")
}

/** 把台词提取改成「什么都算台词」。 */
function makeExtractEverythingStory(src) {
  const marker = "  return out\n}\n\n/**\n * 去掉一段文字里的旁白/动作"
  if (!src.includes(marker)) return null
  return src.replace(marker, "  out.push(text.trim())\n  return out\n}\n\n/**\n * 去掉一段文字里的旁白/动作")
}

/**
 * 拆掉「自言自语闸」——即 decideAdvanceDelivery 开头那段拦下自说自话的判定。
 *
 * 拆掉之后，思考里用引号写的「候选台词」又会被 extractSpeech 挑出来发出去，
 * 这正是 2026-09-15 第二次线上泄漏的形态。
 */
function makeDropSelfNarrationGate(src) {
  const marker = "  if (looksLikeSelfNarration(text).leak && advanceEnabled) {\n    return { mode: 'story-only', messages: [], reason: 'self-narration', lines: 0 }\n  }"
  if (!src.includes(marker)) return null
  return src.replace(marker, '')
}

let ok = true

try {
  // ── 场景一：整段写回直投（改版前的行为）─────────────────────────
  const whole = makeSendWholeStoryIndex(originalIndex)
  if (!whole) {
    console.error('无法生成「整段投递」版本（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/index.js', whole)
  console.log('场景一：把续写改成「写什么就整段发出去」…\n')
  const redsOne = runTests('test/proactive-cold.test.mjs').concat(runTests('test/story.test.mjs'))
  for (const line of redsOne) console.log('  ' + line)
  const onePass = redsOne.length >= 1
  console.log(`  → 红掉 ${redsOne.length} 条`)
  if (!onePass) ok = false

  // ── 场景二：无视发消息间隔 ────────────────────────────────────
  // 两处都要拆才算「真的不管间隔」：唤起前的预判，以及写完之后那道复核
  // （复核用的就是同一个纯函数）。只拆一处，另一处仍会把消息拦住。
  sandbox.write('lib/index.js', originalIndex)
  let noInterval = makeIgnoreIntervalIndex(originalIndex)
  if (noInterval) noInterval = makeIgnoreIntervalInDecision(noInterval)
  if (!noInterval) {
    console.error('无法还原间隔门（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/index.js', noInterval)
  console.log('\n场景二：把「发消息间隔」这一关拆掉（每轮有话就发）…\n')
  const redsTwo = runTests('test/proactive-cold.test.mjs')
  for (const line of redsTwo) console.log('  ' + line)
  const twoPass = redsTwo.some(line => line.includes('发消息间隔没到'))
  console.log(`  → 红掉 ${redsTwo.length} 条`)
  if (!twoPass) ok = false

  // ── 场景三：台词提取退化成「什么都算台词」───────────────────────
  sandbox.write('lib/index.js', originalIndex)
  const loose = makeExtractEverythingStory(originalStory)
  if (!loose) {
    console.error('无法还原提取器（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/story.js', loose)
  console.log('\n场景三：让「旁白也算台词」…\n')
  const redsThree = runTests('test/story.test.mjs').concat(runTests('test/proactive-cold.test.mjs'))
  for (const line of redsThree) console.log('  ' + line)
  const threePass = redsThree.length >= 2
  console.log(`  → 红掉 ${redsThree.length} 条`)
  if (!threePass) ok = false

  // ── 场景四：拆掉自言自语闸（2026-09-15 第二次泄漏的那道缺口）──────
  // 这道闸让「思考里的候选台词」不再被当成真台词发出去。拆掉它，
  // 那两条回归用例必须变红——否则这层保护就是摆设。
  sandbox.write('lib/story.js', originalStory)
  const noGate = makeDropSelfNarrationGate(originalStory)
  if (!noGate) {
    console.error('无法拆掉自言自语闸（结构已变），承重验证需要更新')
    process.exit(2)
  }
  sandbox.write('lib/story.js', noGate)
  console.log('\n场景四：拆掉「自言自语闸」（让思考里的候选台词照发）…\n')
  const redsFour = runTests('test/story.test.mjs').concat(runTests('test/proactive-cold.test.mjs'))
  for (const line of redsFour) console.log('  ' + line)
  const fourPass = redsFour.some(line => line.includes('候选台词'))
  console.log(`  → 红掉 ${redsFour.length} 条`)
  if (!fourPass) ok = false

  console.log('')
  console.log(ok
    ? '✅ 测试确实在检验「故事只留在 DSH，只有角色说的话才发出去」'
    : '❌ 测试是摆设')
  sandbox.cleanup()
  process.exit(ok ? 0 : 1)
} finally {
  sandbox.cleanup()
}

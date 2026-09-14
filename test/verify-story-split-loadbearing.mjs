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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const STORY = fileURLToPath(new URL('../lib/story.js', import.meta.url))
const originalIndex = fs.readFileSync(INDEX, 'utf8')
const originalStory = fs.readFileSync(STORY, 'utf8')

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(INDEX, originalIndex, 'utf8')
  fs.writeFileSync(STORY, originalStory, 'utf8')
}

/** 跑一个测试文件，返回红掉的用例行。 */
function runTests(file) {
  let output = ''
  try {
    output = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  return output.split('\n').filter(line => line.trim().startsWith('FAIL')).map(line => line.trim())
}

/** 改版前的行为：整段写回直接投递（不问有没有台词）。 */
function makeSendWholeStoryIndex(src) {
  const marker = '    const delivered = await deliverToIm({\n      key, state, cfg, text: decision.messages.join(\'\\n\'), reason: \'故事续写中的发言\',\n    })'
  if (!src.includes(marker)) return null
  return src.replace(marker, "    const delivered = await deliverToIm({\n      key, state, cfg, text: written, reason: '自动生活推进',\n    })")
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

let ok = true

try {
  // ── 场景一：整段写回直投（改版前的行为）─────────────────────────
  const whole = makeSendWholeStoryIndex(originalIndex)
  if (!whole) {
    console.error('无法生成「整段投递」版本（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(INDEX, whole, 'utf8')
  console.log('场景一：把续写改成「写什么就整段发出去」…\n')
  const redsOne = runTests('test/proactive-cold.test.mjs').concat(runTests('test/story.test.mjs'))
  for (const line of redsOne) console.log('  ' + line)
  const onePass = redsOne.length >= 1
  console.log(`  → 红掉 ${redsOne.length} 条`)
  if (!onePass) ok = false

  // ── 场景二：无视发消息间隔 ────────────────────────────────────
  // 两处都要拆才算「真的不管间隔」：唤起前的预判，以及写完之后那道复核
  // （复核用的就是同一个纯函数）。只拆一处，另一处仍会把消息拦住。
  fs.writeFileSync(INDEX, originalIndex, 'utf8')
  let noInterval = makeIgnoreIntervalIndex(originalIndex)
  if (noInterval) noInterval = makeIgnoreIntervalInDecision(noInterval)
  if (!noInterval) {
    console.error('无法还原间隔门（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(INDEX, noInterval, 'utf8')
  console.log('\n场景二：把「发消息间隔」这一关拆掉（每轮有话就发）…\n')
  const redsTwo = runTests('test/proactive-cold.test.mjs')
  for (const line of redsTwo) console.log('  ' + line)
  const twoPass = redsTwo.some(line => line.includes('发消息间隔没到'))
  console.log(`  → 红掉 ${redsTwo.length} 条`)
  if (!twoPass) ok = false

  // ── 场景三：台词提取退化成「什么都算台词」───────────────────────
  fs.writeFileSync(INDEX, originalIndex, 'utf8')
  const loose = makeExtractEverythingStory(originalStory)
  if (!loose) {
    console.error('无法还原提取器（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(STORY, loose, 'utf8')
  console.log('\n场景三：让「旁白也算台词」…\n')
  const redsThree = runTests('test/story.test.mjs').concat(runTests('test/proactive-cold.test.mjs'))
  for (const line of redsThree) console.log('  ' + line)
  const threePass = redsThree.length >= 2
  console.log(`  → 红掉 ${redsThree.length} 条`)
  if (!threePass) ok = false

  console.log('')
  console.log(ok
    ? '✅ 测试确实在检验「故事只留在 DSH，只有角色说的话才发出去」'
    : '❌ 测试是摆设')
  restore()
  process.exit(ok ? 0 : 1)
} finally {
  restore()
}

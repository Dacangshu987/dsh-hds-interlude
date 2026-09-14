/**
 * 验证「故事续写写出来的话必须真的发出去」的用例是承重的。
 *
 * 手法：让兜底分支直接 return（相当于改版前的「只 followup、不投递」）——
 * 跑 proactive-cold.test.mjs，看对应用例是否变红。
 *
 * 这一层为什么必要：这段代码的坏法**不会抛错、不会写日志**。
 * 角色照样在说话、turn/end 照样 completed、会话里什么都有，
 * 只有聊天软件那头是空的。没有承重验证，一次「顺手改回去」不会被任何人发现。
 *
 * 用法：node test/verify-auto-advance-loadbearing.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const SCHEMA = fileURLToPath(new URL('../lib/schema.js', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const original = fs.readFileSync(INDEX, 'utf8')
const originalSchema = fs.readFileSync(SCHEMA, 'utf8')

/**
 * **在沙箱副本里做注入，绝不改写真实源码。**
 *
 * 早先的写法是就地改写 lib/index.js、跑完再还原。它的致命问题是扛不住
 * SIGKILL（超时被 taskkill / 强杀时任何 exit / signal 钩子都不会执行），
 * 于是坏版本被永久留在磁盘上——而它是合法 JS，`node --check` 照样通过，
 * 没人会发现。这里改成：把 lib/ 与 test/ 复制到临时目录，在副本里注入与运行。
 * 真实源码全程只读，进程被杀也污染不到它。
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-loadbearing-'))
fs.cpSync(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'), { recursive: true })
fs.cpSync(path.join(ROOT, 'test'), path.join(SANDBOX, 'test'), { recursive: true })
// 让沙箱里的相对 import（node_modules 解析）能走到真实依赖
const nm = path.join(ROOT, 'node_modules')
if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(SANDBOX, 'node_modules'), 'junction')

const SANDBOX_INDEX = path.join(SANDBOX, 'lib', 'index.js')
const SANDBOX_SCHEMA = path.join(SANDBOX, 'lib', 'schema.js')

const cleanup = () => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
}
process.on('exit', cleanup)

/**
 * 把「故事续写写出来的话到底有没有发出去」这一环整段拿掉，只留 agent.followup。
 *
 * 改版前这里是「只 followup、不投递」；改版后同一个坏法长成了新形状：
 * 让纯判定函数永远返回 story-only —— 代码照样跑、日志照样安静、
 * 故事照样写进会话，只是用户永远收不到消息。
 *
 * 锚点是 decision 调用之后的那段处理（从 `if (decision.mode !== 'speak')` 起
 * 到函数结尾），替换成一句 `return`。
 */
function makeBuggyIndex(src) {
  const marker = "    if (decision.mode !== 'speak') {"
  const start = src.indexOf(marker)
  const end = src.indexOf('\n  }\n\n  /**\n   * 故事续写的发言门', start)
  if (start < 0 || end < 0) return null
  return src.slice(0, start) + '    return' + src.slice(end)
}

/** 只把开关的 schema 默认值改回 false（分支代码不动）。 */
const OLD_DEFAULT = 'deliverAutoAdvance: z.boolean().default(false)'
const NEW_DEFAULT_LINE = 'deliverAutoAdvance: z.boolean().default(true)'

function makeDefaultOffSchema(src) {
  const index = src.indexOf(NEW_DEFAULT_LINE)
  if (index < 0) return null
  return src.slice(0, index) + OLD_DEFAULT + src.slice(index + NEW_DEFAULT_LINE.length)
}

/**
 * 把配额闸改回「承诺型也一起挡」的旧顺序。
 *
 * 这一处与投递无关，但它是**投递打开之后才出现**的新风险：生活推进开始占名额，
 * 于是排在它后面的到点提醒可能被挤掉。没有承重验证，没人会发现这层耦合。
 */
const FIXED_QUOTA = 'if (!promised && (state.reachedOut ?? 0) >= (cfg.proactive?.maxPerDay ?? 6)) return false'
const OLD_QUOTA = 'if ((state.reachedOut ?? 0) >= (cfg.proactive?.maxPerDay ?? 6)) return false'

function makeQuotaBlockingIndex(src) {
  if (!src.includes(FIXED_QUOTA)) return null
  return src.replace(FIXED_QUOTA, OLD_QUOTA)
}

/** 跑一遍测试，返回红掉的用例行。在**沙箱副本**里跑，绝不碰真实源码。 */
function runTests() {
  let output = ''
  try {
    output = execFileSync(process.execPath, ['test/proactive-cold.test.mjs'], {
      cwd: SANDBOX,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  return output.split('\n').filter(l => l.trim().startsWith('FAIL')).map(l => l.trim())
}

const NEW_CASES = [
  '续写里角色说了话',
  '投递状态落盘',
  'im.autoMessage=false',
  'im.deliverAutoAdvance=false',
  '承诺优先于配额',
]

/** 新增用例里红掉的那些（旧的冷会话用例不受这两处改动影响）。 */
function newReds(reds) {
  return reds.filter(line => NEW_CASES.some(name => line.includes(name)))
}

let ok = true

try {
  // ── 场景一：分支不接管（出 bug 的实现）────────────────────────────
  const buggy = makeBuggyIndex(original)
  if (!buggy) {
    console.error('无法生成 buggy 版本（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(SANDBOX_INDEX, buggy, 'utf8')
  console.log('场景一：把自动推进改回「只 followup、不投递」…\n')
  const redsOne = newReds(runTests())
  for (const line of redsOne) console.log('  ' + line)
  const onePass = redsOne.length >= 2
  console.log(`  → 新增用例红掉 ${redsOne.length} 条`)
  if (!onePass) ok = false

  // ── 场景二：分支在，但默认开关关着（另一半根因）──────────────────
  const offSchema = makeDefaultOffSchema(originalSchema)
  if (!offSchema) {
    console.error('无法改回 schema 默认值（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(SANDBOX_SCHEMA, offSchema, 'utf8')
  // 分支代码必须还原成修好的版本，否则场景二会退化成场景一的复现。
  fs.writeFileSync(SANDBOX_INDEX, original, 'utf8')
  console.log('\n场景二：分支保留，但把 deliverAutoAdvance 的默认值改回 false…\n')
  const redsTwo = newReds(runTests())
  for (const line of redsTwo) console.log('  ' + line)
  const twoPass = redsTwo.length >= 1
  console.log(`  → 新增用例红掉 ${redsTwo.length} 条`)
  if (!twoPass) ok = false

  // ── 场景三：配额闸把承诺型也一起挡（投递打开后的新耦合）──────────
  const quotaBuggy = makeQuotaBlockingIndex(original)
  if (!quotaBuggy) {
    console.error('无法还原配额顺序（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(SANDBOX_INDEX, quotaBuggy, 'utf8')
  fs.writeFileSync(SANDBOX_SCHEMA, originalSchema, 'utf8')
  console.log('\n场景三：把配额闸改回「承诺型也一起挡」…\n')
  const redsThree = newReds(runTests())
  for (const line of redsThree) console.log('  ' + line)
  const threePass = redsThree.some(line => line.includes('承诺优先于配额'))
  console.log(`  → 新增用例红掉 ${redsThree.length} 条`)
  if (!threePass) ok = false

  console.log('')
  console.log(ok ? '✅ 测试确实在检验「自动推进的话有没有真的发出去」' : '❌ 测试是摆设')
  process.exit(ok ? 0 : 1)
} finally {
  cleanup()
}

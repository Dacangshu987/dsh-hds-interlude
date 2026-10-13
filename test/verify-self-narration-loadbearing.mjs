/**
 * 验证「自言自语闸」是承重的。
 *
 * ## 这一层为什么必要
 *
 * 模型有可能把**思考**塞进工具参数（少见，但线上发生过）。那道闸要是被顺手
 * 去掉，故障不会抛错、日志也安静——用户只会收到几句没头没尾的内心独白，
 * 而来源是模型的思考过程。
 *
 * ## 手法
 *
 * 在**沙箱副本**里把闸拆掉（`decideAdvanceDelivery` 里对显式发言的那道），
 * 跑 `test/story.test.mjs`，看对应用例是否变红。
 *
 * ## 两处刻意的设计（与前身相比）
 *
 *   ① **绝不改写真实源码**：前身是就地改写 `lib/index.js` 再还原，扛不住
 *      SIGKILL（强杀时任何 exit/signal 钩子都不执行），坏版本会被永久留在磁盘上
 *      ——而它是合法 JS，`node --check` 照样通过。这里改为复制到临时目录再注入。
 *   ② **锚点失效时如实报错**（exit 2），不假装验证通过。文本锚点会随代码演进
 *      失效，宁可吵，也不要让承重验证静默变成摆设。</description>
 *
 * 用法：node test/verify-self-narration-loadbearing.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-selfnarration-'))
fs.cpSync(path.join(ROOT, 'lib'), path.join(SANDBOX, 'lib'), { recursive: true })
fs.cpSync(path.join(ROOT, 'test'), path.join(SANDBOX, 'test'), { recursive: true })
const nm = path.join(ROOT, 'node_modules')
if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(SANDBOX, 'node_modules'), 'junction')

const cleanup = () => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
}
process.on('exit', cleanup)

/** 跑一个测试文件，返回红掉的用例行。 */
function runTests(file) {
  let output = ''
  try {
    output = execFileSync(process.execPath, [file], {
      cwd: SANDBOX, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  return output.split('\n').filter(l => l.trim().startsWith('FAIL')).map(l => l.trim())
}

const STORY = path.join(SANDBOX, 'lib', 'story.js')
const original = fs.readFileSync(STORY, 'utf8')

/*
 * 锚点：`decideAdvanceDelivery` 里对**显式发言**的那道闸。
 *
 * 为什么指向这里而不是正文：2026-10-13 起正文完全不参与投递判定
 * （那段兼容路径已按上游口径删除），所以旧锚点「正文原样投递」已不存在。
 * 显式发言这条闸仍然活着，而且它保护的正是同一个故障形态。
 *
 * 用**正则**而不是字符串：本仓源码是 CRLF 行尾，写死 `\n` 会匹配不上
 * （踩过：报「结构已变」，其实是行尾不同）。`\r?\n` 两种都容忍。
 */
const MARKER_RE = / {4}if \(looksLikeSelfNarration\(explicit\.join\('\\n'\)\)\.leak\) \{\r?\n {6}return \{ mode: 'story-only', messages: \[\], reason: 'self-narration', lines: 0 \}\r?\n {4}\}/

let ok = true
try {
  if (!MARKER_RE.test(original)) {
    console.error('无法定位自言自语闸（结构已变），承重验证需要更新')
    process.exit(2)
  }
  const buggy = original.replace(MARKER_RE, '    // 承重验证：闸被拆掉')
  fs.writeFileSync(STORY, buggy, 'utf8')
  console.log('把「自言自语闸」拆掉（显式发言里的思考会被照发）…\n')

  const reds = runTests('test/story.test.mjs')
  for (const line of reds) console.log('  ' + line)
  const pass = reds.some(l => l.includes('思考'))
  console.log(`  → 红掉 ${reds.length} 条`)
  if (!pass) ok = false

  console.log('')
  console.log(ok ? '✅ 测试确实在检验「思考不会被当成消息发出去」' : '❌ 测试是摆设')
  process.exit(ok ? 0 : 1)
} finally {
  cleanup()
}

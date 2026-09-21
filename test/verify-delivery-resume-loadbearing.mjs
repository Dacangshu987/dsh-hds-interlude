import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 承重验证的对象是**真正在跑的那份代码**。
 *
 * 自建通道之后，主动投递走的是 `lib/qq-im/outbound.js` 的 `deliverMessages`，
 * 不再经过 `lib/im.js` 的 `deliverImChunks`（那是为在 dsh-im 之上做适配而写的）。
 * 所以这里必须改指向 `qq-im/outbound.js`——否则我们拆的是一个已经不在链路上的
 * 函数：测试会「通过」，但它验证的是一个已经不承重的机制。
 *
 * 这正是本文件存在的意义：**确认那条性质真的由活代码保证**。
 */
const TARGET = fileURLToPath(new URL('../lib/qq-im/outbound.js', import.meta.url))
const original = fs.readFileSync(TARGET, 'utf8')

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(TARGET, original, 'utf8')
}

function runTests(file) {
  let output = ''
  try {
    output = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  return output.split('\n').filter(l => l.trim().startsWith('FAIL')).map(l => l.trim())
}

let ok = true
try {
  // 把「带回未送出部分」拆掉：失败时不再返回 remaining（旧行为）。
  // 锚点要与 outbound.js 里的实际写法一致；那里为了兼容老调用方，
  // 文字条目会经 toExternalItem 还原成字符串，所以整行一起匹配。
  const buggy = original.replace(
    '      remaining: list.slice(index).map(toExternalItem), receipt: receipt(false, sentCount, error),\n',
    '      receipt: receipt(false, sentCount, error),\n',
  )
  if (buggy === original) {
    console.error('无法定位 remaining 构造（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(TARGET, buggy, 'utf8')
  console.log('把「带回未送出部分」拆掉（失败时丢掉 remaining）…\n')
  const reds = runTests('test/proactive-cold.test.mjs')
  for (const line of reds) console.log('  ' + line)
  const pass = reds.some(l => l.includes('不重新生成'))
  console.log(`  → 红掉 ${reds.length} 条`)
  if (!pass) ok = false

  console.log('')
  console.log(ok ? '✅ 测试确实在检验「重试重发原文、不重新生成」' : '❌ 测试是摆设')
  restore()
  process.exit(ok ? 0 : 1)
} finally {
  restore()
}

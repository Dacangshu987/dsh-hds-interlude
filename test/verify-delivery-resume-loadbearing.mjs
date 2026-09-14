import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const IM = fileURLToPath(new URL('../lib/im.js', import.meta.url))
const original = fs.readFileSync(IM, 'utf8')

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(IM, original, 'utf8')
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
  const buggy = original.replace(
    '      remaining: list.slice(index),\n',
    '',
  )
  if (buggy === original) {
    console.error('无法定位 remaining 构造（结构已变），承重验证需要更新')
    process.exit(2)
  }
  fs.writeFileSync(IM, buggy, 'utf8')
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

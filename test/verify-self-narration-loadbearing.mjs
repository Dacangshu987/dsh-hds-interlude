import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const original = fs.readFileSync(INDEX, 'utf8')

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(INDEX, original, 'utf8')
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

// 把自言自语那道闸拆掉：恢复成「written 原样投递」
const marker = `      const verdict = written ? looksLikeSelfNarration(written) : { leak: false }
      if (verdict.leak) {`
const start = original.indexOf(marker)
const endMarker = `      const delivered = written`
const end = original.indexOf(endMarker, start)

let ok = true
try {
  if (start < 0 || end < 0) {
    console.error('无法定位自言自语闸（结构已变），承重验证需要更新')
    process.exit(2)
  }
  const buggy = original.slice(0, start) + "      const verdict = { leak: false }\n" + original.slice(end)
  fs.writeFileSync(INDEX, buggy, 'utf8')
  console.log('把「自言自语闸」拆掉（正文原样投递）…\n')
  const reds = runTests('test/proactive-cold.test.mjs')
  for (const line of reds) console.log('  ' + line)
  const pass = reds.some(l => l.includes('思考过程'))
  console.log(`  → 红掉 ${reds.length} 条`)
  if (!pass) ok = false

  console.log('')
  console.log(ok ? '✅ 测试确实在检验「思考过程不会被当成消息发出去」' : '❌ 测试是摆设')
  restore()
  process.exit(ok ? 0 : 1)
} finally {
  restore()
}

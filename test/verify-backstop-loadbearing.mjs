/**
 * 验证「承诺兜底」的测试是承重的。
 *
 * 手法：把 `recordMissedCommitment` 里的开关判断改成恒假（等价于关掉整个兜底），
 * 再跑 commitment.test.mjs，看对应用例是否变红。
 *
 * 用**配置门控**而不是函数体短路的做法更稳：不需要注入代码、不会破坏语法，
 * 而且它检验的正是「兜底有没有真的在起作用」这件事本身。
 *
 * 用法：node test/verify-backstop-loadbearing.mjs
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const original = fs.readFileSync(INDEX, 'utf8')
const GATE = 'if (cfg.proactive?.commitmentBackstop === false) return'
const DISABLED = 'if (true) return // DISABLED-FOR-VERIFICATION'

if (!original.includes(GATE)) {
  console.error(`找不到兜底开关那一行，测试无效：${GATE}`)
  process.exit(2)
}

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(INDEX, original, 'utf8')
}

try {
  const patched = original.replace(GATE, DISABLED)
  if (patched === original) {
    console.error('替换未生效（GATE 没匹配上），测试无效')
    process.exit(2)
  }
  fs.writeFileSync(INDEX, patched, 'utf8')
  // 读回来确认磁盘上真的是改过的版本——不然测试跑的还是旧代码，
  // 会得出「关掉兜底也全绿」这种假结论。
  const onDisk = fs.readFileSync(INDEX, 'utf8')
  console.log('已关掉承诺兜底，跑测试…')
  console.log(`  磁盘校验: 含 DISABLED=${onDisk.includes('DISABLED-FOR-VERIFICATION')} 与原文不同=${onDisk !== original}\n`)

  let output = ''
  let nonzero = false
  try {
    output = execFileSync(process.execPath, ['test/commitment.test.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    })
  } catch (error) {
    nonzero = true
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }

  const reds = output.split('\n').filter(l => l.trim().startsWith('FAIL'))
  for (const line of reds) console.log(line.trim())
  console.log(output.split('\n').filter(l => /通过 \d+ 项/.test(l)).join('\n'))

  console.log(`\n结论：关掉兜底后 ${reds.length} 条用例变红，退出码${nonzero ? '非 0' : '为 0'}`)
  console.log(reds.length > 0 ? '✅ 测试确实在检验兜底逻辑' : '❌ 测试是摆设——兜底被关掉也照样通过')
  restore()
  process.exit(reds.length > 0 ? 0 : 1)
} finally {
  restore()
}

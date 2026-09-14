/**
 * 验证「跨作用域取服务」的测试是承重的。
 *
 * 手法：把 resolveImService 改回**只用属性访问**（线上出 bug 的那版），
 * 跑 im.test.mjs，看对应用例是否变红。
 *
 * 用法：node test/verify-im-service-loadbearing.mjs
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const IM = fileURLToPath(new URL('../lib/im.js', import.meta.url))
const original = fs.readFileSync(IM, 'utf8')

/** 把 get() 那条路径去掉，只留属性访问（= 出 bug 的实现）。 */
function makeBuggyVersion(src) {
  const start = src.indexOf('export function resolveImService(ctx) {')
  const end = src.indexOf('\n}', start)
  if (start < 0 || end < 0) return null
  const buggyBody = `export function resolveImService(ctx) {
  let service
  try {
    service = ctx?.dshIm
  } catch {
    return undefined
  }
  return typeof service?.send === 'function' ? service : undefined`
  return src.slice(0, start) + buggyBody + src.slice(end)
}

const buggy = makeBuggyVersion(original)
if (!buggy) {
  console.error('无法生成 buggy 版本，测试无效')
  process.exit(2)
}

let restored = false
const restore = () => {
  if (restored) return
  restored = true
  fs.writeFileSync(IM, original, 'utf8')
}

try {
  fs.writeFileSync(IM, buggy, 'utf8')
  console.log('已把 resolveImService 改回「只用属性访问」，跑测试…\n')

  let output = ''
  let nonzero = false
  try {
    output = execFileSync(process.execPath, ['test/im.test.mjs'], {
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

  console.log(`\n结论：改回旧实现后 ${reds.length} 条用例变红，退出码${nonzero ? '非 0' : '为 0'}`)
  console.log(reds.length > 0 ? '✅ 测试确实在检验跨作用域取服务' : '❌ 测试是摆设')
  restore()
  process.exit(reds.length > 0 ? 0 : 1)
} finally {
  restore()
}

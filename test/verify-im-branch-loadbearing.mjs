/**
 * 验证「IM 直投分支」端到端测试是承重的。
 *
 * 手法：把 resolveImService 改回只读属性（线上出 bug 的实现），
 * 跑 verify-im-branch.mjs，看它是否变红。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const IM = fileURLToPath(new URL('../lib/im.js', import.meta.url))
const original = fs.readFileSync(IM, 'utf8')

const start = original.indexOf('export function resolveImService(ctx) {')
const end = original.indexOf('\n}', start)
if (start < 0 || end < 0) { console.error('无法定位 resolveImService'); process.exit(2) }

const buggy = original.slice(0, start) + `export function resolveImService(ctx) {
  let service
  try { service = ctx?.dshIm } catch { return undefined }
  return typeof service?.send === 'function' ? service : undefined` + original.slice(end)

let restored = false
const restore = () => { if (!restored) { restored = true; fs.writeFileSync(IM, original, 'utf8') } }

try {
  fs.writeFileSync(IM, buggy, 'utf8')
  console.log('已改回「只读属性」的旧实现，跑端到端测试…\n')
  let output = ''
  let nonzero = false
  try {
    output = execFileSync(process.execPath, ['test/verify-im-branch.mjs'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    })
  } catch (error) {
    nonzero = true
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const relevant = output.split('\n').filter(l => /发到 QQ|待办状态|结论|lastImDelivery/.test(l))
  console.log(relevant.join('\n'))
  console.log(`\n退出码${nonzero ? '非 0（符合预期：旧实现确实发不出去）' : '为 0（测试无效）'}`)
  restore()
  process.exit(nonzero ? 0 : 1)
} finally {
  restore()
}

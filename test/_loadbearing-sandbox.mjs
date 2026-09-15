/**
 * 承重验证的沙箱工具。
 *
 * 这些脚本的工作原理是「注入坏版本 → 跑测试 → 看用例是否变红」，
 * 而它们需要改写 lib/ 下的源文件。**绝不能就地改写**：
 * 一次超时被 taskkill / 强杀，exit 与 signal 钩子都不会执行，
 * 坏版本就被永久留在磁盘上——而它是合法 JS，`node --check` 照样通过，
 * 没有任何机制会在意。本项目真的踩过两次（lib/index.js 与 lib/schema.js
 * 双双停在被注入的「配额不认承诺型」版本上）。
 *
 * 所以：复制 lib/ 与 test/ 到临时目录，在副本里注入与运行，真实源码全程只读。
 * 进程被 SIGKILL 也污染不到仓库（最坏只留一个 TEMP 目录）。
 *
 * @module test/_loadbearing-sandbox
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 建立一个一次性沙箱：lib/ 与 test/ 的完整副本 + 指向真实 node_modules 的 junction。
 * @returns {{ dir: string, read: (rel: string) => string, write: (rel: string, text: string) => void, run: (file: string) => string[], cleanup: () => void }}
 */
export function createSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-loadbearing-'))
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true })
  // 沙箱里的相对 import 需要能解析到 @deepseek-ai/*，接过去即可（只读）。
  const nm = path.join(ROOT, 'node_modules')
  if (fs.existsSync(nm)) {
    try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'junction') } catch { /* 已有就跳过 */ }
  }

  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  }
  process.on('exit', cleanup)

  return {
    dir,
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    write: (rel, text) => fs.writeFileSync(path.join(dir, rel), text, 'utf8'),
    /** 跑一个测试文件，返回红掉的用例行。 */
    run: (file) => {
      let output = ''
      try {
        output = execFileSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        output = String(error.stdout ?? '') + String(error.stderr ?? '')
      }
      return output.split('\n').filter(line => line.trim().startsWith('FAIL')).map(line => line.trim())
    },
    cleanup,
  }
}

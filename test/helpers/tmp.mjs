/**
 * 测试用的临时目录工具 —— **不再往工作区里堆目录**。
 *
 * ## 背景（踩过的坑）
 *
 * 早先各用例把临时 HOME 硬编码成 `D:/ds-runtime-test/111/.tmp-qqim-xxx/<时间戳>`
 * 这种形式，而且**没有清理**。于是每跑一轮 `npm test`，工作区根目录就多出一批
 * `.tmp-qqim-*` 目录 —— 累积到 896 个，把工作区弄得一团糟。
 *
 * 现在的约定：
 *   1. 临时目录一律建在**系统临时目录**下（`os.tmpdir()`），不再进工作区；
 *   2. 进程退出时（正常结束、异常、信号）**统一清理**，不留残骸；
 *   3. 名称带进程号与随机串，避免并发/重复运行时互相踩踏。
 *
 * @module dsh-hds-interlude/test/helpers/tmp
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本次进程创建过的临时目录（退出时统一清理）。 */
const created = new Set()
let cleanupHooked = false

/**
 * 挂上退出清理钩子（只挂一次）。
 *
 * 三个时机都要管：
 *   - `exit`：正常结束与 `process.exit()`；
 *   - `uncaughtException` / `unhandledRejection`：用例炸了也要清；
 *   - 信号：Ctrl-C 中断时能清多少清多少。
 */
function hookCleanup() {
  if (cleanupHooked) return
  cleanupHooked = true
  const cleanup = () => {
    for (const dir of created) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不该影响测试结果（Windows 上偶发文件占用）。
      }
    }
    created.clear()
  }
  process.on('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup()
      process.exit(130)
    })
  }
}

/**
 * 造一个本次进程独占的临时目录。
 *
 * @param {string} label 用途标签（只用于目录名，便于排查）。
 * @returns {string} 绝对路径（目录**已创建**）。
 */
export function tmpDir(label = 'tmp') {
  hookCleanup()
  const safe = String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'tmp'
  const dir = path.join(
    os.tmpdir(),
    'hds-i-test',
    `${safe}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  created.add(dir)
  return dir
}

/**
 * 每个用例一个独立目录（带自增序号，避免同毫秒冲突）。
 *
 * @param {string} label 用途标签。
 * @returns {string} 绝对路径（目录已创建）。
 */
let counter = 0
export function caseDir(label = 'case') {
  counter += 1
  return tmpDir(`${label}-${counter}`)
}

/** 立即清理本次进程创建的全部临时目录（一般不必手动调，退出时会自动清）。 */
export function cleanupTmpDirs() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
  created.clear()
}

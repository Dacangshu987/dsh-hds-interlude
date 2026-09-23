/**
 * resolveSecret 的凭据兜底：凭据服务缺失/报错时，直读 `$DSH_HOME/.credentials.yaml`。
 *
 * 线上症状：`.credentials.yaml` 里明明有 AppSecret，但凭据服务（dsh-credentials）
 * 在该时刻未注册/resolve 失败 → 机器人红点「凭据服务不可用，且环境变量未设置」。
 * 兜底（只读 yaml 行匹配）让已落盘的凭据一定读得到。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { resolveSecret, QqCredentialError } from '../../lib/qq-im/qq.js'
import { caseDir } from '../helpers/tmp.mjs'

const TMP = caseDir('credential-resolve')
process.env.DSH_HOME = TMP
fs.writeFileSync(path.join(TMP, '.credentials.yaml'), [
  'DSH_QQBOT_APP_SECRET: secretA',
  'DSH_QQBOT_APP_SECRET_HASH: "quotedSecret"',
  '',
].join('\n'), 'utf8')

let passed = 0
let failed = 0
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
}

// 凭据服务不可用：ctx.get('credentials') 返回 undefined。
const bareCtx = { get: () => undefined }

console.log('resolveSecret 凭据文件兜底')

await check('凭据服务缺失 + 环境变量没有 → 从 .credentials.yaml 读到', async () => {
  assert.equal(await resolveSecret(bareCtx, 'DSH_QQBOT_APP_SECRET'), 'secretA')
})

await check('yaml 引号值被剥掉', async () => {
  assert.equal(await resolveSecret(bareCtx, 'DSH_QQBOT_APP_SECRET_HASH'), 'quotedSecret')
})

await check('环境变量优先于文件兜底', async () => {
  process.env.DSH_QQBOT_APP_SECRET = 'fromEnv'
  try {
    assert.equal(await resolveSecret(bareCtx, 'DSH_QQBOT_APP_SECRET'), 'fromEnv')
  } finally {
    delete process.env.DSH_QQBOT_APP_SECRET
  }
})

await check('文件里没有 → 仍抛 QqCredentialError（不静默）', async () => {
  await assert.rejects(() => resolveSecret(bareCtx, 'DSH_QQBOT_APP_SECRET_NOPE'), QqCredentialError)
})

await check('凭据服务可用的正常路径仍走服务（文件兜底不干扰）', async () => {
  const ctx = {
    get: (name) => (name === 'credentials' ? { resolve: async (ref) => ({ value: 'fromService' }) } : undefined),
  }
  assert.equal(await resolveSecret(ctx, 'DSH_QQBOT_APP_SECRET'), 'fromService')
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 无所谓 */ }

console.log(`\n凭据兜底：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
/**
 * SSRF 防护（`lib/net/safe-fetch.js`）的用例。
 *
 * ## 为什么现在就测一个"还没人用"的模块
 *
 * 该模块**当前没有调用点**（本插件目前无出站 HTTP，是给将来接图片/链接预留的）。
 * 正因如此更要现在测：等到真接上图片能力时才第一次运行它，
 * 等于把安全闸门和业务改动绑在一次上线里；而且一个从没跑过的防护代码，
 * 与没有防护在心理上是等价的。
 *
 * ## 测法
 *
 * - **纯函数部分**（`isPrivateIp`）直接测，无需网络；
 * - **需要 DNS 的部分**（`validateFetchUrl`）只用**必然失败**的输入
 *   （内网 IP 字面量、非法 scheme、带凭据的 URL），这些在 DNS 之前就会被拒，
 *   因此**不依赖网络**、可在离线环境稳定运行；
 * - **不测**真实外网抓取（那需要网络，且不是本模块要保证的东西）。
 *
 * @module dsh-hds-interlude/test/safe-fetch.test
 */

import assert from 'node:assert/strict'

import {
  isPrivateIp,
  validateFetchUrl,
  validateImageUrl,
} from '../lib/net/safe-fetch.js'

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

console.log('SSRF 防护')

/* ------------------------------------------------ ① 内网地址必须被识别 */

await ok('IPv4 私有段全部覆盖（含 CGNAT 与保留段）', () => {
  const privates = [
    '127.0.0.1', '127.1.2.3',           // 环回
    '10.0.0.1', '10.255.255.255',       // 10/8
    '172.16.0.1', '172.31.255.254',     // 172.16/12
    '192.168.1.1',                       // 192.168/16
    '169.254.1.1',                       // 链路本地
    '100.64.0.1', '100.127.255.255',    // CGNAT（最容易漏的一段）
    '198.18.0.1', '198.19.255.255',     // 基准测试保留
    '192.0.0.1',                         // IETF 保留
    '224.0.0.1', '255.255.255.255',     // 组播 / 广播
    '0.0.0.0',                           // 未指定
  ]
  for (const ip of privates) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为内网`)
  }
})

await ok('IPv6 私有段覆盖（ULA / 链路本地 / 组播 / 文档段）', () => {
  const privates = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', '2001:db8::1', 'ff02::1']
  for (const ip of privates) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为内网`)
  }
})

await ok('内嵌 IPv4 的 IPv6 被递归判定（防绕过）', () => {
  // 这些是最经典的绕过手法：写成 v6 形式骗过朴素字符串匹配
  const bypasses = [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2002:7f00:0001::',        // 6to4 包装 127.0.0.1
    '64:ff9b::7f00:1',         // NAT64 包装 127.0.0.1
    '::ffff:192.168.1.1',
  ]
  for (const ip of bypasses) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为内网（内嵌 IPv4 未递归）`)
  }
})

await ok('公网地址不被误判（否则会把正常抓取全挡掉）', () => {
  const publics = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700::1111']
  for (const ip of publics) {
    assert.equal(isPrivateIp(ip), false, `${ip} 不应判为内网`)
  }
})

await ok('空值按内网处理（宁可拒绝，也不放行没解析出来的地址）', () => {
  assert.equal(isPrivateIp(''), true)
  assert.equal(isPrivateIp(null), true)
  assert.equal(isPrivateIp(undefined), true)
})

/* ------------------------------------------------ ② URL 层校验（离线可跑） */

await ok('拒绝非 http/https 协议', async () => {
  await assert.rejects(validateFetchUrl('file:///etc/passwd'), /仅允许 http\/https/)
  await assert.rejects(validateFetchUrl('ftp://example.com/x'), /仅允许 http\/https/)
  await assert.rejects(validateFetchUrl('gopher://example.com/'), /仅允许 http\/https/)
})

await ok('拒绝 URL 内嵌凭据', async () => {
  await assert.rejects(validateFetchUrl('http://user:pass@example.com/'), /不能包含凭据/)
})

await ok('拒绝非法 URL', async () => {
  await assert.rejects(validateFetchUrl('not a url'), /URL 无效/)
  await assert.rejects(validateFetchUrl(''), /URL 无效/)
})

await ok('拒绝内网 IP 字面量（DNS 之前就拦下）', async () => {
  await assert.rejects(validateFetchUrl('http://127.0.0.1/'), /禁止访问内网/)
  await assert.rejects(validateFetchUrl('http://10.0.0.1/'), /禁止访问内网/)
  await assert.rejects(validateFetchUrl('http://192.168.1.1/'), /禁止访问内网/)
  await assert.rejects(validateFetchUrl('http://[::1]/'), /禁止访问内网/)
})

await ok('拒绝 localhost 与 .local 域名', async () => {
  await assert.rejects(validateFetchUrl('http://localhost/'), /禁止访问内网/)
  await assert.rejects(validateFetchUrl('http://foo.localhost/'), /禁止访问内网/)
  await assert.rejects(validateFetchUrl('http://printer.local/'), /禁止访问内网/)
})

/* ------------------------------------------------ ③ 图片地址校验 */

await ok('validateImageUrl 同样拦截内网图片地址', async () => {
  await assert.rejects(validateImageUrl('http://127.0.0.1/a.png'), /禁止访问内网/)
  await assert.rejects(validateImageUrl('file:///a.png'), /只允许 http\(s\) 图片地址/)
})

await ok('validateImageUrl：allowPrivate 是显式开关，默认关闭', async () => {
  // 显式放行时才允许内网（对应上游 security.allowPrivateImageHosts）
  const allowed = await validateImageUrl('http://127.0.0.1/a.png', { allowPrivate: true })
  assert.equal(allowed, 'http://127.0.0.1/a.png')
  // 默认（不传）必须仍拒绝
  await assert.rejects(validateImageUrl('http://127.0.0.1/a.png'), /禁止访问内网/)
})

/* ------------------------------------------------ ④ 导出面完整性 */

await ok('导出面与上游一致（5 个函数）', async () => {
  const mod = await import('../lib/net/safe-fetch.js')
  const names = Object.keys(mod).sort()
  assert.deepEqual(names, ['isPrivateIp', 'safeFetch', 'safeFetchBinary', 'validateFetchUrl', 'validateImageUrl'])
})

console.log(`\n✅ 全部通过（${passed} 项）`)

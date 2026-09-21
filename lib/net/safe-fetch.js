/**
 * 安全抓取层 —— SSRF 防护（DNS 固定 + 逐跳重校验 + 内网地址拦截）。
 *
 * ## 来源与许可
 *
 * 移植自 **K0nd1us/QQ-agent**（MIT License, Copyright (c) 2026 Kondius）
 * 的 `src/safe-fetch.js`，commit `72f537f9`。
 *
 * 依据 MIT 许可保留上述声明即可自由使用、修改、分发。
 *
 * ## 相对上游的改动（只有一处）
 *
 * 上游用模块级 `getConfig()` 读 `security.allowPrivateImageHosts`（2 处：
 * 原文 L252 / L280）。**本移植改为参数注入** —— 本插件没有全局可变配置单例，
 * 且注入后这些函数成为纯函数，可独立测试。
 * 其余逻辑（IP 判定表、DNS 校验、IP 固定、重定向、限读）**逐行保留**。
 *
 * ## 本插件当前是否需要它
 *
 * **暂时不需要 —— 这是为将来预留的。**
 * 实测本插件目前**没有任何出站 HTTP**：`lib/*.js` 与 `lib/qq-im/*.js` 里
 * 全部 `fetch(` 命中都是 `lib/client.js` 的**同源** UI 调用
 * （`fetch('/api/hds-interlude/...')`），入站也只处理文本
 * （`lib/qq-im/inbound.js` 的 `renderInboundText`）。联网能力归 DSH 宿主。
 *
 * 所以本模块**当前没有调用点**。留它的理由是：一旦接入图片/链接能力
 * （例如下载入站图片、或让模型提供的 URL 进上下文），这就是必须先有的那道闸。
 * 与其那时临时写，不如现在把上游经过实战检验的实现放进来。
 *
 * ## 防护要点
 *
 * - 仅 http/https；拒绝 URL 内嵌凭据；
 * - 拒绝 localhost / `.local` / 私有 IP / 环回 / 链路本地 / CGNAT 等；
 * - 域名先 DNS 解析并**检查全部结果**，任一为内网即拒；
 * - 解析后**固定到已校验的 IP** 发请求（`hostname: ip`，保留 Host 头与 SNI）
 *   —— 从根上消除 DNS rebinding；
 * - 手动跟随重定向，**每一跳重新校验**；
 * - 响应体按**字节**限读。
 *
 * @module dsh-hds-interlude/net/safe-fetch
 */

import dns from 'node:dns'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'

const dnsLookup = dns.promises.lookup

/* ── IP 判定 ───────────────────────────────────────────────────────────── */

/** 解析 IPv6 中内嵌的 IPv4（`::ffff:a.b.c.d`、`::ffff:7f00:1` 等）。 */
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':')
  if (parts.length < 2) return null
  const last = parts[parts.length - 1]
  const secondLast = parts[parts.length - 2]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  return null
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!lower.includes(':')) return null
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower)
    if (embedded) return embedded
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower)
    if (embedded) return embedded
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i)
  if (nat64) {
    if (nat64[3]) return nat64[3]
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  return null
}

/**
 * 是否是内网 / 保留 / 不可路由地址。
 *
 * 覆盖：`10/8`、`127/8`、`0/8`、`169.254/16`、`172.16/12`、`192.168/16`、
 * `100.64/10`（CGNAT）、`198.18/15`、`192.0.0/24`、`>=224`（组播+保留）；
 * IPv6：`::1`、`fc/fd`（ULA）、`fe8-feb`（链路本地）、`fec-fef`、`2001:db8`、
 * `2001:2/10/20`、`ff`（组播），以及各类**内嵌 IPv4 递归判定**。
 *
 * 空值按「内网」处理（宁可拒绝，也不放行一个没解析出来的地址）。
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null
  if (embedded) return isPrivateIp(embedded)

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number)
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true
    if (parts[0] >= 224) return true
    return false
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    if (/^fe[89ab]/.test(h)) return true
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true
    if (h.startsWith('2001:db8')) return true
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i)
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16)
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
      if (isPrivateIp(ipv4)) return true
    }
    if (h.startsWith('ff')) return true
    return false
  }
  return false
}

/* ── 主机名校验（含 DNS） ──────────────────────────────────────────────── */

function lookupWithTimeout(hostname) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000)
  })
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout])
    .finally(() => clearTimeout(timer))
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) throw new Error('主机名为空')
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址')
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址')
    return h
  }
  let addresses
  try {
    addresses = await lookupWithTimeout(h)
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`)
  }
  if (!addresses.length) throw new Error('域名没有解析结果')
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止')
    }
  }
  return addresses[0].address
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 `{ url, ip }`。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('URL 无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https')
  if (url.username || url.password) throw new Error('URL 不能包含凭据')
  const ip = await resolveSafeHost(url.hostname, { allowPrivate })
  return { url, ip }
}

/* ── 受限请求 ──────────────────────────────────────────────────────────── */

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s
  return Array.from(s).slice(0, max).join('')
}

function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    const chunks = []
    let total = 0
    let text = ''
    let settled = false
    const finish = (fn, val) => {
      if (settled) return
      settled = true
      fn(val)
    }
    res.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (asText) text += decoder.write(chunk)
      else chunks.push(chunk)
      // 只用**字节数**判断是否超限。
      //
      // 上游注释记录过一个真实 bug：原实现还额外比较 `text.length >= maxBytes`，
      // 但 text.length 是**字符数**而 maxBytes 是**字节数**（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy() } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes))
      }
    })
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end()
          finish(resolve, sliceByCodePoints(text, maxBytes))
        } else {
          finish(resolve, Buffer.concat(chunks))
        }
      }
    })
    res.on('error', (err) => finish(reject, err))
  })
}

/**
 * 用**已校验的 IP** 发起请求（保留 `Host` 头与 https 的 SNI）。
 *
 * 这是防 DNS rebinding 的关键：DNS 只在 `resolveSafeHost` 里解析一次，
 * 之后连接直连那个 IP，中途再改 DNS 也影响不了本次请求。
 */
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const port = url.port || (url.protocol === 'https:' ? 443 : 80)
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-hds-interlude/0.1',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume()
        resolve({ statusCode, redirect: String(res.headers.location || '') })
        return
      }
      readBounded(res, maxBytes, !asBinary)
        .then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject)
    })
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)))
    req.on('error', reject)
    req.end()
  })
}

const MAX_REDIRECTS = 5

/**
 * 抓取网页文本（≤50000 字符），SSRF 全防护（**不做**内网例外）。
 *
 * @param {string} urlString
 * @returns {Promise<{url: string, statusCode: number, truncated: boolean, body: string}>}
 */
export async function safeFetch(urlString) {
  let { url, ip } = await validateFetchUrl(urlString)
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: 50000 })
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`)
      const next = new URL(result.redirect, url).toString()
      // 每一跳都重新校验 —— 否则第一跳的合法域名可以把你重定向到内网。
      ({ url, ip } = await validateFetchUrl(next))
      continue
    }
    const body = result.body || ''
    return { url: url.toString(), statusCode: result.statusCode, truncated: body.length >= 50000, body }
  }
  throw new Error('重定向次数过多，已停止')
}

/**
 * 下载二进制（图片，≤maxBytes 字节）。
 *
 * @param {string} urlString
 * @param {number} [maxBytes]
 * @param {{allowPrivate?: boolean}} [options]
 *   `allowPrivate` 对应上游的 `security.allowPrivateImageHosts`
 *   （仅供本地测试/自建图床，默认关闭）。**注入而非读全局配置。**
 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, { allowPrivate = false } = {}) {
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate })
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes })
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`)
      const next = new URL(result.redirect, url).toString()
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }))
      continue
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`)
    return { buffer: result.body, contentType: result.contentType }
  }
  throw new Error('重定向次数过多，已停止')
}

/**
 * 图片地址校验（供图片下载前使用）。
 *
 * @param {string} raw
 * @param {{allowPrivate?: boolean}} [options]
 * @returns {Promise<string>} 校验通过的 URL 字符串
 */
export async function validateImageUrl(raw, { allowPrivate = false } = {}) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('图片地址不合法')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址')
  if (allowPrivate) return url.toString()
  const { url: safeUrl } = await validateFetchUrl(url.toString())
  return safeUrl.toString()
}

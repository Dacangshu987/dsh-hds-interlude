/**
 * 入站图片收割 —— 把用户发来的表情包存进表情库。
 *
 * ## 为什么必须落盘
 *
 * QQ 入站图片给的是一条 `attachments[].url`，它有两个问题：
 *   ① **会过期**：那是腾讯 CDN 的临时地址，几小时到几天后 404；
 *   ② **要鉴权**：部分场景直接 GET 拿不到。
 *
 * 所以「用户发过的表情可以复用」这件事，**不落盘就是做不到的**——
 * 存 URL 等于存了一个很快就失效的引用。
 *
 * ## 为什么值得存
 *
 * 用户自己发的表情包，正是**这个用户的语域**。角色用他自己的表情回他，
 * 比让模型编一个通用路径要自然得多，也几乎是唯一能让「发表情包」
 * 真的像本人的办法。
 *
 * ## 安全取舍
 *
 *   - 只收 `image/*`（按 content_type 判，不信扩展名）；
 *   - 单张上限 10MB，超了直接放弃（不截断——截断的图是坏图）；
 *   - **下载失败绝不影响消息注入**：收割是旁路，失败就当日志记一条。
 *
 * @module dsh-hds-interlude/qq-im/sticker-harvest
 */

import path from 'node:path'

import {
  OWN_DIR, contentHash, guessImageExt, senderDirName, writeSticker, rememberSticker,
} from './sticker-store.js'

/** 单张入站图片大小上限（与 store 保持一致，提前拒掉省一次读盘）。 */
const MAX_BYTES = 10 * 1024 * 1024

/** 下载超时（毫秒）。收割是旁路，卡住不如放弃。 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * 从入站消息里挑出所有图片附件。
 *
 * @param {object} message SDK 入站消息。
 * @returns {Array<{url: string, contentType: string, filename?: string}>} 图片附件列表。
 */
export function imageAttachmentsOf(message) {
  const list = Array.isArray(message?.attachments) ? message.attachments : []
  const out = []
  for (const att of list) {
    const contentType = String(att?.content_type ?? att?.contentType ?? '').toLowerCase()
    const url = String(att?.url ?? '').trim()
    if (!url) continue
    // 只认 image/*。voice/video/file 交给别的路径（现在没有，也不该混进来）。
    if (!contentType.startsWith('image/')) continue
    if (!/^https?:\/\//i.test(url)) continue
    const size = Number(att?.size)
    if (Number.isFinite(size) && size > MAX_BYTES) continue
    out.push({ url, contentType, filename: att?.filename })
  }
  return out
}

/**
 * 下载一张图并落盘到表情库。
 *
 * @param {object} options
 * @param {string} options.url 图片地址。
 * @param {string} options.contentType MIME。
 * @param {string} [options.filename] 原始文件名（兜底猜扩展名）。
 * @param {string} options.dir 表情库目录。
 * @param {string} [options.sender] 发送者 openid（决定子目录）。
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用）。
 * @param {Function} [options.log] 日志回调。
 * @returns {Promise<{path: string, created: boolean}|null>} 落盘结果；失败返回 null。
 */
export async function harvestOne({
  url, contentType, filename, dir, sender, fetchImpl, log = () => {},
}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return null

  let response
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    log('warn', `表情包下载失败（${error?.message ?? error}）：${url.slice(0, 80)}`)
    return null
  }
  if (!response?.ok) {
    log('warn', `表情包下载失败（HTTP ${response?.status}）：${url.slice(0, 80)}`)
    return null
  }

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    log('warn', `表情包读取失败（${error?.message ?? error}）`)
    return null
  }
  if (!buffer.length) return null
  // 下载后按真实大小再判一次：附件里声明的 size 不总是可信。
  if (buffer.length > MAX_BYTES) {
    log('warn', `表情包超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，已放弃：${url.slice(0, 80)}`)
    return null
  }

  const sub = sender ? senderDirName(sender) : OWN_DIR
  const ext = guessImageExt(contentType, filename ?? url)
  const written = writeSticker({ buffer, dir: path.join(dir, sub), ext })
  if (!written) return null

  rememberSticker(dir, {
    path: written.path,
    // 名字先用内容 hash 的短前缀：真正有意义的名字由用户/角色后来补。
    // 不用原始 filename——QQ 常给 `image` 或一串数字，做名字没有意义。
    name: contentHash(buffer).slice(0, 6),
    sender: sender ?? null,
    source: 'inbound',
  })
  return written
}

/**
 * 收割一条入站消息里的全部图片。
 *
 * **永不抛错**：这是旁路，任何失败都只记日志。调用方可以放心
 * `await` 它，也可以直接 `void` 掉不 await。
 *
 * @param {object} options
 * @param {object} options.message 入站消息。
 * @param {string} options.dir 表情库目录。
 * @param {string} [options.sender] 发送者 openid。
 * @param {Function} [options.fetchImpl] 注入的 fetch。
 * @param {Function} [options.log] 日志回调。
 * @returns {Promise<{saved: number, created: number}>} 收割结果。
 */
export async function harvestInboundImages({ message, dir, sender, fetchImpl, log = () => {} }) {
  const result = { saved: 0, created: 0 }
  if (!dir) return result
  const images = imageAttachmentsOf(message)
  for (const image of images) {
    try {
      const written = await harvestOne({
        url: image.url,
        contentType: image.contentType,
        filename: image.filename,
        dir,
        sender,
        fetchImpl,
        log,
      })
      if (written) {
        result.saved += 1
        if (written.created) result.created += 1
      }
    } catch (error) {
      // 双保险：harvestOne 内部已经兜了，这里防未来的改动漏掉。
      log('warn', `表情包收割异常：${error?.message ?? error}`)
    }
  }
  return result
}

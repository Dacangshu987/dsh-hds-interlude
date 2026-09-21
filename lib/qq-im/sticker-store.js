/**
 * 表情包仓库 —— 角色可复用的图片库，以及「用户发过的表情」的落盘。
 *
 * ## 解决什么问题
 *
 * 模型发表情包时最现实的两个障碍：
 *   ① 它不知道文件在哪。让模型凭空编一个路径，结果只能是「图片文件不存在」；
 *   ② 用户发来的表情包是**最有价值的素材**（那正是这个用户的语域），
 *      但它只是一条会过期的 QQ URL，转身就没了。
 *
 * 本模块把这两件事收敛到一个目录里：`~/.dsh/media/stickers/`。
 *   - 角色没给路径时，工具从这里**按名字**找图；
 *   - 用户发来的图片自动落盘、去重、按发送者分目录，角色之后可以直接复用。
 *
 * ## 目录结构
 *
 * ```
 * ~/.dsh/media/stickers/
 *   index.json                 # 清单：每张图的名字 / 来源 / 时间 / 摘要
 *   mine/                      # 角色自己的图（用户手动放的，或角色存的）
 *     开心.png
 *   from-<用户openid前8位>/     # 用户发来的，按发送者分开
 *     a1b2c3d4.png
 * ```
 *
 * 为什么按发送者分目录而不是全堆一起：不同人的表情包语域不同，
 * 「用 A 的表情回 B」在真人聊天里是件很奇怪的事。分开存，模型才有得选。
 *
 * ## 去重
 *
 * 按**文件内容**的 sha256 去重，不按 URL——QQ 的图片 URL 几乎每条都不同，
 * 同一张图发两次会得到两个 URL。内容 hash 才认得出「这就是同一张」。
 *
 * @module dsh-hds-interlude/qq-im/sticker-store
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 角色自己的图放这里（固定目录名，用户手工往里丢图就能被复用）。 */
export const OWN_DIR = 'mine'

/** 允许作为表情包落盘/发送的图片扩展名。 */
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|bmp)$/i

/** 单张表情包大小上限（10MB）。超过就不落盘——QQ 侧也未必收得下。 */
const MAX_STICKER_BYTES = 10 * 1024 * 1024

/**
 * 默认表情包目录。
 *
 * 为什么是 `~/.dsh/` 而不是工作区：表情包是**跨项目**的资产。
 * 跟着 workspace 走会让用户每换一个项目就发现「角色又不会发表情了」。
 * 放在 DSH_HOME 下与其它持久数据同级，语义也清楚。
 *
 * @param {string} [dshHome] 覆盖 DSH_HOME（测试用）。
 * @returns {string} 绝对路径。
 */
export function defaultStickerDir(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'media', 'stickers')
}

/** 把一个 openid 压成安全的目录名（只留字母数字，取前 8 位）。 */
export function senderDirName(senderId) {
  const safe = String(senderId ?? '').replace(/[^A-Za-z0-9]/g, '')
  return `from-${safe.slice(0, 8) || 'unknown'}`
}

/** 取内容 hash（sha256 前 16 位）——去重的依据。 */
export function contentHash(buffer) {
  if (!buffer || !buffer.length) return ''
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

/**
 * 从 Content-Type 或 URL 猜图片扩展名。
 *
 * 落盘时必须有扩展名：QQ 侧与后面的发送路径都按扩展名判断是不是图片，
 * 存成 `.bin` 会让这张图**再也发不出去**。
 *
 * @param {string} [contentType] MIME（如 `image/png`）。
 * @param {string} [urlOrName] 兜底的 URL / 文件名。
 * @returns {string} 形如 `.png`；认不出退回 `.png`。
 */
export function guessImageExt(contentType, urlOrName) {
  const mime = String(contentType ?? '').toLowerCase()
  const byMime = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
  }
  for (const [key, ext] of Object.entries(byMime)) {
    if (mime.startsWith(key)) return ext
  }
  // URL 里带的扩展名比 MIME 更可信时用它（QQ 有时只给 application/octet-stream）。
  const fromName = String(urlOrName ?? '').split(/[?#]/)[0]
  const match = /\.(jpe?g|png|gif|webp|bmp)$/i.exec(fromName)
  if (match) return `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`
  return '.png'
}

/** 是不是一张「看起来像图片」的路径。 */
export function looksLikeImagePath(filePath) {
  return typeof filePath === 'string' && IMAGE_EXT.test(filePath)
}

/**
 * 用文件内容 hash 去重落盘。
 *
 * **先落盘再查重**（或反过来）都行，但必须按内容判等：同一个文件被两个不同
 * URL 指向时，只应存一份。
 *
 * @param {object} options
 * @param {Buffer} options.buffer 文件内容。
 * @param {string} options.dir 目标目录（绝对路径）。
 * @param {string} [options.ext] 扩展名（含点）。
 * @param {string} [options.hash] 预先算好的 hash（省一次计算）。
 * @returns {{path: string, created: boolean, hash: string}|null} 落盘结果；内容为空返回 null。
 */
export function writeSticker({ buffer, dir, ext = '.png', hash }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  if (buffer.length > MAX_STICKER_BYTES) return null
  const digest = hash || contentHash(buffer)
  fs.mkdirSync(dir, { recursive: true })

  const target = path.join(dir, `${digest}${ext}`)
  // 已存在同一张（同 hash）：不重写、不重复计数。
  if (fs.existsSync(target)) return { path: target, created: false, hash: digest }

  // 同 hash 但扩展名不同（同一张图被存成 .jpg 和 .png）：也算已存在。
  const existing = fs.existsSync(dir)
    ? fs.readdirSync(dir).find(name => name.startsWith(`${digest}.`) && IMAGE_EXT.test(name))
    : undefined
  if (existing) return { path: path.join(dir, existing), created: false, hash: digest }

  // 先写临时文件再改名：中途失败不会留下半张图被当成有效表情包。
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, target)
  return { path: target, created: true, hash: digest }
}

/**
 * 读取清单（index.json）。
 *
 * 清单只存**元数据**（名字、来源、时间），用来给模型一份「库里有什么」的列表。
 * 真图片始终以磁盘文件为准——清单丢了不影响发图，反之则不然。
 *
 * @param {string} dir 表情包目录。
 * @returns {Array<object>} 条目列表；读不到返回空数组。
 */
export function readIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    return Array.isArray(parsed?.stickers) ? parsed.stickers : []
  } catch {
    return []
  }
}

/** 原子写入清单。 */
export function writeIndex(dir, stickers) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'index.json')
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ stickers }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export const MAX_STICKER_COUNT = 500

/**
 * 记一条表情包进清单（同路径只记一次），并执行清理。
 *
 * @param {string} dir 表情包目录。
 * @param {object} entry `{ path, name?, sender?, source?, at? }`。
 * @returns {object} 写入的条目。
 */
export function rememberSticker(dir, entry) {
  const stickers = readIndex(dir)
  const rel = path.basename(entry.path)
  const existing = stickers.find(s => s.file === rel)
  if (existing) {
    // 已经记过：只补可能缺的字段（比如后来才起了名字），不覆盖已有名字。
    let changed = false
    if (!existing.name && entry.name) { existing.name = entry.name; changed = true }
    if (changed) writeIndex(dir, stickers)
    return existing
  }
  const record = {
    file: rel,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.parse(rel).name,
    sender: entry.sender ?? null,
    source: entry.source ?? 'unknown',
    at: entry.at ?? new Date().toISOString(),
  }
  stickers.push(record)
  writeIndex(dir, stickers)
  
  // 触发淘汰
  evictOldStickers(dir)
  
  return record
}

/**
 * 按数量淘汰过期的表情包。
 */
export function evictOldStickers(dir) {
  const all = listStickers(dir, { limit: 10000 })
  if (all.length <= MAX_STICKER_COUNT) return

  const toRemove = all.slice(MAX_STICKER_COUNT)
  let removedCount = 0
  for (const s of toRemove) {
    // 不淘汰用户自己放的表情
    if (s.source === 'mine') continue
    try {
      fs.unlinkSync(s.path)
      removedCount++
    } catch { }
  }

  // 同步清理 index.json 中已经删掉的文件记录
  if (removedCount > 0) {
    const validFiles = new Set(all.slice(0, MAX_STICKER_COUNT).map(s => path.basename(s.path)))
    const currentStickers = readIndex(dir).filter(s => validFiles.has(s.file) || s.source === 'mine')
    writeIndex(dir, currentStickers)
  }
}

/**
 * 列出库里可用的表情包（磁盘上真实存在的才算）。
 *
 * 清单与磁盘可能不一致（用户手工删了文件、或往里丢了图没登记），
 * 这里以**磁盘**为准并顺带把磁盘上多出来的补进清单——用户手动丢图的
 * 用法因此不需要手工维护 index.json。
 *
 * @param {string} dir 表情包目录。
 * @param {object} [options]
 * @param {number} [options.limit] 最多返回多少条。
 * @returns {Array<{name: string, path: string, sender: string|null, source: string, at: string}>}
 */
export function listStickers(dir, { limit = 200 } = {}) {
  const stickers = readIndex(dir)
  const byFile = new Map(stickers.map(s => [s.file, s]))
  const found = []

  // 扫磁盘：清单是索引，磁盘才是事实。
  let dirs = []
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch { /* 目录不存在 → 空库 */ }

  for (const sub of dirs) {
    let files = []
    try {
      files = fs.readdirSync(path.join(dir, sub.name), { withFileTypes: true })
        .filter(e => e.isFile() && IMAGE_EXT.test(e.name))
    } catch { continue }
    for (const file of files) {
      const meta = byFile.get(file.name)
      found.push({
        name: meta?.name ?? path.parse(file.name).name,
        path: path.join(dir, sub.name, file.name),
        sender: meta?.sender ?? (sub.name === OWN_DIR ? null : sub.name.replace(/^from-/, '')),
        source: meta?.source ?? (sub.name === OWN_DIR ? 'mine' : 'inbound'),
        at: meta?.at ?? null,
      })
    }
  }
  // 也接受直接放在根目录下的图（用户可能就这么丢进来）。
  try {
    const loose = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && IMAGE_EXT.test(e.name))
    for (const file of loose) {
      const meta = byFile.get(file.name)
      found.push({
        name: meta?.name ?? path.parse(file.name).name,
        path: path.join(dir, file.name),
        sender: meta?.sender ?? null,
        source: meta?.source ?? 'mine',
        at: meta?.at ?? null,
      })
    }
  } catch { /* 无所谓 */ }

  found.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  return found.slice(0, limit)
}

/**
 * 按名字（或不完整名字）在库里找一张图。
 *
 * 匹配优先级：**精确名字 → 精确文件名 → 唯一前缀**。
 * 刻意不做模糊匹配：找不到时让调用方如实报错，比猜错一张图好——
 * 发错表情包是无法撤回的社交事故。
 *
 * @param {string} dir 表情包目录。
 * @param {string} query 名字关键词。
 * @returns {object|undefined} 命中的条目。
 */
export function findStickerByName(dir, query) {
  const want = String(query ?? '').trim()
  if (!want) return undefined
  const all = listStickers(dir, { limit: 2000 })
  const lower = want.toLowerCase()

  const exact = all.find(s => s.name === want || path.parse(s.path).name === want)
  if (exact) return exact

  const caseInsensitive = all.find(s => s.name.toLowerCase() === lower)
  if (caseInsensitive) return caseInsensitive

  const prefixes = all.filter(s => s.name.toLowerCase().startsWith(lower))
  if (prefixes.length === 1) return prefixes[0]

  // 名字里包含也算，但仍然只在唯一时采纳。
  const contains = all.filter(s => s.name.toLowerCase().includes(lower))
  if (contains.length === 1) return contains[0]

  return undefined
}

/** 表情库统计（给状态展示与 UI 用）。 */
export function stickerStats(dir) {
  const all = listStickers(dir, { limit: 5000 })
  const senders = new Set()
  let mine = 0
  for (const s of all) {
    if (s.source === 'mine' || !s.sender) mine += 1
    else senders.add(s.sender)
  }
  return { total: all.length, mine, senders: senders.size }
}

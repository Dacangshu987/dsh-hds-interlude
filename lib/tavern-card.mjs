/**
 * 酒馆（SillyTavern）角色卡 ↔ interlude Story 的转换。
 *
 * 角色卡格式：`chara_card_v2`（JSON，字段 name/description/personality/scenario/
 * first_mes/mes_example/system_prompt/post_history_instructions/character_book…），
 * 载体可为 `.json` 文件，或 PNG 的 `tEXt/zTXt/iTXt` chunk（键 `chara`）。
 *
 * ## 双向无损
 *
 * 导出时把**完整 Story JSON** 备份进 `data.extensions.dsh_hds_interlude.story`
 * （酒馆会忽略未知扩展）；导入时**优先读该备份**（100% 还原），纯酒馆卡
 * （无备份）才走字段映射 + 合理默认。
 *
 * ## 字段映射（无备份时）
 *
 * | Story | 酒馆卡 |
 * |---|---|
 * | character.name | name |
 * | character.profile | description（+ perspective / world / counterpart 合并段） |
 * | character.speech | personality |
 * | plot.startingPoint | scenario（+ first_mes 并入「开场白」） |
 * | plot.boundaries | system_prompt |
 * | plot.style | post_history_instructions |
 * | plot.keywords | tags（+ character_book.keys 并入） |
 * | （导入）character_book.entries 内容 | 并入 profile「世界书」段 |
 * | （导入）mes_example | 并入 profile「示例对话」段 |
 *
 * 本模块是 **node 侧纯函数**（PNG 用 node:zlib 同步解压；浏览器侧在 client.js
 * 内联等价实现，用 DecompressionStream——两边行为由各自测试覆盖）。
 *
 * @module dsh-hds-interlude/tavern-card
 */

import zlib from 'node:zlib'

/** 转字符串（空值/非字符串 → ''）。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** UTF-8 解码（node 与浏览器都有全局 TextDecoder）。 */
function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes)
}

/** 深拷贝（JSON 往返，丢掉 undefined）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}))
}

/**
 * Story → 酒馆角色卡 v2 JSON。
 *
 * @param {object} story interlude Story。
 * @returns {object} 酒馆卡（含 extensions.dsh_hds_interlude.story 无损备份）。
 */
export function storyToTavernCard(story) {
  const s = story ?? {}
  const c = s.character ?? {}
  const w = s.world ?? {}
  const cp = s.counterpart ?? {}
  const p = s.plot ?? {}

  const descParts = []
  if (str(c.profile)) descParts.push(c.profile)
  if (str(s.perspective)) descParts.push(`价值观：\n${s.perspective}`)
  const worldLines = [
    str(w.setting) || null,
    str(w.location) ? `主要地点：${w.location}` : null,
    str(w.supportingCast) ? `配角：\n${w.supportingCast}` : null,
  ].filter(Boolean)
  if (worldLines.length) descParts.push(`世界观：\n${worldLines.join('\n')}`)
  const counterpartLines = [
    str(cp.profile) || null,
    str(cp.initial) ? `初始关系：${cp.initial}` : null,
  ].filter(Boolean)
  if (counterpartLines.length) descParts.push(`对话者：\n${counterpartLines.join('\n')}`)

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: str(c.name),
      description: descParts.join('\n\n'),
      personality: str(c.speech),
      scenario: str(p.startingPoint),
      first_mes: '',
      mes_example: '',
      creator_notes: '由 dsh-hds-interlude（幕间系统）导出',
      system_prompt: str(p.boundaries),
      post_history_instructions: str(p.style),
      alternate_greetings: [],
      character_book: undefined,
      tags: Array.isArray(p.keywords) ? p.keywords.filter(k => typeof k === 'string' && k.trim()) : [],
      creator: 'dsh-hds-interlude',
      character_version: '1.0',
      extensions: {
        dsh_hds_interlude: { story: clone(story) },
      },
    },
  }
}

/**
 * 酒馆角色卡 → Story。
 *
 * 优先读 `extensions.dsh_hds_interlude.story`（无损还原）；没有则字段映射。
 *
 * @param {object} card 角色卡（`{data: {...}}` 或直接卡对象均可）。
 * @returns {object} Story。
 */
export function tavernCardToStory(card) {
  const data = card?.data ?? card ?? {}
  const ext = data?.extensions?.dsh_hds_interlude?.story
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    return clone(ext)
  }

  const story = { character: {}, world: {}, counterpart: {}, plot: {}, keywords: [] }
  story.character.name = str(data.name) || '未命名角色'
  story.character.profile = str(data.description)
  story.character.speech = str(data.personality)
  story.plot.startingPoint = str(data.scenario)
  if (str(data.first_mes)) {
    story.plot.startingPoint = [story.plot.startingPoint, `开场白：${data.first_mes.trim()}`]
      .filter(Boolean).join('\n\n')
  }
  story.plot.boundaries = str(data.system_prompt)
  story.plot.style = str(data.post_history_instructions)
  if (str(data.mes_example)) {
    story.character.profile = [story.character.profile, `（示例对话，来自角色卡）\n${data.mes_example.trim()}`]
      .filter(Boolean).join('\n\n')
  }

  // 世界书：内容并入 profile「世界书」段，keys 并入 keywords（interlude 文本驱动）。
  const bookEntries = Array.isArray(data.character_book?.entries) ? data.character_book.entries : []
  const bookLines = bookEntries.map(e => str(e?.content)).filter(Boolean)
  if (bookLines.length) {
    story.character.profile = [story.character.profile, `（世界书条目）\n${bookLines.join('\n---\n')}`]
      .filter(Boolean).join('\n\n')
  }
  const bookKeys = []
  for (const entry of bookEntries) {
    if (Array.isArray(entry?.keys)) bookKeys.push(...entry.keys.filter(k => typeof k === 'string' && k.trim()))
  }
  const tags = Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string' && t.trim()) : []
  story.plot.keywords = [...new Set([...bookKeys, ...tags])]

  return story
}

/**
 * 把一段文本解析成角色卡对象（先当原始 JSON，再当 base64）。
 *
 * SillyTavern 官方 PNG 卡的 `chara` 块存的是 **base64 的 JSON**
 * （`btoa(unescape(encodeURIComponent(json)))`，即「UTF-8 字节 → base64」），
 * 部分分发渠道的 `.json` 文件同样可能是 base64 文本。若直接 `JSON.parse` 会抛
 * `Unexpected token 'e', "eyJzcGVj..."`——那正是 base64 开头 `{"spec…` 的前几个字符。
 *
 * 判序是「先原始、后 base64」：本插件旧导出的 PNG 卡是原始 JSON，必须继续兼容；
 * 而 base64 字符串不可能同时是合法 JSON，两条路不冲突。
 *
 * @param {string} text 角色卡文本。
 * @returns {object} 解析出的对象。
 * @throws {Error} 既非原始 JSON 也非 base64 JSON。
 */
function parseCardText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 非原始 JSON，继续 */ }
  try {
    const decoded = Buffer.from(String(text ?? '').replace(/\s+/g, ''), 'base64').toString('utf8')
    parsed = JSON.parse(decoded)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* 也不是 base64 */ }
  throw new Error('不是合法的角色卡 JSON（既非原始 JSON，也非 base64 JSON）')
}

/** 从 JSON 文本解析角色卡对象（兼容带/不带 `data` 包装，并校验确实是角色卡）。 */
export function parseCardJson(text) {
  const parsed = parseCardText(text)
  // 角色卡特征：顶层或 data 里有 name（酒馆 v2 的 data.name）。
  const name = parsed?.name ?? parsed?.data?.name
  if (typeof name !== 'string') throw new Error('不是合法的角色卡 JSON（缺少角色名）')
  return parsed
}

/** PNG chunk 里按关键字提取文本（支持 tEXt / zTXt / iTXt）。 */
function pngTextByKeyword(chunks, keyword) {
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt' && chunk.keyword === keyword) return chunk.text
    if (chunk.type === 'zTXt' && chunk.keyword === keyword) return chunk.text
    if (chunk.type === 'iTXt' && chunk.keyword === keyword) return chunk.text
  }
  return undefined
}

/**
 * 解析 PNG 文件，提取 `chara` 角色卡 JSON（只读元数据 chunk，不解码像素）。
 *
 * @param {Buffer|Uint8Array} buffer PNG 字节。
 * @returns {object|undefined} 角色卡；没有 chara 返回 undefined。
 */
export function parsePngChara(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== sig[i]) throw new Error('不是合法的 PNG 文件')
  }
  const chunks = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > bytes.length) break
    if (type === 'tEXt') {
      const sep = bytes.indexOf(0, dataStart)
      if (sep > dataStart && sep < dataEnd) {
        chunks.push({
          type,
          keyword: decodeUtf8(bytes.subarray(dataStart, sep)),
          text: decodeUtf8(bytes.subarray(sep + 1, dataEnd)),
        })
      }
    } else if (type === 'zTXt') {
      const sep = bytes.indexOf(0, dataStart)
      if (sep > dataStart && sep + 2 <= dataEnd) {
        const keyword = decodeUtf8(bytes.subarray(dataStart, sep))
        const compressed = bytes.subarray(sep + 2, dataEnd)
        try {
          chunks.push({ type, keyword, text: zlib.inflateSync(compressed).toString('utf8') })
        } catch { /* 解压失败跳过 */ }
      }
    } else if (type === 'iTXt') {
      const sep = bytes.indexOf(0, dataStart)
      if (sep > dataStart) {
        const keyword = decodeUtf8(bytes.subarray(dataStart, sep))
        // flag(1) method(1) lang\0 translated\0 text
        let cursor = sep + 1
        if (cursor + 2 <= dataEnd) {
          const flag = bytes[cursor]
          const method = bytes[cursor + 1]
          cursor += 2
          const langEnd = bytes.indexOf(0, cursor)
          cursor = langEnd < 0 ? dataEnd : langEnd + 1
          const transEnd = bytes.indexOf(0, cursor)
          cursor = transEnd < 0 ? dataEnd : transEnd + 1
          const textBytes = bytes.subarray(cursor, dataEnd)
          try {
            const text = flag === 1 && method === 0
              ? zlib.inflateSync(textBytes).toString('utf8')
              : decodeUtf8(textBytes)
            chunks.push({ type, keyword, text })
          } catch { /* 跳过 */ }
        }
      }
    }
    off = dataEnd + 4 // 跳过 CRC
  }
  const chara = pngTextByKeyword(chunks, 'chara')
  return chara ? parseCardText(chara) : undefined
}

/* ------------------------------------------------ CRC32 / PNG 构造（测试与未来导出用） */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32(bytes) {
  let crc = -1
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/**
 * 把角色卡构造成 PNG（tEXt `chara` 键）——测试与未来「导出 PNG」用。
 *
 * @param {object} card 角色卡对象。
 * @returns {Buffer} PNG 字节。
 */
export function buildPngCard(card) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)      // width
  ihdr.writeUInt32BE(1, 4)      // height
  ihdr[8] = 8                   // bit depth
  ihdr[9] = 6                   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  const pixel = Buffer.from([0x5f, 0x9b, 0xe8, 0xff]) // 1×1 蓝点
  const idat = Buffer.concat([Buffer.from([0]), pixel]) // filter 0

  const keyword = Buffer.from('chara', 'ascii')
  // 对齐 SillyTavern：PNG 卡的 chara 块存 **base64 的 JSON**（不是原始 JSON），
  // 这样本插件导出的 PNG 卡能被酒馆直接导入（parsePngChara 会 base64 解回）。
  const text = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
  const tEXt = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(text, 'utf8')])

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(idat)),
    chunk('tEXt', tEXt),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 从文件内容解析角色卡：自动识别 JSON 文本或 PNG。
 *
 * @param {Buffer|Uint8Array} buffer 文件字节。
 * @param {string} [name] 文件名（仅用于错误提示）。
 * @returns {object} 角色卡对象。
 */
export function parseTavernCardFile(buffer, name = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // PNG 魔数：\x89PNG
  const isPng = bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (isPng) {
    const card = parsePngChara(bytes)
    if (!card) throw new Error('PNG 里没有找到 chara 角色卡数据')
    return card
  }
  const text = Buffer.from(bytes).toString('utf8')
  if (!text.trim()) throw new Error('文件是空的')
  try {
    return parseCardJson(text)
  } catch (error) {
    throw new Error(`不是合法的角色卡文件（既不是 JSON 也不是 PNG）：${error?.message ?? String(error)}`)
  }
}

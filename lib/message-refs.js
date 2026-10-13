/**
 * 入站消息引用清单 —— 让角色能**指名引用**某一条来消息回复。
 *
 * ## 上游对应
 *
 * 上游 `ChatActions.quoteReply`（默认开）的语义是：「允许主角引用当前上下文中的
 * **一条**消息进行指定回复」。它的机制是给上下文里每条消息一个 `messageRef`
 * （`msg-…`），模型在回复里带上 `replyTo:"msg-…"`，且**只有清单里真实存在的 ref
 * 才合法**（上游原话：`only messageRef values explicitly present in … are valid targets`）。
 *
 * ## 本仓为什么需要这一层
 *
 * 本仓的入站消息以**自然文本**进入 DSH 的会话历史，不带任何引用标识——
 * 模型看得到「对方说过什么」，但**说不清是哪一条**。所以要自己维护一份
 * 「最近收到的几条 + 它们的稳定 ref」，渲染进提示词，模型才有东西可指。
 *
 * ## 三个刻意的约束
 *
 *   ① ref 必须**稳定**：同一条消息在多次渲染里是同一个 ref，否则模型上一轮看到的
 *      ref 下一轮就失效了；
 *   ② 只在**清单内**解析：模型可能编一个 ref（或复述历史里的旧 ref），
 *      解析不到就当作「没有指定引用」，绝不猜；
 *   ③ 容量有上限且按时间淘汰：清单会进提示词，不能无限长。
 *
 * 本模块是**纯函数 + 纯数据**：不碰网络、不碰投递，只负责维护与解析。
 *
 * @module dsh-hds-interlude/message-refs
 */

/** 清单默认容量（最近多少条）。上限存在的理由是它会进提示词。 */
export const DEFAULT_REF_LIMIT = 8

/** ref 前缀：与上游的 `msg-…` 形态一致，便于对照。 */
export const REF_PREFIX = 'msg-'

/** 单条预览的最大字符数（避免一条长消息把清单撑爆）。 */
const PREVIEW_CHARS = 80

/**
 * 归一化一条入站记录。
 *
 * @param {object} raw 原始记录。
 * @returns {{ref: string, text: string, sender: string, at: string}|undefined}
 *   不可用时返回 undefined（宁可少一条，也不要塞半个进去）。
 */
export function normalizeInboundRef(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const seq = Number(raw.seq)
  if (!Number.isFinite(seq) || seq <= 0) return undefined
  const text = typeof raw.text === 'string' ? raw.text : ''
  return {
    ref: `${REF_PREFIX}${Math.floor(seq)}`,
    text: text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    sender: typeof raw.sender === 'string' ? raw.sender.slice(0, 64) : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  }
}

/**
 * 把一条新入站消息压进清单（返回**新数组**，不改原数组）。
 *
 * ref 由调用方给的 `seq`（单调递增的序号）决定——用序号而不是时间戳，
 * 是因为同一毫秒内可能连收两条，时间戳会撞。
 *
 * @param {Array<object>} list 现有清单。
 * @param {object} raw 新记录（需要 `seq`）。
 * @param {number} [limit] 容量上限。
 * @returns {Array<object>} 新清单（旧的在前，新的在后）。
 */
export function pushInboundRef(list, raw, limit = DEFAULT_REF_LIMIT) {
  const entry = normalizeInboundRef(raw)
  const base = Array.isArray(list) ? list.slice() : []
  if (!entry) return base
  // 同一个 ref 不重复入列（重放/重试同一事件时不叠加）。
  if (base.some(item => item?.ref === entry.ref)) return base
  base.push(entry)
  const cap = Math.max(1, Math.floor(Number(limit) || DEFAULT_REF_LIMIT))
  return base.slice(-cap)
}

/**
 * 解析模型给出的引用（`replyTo` / `reply_to`）。
 *
 * **只在清单内解析**：找不到就返回 undefined——绝不猜、也不用「最近一条」兜底。
 * 模型可能编一个 ref，也可能复述上一轮渲染过但已淘汰的旧 ref；两种都必须
 * 退化成「没有指定引用」，而不是发一条引用错了对象的回复。
 *
 * @param {Array<object>} list 清单。
 * @param {unknown} ref 模型给出的 ref。
 * @returns {object|undefined} 命中的条目。
 */
export function resolveInboundRef(list, ref) {
  const wanted = String(ref ?? '').trim()
  if (!wanted) return undefined
  if (!Array.isArray(list)) return undefined
  return list.find(item => item?.ref === wanted)
}

/**
 * 把清单渲染成提示词里的一段（模型据此挑 ref）。
 *
 * 刻意**只给 ref 与预览**，不给完整正文——完整正文已经在会话历史里了，
 * 这里的作用是「给每条一个可指的名字」。
 *
 * @param {Array<object>} list 清单。
 * @param {number} [limit] 最多渲染几条（默认全部）。
 * @returns {Array<string>} 提示词行；清单为空时返回空数组（调用方据此不渲染该段）。
 */
export function renderInboundRefs(list, limit) {
  const items = Array.isArray(list) ? list : []
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : items.length
  // `slice(-0)` 等价于 `slice(0)`，会返回**整段**而不是空——必须显式挡掉 0。
  if (cap === 0) return []
  const picked = items.slice(-cap)
  if (!picked.length) return []
  const lines = ['【可引用的来消息】']
  for (const item of picked) {
    const who = item.sender ? `${item.sender}：` : ''
    lines.push(`- ${item.ref}｜${who}${item.text}`)
  }
  lines.push('想针对其中某一条回复，就在 interlude_say 里带上 reply_to（填上面那个 ref）。只在确有其事时才用，不要编 ref。')
  return lines
}

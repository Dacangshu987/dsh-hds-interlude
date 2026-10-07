/**
 * 入站事件归一化 —— 把腾讯 SDK 的**原始事件**翻译成本插件内部的统一 `message` 形状。
 *
 * ## 为什么必须有这一层（线上症状：群聊里「不认识人」）
 *
 * SDK 的原始事件按场景长得完全不一样：
 *
 * ```
 * C2CMessageEvent   { author: { user_openid } }                    // 私聊：**没有昵称字段**
 * GroupMessageEvent { author: { member_openid, username? } }        // 群聊：昵称是**可选**的
 * GuildMessageEvent { author: { id, username? } }                  // 频道
 * ```
 *
 * 而本插件的内部契约是扁平的 `{ kind, senderId, senderName, groupOpenid, content, ... }`。
 * 早先 `qq.js` 把 SDK 事件**原样透传**给 handler，于是：
 *   - `message.senderId` 永远是 undefined（SDK 叫 `author.member_openid`）；
 *   - `message.senderName` 永远是 undefined（SDK 叫 `author.username`，且常不返回）；
 *   - 群聊渲染退化成「**对方**（来自 QQ 群）：」，同一个人说话和另一个人说话长得一模一样
 *     —— 角色当然「不认识人」。
 *
 * ## 设计取舍
 *
 * 1. **昵称拿不到时，用稳定的短标识代替**（`群友3f2a`）。
 *    不能退化成「对方」：多个人共用一个称呼，模型无法区分谁是谁，
 *    更无法维持「A 说过什么、B 说过什么」的关系记忆。
 *    openid 是稳定的，取尾部几位既能区分人、又不再泄漏完整标识。
 * 2. **昵称优先**：QQ 有时确实给 `username`，那就用人话（真实昵称）。
 * 3. **纯函数、无副作用**：便于单测覆盖各种 SDK 事件形态。
 *
 * @module dsh-hds-interlude/qq-im/normalize
 */

/** 取稳定短标识：去掉非字母数字后取尾部 4 位。 */
function shortId(raw) {
  const safe = String(raw ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!safe) return ''
  return safe.length <= 4 ? safe : safe.slice(-4)
}

/**
 * 昵称兜底：没有真实昵称时，造一个**可区分**的称呼。
 *
 * @param {string} openid 发送者标识。
 * @param {boolean} isGroup 是否群聊。
 * @returns {string} 如 `群友3f2a` / `对方7c1b`；连 openid 都没有时返回空串。
 */
export function fallbackSenderName(openid, isGroup) {
  const tail = shortId(openid)
  if (!tail) return ''
  return isGroup ? `群友${tail}` : `对方${tail}`
}

/**
 * 把 SDK 原始事件归一成本插件的内部 `message` 形状。
 *
 * 兼容三种形态（顺序即优先级）：
 *   ① 已经是内部形状（有 `senderId` 或 `kind`）→ 补齐缺失字段后原样返回；
 *   ② SDK 原始事件（有 `author`）→ 从中提取；
 *   ③ 两者都不像 → 返回 undefined，调用方据此丢弃（绝不猜）。
 *
 * @param {object} raw SDK 原始事件或内部形状。
 * @param {object} [options]
 * @param {string} [options.botSelfId] 机器人自己的 openid（用于识别「自己发的」）。
 * @returns {object|undefined} 内部 message；无法识别时 undefined。
 */
export function normalizeInboundMessage(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return undefined
  const author = raw.author && typeof raw.author === 'object' ? raw.author : undefined

  // 场景判定：SDK 用 group_openid 区分群聊；也可由 rawEventType 判定。
  const rawEventType = typeof raw.rawEventType === 'string' ? raw.rawEventType : ''
  const looksGroup = Boolean(raw.group_openid) || rawEventType.includes('GROUP')
  const kind = raw.kind === 'group' || raw.kind === 'c2c'
    ? raw.kind
    : (looksGroup ? 'group' : 'c2c')

  // 发送者标识：内部字段优先，其次 SDK 的 author 各变体。
  const groupOpenid = raw.groupOpenid ?? raw.group_openid
  const senderId = raw.senderId
    ?? author?.member_openid
    ?? author?.user_openid
    ?? author?.id
    ?? groupOpenid

  if (typeof senderId !== 'string' || !senderId) return undefined

  // 昵称：SDK 的 author.username（群聊/频道可能有），否则可区分短标识。
  const rawName = typeof raw.senderName === 'string' && raw.senderName.trim()
    ? raw.senderName.trim()
    : (typeof author?.username === 'string' && author.username.trim() ? author.username.trim() : '')
  const senderName = rawName || fallbackSenderName(senderId, kind === 'group')

  const normalized = {
    ...raw,
    kind,
    senderId,
    ...(senderName ? { senderName } : {}),
    ...(groupOpenid ? { groupOpenid } : {}),
    messageId: raw.messageId ?? raw.id,
    content: typeof raw.content === 'string' ? raw.content : '',
  }
  // 机器人自己发的消息不该当作用户输入（否则会自我循环）。
  if (options.botSelfId && senderId === options.botSelfId) {
    return { ...normalized, fromSelf: true }
  }
  return normalized
}

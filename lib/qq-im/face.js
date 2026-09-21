/**
 * QQ 原生 face（系统表情）双向适配。
 *
 * ## 背景
 *
 * QQ 的 `[face:id]` 是**文本标记**，不是媒体消息——它跟图片走两条完全不同的
 * 通路。图片要上传再发 `msg_type:7`；face 只是一段文本，直接混在正文里发出去
 * 就能被 QQ 客户端渲染成表情。
 *
 * 这一点很关键：**发 face 不需要任何新通路**，只要保证它不被当成噪声删掉。
 *
 * ## 为什么单独一个模块
 *
 * 两个方向都要处理，而且必须用**同一份 id 表**：
 *   - 收：`[face:14]` → `[微笑]`，让模型看得懂对方发了什么表情；
 *   - 发：让模型可以写 `[face:14]` 或 `[微笑]`，由这里翻成 QQ 认的标记。
 *
 * 如果两边各写一份映射，早晩会出现「收进来是微笑、发出去变成别的脸」。
 *
 * ## 与清洗管线的关系
 *
 * `im.js` 的 `cleanImText` 会删掉旁白括号、Markdown 标记。face 标记是
 * **方括号**形态，正好和「整行旁白【…】」的判据撞车——`[face:14]` 若单独一行
 * 会被 `NARRATION_LINE` 整行删除。所以发送前必须先把 face 标记**保护**起来，
 * 清洗完再还原。见 {@link protectFaces}。
 *
 * @module dsh-hds-interlude/qq-im/face
 */

/**
 * QQ face id → 中文名。
 *
 * 只收录常用的一批：全表有 200+ 个，其中大量是历史遗留与游戏联动表情，
 * 收全了既没意义（模型也不会用）又难维护。表里没有的 id 走
 * {@link describeFace} 的兜底文案，不会丢信息。
 */
export const FACE_NAMES = {
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞',
  7: '闭嘴', 8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙',
  14: '微笑', 15: '难过', 16: '酷', 17: '冷汗', 18: '抓狂', 19: '吐',
  20: '偷笑', 21: '可爱', 22: '白眼', 23: '傲慢', 24: '饥饿', 25: '困',
  26: '惊恐', 27: '流汗', 28: '憨笑', 29: '大兵', 30: '奋斗', 31: '咒骂',
  32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅',
  38: '敲打', 39: '再见', 40: '擦汗', 41: '抠鼻', 42: '鼓掌', 43: '糗大了',
  44: '坏笑', 45: '左哼哼', 46: '右哼哼', 47: '哈欠', 48: '鄙视', 49: '委屈',
  50: '快哭了', 51: '阴险', 52: '亲亲', 53: '吓', 54: '可怜', 55: '菜刀',
  56: '西瓜', 57: '啤酒', 58: '篮球', 59: '乒乓', 60: '咖啡', 61: '饭',
  62: '猪头', 63: '玫瑰', 64: '凋谢', 65: '示爱', 66: '爱心', 67: '心碎',
  68: '蛋糕', 69: '闪电', 70: '炸弹', 71: '刀', 72: '足球', 73: '瓢虫',
  74: '便便', 75: '月亮', 76: '太阳', 77: '礼物', 78: '拥抱', 79: '强',
  80: '弱', 81: '握手', 82: '胜利', 83: '抱拳', 84: '勾引', 85: '拳头',
  86: '差劲', 87: '爱你', 88: 'NO', 89: 'OK', 90: '爱情', 91: '飞吻',
  92: '跳跳', 93: '发抖', 94: '怄火', 95: '转圈', 96: '磕头', 97: '回头',
  98: '跳绳', 99: '挥手', 100: '激动', 101: '街舞', 102: '献吻', 103: '左太极',
  104: '右太极', 105: '双喜', 106: '鞭炮', 107: '灯笼', 108: 'K歌', 109: '喝彩',
  110: '购物', 111: '邮件', 112: '帅', 113: '喝彩', 114: '祈祷', 115: '爆筋',
  116: '棒棒糖', 117: '喝奶', 118: '下面', 119: '香蕉', 120: '飞机',
  121: '开车', 122: '高铁', 123: '左车头', 124: '车厢', 125: '右车头',
  126: '多云', 127: '下雨', 128: '钞票', 129: '熊猫', 130: '灯泡',
  131: '风车', 132: '闹钟', 133: '打伞', 134: '彩球', 135: '钻戒',
  136: '沙发', 137: '纸巾', 138: '药', 139: '手枪', 140: '青蛙',
  141: '茶', 142: '眨眼睛', 143: '泪奔', 144: '无奈', 145: '托腮',
  146: '卖萌', 147: '笑哭', 148: '瀑布汗', 149: '惊哭', 150: '喷血',
  151: 'actually', 152: 'doge', 153: '喵', 154: '打脸', 155: '大笑',
  156: 'doge脸', 157: '抠鼻屎', 158: '鼓掌', 159: '猜猜', 160: '哼',
}

/** 中文名 → face id（用于把模型写的「[微笑]」翻回去）。多个 id 同名时取最小的那个。 */
const NAME_TO_ID = (() => {
  const map = new Map()
  for (const [id, name] of Object.entries(FACE_NAMES)) {
    const key = name.toLowerCase()
    if (!map.has(key)) map.set(key, Number(id))
  }
  // 常用别名：模型更可能写这些，而不是官方名。
  const aliases = {
    '笑': 13, '大笑': 155, '害羞脸': 6, '生气': 11, '怒': 11, '哭': 9,
    '想哭': 50, '疑惑': 32, '汗': 27, '点赞': 79, '鼓掌': 42, '玫瑰': 63,
    '爱心': 66, '心': 66, '强': 79, 'ok': 89, 'no': 88, '再见': 39,
  }
  for (const [name, id] of Object.entries(aliases)) {
    const key = name.toLowerCase()
    if (!map.has(key)) map.set(key, id)
  }
  return map
})()

/** QQ 原生 face 标记：`[face:14]`、`[face: 14 ]`。 */
const FACE_MARK = /\[face:\s*(\d+)\s*\]/gi

/** 模型可能写的中文名标记：`[微笑]`、`【微笑】`。 */
const NAME_MARK = /[[【]\s*([^\[\]【】:]{1,8}?)\s*[\]】]/g

/** 保护 face 标记时用的占位符（清洗管线不会碰它）。 */
const PROTECT_PREFIX = '\u0000FACEPLACEHOLDER'
const PROTECT_TAIL = '\u0000'

/**
 * 把一个 face id 说成人话。
 *
 * QQ 的 face id 是**非负整数**，合法范围落在 32 位无符号内。早先这里直接
 * `key |= 0`（转 32 位**有符号**）了事，于是超出范围的值会**回绕成负数**：
 * `[face:4294967295]` → `[表情-1]`、`[face:2147483648]` → `[表情-2147483648]`。
 * 这些负数不是「不认识的表情」，而是**不存在的东西**，却照样被拼进入站文本
 * 喂给模型——模型会当真去理解它。
 *
 * 现在的规矩：只接受安全范围内的非负整数；**超范围就如实说「不认识」**，
 * 不做回绕、也不做截断（截断会把一个坏 id 伪装成一个好 id）。
 *
 * @param {number|string} id face id。
 * @returns {string} 中文名；不认识返回 `[表情30]` / `[表情?]` 这种可读兜底。
 */
export function describeFace(id) {
  const key = Number(id)
  // 非数字：保持既有的可读兜底（用例钉过这个形态）。
  if (!Number.isFinite(key)) return '[表情]'
  // **溢出防线**：只认非负安全整数。超范围的值不做 32 位回绕——回绕出来的负数
  // 是「不存在的东西」，却会被当真理解（`[face:4294967295]` 曾变成 `[表情-1]`）。
  if (!Number.isSafeInteger(key) || key < 0) return `[表情${String(id).trim()}]`
  return FACE_NAMES[key] ?? `[表情${key}]`
}

/**
 * 把中文化：`[face:14]` → `[微笑]`。
 *
 * 用在**入站**方向，让模型看得懂对方发了什么表情。
 *
 * @param {string} text 原始文本。
 * @returns {string} 替换后的文本。
 */
export function humanizeFaces(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(FACE_MARK, (_m, id) => `[${describeFace(id)}]`)
}

/**
 * 把模型写的中文名标记翻成 QQ 认的 `[face:id]`。
 *
 * 保留无法识别的方括号内容（可能是别的东西，比如 [图片]），
 * 只翻表里有的名字——**翻不出来的不动**比猜一个脸安全。
 *
 * @param {string} text 原始文本。
 * @returns {string} 替换后的文本。
 */
export function materializeFaces(text) {
  if (typeof text !== 'string' || !text) return ''
  // 已经是 [face:N] 的原样保留（模型也可能直接写对了）。
  return text.replace(NAME_MARK, (whole, inner) => {
    const name = String(inner ?? '').trim()
    if (!name) return whole
    const id = NAME_TO_ID.get(name.toLowerCase())
    return id === undefined ? whole : `[face:${id}]`
  })
}

/**
 * 发送前保护 face 标记，避免被 `cleanImText` 当旁白删掉。
 *
 * 为什么必须做：`cleanImText` 的 `NARRATION_LINE` 会把「整行只有方括号」的内容
 * 整行删除（那是过滤「【她犹豫了一下】」用的）。而模型完全可能**只发一个表情**，
 * 那一行就是 `[face:14]` —— 会被删得干干净净，变成「这一轮什么都没说」。
 *
 * 做法：把 face 标记换成不含方括号的占位符，清洗后再还原。
 *
 * @param {string} text 原始文本。
 * @returns {{text: string, faces: string[]}} 保护后的文本与待还原的片段。
 */
export function protectFaces(text) {
  const faces = []
  const out = String(text ?? '').replace(FACE_MARK, (mark) => {
    faces.push(mark)
    return `${PROTECT_PREFIX}${faces.length - 1}${PROTECT_TAIL}`
  })
  return { text: out, faces }
}

/**
 * 还原被保护的 face 标记。
 *
 * @param {string} text 清洗后的文本。
 * @param {string[]} faces {@link protectFaces} 返回的片段表。
 * @returns {string} 还原后的文本。
 */
export function restoreFaces(text, faces) {
  if (typeof text !== 'string' || !Array.isArray(faces) || faces.length === 0) return text ?? ''
  return text.replace(
    new RegExp(`${PROTECT_PREFIX}(\\d+)${PROTECT_TAIL}`, 'g'),
    (whole, index) => faces[Number(index)] ?? whole,
  )
}

/**
 * 一段文本里有没有 face 标记。
 *
 * @param {string} text 待检查文本。
 * @returns {boolean}
 */
export function hasFace(text) {
  if (typeof text !== 'string' || !text) return false
  FACE_MARK.lastIndex = 0
  return FACE_MARK.test(text)
}

/**
 * `cleanImText` 的 face 安全包装：先保护、再清洗、再还原。
 *
 * 为什么放在这里而不是改 `cleanImText`：清洗管线是**共享**的（故事落盘、
 * 自言自语闸都在用），在那里塞 face 逻辑会让「什么算台词」的判据复杂化。
 * face 是 QQ 通道专有的概念，就留在 QQ 通道里。
 *
 * @param {string} text 原始文本。
 * @param {(input: string) => string} clean 清洗函数（通常是 cleanImText）。
 * @returns {string} 清洗后还原了 face 的文本。
 */
export function cleanKeepingFaces(text, clean) {
  const { text: guarded, faces } = protectFaces(text)
  const cleaned = clean(guarded)
  const restored = restoreFaces(cleaned, faces)
  // 清洗可能把带占位符的整行清空，但 face 本身是有意义的「一句话」。
  // 若还原后只剩空白，就用原始 face 片段兜底。
  if (!restored.trim() && faces.length > 0) return faces.join('')
  return restored
}

/**
 * 分条，但保住 face 标记。
 *
 * ## 为什么不能「先 cleanKeepingFaces 再 split」
 *
 * 因为 `splitImText` **内部自己会再清洗一次**（那是它的第一道工序）。
 * 于是：
 *
 * ```
 * cleanKeepingFaces('[face:14]')  →  '[face:14]'   ✅ 保护住了
 * splitImText('[face:14]')        →  []            ❌ 又被清掉
 * ```
 *
 * 保护必须包在**分条的外面**：先把 face 换成占位符，整段交给分条
 * （它内部怎么清洗都伤不到占位符），分完再逐条还原。
 * 占位符不含方括号与 Markdown 标记，所以分条也不会把它切开。
 *
 * @param {string} text 原始文本。
 * @param {(input: string, options?: object) => string[]} split 分条函数（通常是 splitImText）。
 * @param {object} [options] 传给分条函数的参数（maxChars / maxMessages）。
 * @returns {string[]} 分好的条目（face 已还原）。
 */
export function splitKeepingFaces(text, split, options) {
  const { text: guarded, faces } = protectFaces(text)
  const chunks = split(guarded, options)
  const out = []
  for (const chunk of chunks) {
    const restored = restoreFaces(chunk, faces)
    // 某个 chunk 被清成空、而它承载了 face：那是「只发了一个表情」，
    // 不能丢——丢掉就变成「这一轮什么都没说」。
    if (!restored.trim()) {
      const held = faces.filter(f => chunk.includes(f) || chunk.includes(PROTECT_PREFIX))
      if (held.length) { out.push(held.join('')); continue }
      continue
    }
    out.push(restored)
  }
  // 兜底：整段被清空但本来有 face（比如文本是「[face:14]」而分条返回 []）。
  if (out.length === 0 && faces.length > 0) {
    const guardedHasContent = guarded.replace(new RegExp(`${PROTECT_PREFIX}\\d+${PROTECT_TAIL}`, 'g'), '').trim()
    // 只有「除了 face 没别的内容」时才整体退化成 face；否则说明是真被清洗掉了。
    if (!guardedHasContent) return [faces.join('')]
  }
  return out
}

/** 导出映射表供测试与 UI 使用。 */
export const __internals = { NAME_TO_ID, FACE_MARK, NAME_MARK }

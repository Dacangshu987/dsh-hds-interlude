/**
 * 配置键的**改名兼容层**（第 3 阶段：按上游键名重构）。
 *
 * ## 为什么需要它
 *
 * 上游把「故事档案模板」叫 `storyDefaults`，本仓叫 `story`（上游在 rc5x 中途改的名）。
 * 对齐上游要改键名，但**用户 profile 里已经有 `story:` 的写法**——直接改名的后果是
 * 那份配置静默失效（schemastery 会把不认识的键当透传保留，代码却读不到新名字）。
 *
 * 所以分两步走：**先做兼容，再改名**。兼容做在**配置载入的入口**上，而不是去改
 * 几十处读取点——下游代码看到的永远是填好的那个名字，一处归一化、处处生效。
 *
 * ## 两个方向都要填
 *
 * 迁移期里两种写法都可能出现，而读取点也可能还没全部改完。所以：
 *
 *   - 只有**新名**（`storyDefaults`）→ 把旧名（`story`）也填上，旧读取点照常工作；
 *   - 只有**旧名**（`story`）→ 把新名也填上，新读取点照常工作；
 *   - 两个都有 → **新名赢**（并在返回值里把旧名对齐成新名的值，避免两处不一致）。
 *
 * 这样「谁读哪个名字」在迁移期不再是问题，改名可以一步步做。
 *
 * @module dsh-hds-interlude/config-compat
 */

/**
 * 已知的改名对：`旧名 → 新名`。
 *
 * 加新对时**只往这里加**，不要在别处写第二份清单——那正是本仓反复踩的「同一个
 * 东西写两遍」。
 */
/**
 * 已知的**路径搬移**：`旧路径 → 新路径`（第 3 阶段把字段从 `im` 折进独立段时用）。
 *
 * 与 `RENAMED_KEYS` 的区别：那个管**顶层改名**（story → storyDefaults），
 * 这个管**换位置且可能同时改名**（`im.stickerDir` → `stickers.directory`）。
 * 两者都是「旧写法必须继续生效」的同一件事，所以放在同一层处理。
 *
 * 目前为空：能力先就位并测好，第一条真实搬移随 `stickers` 段的迁移一起加。
 */
export const MOVED_PATHS = {}

/** 按点路径取值（中途断了返回 undefined）。 */
function getAt(root, path) {
  let node = root
  for (const part of String(path ?? '').split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/** 按点路径写值（**原地写**；调用方负责先复制）。中间层缺失时建对象。 */
function setAt(root, path, value) {
  const parts = String(path ?? '').split('.')
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (node[k] === null || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {}
    node = node[k]
  }
  node[parts[parts.length - 1]] = value
  return root
}

export const RENAMED_KEYS = {
  story: 'storyDefaults',
}

/**
 * 归一化配置里的改名键：让新旧两种写法在任何读取点都等价。
 *
 * @param {object} config 原始配置（不会被修改）。
 * @returns {object} 归一化后的**新对象**。
 */
/** 结构比较（对象键序无关）——用来判断「这个值是不是 schema 的默认值」。 */
function sameValue(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]))
}

/**
 * 归一化配置里的改名键：让新旧两种写法在任何读取点都等价。
 *
 * ## 为什么需要 `defaults`
 *
 * 宿主在调用插件前**已经用 schema 解析过配置**，而 schemastery 会给**没写的键**
 * 填上默认值。于是「两个名字都存在」这件事本身**不代表用户写了两个**——很可能
 * 其中一个是我自己填的默认值。
 *
 * 实测过的坑（两个方向都踩过）：
 *   - 改名后配置里只有**旧名**：新名被填成默认值 → 简单规则「新名赢」会**用默认值
 *     把用户真正的配置压掉**（实测：主角名变成 "Unnamed character"）；
 *   - 反过来只有新名时同理。
 *
 * 所以传入 `defaults`（`Config({})` 的结果）后，判断变成：
 * **新名等于默认值、而旧名不等于默认值 → 认定用户写的是旧名，用旧名。**
 * 没传 `defaults` 时退回「新名优先」的简单规则（调用方明确知道没有默认值填充时可用）。
 *
 * @param {object} config 原始配置（不会被修改）。
 * @param {object} [options]
 * @param {object} [options.defaults] schema 的默认值（`Config({})`）。
 * @returns {object} 归一化后的**新对象**。
 */
/**
 * 按「谁不是默认值」挑赢家。这一条是本层的核心判断：
 * 宿主已经用 schema 解析过配置，**「存在」不代表「用户写了」**——很可能是 schema
 * 自己填的默认值。实测过的坑：改名后配置里只有旧名时，「新名赢」会拿默认值把
 * 用户真正的配置压掉（主角名变成 Unnamed character）。
 */
function pickWinner(oldValue, newValue, oldDefault, newDefault, hasDefaults) {
  if (!hasDefaults) return newValue !== undefined ? newValue : oldValue
  const newIsDefault = sameValue(newValue, newDefault)
  const oldIsDefault = sameValue(oldValue, oldDefault)
  if (newIsDefault && !oldIsDefault) return oldValue
  return newValue !== undefined ? newValue : oldValue
}

export function normalizeConfigAliases(config, { defaults, moved = MOVED_PATHS } = {}) {
  const src = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const base = defaults && typeof defaults === 'object' ? defaults : null
  const out = { ...src }
  // ① 顶层改名
  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    const hasOld = src[oldKey] !== undefined
    const hasNew = src[newKey] !== undefined
    if (!hasOld && !hasNew) continue
    const winner = pickWinner(src[oldKey], src[newKey],
      base ? base[oldKey] : undefined, base ? base[newKey] : undefined, Boolean(base))
    out[newKey] = winner
    out[oldKey] = winner
  }
  // ② 路径搬移：旧路径与新路径**都写**，迁移期里两边的读取点都能工作。
  for (const [oldPath, newPath] of Object.entries(moved ?? {})) {
    const hasOld = getAt(src, oldPath) !== undefined
    const hasNew = getAt(src, newPath) !== undefined
    if (!hasOld && !hasNew) continue
    const winner = pickWinner(getAt(src, oldPath), getAt(src, newPath),
      base ? getAt(base, oldPath) : undefined, base ? getAt(base, newPath) : undefined, Boolean(base))
    setAt(out, newPath, winner)
    setAt(out, oldPath, winner)
  }
  return out
}

/**
 * 读一个改名键的**规范值**（新名优先，回退旧名）。
 *
 * 给「不方便走归一化」的地方用（例如已经拿到零散配置片段的纯函数）。
 * 两条路都能拿到同一个值，是这一层的意义。
 *
 * @param {object} config 配置对象。
 * @param {string} oldKey 旧名。
 * @returns {*} 值；两个名字都没有时返回 undefined。
 */
export function readAliased(config, oldKey) {
  const newKey = RENAMED_KEYS[oldKey]
  if (!newKey) return config?.[oldKey]
  if (config?.[newKey] !== undefined) return config[newKey]
  return config?.[oldKey]
}

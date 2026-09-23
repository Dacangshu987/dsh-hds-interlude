/**
 * 从角色的回复里认出「它答应了但没记下来」的时间约定。
 *
 * 为什么需要这一层：**把按时提醒寄希望于模型每次都记得调工具，是不可靠的**。
 * 线上实测（QQ 会话 ffc1e728）就是这样坏的：
 *   用户：「三分钟后提醒我喝水」
 *   角色：「行 / 三分钟后喊你 / 你先回我，是不是又没喝水」
 *   ——听着完全合理，但它没有调用 interlude_plan。三分钟后什么都没发生。
 * 工具是暴露给模型的（request/header 里 6 个 interlude_* 全在），提示词也写了
 * 要记——模型仍然漏了。这是提示词工程无法 100% 消除的一类失败。
 *
 * 所以这里做一道**确定性兜底**：角色的回复里如果出现了将来时间点的承诺，
 * 而这一轮又没有真的记下待办，就替它记一条，让到点唤醒照常发生。
 * 它兑现的是角色自己说过的话，不是替它编内容。
 *
 * @module dsh-hds-interlude/commitment
 */

/** 中文数字 → 阿拉伯数字，覆盖分钟量级的常见说法。 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/**
 * 过去时标记。
 *
 * 用在时间点**前面**那一小段里判断：`昨天我三分钟后就走了` 说的是已经发生的事，
 * 不是承诺。只在时间点前看，是因为「三分钟后」之后的字属于另一个分句，
 * 它的时态与这个短语无关（`三分钟后喊你` 后面跟什么都是将来的事）。
 */
const PAST_MARKER = /(昨天|前天|刚才|刚刚|之前|那次|上次|已经|早就|当时|后来|结果)/

/** 角色可能承诺要做的动作。 */
const COMMIT_VERB = /(喊|叫|提醒|说|聊|找你|回你|联系|发你|告诉|给你|问你|看你|催|打电话)/

/** 把「三」「十五」「20」都解析成数字；认不出返回 undefined。 */
export function parseCount(raw) {
  if (raw == null) return undefined
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Number(text)
  // 十 / 十五 / 二十 / 二十三
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text)
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  if (CN_NUM[text] !== undefined) return CN_NUM[text]
  return undefined
}

/**
 * 认出一段文本里表达的「将来某刻」。
 *
 * 只认**明确的相对时间**，不做任何语义猜测：
 *   - 「N 分钟后 / N 个小时后 / N 天后」
 *   - 「等会儿 / 一会儿 / 待会儿 / 晚点 / 回头 / 稍后」（用默认延迟）
 *   - 「明天 / 明早 / 明晚」（用默认延迟）
 * 认不出就返回 undefined —— 宁可漏，不可乱记。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.vagueMinutes] 「等会儿」这类模糊说法折算多少分钟。
 * @param {number} [options.tomorrowMinutes] 「明天」折算多少分钟。
 * @returns {{minutes: number, phrase: string}|undefined}
 */
export function detectFutureTime(text, { vagueMinutes = 10, tomorrowMinutes = 720 } = {}) {
  if (typeof text !== 'string' || !text) return undefined

  // ① 明确的「N 分钟后 / N 小时(个)后 / N 天后」
  const unit = /([0-9]+|[一二两三四五六七八九十]+)\s*(分钟|分|个小时|小时|钟头|天)\s*(?:之后|以后|后)/
  const m = unit.exec(text)
  if (m) {
    // 过去时排除：「三分钟后就走了 / 刚才 / 昨天」说的是已经发生的事，不是承诺。
    // 只看时间点前面那一小段——`三分钟后` 之后的字管不着它的时态。
    const before = text.slice(Math.max(0, m.index - 12), m.index)
    if (PAST_MARKER.test(before)) return undefined
    const n = parseCount(m[1])
    if (Number.isFinite(n) && n > 0) {
      const scale = /天/.test(m[2]) ? 1440 : /(小时|钟头)/.test(m[2]) ? 60 : 1
      const minutes = Math.min(10080, Math.max(1, Math.round(n * scale)))
      return { minutes, phrase: m[0] }
    }
  }

  // ② 模糊的「等会儿」类：只在**同一句里带承诺语气**时才算，
  //    避免把「他等会儿要来」这类纯叙述误判成角色的承诺。
  const vague = /(等会儿|待会儿|一会儿|晚点|稍后|回头)/
  const vagueHit = vague.exec(text)
  if (vagueHit) {
    const before = text.slice(Math.max(0, vagueHit.index - 6), vagueHit.index)
    if (PAST_MARKER.test(before)) return undefined
    if (COMMIT_VERB.test(text)) return { minutes: vagueMinutes, phrase: vagueHit[0] }
  }

  // ③ 「明天」类
  const tomorrow = /(明天|明早|明晚|明儿)/
  const tomorrowHit = tomorrow.exec(text)
  if (tomorrowHit) {
    const before = text.slice(Math.max(0, tomorrowHit.index - 6), tomorrowHit.index)
    if (PAST_MARKER.test(before)) return undefined
    return { minutes: tomorrowMinutes, phrase: tomorrowHit[0] }
  }

  return undefined
}

/**
 * 角色的话里是否有「我待会儿会做某事」的承诺语气。
 * 必须同时有：将来时间点 + 第一人称会做某事的措辞。
 */
const FIRST_PERSON_HINT = /(我|咱)/

/**
 * 判断这一轮回复是否构成一个「该记却可能没记」的承诺。
 *
 * @param {string} text 角色这一轮写出的全部文本。
 * @param {object} [options] 同 {@link detectFutureTime}。
 * @returns {{summary: string, kind: string, minutes: number, phrase: string}|undefined}
 */
export function detectCommitment(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) return undefined
  const time = detectFutureTime(text, options)
  if (!time) return undefined
  // 承诺语气：要么明说「我」，要么直接在祈使/承诺句里出现动作动词。
  if (!COMMIT_VERB.test(text) && !FIRST_PERSON_HINT.test(text)) return undefined
  return {
    summary: summarize(text, time),
    kind: 'promise',
    minutes: time.minutes,
    phrase: time.phrase,
  }
}

/**
 * 把承诺压成一句可读的待办摘要（第一人称）。
 * 取含时间点的那一句；太长就截断——它只是给未来那一刻的提示，不是原文。
 */
function summarize(text, time) {
  const sentences = text.split(/[\n。！？!?]+/).map(s => s.trim()).filter(Boolean)
  const withTime = sentences.find(s => s.includes(time.phrase)) ?? sentences[0] ?? text
  const clipped = withTime.length > 60 ? `${withTime.slice(0, 60)}…` : withTime
  return `答应过对方：${clipped}`
}

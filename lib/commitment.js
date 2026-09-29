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

/**
 * 「见」单独一条规则：`三分钟后见` / `明天见` 是真承诺，
 * 但 `看得见` / `听见` / `不见` / `遇见` / `梦见` 不是（感知或别的意思）。
 * 负向后查找把它们排除掉——`得` 必须在内，否则「看得见」会被当成承诺。
 */
const COMMIT_VERB_MEET = /(?<!看|听|不|梦|遇|想|得)见/

/** 第三人称主语。承诺动词是**她**要做的事，别人要打电话不是她的承诺。 */
const THIRD_PERSON_SUBJECT = /(他|她|他们|她们|别人|人家)/

/** 第一人称（她自己）。 */
const FIRST_PERSON = /(我|咱)/

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
 * 判断这一轮回复是否构成一个「该记却可能没记」的承诺。
 *
 * ## 为什么必须**逐句**判定（线上实例）
 *
 * 老实现把整段正文当一个字符串：只要「明天」出现在某一句、而「我」出现在
 * **另一句**里，就判成承诺——于是两类东西被误记成"她答应过的事"：
 *   - 用户的问句（模型引述对方的话）：「那你明天不上班了，干嘛去」；
 *   - 纯旁白：「那两条消息就那样孤零零地躺在对话框里，等着我明天醒了才看得见」。
 *
 * 它们在线上真的进了待办表（kind=promise），到期后又因为模型那一轮什么都没写
 * 而反复失败。现在改成：**将来时间点与「我 / 承诺动词」必须落在同一句里**，
 * 摘要也只取那一句。
 *
 * @param {string} text 角色这一轮写出的全部文本。
 * @param {object} [options] 同 {@link detectFutureTime}。
 * @returns {{summary: string, kind: string, minutes: number, phrase: string}|undefined}
 */
export function detectCommitment(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) return undefined
  for (const sentence of sentencesOf(text)) {
    const time = detectFutureTime(sentence, options)
    if (!time) continue
    // 承诺语气必须在**同一句**里，且必须是**承诺动词**（含「三分钟后见」）。
    //
    // 为什么不再接受"只要句中有我"：那会把旁白也认成承诺——
    // 「那两条消息就那样孤零零地躺在对话框里，等着我明天醒了才看得见」里
    // 有「我」也有「明天」，但它不是她答应要做的事。承诺的判据应该是
    // 「她答应**做某个动作**」，所以动作动词是必要条件。
    if (!COMMIT_VERB.test(sentence) && !COMMIT_VERB_MEET.test(sentence)) continue
    // 主语是别人时不是她的承诺：「他三分钟后要打电话」只是叙述。
    if (THIRD_PERSON_SUBJECT.test(sentence) && !FIRST_PERSON.test(sentence)) continue
    return {
      summary: `答应过对方：${clip(sentence)}`,
      kind: 'promise',
      minutes: time.minutes,
      phrase: time.phrase,
    }
  }
  return undefined
}

/**
 * 句子切分（与摘要共用一套分隔符）。
 *
 * 为什么连分号也切：中文里「行吧；三分钟后见」这种写法很常见，
 * 不切的话「我」和「三分钟后」又会被算进同一句。
 */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/[\n。！？!?；;]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 把承诺压成一句可读的待办摘要（第一人称）。
 *
 * 只取**含时间点的那一句**；太长就截断——它只是给未来那一刻的提示，不是原文。
 */
function clip(sentence) {
  const text = String(sentence ?? '').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

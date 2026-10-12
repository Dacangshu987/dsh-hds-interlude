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

/**
 * 上游 `interactionPromisesFollowUp` 的**模式集**（「答应稍后给答复」）。
 *
 * ## 为什么要单列一族
 *
 * 这批句子**没有明确时间词**，也没有本仓 `COMMIT_VERB` 里的通讯动词，
 * 但它们确实承诺了「待会儿给你一个答复」——正是最该记的那类承诺
 * （上游把它单独列出来，就是因为通用判据抓不到）。
 *
 * 上游原模式集包含六组：`我先想想` / `我去想想|看看|查查|确认` /
 * `晚点回|说|告诉` / `之后回|说|告诉` / `等我…回|说|告诉` /
 * `整理…回|说|告诉`。本仓照搬这六组（`晚点…` 那组本仓另有更严的判据，
 * 这里重复覆盖不会有害——两处都指向同一个结论）。
 *
 * 与上游的差别：上游由模型给出 `notBefore`（具体时刻），本仓没有这个字段，
 * 因此用配置的 `vagueMinutes`（默认 10 分钟）作为提前量。
 */
const FOLLOW_UP_PROMISE = /我(?:先)?想想|我去(?:想想|看看|查查|确认)|晚点(?:回|说|告诉)|之后(?:回|说|告诉)|等我.{0,12}(?:回|说|告诉)|整理.{0,12}(?:回|说|告诉)/

/**
 * 第三人称主语。承诺动词是**她**要做的事，别人打电话不是她的承诺。
 *
 * 线上事故（2026-10-12，QQ 会话 session-58be9b68）：原判据只认「他/她/别人」，
 * 于是**具名第三人称**的转述全部漏网——「我妈说晚饭晚点吃」「小鹿说晚点回」
 * 都被记成了她自己的承诺。中文叙事里具名转述比代词常见得多。
 */
const THIRD_PERSON_SUBJECT = /(他|她|他们|她们|别人|人家|我妈|我爸|我姐|我哥|我弟|我妹|外婆|奶奶|爷爷|姥姥|姥爷|同事|朋友|室友|王姐|老板|客户)/

/** 转述动词：跟在第三人称主语后面时，说明这句是**引述别人**而不是她在承诺。 */
const REPORTED_SPEECH = /(说|讲|提|问|叫|让|催|告诉|提醒|念叨|嘱咐)/

/**
 * 第三人称转述：`<第三人称> … <转述动词>` 出现在时间词之前。
 *
 * 只看时间词**前面**那一小段——转述动词在时间词后面就是另一回事了
 * （「我跟小鹿说三分钟后喊她」里「说」在前但主语是「我」）。
 */
const THIRD_PERSON_BEFORE = new RegExp(`(?:${THIRD_PERSON_SUBJECT.source})[^。！？\\n]{0,12}(?:${REPORTED_SPEECH.source})`)

/**
 * 完成体：时间词**后面**紧跟「了/过」，说明这是已发生动作的持续时长。
 *
 * 线上事故的同一条：「跟家里**视频了一会儿**」「沙发窝了没**一会儿**」——
 * 「一会儿」在这里是过去时长的度量，不是「等会儿」。
 * 「等会儿我打给你」的「一会儿」后面是「我」，不受影响。
 */
const PERFECTIVE_AFTER = /^\s*(?:都|才|就|没|不|还|已经)?\s*(?:了|过)/

/**
 * 「一会儿」类模糊词的**将来形态**。
 *
 * 判据是：**带将来助词**（等/待/过 + 会儿），或**裸 `一会儿` 后面紧跟她的动作**。
 *
 * 为什么不能只靠「后面有没有『了』」：`没一会儿` 的「了」在 "会儿" 之前，
 * 而 `先歇一会儿再说吧` 里跟的「再」是**当即的动作**、不是"稍后为她做某事"。
 *
 * 为什么不能要求「必须有将来助词」：`等会儿喊你` 的「喊你」就是承诺本身，
 * 「等会儿」已经表明了将来——上一版要求 `晚点/稍后/回头` 必须后接特定动词，
 * 把 `回头喊你` 这类真承诺漏掉了（commitment.test 抓到的回归）。
 */
const VAGUE_FUTURE = /(?:等|待|过)会儿/

/**
 * 「晚点/稍后/回头」的将来语境：这些词本身即可指将来，只要**后面跟着动作**即可。
 *
 * 用「时间词 + 其后 0..6 字内出现通讯动词」判定，而不是要求特定的紧邻组合——
 * `晚点提醒你` / `回头喊你` / `稍后联系你` 都该命中。
 */
const VAGUE_THEN_ACT = /(?:晚点|稍后|回头)[^。！？\n]{0,6}(?:喊|叫|提醒|说|聊|找你|回你|联系|发你|告诉|给你|问你|看你|催|打|见)/

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

  // ② 模糊的「等会儿」类：只在**确实在说将来的事**时才算。
  //
  // 线上事故（2026-10-12）：原判据只要同句出现 COMMIT_VERB 就算，于是
  // 「视频**了一会儿**」「沙发窝了没**一会儿**」这类**已发生动作的时长**
  // 全被当成「等会儿再说」并记成承诺，到期后还把剧情外发。
  //
  // 收紧后的判据（宁可漏，不可乱记）：
  //   ① `一会儿` 必须带将来助词（等/待/过会儿）——裸用的 `一会儿` 几乎总是时长；
  //   ② `晚点/稍后/回头` 必须后接她自己的动作（晚点我打给你 / 回头再说）；
  //   ③ 排除第三人称转述（我妈说…晚点…）与过去时标记。
  const before12 = (idx) => text.slice(Math.max(0, idx - 12), idx)
  const vagueHit = /(等会儿|待会儿|过会儿|一会儿|晚点|稍后|回头)/.exec(text)
  if (vagueHit) {
    const phrase = vagueHit[0]
    const before = before12(vagueHit.index)
    if (PAST_MARKER.test(before)) return undefined
    // ③ 第三人称转述：「我妈说晚饭晚点吃」不是她的承诺。
    if (THIRD_PERSON_BEFORE.test(before)) return undefined
    // ①/② 将来形态。
    //
    //   `一会儿` 家族：`等会儿/待会儿/过会儿`（带将来助词）本身就是将来；
    //     裸 `一会儿` 需要它在**将来语境**里——这里用「后面跟着动作」近似
    //     （已发生的时长后面接的是「，」或另一个叙述分句）。
    //    `晚点/稍后/回头`：后 6 字内出现通讯动作即算（`晚点提醒你` / `回头喊你`）。
    const isFuture = VAGUE_FUTURE.test(text) || VAGUE_THEN_ACT.test(text)
    // 完成体兜底：时间词紧接着「了/过」= 已发生（「晚点了」这类）。
    const after = text.slice(vagueHit.index + phrase.length, vagueHit.index + phrase.length + 4)
    if (PERFECTIVE_AFTER.test(after)) return undefined
    // 承诺动作：通讯动词，或「见」类约定（`等会儿见` 也是真承诺）。
    if (isFuture && (COMMIT_VERB.test(text) || COMMIT_VERB_MEET.test(text))) {
      return { minutes: vagueMinutes, phrase }
    }
  }

  // ③ 「明天」类：将来时无需额外助词，但必须排除**转述 / 元叙述 / 开放性表述**。
  //
  // 「明天要是想说话，随时」是**开放性邀请**、「明天要不要回老家，醒来再说」
  // 是她自己的待定——二者都不是「她答应在明天做某个通讯动作」。
  // 线上实测这两类会积成假承诺（到期后唤起模型，正文被当消息发出去）。
  const tomorrowHit = /(明天|明早|明晚|明儿)/.exec(text)
  if (tomorrowHit) {
    const before = before12(tomorrowHit.index)
    if (PAST_MARKER.test(before)) return undefined
    // 转述（「我妈说明天早上要用」）与元叙述（「这是在回应我说的明天要早睡」）。
    if (THIRD_PERSON_BEFORE.test(before)) return undefined
    if (/(?:回应|回复|说的|说真的|要早睡|那句话|上一?条|消息里)/.test(before)) return undefined
    // 开放性 / 待定表述：条件句（要是/如果/万一）、二选一（要不要/是否）、
    // 以及「随时」「再说」这类不承诺具体动作的收尾。
    const after = text.slice(tomorrowHit.index + tomorrowHit[0].length, tomorrowHit.index + tomorrowHit[0].length + 14)
    if (/^(?:要是|如果|万一|要不要|是否|有没有)/.test(after)) return undefined
    if (/(?:随时|再说|看情况|不一定|醒了再)/.test(text)) return undefined
    return { minutes: tomorrowMinutes, phrase: tomorrowHit[0] }
  }

  // ④ 上游「稍后给答复」模式集（放在最后：只接住前面几条都抓不到的形态）。
  //
  // 这批句子没有明确时间词、也没有通讯动词，但确实承诺了将来的答复——
  // 上游就是因为通用判据抓不到才单列一族。同样的防线照旧：
  // 转述（「他说我去查查」）与过去时（「刚才说之后回你」）都不算。
  const followUpHit = FOLLOW_UP_PROMISE.exec(text)
  if (followUpHit) {
    const before = before12(followUpHit.index)
    if (PAST_MARKER.test(before)) return undefined
    if (THIRD_PERSON_BEFORE.test(before)) return undefined
    // 转述防线（这一族特别需要）：`小鹿…说晚点回` 里「晚点回」紧跟在
    // 「说」之后，是**别人说过的话**。12 字窗口够不到句首的人名，而句中的
    // 「我」（「我回了句…」）又会让主语检查放行——所以这里直接看**紧邻前文**：
    // 以言语动词收尾就是转述。
    if (/(?:说|讲|提|问|叫|让|催|告诉|提醒|念叨|嘱咐)\s*$/.test(before)) return undefined
    return { minutes: vagueMinutes, phrase: followUpHit[0], followUp: true }
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
    //
    // 例外：上游「稍后给答复」那族（`我去查查` / `整理好告诉你`）**自带答复
    // 动词**，本就该算承诺——它们正是因为不带本仓的通讯动词才需要单列，
    // 这里不能再拿 COMMIT_VERB 把它们挡回去。
    const isFollowUpFamily = time.followUp === true
    if (!isFollowUpFamily && !COMMIT_VERB.test(sentence) && !COMMIT_VERB_MEET.test(sentence)) continue
    // 主语是别人时不是她的承诺：「他三分钟后要打电话」只是叙述。
    //
    // 线上事故（2026-10-12）补充：具名第三人称转述（「我妈说明天带我去镇上」）
    // 同样不是她的承诺。判据是「第三人称主语 + 转述动词」，与 detectFutureTime
    // 里的 THIRD_PERSON_BEFORE 同一套——两处必须一致，否则会出现
    // 「时间认得出来、句子里却有别人在说话」的错记。
    if (THIRD_PERSON_BEFORE.test(sentence)) continue
    if (THIRD_PERSON_SUBJECT.test(sentence) && !/(我|咱)/.test(sentence)) continue
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

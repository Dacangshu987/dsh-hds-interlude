/**
 * 故事续写 / 发言判定层的单元测试（lib/story.js）。
 *
 * 这一层是「写故事」与「发消息」分开之后的行为核心：
 *   - 什么算「角色对用户说了话」（整行引语）；
 *   - 什么只算「角色活着」（旁白、动作、场景）；
 *   - 间隔与配额怎么把发言攒下来。
 *
 * 为什么必须单独测：这段逻辑的坏法不抛错——旁白当成台词发出去，用户收到的就是
 * 一条没头没尾的消息（「（下班回来，把包往沙发上一扔）」）；反过来漏判，用户就
 * 什么都收不到。两种都不会在日志里留痕迹。
 *
 * 运行：node test/story.test.mjs
 */

import assert from 'node:assert/strict'

import { decideAdvanceDelivery, extractSpeech, extractQuotedLine, speechContentOf, looksLikeSelfNarration } from '../lib/story.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------ 台词提取 */

console.log('台词提取：什么算「角色对用户说了话」')

check('整行用引号括起来的话 → 是台词', () => {
  assert.deepEqual(extractSpeech('（下班回来，先去阳台看了眼绿萝。）\n\n“在忙吗”'), ['在忙吗'])
})

check('「」和「\"」也算引语（模型用的引号不统一）', () => {
  assert.deepEqual(extractSpeech('「你回来啦」'), ['你回来啦'])
  assert.deepEqual(extractSpeech('"吃饭没"'), ['吃饭没'])
  assert.deepEqual(extractSpeech('『别熬夜』'), ['别熬夜'])
})

check('Markdown 强调包着的引语照样认（**"我到了"**）', () => {
  assert.deepEqual(extractSpeech('**“我到了”**'), ['我到了'])
})

check('连着的几句台词按出现顺序全部取出来', () => {
  const text = '（把伞收起来，甩了甩水。）\n\n“外面好大的雨”\n“你带伞了吗”'
  assert.deepEqual(extractSpeech(text), ['外面好大的雨', '你带伞了吗'])
})

check('旁白、动作、场景都不算台词', () => {
  const text = [
    '（洗完澡把头发擦到半干，坐在床沿刷了会儿手机。）',
    '',
    '外面开始下雨了，窗户没关严。',
    '*她笑了一下*',
    '明天又要早起，先睡了。',
  ].join('\n')
  assert.deepEqual(extractSpeech(text), [], '没有引语就是没有话要说')
})

check('行内旁白后面跟着的引语能取出来（模型常见的混写）', () => {
  assert.deepEqual(extractSpeech('（她笑了一下）“你回来啦”'), ['你回来啦'])
})

check('台词后面接旁白时判成叙事——分不清旁白要不要一起发，宁可不发', () => {
  assert.deepEqual(extractSpeech('“你回来啦”（她笑了一下）'), [])
})

check('代码块里的引语不算（那是引用，不是角色在说话）', () => {
  assert.deepEqual(extractSpeech('```\n"这是引用"\n```'), [])
})

check('只有引号、里面是空的，不算台词', () => {
  assert.deepEqual(extractSpeech('“”'), [])
  assert.deepEqual(extractSpeech('“  ”'), [])
})

check('非文本输入安静返回空，不抛错', () => {
  assert.deepEqual(extractSpeech(undefined), [])
  assert.deepEqual(extractSpeech(''), [])
  assert.deepEqual(extractQuotedLine(null), undefined)
})

check('speechContentOf 剥掉旁白后为空 → 这条其实没话说（判定与投递口径一致）', () => {
  assert.equal(speechContentOf('（她笑了一下）'), '')
  assert.equal(speechContentOf('药吃了没'), '药吃了没')
  // 一致性的关键：im.js 的清洗器怎么判，判定层就怎么判，否则会出现
  // 「判定有话说、发出去却是空的」——投递一条空消息。
  assert.equal(speechContentOf('“今天好冷啊”'), '今天好冷啊')
})

/* ------------------------------------------------------- 发言门控 */

console.log('\n发言门控：什么时候真的发出去')

const base = { text: '“在忙吗”', bound: true, lastMessageAt: 0, messageIntervalMinutes: 120 }

check('说了话 + 有绑定 + 间隔已过 → speak', () => {
  const d = decideAdvanceDelivery({ ...base })
  assert.equal(d.mode, 'speak')
  assert.deepEqual(d.messages, ['在忙吗'])
})

check('没说话（只有旁白）→ story-only，且不占任何额度', () => {
  const d = decideAdvanceDelivery({ ...base, text: '（洗完澡就睡了。）' })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'no-speech')
  assert.deepEqual(d.messages, [])
})

check('没有聊天软件绑定 → story-only（Web 会话没有收件人）', () => {
  const d = decideAdvanceDelivery({ ...base, bound: false })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'no-binding')
})

check('发消息间隔没到 → story-only，台词攒着', () => {
  const now = Date.now()
  const d = decideAdvanceDelivery({ ...base, lastMessageAt: now - 10 * 60_000, now, messageIntervalMinutes: 120 })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'message-interval')
  assert.deepEqual(d.messages, ['在忙吗'], '台词提取出来了，只是不发')
  assert.equal(d.waitedMinutes, 10)
})

check('间隔刚好走完 → speak（边界是 >= 不是 >）', () => {
  const now = Date.now()
  const d = decideAdvanceDelivery({ ...base, lastMessageAt: now - 120 * 60_000, now, messageIntervalMinutes: 120 })
  assert.equal(d.mode, 'speak')
})

check('messageIntervalMinutes=0 → 每轮有话就发（退回到改版前的节奏）', () => {
  const now = Date.now()
  const d = decideAdvanceDelivery({ ...base, lastMessageAt: now - 1000, now, messageIntervalMinutes: 0 })
  assert.equal(d.mode, 'speak')
})

check('每日配额用光 → story-only，台词攒着（不能靠多发把额度刷出来）', () => {
  const d = decideAdvanceDelivery({ ...base, reachedOut: 6, maxPerDay: 6 })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'daily-quota')
})

check('autoMessageEnabled=false → 只写故事（用户明确不想被打扰的那条路）', () => {
  const d = decideAdvanceDelivery({ ...base, autoMessageEnabled: false })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'auto-message-disabled')
})

check('advanceEnabled=false → skip（连故事都不写）', () => {
  const d = decideAdvanceDelivery({ ...base, advanceEnabled: false })
  assert.equal(d.mode, 'skip')
  assert.equal(d.reason, 'advance-disabled')
})

check('门控顺序：先算「有没有话说」，再判发不发', () => {
  // 间隔内 + 没绑定 + 满配额，三种理由都可能成立；但「有没有话说」必须先算出来，
  // 否则面板上分不清「这一轮没说话」和「说了但没发」。
  const d = decideAdvanceDelivery({ ...base, bound: false, reachedOut: 99, maxPerDay: 6, autoMessageEnabled: false })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'auto-message-disabled', '总开关优先于分支理由')
})

check('间隔与配额都不拦 speak 时，绑定是必要条件', () => {
  const withBinding = decideAdvanceDelivery({ ...base, bound: true })
  const without = decideAdvanceDelivery({ ...base, bound: false })
  assert.equal(withBinding.mode, 'speak')
  assert.equal(without.mode, 'story-only')
})

/* ------------------------------------------- 自言自语：思考过程不许当消息发 */

console.log('\n自言自语：模型把思考过程写成正文时不许发出去')

/** 线上 session-xxx turn 33 的原文（被逐字发到了 QQ）。 */
const LEAKED = [
  '用户也没回消息，那就真睡了。不打扰他了，他说打游戏就打游戏吧。',
  '',
  '不用再发消息了，这条就当是安静收尾——毕竟答应了睡，不需要再开口。但系统说"到期待办到期了"，让我自然处理。其实这条待办（i4）记的就是那段话本身，不需要真的再发消息。安静就好。',
  '',
  '不发了。',
].join('\n')

check('线上泄漏原文被拦下', () => {
  const verdict = looksLikeSelfNarration(LEAKED)
  assert.equal(verdict.leak, true, `应当拦下，实际放行：${JSON.stringify(verdict)}`)
})

check('「系统说」「待办」「不发了」这类元叙述被拦下', () => {
  assert.equal(looksLikeSelfNarration('系统说这条待办到期了，我决定不发了，安静就好。').leak, true)
  assert.equal(looksLikeSelfNarration('这条不需要真的再发消息，不用再开口了。').leak, true)
  // 短句也要拦得住：复述提示词里的内部词汇（待办/幕间/提示词）本身就很说明问题，
  // 正常人跟人聊天不会用这些词——这是打分制对短句漏判的补丁。
  assert.equal(looksLikeSelfNarration('用户没回，那我也不发了。待办的事其实已经说过了。').leak, true)
})

check('正常聊天不被误伤（这是最要紧的一半）', () => {
  // 判据保守的理由：这些句子单独看都带「不发消息 / 不打扰」的字样，
  // 但它们是**人话**——拦掉它们等于角色不会说话了。
  const normal = [
    '睡了吗', '水喝了没', '药吃了没', '行，那你早点睡', '不打扰你了', '就这？',
    '我刚下楼买了瓶水', '你今天怎么这么晚还没睡啊', '嗯，知道了',
    '那我不发消息了啊，你别嫌我烦',
    '知道了知道了，手机放下了，真的睡',
  ]
  for (const text of normal) {
    assert.equal(looksLikeSelfNarration(text).leak, false, `不该拦：${JSON.stringify(text)}`)
  }
})

check('空文本 / 非文本安静放过，不抛错', () => {
  assert.equal(looksLikeSelfNarration('').leak, false)
  assert.equal(looksLikeSelfNarration(undefined).leak, false)
  assert.equal(looksLikeSelfNarration('   ').leak, false)
})

check('故事续写路径对同一段原文天然安全（提取不到台词）', () => {
  // 两条路径的防线不同但都成立：这段自言自语里没有引语行，提取为空 → 不发。
  // 现在更早的一道闸（looksLikeSelfNarration）先把它拦掉了，reason 因此是
  // self-narration 而不是 no-speech —— 前者更准确（它确实是在自言自语，
  // 而不是「只是没说台词」）。
  const d = decideAdvanceDelivery({ text: LEAKED, bound: true, lastMessageAt: 0, messageIntervalMinutes: 0 })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'self-narration')
  assert.deepEqual(d.messages, [])
})

check('线上第二次泄漏：思考里的「候选台词」不算台词（2026-09-15 回归）', () => {
  // 这次的形态更隐蔽：模型在思考**里**用引号写了几行候选台词——
  //
  //     我组织一下：
  //     “今天不算，说完就睡”
  //     “你倒管起我来了”
  //
  // extractSpeech 只认「整行引号」，于是把思考里的**候选**当成真台词发出去，
  // 用户在 QQ 里收到两句没头没尾的话。
  //
  // 缺口在于：到点提醒那条路径早就有自言自语闸，故事续写这条没有。
  // 这道闸现在补在 decideAdvanceDelivery 里，两条路径共用。
  const leaked = [
    '用户问“那今天呢”。这是在回应我说的“明天要早睡，说真的”。',
    '',
    '现在是23:00，周二夜间。我（江柚）刚洗完澡躺床上。',
    '',
    '我组织一下：',
    '“今天不算，说完就睡”',
    '“你倒管起我来了”',
  ].join('\n')

  // 前提：extractSpeech 单独看**确实**会把这些引语当台词——这是根因所在，
  // 所以要明确钉住它，免得有人以为 extractSpeech 是安全的。
  assert.deepEqual(extractSpeech(leaked), ['今天不算，说完就睡', '你倒管起我来了'])

  // 但整段判定必须拦住它。
  assert.equal(looksLikeSelfNarration(leaked).leak, true)
  const d = decideAdvanceDelivery({
    text: leaked, bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'self-narration')
  assert.deepEqual(d.messages, [], '思考里的候选台词一个字都不该发出去')
})

check('自言自语闸不误伤正常续写', () => {
  // 最要紧的一半：正常的故事 + 真台词必须照发，否则角色就哑了。
  const normal = [
    '（下班回来，把包往沙发上一扔。）\n\n先浇了水，又泡了碗面。\n\n“在忙吗”',
    '今天下班迟了。\n“你忙你的，看到回”',
    '“青提真留了一半，冰箱里。”',
  ]
  for (const text of normal) {
    const d = decideAdvanceDelivery({
      text, bound: true, lastMessageAt: 0,
      autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
    })
    assert.equal(d.mode, 'speak', `不该拦：${JSON.stringify(text)}（reason=${d.reason}）`)
    assert.ok(d.messages.length > 0, `应当有话可发：${JSON.stringify(text)}`)
  }
})

check('只读核查发现的漏网形态被拦下（打分制对短句的结构性漏洞）', () => {
  // 起因：`命中两处 + 够长` 的打分门槛会把**只命中一处**的真泄漏全放行。
  // 句子越短越干脆，越不容易凑够两处——而自言自语恰恰都是短句。
  const leaked = [
    // 纯旁白：cleanImText 会把整行括号删光，删完就「看起来没内容」，
    // 于是原实现直接 return leak:false，整段旁白被投递出去。
    '（她把手机扣在枕边，翻了个身，想着明天还得早起。）',
    '（她还是没回我。都这个点了，算了。）\n（那就先不说了吧。）',
    // 第一人称的自我宣告：没有听众的「我决定不说了」。
    '我决定不发了。',
    '那我不说了。',
    '我还是不打扰了。',
    // 句首的「用户…」：角色不会管对方叫「用户」。
    '用户一直没回，可能在忙。',
  ]
  for (const text of leaked) {
    assert.equal(looksLikeSelfNarration(text).leak, true, `应当拦下，实际放行：${JSON.stringify(text)}`)
  }
})

check('「系统说」收紧后不再误伤日常用语', () => {
  // 误伤比漏判更疼：静默跳过之后角色直接变哑巴。
  // 「系统」在日常聊天里是常用词（公司系统/健身系统），裸的 /系统说/ 会拦掉人话。
  const normal = [
    '你们那个系统说了算吗',
    '系统说的不算，得王姐点头',
    '公司系统说周末要升级，登不上',
    '我那个健身系统说今天该练腿了',
  ]
  for (const text of normal) {
    assert.equal(looksLikeSelfNarration(text).leak, false, `不该拦：${JSON.stringify(text)}`)
  }
  // 但插件口吻仍然要拦得住。
  assert.equal(looksLikeSelfNarration('系统说这条待办到期了').leak, true)
  assert.equal(looksLikeSelfNarration('系统提示我该开口了').leak, true)
})

check('「对自己宣告不发」不能误伤有听众的正常台词', () => {
  // 分界线是**有没有第二人称**：`我决定不发了。` 没有听众；
  // `那我不发消息了啊，你别嫌我烦` 是在跟人聊天。后者必须放行。
  assert.equal(looksLikeSelfNarration('那我不发消息了啊，你别嫌我烦').leak, false)
  assert.equal(looksLikeSelfNarration('我不打扰你了，你忙吧').leak, false)
  assert.equal(looksLikeSelfNarration('你决定不发就不发呗，我又不催你').leak, false)
  // 单行的短旁白更像「这一轮没话说」，不是自言自语——宁可放过。
  assert.equal(looksLikeSelfNarration('（今天真累啊，不过还行）').leak, false)
})

/* ------------------------------------------------- 从根上分离：interlude_say */

console.log('\n从根上分离：发言走工具，正文只当故事')

check('显式发言优先于正文提取（interlude_say）', () => {
  // 「从根上分离」的主路径：模型调了 interlude_say 时，那几句话就是权威，
  // **不再看正文**。于是正文里写什么（包括思考、列出的候选台词）都不会被误发。
  //
  // 这从根上消除了前两次线上事故：它们都源于「从正文的文本形态猜发言」。
  const bodyWithCandidates = [
    '用户问“那今天呢”。这是在回应我说的“明天要早睡”。',
    '',
    '我组织一下：',
    '“今天不算，说完就睡”',
    '“你倒管起我来了”',
  ].join('\n')

  const d = decideAdvanceDelivery({
    text: bodyWithCandidates,
    explicitSpeech: ['今天不算，说完就睡', '你倒管起我来了'],
    bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  })
  assert.equal(d.mode, 'speak')
  assert.equal(d.reason, 'speak-explicit')
  assert.deepEqual(d.messages, ['今天不算，说完就睡', '你倒管起我来了'])

  // 同样一段正文，没有显式发言时会被自言自语闸拦下——说明分离确实起了作用。
  const without = decideAdvanceDelivery({
    text: bodyWithCandidates,
    bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  })
  assert.equal(without.mode, 'story-only')
  assert.equal(without.reason, 'self-narration')
})

check('显式发言里若写了思考，仍会被自言自语闸拦下', () => {
  // 少见但发生过：模型把思考也塞进了工具参数。闸对显式发言同样生效。
  const d = decideAdvanceDelivery({
    text: '（随便写的故事。）',
    explicitSpeech: ['用户一直没回，那就这样吧。系统说这条待办到期了。'],
    bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  })
  assert.equal(d.mode, 'story-only')
  assert.equal(d.reason, 'self-narration')
})

check('显式发言为空时退回兼容路径（不影响旧行为）', () => {
  const d = decideAdvanceDelivery({
    text: '（下班回来。）\n\n“在忙吗”',
    explicitSpeech: [],
    bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  })
  assert.equal(d.mode, 'speak')
  assert.equal(d.reason, 'speak', '兼容路径的 reason 仍是 speak')
  assert.deepEqual(d.messages, ['在忙吗'])
})

check('显式发言也要过绑定/间隔/配额这些门', () => {
  const base = {
    text: '（故事。）', explicitSpeech: ['在忙吗'],
    bound: true, lastMessageAt: 0,
    autoMessageEnabled: true, advanceEnabled: true, reachedOut: 0, maxPerDay: 6,
  }
  assert.equal(decideAdvanceDelivery({ ...base, bound: false }).reason, 'no-binding')
  assert.equal(decideAdvanceDelivery({ ...base, lastMessageAt: Date.now(), messageIntervalMinutes: 120 }).reason, 'message-interval')
  assert.equal(decideAdvanceDelivery({ ...base, reachedOut: 6 }).reason, 'daily-quota')
  assert.equal(decideAdvanceDelivery({ ...base, autoMessageEnabled: false }).reason, 'auto-message-disabled')
})

console.log(`\n故事续写判定：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)


/**
 * say.js 的行为测试。
 *
 * 这里测的是「什么会被发出去」——本插件存在的理由。
 */
import assert from 'node:assert/strict'

import {
  decide, cleanSayText, looksLikeSelfNarration, speechOfToolCall,
  collectSpeech, DEFAULT_SAY_TOOL,
} from '../../lib/qq-im/say.js'
import * as configModule from '../../lib/qq-im/config.js'

/** 构造一条 tool/call 事件。 */
function toolCall(text, tool = DEFAULT_SAY_TOOL) {
  return { type: 'tool/call', data: { name: tool, arguments: JSON.stringify({ text }) } }
}

/** 构造一条 assistant/message 事件。 */
function assistant(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

/* ------------------------------------------------------------ 工具通道 */

check('工具调用 → 逐行拆条', () => {
  const v = decide({ events: [toolCall('在吗\n今天好累')], sayFallback: 'strict' })
  eq(v.messages, ['在吗', '今天好累'], '两行应当拆成两条')
  eq(v.source, 'tool', '来源应当是工具')
  eq(v.called, true, '应当记录为「调了工具」')
})

check('工具参数里的旁白也会被清掉（第二道防线）', () => {
  const v = decide({ events: [toolCall('（她犹豫了一下）\n在吗')], sayFallback: 'strict' })
  eq(v.messages, ['在吗'], '整行旁白应当被清掉')
})

check('工具参数里剥掉整行外层引号', () => {
  const v = decide({ events: [toolCall('「今天很冷」')], sayFallback: 'strict' })
  eq(v.messages, ['今天很冷'], '外层引号应当剥掉')
})

check('空参数 / 非法 JSON 不产生投递内容，但仍算调过工具', () => {
  const empty = decide({ events: [toolCall('   ')], sayFallback: 'strict' })
  eq(empty.messages, [], '空内容不该发出')
  eq(empty.called, true, '空内容也算调过工具')

  const broken = decide({
    events: [{ type: 'tool/call', data: { name: DEFAULT_SAY_TOOL, arguments: '{不是 JSON' } }],
    sayFallback: 'strict',
  })
  eq(broken.messages, [], '非法 JSON 应当静默丢弃，不猜')
})

check('别的工具调用不算发言', () => {
  eq(speechOfToolCall(toolCall('x', 'interlude_plan'), DEFAULT_SAY_TOOL), [], '非发言工具应当忽略')
  const v = decide({ events: [toolCall('x', 'some_other_tool')], sayFallback: 'strict' })
  eq(v.called, false, '别的工具不算调了发言工具')
})

check('多条工具调用按顺序合并', () => {
  const v = decide({ events: [toolCall('一'), toolCall('二')], sayFallback: 'strict' })
  eq(v.messages, ['一', '二'], '应当按顺序合并')
})

check('collectSpeech 收集全部发言调用', () => {
  eq(collectSpeech([toolCall('a'), assistant('正文'), toolCall('b')]), ['a', 'b'], '应当只收工具内容')
})

/* ------------------------------------------------------------ strict：结构保证 */

check('strict：正文有内容但没调工具 → 什么都不发', () => {
  const v = decide({
    events: [assistant('（她盯着屏幕发呆）\n今天又是一整天会。')],
    assistantText: '（她盯着屏幕发呆）\n今天又是一整天会。',
    sayFallback: 'strict',
  })
  eq(v.messages, [], 'strict 下正文绝不参与投递')
  eq(v.reason, 'no-tool-call', '原因应当是「没调工具」')
  eq(v.leaked, false, 'strict 下结构上不可能泄漏')
})

check('strict：模型把思考写成正文 → 也什么都不发', () => {
  // 这正是线上出过三次事故的形态。
  const thinking = '用户问我吃饭没有。我应该回一句关心的话。让我想想怎么写得自然一点……'
  const v = decide({ events: [assistant(thinking)], assistantText: thinking, sayFallback: 'strict' })
  eq(v.messages, [], '思考写在正文里绝不该发出去')
})

check('strict：思考里用引号列候选台词 → 仍然什么都不发', () => {
  // 事故形态 ②：模型在思考里列候选，被提取误判成真台词。
  const thinking = '候选台词：\n"吃了吗"\n"记得吃饭"\n选哪个好呢'
  const v = decide({ events: [assistant(thinking)], assistantText: thinking, sayFallback: 'strict' })
  eq(v.messages, [], '候选台词绝不该被当成真台词发出')
})

check('strict：正文与工具同时存在 → 只发工具内容', () => {
  const v = decide({
    events: [assistant('（她想了想）\n内心戏一大堆。'), toolCall('刚下班')],
    assistantText: '（她想了想）\n内心戏一大堆。',
    sayFallback: 'strict',
  })
  eq(v.messages, ['刚下班'], '只发工具里的内容，正文一个字都不带')
  eq(v.source, 'tool', '来源应当是工具')
})

/* ------------------------------------------------------------ loose：过渡路径 */

check('loose：无工具时从正文提取', () => {
  const v = decide({
    events: [assistant('（她低头看着手机）\n今天好累啊。')],
    assistantText: '（她低头看着手机）\n今天好累啊。',
    sayFallback: 'loose',
  })
  eq(v.messages, ['今天好累啊。'], 'loose 下应当从正文提取台词')
  eq(v.source, 'loose-text', '来源应当是正文提取')
})

check('loose：自言自语闸拦住思考型正文', () => {
  // 用 hds-interlude 打磨过的判据能确实拦住的形态。
  // （注意：`根据设定我应该…` 这类**不在**它的判据里——那正说明
  //  loose 路径依赖的是一组对形态的猜测，必然有漏网的写法。）
  const v = decide({
    events: [assistant('我决定不发了。')],
    assistantText: '我决定不发了。',
    sayFallback: 'loose',
  })
  eq(v.messages, [], '自述口吻应当被拦下')
  eq(v.leaked, true, '应当记为拦截')
})

check('loose：工具优先于正文', () => {
  const v = decide({
    events: [assistant('（内心戏）'), toolCall('在的')],
    assistantText: '（内心戏）',
    sayFallback: 'loose',
  })
  eq(v.messages, ['在的'], '有工具时用工具，不退回正文提取')
  eq(v.source, 'tool', '来源应当是工具')
})

/* ------------------------------------------------------------ 纯函数细节 */

check('cleanSayText 清旁白/动作/Markdown', () => {
  // 旁白整行删掉；Markdown 只剥标记，**保留文字**（否则会丢字）。
  eq(cleanSayText('【她叹了口气】\n**今天**真的累了。'), '今天真的累了。', '应当清掉旁白并剥掉 Markdown 标记')
  eq(cleanSayText('```\ncode\n```\n在吗'), '在吗', '代码块应当整体丢弃')
})

check('looksLikeSelfNarration 复用 hds-interlude 的判据（合并要点）', () => {
  eq(looksLikeSelfNarration('今天下雨了').leak, false, '普通句子不该被判为自言自语')
  eq(looksLikeSelfNarration('在吗？').leak, false, '短问句不该被判为自言自语')

  // 下面这几条是 hds-interlude 在三次线上事故里打磨出来的判据。
  // 本测试的价值在于：**确认合并后用的确实是那一套**，而不是我另写的一份简化版。
  eq(looksLikeSelfNarration('我决定不发了。').leak, true, '第一人称对自己宣告不发应当命中')
  eq(looksLikeSelfNarration('那我不发消息了啊，你别嫌我烦').leak, false, '有第二人称就说明在跟人说话，应当放过')
  eq(looksLikeSelfNarration('这条不需要真的再发消息').leak, true, '把「要不要开口」当成话题应当命中')
  eq(looksLikeSelfNarration('系统说我该短句回复').leak, true, '复述提示词里的内部词汇应当命中')
  eq(looksLikeSelfNarration('待办里说要提醒他').leak, true, '正文里出现插件内部词汇应当命中')
})

check('对话里的引号由 cleanImText 统一处理（不再单独实现）', () => {
  // 引号剥离是 im.js cleanImText 的职责，say.js 直接复用它。
  // 单独实现一份会与投递前的清洗不一致，导致同一段文本在两处判定不同。
  eq(cleanSayText('"你好"'), '你好', '整行引号应当剥掉')
  eq(cleanSayText('他说"你好"'), '他说"你好"', '行内引号不该动')
})

check('默认策略是 strict（最安全的那一个）', () => {
  const v = decide({ events: [assistant('今天好累')], assistantText: '今天好累' })
  eq(v.messages, [], '不传 sayFallback 时应当按 strict 处理')
})

check('config.js 把写错的策略值当作 strict（配置写错时选安全的那边）', () => {
  const { resolveConfig } = configModule
  eq(resolveConfig({ sayFallback: 'loose' }).sayFallback, 'loose', '显式 loose 应当生效')
  eq(resolveConfig({ sayFallback: 'STRICT' }).sayFallback, 'strict', '大小写不对应当回落 strict')
  eq(resolveConfig({ sayFallback: '随便写的' }).sayFallback, 'strict', '非法值应当回落 strict')
})

console.log(`say.test.mjs：${passed} 项通过`)

/**
 * 长线叙事引导（Long-Horizon Narrative Guidance）纯函数层的用例。
 *
 * ## 这一层为什么值得单独测
 *
 * 它是**累计器 + 判定器**：把「最近发生了多少件有叙事分量的事」折算成一个分数，
 * 再用它决定要不要请长线模型给一段方向性指导。坏起来是**静默**的——
 *   - 资格判宽了：纯技术条目（管理员注记、推进标记、纯分隔符）也计入分数，
 *     于是分数虚高、过早触发；
 *   - 权重判错：群聊证据按私聊权重计，等于**放大了公开场合的权重**，
 *     而上游刻意把群聊压到一半（隐私/关系权重契约）；
 *   - 触发判错：`unknown` 来源给了分（应当保守 0），或复审用的是**总分**
 *     而不是**增量**，于是要么不触发、要么每轮都触发。
 * 三种都不报错，只表现为「她忽然开始往某个方向走」或「永远不动」。
 *
 * 参考实现：上游 `1.0.1-rc50` 的 `src/long-arc.ts`。
 *
 * 运行：node test/long-arc.test.mjs
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_LONG_HORIZON_CONFIG, resolveLongHorizonConfig,
  isEligibleNarrativeEntry, resolveConversationKind, resolveConversationWeight,
  calculateLongHorizonScore, shouldTriggerLongHorizon,
} from '../lib/long-arc.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

const eq = (actual, expected, label) => assert.deepEqual(
  actual, expected,
  `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
)

console.log('长线叙事引导（纯函数层）')

/* ─────────────── A. 配置归一化 ─────────────── */

check('默认配置与上游一致（enabled 默认关）', () => {
  eq(DEFAULT_LONG_HORIZON_CONFIG, {
    enabled: false,
    triggerScore: 25,
    reviewIncrement: 40,
    privateWeight: 1.0,
    groupWeight: 0.5,
    intensity: 'subtle',
    maxActiveGuidance: 1,
  }, '默认值')
  eq(resolveLongHorizonConfig(undefined).enabled, false, '未配置 = 关')
  eq(resolveLongHorizonConfig({}).enabled, false, '空对象 = 关')
  eq(resolveLongHorizonConfig({ enabled: 'yes' }).enabled, false, '非 true 一律当作关')
})

check('权重契约不接受配置覆盖（上游刻意设计）', () => {
  // 上游注释：这是隐私/关系权重契约，即使保留读旧键也绝不让配置削弱或放大它。
  const cfg = resolveLongHorizonConfig({ privateWeight: 99, groupWeight: 99 })
  eq(cfg.privateWeight, 1.0, 'privateWeight 固定 1')
  eq(cfg.groupWeight, 0.5, 'groupWeight 固定 0.5')
  eq(resolveLongHorizonConfig({ maxActiveGuidance: 7 }).maxActiveGuidance, 1, 'active 上限固定 1')
})

check('阈值夹到 10–500，故障值回落默认', () => {
  eq(resolveLongHorizonConfig({ triggerScore: 999 }).triggerScore, 500, '上限 500')
  eq(resolveLongHorizonConfig({ triggerScore: 1 }).triggerScore, 10, '下限 10')
  eq(resolveLongHorizonConfig({ triggerScore: 'x' }).triggerScore, 25, '坏值回默认')
  eq(resolveLongHorizonConfig({ triggerScore: 100 }).triggerScore, 100, '合法值保留')
  eq(resolveLongHorizonConfig({ intensity: 'strong' }).intensity, 'strong', '合法档位')
  eq(resolveLongHorizonConfig({ intensity: 'nope' }).intensity, 'subtle', '坏档位回 subtle')
})

/* ─────────────── B. 有效叙事条目判定（宿主裁决权） ─────────────── */

check('isEligibleNarrativeEntry：白名单 kind + 非空内容才作数', () => {
  for (const kind of ['user-message', 'character-message', 'script', 'world-event']) {
    eq(isEligibleNarrativeEntry({ kind, content: '有内容' }), true, `${kind} 应作数`)
  }
  // 上游表里但本仓暂不产生的 kind：留着以便将来补特性时无需改这里。
  for (const kind of ['character-group-message', 'character-platform-action', 'friend-feed', 'qzone-post']) {
    eq(isEligibleNarrativeEntry({ kind, content: '有内容' }), true, `${kind} 应作数`)
  }
  eq(isEligibleNarrativeEntry({ kind: 'whatever', content: 'x' }), false, '表外 kind 不作数')
  eq(isEligibleNarrativeEntry({ kind: 'script', content: '   ' }), false, '空内容不作数')
  eq(isEligibleNarrativeEntry({ kind: 'script', content: '' }), false, '空串不作数')
  eq(isEligibleNarrativeEntry(null), false, '坏输入安全')
})

check('isEligibleNarrativeEntry：技术性 kind 永远不计入', () => {
  for (const kind of ['system', 'compaction', 'delivery-failure', 'retry', 'technical', 'admin-note', 'advance']) {
    eq(isEligibleNarrativeEntry({ kind, content: '有内容' }), false, `${kind} 不该计入`)
  }
})

check('isEligibleNarrativeEntry：纯格式控制不算叙事证据', () => {
  // 分隔符、空白、省略号、破折号——它们有内容但没有任何叙事分量。
  for (const content of ['<sep/>', '…', '...', '—', '- -', '   \n  ']) {
    eq(isEligibleNarrativeEntry({ kind: 'script', content }), false, `「${content}」不该计入`)
  }
  eq(isEligibleNarrativeEntry({ kind: 'script', content: '她抬头看了一眼。' }), true, '真内容仍作数')
})

/* ─────────────── C. 会话来源解析与权重 ─────────────── */

check('resolveConversationKind：显式标注优先于按 kind 反推', () => {
  eq(resolveConversationKind({ kind: 'script', metadata: { conversationKind: 'group' } }), 'group', '显式标注')
  eq(resolveConversationKind({ kind: 'script', metadata: { conversationKind: 'unknown' } }), 'unknown', '显式 unknown')
  eq(
    resolveConversationKind({ kind: 'script', metadata: { channel: { conversationKind: 'group' } } }),
    'group',
    '通道标注',
  )
  eq(resolveConversationKind({ kind: 'user-message' }), 'private', '按 kind 反推：私聊')
  eq(resolveConversationKind({ kind: 'character-group-message' }), 'group', '按 kind 反推：群聊')
  eq(resolveConversationKind({ kind: 'world-event' }), 'unknown', '推不出就 unknown')
})

check('resolveConversationKind：script 行优先看事件账本（别把群提交算成私聊）', () => {
  const events = (kinds) => ({ metadata: { scriptEvents: kinds.map(kind => ({ kind })) } })
  eq(resolveConversationKind({ kind: 'script', ...events(['group-message']) }), 'group', '只有群事件')
  eq(resolveConversationKind({ kind: 'script', ...events(['outgoing-message']) }), 'private', '只有私聊事件')
  eq(
    resolveConversationKind({ kind: 'script', ...events(['group-message', 'outgoing-message']) }),
    'unknown',
    '两种都有 → 不猜',
  )
  // 旧版 script 行没有事件账本，按约定算私聊。
  eq(resolveConversationKind({ kind: 'script' }), 'private', '无账本按约定')
})

check('resolveConversationWeight：未知来源保守 0 分', () => {
  const cfg = DEFAULT_LONG_HORIZON_CONFIG
  eq(resolveConversationWeight({ kind: 'user-message', content: 'x' }, cfg), 1.0, '私聊满权')
  eq(resolveConversationWeight({ kind: 'character-group-message', content: 'x' }, cfg), 0.5, '群聊半权')
  eq(resolveConversationWeight({ kind: 'world-event', content: 'x' }, cfg), 0, 'unknown → 0')
  eq(resolveConversationWeight({ kind: 'admin-note', content: 'x' }, cfg), 0, '不合格条目不参与')
})

/* ─────────────── D. 加权评分 ─────────────── */

check('calculateLongHorizonScore：私聊满权 + 群聊半权，unknown 只计数不计分', () => {
  const cfg = DEFAULT_LONG_HORIZON_CONFIG
  const score = calculateLongHorizonScore([
    { id: 1, kind: 'user-message', content: '在吗' },
    { id: 2, kind: 'script', content: '她抬头看了一眼' },
    { id: 3, kind: 'character-group-message', content: '群里说了句' },
    { id: 4, kind: 'world-event', content: '楼下开始施工' },
    { id: 5, kind: 'script', content: '<sep/>' },
    { id: 6, kind: 'admin-note', content: '注记' },
  ], cfg)
  eq(score.privateCount, 2, '私聊有效条目数')
  eq(score.privateScore, 2, '私聊得分')
  eq(score.groupCount, 1, '群聊有效条目数')
  eq(score.groupScore, 0.5, '群聊得分')
  eq(score.unknownCount, 1, 'unknown 只计数')
  eq(score.totalScore, 2.5, '总分 = 2 + 0.5（unknown 不计）')
  eq(score.latestEligibleEntryId, 4, '最近一条有效条目的 id（分隔符与注记不算）')
})

check('calculateLongHorizonScore：空输入与坏输入安全', () => {
  const empty = calculateLongHorizonScore([], DEFAULT_LONG_HORIZON_CONFIG)
  eq(empty.totalScore, 0, '空集合 0 分')
  eq(empty.latestEligibleEntryId, 0, '无有效条目 → 0')
  const bad = calculateLongHorizonScore(null, DEFAULT_LONG_HORIZON_CONFIG)
  eq(bad.totalScore, 0, 'null 安全')
  const mixed = calculateLongHorizonScore([null, undefined, 42, { id: 9, kind: 'script', content: '有效' }], DEFAULT_LONG_HORIZON_CONFIG)
  eq(mixed.totalScore, 1, '坏条目被跳过而不是抛错')
  eq(mixed.latestEligibleEntryId, 9, '有效条目仍被计入')
})

/* ─────────────── E. 触发判定 ─────────────── */

const cfgDefault = resolveLongHorizonConfig({ enabled: true })
const scoreOf = (n, kind = 'user-message') =>
  calculateLongHorizonScore(Array.from({ length: n }, (_, i) => ({ id: i + 1, kind, content: 'x' })), cfgDefault)

check('shouldTriggerLongHorizon：无 active 达阈值 → first-trigger', () => {
  // 阈值 25：30 条私聊 = 30 分。
  eq(shouldTriggerLongHorizon(scoreOf(30), undefined, undefined, cfgDefault), { trigger: true, reason: 'first-trigger' }, '首次达标')
  eq(shouldTriggerLongHorizon(scoreOf(24), undefined, undefined, cfgDefault), { trigger: false, reason: 'not-due' }, '差一点不触发')
  eq(shouldTriggerLongHorizon(scoreOf(25), undefined, undefined, cfgDefault), { trigger: true, reason: 'first-trigger' }, '正好达阈值触发')
})

check('shouldTriggerLongHorizon：有 active 时用**增量**而不是总分（review-due）', () => {
  // 30 分，基线 0 → 增量 30 < 40 → 不触发。
  eq(shouldTriggerLongHorizon(scoreOf(30), { status: 'active' }, 0, cfgDefault), { trigger: false, reason: 'not-due' }, '增量不足')
  // 30 分，基线 -10 → 增量 40 ≥ 40 → 触发。
  eq(shouldTriggerLongHorizon(scoreOf(30), { status: 'active' }, -10, cfgDefault), { trigger: true, reason: 'review-due' }, '增量达标')
  // 70 分，基线 30 → 增量 40 → 触发。
  eq(shouldTriggerLongHorizon(scoreOf(70), { status: 'active' }, 30, cfgDefault), { trigger: true, reason: 'review-due' }, '大分数同理')
  // 基线缺失按 0 起算。
  eq(shouldTriggerLongHorizon(scoreOf(70), { status: 'active' }, undefined, cfgDefault), { trigger: true, reason: 'review-due' }, '基线缺失按 0')
})

check('shouldTriggerLongHorizon：active 已失效 → no-active（条件满足即重建）', () => {
  for (const status of ['paused', 'completed', 'expired', 'superseded', 'draft', 'rejected']) {
    eq(
      shouldTriggerLongHorizon(scoreOf(30), { status }, 0, cfgDefault),
      { trigger: true, reason: 'no-active' },
      `${status} 应重建`,
    )
  }
  // 失效但分数不够 → 仍不触发。
  eq(shouldTriggerLongHorizon(scoreOf(3), { status: 'completed' }, 0, cfgDefault), { trigger: false, reason: 'not-due' }, '失效但分不够')
})

check('shouldTriggerLongHorizon：坏输入安全', () => {
  eq(shouldTriggerLongHorizon(null, undefined, undefined, cfgDefault), { trigger: false, reason: 'not-due' }, 'null 分数')
  eq(shouldTriggerLongHorizon(undefined, undefined, undefined, cfgDefault), { trigger: false, reason: 'not-due' }, 'undefined 分数')
  eq(
    shouldTriggerLongHorizon({ totalScore: 'x' }, undefined, undefined, cfgDefault),
    { trigger: false, reason: 'not-due' },
    '非数总分当 0',
  )
})

console.log(`\n长线叙事引导：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

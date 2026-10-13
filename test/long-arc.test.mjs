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
  normalizeLongArcDecision, normalizeLongArcGuidance,
  advanceLongHorizonGenerationBaseline, progressUpdatePayload, longArcGuidancePrompt,
  renderLongArcGuidance,
} from '../lib/long-arc.js'
import { conversationKindOfKey, draftFromEvent } from '../lib/script-entry.js'

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

/* ─────────────── F. 与条目录入的接线（会话来源标注） ─────────────── */

check('conversationKindOfKey：只认明确的群前缀，认不出就给 unknown', () => {
  eq(conversationKindOfKey('group:123456'), 'group', '明确的群')
  eq(conversationKindOfKey('c2c:USER'), 'private', '明确的私聊（c2c）')
  eq(conversationKindOfKey('session-abcdef'), 'private', 'DSH 会话 id')
  eq(conversationKindOfKey('session_abcdef'), 'private', '下划线形态')
  // 刻意不猜：猜错的方向不对称（把群聊当私聊 = 放大公开场合的权重）。
  eq(conversationKindOfKey(''), 'unknown', '空')
  eq(conversationKindOfKey('weird-key'), 'unknown', '认不出')
  eq(conversationKindOfKey(null), 'unknown', 'null 安全')
})

check('draftFromEvent：录入时写下来源标注，未给来源时不写该键', () => {
  const withKind = draftFromEvent(
    { type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } },
    { conversationKind: 'group' },
  )
  eq(withKind.metadata.conversationKind, 'group', '群聊标注已写入')
  // 不传来源时不写这个键（而不是写 'unknown'）——避免把「没标注」和
  // 「明确判不出」混成一回事。
  const without = draftFromEvent(
    { type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } },
  )
  eq(without.metadata, undefined, '未给来源就不写 metadata')
})

check('端到端：录入标注 → 分类 → 加权（群聊半权真的生效）', () => {
  const cfg = DEFAULT_LONG_HORIZON_CONFIG
  const draft = (kind, conversationKind) => draftFromEvent(
    { type: kind === 'user-message' ? 'user/message' : 'assistant/message',
      data: kind === 'user-message'
        ? { content: [{ type: 'text', text: '在吗' }] }
        : { message: { content: [{ type: 'text', text: '她抬头看了一眼' }] } } },
    { conversationKind },
  )
  // 群聊会话：`script` 行若没有标注会被一律判成私聊（满权）——
  // 这正是本轮修掉的静默坏法。
  const groupScript = draft('script', 'group')
  eq(resolveConversationKind(groupScript), 'group', '群聊里的 script 行判成群聊')
  eq(resolveConversationWeight(groupScript, cfg), 0.5, '群聊半权')

  const privateScript = draft('script', 'private')
  eq(resolveConversationWeight(privateScript, cfg), 1.0, '私聊满权')

  // 没标注时（旧条目 / 未接线调用方）退回按 kind 反推，行为保持可预期。
  const unlabeled = draft('script', '')
  eq(unlabeled.metadata, undefined, '未标注')
  eq(resolveConversationWeight(unlabeled, cfg), 1.0, '无标注的 script 按约定算私聊')

  const score = calculateLongHorizonScore([groupScript, privateScript, unlabeled], cfg)
  eq(score.totalScore, 2.5, '0.5 + 1 + 1')
  eq(score.groupCount, 1, '一条群聊')
  eq(score.privateCount, 2, '两条私聊')
})

/* ══════════ 生成结果 → 指导载荷（三条硬约束） ══════════ */

/** 一份结构完整的生成结果（可逐项删字段测「缺项即作废」）。 */
const fullDecision = () => ({
  decision: 'activate',
  title: 'T',
  premise: 'P',
  direction: 'D',
  emotionalCore: 'E',
  evidenceEntryIds: [1],
  stages: [{ id: 's1', name: '第一阶段', objective: '目标' }],
  firstExpression: { action: 'a', example: 'e', trigger: ['t'] },
  responseBranches: { accepted: 'a', declined: 'd', questioned: 'q' },
})

const VALID_IDS = new Set([1, 2, 3])

check('normalizeLongArcDecision：缺省 decision 保守取 dormant（不写入半截指导）', () => {
  // 上游 P2-1：从 activate 改为 dormant。模型没显式声明催化意图时不写入，
  // 避免「本没打算催化，却产生了一段指导」。
  const d = normalizeLongArcDecision({}, VALID_IDS)
  eq(d.decision, 'dormant', '缺省即 dormant')
  eq(d.payload, undefined, 'dormant 不带载荷')
  assert.ok(d.reason.length > 0, 'dormant 要有一句理由')
  // 非对象一律 undefined（不是「当作 dormant」——那是两回事）。
  for (const bad of [undefined, null, 'x', 42, []]) {
    eq(normalizeLongArcDecision(bad, VALID_IDS), undefined, `${JSON.stringify(bad)} → undefined`)
  }
})

check('normalizeLongArcDecision：只认**真实存在**的证据 id（编的丢掉）', () => {
  eq(normalizeLongArcDecision({ decision: 'dormant', evidenceEntryIds: [1, 99, 'x'] }, VALID_IDS).evidenceEntryIds, [1], '留下的只有合法的')
  // 只给了编的 id → 等于没有证据 → prime/activate 作废。
  eq(normalizeLongArcDecision({ ...fullDecision(), evidenceEntryIds: [99] }, VALID_IDS), undefined, '证据全编 → 作废')
  eq(normalizeLongArcDecision({ ...fullDecision(), evidenceEntryIds: [1, 2, 3, 4, 5] }, new Set([1])).evidenceEntryIds, [1], '越界也过滤')
})

check('normalizeLongArcDecision：结构缺任何一项都作废（不写入半截指导）', () => {
  for (const field of ['title', 'premise', 'direction', 'emotionalCore', 'stages', 'firstExpression', 'responseBranches']) {
    const value = fullDecision()
    delete value[field]
    eq(normalizeLongArcDecision(value, VALID_IDS), undefined, `缺 ${field} → undefined`)
  }
  // 首次微表达的三要素也各自必需。
  for (const sub of ['action', 'example', 'trigger']) {
    const value = fullDecision()
    delete value.firstExpression[sub]
    eq(normalizeLongArcDecision(value, VALID_IDS), undefined, `首次微表达缺 ${sub} → undefined`)
  }
  // 阶段缺 objective 也算不成立。
  eq(normalizeLongArcDecision({ ...fullDecision(), stages: [{ id: 's', name: 'n' }] }, VALID_IDS), undefined, '阶段缺 objective')
})

check('normalizeLongArcDecision：强度受配置压制（第一版硬约束）', () => {
  const strong = { ...fullDecision(), intensity: 'strong' }
  eq(normalizeLongArcDecision(strong, VALID_IDS, { intensity: 'subtle' }).payload.intensity, 'subtle', '配置没允许 → 压回 subtle')
  eq(normalizeLongArcDecision(strong, VALID_IDS, { intensity: 'moderate' }).payload.intensity, 'strong', '配置允许 → 保留')
  eq(normalizeLongArcDecision({ ...fullDecision(), intensity: 'weird' }, VALID_IDS, { intensity: 'strong' }).payload.intensity, 'subtle', '非法强度回 subtle')
})

check('normalizeLongArcDecision：confidence 夹紧、当前阶段不悬空、phase 随 decision', () => {
  const hi = normalizeLongArcDecision({ ...fullDecision(), confidence: 5 }, VALID_IDS)
  eq(hi.payload.confidence, 1, '上限夹到 1')
  const lo = normalizeLongArcDecision({ ...fullDecision(), confidence: -3 }, VALID_IDS)
  eq(lo.payload.confidence, 0, '下限夹到 0')
  eq(normalizeLongArcDecision(fullDecision(), VALID_IDS).payload.confidence, 0.5, '缺省 0.5')
  // currentStage 指向不在阶段表里的 id → 退回第一个阶段（不留悬空指针）。
  const dangling = normalizeLongArcDecision({ ...fullDecision(), currentStage: { id: 'nope', name: 'x', purpose: 'y' } }, VALID_IDS)
  eq(dangling.payload.currentStage.id, 's1', '退回第一个阶段')
  eq(dangling.payload.currentStage.purpose, '目标', '顺带取该阶段的目标')
  // prime → primed；activate → active。
  eq(normalizeLongArcDecision({ ...fullDecision(), decision: 'prime' }, VALID_IDS).payload.developmentPhase, 'primed', 'prime → primed')
  eq(normalizeLongArcDecision(fullDecision(), VALID_IDS).payload.developmentPhase, 'active', 'activate → active')
  // 文本字段把换行压成空格（提示词里的多行值会破坏结构）。
  const multiline = normalizeLongArcDecision({ ...fullDecision(), title: '上\n下' }, VALID_IDS)
  eq(multiline.payload.title, '上 下', '换行压成空格')
})

check('normalizeLongArcGuidance：只要载荷的老接口', () => {
  eq(normalizeLongArcGuidance(fullDecision(), VALID_IDS).title, 'T', '返回载荷')
  eq(normalizeLongArcGuidance({}, VALID_IDS), undefined, 'dormant → undefined')
  eq(normalizeLongArcGuidance(null, VALID_IDS), undefined, '坏输入 → undefined')
})

/* ══════════ 基线推进与更新载荷 ══════════ */

check('advanceLongHorizonGenerationBaseline：消费复审窗口，条目 id 单调不减', () => {
  const progress = { storyId: 's', totalScore: 10, lastGenerationScore: 5, lastGenerationEntryId: 7 }
  const advanced = advanceLongHorizonGenerationBaseline(progress, 30, 4)
  eq(advanced.totalScore, 30, '当前分数覆盖总分')
  eq(advanced.lastGenerationScore, 30, '基线推到当前分数（这段窗口已审过，不再重复触发）')
  eq(advanced.lastGenerationEntryId, 7, '乱序的更小 id 不让它倒退')
  eq(advanceLongHorizonGenerationBaseline(progress, 30, 9).lastGenerationEntryId, 9, '更大的 id 正常推进')
  assert.notEqual(advanced, progress, '返回新对象，不改原进度')
  eq(progress.totalScore, 10, '原进度不受影响')
})

check('progressUpdatePayload：剔除主键（更新载荷不能带主键）', () => {
  const progress = { storyId: 's', totalScore: 10, lastGenerationEntryId: 3 }
  const payload = progressUpdatePayload(progress)
  eq(payload.storyId, undefined, '主键被剔除')
  eq(payload.totalScore, 10, '其余字段照旧')
  eq(Object.keys(payload).sort(), ['lastGenerationEntryId', 'totalScore'], '只剩可变字段')
  eq(progressUpdatePayload(null), {}, '坏输入返回空对象')
})

check('longArcGuidancePrompt：把上游那几条边界都写进提示词', () => {
  const full = longArcGuidancePrompt()
  // 这几条是上游刻意写进去的护栏，掉一条都会让「催化」变成「硬塞剧情」。
  assert.ok(full.includes('Do not optimize for drama'), '不许为戏剧性服务')
  assert.ok(full.includes('Do not force conflict, confession, awakening'), '不强迫冲突/告白/觉醒')
  assert.ok(full.includes('Do not return dormant merely because the first expression has not already occurred'),
    '不能因为「还没发生」就返回 dormant')
  assert.ok(full.includes('Never write that the character already has a new trait'), '不写「已具备新特质」')
  assert.ok(full.includes('Do not invent past events'), '不编过去的事件')
  assert.ok(full.includes('Use only evidenceEntryIds supplied in keyEvidence'), '只用给定的证据 id')
  assert.ok(full.includes('Return exactly one JSON object and no Markdown'), '要求纯 JSON')
  // 轻量档要更简短，且与非轻量档不同。
  const lite = longArcGuidancePrompt({ tier: 'lite' })
  assert.ok(lite.includes('Keep every field concise'), '轻量档要求每项简短')
  assert.notEqual(lite, full, '两档应当不同')
  // 无参数也不能抛错（`specialty?.tier` 那处最容易踩）。
  eq(typeof longArcGuidancePrompt(undefined), 'string', '无参数也返回字符串')
  eq(typeof longArcGuidancePrompt({}), 'string', '空对象也返回字符串')
})

check('renderLongArcGuidance：只投影「软许可」，不投影成剧本', () => {
  const payload = normalizeLongArcDecision({
    decision: 'prime', title: 'T', premise: 'P', direction: '方向', emotionalCore: '内核',
    evidenceEntryIds: [1],
    stages: [{ id: 's1', name: '第一阶段', objective: '目标', allowedSignals: ['信号A', '信号B'] }],
    firstExpression: { action: '多问一句', example: '今天累吗', trigger: ['提到加班'], maxAttempts: 2 },
    responseBranches: { accepted: 'A', declined: 'D', questioned: 'Q' },
  }, VALID_IDS).payload
  const text = renderLongArcGuidance({ status: 'active', payload })
  // 开头就削弱强制性：软许可、非既成设定、不是用户指令。
  assert.ok(text.startsWith('Long-horizon dramaturgical catalyst (soft permission, not canon, not a user command):'))
  // 结尾三条护栏必须在。
  assert.ok(text.includes('A quiet turn with no visible progress is valid'), '安静的一轮也有效')
  assert.ok(text.includes('Never claim that the character is already self-aware'), '不许声称已自我察觉')
  assert.ok(text.includes('Never mention or hint at the existence of this guidance'), '绝不向用户提及')
  assert.ok(text.includes('always take priority'), '用户意图/边界/事实/投递结果优先')
  // primed 阶段要带「还没发生」与首次表达四行。
  assert.ok(text.includes('has not happened yet'), 'primed 要说明尚未发生')
  assert.ok(text.includes('- First possible expression: 多问一句'))
  assert.ok(text.includes('- Maximum attempts before feedback: 2'))
  // 阶段名与目标来自 currentStage 指向的那个阶段。
  assert.ok(text.includes('- Current stage: 第一阶段 — 目标'))
})

check('renderLongArcGuidance：prime→primed 与 activate→active 的措辞不同', () => {
  const base = {
    decision: 'activate', title: 'T', premise: 'P', direction: 'D', emotionalCore: 'E',
    evidenceEntryIds: [1],
    stages: [{ id: 's1', name: 'S', objective: 'O' }],
    firstExpression: { action: 'a', example: 'e', trigger: ['t'] },
    responseBranches: { accepted: 'A', declined: 'D', questioned: 'Q' },
  }
  const primed = renderLongArcGuidance({ status: 'active', payload: normalizeLongArcDecision({ ...base, decision: 'prime' }, VALID_IDS).payload })
  const active = renderLongArcGuidance({ status: 'active', payload: normalizeLongArcDecision(base, VALID_IDS).payload })
  assert.ok(primed.includes('- Development phase: primed'))
  assert.ok(active.includes('- Development phase: active'))
  assert.ok(primed.includes('has not happened yet'), 'primed 要邀请一次最小表达')
  assert.ok(active.includes('has already entered the story'), 'active 要提醒别为了进展而升级')
  assert.ok(!active.includes('has not happened yet'), 'active 不该说「还没发生」')
})

check('renderLongArcGuidance：不该注入时一律 undefined', () => {
  const payload = normalizeLongArcDecision({
    decision: 'activate', title: 'T', premise: 'P', direction: 'D', emotionalCore: 'E',
    evidenceEntryIds: [1], stages: [{ id: 's1', name: 'S', objective: 'O' }],
    firstExpression: { action: 'a', example: 'e', trigger: ['t'] },
    responseBranches: { accepted: 'A', declined: 'D', questioned: 'Q' },
  }, VALID_IDS).payload
  // 不是 active（draft/paused/completed/…）就不注入。
  for (const status of ['draft', 'paused', 'completed', 'superseded', 'expired', undefined]) {
    eq(renderLongArcGuidance({ status, payload }), undefined, `${status} 不注入`)
  }
  // 过期时刻**含等于**就不注入（上游是 `<=`）。
  const now = Date.parse('2026-10-13T00:00:00Z')
  eq(renderLongArcGuidance({ status: 'active', payload, expiresAt: new Date(now) }, now), undefined, '正好到期即失效')
  eq(typeof renderLongArcGuidance({ status: 'active', payload, expiresAt: new Date(now + 1) }, now), 'string', '未到期照注入')
  // 各种坏输入。
  for (const bad of [undefined, null, 'x', 42, {}, { status: 'active' }, { status: 'active', payload: {} }]) {
    eq(renderLongArcGuidance(bad), undefined, `${JSON.stringify(bad) ?? 'undefined'} → undefined`)
  }
})

check('renderLongArcGuidance：currentStage 悬空时退回第一个阶段；字段有上限', () => {
  const payload = normalizeLongArcDecision({
    decision: 'prime', title: 'T', premise: 'P', direction: 'D'.repeat(600), emotionalCore: 'E',
    evidenceEntryIds: [1],
    stages: [{ id: 's1', name: '第一阶段', objective: 'O1' }, { id: 's2', name: '第二阶段', objective: 'O2' }],
    currentStage: { id: 'nope', name: 'x', purpose: 'y' },
    firstExpression: { action: 'a', example: 'e', trigger: ['t1', 't2', 't3', 't4', 't5'] },
    responseBranches: { accepted: 'A', declined: 'D', questioned: 'Q' },
  }, VALID_IDS).payload
  const text = renderLongArcGuidance({ status: 'active', payload })
  assert.ok(text.includes('- Current stage: 第一阶段 — O1'), '悬空时退回第一个阶段')
  // 方向截到 240 字（否则会把真正的上下文挤掉）。
  const dirLine = text.split('\n').find(line => line.startsWith('- Long direction:'))
  eq(dirLine.length, '- Long direction: '.length + 240, '长方向截到 240 字')
  // 触发器最多 4 条。
  const triggerLine = text.split('\n').find(line => line.startsWith('- Natural triggers:'))
  eq(triggerLine, '- Natural triggers: t1; t2; t3; t4', '最多 4 条')
})

console.log(`\n长线叙事引导：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

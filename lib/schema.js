/**
 * 配置契约 —— 忠实映射自 hds-interlude 的 Console Schema（src/index.ts 的 Config）。
 *
 * 保留：storyDefaults / runtime（节选）/ schedulePreplan / agency / alterSystem。
 * 剔除：model 提供商中心、onebot、vision、browser(Puppeteer)、chatActions、stickers、group 意愿 ——
 * 这些在 DSH 无对应物（模型由 ctx.llm 提供、输入为 Web/headless、无 IM 通道），
 * 已在 MIGRATION.md 中逐项说明。
 *
 * @module dsh-hds-interlude/schema
 */

import z from '@deepseek-ai/schemastery'

/** 剧本起点：主角、世界、对手戏、剧情。字段名与原项目 StoryDefaults 对齐。 */
export const Story = z.object({
  character: z.object({
    name: z.string().default('Unnamed character').description('主角显示名称。'),
    profile: z.string().role('textarea').default('').description('主角背景、性格、日程、习惯、压力与行为边界。'),
    speech: z.string().role('textarea').default('').description('说话风格与口头习惯。'),
  }).description('人设。'),
  perspective: z.string().role('textarea').default('').description('主角个体价值观 / 看待世界的方式；独立于设定的外壳人格层，随剧情演化，不改写人设。'),
  world: z.object({
    setting: z.string().role('textarea').default('').description('故事时代、地点与现实规则。'),
    location: z.string().default('').description('主角的主要活动地点。'),
    supportingCast: z.string().role('textarea').default('').description('配角及其与主角的关系。'),
  }).description('世界观。'),
  counterpart: z.object({
    profile: z.string().role('textarea').default('').description('默认用户资料；在 DSH 中即对话者背景。'),
    initial: z.string().default('').description('新参与者与主角的默认初始关系。'),
  }).description('对手戏。'),
  plot: z.object({
    startingPoint: z.string().role('textarea').default('').description('剧情起点：当前关系与处境。'),
    style: z.string().role('textarea').default('现实主义日常叙事，情绪克制，关系变化缓慢而具体。').description('故事级叙事文风。'),
    boundaries: z.string().role('textarea').default('').description('禁则与边界。'),
    keywords: z.array(z.string()).default([]).description('用于长期事实检索的关键词。'),
  }).description('剧情。'),
}).description('剧本起点：主角、世界观、对手戏与剧情。')

/** 休息窗口（自动推进低频时段）。 */
const RestWindow = z.object({
  enabled: z.boolean().default(true).description('是否启用该休息窗口。'),
  label: z.string().default('night sleep').description('窗口名称。'),
  start: z.string().default('23:00').description('开始 HH:mm。'),
  end: z.string().default('07:00').description('结束 HH:mm；可跨午夜。'),
  minIntervalMinutes: z.natural().default(120).description('窗口内自动推进最短间隔。'),
  maxIntervalMinutes: z.natural().default(240).description('窗口内自动推进最长间隔。'),
})

/** 对话节奏与自动生活推进（节选，去除打字模拟 / QQ 消息切分 / 群聊）。 */
export const Runtime = z.object({
  roleplayOnly: z.boolean().default(true).description('只对角色会话生效：仅当会话使用角色预设（agentPreset）或被 /interlude on 标记时，才注入幕间块、自动推进与主动联系。'),
  autoAdvanceEnabled: z.boolean().default(true).description('无对话时是否按真实时间补写角色生活（写故事）。'),
  // 「写故事」与「发消息」现在是两件事：续写出来的故事留在 DSH 会话里，是叙事；
  // 只有角色在续写里真的说了要发出去的话，才按「发消息间隔」发到聊天软件。
  autoAdvanceIntervalMinutes: z.natural().min(5).max(1440).default(40).description('写故事间隔：无对话时每隔多少分钟续写一段角色生活（分钟）。这一项只影响 DSH 里的故事，不影响发消息。'),
  autoAdvanceJitterMinutes: z.natural().min(0).max(60).default(5).description('写故事间隔的随机浮动（分钟）。'),
  conversationFollowUpMinutes: z.array(z.natural().min(1).max(240)).default([10, 20]).description('对话结束后额外补写生活的时间点（分钟）。'),
  userMessageDebounceSeconds: z.number().min(0).max(15).default(2).description('短消息合并等待秒数；DSH 中主要影响连续输入的合并。'),
  minimumAdvanceMinutes: z.natural().min(1).max(10080).default(30).description('手动 advance 的最小有效补写间隔。'),
  contextEntryLimit: z.natural().min(1).max(200).default(50).description('近期原始记录最低保留条目数。'),
  contextTimeWindowMinutes: z.natural().min(0).max(1440).default(60).description('额外保留最近多少分钟的真实收发。'),
  memoryLimit: z.natural().min(1).max(200).default(20).description('主叙事读取的长期事实数量。'),
  restWindows: z.array(RestWindow).default([
    { enabled: true, label: 'night sleep', start: '23:00', end: '07:00', minIntervalMinutes: 120, maxIntervalMinutes: 240 },
  ]).description('多个低频推进窗口。'),
})

/** 主动联系边界（DSH 侧对 allowProactiveMessages + 意愿门槛 + 投递的适配）。 */
export const Proactive = z.object({
  enabled: z.boolean().default(true).description('允许宿主在到点时唤起一次主动开口。'),
  checkIntervalMinutes: z.natural().min(1).max(1440).default(5).description('后台检查周期。'),
  graceMinutes: z.natural().min(0).max(1440).default(1).description('到期后再等待多久才主动开口。'),
  maxPerDay: z.natural().min(1).max(100).default(6).description('每个会话每天最多主动联系次数。'),
  duringSleep: z.boolean().default(false).description('是否允许在休息时段主动开口（普通生活型联系）。'),
  // 「三分钟后提醒我喝水」这类事是角色当场答应下来的，不该因为「角色该睡了」被吞掉：
  // 用户还醒着、还在等，承诺就得兑现。只有随性起意的关心才需要遵守休息时段。
  duringSleepPromises: z.boolean().default(true).description('承诺型到期待办（提醒/回访/主动问候/延迟回复）是否豁免休息时段。'),
  // 用户不在聊天时，会话是冷的：没有实时 agent，后台扫描根本扫不到它，
  // 「主动联系」就退化成「只在你刚说完话时才有用」。这里允许把它唤醒。
  wakeIdleSessions: z.boolean().default(true).description('到期待办所属会话不在运行时，是否自动唤醒它以完成主动开口。'),
  // 模型偶尔会「嘴上答应、忘了记」——线上实测过：角色说「三分钟后喊你」，
  // 但没调 interlude_plan，于是三分钟后什么都没发生。这是提示词无法 100% 消除的失败，
  // 所以由插件按角色自己说出口的时间承诺补记一条待办（它兑现的是角色的话，不是新内容）。
  commitmentBackstop: z.boolean().default(true).description('角色答应了将来某刻的事却没记成待办时，自动补记一条，避免漏掉提醒。'),
  vagueCommitmentMinutes: z.natural().min(1).max(1440).default(10).description('「等会儿/晚点」这类模糊承诺折算成多少分钟后。'),
  tomorrowCommitmentMinutes: z.natural().min(1).max(10080).default(720).description('「明天」类承诺折算成多少分钟后。'),
})

export const AlterSystem = z.object({
  enabled: z.boolean().default(true).description('启用情绪偏移追踪（Alter System）。'),
  baseThreshold: z.number().min(1).max(50).default(10).description('Alter 累计绝对值达到此阈值时触发。'),
  densityFactor: z.number().min(0).max(1).default(0.3).description('最近一小时越密集阈值越低；最低不低于一半。'),
  sameDirectionBoost: z.number().min(0).max(1).default(0.05).description('同向时每点 Alter 增加的权重。'),
  oppositeDecay: z.number().min(0).max(1).default(0.15).description('反向时每点 Alter 衰减的权重。'),
  minWeight: z.number().min(0).max(1).default(0.2).description('权重低于此值清除 emotionalOffset。'),
  maxIntensity: z.number().min(1).max(3).default(2).description('情绪偏移强度上限。'),
}).description('情绪偏移追踪：临时氛围惯性。')

export const Agency = z.object({
  enabled: z.boolean().default(true).description('启用主体行动窗口。'),
  maxWindowMinutes: z.natural().min(5).max(1440).default(240).description('一张 Agency Window 最长有效期。'),
  minimumProactiveIntervalMinutes: z.natural().min(0).max(10080).default(60).description('两次普通主动联系安全间隔；承诺型可绕过。'),
  maxCandidateHours: z.natural().min(1).max(168).default(24).description('主动联系候选最长保留时间。'),
}).description('主体行动窗口：日程/隐私/设备容量。')

export const SchedulePreplan = z.object({
  enabled: z.boolean().default(true).description('启用近期日程审查与投影。'),
  horizonDays: z.natural().min(3).max(30).default(14).description('日程保存与展开天数。'),
  variationLevel: z.union(['stable', 'contextual', 'granular']).default('stable').description('变化颗粒度。'),
  candidateActivationProbability: z.number().min(0.05).max(0.5).default(0.25).description('候选变化激活概率。'),
  candidateRevealMinutes: z.natural().min(15).max(360).default(120).description('候选内容提前揭示时间。'),
  reviewAfterLocalHour: z.natural().min(0).max(23).default(3).description('每天从主角本地时间几点起允许空闲审查。'),
  anchorAutoAdvance: z.boolean().default(true).description('固定日程边界作为自动推进锚点。'),
}).description('近期日程层：周规律 + 例外 + 半日投影。')

/** IM 主动投递：把角色的到点开口直投到 IM，并按「真人发消息」的方式分条。 */
export const Im = z.object({
  enabled: z.boolean().default(false).description('启用 IM 主动投递。需先配好 botId + targetId，或对会话执行 /interlude bind。'),
  botId: z.string().default('').description('dsh-im 的 Bot ID（设置 → IM机器人 → 齿轮 → 调用标识）。'),
  targetId: z.string().default('').description('dsh-im 的 Target ID（新建目标时自己定义，保存后不可改）。'),
  autoDiscover: z.boolean().default(true).description('自动从 dsh-im 的已开启「会话双向同步」目标里发现本会话的投递目标，免去手工绑定。'),
  autoMessage: z.boolean().default(true).description('故事续写里角色的发言是否自动发到聊天软件。关掉后只写故事、不打扰用户（到点提醒仍照常送达）。'),
  messageIntervalMinutes: z.natural().min(0).max(1440).default(120).description('发消息间隔：两次「自动发消息」之间至少隔多少分钟（分钟）。写故事不受它限制；到点的提醒/承诺不受它限制。填 0 表示每轮有话就发。'),
  deliverAutoAdvance: z.boolean().default(true).description('兼容开关，等价于 autoMessage（两者都开才会自动发消息）。默认 true，保持与 autoMessage 一致。'),
  waitForTurnMs: z.natural().min(5000).max(600000).default(90000).description('唤起角色后，最多等多久去取它写出的那一段话。'),
  timeoutMs: z.natural().min(1000).max(120000).default(15000).description('单条消息的投递超时。'),
  keepPassive: z.boolean().default(false).description('投递失败时是否额外保留旧的 agent.followup 唤起作为兜底（可能重复发送，默认关）。'),
  chunking: z.object({
    enabled: z.boolean().default(true).description('按句拆成多条短消息发送。'),
    maxChars: z.natural().min(1).max(500).default(40).description('单条目标字数。'),
    maxMessages: z.natural().min(1).max(10).default(4).description('一次最多几条；超出时合并而不是丢弃。'),
    minIntervalMs: z.natural().min(0).max(10000).default(400).description('条与条之间的间隔，避免触发平台限流。'),
  }).description('分条参数。'),
}).description('IM 主动投递。')

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用幕间层。'),
  timeZone: z.string().default('Asia/Shanghai').description('角色所在 IANA 时区。'),
  gapNoticeMinutes: z.natural().min(0).max(1440).default(30).description('距上次互动超过多少分钟才在幕间块里提示「过了多久」。'),
  alwaysReportTime: z.boolean().default(false).description('每回合都注入当前时间，即使没有其它事实。'),
  rules: z.string().role('textarea').default('').description('替换常驻行为规则段；留空使用内置文本。'),
  story: Story,
  runtime: Runtime.description('对话节奏与自动生活推进。'),
  proactive: Proactive.description('主动联系边界。'),
  agency: Agency.description('主体行动窗口。'),
  alterSystem: AlterSystem.description('情绪偏移追踪。'),
  schedulePreplan: SchedulePreplan.description('近期日程层。'),
  im: Im,
})

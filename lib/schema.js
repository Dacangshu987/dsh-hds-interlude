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
  /*
   * 连发同条数守卫（移植自上游 1.0.1-rc18）。
   *
   * 弱模型会把「上一轮发了几条」当成固定形态复刻，且剧本叙述层也会同步固化。
   * 开启后，宿主检测到她最近连续 ≥2 批都以同样条数开口，就在私聊对话回合
   * 注入一段守卫，要求本段不要复刻同样的条数。默认开（与上游一致）。
   */
  repetitionGuard: z.boolean().default(true).description('连发同条数守卫：她最近连续几批都以相同条数开口时，提醒模型别复刻这个形态。'),
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

/**
 * Urge 弹性推进（移植自上游 1.0.0-beta8）。
 *
 * 默认**关闭**：开启后自动推进节奏跟随真实消息热度伸缩，模型可在推进/跟进/
 * 到期回合返回 `urge:{...}` 调度交接（慢速/建议延迟）。只影响「下一次推进的
 * 时机」，不决定是否联系对方、不进记忆。
 */
export const Urge = z.object({
  enabled: z.boolean().default(false).description('启用 Urge 弹性推进：自动推进节奏跟随真实消息热度，而非固定间隔。'),
  frequency: z.union(['low', 'medium', 'high', 'custom']).default('medium').description('热度档位：low 更慢、high 更快；custom 用 advanced 自定义。'),
  proactiveWillingnessThreshold: z.number().min(0).max(1).default(0.4).description('模型意愿达到此值且目标可联系时，武装一次主动联系意图。'),
  advanced: z.object({
    hotMin: z.natural().min(1).max(1440).default(10).description('热络期最短推进间隔（分钟）。'),
    hotMax: z.natural().min(1).max(1440).default(20).description('热络期最长推进间隔（分钟）。'),
    idleMin: z.natural().min(1).max(1440).default(35).description('平淡期最短推进间隔（分钟）。'),
    idleMax: z.natural().min(1).max(1440).default(55).description('平淡期最长推进间隔（分钟）。'),
    burstMin: z.natural().min(1).max(1440).default(3).description('已确认联系爆发期最短间隔（分钟）。'),
    burstMax: z.natural().min(1).max(1440).default(7).description('已确认联系爆发期最长间隔（分钟）。'),
    slowMin: z.natural().min(1).max(1440).default(110).description('慢速（睡眠/专注）最短间隔（分钟）。'),
    slowMax: z.natural().min(1).max(1440).default(130).description('慢速（睡眠/专注）最长间隔（分钟）。'),
    halfLifeMinutes: z.natural().min(5).max(240).default(45).description('热度半衰期（分钟）：事件热度随时间的衰减速度。'),
    burstThreshold: z.number().min(0).max(1).default(0.75).description('模型意愿达到此值且非慢速时进入爆发期。'),
    jitter: z.number().min(0).max(1).default(0.15).description('模型 value 的随机抖动幅度。'),
    extremeChance: z.number().min(0).max(1).default(0.03).description('极值概率：命中时忽略模型 value 用随机值（防模型故意填低/高）。'),
    burstTtlMinutes: z.natural().min(5).max(120).default(35).description('爆发期有效期（分钟）。'),
    burstBudget: z.natural().min(0).max(10).default(3).description('爆发期内的最大联系次数。'),
    burstContactMinMinutes: z.natural().min(1).max(60).default(5).description('爆发期内两次联系的最短间隔（分钟）。'),
  }).default({}).description('自定义档位的详细参数（frequency=custom 时生效）。'),
}).description('Urge 弹性推进：推进节奏随消息热度伸缩。')

/**
 * 时间导演（移植自上游 1.0.0-beta6 ~ 1.0.1-beta1 的时间导演轻量化）。
 *
 * 默认**关闭**：开启后自动推进时会在提示里请求模型输出时间账本 JSON
 * （`<timeline_plan>` 块），解析成功则把账本作为本段时间的权威时间线；
 * 解析失败照常走退避/熔断（`timeline-guard.js`），降级为无账本推进。
 * 账本只是建议，不是既成事实；不做笃定的未来预测。
 */
export const TimelineDirector = z.object({
  enabled: z.boolean().default(false).description('启用时间导演：自动推进时请求模型输出相对时间账本，防止自由散文决定世界时间。'),
}).description('时间导演：自动时间窗的事件账本。')

/**
 * IM 主动投递：把角色的到点开口直投到 IM，并按「真人发消息」的方式分条。
 *
 * 自建通道（`lib/qq-im/`）之后，这里不再依赖 dsh-im：
 *   - 凭据走 DSH 的凭据服务（`secretRef` 是引用名，不是值）；
 *   - 绑定关系由我们自己持有（不再借用 dsh-im 的 sessionSync）。
 */
export const Im = z.object({
  enabled: z.boolean().default(false).description('启用 IM 主动投递。配好 appId + secretRef 即生效。'),
  botId: z.string().default('qq').description('本通道的 bot 标识（日志与状态展示用）。多 Bot 时以 bots 数组为准，此项保留为兼容字段。'),
  appId: z.string().default('').description('QQ 开放平台 AppID。多 Bot 时以 bots 数组为准，此项保留为兼容字段。'),
  secretRef: z.string().role('credential-ref').default('DSH_QQBOT_APP_SECRET').description('AppSecret 的凭据引用（环境变量名），不是值本身。多 Bot 时以 bots 数组为准，此项保留为兼容字段。'),

  /**
   * 多个 QQ 机器人账号（QQ 开放平台每人可申请 5 个）。
   *
   * 与 dsh-im 对齐：`botId` / `secretRef` 由 `appId` 派生（`qq_<sha256前24位>` /
   * `DSH_QQBOT_APP_SECRET_<大写>`），`alias` 只做显示别名。
   * 为空但顶层 `appId` 非空时，宿主自动归一成单条（旧配置兼容）。
   */
  bots: z.array(z.object({
    botId: z.string().default('').description('机器人标识（由 appId 派生，通常无需手填）。'),
    appId: z.string().default('').description('QQ 开放平台 AppID。'),
    secretRef: z.string().role('credential-ref').default('').description('AppSecret 的凭据引用（环境变量名）。留空则由 appId 派生。'),
    alias: z.string().default('').description('显示别名（Q群/私聊里好认）。'),
    agentPreset: z.string().default('').description('该机器人的默认角色预设 id/名：自动新建会话时用它（优先于全局 im.agentPreset）。留空则按绑定里的角色名匹配或回退全局。'),
    cwd: z.string().default('').description('该机器人的会话存放工作区（workspace）。留空继承全局 im.cwd。'),
    whitelist: z.array(z.string()).default([]).description('白名单用户（QQ openid，每行一个）：只有列表内的用户能与该机器人交互；留空 = 不限制。'),
    botCommands: z.boolean().default(true).description('该机器人是否响应 QQ 私聊里的机器人命令（/help /status /new /session /sessionlist）。关闭后该机器人的命令全部按普通消息处理。'),
    // Schemastery 的字段无 default 即可选（无 .optional() 方法）。
    story: Story.description('该机器人的独立人设（per-bot story）：canon 注入与 interlude_state 的主角名用它；不填则继承全局 story。'),
  })).default([]).description('多个 QQ 机器人账号（最多 5 个）：一个机器人绑定一个会话，可新开会话。每个机器人可有独立角色预设与人设。'),

  markdownSupport: z.boolean().default(false).description('机器人是否拥有 markdown 权限；没有就保持 false，否则 QQ 侧渲染失败。'),

  /**
   * 是否把通道注册为 `dshIm` 服务名。
   *
   * **默认关**：本插件自己收发消息不需要这个服务名（内部直接调用通道），
   * 它只是给「外部按 ctx.get('dshIm') 找投递服务」的代码留的兼容出口。
   *
   * Cordis 在服务名被占用时会抛错并带崩整个插件树，所以两个插件都注册
   * `dshIm` 会是一场零和竞速（谁后到谁死）。默认不注册，两个插件就能安全共存。
   * 需要暴露时打开它，并**先停用 dsh-im**。
   */
  exposeService: z.boolean().default(false).description('把通道注册为 dshIm 服务名（供外部消费者使用）。若同时装着 dsh-im，请先停用它。'),

  /**
   * QQ 用户端机器人命令（对齐 dsh-im 的 /new /session /sessionlist /status）：
   * 用户在 QQ 私聊里给机器人发 /help /status /new /session <ID|序号> /sessionlist，
   * 由插件直接处理并回投结果，**不进入模型**。默认开。
   */
  botCommands: z.boolean().default(true).description('是否响应 QQ 私聊里的机器人命令（/help /status /new /session /sessionlist）。'),

  /** 本通道最重要的一个配置：不调工具时发不发。 */
  sayFallback: z.union([z.const('strict'), z.const('loose')]).default('strict')
    .description('strict：模型不调 interlude_say 就什么都不发（思考结构上不可能外泄）；loose：过渡期从正文按引号提取，实测会复现历史上的泄漏事故。'),
  sayTool: z.string().default('interlude_say').description('发言工具名。'),
  imageTool: z.string().default('interlude_send_image').description('发图工具名（表情包/照片）。与 sayTool 一样，只有调用该工具才会把图片送出去。'),
  imagesEnabled: z.boolean().default(true).description('是否允许角色发表情包/图片。关掉后 interlude_send_image 会被忽略，模型即使调了也发不出去。'),
  stickerDir: z.string().default('').description('表情包目录。角色发表情时若只给名字、没给路径，就从这里找；用户发来的表情也会自动存进这里。留空用默认目录 ~/.dsh/media/stickers/。'),
  harvestInbound: z.boolean().default(true).description('把用户发来的图片自动存进表情包目录，供角色之后复用。注意 QQ 的图片地址会过期，关掉后这类图片将无法再被使用。'),
  faceEnabled: z.boolean().default(true).description('QQ 原生表情（[face:14] 这类系统表情）双向适配：收进来翻成中文名给模型看，角色写 [微笑] 也会翻成 QQ 认的标记发出去。'),

  autoCreateSession: z.boolean().default(true).description('收到未绑定会话的 QQ 私聊时，自动新建 DSH 会话并绑定。**默认开启**——这是标准功能，不再在设置面板中暴露；如需关闭，请在 settings.yaml 里显式写 autoCreateSession: false。'),
  agentPreset: z.string().default('').description('自动新建会话时使用的角色预设 id（如「江柚」那个预设）。留空则按绑定里的角色名自动匹配到同名预设；仍匹配不到时不带预设——注意不带角色预设的新会话不会注入人设与发言规则，角色可能不会调用 interlude_say。'),
  cwd: z.string().default('').description('自动新建 QQ 会话的工作目录（workspace）。DSH 的会话列表按 workspace 分组，建在别处的会话不会显示在你当前打开的 workspace 里。留空则跟随你最近活跃会话所在的目录。'),
  migrateLegacyBindings: z.boolean().default(true).description('首次启动时只读迁移 dsh-im 遗留的绑定关系。'),
  inboundPrefix: z.boolean().default(true).description('给注入会话的正文加「来自 QQ」的来源前缀。'),

  botId_legacy: z.string().default('').description('（已废弃）旧 dsh-im 的 Bot ID，仅为兼容旧配置保留。'),
  targetId: z.string().default('').description('（已废弃）旧 dsh-im 的 Target ID，仅为兼容旧配置保留。'),
  autoDiscover: z.boolean().default(true).description('（已废弃）旧 dsh-im 的自动发现开关；自建通道自带绑定表，此项不再生效。'),
  autoMessage: z.boolean().default(true).description('故事续写里角色的发言是否自动发到聊天软件。关掉后只写故事、不打扰用户（到点提醒仍照常送达）。'),
  messageIntervalMinutes: z.natural().min(0).max(1440).default(120).description('发消息间隔：两次「自动发消息」之间至少隔多少分钟（分钟）。写故事不受它限制；到点的提醒/承诺不受它限制。填 0 表示每轮有话就发。'),
  deliverAutoAdvance: z.boolean().default(true).description('兼容开关，等价于 autoMessage（两者都开才会自动发消息）。默认 true，保持与 autoMessage 一致。'),
  waitForTurnMs: z.natural().min(5000).max(600000).default(90000).description('唤起角色后，最多等多久去取它写出的那一段话。'),
  timeoutMs: z.natural().min(1000).max(120000).default(15000).description('单条消息的投递超时。'),
  keepPassive: z.boolean().default(false).description('投递失败时是否额外保留旧的 agent.followup 唤起作为兜底（可能重复发送，默认关）。'),

  /** 去重窗口：SDK 明确警告重连会重复回调同一条消息。 */
  dedupe: z.object({
    ttlMinutes: z.natural().min(1).max(1440).default(10).description('入站消息去重窗口（分钟）。'),
    maxEntries: z.natural().min(10).max(100000).default(2000).description('去重表容量上限。'),
  }).description('入站幂等参数。'),

  /** 交互式回复：DSH 界面里说的话经 interlude_say 回到 QQ。 */
  interactive: z.object({
    enabled: z.boolean().default(true).description('本轮的 interlude_say 是否回到 QQ。'),
    requireInbound: z.boolean().default(true).description('仅当该 QQ 会话发过消息时才回投，避免把 DSH 界面里的对话泄漏到 QQ。'),
    replyWindowMinutes: z.natural().min(1).max(1440).default(30).description('入站消息在此窗口内走被动回复（省主动额度），否则走主动推送。'),
  }).description('交互式回复参数。'),

  /** 主动消息额度（QQ 平台硬限制）。 */
  proactive: z.object({
    maxPerDay: z.natural().min(1).max(200).default(30).description('每天主动消息上限。'),
    minIntervalMinutes: z.natural().min(0).max(1440).default(1).description('两次主动消息之间的最小间隔（分钟）。'),
  }).description('主动消息额度控制。'),

  group: z.object({
    enabled: z.boolean().default(true).description('是否响应群聊消息。**默认开启**——这是标准功能，不再在设置面板中暴露；如需关闭，请在 settings.yaml 里显式写 group.enabled: false。'),
    mentionOnly: z.boolean().default(true).description('群聊只响应 @机器人 的消息（判定对齐 SDK mentionGate：GROUP_AT_MESSAGE_CREATE 事件 / mentions[].is_you / 内容里的 <@!appId>）。关掉后群消息都会进入下面的「发言意愿」判定。'),
    /*
     * 群聊发言意愿与节流（移植自上游 beta10 的 group-willingness + 本地冷却间隔）。
     *
     * 关掉 mentionOnly 后，群里每条消息都会触发一次完整主叙事回合（上万 token）。
     * 这一层是**纯算法判定**（零模型调用）：累积意愿 + 阈值概率决定要不要回，
     * 并用最小回复间隔做硬冷却。被 @ 时强制通过。
     */
    willingness: z.object({
      enabled: z.boolean().default(false).description('启用群聊发言意愿判定：不是每条群消息都回，按累积意愿与概率决定。**关掉 mentionOnly 时建议开启**，否则群里每条消息都会触发角色。'),
      threshold: z.number().min(0).max(10).default(0.24).description('意愿阈值：低于它直接不回。调高 = 更沉默。'),
      probabilityAmplifier: z.number().min(0).max(100).default(1.3).description('概率放大系数：超过阈值后，超出幅度乘以它得到回复概率（上限 100%）。调小 = 更少回复。'),
      decayHalfLifeSeconds: z.natural().min(1).max(86400).default(180).description('意愿半衰期（秒）：群里安静多久后意愿衰减一半。默认 180 秒（3 分钟）。'),
      replyCost: z.number().min(0).max(10).default(0.55).description('每次回复消耗的意愿：说过一次就降温，避免连着抢话。'),
      baseGain: z.number().min(0).max(10).default(0.12).description('每条群消息累积的意愿（按消息条数最多叠加 3 条，边际递减）。'),
      quoteGain: z.number().min(0).max(10).default(0.12).description('有人引用机器人时额外累积的意愿。'),
      keywordGain: z.number().min(0).max(10).default(0.18).description('消息命中关键词时额外累积的意愿。'),
      keywords: z.array(z.string()).default([]).description('关键词列表：消息里出现任意一个就额外累积意愿（比如角色关心的名字、话题）。最多 30 个。'),
      minReplyIntervalSeconds: z.natural().min(0).max(86400).default(0).description('最小回复间隔（秒）：距上次群内发言不足这个时长就不回（被 @ 仍会回）。这就是「多少时间内限制回复」。默认 0 = 不限制；建议 60~300。'),
    }).description('群聊发言意愿：控制角色在群里说话的频率。'),
  }).description('群聊参数。'),

  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info').description('通道日志级别。'),

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
  urge: Urge.description('Urge 弹性推进。'),
  timelineDirector: TimelineDirector.description('时间导演。'),
  im: Im,
})

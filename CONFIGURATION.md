# 配置参考

配置通过 DSH 的三层命名空间生效：**schema 默认值 → `cordis.patch.yml` 的 base → 用户层 `~/.dsh/settings.yaml`**。只落盘用户改过的字段；改完保存，下一次回复生效，无需重启。

顶层命名空间键为插件名 `hds-interlude`。下表中的「默认值」即 schema 出厂默认。

> 设置面板最上方还有一张**只读运行状态卡片**（实时角色会话数 / 待办 / 下次主动开口预计时间 /
> 幕间推进状态 / 开关芯片 / 即将到点），
> 它不写任何配置，数据来自 `GET /api/hds-interlude/status`（该路由只实现 GET）。详见 README。

---

## 1. 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 启用幕间层。 |
| `timeZone` | string | `Asia/Shanghai` | 角色所在 IANA 时区。 |
| `gapNoticeMinutes` | number | `30` | 距上次互动超过多少分钟才在幕间块提示「过了多久」。 |
| `alwaysReportTime` | boolean | `false` | 每回合都注入当前时间，即使没有其它事实。 |
| `rules` | string | `''` | 替换常驻行为规则段；留空用内置文本。 |

---

## 2. `story`（剧本起点）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `story.character.name` | string | `Unnamed character` | 主角显示名称。 |
| `story.character.profile` | text | `''` | 主角背景、性格、日程、习惯、压力与行为边界。 |
| `story.character.speech` | text | `''` | 说话风格与口头习惯。 |
| `story.perspective` | text | `''` | 主角个体价值观 / 看待世界的方式；独立外壳人格层。 |
| `story.world.setting` | text | `''` | 故事时代、地点与现实规则。 |
| `story.world.location` | string | `''` | 主角的主要活动地点。 |
| `story.world.supportingCast` | text | `''` | 配角及其与主角的关系。 |
| `story.counterpart.profile` | text | `''` | 对话者背景。 |
| `story.counterpart.initial` | string | `''` | 新参与者与主角的默认初始关系。 |
| `story.plot.startingPoint` | text | `''` | 剧情起点。 |
| `story.plot.style` | text | `现实主义日常叙事，情绪克制，关系变化缓慢而具体。` | 故事级叙事文风。 |
| `story.plot.boundaries` | text | `''` | 禁则与边界。 |
| `story.plot.keywords` | string[] | `[]` | 长期事实检索关键词。 |

---

## 3. `runtime`（对话节奏与自动生活推进）

**「写故事」与「发消息」是两个节奏。** 续写出来的故事只留在 DSH 会话里（它是叙事，
可以有旁白、动作、场景）；只有角色在续写里**单独成行、用引号整句写出来的那句话**
才会发给用户，并且受下面 `im.messageIntervalMinutes` 限制。详见本节末尾。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `runtime.autoAdvanceEnabled` | boolean | `true` | 无对话时是否按真实时间续写角色生活（**写故事**）。 |
| `runtime.autoAdvanceIntervalMinutes` | number | `40` | **写故事间隔**（分钟）。只影响 DSH 里的故事，不影响发消息。 |
| `runtime.autoAdvanceJitterMinutes` | number | `5` | 写故事间隔随机浮动。 |
| `runtime.minimumAdvanceMinutes` | number | `30` | 手动 `/interlude advance` 的最小有效间隔。 |
| `runtime.memoryLimit` | number | `20` | `/interlude context` 读取的长期事实数量。 |
| `runtime.restWindows[]` | array | `[{enabled,label:'night sleep',start:'23:00',end:'07:00',minIntervalMinutes:120,maxIntervalMinutes:240}]` | 低频推进窗口，可跨午夜。 |

> ⚠️ **声明但 v0.1 未接线**：`runtime.conversationFollowUpMinutes`（对话后续补写时间点）、`runtime.userMessageDebounceSeconds`、`runtime.contextEntryLimit`、`runtime.contextTimeWindowMinutes`。这些字段保留在 schema 中以对齐原项目 Runtime 面，但当前实现把「对话后续」并入自动推进，消息合并交给 dsh 输入层，脚本条目折叠只做时序、不做条目预算。见 `MIGRATION.md` 差异 6。

### 写故事 / 发消息为什么必须分开

改版前「自动生活推进」只有一个动作：唤起角色 → 把它写的那一整段**直接投递**到聊天软件。
于是每 40 分钟，用户的聊天窗口里就会多出一条消息——而它多半只是一段独白
（「下午两点半才醒的……」）。两条路各自都很糟：

- **关掉投递**（`im.deliverAutoAdvance=false`）：消息不发了，但角色的话也彻底消失，
  它等于在对着空气说话（线上 session-xxx 第 7 轮）；
- **关掉整层**（`runtime.autoAdvanceEnabled=false`）：连「生活在继续」这件本来的事也没了。

现在拆成三件独立的事，各自有各自的开关：

| 想要的效果 | 怎么配 |
| --- | --- |
| 故事照写，基本不打扰（默认） | 写故事 40 分钟；发消息 120 分钟 |
| 故事更连续，消息也更勤 | 把发消息间隔调小（填 `0` = 每轮有话就发，等于改版前的节奏） |
| 只写故事，一条都不发 | 关掉 `im.autoMessage`（到点的提醒/承诺**仍然照常送达**） |
| 想收到短消息，但不要旁白 | 不用配——这是默认行为，旁白永远不会被发出去 |

### 什么算「角色说了话」

判定是**确定性的**，不依赖模型记得调用某个工具（见下一节「承诺兜底」为什么不能靠提示词）：

- **算**：单独成行、整句用引号括起来——`“在忙吗”`、`「你回来啦」`、`**"我到了"**`；
- **不算**：旁白、动作、场景、独白——`（下班回来，把包往沙发上一扔）`、`外面开始下雨了`；
- **不算**：引语后面还接着旁白的行（分不清旁白要不要一起发，宁可不发）。

判定通过后才交给 `im.js` 清洗分条，所以「判定有话说、发出去却是空的」不会发生——
两条路径共用同一个清洗器（`test/story.test.mjs` 专门钉住这个一致性）。

角色说什么、写多少，由模型决定；插件只负责**发不发、发哪几句**。这一层是纯函数
（`lib/story.js`），有 22 条单元测试 + 3 组承重验证（`test/verify-story-split-loadbearing.mjs`）。

---

## 4. `proactive`（主动联系边界）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `proactive.enabled` | boolean | `true` | 允许宿主在到点时唤起主动开口。 |
| `proactive.checkIntervalMinutes` | number | `5` | 后台扫描周期（兜底；到点时刻另有精确定时器）。 |
| `proactive.graceMinutes` | number | `1` | 到期后再等待多久才主动开口。 |
| `proactive.maxPerDay` | number | `6` | 每会话每天最多主动联系次数（按角色本地日重置）。 |
| `proactive.duringSleep` | boolean | `false` | 是否允许在休息时段主动开口（普通生活型联系）。 |
| `proactive.duringSleepPromises` | boolean | `true` | 承诺型到期待办（提醒/回访/主动问候/延迟回复）是否豁免休息时段。 |
| `proactive.wakeIdleSessions` | boolean | `true` | 到期待办所属会话不在运行时，是否自动唤醒它以完成主动开口。 |
| `proactive.commitmentBackstop` | boolean | `true` | 角色答应了将来某刻的事却没记成待办时，自动补记一条。 |
| `proactive.vagueCommitmentMinutes` | number | `10` | 「等会儿 / 晚点」这类模糊承诺折算成多少分钟后。 |
| `proactive.tomorrowCommitmentMinutes` | number | `720` | 「明天」类承诺折算成多少分钟后。 |

### 承诺兜底（为什么不能只靠提示词）

**「到点主动回复」需要先有一条待办。** 待办由 `interlude_plan` 工具写入，而是否调用
工具取决于模型——这件事没法 100% 保证。

线上实测就坏在这里（session-xxx）：

```text
用户：三分钟后提醒我喝水
角色：行 / 三分钟后喊你 / 你先回我，是不是又没喝水
```

听着完全合理，但角色**没有调用 `interlude_plan`**。核查确认 6 个 `interlude_*`
工具当时全都暴露给了模型（`request/header` 里在），规则段也写了「务必调用」——
模型仍然漏了。于是三分钟后什么都没发生；直到用户自己又发了一句「哎」，
角色才顺口问「水喝了吗」。

结论：**能不能按时提醒，不能押在「模型每次都记得调工具」上。**
`commitmentBackstop` 因此在插件侧做确定性兜底：

- 触发条件很窄——这一步**没有**任何 plan 类工具调用，而回复里又出现了将来的时间承诺；
- 只认明确的相对时间（`N 分钟后 / 小时后 / 天后`、`等会儿`、`明天`），
  且排除过去时（`昨天我三分钟后就走了`）与纯叙述（`他等会儿要来`）；
- 补记的是**角色自己说出口的话**（`答应过对方：三分钟后喊你`），不是插件编的新内容；
- 静默进行：不注入提示、不改写角色的下一句、用户侧看不到系统痕迹；
- 同一件事只记一次——角色常说两遍（`三分钟后喊你` → `行吧，三分钟后见`），
  同类型且到点时间相差 2 分钟内的算同一件。

补记后的待办与手工记的走**完全同一条路**：同样挂精确定时器、同样受配额与休息时段约束。

### 到点唤醒是怎么发生的

`interlude_plan` 记下待办时会按**精确到点时间**挂一个一次性定时器，周期扫描只作兜底。
两点必须一起看：

- **定时器要带 `graceMinutes`**。判定条件是 `now - dueAt >= graceMinutes`，
  定时器若卡在 `dueAt` 准点触发，那一刻宽限还没走完，这次唤醒会空转，
  然后再等一整个扫描周期——「一分钟后提醒」就变成了六分钟后。
- **周期扫描要能看见「冷会话」**。用户不说话时那个会话没有实时 agent；
  只遍历活跃会话会让主动联系退化成「只在你刚说完话之后才有用」。
  扫描因此会遍历磁盘上的会话状态（`$DSH_HOME/hds-interlude/session-*.json`），
  必要时用 `sessionController.resolveAgent()` 把会话唤醒。

同一会话同时只允许一次扫描（`inFlight` 互斥）：一次 IM 投递要等捕获窗口
（默认 90 秒），而冷会话恢复要几百毫秒，重叠窗口里两条扫描会读到同一份
`pending` 状态、把同一件事说两遍。

---

## 5. `agency`（主体行动窗口）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `agency.enabled` | boolean | `true` | 启用行动窗口。 |
| `agency.maxWindowMinutes` | number | `240` | 一张窗口最长有效期。 |
| `agency.minimumProactiveIntervalMinutes` | number | `60` | 两次普通主动联系安全间隔；承诺型可绕过。 |
| `agency.maxCandidateHours` | number | `24` | 主动联系候选最长保留时间。 |

---

## 6. `alterSystem`（情绪偏移追踪）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `alterSystem.enabled` | boolean | `true` | 启用 Alter System。 |
| `alterSystem.baseThreshold` | number | `10` | 累计绝对值达到此值触发。 |
| `alterSystem.densityFactor` | number | `0.3` | 最近一小时越密集阈值越低（最低不低于一半）。 |
| `alterSystem.sameDirectionBoost` | number | `0.05` | 同向时每点 Alter 增加的权重。 |
| `alterSystem.oppositeDecay` | number | `0.15` | 反向时每点 Alter 衰减的权重。 |
| `alterSystem.minWeight` | number | `0.2` | 权重低于此值清除 emotionalOffset。 |
| `alterSystem.maxIntensity` | number | `2` | 情绪偏移强度上限。 |

---

## 7. `schedulePreplan`（近期日程）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `schedulePreplan.enabled` | boolean | `true` | 启用近期日程审查与投影。 |
| `schedulePreplan.horizonDays` | number | `14` | 日程保存与展开天数。 |
| `schedulePreplan.variationLevel` | enum | `stable` | `stable` / `contextual` / `granular`。 |
| `schedulePreplan.candidateActivationProbability` | number | `0.25` | 候选变化激活概率。 |
| `schedulePreplan.candidateRevealMinutes` | number | `120` | 候选内容提前揭示时间。 |
| `schedulePreplan.reviewAfterLocalHour` | number | `3` | 每天从主角本地时间几点起允许空闲审查。 |
| `schedulePreplan.anchorAutoAdvance` | boolean | `true` | 固定日程边界作为自动推进锚点。 |

---

## 7.5 `urge`（Urge 弹性推进）

> 移植自上游 1.0.0-beta8。默认**关闭**——开启前自动推进是固定间隔，行为零变化。
> 开启后推进节奏跟随**真实消息热度**：刚聊完时下一次推进快一些，冷下来逐步变慢；
> 模型还可以在推进/跟进/到期回合的正文末尾返回 `urge:{...}` 调度交接
> （`value` 意愿 / `pace:"slow"` 慢速 / `suggestedDelayMinutes` 建议延迟 /
> `basisQuote` 必须逐字命中正文的引文），被采纳后影响**下一次**推进的时机。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `urge.enabled` | boolean | `false` | 启用 Urge 弹性推进。 |
| `urge.frequency` | enum | `medium` | `low`（更慢）/ `medium` / `high`（更快）/ `custom`（用 advanced 自定义）。 |
| `urge.proactiveWillingnessThreshold` | number | `0.4` | 模型意愿达到此值且目标可联系时，武装一次主动联系意图。 |
| `urge.advanced.hotMin/hotMax` | number | `10/20` | 热络期推进间隔范围（分钟）。 |
| `urge.advanced.idleMin/idleMax` | number | `35/55` | 平淡期推进间隔范围（分钟）。 |
| `urge.advanced.burstMin/burstMax` | number | `3/7` | 已确认联系爆发期间隔范围（分钟）。 |
| `urge.advanced.slowMin/slowMax` | number | `110/130` | 慢速（睡眠/专注）间隔范围（分钟）。 |
| `urge.advanced.halfLifeMinutes` | number | `45` | 热度半衰期（分钟）。 |
| `urge.advanced.burstThreshold` | number | `0.75` | 意愿达到此值且非慢速进入爆发期。 |
| `urge.advanced.jitter` | number | `0.15` | 模型 value 的随机抖动。 |
| `urge.advanced.extremeChance` | number | `0.03` | 极值概率（忽略模型 value 用随机值，防模型故意填低/高）。 |
| `urge.advanced.burstTtlMinutes` | number | `35` | 爆发期有效期（分钟）。 |
| `urge.advanced.burstBudget` | number | `3` | 爆发期内最大联系次数。 |
| `urge.advanced.burstContactMinMinutes` | number | `5` | 爆发期内两次联系最短间隔（分钟）。 |

> Urge 只决定**下一次推进的时机**，绝不直接决定是否联系对方、也不进记忆——
> 联系决策仍由 Agency 窗口与到期待办负责（与上游定位一致）。

---

## 7.6 `timelineDirector`（时间导演）

> 移植自上游 beta6 ~ 1.0.1-beta1 的时间导演轻量化。默认**关闭**。
> 开启后，自动生活推进时插件会在提示里请求模型输出一段相对时间账本
> （`<timeline_plan>{...}</timeline_plan>` JSON 块：1–4 个 `{at, kind, summary}` 节点
> + 可选的 carry）。解析成功则账本成为本段时间的**权威时间线**（`state.timelinePlan`，
> carry 并入时间线承载），正文里的账本块被剥离、不污染故事；解析失败照常走
> timeline-guard 的退避/熔断，降级为无账本推进。账本是**建议**不是既成事实，
> 不做笃定的未来预测（与上游语义一致）。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `timelineDirector.enabled` | boolean | `false` | 启用时间导演：自动推进时请求模型输出相对时间账本。 |

---

## 8. `im`（聊天软件通道）

> **可视化面板已覆盖本节大部分字段**：设置 → 幕间系统 → **「聊天」Tab**。
> 面板是四分区结构：**故事**（人设/关系/世界/剧情）、**节奏**（时间/消息节奏/功能开关）、
> **聊天**（连接状态 + QQ 通道 + 高级选项 + 消息行为）、**预设**（导出）。
> 「聊天」Tab 里：顶部是**连接状态**（已连/未连、原因、绑定与收发统计），
> 下面可填通道开关、AppID、凭据引用名、Bot 标识；**降级策略、额度、分条参数
> 收在「高级选项」里**（默认折叠）；再往下是消息行为开关。
> 下面的表格是字段的完整语义；面板未暴露的字段（如 `migrateLegacyBindings`、
> `exposeService`，以及已改为标准功能、只保留配置文件退路的
> `autoCreateSession`、`group.enabled`）只能写配置文件。
>
> **标准功能（面板不再显示）**：以下两项是默认行为，面板里没有开关——
>
> - **收到未绑定的 QQ 私聊时自动新建会话并绑定**（`autoCreateSession`，默认 `true`）
> - **响应群聊消息**（`group.enabled`，默认 `true`；需 QQ 开放平台开通群聊权限；一个群共用一个角色会话）
>
> 它们仍可在 `settings.yaml` 里显式关闭（写 `false`）。面板保存时**不会**覆盖这两项——
> 未显示即不下发，配置沿用你写在文件里的值或 schema 默认值。

### 8.1 通道与凭据

> **扫码绑定**（与 dsh-im 对齐）：设置 → 幕间系统 → 「聊天」Tab → 「扫码绑定」——
> 手机 QQ 扫一下腾讯官方授权页，AppID 与 AppSecret **自动写入本机凭据服务**，
> 免去手动去开放平台创建再把密钥贴进来的流程。扫码成功后插件自动更新
> `im.appId` / `im.enabled` 并重连通道。扫码轮询由插件进程内的
> `@tencent-connect/qqbot-connector` 完成，二维码约 2–5 分钟有效、过期自动刷新。
>
> 依赖（可选）：`@tencent-connect/qqbot-connector`（扫码）、`qrcode`（二维码图片）。
> 未安装时「扫码绑定」会明确提示组件不可用，不影响手动填写。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.enabled` | boolean | `false` | 启用 QQ 通道。配好 `appId` + `secretRef` 后打开即生效。 |
| `im.appId` | string | `''` | QQ 开放平台 AppID。扫码绑定后自动填入。 |
| `im.secretRef` | string | `DSH_QQBOT_APP_SECRET` | AppSecret 的**凭据引用**（环境变量名），**不是值本身**。扫码绑定后 AppSecret 写入该名字。 |
| `im.botId` | string | `qq` | 本通道标识，用于日志与状态展示。 |
| `im.agentPreset` | string | `''` | 自动新建 QQ 会话时使用的**角色预设 id**。留空则按绑定里的角色名自动匹配同名预设。**没预设的新会话不会注入人设与发言规则，模型不会调 `interlude_say`，于是「收得到消息却永远不回复」**——所以这条很关键。 |
| `im.cwd` | string | `''` | 自动新建 QQ 会话的**工作目录（workspace）**。DSH 会话列表按 workspace 分组，建在别处的会话不会显示在你当前打开的 workspace 里。留空则跟随最近活跃会话的目录；再拿不到才用宿主默认目录（会记一条警告）。 |
| `im.markdownSupport` | boolean | `false` | 机器人是否有 markdown 权限。没有就保持 `false`，否则 QQ 侧渲染失败。 |
| `im.exposeService` | boolean | `false` | 把通道注册为 `dshIm` 服务名（供外部消费者用）。**默认关**——见下。 |
| `im.logLevel` | enum | `info` | 通道日志级别。 |

#### `im.exposeService` 为什么默认关

本插件自己收发消息**不需要** `dshIm` 这个名字：收靠通道自己的入站监听，
发靠 `deliverToIm` 直接调用通道。那个名字只是给「外部按 `ctx.get('dshIm')`
找投递服务」的旧代码留的兼容出口。

而 Cordis 的 `provide` 在服务名被占用时**直接抛错**，且会带崩整个插件树：

```
service "dshIm" has been registered at <hds-interlude>
→ 插件树加载失败 → 进程退出
```

两个插件都注册就变成一场**零和竞速：谁后到谁死**。本插件是**后装的那个**，
本该让位——所以默认根本不参与这场竞速，两者可以安全共存。

确实需要暴露时打开它，并**先停用 dsh-im**（否则按上面的规则总有一方会崩）。

凭据的值通过 DSH 的凭据服务解析，**不缓存在内存里**——轮换后下一个操作即生效。
解析顺序：进程环境变量 > `$DSH_HOME/.credentials.yaml` > `.env`。

### 8.2 发言判定（**本插件最重要的一项**）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.sayFallback` | `strict`\|`loose` | `strict` | 见下。 |
| `im.sayTool` | string | `interlude_say` | 发言工具名。 |

**`strict`（默认）**：模型没调用 `interlude_say` → **什么都不发**。
正文（故事 / 旁白 / 思考）**从不进入投递链路**，所以泄漏是**结构上不可能**的，
而不是「判据拦住了」。

代价：模型忘记调工具时角色会静默。这是**可观测、可度量**的——
用 `/interlude im` 看工具调用统计。

**`loose`（过渡期）**：没有工具调用时，退回从正文按「整行引号」提取，
再过一道自言自语闸。它让判据重新回到链路上，**只应该短期使用**。

> 交互式回复路径**不受 `sayFallback` 影响**：它只消费 `interlude_say`，
> 因为那时有用户在等着，模型不调工具就是「这一轮不说」，不该由插件代猜。

### 8.3 入站

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.autoCreateSession` | boolean | `true` | 未绑定会话收到私聊时，自动新建 DSH 会话并绑定。**标准功能，面板不显示**；要关只能写配置文件。 |
| `im.migrateLegacyBindings` | boolean | `true` | 首次启动时**只读**迁移 dsh-im 遗留的绑定关系。 |
| `im.inboundPrefix` | boolean | `true` | 给注入正文加来源前缀（「来自 QQ」/「来自 QQ 群」）。 |
| `im.group.enabled` | boolean | `true` | 是否响应群聊消息。**标准功能，面板不显示**（需 QQ 开放平台开通群聊权限）；要关只能写配置文件。**一个群共用一个角色会话**。 |
| `im.group.mentionOnly` | boolean | `true` | 群聊只响应 **@机器人** 的消息（判定对齐 QQ 平台：`GROUP_AT_MESSAGE_CREATE` 事件 / `mentions[].is_you` / 内容里的 `<@!appId>`）。关掉后群里每条消息都会触发角色，很吵。**此项仍在面板中可改。** |
| `im.dedupe.ttlMinutes` | number | `10` | 入站去重窗口。 |
| `im.dedupe.maxEntries` | number | `2000` | 去重表容量上限。 |

> **QQ 群聊适配要点**：群聊支持**默认开启**（`group.enabled` 默认 `true`，标准功能），
> 群消息以 `group:<群 openid>` 作为会话键，
> 一个群一个角色会话，群成员共用这个角色；被 @ 的消息会路由进去（`mentionOnly` 门控），
> 回复走群内被动回复（引用原消息）。机器人命令（`/presetlist` 等）仍仅私聊可用。
> 注意群聊需要 QQ 开放平台为机器人开通群聊相关权限，否则 SDK 收不到群事件；
> 未开通权限时群聊功能静默不生效，私聊不受影响。
>
> 「被 @」的判定依次是：`GROUP_AT_MESSAGE_CREATE` 事件 → `mentions[].is_you` →
> 内容里的 `<@!appId>` → **内容以「@角色名」开头**（角色名取绑定 name / bot 别名 /
> bot 人设名——所以群里发「@江柚 你好」也能触发，即使那只是纯文本不是真提及）。

> **为什么要去重**：腾讯 SDK 明确警告「重连可能导致同一条消息重复回调」。
> 不按 `messageId` 幂等的话，网络抖一次用户就会看到角色把同一句话回两遍。

### 8.4 出站与交互式回复

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.interactive.enabled` | boolean | `true` | 本轮的 `interlude_say` 是否回到 QQ。 |
| `im.interactive.requireInbound` | boolean | `true` | 仅当该 QQ 会话发过消息时才回投。 |
| `im.interactive.replyWindowMinutes` | number | `30` | 入站消息在此窗口内走**被动回复**（省主动额度）。 |
| `im.proactive.maxPerDay` | number | `30` | 每天主动消息上限（QQ 平台硬限制）。 |
| `im.proactive.minIntervalMinutes` | number | `1` | 两次主动消息之间的最小间隔。 |
| `im.timeoutMs` | number | `15000` | 单条消息投递超时。 |
| `im.chunking.enabled` | boolean | `true` | 按真人发消息的方式分条。 |
| `im.chunking.maxChars` | number | `40` | 单条最大字数。 |
| `im.chunking.maxMessages` | number | `4` | 一次最多分几条（超出合并，**不丢内容**）。 |
| `im.chunking.minIntervalMs` | number | `400` | 两条之间的间隔。 |

> **`requireInbound` 为什么要开**：不开的话，你在 DSH 界面里跟角色的私聊
> 会被莫名其妙发到 QQ。开着它就只在「对话确实发生在 QQ 里」时回投。

### 8.5 故事节奏（与既有行为一致）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.autoMessage` | boolean | `true` | 故事里角色的发言是否自动发出去。关掉 = 只写故事、不打扰；到点提醒不受影响。 |
| `im.messageIntervalMinutes` | number | `120` | **发消息间隔**：两次自动发消息之间至少隔多久。写故事不受它限制。 |
| `im.deliverAutoAdvance` | boolean | `true` | 兼容开关，等价于 `autoMessage`（**两者都开**才会自动发消息）。 |
| `im.waitForTurnMs` | number | `90000` | 唤起角色后等它写出这段文字的时限。 |
| `im.keepPassive` | boolean | `false` | 投递失败时是否退化为一次普通本地唤起。 |

### 8.6 投递目标是怎么定的

**两层**优先级（自建通道之后从三层收敛为两层，「自动发现」现在是查自己的绑定表）：

1. **会话级绑定** —— `/interlude im bind <openid> [sessionId]`；
2. **绑定表** —— `$DSH_HOME/integrations/dsh-qq-im/bindings.json`。

绑定表由**你自己**维护，不再借用 dsh-im 的 `sessionSync`。这是本次改造的关键：
那份数据的存在本身就是开关，关掉镜像会连绑定一起 `delete`——两件无关的事被耦合
在一个字段上，导致「要么忍受泄漏，要么失去主动投递」的死结。

绑定通常是**自动建立**的：在 QQ 里给机器人发一条私聊即可（默认
`autoCreateSession: true`）。从 dsh-im 迁过来的用户，首次启动会自动导入旧绑定。

### 8.7 哪些话会走到聊天软件

| 触发 | 有绑定的会话 | 没有绑定的 Web 会话 |
| --- | --- | --- |
| 到点提醒 / 承诺回访 | 直投 QQ（**不受发消息间隔限制**——那是答应过的事） | 本地唤起，话留在会话里 |
| 故事续写里调了 `interlude_say` | 直投 QQ，受「发消息间隔」与每日配额约束 | 不会发（没有收件人） |
| 故事续写里只有正文 | **一个字都不发**，故事留在 DSH 里 | 同上 |
| 你在 DSH 界面说话，角色调了 `interlude_say` | 回到 QQ（受 `interactive` 约束） | 不会发 |

投递成功会占掉一个主动联系名额（`proactive.maxPerDay`，默认 6），承诺型待办在
`handleProactive` 里先结算，所以配额永远优先给角色答应过的事。

**只有真的发出去了**才推进「发消息间隔」的水位：投递失败不该让用户白等两小时。

### 8.8 自检命令

| 命令 | 作用 |
| --- | --- |
| `/interlude im` | 绑定、通道状态、降级策略、投递统计 |
| `/interlude im targets` | 列出本通道的绑定关系 |
| `/interlude im bind <openid>` | 手工绑定当前会话 |
| `/interlude im unbind` | 解除本会话绑定 |
| `/interlude im test [文案]` | 试投一条（`\|` 分隔多条） |
| `/interlude im reconnect` | 重连 |
| `/interlude im discover` | 列出绑定表并说明如何自动建立 |

### 8.9 QQ 用户端命令（在 QQ 私聊发给机器人，不进模型）

单行、以 `/` 开头、**私聊**时拦截，由插件直接处理并回投结果。
**群聊不响应命令**（避免群内命令刷屏与误触发；被 @ 的普通消息照常进角色会话）。

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示全部可用命令 |
| `/status` | 查看连接与当前绑定状态 |
| `/new` | 开启一个全新会话（解绑 → 新建 → 绑回） |
| `/sessionlist` | 列出可绑定的会话 |
| `/session <ID\|序号>` | 把当前聊天绑到指定会话 |
| `/presetlist` | 列出可切换的角色预设（带序号） |
| `/preset <ID\|序号\|角色名>` | **切换角色预设**：用该预设**新建一个会话**并接管当前聊天（绑定名 = 新角色名）。切换后旧会话仍保留，随时可用 `/session` 绑回 |

> `/preset` 的可用预设来自 `presets.json` 里已落盘的 roleplay 预设（含「创作」页保存的
> `preset-hds-*`）。切换只改当前聊天的绑定，不改 `im.bots[].agentPreset` 全局默认。


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
  它等于在对着空气说话（线上 session-58be9b68 第 7 轮）；
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

线上实测就坏在这里（session-ffc1e728）：

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

## 8. `im`（主动投递到 IM）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `im.enabled` | boolean | `false` | 兼容开关；**不再是投递的必要条件**（见下）。 |
| `im.botId` | string | `''` | dsh-im 的 Bot ID。 |
| `im.targetId` | string | `''` | dsh-im 的 Target ID。 |
| `im.autoDiscover` | boolean | `true` | 自动从 dsh-im 的「会话双向同步」目标里发现本会话的投递目标。 |
| `im.autoMessage` | boolean | `true` | **故事里角色的发言是否自动发出去**。关掉 = 只写故事、不打扰；到点提醒不受影响。 |
| `im.messageIntervalMinutes` | number | `120` | **发消息间隔**（分钟）：两次自动发消息之间至少隔多久（分钟）。填 `0` 表示每轮有话就发。写故事不受它限制。 |
| `im.deliverAutoAdvance` | boolean | `true` | 兼容开关，等价于 `autoMessage`（**两者都开**才会自动发消息）。 |
| `im.waitForTurnMs` | number | `90000` | 唤起角色后等它写出这段文字的时限。 |
| `im.timeoutMs` | number | `15000` | 单条消息投递超时。 |
| `im.keepPassive` | boolean | `false` | 投递失败时是否退化为一次普通本地唤起。 |
| `im.chunking.enabled` | boolean | `true` | 按真人发消息的方式分条。 |
| `im.chunking.maxChars` | number | `40` | 单条最大字数。 |
| `im.chunking.maxMessages` | number | `4` | 一次最多分几条。 |
| `im.chunking.minIntervalMs` | number | `400` | 两条之间的间隔。 |

### 投递目标是怎么定的

三层优先级，前一层没有才看后一层：

1. **会话级绑定** —— 在该会话里执行 `/interlude im bind <botId> <targetId>`；
2. **插件配置** —— 上面的 `im.botId` / `im.targetId`；
3. **自动发现** —— 从 `$DSH_HOME/integrations/dsh-<channel>/` 反查。

自动发现是默认路径，也是**最不容易出错**的一条：dsh-im 的「会话双向同步」
本来就把 `conversationKey` 绑到了会话上，插件只是把它读出来，因而长期有效、
不需要人工维护。三层都没有时，主动开口仍会唤起角色，只是写出来的话留在
DSH 里、回不到聊天软件——用 `im.keepPassive` 可以改成「至少在本地留一条」。

> **`im.enabled` 为什么不再是必要条件**：dsh-im 的会话同步只推送「用户在 DSH
> 里发起的回合」。主动回合的文本根本不会进 IM，必须由插件自己取出来直投。
> 早期实现要求先手工 `im bind` 且打开 `im.enabled`，于是任何一次忘记配置都会让
> 主动开口在聊天窗口里静默消失——那正是「不主动回复」的根因。

### 哪些话会走到聊天软件

判断依据有两条，**都满足**才发：

1. **这个会话有没有绑定**（`bindingFor`）。有绑定就说明这个会话本来就是在聊天软件里
   收发的，角色写出来的话就该回到那里去；
2. **角色这一轮有没有真的说话**（`lib/story.js` 的台词提取）。

| 触发 | 有绑定的会话 | 没有绑定的 Web 会话 |
| --- | --- | --- |
| 到点提醒 / 承诺回访 | 直投 IM（**不受发消息间隔限制**——那是答应过的事） | 本地唤起，话留在会话里 |
| 故事续写里角色说了话 | 直投 IM，但受「发消息间隔」与每日配额约束 | 不会发（没有收件人） |
| 故事续写里只有旁白 | **一个字都不发**，故事留在 DSH 里 | 同上 |

投递成功会占掉一个主动联系名额（`proactive.maxPerDay`，默认 6），承诺型待办在
`handleProactive` 里先结算，所以配额永远优先给角色答应过的事。

**只有真的发出去了**才推进「发消息间隔」的水位：投递失败不该让用户白等两小时。

查看当前状态：`/interlude im`；列出发现结果：`/interlude im discover`；
试投一条：`/interlude im test`。

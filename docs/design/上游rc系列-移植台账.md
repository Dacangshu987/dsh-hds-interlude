# 上游 rc 系列 —— 移植台账

> 参照物：`D:\ds-harness-test\111\.tmp-rc24\hds-interlude-1.0.1-rc24`（上游 `1.0.1-rc24` 完整源码包，
> 含 `src/` 43 个 .ts、`test/` 59 个、`docs/` 33 篇）。
> 上游仓库：<https://gitee.com/MomoiCore/hds-interlude>
>
> 本文只记录**逐项状态与理由**。凡「N/A」都写明架构差异，避免下次又照着错的前提做一遍。

---

## 一、版本线

| 上游版本 | 日期 | 本仓状态 |
|---|---|---|
| `0.1.4` → `1.0.1-beta6-rebuild` | 2026-09-01 → 09-10 | ✅ 已对齐（见 `上游更新方案-落实进度.md`） |
| `1.0.1-rc1` ~ `rc13` | 09-12 → 09-21 | ◐ 部分（见下表） |
| `1.0.1-rc14` ~ `rc19` | 09-23 | ◐ 部分（rc18 已移植，其余多为提示词/协议） |
| `1.0.1-rc20` ~ `rc22` | 09-24 | ❌ 未移植 |
| `1.0.1-rc23` | 09-26 | ◐ **档位化已移植**；播种器未移植 |
| `1.0.1-rc24` | 09-27 | ❌ 未移植（配置形态，多为 N/A） |

---

## 二、逐项状态

### ✅ 已移植

| 上游项 | 落点 | 说明 |
|---|---|---|
| rc1 健康诊断面板 | `lib/health.js` | 内存滚动指标 + `/interlude status` 健康段 |
| rc1/rc2 Schema 默认值对齐 | `lib/schema.js` | `contextEntryLimit=35`、`contextTimeWindowMinutes=45` |
| rc2/rc4 fact `lastSeenAt` | `lib/state.js` | 排序对空值回退 |
| rc2 主动联系计数移到投递结果后 | `lib/index.js` | `reachedOut` 只在 `deliverToIm.ok` 时自增 |
| **rc18 连发同条数守卫** | `lib/repetition-guard.js` | 倒序归批统计每批气泡数，尾部连续 ≥2 批同条数即守卫 |
| **rc23 群聊意愿档位化 + auto 档** | `lib/group-willingness.js` | 五档 + auto 三态 + 睡眠态三固定行为；见下节「DSH 适配」 |
| **rc23 世界事件播种器 纯函数核心** | `lib/world-seeder.js` | 运行配置夹取、提示词（逐字）、四道纯函数闸、防御解析、Jaccard 去重、执行器接缝 |
| **rc23 世界事件播种器 M1（注入侧）** | `lib/world-seeder.js` + `lib/index.js` + `lib/state.js` | 事件表 `state.seededEvents`（含状态机）、到点排水 → `kind:'world-event'/actor:'system'` 条目入账本、pre-step 以「事实权威、反应自由」呈现给模型、`/interlude seeded` 命令 |
| **rc23 世界事件播种器 M2（生成侧）** | `lib/world-seeder.js` + `lib/index.js` | 抖动跳过、频控、摘要级载荷、逐条采纳（含「high 每天至多 1 条」）、入库排期、`/interlude seeded generate` |
| **rc21 首条发言打字时间下限 + 打字模拟** | `lib/qq-im/outbound.js` + `lib/qq-im/channel.js` + `lib/index.js` + `lib/schema.js` | `typingDelayMs`（上游公式 + 抖动）、`firstMessageTypingFloorMs`（以请求发起时刻为基准补足）、分段按字数等待、图片豁免；参数与上游默认一致（1s / 8cps / 12s / 0.3） |
| **rc19 守卫默认值收紧** | `lib/repetition-guard.js` | 本仓守卫段末尾已有等价句「拿不准时，就只发一条。」（上游 `When unsure, make this reply a single bubble.`） |
| **rc23 审计：due 批次失败整批退避** | `lib/index.js` + `lib/state.js` | `state.proactiveBackoffUntil`；模型这一轮什么都没写出来（`no-writeback`）→ 整批退避一个扫描周期，杜绝每周期重新生成的无界烧 token |
| **rc23 审计：入站重放去重** | `lib/qq-im/inbound.js`（既有） | `DedupeWindow` 以 **messageId** 为键、TTL 10 分钟，覆盖「桌面超时-重放双写双回」；语义与上游私聊/群聊两侧一致 |

### ❌ 待移植（按建议优先级）

| 优先级 | 上游项 | 上游落点 | 备注 |
|---|---|---|---|
| 1 | **rc23 世界事件播种器 M1+M2** | `src/world-seeder.ts`(10.4KB) + `docs/WORLD_EVENT_SEEDER_DESIGN.md` | 全新子系统；六道校验闸；`[世界事件]` 条目注入 |
| 2 | rc21 首条发言打字时间下限 | `service.ts` `sendOutgoingMessages` | 我们已有分条间隔，缺首条下限 |
| 3 | rc19 守卫默认值收紧 | 一行英文 | `When unsure, make this reply a single bubble.` |
| 4 | rc22/rc23 审计项 | `service.ts` | due 批次整批退避、群消息桥接重放去重、取消遗留 narrative-retry |
| 5 | rc6 QQ 合并转发读取 | `src/forward-message.ts`(8.5KB) + `docs/FORWARD_MESSAGE_READING_DESIGN.md` | `forward` 段 → 读节点正文，带预算 |
| 6 | rc13 十一项缺陷修复 | `service.ts` 等 | 含**中文时间解析「八点半」**、清库后向量缓存失效、时间线分页游标等，需逐条核对 |
| 7 | rc3/rc4 管理员注记 | 主提示词 + `compactPromptEntries` | `[管理员注记]` 权威语义 + 防截断 |
| 8 | rc5/rc7 写作/视觉表达提示词 | `narrator.ts` | 需与我们的中文等价物逐句对照 |
| 9 | rc14 模型特化档位 | `src/specialization.ts`(14KB) | 架构不同，但「按模型能力给 lite/standard/full 三档提示词」可借鉴省 token |

### ➖ N/A（架构差异，明确不做）

| 上游项 | 为什么 N/A |
|---|---|
| rc12 Anthropic Messages 双协议 / cache-first / SSE 容错 | DSH 宿主统一管理 provider 与传输 |
| rc14-17 传输协议形态回退、气泡分隔符 `<sep/>` 教学 | 本仓用 `interlude_say` 工具调用；分条语义是「一行一条」 |
| rc20 死代码清理 / 命名对齐 / TurnEngine 回流 / `ensure-fresh-bundle.mjs` | 本仓是手写 JS，无 `src→lib` 构建链 |
| rc16 `clearDatabase` 30 秒在途屏障 | 本仓 JSON 状态 + `withStateLock`，无数据库清库动作 |
| rc23/rc24 Console 主提示词入口、播种器「用途勾选」 | Koishi Console 与本仓设置页形态不同（可另做等价入口） |
| rc11/rc10 跨群投递 `crossConversationActions` | 需多群绑定语义；本仓目前一 bot 一私聊/群绑定。**若需要可再评估** |

---

## 三、本轮移植详情：rc23 群聊意愿档位化

### 上游语义（`src/group-willingness.ts` L103-244）

- **五档参数表** `WILLINGNESS_TIERS`：quiet / reserved / normal / active / eager
  （阈值 0.80/0.75/0.62/0.30/0.10，增益 0.12/0.17/0.25/0.34/0.45，半衰期 150–360s）。
  基线校准：normal ≈ 每 4~5 条普通群消息触发一次（固定掷骰 0.4 的期望首发位置：
  eager=1、active=2、normal=4~5、reserved=6~8、quiet=9~13）。
- **auto 档**：按 `lifeStatus`（`busy|asleep|idle`）切档，三态各可配；
  **状态缺失或超过 6 小时未刷新 → 回退 normal**（`LIFE_STATUS_STALE_MS`）。
- **睡眠态三固定行为**：① @ 不再直通；② 概率 ×0.2（`ASLEEP_PROBABILITY_MULTIPLIER`）；
  ③ 掷骰失败 reason 记为 `asleep`。
- **存量兼容**：preset 未设置（或 `off`）但旧数值门 `enabled=true` → 按 `custom` 处理，行为字节级不变。
- **评分数学零改动**：档位只换参数来源。

### 本仓实现

| 项 | 落点 |
|---|---|
| 档位表 / auto 映射 / 常量 / 归一 | `lib/group-willingness.js` |
| 档位统一门 `evaluateWillingnessGate` / `consumeWillingnessGate` | 同上（`resolveWillingnessLayers` 私有） |
| 生活状态字段 `state.lifeStatus` + `normalizeLifeStatus` | `lib/state.js` |
| 配置 `im.group.willingnessPreset` / `willingnessAuto` | `lib/schema.js` |
| 评估门接线 + 发言记账（同档位解析） | `lib/qq-im/channel.js` |
| lifeStatus 读取器注入 | `lib/index.js`（`resolveLifeStatus`） |
| 生产者：`/interlude life <busy\|asleep\|idle\|clear>` | `lib/index.js` 命令分支 |
| 测试 | `test/group-willingness-tiers.test.mjs`（9 项） |

### DSH 适配点（唯一与上游的差别）

上游的 `lifeStatus` **搭压缩器便车**（压缩提示词附带返回，零额外模型调用）。
本仓**没有独立侧端模型通道**（`lib/side-task.js` 只提供解析/重试原语，
执行器注入点尚无宿主实现），因此把它做成**可写入的宿主调度字段**：

- `state.lifeStatus = { status, updatedAt }`，防御归一（仅三值 + 合法时间戳）；
- 归属于**宿主调度字段，不进模型上下文**（上游 `storyStateForPrompt` 同样剥除）；
- 生产者：`/interlude life …` 命令（本仓新增）；未来任何侧任务/交接写入即可复用；
- **缺失/过期回退 normal 的行为与上游一致**，因此 auto 语义等价。

> 结论：机制 100% 移植；生产者按平台能力替换，且已保留同样的语义边界。

---

## 四、本轮移植详情：rc23 世界事件播种器（M1 注入侧）

### 上游实现（`src/world-seeder.ts` + `src/service.ts` 的 `drainDueSeededEvents`）

| 上游项 | 上游值 | 本仓落点 |
|---|---|---|
| 默认运行参数 | cadence 45 / maxPending 4 / dailyCap 4 / maxHorizon 72h / temp 0.9 / maxTokens 1000 / timeout 60s | `DEFAULT_WORLD_SEEDER_RUNTIME`（逐字对齐） |
| 侧模型系统提示词 | 全英文，含 `MOST RUNS MUST RETURN an empty events array.`、`BLOCKED NAMES` | `worldSeederSystemPrompt()`（**逐字对齐**） |
| 校验闸① 时间窗 | `occursAt ∈ (now, now+maxHorizon]` | `validateSeedEvent` → `invalid-time` |
| 校验闸② 拉黑 | subjects/summary 命中名单（含双向包含，长度 ≥2 才参与） | `blocked-name` |
| 校验闸③ 深夜 high | 故事时区 0:00–6:00 的 high 事件拒 | `night-high` |
| 校验闸④ 去重 | 与近 14 天摘要 bigram Jaccard > 0.6 | `duplicate`（`summaryJaccard`） |
| 校验闸⑤/⑥ | Preplan 冲突、频控（pending/dailyCap） | 频控在排水侧（`dailyCap`）；Preplan 冲突待 M2 接入 |
| 注入形态 | `kind:'world-event', actor:'system', content:'[世界事件] '+summary, metadata:{seededEventId,importance}` | 逐字对齐（`appendEntry`） |
| 排水顺序 | 按 `occursAt` 升序；过期 → `expired` 并 continue；`low && !includeLow` → 跳过 | 逐字对齐（`planSeedDrain` + `drainSeededEvents`） |
| 事件表 | `interlude_seeded_event`（SQLite + 自增 id + status 四态） | `state.seededEvents[]`（JSON，`nextId` 只增、容量 60） |

### 增量闸（上游 service 层）

- `importance === 'low' && !includeLow` → 跳过：上游由调用方传 `phase !== 'user-message'`，
  **用户消息回合不塞质感级噪声**。本仓排水发生在后台扫描（无用户回合相位），
  故固定传 `true`，参数保留供未来复用。

### DSH 适配点（**刻意偏离，已在此记录**）

上游把「是否排水」绑在 `worldSeederRuntime.enabled` 上，而该值要求**已指派模型**
（模型中心连接行勾选 `useForWorldSeeding`）。本仓没有侧端模型通道，
若照搬则 **M1 永远无法运行**（没有任何连接可勾选）。
因此这里把排水绑在**配置开关** `cfg.worldSeeder.enabled` 上：
- 注入侧（M1）**不需要第二个模型**即可工作；
- 生成侧（M2，需要模型）通过可注入执行器 `ctx.__worldSeederExecute` 接入，
  未注入时 `createWorldSeeder(...).available === false`，生成自动关闭
  ——与上游「未勾选连接即关闭（生成）」语义一致。

> 结论：纯函数与注入形态 100% 对齐；仅「排水开关的来源」按平台能力替换，
> 且已在测试中显式断言该偏离的可观测行为。

### 测试

- `test/world-seeder.test.mjs`（11 项）：四道闸逐条、边界（恰好 now、超时限、
> 双向包含、单字名字不参与、时区切换影响深夜判定）、防御解析、运行配置夹取、
> 生成侧接缝（系统提示词逐字）、事件表归一、排水顺序与过期、注入前缀。
- `test/world-seeder-m1.test.mjs`（5 项）：端到端——到点事件入账本（kind/actor/前缀/
> metadata 回链）、pre-step 呈现且只呈现一次、过期不补发、关闭时不排水、
> 「无执行器也能注入」的偏离断言。

---

## 五、本轮移植详情：rc23 世界事件播种器（M2 生成侧）

### 上游实现（`service.ts` 的 `worldSeederSweep` / `buildWorldSeederPayload`）

| 上游语义 | 上游值 | 本仓落点 |
|---|---|---|
| 节律抖动 | `Math.random() < 0.25` 直接跳过本轮 | `planWorldSeederSweep` → `reason='jitter'` |
| 频控① 挂起上限 | `scheduled.length >= maxPending` → 不生成 | `reason='max-pending'` |
| 频控② 当日上限 | 近 24h `injected >= dailyCap` → 不生成 | `reason='daily-cap'` |
| 去重输入 | 近 14 天已注入事件摘要（截 -10） | `recentSummaries` → 载荷 `recentlySeededEvents` |
| **额外闸：high 每天至多 1 条** | 采纳循环里 `if (draft.importance === 'high' && highToday >= 1) continue` | `acceptSeedDrafts` → `reason='high-daily-cap'` |
| 载荷 | 环境（时区/季节/世界设定）+ 历史（压缩 2000 预算、截 -14、每条 240 字）+ 场景/弧摘要（500）+ workingDetails（-8）+ 拉黑名单 + 近期已播种 + constraints | `buildWorldSeederPayload`（逐字段对齐；季节 3–5 春/6–8 夏/9–11 秋/其余冬） |
| 采纳上限 | 循环内 `pendingCount >= maxPending \|\| dailyCount >= dailyCap` → break | 同（`acceptSeedDrafts` 的计数递增） |
| 排期后唤起到点 | `scheduleDueIntentWake(story.id, occursAt)` | `scheduleIntentWake(key, occursAt)` |
| 触发时机 | 定时器 cadence + **每次 advance 提交后 piggyback** | 搭在会话扫描上（每次 `handleSession`），由 `state.lastSeedSweepAt` 按 `cadenceMinutes × (0.7~1.3)` 节流 |

### DSH 适配点（**刻意偏离，已在此记录**）

- **执行器可注入**：上游用模型中心连接行勾选出的 provider；本仓用
  `ctx.__worldSeederExecute`。未注入 → `available=false` → 生成关闭、**注入侧不受影响**。
- **手动触发**：本仓新增 `/interlude seeded generate`（跳过 cadence 节流与抖动，
  便于验证与应急），上游无此命令。
- 注入与水位的开关来源见上一节（绑配置开关而非「已指派模型」）。

### 测试

- `test/world-seeder-m2.test.mjs`（14 项）：抖动/两条频控/14 天窗口/禁用、季节映射、
  载荷裁剪与预算与拉黑过滤、采纳的三条规则（high 每日上限、上限 break、四道闸拒绝原因）、
  以及四个端到端用例（执行器产出 → 入库；无执行器 → 不生成；校验闸拦截；high 每日一条）。
  > 端到端用例用「重试直到真正跑过一轮」的辅助规避上游 25% 抖动带来的概率性
  > （单次被跳过的概率 25%，6 次全跳过 < 0.03%）。

---

## 六、本轮移植详情：rc21 打字节奏 + rc19 守卫默认值

### rc21 首条发言打字时间下限（含恢复打字模拟）

**背景**：本仓此前在 schema 里显式标注「去除打字模拟」，只保留固定的
`chunking.minIntervalMs`（条间隔 400ms）。而上游自 0.1.x 起就有打字模拟，
rc21 是**建立在该参数之上**的首条下限，因此先把模拟恢复回来、再加下限。

| 上游 | 上游值/公式 | 本仓落点 |
|---|---|---|
| `typingBaseDelaySeconds` | 1 | `chunking.typingBaseDelaySeconds` |
| `typingCharactersPerSecond` | 8 | `chunking.typingCharactersPerSecond` |
| `typingMaxDelaySeconds` | 12 | `chunking.typingMaxDelaySeconds` |
| `typingJitterRatio` | 0.3 | `chunking.typingJitterRatio` |
| 打字时长 | `clamp(base + 字数/cps, 0, max) × (1 + jitter×(2r−1))` | `typingDelayMs`（可注入随机源，便于测试） |
| rc21 首条下限 | 以**叙事请求发起时刻**为基准补足 `typingDelay(首条)`；已超过则立即发；至多应用一次 | `firstMessageTypingFloorMs` + `deliverMessages({ requestStartedAt })`；基准取 `pendingTurns.get(key).startedAt` |
| 打断 | 等待期间新用户消息可经 `shouldCancel` 打断 | 首条 floor 用 `interruptibleDelay(ms, signal)` 实现，被打断则整批作废 |

**DSH 侧的三处刻意选择（均已在代码注释与本表记录）**：
1. **图片豁免打字模拟**：图片不是「打出来的」，按空文本会回落到基础 1 秒，
   把「图 + 文」整体拖慢（实测会把图片推出调用方的等待窗口）。图片只受
   本地 `minIntervalMs` 约束。
2. **分段等待不可打断**：保持 `deliverMessages` 原有语义（每条开头检查一次中止）。
   若让分段等待也可打断，外层 signal 在打字期间中止会把整批剩余内容一起丢掉
   ——这正是本轮引入又修掉的一个回归（见下）。
3. **`minIntervalMs` 作为本地下限**：取 `max(minIntervalMs, typingDelay)`
   （上游没有这一层，是本仓防平台限流的额外保护）。

### rc19 守卫默认值

上游 rc19 在 REPETITION GUARD 段末尾追加
`When unsure, make this reply a single bubble.`。本仓守卫段末尾对应句为
「拿不准时，就只发一条。」——**语义已等价**，无需改动。

### 本轮踩到并修掉的回归（值得记下来）

加打字模拟后 `test/verify-sticker-dispatch.mjs` 从 12/12 掉到 10/12
（图片发不出去）。用 `git show HEAD:<file>` 逐文件二分定位到 `outbound.js`，
再定位到两个原因：① 分段等待新增的「等待后中止检查」让外层 signal 中止时
整批作废（含图片）；② 图片条目按空文本吃满基础 1 秒。两者都修掉后恢复 12/12
（连跑 3 次稳定），并补了 `test/typing-floor.test.mjs`（9 项）钉住这些边界。

---

## 七、本轮移植详情：rc22/rc23 审计项

上游 rc23 的「全量审计修复（7 项）」逐条对照本仓，结论如下：

| 上游审计项 | 本仓结论 | 依据 |
|---|---|---|
| Fix#10 守卫回归（committed 标志移到持久化成功后） | N/A | 本仓没有该 `committed` 标志；投递记账在 `deliverToIm` 返回 `ok` 之后才写 `state`（本来就「先成功再落账」） |
| 群消息桥接重放去重（与私聊对齐） | ✅ 已等价 | `DedupeWindow` 以 messageId 为键、TTL 10 分钟；私聊与群聊走同一入口 |
| 用户回合成功后取消遗留 narrative-retry | **N/A（架构差异）** | 上游有 `interlude_intent(type='narrative-retry')` + `narrativeRetryDelaySeconds/MaxAttempts`；**本仓不排叙事重试意图**（模型请求失败由 DSH 宿主重试），因此不存在「遗留重试到期再跑一轮 → 重复回复」这一缺陷类 |
| due 路径参与者状态检查 + 暂停不再反向排重试 | ✅ 已等价 | 暂停：`handleSession` 经 `isRoleplayState` 直接返回，不排重试；参与者：批次派发前必须 `bindingFor` 命中（无绑定则不唤醒） |
| **due 批次失败整批退避一个扫描周期** | ✅ **本轮新实现** | 见下 |
| 空白 delayed content 丢弃消息事件而非拒绝整个 commit | ✅ 已等价 | 出站 `deliverMessages` 先 `normalizeItem` 再 filter（空串/无效图片直接丢），不会因一条空内容整批失败 |
| Anthropic SSE 坏帧容错 | N/A | 本仓不经手 SSE（宿主管传输） |

### 本轮新实现：due 批次失败整批退避

- 新增 `state.proactiveBackoffUntil` / `proactiveBackoffReason`（防御归一：非法值回 `null`，
  过期值自然放行，**不会永久粘住**）。
- `handleProactive` 在选出批次目标后先过这道闸：退避窗口内直接返回，不唤醒模型。
- 触发点**精确到「会重新生成」的那一种失败**：`delivered.error === 'no-writeback'`
  （模型这一轮什么都没写出来）。其余失败（有 `pendingText` 的投递失败）本仓本来就
  「重发同一段、不重新生成」，不属于烧 token，故不触发退避。
- 成功开口时（`settleBundled`）清除退避。

> 实现时的一处教训：第一版把条件写成「没有 pendingText 就退避」，结果**拦截了**
> 原有的「保留草稿待重发」分支（`proactive-cold` 的
> 「投递失败重试时不重新生成内容」用例立刻变红，状态卡在 `delivering`）。
> 条件必须收窄到 `no-writeback` 这一种。

### 测试

- `test/proactive-cold.test.mjs` 新增 2 项：退避窗口内**不投递也不唤起模型**；
  退避过期后照常开口（闸不粘住）。

---

## 八、验证基线

每一项移植都必须：新增对应测试 → 跑全量 `npm test`（含承重验证 `test:loadbearing`）
→ 同步 `.publish-snapshot`（脱敏 + 保持 `test:live` 差异）→ 推送 GitHub。

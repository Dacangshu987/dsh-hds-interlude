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
| **rc6 QQ 合并转发读取（完整）** | `lib/forward-message.js` + `lib/qq-im/inbound.js` + `lib/qq-im/channel.js` | 预算 30/8000/3、id 提取（元素 + CQ 码 + 字符串标签）、归一化渲染与截断标注、可注入 fetcher 的递归读取、入站占位与替换、`im.forwardLimits` 配置 |
| **rc3/rc4 管理员注记（权威层 + 预算保护）** | `lib/index.js` + `lib/script-entry.js` | `kind:'admin-note'` / `actor:'system'` / `[管理员注记] ` 前缀 / `metadata.source='administrator'`；每回合带上最近 3 条（每条 ≤2000 字、合计 ≤6000、超限保前缀并标 `…[注记截断]`）；`/interlude note [<内容>\|clear]` |
| **rc13 用户报时提取 + 提示词投影** | `lib/user-reported-times.js` + `lib/index.js` | 中文钟点「八点半」修复；只在他刚说完时注入事实行 |
| **rc13 preplan 物化滞后防线** | `lib/preplan.js` | `ensureWindowDays`：缺 [今天,明天] 时本地无模型重物化（锚定今天） |

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

## 八、本轮移植详情：rc6 QQ 合并转发读取

### 上游实现（`src/forward-message.ts`，188 行）

| 上游 | 本仓落点 | 说明 |
|---|---|---|
| `forwardReadLimits`（默认 30 / 8000 / 3，夹取 1–100 / 500–32000 / 0–8） | `forwardReadLimits` | 逐字对齐（含上游 `clampInt` 的口径：`Number(null)===0` 走夹取而非回退） |
| `extractForwardIds`（元素 `attrs`/`data` + `[CQ:forward,…]`；长度上限 512；去重） | `extractForwardIds` | 逐字对齐 |
| `normalizeForwardMessages`（节点标题、发送者/QQ、段文字化、节点与字符预算、截断标注） | 同名函数 | 逐字对齐（含 `[合并转发内容｜节点数 N]`、`[节点 k｜昵称（QQ）｜类型]`、`[合并转发内容已按安全预算截断]`） |
| `normalizeForwardSegments`（text/at/reply/forward/image/record/video/file/未知） | 同名内部函数 | 逐字对齐 |
| `readForwardContent` + `fetchForwardNodes`（OneBot `get_forward_msg`，30s 超时、逐层递归、嵌套限 10 条） | 同名函数 + **可注入 fetcher** | 预算与递归语义保留；发请求改为宿主注入 |

### DSH 侧适配（已在文档与代码注释记录）

本仓 QQ 通道是**官方 SDK**，没有 `get_forward_msg`。因此取数做成可注入的
`fetchNodes(id)`（与 `side-task.js` / `world-seeder.js` 同一模式）：
未注入时 `readForwardContent` 退回**占位形态**并标 `failed: true`
——正是上游读取失败时的降级，绝不把裸标记漏给模型。

### 入站卫生（本轮一并做掉）

`sanitizeAttachments` 此前只处理 img/record/video/file，`<forward>` 与
`[CQ:forward,…]` 会**原样漏进上下文**（带 CDN/rkey 的标记正是这条清洗存在的原因）。
现在两者都转成 `[合并转发：id]` / `[合并转发]` 占位，与其他附件共存时互不干扰。

### 接线（本轮补完）

- 通道注入点：`ctx.__qqForwardFetch(id) => Promise<nodes>`（与 `__worldSeederExecute` 同模式）；
  `channel.js` 的 `makeForwardReader()` 把它接上预算与归一化，未注入则返回 `undefined`；
- `handleInbound` 新增第 ①' 步：`applyForwardRead(text, message, {readForward, limits, log})`
  —— 有资源才调用（零开销）、读取成功**按 id 精确替换占位**（保持用户发送时的位置）、
  两侧原文保留；失败/抛错保留占位并记 warn，**不阻断回合**；无通道记 debug；
- 配置：`im.forwardLimits { maxNodes, maxCharacters, maxDepth }`（默认与上游一致）；
- 补齐一处保真缺口：`extractForwardIds` 原先只认**元素对象**与 **CQ 码字符串**，
  而 SDK 常把富文本原文给成字符串（`<forward id="…"/>`）——上游用真实 HTML 解析器
  （`h.parse`），本仓现补标签正则，覆盖 `id` / `res_id` / `forward_id` 三种属性与引号形态。

### 测试

`test/forward-message.test.mjs`（15 项）：预算默认与夹取、id 提取（元素/CQ/字符串标签/递归/去重/超长）、
渲染（各段/节点上限/字符预算/嵌套深度/缺资源标识）、可注入取数（无 fetcher 降级、
无 id 早退、fetcher 抛错、递归与剩余预算）、入站清洗占位、**读取回路**
（无资源零开销、无通道保留占位、成功替换且保留两侧原文、失败与抛错不阻断）。

---

## 九、本轮移植详情：rc13 十一项缺陷逐条核对

| 上游 rc13 缺陷 | 本仓结论 | 依据 / 理由 |
|---|---|---|
| 旧版共享迁移在 Schedule Preplan 表上必然抛错（主键不可 update） | N/A | 本仓是 JSON 状态 + `withStateLock`，没有 SQLite 表迁移路径 |
| 管理员清除数据后同步失效历史向量缓存 | **N/A** | 本仓**不落盘向量**（`semantic-recall` 的 embed 是可注入接口，未注入即词法降级；`state.js` 里没有任何 vector 字段）→ 不存在「需要失效的向量缓存」 |
| 命令识别正则支持点分子命令（`interlude.status`） | **✅ 已等价（且更严）** | 本仓 QQ 侧命令是 `switch (verb)` 匹配（`lib/qq-im/bot-commands.js`），**统一用 `/verb`**、不区分点分子命令；而 `default:` 分支对**任何**未知 `/…`（含 `/interlude.status` 这种点分写法）直接回「不认识命令…」并**不进模型**——注释里写明「避免把『/xxx』当聊天内容灌给角色」。所以"命令文本写进剧本"在本仓构造上不可能发生 |
| **中文时间解析「八点半」（此前为 8:00）** | ✅ **已移植 + 已投影** | `lib/user-reported-times.js` 纯核（`chineseClockNumber` + 三条回路；测试断言 `八点半 → 08:30`）；提示词投影见下 |
| `<say>` 内容含边缘空白时不丢 immediate 回复 | **✅ 已等价（构造上不可能发生）** | 本仓走 `interlude_say` 工具、由 `capture.js` 采集：`text.split('\n').map(line => line.trim()).filter(Boolean)`——**先 trim 再过滤**，边缘空白只会被归一，不会像上游那样因"精确匹配"而丢掉整条 immediate 回复；纯空白行被丢弃是「没有可发的内容」，不是丢回复 |
| `narrative-retry` 不被用户回合提前完成 | N/A | 本仓不排叙事重试意图（模型失败由 DSH 宿主重试），见第七节 |
| **Schedule Preplan 物化滞后时窗口静默变空** | ✅ **本轮移植** | `ensureWindowDays`：缺 [今天,明天] 时**本地无模型重物化（锚定今天）**，详见下 |
| 桌面时间线分页游标改 occurredAt+id 双键 | **N/A** | 本仓没有桌面时间线分页（无游标分页路径） |
| 合并写作持久化抛错不静默吞批 | N/A | 本仓没有「合并写作持久化」这一步（投递/条目各自独立落盘） |
| `interruptedTyping` 在取消异常后无条件清理 | **N/A** | 本仓没有 `interruptedTyping` 这类**持久化**标志：取消走 `capture.cancel()` → `capture.settle()`（把捕获窗口结算掉，不留粘性状态）；分段投递的失败记账是 `pendingText` + `attempts`（≥3 → failed），本身就是有界的 |

> 结论：**rc13 已全部核对完毕** —— **4 项已修复/已等价**（中文钟点、其提示词投影、preplan 物化滞后、`<say>` 边缘空白）、**6 项 N/A/已等价**（旧表迁移、向量缓存、命令点分子命令、`narrative-retry`、分页游标、合并写作持久化、`interruptedTyping`），无遗留待核对项。

### 同一轮：rc5/rc7 线上表达提示词

上游把两条规则都放在 `specialization.ts` 的 `TYPED_MESSAGES_BASE` 里；本仓对应落点是
`render.js` 的 `imRules`（发送方式的约束，不碰文风）：

| 上游 | 本仓 |
|---|---|
| rc5：portray online messages as text she chooses to **type**, not spoken dialogue transcribed | 已有「只写你会真正打出来发出去的字…不要写旁白/动作/神态/内心独白」 |
| rc5：**Each reply is an independent choice — the number of messages in previous replies does not constrain this one** | **本轮补**：「每一轮都是独立的选择：上一轮发了几条**不约束**这一轮」——rc18 的条数守卫只在**检测到锚定之后**才注入，这条是无条件基线 |
| rc5：let this moment alone decide whether she sends one bubble or several | 已有「分开打几条是正常的，像真人聊天那样」 |
| rc7：stickers/emoji-like images are a **metalanguage**；infer attitude/acknowledgement/hesitation/irony from the image **and its conversational context rather than stopping at the depicted subject**；a cat sticker may mean "seen"/"confirmed"；sending the same sticker repeatedly is also an intentional expressive act | **本轮补**：「表情包和图片是**元语言**…**不要停在画面本身上**——一张猫的贴图可能只是「看到了」…同一个贴图连发多次同样是**有意的表达**」 |

只在 IM 场景渲染（`imActive`），不污染纯 Web 写作——已由测试钉住。

### 本轮实现：用户报时提取（rc13 修复项 + 0.1.4 的「提及时间提取」）

| 上游 | 本仓落点 |
|---|---|
| `chineseClockNumber`（十/十几/二十几，坏值 undefined） | 同名导出（逐字对齐） |
| 数字钟点回路（`[:：.]` / `点` / `N点M` / `N点半`；下午晚上 +12；**裸钟点取离当前时钟更近者**） | 同名回路 |
| 时段词锚点（8/9/12/15/18/20） | `PERIOD_HOURS` |
| **中文数字钟点回路（rc13 修复）** | 同名回路 |
| `{localTime, relation, statement}` + 去重键「钟点+原话」+ 上限 4 | 同名形状与口径 |
| `localClockMinutes` / `calendarDayKey` | 复用本仓 `lib/clock.js`（已有，含 `hourCycle: 'h23'`，无 12 小时制歧义） |

与 `lib/commitment.js` 的分工（互不替代）：那边解析「多久之后」的相对时长并判断
是否构成承诺；这边只抽「对方几点」的客观事实，**不做任何推测**（上游口径：
a small factual aid, not an attempt to infer every temporal expression）。

**提示词投影（本轮补完）**：上游把提取结果作为 payload 字段交给模型，并在系统
提示词里说明其含义；本仓提示词是文本块，因此在 pre-step 注入一条**事实行**
（`userReportedTimesLine`）：
- 只在「他刚说完、正在回他」时出现（`lastUserAt > lastAssistantAt`）——
  她刚说完时出现就是拿旧话当"他刚才说的"，那是凭空捏造；
- 只列他自己写出来的钟点 + 相对关系（还没到 / 已经过去 / 就是现在），
  并明确写上「不要据此编造他没说过的安排」；
- 计算是 O(消息长度) 的本地正则，**不落状态**（与上游一致：请求时算一次）。

**另一个 rc13 修复：preplan 物化滞后**——`schedulePreplanWindow` 只取 dayOffset 0..1
的物化天，`materializedDays` 一旦缺 [今天,明天]（每日审查退避/推迟都可能造成），
窗口就**静默变空**且不留痕。现补 `ensureWindowDays`：缺失时**本地无模型重物化
（锚定今天）**。本仓刻意只**在内存里**重算——该函数同时被提示词渲染路径
（`render.js`）调用，从渲染里写状态会让纯投影带上副作用；下次每日审查会正常落盘。
可观测结果与上游一致：窗口不再凭空变空。

---

## 十、本轮移植详情：rc3/rc4 管理员注记

### 上游实现

| 上游 | 本仓落点 |
|---|---|
| `addAdminScriptNote`：`appendEntry({kind:'admin-note', actor:'system', content:'[管理员注记] '+text, metadata:{source:'administrator'}})` + 触发压缩 | `addAdminNote`（同一形态；压缩由 DSH 侧负责） |
| 命令 `interlude.script.note <content:text>`（管理员专用） | `/interlude note <内容>`（+ 无参列表 / `clear`；本仓是 DSH 命令，管理员即会话使用者） |
| 提示词 `ADMIN NOTES`：权威事实或指令；在其主题上覆盖叙事即兴；权重高于普通系统事件；**直到被后来的注记否定之前有效**；当作主角已内化的既定现实；**永远不要让她提到看过注记** | `adminNotesLine` 的中文口径（逐条对应） |
| 预算保护（`compactPromptEntries` admin 段）：最多 3 条最新、每条 ≤2,000 字、合计 ≤6,000 字；超限保留前半段（含前缀）并标截断 | 同（`ADMIN_NOTE_MAX_COUNT/CHARS` + `ADMIN_NOTES_BUDGET`） |

### DSH 侧适配

- **呈现方式**：上游靠 `recentScript` 窗口自然带上注记；本仓的模型上下文是**会话历史**
  （没有 recentScript 投影），所以注记必须显式进入每回合的 pre-step 附加段——
  与已移植的世界事件同一套做法（`takeWorldEventsForPrompt` / `adminNotesLine`）。
- **每回合都带最近 3 条**（而不是"注入一次即可"）：DSH 会自己压缩会话历史，
  靠一次性注入无法保证权威事实仍在窗口里；上游的"受保护窗口"语义正对应这一点，
  且上限 6,000 字把成本钉死。
- `ENTRY_KINDS` 保持与上游可召回清单逐字一致（差分契约测试不受影响），
  `admin-note` 与 `world-event` 一样走 `HOST_ENTRY_KINDS`。

### 测试

`test/admin-note.test.mjs`（4 项）：命令写入的 kind/actor/前缀/metadata；
提示词投影（权威措辞 + 正文 + 「不要提看过注记」）；预算保护（只带最新 3 条、
超长截断标注、合计受约束）；无参数列出（空注记不会落库）+ `clear` 后提示词不再出现。

---

## 十一、验证基线

每一项移植都必须：新增对应测试 → 跑全量 `npm test`（含承重验证 `test:loadbearing`）
→ 同步 `.publish-snapshot`（脱敏 + 保持 `test:live` 差异）→ 推送 GitHub。

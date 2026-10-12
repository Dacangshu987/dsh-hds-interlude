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
| `1.0.1-rc20` ~ `rc22` | 09-24 | ◐ 部分（rc21/rc23 审计项已补，见第 2026-10 批次） |
| `1.0.1-rc23` | 09-26 | ✅ **档位化 + 播种器 M1/M2 + 审计退避已移植** |
| `1.0.1-rc24` | 09-27 | ❌ 未移植（配置形态，多为 N/A） |
| `1.0.1-rc25` ~ `rc36` | 10-02 → 10-04 | ✅ **五项高优先级已移植**（rc28 DeepSeek 家族行、rc28 播种器复读架构、rc25 联系温度、rc33 投递幂等、rc35 历史预算旋钮），见第十四章 |
| `1.0.1-rc37` ~ `rc47` | 10-05 → 10-10 | ❌ 无独立 changelog 条目（内部迭代，随 rc48/rc50 一并发布） |
| `1.0.1-rc48` | 10-08 | N/A（分享码同步专属） |
| `1.0.1-rc50` | 10-11 | ◐ **六项已移植**（preplan 跨夜+保留策略、alter 快照消费、全局事实主体、索引二分、DeepSeek 行收窄），见第十五章 |

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
| **rc5/rc7 线上表达提示词** | `lib/render.js` | rc5 无条件反锚定基线（每轮独立选择）+ rc7 贴图元语言规则（不停在画面本身、连发也是有意表达）；只在 IM 场景渲染 |
| **rc14 模型特化推断层 + 家族块** | `lib/specialization.js` + `lib/render.js` + `lib/schema.js` | 家族识别（8 家族 + generic，顺序逐字对齐）、auto 档位（含 deepseek / glm-5 两处例外）、三档模式与 source 标记、家族块最小偏移（打字块替换 + 至多一条新增行）；配置 `specialization {mode, modelProbe}` |

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

## 十一、本轮移植详情：rc14 模型特化

### 上游（`src/specialization.ts`，14KB）

一个模型的「档位」决定提示词里**给多少约束**：弱模型（flash/lite/mini 系）约束一多就
执行不过来、反而丢关键规则；强模型（claude/gpt）给足了才不出戏。上游分三档
（`lite`/`standard`/`full`）按模型名自动推断，再叠一层**家族块**做最小偏移。

### 本仓移植：推断层（逐字对齐）

| 上游 | 本仓 |
|---|---|
| `FAMILY_PATTERNS`（8 家族 + 顺序即优先级） | 同（claude → gemini-flash → gemini → gpt → grok → kimi → glm → deepseek） |
| `detectFamily`（首命中者胜，否则 `generic`） | 同 |
| `autoTier` | 同，含**两处上游例外**：`deepseek` 不吃「flash→lite」（V4-Flash 数据支持 standard）、`glm-5` 起不算 lite |
| `inferSpecialty`（auto / 手动档位 / off，带 source 标记） | 同 |
| 未识别家族**保守回退 full** | 同（"避免静默改变现有安装的行为"） |

### 本仓移植：家族块（内容按本仓口径重写，规矩照搬）

上游的 `typed` 块正好对应本仓刚移植的 rc5/rc7 打字与贴图规则，于是按上游
「**最小偏移：打字块/长度块替换 + 至多一条新增行**」的规矩落地：

| 家族 | 偏移 |
|---|---|
| `gemini-flash` | 换**精简版打字块**（去掉猫贴图延展，补「真人打出来的消息朴素具体直接」）+ 一条行文基调 |
| `kimi` | 完整打字块 + 补「迟疑/改主意/矛盾是正常状态」一段（对应 `TYPED_MESSAGES_KIMI` 的插入） |
| `claude` | 一条家族行（场景不必圆满收束，不要总结句/教训/情绪标签收尾） |
| `glm` | 一条家族行（情绪跟着真实起因走，不滑向温情安慰） |
| 其余 | 无偏移（`{}`） |

### N/A（架构差异，已写明理由）

- 上游的 `length` 块是**全局英文文风寄存器**；本仓文风来自角色卡（canon 的「文风」段），
  全局再写一层会与人设打架 → 不移植；
- `CONTENT_ONLY_TRANSPORT` / `LITE_*` / JSON `script` 合约那一半是**传输协议**层：
  本仓用 `interlude_say` 工具调用发言，没有 JSON 合约 → N/A（与 rc12/rc16/rc17 同一判断）。

### DSH 侧适配（唯一差别）

上游从**模型中心的连接名**取探测串；DSH 由宿主管模型路由，**插件侧读不到模型名**
（schema 里也已剔除模型提供商中心）。因此探测串做成用户配置
`specialization.modelProbe`：填模型名即按上游规则自动分档；**留空 → generic → full**，
与上游「未识别家族回退 full」一致，也就是**默认完全不影响现状**。

### 测试

`test/specialization.test.mjs`（8 项）：家族识别（含顺序与否定例 `flashlight`）、
autoTier 全部规则与两处例外、三种模式与 source、家族块最小偏移（含「其余家族无偏移」）、
`resolveSpecialtyBlocks` 的选择、以及**渲染落地**三条（留空=完整块无家族行；
gemini-flash 用精简块且不混入别家行；claude/kimi 各自正确）。

### rc11 私聊回合跨群投递（crossConversationActions）—— 已移植

上游形态：`allowCrossConversationMessages` + `maxCrossConversationActions`（默认 1、上限 5）；
`availableGroupTargets` 列出**可发目标**（是"可发对象"而非"已发回执"）；
提示段 `CROSS-CHANNEL DELIVERY`；提交后执行跨会话投递。

| 上游 | 本仓 |
|---|---|
| 目标来自配置里启用的群（`enabled !== false`） | 目标来自**本 bot 已绑定的群会话**（`bindings.list(botId)`，`group:` 前缀）＋ 白名单 —— 语义等价，且不必再配一份群表 |
| 只在 `!groupContext` 且 user-message 相位提供 | 只在当前绑定是**私聊**时提供（群聊回合为空） |
| `maxCrossConversationActions`（默认 1） | `im.crossConversation.maxPerTurn`（默认 1，0–5），**每回合在 pre-step step 1 归零** |
| `participantId: "group:<id>"` + label + groupId | 同（提示里给出精确 `target=\`group:<id>\``） |
| 提示段：私聊回复与跨频道投递是两件事；承诺稍后发 ≠ 已发；目的地不明不要猜；不要想象观众反应 | 逐条对应的中文段（`crossChannelLine`） |
| `crossConversationActions:[{participantId,mode,content}]` | `interlude_say` 的可选 `target` 参数（本仓是工具调用式发言，没有 JSON decision） |

**DSH 侧的两处刻意选择**（已入档 + 测试钉住）：

1. **立即投递**：上游在 Commit 之后批量执行跨会话投递；本仓在工具调用时直接走通道。
   原因是本仓的常规投递会写 `state.lastImDelivery` 与投递账本（那是"本轮私聊说了没有"
   的事实来源），跨群若复用同一路径会把它冲掉。因此跨群走**独立路径**，结果记到
   `state.crossDeliveries`（与 `lastImDelivery` 分开）。用户可见语义一致：群里真的收到了。
2. **同一道自言自语闸**：跨群文本在发送前过 `looksLikeSelfNarration`——否则模型可能
   把思考过程发到群里（工具参数塞思考是发生过的）。

**测试**：`test/cross-conversation.test.mjs`（6 项）：提示段（私聊才注入、列出精确
participantId 与群名、带「承诺 ≠ 已发」「不要想象观众反应」）、未启用/白名单外不注入、
带 target 真的发到群里并记录（含"常规路径仍延后发送"的对照）、未知目标拒绝、
每轮上限与跨回合归零、自言自语拒绝。

---

## 十二、覆盖度收尾：逐版分类（rc1–rc24 全量）

> 这份表是「目标是否达成」的证据：**上游 rc1–rc24 的每一条都被分类过**。

| 版本 | 结论 | 说明 |
|---|---|---|
| rc1 健康面板 / 行为回归测试 | ✅ 已移植（健康面板） / N/A（需真实 API 的行为测试） | `lib/health.js` + `/interlude status` 健康段 |
| rc2 七项审计（含 schema 默认值对齐、计数后移） | ✅ 已移植 | 条目 35 / 时间窗 45；`reachedOut` 只在投递成功后自增 |
| rc3 管理员注记语义 + 防截断 | ✅ 已移植 | 见第十节 |
| rc4 六项（fact `lastSeenAt`、注记预算上限、计数、健康上报…） | ✅ 已移植（前两项）/ N/A（侧端健康上报依赖侧端任务通道） | 侧端任务通道在 DSH 未接线，已在 §三 说明 |
| rc5 打字表达参照 | ✅ 已移植 | 见第十节（rc5/rc7 提示词） |
| rc6 合并转发读取 | ✅ 已移植（含接线） | 见第八节 |
| rc7 线上视觉表达提示词 | ✅ 已移植 | 贴图元语言规则 |
| rc8 / rc9 群聊不完整 interaction 结构兼容 + 重新打包 | N/A | 上游是 JSON `interaction` 结构的兼容层与打包修复；本仓用 `interlude_say` 工具调用发言，**没有该 JSON 结构**，也没有对应的打包链 |
| rc10 / rc11 私聊回合跨群投递 | ✅ 已移植 | 见本节（rc11） |
| rc12 Anthropic 双协议 + 群音频直达 | N/A（协议）/ 部分（群音频依赖宿主的原生音频通路） | 宿主管 provider 与传输；群里语音走 DSH 入站清洗的 `[语音]` 事实占位 |
| rc13 十一项缺陷 | ✅ 全部核对完毕（4 修复/等价 + 6 N/A） | 见第九节 |
| rc14 模型特化 | ✅ 推断层 + 家族块（length 块与 JSON 合约半 N/A） | 见第十一节 |
| rc15 Gemini 兼容与提示词中性化 | 部分等价 | `normalizeInteraction` 宽容化属 JSON interaction → N/A；提示词中性化与"反锚定句"已由 rc5 的常驻基线覆盖 |
| rc16 传输协议回退 + 清库在途屏障 | N/A | 传输协议层（本仓无 JSON 合约）；清库 30 秒屏障对应 SQLite 清库动作，本仓 JSON 状态不需要 |
| rc17 气泡分隔符负向规则 | N/A | 上游针对 `<sep/>` 分隔符教学；本仓分条语义是「一行一条」，无该分隔符 |
| rc18 连发同条数守卫 | ✅ 已移植（早前） | `lib/repetition-guard.js` |
| rc19 守卫默认值收紧 | ✅ 已等价 | 「拿不准时，就只发一条」 |
| rc20 严谨性清理 P0/P1 | N/A | 死代码删除 / 命名对齐 / TurnEngine 回流 / prepack bundle 防线——本仓是手写 JS、无 `src→lib` 构建链 |
| rc21 首条发言打字时间下限 | ✅ 已移植（含恢复打字模拟） | 见第六节 |
| rc22 群聊 interaction 形态容错 | N/A（提升逻辑） / ✅（重放去重） | `hoistParticipantlessInteraction` 是 JSON interaction 专属 → N/A；群消息重放去重本仓 `DedupeWindow` 已等价 |
| rc23 意愿档位 + 世界播种器 M1/M2 + 审计退避 | ✅ 已移植 | 见第三/四/七节 |
| rc24 播种器配置并入用途勾选 | N/A | 上游是「模型中心连接行勾选」的配置形态；DSH 无该 UI，本仓用 `worldSeeder.enabled` + 可注入执行器 |
| rc25 主动联系温度三模式 + proactiveDailyCap | ✅ **已移植** | 见第十四章（一） |
| rc26 / rc27 单剧本多通道 M0/M1 | N/A（后续评估） | 上游「一剧本多端点」是 SQLite 端点注册表 + 路由层；本仓一 bot 一私聊/群绑定，若需要多通道再评估 |
| rc28 DeepSeek V4.1 回复模式修复 + 播种器复读架构修复 | ✅ **已移植** | 见第十四章（二）（三） |
| rc29 ~ rc32 长线叙事催化器 / 群聊图片回流 / 计权契约 | ❌ 暂缓 | 全新子系统（Narrative Attractor）与视觉输入依赖侧端模型通道与多模态通路，本仓执行器注入点尚未接入宿主；后续按需评估 |
| rc33 投递幂等与桥接 ambiguous 语义 | ✅ **已移植**（幂等键部分） | 见第十四章（四）；桥接/worker 是桌面版专属 → N/A |
| rc34 权限拒绝可诊断 | N/A | `canManageSession` / `managerAccounts` / `interlude.doctor` 是 Koishi Console 权限体系；本仓命令无管理员白名单层 |
| rc35 剧本历史条目旋钮修复（硬地板移除） | ✅ **已移植**（且修复了更彻底的死键问题） | 见第十四章（五） |
| rc36 小模型换行分句开关 + 上下文三件套 | ◐ 部分 | `contextEntryLimit`/`contextTimeWindowMinutes` 已接回（见第十四章（五））；`convertNewlineToSeparator` N/A（本仓分条语义是「一行一条」，无需换行→分隔符转换） |

**结论**：上游清单里**可移植的能力全部已移植并有测试**；其余项要么是
**架构差异型 N/A**（宿主管 provider/传输、无 JSON interaction 合约、无 SQLite/构建链），
要么是**已等价的既有实现**（repetition guard / DedupeWindow / 消息感知 / purge）。
没有「未分类」或「知道该做但没做」的遗留项。

> 2026-10 批次补充：rc25–rc36 已按上表分类完毕，五项高优先级能力移植完成
> （详见第十四章），无新增「未分类」项。

---

## 十三、验证基线

每一项移植都必须：新增对应测试 → 跑全量 `npm test`（含承重验证 `test:loadbearing`）
→ 同步 `.publish-snapshot`（脱敏 + 保持 `test:live` 差异）→ 推送 GitHub。

---

## 十四、2026-10 批次：rc25–rc36 五项高优先级移植

> 参照物：上游 Gitee 仓库的两个 collapsed 提交（rc28 @ `cc3452d`、rc36 @ `46190cb`，
> 本地临时 tag `_tmp_upstream_rc24` / `_tmp_upstream_rc36`）。rc25–rc35 逐版语义
> 从 rc36 的 `docs/CHANGELOG.md` 与 `src/` 逐段核对。

### （一）rc25：主动联系温度三模式 + proactiveDailyCap

上游把 `allowProactiveMessages` 拆成 `contactMode: strict|natural|balanced` 三档：
strict 只认硬事实动机；natural 承认「想念/好奇近况/想分享此刻」也是合法动机
（但必须体现在剧本里，安静仍然合法）；balanced 在 natural 之上加「情感动机须节制」。
配套 `naturalMinimumIntervalMinutes`（默认 30）——natural/balanced 下把主动联系
安全间隔从普通 `minimumProactiveIntervalMinutes`（60）缩短到该值（仅当更小时生效，
取 min 语义）。`proactiveDailyCap` 支持 0=不限。

| 上游 | 本仓落点 |
|---|---|
| `Agency.contactMode` 三值 + 默认 strict | `lib/schema.js` + `lib/agency.js`（`DEFAULT_AGENCY_CONFIG` 对齐） |
| `naturalMinimumIntervalMinutes`（0–10080，默认 30） | 同上；`evaluateAgencyCapacity` 的间隔逻辑按档位切换（`min(普通, natural)`，仅 natural/balanced 生效；strict 字节不变） |
| 情感动机教义（strict 无 / natural 两行 / balanced 三行） | `lib/render.js` `renderRules` 联系基线块 + `renderStatus` 联系温度显示行 |
| `proactiveDailyCap` 0=不限 | `lib/index.js` `proactiveMaxPerDay(cfg)`（floor，接受 0）+ `quotaUnlimited(cfg)`；`handleProactive` / `storyMessageGate` / `decideAdvanceDelivery`（0 → `Infinity`）三处配额闸统一；面板输入 `min: 0` + 状态卡「2 / 不限」显示 |

**测试**：`test/contact-mode.test.mjs`（10 项）：schema 三值与默认、间隔档位切换
（含 min 语义不放大）、承诺型照旧绕过、容量硬门不受温度影响、三档教义渲染差异、
状态卡温度行与「不限」显示。

### （二）rc28：DeepSeek V4.1 回复模式修复（EXTRA_DEEPSEEK / TRANSPORT IS PER-TURN）

上游为 deepseek 家族追加家族块：V4.1 会把「上轮没调发言工具」误学成惯例
（历史消息是当年发出的，不带本轮的传输形态），导致连续漏发。核心三句：
**发送通道每回合独立；历史不带工具调用形态，是历史不是模板；决定不说是选择不是惯性。**

本仓等价失败模式是「写了正文但没调 `interlude_say`」（修过两次：cbc642c
advanceMode→speak、salvageBodySpeech 兜底），所以家族行按本仓口径重写，
钉住同一组语义点。`lib/specialization.js` 的 `familyOverrides()` 新增
`case 'deepseek'`（`extraAfterPhase`）。

**测试**：`test/specialization.test.mjs` 扩展（10 项）：deepseek 行覆盖三个语义点
（「每回合独立」「不是模板」「interlude_say」「不要因为最近几轮没调用…」「安静结束」）。
上游 `normalizeInteraction` 宽容化半边 N/A（无 JSON interaction 结构）。

### （三）rc28：世界事件复读架构修复（反馈环切断 + 切面轮换 + 去重视野）

上游根治「播种器复读」（用户实测同一通知 4 连换皮）：① **反馈环切断**——
载荷的紧凑摘录不再包含 world-event 条目（自己播种的事件不该成为自己的灵感）；
② **切面轮换**——`WORLD_SEED_DOMAINS` 六个世界切面（nature/dwelling/livelihood/
close-people/paths/chance），按 `(storyId, 时间槽)` 确定性轮换，相邻两轮必不同，
提示词追加 `THIS RUN'S SLICE OF THE WORLD`（切面是世界的一面不是题材，禁止
搬入现实机构）；③ **去重视野**——去重窗口纳入**排期中**（scheduled）事件的摘要。

| 上游 | 本仓落点 |
|---|---|
| `WORLD_SEED_DOMAINS`（6 切面，逐字） | `lib/world-seeder.js` 导出 |
| `seedDomainForRun(storyId, slotStart, cadence)`（hash×31+crc 种子 7，`Math.imul` 溢出安全） | 同上（逐字对齐） |
| 切面提示词行（label/brief + 反类型化约束 + 空数组出口） | `worldSeederSystemPrompt(domain)` |
| 载荷排除 world-event + `thisRunSlice` | `buildWorldSeederPayload(domain)` |
| 去重窗口 = scheduled + injected | `planWorldSeederSweep().scheduledSummaries` → `lib/index.js` `dedupeWindow`；已采纳草稿的摘要**可变地**并入后续采纳判定（`recentSummaries` 数组复写） |

**测试**：`test/world-seeder.test.mjs` 第 F 节（5 项）+ 既有 M1/M2/E2E 全绿（16/16）。

### （四）rc33：投递幂等（业务幂等键跨投递尝试去重）

上游 P1-1：桌面 worker 30s 超时后用**新 deliveryId** 重发，而「上游已收、回执迟到」
时用户收到重复消息。修复：每条出站消息带**重试间稳定**的业务幂等键
（`scriptEvent.eventId:bubbleIndex`），宿主 outbox 据此跨 deliveryId 去重。
口径：**宁可少发一条，不给用户重复消息**（歧义即视为已送达）。

本仓等价场景：主动投递部分成功后 `pendingText/pendingRemaining` 续发同一段内容——
若失败原因是**歧义**（超时/未确认，消息可能已到 QQ），已确认送达的气泡会被重发。

| 上游 | 本仓落点 |
|---|---|
| 业务幂等键（重试间稳定） | `lib/qq-im/outbound.js` `deriveItemKeys`：`intentPrefix:序号` 锚定**整批**（`baseIndex`），续发用上一轮保存的原键（`remainingKeys` 优先，键不足一律空串——**绝不猜键**，猜键会与首轮碰撞误拦） |
| 宿主 outbox 跨 deliveryId 去重 | `DeliveredIntentWindow`（TTL 6h、容量 500，与入站 `DedupeWindow` 同形态、方向相反）；`channel.js` `sendToTarget` 挂窗口，`intentPrefix` 存在才启用（其他调用方零改动） |
| 确认送达 / 歧义失败 | `deliverMessages`：确认 → `mark` 入窗；歧义失败（`isAmbiguousDeliveryError`：未确认/超时/无错误码）→ 在发条目**保守标疑似已送达**；确定失败（结构化错误码/no-target/cancelled）不标，重发安全 |
| 键透传 | `lib/index.js` `deliverToIm({intentPrefix, remainingKeys})` → `sendToTarget`；主动路径以 `target.id` 为前缀；失败时保存 `pendingRemainingKeys`，续发**直传条目**（不再 join 重分条，避免键错位）；成功/放弃时清键 |

**测试**：`test/delivery-idempotency.test.mjs`（9 项）：歧义判定表、键推导三优先级
与「键不足不猜」、窗口 TTL/容量、确认入窗、窗口命中不真发但计入 sentCount、
歧义标疑似已送达→续发被拦（rc33 要堵的重复消息）、确定失败不误拦、无键调用方
字节不变、取消不标。既有 `test/qq-im/outbound.test.mjs`（15 项）全绿证明向后兼容。

### （五）rc35：剧本历史条目旋钮修复（硬地板移除 + 死键接回）

上游 rc35：`recentEntriesForPrompt` 里 `Math.max(35, …)` 硬地板（M4.1 引入）使
`contextEntryLimit` 调到 35 以下**静默失效**，小模型无法收缩历史上下文。修复后
预算判定抽为纯函数 `resolveScriptContextBudget`：条数下限 1、默认 35、上限 200；
时间窗 0–1440、默认 45；条数闸与时间窗闸**取并集**（连发可超名义条数而不挤掉
同一小时里更早的话）。

**本仓的问题更彻底**：`contextEntryLimit` / `contextTimeWindowMinutes` 两个键在
0.1.4-beta3 时曾消费（`recentEntries(storyId, config.runtime.contextEntryLimit)`），
重写后消费点全部丢失——是**没有任何读者的死键**，调大调小都无效果。

| 上游 | 本仓落点 |
|---|---|
| `resolveScriptContextBudget`（rc35 纯函数，无地板） | `lib/script-entry.js` 同名导出；「没传」与「显式 0」分开（0 分钟=关闭时间窗是合法值；条数 0/非法 → 回默认 35） |
| `recentEntriesForPrompt`（count ∪ 时间窗，500 上限，id 升序） | 同上；墓碑（redacted）不进入 |
| 消费点 | `lib/index.js` 两处接回：① `interlude_memory` 认知证据候选窗口（原 `.slice(-20)`）；② 世界播种器历史窗口（原写死 `.slice(-24)`）。上游的 agency 证据窗口（`Math.max(40, limit*2)`）对应本仓 `agency.js` `sourceEntryIds.slice(-20)`，暂保持独立口径 |
| schema/面板 | `lib/schema.js` 默认值对齐上游（35/45）+ 描述重写（叠加语义、无地板）；`lib/client.js` 面板标签改为「历史上下文条数闸/时间窗」 |

**测试**：`test/context-budget.test.mjs`（7 项）：默认与缺字段、调小到 1 真的生效
（rc35 核心语义）、上限夹取、显式 0 关闭时间窗、条数闸/并集/升序、墓碑排除、
防御。`test/client-panel-coverage.test.mjs` 标签同步更新。

### rc25–rc36 其余项分类（N/A / 暂缓 / 部分）

| 上游项 | 结论 | 理由 |
|---|---|---|
| rc26/rc27 单剧本多通道 M0/M1（端点注册表、按账号路由） | N/A（后续评估） | 需 SQLite 端点表 + 多通道路由层；本仓一 bot 一绑定，若需要再立项 |
| rc28 单剧本多通道 M2/M3/M4 | 同上 | 同为多通道架构 |
| rc29 桌面端 QQ 数字/微信/OneBot 账号 | N/A | 桌面 worker 专属 |
| rc30 Qzone 增量提交 | N/A | 上游 Qzone 端点专属 |
| rc31 Narrative Attractor Phase 0-3（长线叙事指导） | ❌ 暂缓 | 全新子系统，依赖侧端模型通道（`useForCompaction` 类连接勾选）与持久化状态表；本仓执行器注入点尚未接入宿主，见 §四「排水开关」同款约束 |
| rc32 催化器阈值调整 | 同上（随 rc31） | |
| rc33 桥接 ambiguous 语义 / worker 崩溃诊断 / 日志留存 | N/A | 桌面 worker 进程模型专属；本仓无 worker |
| rc33 Qzone 增量一致性 / 贴纸宿主代理 / OneBot 多通道校验 | N/A | 同为桌面/多通道专属 |
| rc34 权限拒绝可诊断（manageSessionDenialReason） | N/A | Koishi Console 管理权限体系（`canManageSession`/`managerAccounts`）；本仓命令无该白名单层 |
| rc36 `convertNewlineToSeparator` | N/A | 上游是「模型没输出 `<sep/>` 时把换行当气泡边界」的补救；本仓分条语义本来就是「一行一条」，无需转换开关 |
| rc36 `contextTimeWindowMinutes` | ✅ 随 rc35 一并接回 | 见（五） |

### 本批次验证

- 新增测试：`contact-mode`（10）/ `delivery-idempotency`（9）/ `context-budget`（7）
  + `specialization`、`world-seeder`、`client-panel-coverage` 扩展。
- 全量 `npm test` exit=0；`test:loadbearing` exit=0（其中 4 个 FAIL 是**刻意的反例
  验证**——拆掉机制后用例必须变红，基线与移植后行为一致）。

---

## 十五、2026-10 第二批：rc48 / rc50 移植

> 参照物：上游 `1.0.1-rc50`（2026-10-11，tag `1.0.1-rc50` @ `bb3be3a`；本地临时 tag
> `_tmp_upstream_rc50`）。区间 rc37–rc49 被压进同一提交（无独立 changelog 条目），
> 逐项语义从 rc50 的 `docs/CHANGELOG.md`、`development/FULL_CODE_REVIEW_FIXES_2026-10-11_RC48.md`
> 与 `src/` diff 核对。区间规模：115 文件 / +13109 / −1762（src 27 文件 +3234/−762）。

### （一）rc50：跨夜日程午夜后消失 + 今天的计划被未来阶段挤掉

Schedule Preplan 的两个保留缺陷（`src/schedule-preplan.ts`）：

1. **跨夜安排午夜后消失**：`materializeSchedulePreplan` 从 `offset = 0`（只物化今天）
   开始，值夜班（23:00–次日 07:00）/通宵出行在今天凌晨**从日程里凭空消失**；
   `schedulePreplanWindow` 又只接受 `dayOffset 0..1`，昨日段的剩余区间同样进不来。
2. **今天的计划被未来阶段挤掉**：`regimes.slice(-6)` 按**数组末位**截断——模型新排
   一条未来阶段，就把今天的阶段挤出保留集；exceptions 的 `slice(-30)` 同理。
3. 附带：空提议判定 `!regimes.length` 会把「只有一次性安排」误判成空提案整批丢弃
   （一次性安排住在 exceptions 里）。

| 上游 | 本仓落点（`lib/preplan.js`） |
|---|---|
| `materializeSchedulePreplan` 从 `-1` 起物化 | 同（昨日跨夜段进入物化结果） |
| `schedulePreplanWindow` 放宽到 `dayOffset >= -1` | 同（早已结束的昨日块由块级 start/end 比较自然过滤） |
| `retainSchedulePreplanRegimes`（逐日找生效阶段 + 未来阶段 6 个名额） | 同（新增私有函数）；取代 `regimes.slice(-6)` |
| `retainSchedulePreplanExceptions`（窗口内全留 + 窗口外 6 个） | 同；取代 `slice(-30)` |
| 空提议判定加 `&& !exceptions.length` | 同 |

**测试**：新增 `test/preplan-retention.test.mjs`（8 项）——跨夜段进入凌晨窗口、
昨日已结束的普通块不渗入、新加未来阶段不挤掉今天、未来阶段上限、过期阶段被裁、
今天的例外不被挤掉、只有一次性安排不算空提议、真·空提议落结论。
既有 `logic.test.mjs` 与 `preplan-materialization-lag.test.mjs` 的物化天断言同步
（现含昨日，`days[0]` → 按 `date` 查找）。

### （二）rc50：Alter 分析消费语义（不再吞掉分析期间的新分数）

上游缺陷：分析要**异步**跑一趟侧端模型，触发时记下快照；分析期间用户还在说话、
累计还在涨——旧实现回来时无条件 `alterValue = 0`，**把分析没看过的新分数一起吞了**；
且一次过期结果仍会占满 5 分钟冷却期，期间新分数攒够也审不了。

上游修订：`completeAlterAnalysis` 加 `analyzedValue` 入参，只扣掉被消费的那份
（`clamp(alterValue - triggerValue)`）；应用前复核快照（反向或跌回阈值下 → 整份丢弃、
一分不消费）；新增 `clearAlterScopeAnalysisAttempt` 让未消费的 scope 可再次被审。

**本仓形态差异（如实记录）**：本仓的底色是**同步**产生的（`interlude_alter` 的
`note` 直接就是底色描述，没有侧端模型往返），所以「分析期间新累积分数」在结构上
不可能发生。仍按上游形态实现，理由是：① 只消费快照不整片清零是更精确的契约
（同步路径下两者结果相同），将来若接入异步分析不必再改；② 过期复核 +「没消费
就不占冷却」把边界写进函数而非靠调用方自觉。

| 上游 | 本仓落点（`lib/alter.js` + `lib/index.js`） |
|---|---|
| `completeAlterAnalysis(..., analyzedValue?)` | 同（第 6 个可选参数；缺省 = 消费当前全部） |
| 只消费快照 `clamp(alterValue - triggerValue)` | 同 |
| 快照过期 → 原样返回、不消费 | 同（**返回同一对象引用**，作为「未生效」的信号） |
| 零值不造底色 | 同（旧实现会把 `0` 判成 `relaxed`，凭空生成一个方向为 0 的底色） |
| `clearAlterScopeAnalysisAttempt`（未消费则不锁） | 本仓等价物：`alterAnalysisApplied(before, after)` 引用比较；`index.js` 只在真的消费了才写 `lastAnalysisAttemptAt`，否则回复「未消费任何分数」 |

**N/A（本仓无对应结构）**：上游同批修的 `normalizePendingScopes` 容量饥饿
（固定 `slice(0, 32)` 让先到的零值 scope 永久占位，挤压新建参与者/独立生活 scope）
——本仓 Alter 是**单 scope**（state 顶层 `alterValue`，无 `pendingScopes`、无
`participantId` 维度），不存在多 scope 淘汰，故不适用。

**测试**：`test/logic.test.mjs` 扩展（+4 项）：生成底色并消费累计、只消费快照不吞新分、
快照过期整份丢弃、零值不造底色、`alterAnalysisApplied` 判据。

### （三）rc50：全局事实主体澄清

上游口径：长期事实是**全局叙事材料**，可能出现在任何对话上下文里；靠
`participantId` 标"这条关于谁"是存储层思路，投影进提示词只会诱导模型把人物身份
理解成隐藏字段，而正文里依旧写着「他说他准备出门」，换个人读就指代不明。
修订：契约要求事实**自带主语**（「小林说他准备出门」合格，「他说他准备出门」不合格），
`factEvidenceForPrompt` 不再投影 `participantId`，是否显露由叙事模型决定。

本仓事实本就是全局的（`rankFacts` 不按 `participantId` 过滤、`renderFacts` 全量渲染），
所以落点是**措辞与字段**，不是隔离逻辑。

| 上游 | 本仓落点 |
|---|---|
| `factEvidenceForPrompt` 去掉 `participantId` | `lib/knowledge-evidence.js` 同 |
| 「Facts are global narrative evidence…name that person explicitly」 | `KNOWLEDGE_WRITING_FRAME` 追加中文契约（含合格示例与不合格反例） |
| 事实 JSON 契约 `content` 改为 "self-contained fact with any related person named explicitly" | `interlude_memory` 工具 `content` 参数描述同步改写 |

**测试**：新增 `test/rc50-batch.test.mjs` 中「全局事实主体」3 项。

### （四）rc50：情节索引检查点查找优化

`buildEpisodeIndex` 原为每行对检查点做一次线性 `find`（O(条目数 × 检查点数)）。
上游改为：检查点**互不重叠**时按 `firstEntryId` 排序后**二分**（O(log n)）；
一旦重叠就**退回**原 first-match 线性扫描——重叠意味着语义本身有歧义，二分只认
「最后一个 `firstEntryId <= id`」会改变选中结果，正确性优先于速度。

本仓 `lib/episode-index.js` 抽出 `makeCheckpointLookup(checkpoints)` 实现同语义，
`buildEpisodeIndex` 主体不变。

**测试**：`test/rc50-batch.test.mjs` 4 项（不相交分组、区间外单点锚、**重叠时保留
first-match**、无检查点按 frameId、空/损坏输入）。

### （五）rc50：DeepSeek 家族行收窄

上游把 `EXTRA_DEEPSEEK` 的适用范围收窄为「可承载回复的回合」（user-message /
conversation-follow-up / intent-due），并明确自主生活推进回合**本来就不带传输**
——除非这一轮真的发了消息。理由：原措辞会让模型在「没话可说」的推进回合里硬凑
一句，与「安静的出口」相冲突。

本仓 `lib/specialization.js` 的 deepseek 家族行同步收窄（「本轮若确实要对她说话」
才必需；自主推进回合豁免），原有语义点（每回合独立 / 不是模板 / 安静是选择）全部保留。

**测试**：`test/rc50-batch.test.mjs` 1 项 + 既有 `specialization.test.mjs`（9 项）全绿。

### rc50 其余项分类（N/A / 暂缓）

| 上游项 | 结论 | 理由 |
|---|---|---|
| 端点在线状态（Satori `Status.ONLINE` 枚举） | N/A | 本仓自建 QQ 通道，无 Satori/Koishi 端点注册表 |
| 已提交 pending 消息补偿（`metadata.deliveryActions` 恢复） | N/A | 上游是 SQLite 剧本行 + 桌面 worker 的补偿扫描；本仓投递重试走 `pendingText`/`pendingRemaining` + 投递幂等窗口（见第十四章四） |
| 分段气泡与补写互斥（`split-message` pending 检查） | N/A | 上游分段链持久化于剧本元数据；本仓分条是一次调用内的同步循环，无跨轮 pending 分段链 |
| 僵尸承诺退役（`expiresAt`、五次顺延上限） | ◐ 已等价 | 本仓 `lib/intent-lifecycle.js` 的到期顺延与上限逻辑已覆盖；语义细节见该模块注释 |
| 统一发送与成功确认入口 | N/A | 上游是多条投递路径（私聊/群/分段/补偿/实验早发）收敛；本仓出站只有 `deliverToIm` → `qqIm.sendToTarget` 一条 |
| 已接受结果与持久化失败分离 / purge 世代 | N/A | 同上（上游账本写在剧本行内，本仓写 state JSON） |
| 后台整理读取本剧本原文 | N/A | 本仓无后台压缩整理管道（DSH 宿主自己管 compaction） |
| 关系证据跨检查点衔接 / 整理合约日志对齐 / 整理提交完整性（SQLite 事务） | N/A | 同上；事务与回滚是 SQLite 专属 |
| 兼容端点 DeepSeek `thinking` 开关 | N/A | 本仓不组装模型请求（宿主管 provider 与路由） |
| 模型分配与维护路由 / 流式 SSE / 代理（`http-proxy.ts`） | N/A | 同上 |
| 历史图片回源失败日志分层 / 群聊历史图片回流 | N/A | 本仓无素材库与历史图片回流管道 |
| 入站去重（落库后登记 + 记 bot selfId） | ◐ 已等价 | 本仓 `lib/qq-im/inbound.js` 的 `DedupeWindow` 已按 messageId 去重（rc23 审计时对齐）；selfId 维度的跨账号冲突在本仓单 bot 绑定模型下不出现 |
| 任务与并发容器修复（作品任务/wake busy/browser 槽） | N/A | 上游 scheduler/works/browser 专属 |
| 恢复与历史导航（分页扫描、二分 checkpoint） | ◐ 部分 | 索引侧二分已移植（见（四））；恢复扫描是 SQLite 分页专属 |
| 群上下文与冷却（先筛目标群再截窗口） | N/A | 本仓会话状态按 key 隔离，群/私聊不共享条目表 |
| rc48 分享码同步（`share-sync.ts`，410 行） | N/A | 本仓无分享码/预设同步功能，也无清库重建流程 |
| rc31/rc32 Narrative Attractor（含 rc50 的 `long-arc.ts` 增量） | ❌ 暂缓 | 全新子系统，依赖侧端模型通道与持久化状态表；与前批结论一致 |

### 本批次验证

- 新增测试：`preplan-retention`（8）/ `rc50-batch`（9）+ `logic`（+4）。
- **补链**：发现 `package.json` 的 `test` / `test:full` 是**显式枚举文件**的，本轮与
  上轮新增的 5 个测试文件（`contact-mode` / `delivery-idempotency` / `context-budget` /
  `preplan-retention` / `rc50-batch`）此前**都不在链上**——`npm test` 通过并不代表
  它们被跑过。已全部补入两条链（这是验证基线的真实缺口，记此备忘）。
- 全量 `npm test` exit=0；`test:loadbearing` exit=0。

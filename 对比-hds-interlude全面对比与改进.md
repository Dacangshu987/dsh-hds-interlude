# dsh-hds-interlude vs hds-interlude 全面对比

> 参考实现：<https://github.com/euphoriaaaaaa1/hds-interlude>（Koishi 插件，v0.1.4，11,404 行 TS）
> 本实现：`dsh-hds-interlude`（DSH 插件，5,261 行 JS）
>
> 两份深度分析作为附录：
> - `prompt-architecture-report.md`（提示词/载荷架构，56 KB）
> - `reference-runtime-report.md`（运行时/投递/调度，66 KB）
>
> 本文是结论汇总与本轮**实际落地**的改动。

---

## 一、规模与结构对照

| | 参考（Koishi） | 本实现（DSH） |
| --- | --- | --- |
| 源码规模 | 11,404 行 | 5,261 行 |
| 最大文件 | `service.ts` 6,451 行 | `index.js` 1,895 行 |
| 持久化 | 13 张 SQLite 表 | 每会话一个 JSON 文档 |
| 谁组装请求 | **它自己**（拼 JSON 直发） | DSH 宿主 |
| 系统提示词 | **~15,000 字符，每轮回滚重建** | ~1,700 字符，**每会话注入一次** |
| 载荷 | 32 个顶层字段（另有 31 键的缓存优化序） | 一个 `<幕间>` 块，≤7 行 |
| 结构化输出 | 4 层强制 + 容错解析 + 语义恢复 | **无** |
| 字符预算 | 每字段独立上限（合计 ~45,000 字符/轮） | **无** |
| 投递 | 持久化队列、逐段状态机、原文重试 | 单次 best-effort 调用 |
| 压缩 | 自建（16 条 / 10000 字符触发） | 交给 DSH（合理） |

**一句话**：它是一个**自己拥有模型调用与上下文的完整系统**；我们是一个**挂在宿主上下文里的注入层**。
这个差别决定了它能做的很多事我们做不到——但也意味着它的**状态机与不变量**可以整套搬过来。

---

## 二、这些差别意味着什么（不是「它更好」，是「它控盘」）

它的优势**不是提示词更长**，而是**提示词、载荷、校验器共享同一套词汇**：
合约里点名的字段（`currentEvent.type is none`、`agencyWindow`、`interaction.reply.mode`）
在载荷里真实存在、受阶段约束、从 JSON 信封解码、并由校验器检查——
不一致时**丢弃整份草稿重问一次**。

我们只能往宿主上下文里**追加消息**（`agent/pre-step` 返回 `{...decision, messages: [...]}`），
既不能设 `response_format`，也不能重排载荷。所有下游差异都从这一条派生。

---

## 三、本轮**已经落地**的五项改进

### ① 投递失败重试不再重新生成内容（P0，最重要）

**问题（我们真实存在的缺陷）**：`deliverImChunks` 在部分失败时只返回 `sentCount`，
**丢掉未送出的尾部**；调用方把待办放回 `pending`，下一轮扫描**重新唤起模型**。
后果三条：又花一次全量上下文（该会话每轮 ~15k token）；模型写出**不一样**的话；
若上一轮已送出一部分，用户看到「前半句旧版本、后半句新版本」的错位。

**参考做法**（`service.ts:2525-2531`）：把已决定的每条消息**先落库成 intent 行**，
失败时 +30 秒重发**同一段文字**，模型不再参与。

**改动**：
- `lib/im.js`：失败时返回 `remaining: list.slice(index)`（未送出的原文）；
- `lib/index.js` `deliverToIm`：透传 `remaining`；
- `lib/index.js` `handleProactive`：失败时把 `pendingText` / `pendingRemaining`
  存进待办；下一轮**先检查有没有草稿**，有就直接重发，**不唤起模型**。

**验证**：`test/proactive-cold.test.mjs` 新增 1 条；`verify-delivery-resume-loadbearing.mjs`
证明拆掉这个机制会变红。

### ② 休息时段从「停掉」改为「拉长」

**问题**：我们原先在休息窗口内直接 `return`，于是 23:00–07:00 整段静止，
第二天早上要么什么都不记得，要么一次性补写一大段「昨天夜里……」。
**参考做法**（`service.ts:6760`）：窗口内返回 `randomInteger(min, max)`（默认 120–240 分钟）——
**低频而不是静止**。

**改动**：新增 `restIntervalFor()`，读窗口的 `min/maxIntervalMinutes`；
未配时退化成「普通间隔 ×3，至少 60 分钟」。

**验证**：新增 1 条用例，含**对照组**（窗口放宽到 10 分钟后应当续写），
避免「因为别的原因没跑起来」造成的假绿。

### ③ 推进抖动改成对称（修掉一个系统性偏差）

**问题**：原式 `interval + Math.random() * jitter` **只可能变长**，
平均白等 `jitter/2`（默认 5 分钟 → 每轮晚 2.5 分钟）。
参考用的是对称的 `randomInteger(min, max)`。

**改动**：`interval + (Math.random() - 0.5) * jitter`。

### ④ 提示词补三条从参考移植的规则

| 规则 | 来源 | 解决什么 |
| --- | --- | --- |
| **幕间块的时间是唯一权威** | `narrator.ts:1487` | 模型被自己更早写过的 prose 带偏（幕间说下午，它接着写「夜深了」）。**我们原先没有任何一句交代谁说了算。** |
| **不要凭空造外部事件** | `narrator.ts:1506-1507` | 「手机震了一下」「有人发来消息」——模型爱给「安静的一轮」编转场。我们的场景更容易犯。 |
| 想起某人须写成「不确定」 | 同上 | 不能把猜测写成已发生 |

### ⑤ 长期事实改成按得分排序（修掉「按插入顺序取前 N 条」）

**问题**：我们的「检索」是 `state.facts.filter(...).slice(0, memoryLimit ?? 20)`——
**按插入顺序取前 N 条**。`importance` 字段一直在写，但**从不参与选择**；
于是「三天前随口说的小事」会挤掉「上周那条要紧的承诺」。

**参考做法**（`service.ts:6687`）：

```
score = importance×0.5 + confidence×0.35 + recency×0.15
      + semantic×0.55 + unresolved(promise)×0.2
recency = exp(-ageDays / 30)
```

**改动**（`state.js` 新增 `rankFacts`，`/interlude context` 改用它）：
- 实现前四项纯计算；
- 新增 `lastSeenAt` 字段——时间衰减用它而不是 `createdAt`，
  「三个月前写下、昨天又提起」仍然是新鲜的；
- **不加权 `semantic` 项**：那需要 embedding，DSH 侧不具备。
  给 0 分会把每条事实均等地压低，排序结果与不加完全一样，只是多了个误导性权重。

**验证**：`test/logic.test.mjs` 新增 6 条，其中 3 条（重要度 / 承诺权重 / 时间衰减）
经确认在旧实现下确实变红。

---

## 四、**值得做但本轮没做**的（按价值排序）

### P1 — 状态写入串行化 + 错误不再静默

**参考**：全局写队列 `databaseWriteQueue`（`service.ts:509`），每次写入链到同一个 promise 上；
`retryDbWrite` 重试 7 次（`[100,250,500,1000,2000,3000,5000]` + 抖动）。

**我们**：`saveState` 是 **bare `catch {}`**（`state.js:134-136`）——**静默丢失**；
并发扫描（`Promise.all`）+ 工具处理器可能对同一 key 做并发读改写，
`inFlight` 只挡扫描入口，**不覆盖工具路径**。一次丢写可能丢掉 `delivered` 标记 → 重复投递。

**建议**：进程内每 key 一个写队列 + 失败告警（不重试 7 次那么多，但至少别静默）。

### P2 — 叙事失败的有界重试

**参考**：模型返回「合法但空白」的结果时**当作 provider 失败**，
因为成功会推进 `cursorAt` 并**永久跳过那段时间窗**；重试预算是 6 次 × 60 秒（`service.ts:3633`）。
**我们**：没有任何重试预算——一次空返回就白丢一轮。

### P3 — 证据门控的 overlay 演化

**参考**：`statePatchMinEvidence: 3` / `minTurns: 3` / `minDays: 2` / `cooldownHours: 72`（`service.ts:4531-4534`）。
**我们**：`upsertOverlay` 任何提案都**立即生效**，只带一个 `evidence` 计数器。
角色人格会漂移。**这一条不依赖摘要模型，可以独立于「压缩交给 DSH」的决定单独做。**

### P4 — 打断时的内容续接

**参考**：取消待发段时把文本**带下去**，让角色能把话说完（`service.ts:3960-3973`）。
我们直接丢。

### P5 — 事实检索排序（我们的 `/interlude context` 是 `.slice(0, N)`）

> ✅ **本轮已完成** —— 见上文「三、⑤」。

**参考**（`service.ts:6687`）：

```
score = importance×0.5 + confidence×0.35 + recency×0.15
      + semantic×0.55 + unresolved(promise)×0.2
      recency = exp(-ageDays / 30)
```

**改动前**：`state.facts.filter(...).slice(0, memoryLimit ?? 20)`——**按插入顺序取前 N 条**，
重要度/置信度衰减/时间衰减全都没用上。`interlude_memory` 写了 `importance` 字段但**从不参与排序**。

**注意**：`semantic` 项需要 embedding，DSH 侧不一定好接；但前四项是纯计算，**已完成**。

### P6 — 追加式投递记录

当前只有 `lastImDelivery` 一条（**上一条**）。有了持久队列后需要能自检「哪几条送出去了」，
建议一个带上限的数组。

---

## 五、**明确建议不要做**的

| 不要做 | 理由 |
| --- | --- |
| 移植 13 张表 | 一个 JSON 文档足够；DSH 没有 `ctx.database` |
| 移植压缩 | DSH 有 `compaction/*`，重造是重复劳动（我们该做的是让它**能触发**） |
| 移植 OneBot / 群聊 / 表情包 / 视觉 | DSH 无对应物，`MIGRATION.md` 已逐项说明 |
| 移植 `blindMode`、浏览器观测 | DSH 原生有 `web_fetch` |

---

## 六、我们已经**优于**参考的地方（别被"对齐"改坏）

这两条是子代理明确标出的「do not fix」：

1. **重启恢复**：`delivering` 卡死回收（`index.js:1531-1540`）+ `STALE_INTENT_MS = 6h` 过期
   （`index.js:1543-1553`）——**参考项目没有对应物**。
2. **传输层**：每条独立超时、`AbortSignal.any` 组合、显式 `result.sent !== true` 确认
   （`im.js:276-278`）；分条器也比它丰富（语义边界 + 代理对保护）。
   我们缺的不是传输质量，是**发起调用的那个队列**。

另有两处虽小但确认不弱于参考：`scheduleIntentWake` 的最早优先 + 自愈重挂 + `2**31-1` 分片；
`STATE_VERSION` 版本闸（参考没有）。

---

## 七、还有一个**悬空字段**值得单独说

`state.continuity`：

- 被 `renderInterludeBlock`（`render.js:219`）和 `renderProactiveText`（`render.js:259`）**注入到提示词**；
- 但**没有任何工具写它**（六个 `interlude_*` 工具里没有），schema 里也没有这个配置；
- 唯一一次写入是 `/interlude purge` 把它清空。

也就是说：**它是一个永远为空的字段，却占着「连续性快照」这个位置**——
参考项目里对应的是 `previousScenes` / `continuitySnapshot`（由压缩模型维护，
是它三层记忆的中间层）。我们要么给它一个写入路径（比如并入 `interlude_memory`），
要么删掉它，别留着误导后来人。

---

## 八、小结

- 参考项目的核心竞争力是「**自己控盘**」：能定契约、能强制结构化输出、能按字符预算裁上下文、
  能重排以吃满前缀缓存。这些我们**结构上做不到**，也不该假装能做。
- 但它全套的**运行时工程**是通用的，而且我们这轮已经落了最值钱的一条：
  **投递失败重发原文而不是重新生成**（省一次全量上下文，且用户不会看到前后不一致）。
- 剩下最该做的是 **P1（写队列 + 别静默吞错）** 和 **P5（事实排序）**——
  两者都是纯计算、不依赖我们拿不到的能力。

改动全部有测试与承重验证；`npm test` 全绿。

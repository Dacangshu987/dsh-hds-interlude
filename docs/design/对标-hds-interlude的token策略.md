# 参考项目 hds-interlude 是怎么省 token 的 —— 以及我们的差距在哪

> 对照对象：<https://github.com/euphoriaaaaaa1/hds-interlude>（Koishi 插件，v0.1.4）
> 对照基线：我们的 `dsh-hds-interlude` + 线上会话 `session-58be9b68` 的实测数据。

## 根本区别：它自己调模型，我们不调

| | hds-interlude | dsh-hds-interlude |
| --- | --- | --- |
| 谁组装请求 | **它自己**（`narrator.ts` 拼一个 JSON payload 直接发） | DSH 宿主（我们只能插事件、改 `pre-step` 的消息） |
| 上下文来源 | **它自己维护的数据库条目**，每轮按预算挑选 | DSH 的会话日志，**全量重发** |
| 能做什么 | 任意裁剪、重排、分层、换小模型 | 只能决定「注入什么」，管不了「历史怎么发」 |

**一句话：它把上下文当成「自己可以切的一块料」，我们只能往 DSH 的上下文里追加。**
这决定了它能做的一些事我们做不到——但也决定了它有一整套办法值得我们抄。

---

## 它的六个省 token 手段

### ① 字符预算切分（最核心）

每类内容都有**独立的字符上限**，超了就从头截断：

```ts
// narrator.ts:1842 —— 从**最新往回**装，装到预算用完为止
function compactPromptEntries(entries, characterBudget, protectedSince?) {
  let remaining = Math.max(1_000, characterBudget)
  // ① 先钉住「受保护」的：最近 60 分钟内的真实收发消息，绝不截
  const protectedIds = new Set(entries
    .filter(e => protectedSince && e.occurredAt >= protectedSince && rawKinds.has(e.kind))
    .map(e => e.id))
  const selected = entries.filter(e => protectedIds.has(e.id))
  remaining -= 已占用的字符数
  // ② 剩下的预算从最新往回填，单条超预算就「保留尾部」并标 [前文截断]
  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) { … }
  return selected.sort(按时间)
}
```

各层的预算（`narrator.ts:1696-1720`）：

| 内容 | 字符预算 |
| --- | --- |
| 对话历史 `recentScript` | **12,000** |
| 长期事实 `durableFacts` | **8,000** |
| 记忆 `memories` | **6,000** |
| Overlay 演化 | 8,000 |
| 网页上下文 | 8,000 |
| 压缩模型单次读取 | 32,000 |

注意 `12_000` 这个数字：**它和 `contextEntryLimit: 50` 是两套并行的闸**——
「至少保 50 条」是下限，「最多 12000 字符」是上限，谁先到算谁。
所以历史再长，进 prompt 的部分也被钉死在 12k 字符（约 3~4k token）。

**它的注释写得很直白：**

> Keep the live request bounded even when old configurations contain very high
> context limits. **Stored entries remain untouched; only the copy sent over
> the wire is shortened.** This materially reduces both prompt upload time and
> model prefill latency.

——**存储不动，只砍发送的那一份。** 这是它能做到而我们不能做到的（DSH 的历史不由我们组装）。

### ② 前缀缓存重排（`cache-first`）

这是它**最聪明**的一招，也是唯一一招**不需要删任何内容**就能省钱的办法：

```ts
// 按「变异频率」升序重排 JSON 键
// 稳定区（跨轮逐字节一致）：setting → recentScript → durableFacts → memories
//                          → overlayEvolution → sceneContext → continuitySnapshot
// 每轮变化区（越靠后越接近生成点）：currentParticipant → participants → state
//                          → emotionalOffset → agencyWindow → currentEvent → recentExchange
```

背景（`docs/development/2026-08-31-payload-cache-first.md`）：

> legacy 顺序下 payload 以每轮变化的时间戳字段开头、对话历史垫底，
> **服务商前缀缓存永远无法命中——system 之后第一个 token 就分叉。**

还有几个细节很讲究：

- `continuitySnapshotAgeMinutes` 每轮都变 → **从快照旁边移到尾部**，否则每轮击穿缓存；
- 尾部新增 `recentExchange` 块（最多 3 条、1600 字符），把最近交互**重新锚定在生成点旁**，
  对冲「历史前置导致近因稀释」；
- JSON 键序不影响语义解析，**只移动 token 级注意力分布**——所以这是纯收益。

### ③ 分层压缩（异步，不占用户回合）

```
近期：原始剧本（受保护窗口内不压缩）
更早：场景摘要 + 剧情弧线 + 长期事实
```

默认在「**16 条未压缩条目** 或 **10000 字符**」达到其一就触发压缩。
压缩走 `useForCompaction` 指定的模型，**和主叙事模型分开**。

还有两个记忆载体：
- `previousScenes`：紧邻已关闭场景的摘要，**放在稳定区**（利于缓存）；
- `workingDetails`：取餐码这类小细节，默认 6 小时过期自然淡出。

### ④ 按任务分模型（`useForCompaction` / `useForAlter` / …）

```ts
useForCompaction: true    // 后台压缩
useForAlter: true         // 情绪分析
useForEmbedding: false
useForStickers: false
useForVision: false       // 侧端识图
```

后台活（压缩、Alter、日程审查、识图）**可以全部交给一个便宜模型**，
主叙事才用贵的。它甚至有一个专门的「轻度整理」路径：

> 已有计划覆盖充足且没有新剧本证据时，**程序直接保持原计划，不调用模型**。
> ……插件会保存「已审查、暂无线索」的空日程记录，**等待后续新的生活证据，
> 不会反复消耗压缩调用**。

——**没证据就别调模型**。这个「宁可不调」的默认，是很值钱的设计。

### ⑤ 图片降采样

```ts
vision.maxImageDimension: 1024   // 默认 1024，可选 0/512/768/1024
vision.detail: 'low'             // 多模态 token 更省
```

> 通过可选 Puppeteer 服务重渲染，**节省多模态 token 与上传时间**；
> Puppeteer 不可用或图片本身较小（<150KB）时自动透传原图。

### ⑥ 自建成本核算

它把缓存命中单独记账：

```ts
priceInput / priceOutput / priceCachedInput   // 每百万 token 单价
parseTokenUsage(usage) → { inputTokens, outputTokens, cachedInputTokens }
```

> 配置后每次模型调用会在日志中输出计费；缓存命中的输入按 `priceCachedInput` 计，
> **并单独报告「缓存节省」**。

——省了多少，是**看得见**的。

---

## 我们的现状：实测下来，有几条已经做到了，有两条差得远

拿线上会话的 40 次调用实测（`qq4.jsonl`）：

```
累计：新输入 127,638 / 缓存命中 284,288
缓存命中率：69.0%
```

**逐轮看，命中率是 86% → 97% → 突然 0% → 又回 99%：**

| turn | 新输入 | 缓存读 | 命中率 |
| --- | --- | --- | --- |
| 1 | 692 | 4,096 | 86% |
| 6 | 177 | 5,376 | **97%** |
| 8–21 | 6,244…7,821 | **0** | **0%** ← 换了模型 `hy3-x` |
| 22 | 14,040 | 0 | 0% ← 换到 `ginka` |
| 23–27 | 149…253 | 13,952…14,336 | **99%** |
| 28 | 9,244 | 6,016 | 39% ← 换回 `workbuddy` |
| 36 | 163 | 16,256 | **99%** |

### 结论一：DSH 的前缀缓存**本来就是好的**（同模型连续对话 97~99%）

这一点比参考项目的出发点还好——DSH 的会话日志是 append-only 的，
天然就是「稳定前缀 + 追加」，直接吃满了服务商的前缀缓存。

### 结论二：**换模型是唯一真正击穿缓存的元凶**

turn 8–22 命中率全 0，代价有多大：

```
那一段（14 次调用）全部按「新输入」计费：
  6,244 + 6,341 + … + 7,821 + 14,040 ≈ 106,000 token 全价
若按 97% 命中算，其中约 103,000 token 本可以走缓存价（通常 1/10）
```

**一次换模型，就把前面所有轮攒下的缓存全废了。** 而这一晚换了三次
（`hy3-x` → `ginka` → `workbuddy`），每次都要重新「预热」整个上下文。

### 结论三：我们缺的正是 ① 和 ③（预算切分 + 分层压缩）

DSH 给的是全量历史 → 我们无法像它那样把 `recentScript` 钉在 12k 字符。
但**这不代表没得做**：

| 它的手段 | 我们的可行性 |
| --- | --- |
| ① 字符预算切历史 | ❌ 做不到（历史由 DSH 发）。**但 DSH 自己的 compaction 就是干这个的**——问题是窗口开到 100 万，永远不触发 |
| ② 前缀缓存重排 | ✅ 已经是好的；**要做的是别换模型** |
| ③ 分层压缩 | ⚠️ 半可行：DSH 有 `compaction/*` 事件，我们不该重造 |
| ④ 按任务分模型 | ❌ DSH 里模型归 agent 配置（就是它导致了换模型） |
| ⑤ 图片降采样 | ✅ **可行且未做**——见下 |
| ⑥ 成本核算 | ✅ 已有 `dsh-cost-meter` |

---

## 可以照着做的三件事

### A. 别在会话中途换模型（立刻，零成本）

上面数据已经证明：**换一次模型 = 整个上下文重新按全价计费一次**。
这一晚三次切换，光缓存失效就多花了约 10 万 token 的全价差额。

如果确实要换，**换完第一轮就让它继续用**，不要来回横跳。

### B. 图片降采样（可做，参考它的 ⑤）

它的做法：最长边降到 1024、`detail: 'low'`、小于 150KB 的图直接透传。
我们这边图片走 dsh-im → 附件，**目前没有降采样**。
上一轮那张 643KB / 822KB 的表情包，如果按「最长边 1024 + low detail」进模型，
多模态 token 能省掉大半。

落点：`hds-interlude` 管不到 dsh-im 的图片管线，但**可以在注入前对
`attachment` 做一层提示**；真正的降采样要在 dsh-im 侧做（可以给作者提需求）。

### C. 把「没证据就别调模型」抄过来（可做）

它的 Schedule Preplan：

> 已有计划覆盖充足且没有新剧本证据时，程序直接保持原计划，**不调用模型**。

我们对应的位置是 **`schedulePreplan` 与自动续写**：

- 自动续写现在只要「距上次够久」就唤起一次模型，**不管这段时间有没有发生什么**。
  可以加一道：若这一窗口内没有任何新事件（无用户消息、无到期待办、无新事实），
  **跳过这次续写**——反正它只会写出「又躺了一会儿」这种水文。
- 代价是「生活推进」会变稀，但正如它文档说的：**正确的停顿优先于虚构**。

---

## 一句话总结

参考项目的省 token 核心是「**它自己组装上下文，于是能把每一层都钉上字符预算，
并按变异频率重排以吃满前缀缓存**」。

我们受 DSH 架构限制，做不了 ①（预算切历史）——那本就是 DSH 压缩该干的事。
但实测下来，我们真正流血的地方**不是插件，而是「会话中途换模型」**：
一次切换让 10 万 token 从缓存价变全价。这一条不改，其他优化都是零头。

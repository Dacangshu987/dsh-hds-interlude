# 可行性评估：im 页新增「多 QQ Bot 绑定」

> 评估对象：`dsh-hds-interlude` 的 `im` 配置页与 `lib/qq-im/` 通道。
> 评估方式：直接读取当前源码（`lib/qq-im/*.js`、`lib/schema.js`、`lib/index.js`、`lib/im.js`），
> 所有结论附文件与行号，可独立复现。
> **本文只做评估，未修改任何代码。**

> **配套文档**：`docs/design/方案-多QQBot绑定.md`（实施层方案：
> 分阶段改造、配置页改法、迁移脚本、测试清单）。
> 该文档含一轮**实机验证记录**（V1–V8），并**修正了本文档的一处错误**（见 §2 的 B-2）。

---

## 〇、前提假设（原文未指明，先显式标注）

需求原文只说「im 页新增多 QQ Bot 绑定」，未给出产品定义。以下为推进评估所设的前提，
**均为假设，不是从代码或原文推出的结论**：

| 编号 | 假设 | 依据 |
|---|---|---|
| **P1** | 「多 Bot」指**同时接入多个 QQ 机器人账号**（多个 AppID/AppSecret，各自连一条 QQ 长连接），而**不是**同一账号的多条连接 | 与 `appId` / `secretRef` 的存在方式一致 |
| **P2** | 绑定粒度是**会话级**：一个 DSH 会话可绑定到「某个 Bot 的某个 target」，不同会话可分属不同 Bot | 与现有 `state.imBinding` 的粒度一致 |
| **P3** | 至少需要：查看各 Bot 状态、为当前会话选择 Bot、入站消息按 Bot 分流 | 「im 页」的最小可用集合 |
| **P4** | **不要求**同一会话同时向多个 Bot 并发投递 | 现有投递出口是单出口，且无此需求的迹象 |

（待补充：具体产品定义 / 绑定粒度 / 切换方式）

若 **P3 中的「切换方式」实际是「同一会话同时绑多个 Bot 并群发」**，
则结论从「有条件可行」降为「不可行」——现有 `sendToTarget` 是单一出口，
需要重新设计投递扇出与去重（见 §2 的 B-4）。

---

## 一、可行性结论

### 结论：**有条件可行**（改造量中等偏大，集中在通道层）

**可行**的部分——现有的三层绑定优先级已经天然支持「按会话选 Bot」：

```
lib/index.js:950-960  bindingFor(key, state, cfg)
  ① state.imBinding（会话级 /interlude im bind）   ← 已经是 per-session 的
  ② cfg.im.botId / targetId（插件级）
  ③ qqIm.bindingForSession(key)（自动发现，查自建绑定表）
```

`resolveImBinding`（`lib/im.js:324`）读的是 `state.imBinding.botId`，
**`botId` 已经是绑定的一部分**；`bindings.json` 里也**已经存了 `botId` 字段**
（实测：`{"c2c:4DDB…": {"sessionId": "…", "botId": "qq", …}}`）。

**不可行的部分**——以下三处是**硬约束**，不是配置问题：

| # | 硬约束 | 证据 |
|---|---|---|
| **H1** | **通道是单例**：只有一个 `QqChannel` 实例 | `lib/qq-im/channel.js:98` `const channel = new QqChannel({...})`，在 `installQqIm` 里创建一次 |
| **H2** | **凭据是单个**：配置里 `appId` / `secretRef` 都是单值，不是数组 | `lib/schema.js:126-127`；`lib/qq-im/config.js` 的 `appId: nonEmpty(source.appId, '')` |
| **H3** | **绑定表的键不含 botId** | `lib/qq-im/binding.js:60-63` `conversationKeyOf` 返回 `` `${scope}:${targetId}` ``；`lib/qq-im/inbound.js:120` 同样只拼 `scope:peerId` |

**H3 是最关键的一条**，它直接决定多 Bot 上线后会不会串号。详见 §2 A-1。

**结论口径**：在 P1–P4 前提下，**有条件可行** ——
可行的是「多 Bot 并存 + 按会话选择投递目标」；
必须先改的是**通道生命周期（从单例改为多实例）**与**绑定表主键（补 botId）**。
后者是**破坏性数据结构变更**，需要迁移（见 §4）。

---

## 二、可能出现的 Bug

按严重程度分三档。每条给出触发条件、表现、根因。

### A 档：数据错误 / 串号（最严重，必须先解决）

---

#### **A-1｜不同 Bot 的同名 target 互相覆盖绑定**

**触发条件**：Bot-A 与 Bot-B 都对同一用户收到私聊，且两条入站消息的
`peerId`（openid）**字符串相同**——即 `conversationKey` 相同。

**表现**：
- `bindings.json` 里 `c2c:<openid>` 只有**一条**记录，后绑的覆盖先绑的；
- 更糟的是 `bindings.set()`（`binding.js:179-196`）保留 `boundAt`：
  覆盖后**看不出**发生过覆盖；
- 结果是：本来该由 Bot-A 回的会话，回消息时从 Bot-B 发出（或反之），
  用户收到「从另一个机器人那儿发来的回复」。

**根因**：`conversationKeyOf` 不带 `botId`

```js
// lib/qq-im/binding.js:60-63
export function conversationKeyOf({ scope = 'c2c', targetId } = {}) {
  if (typeof targetId !== 'string' || !targetId) return undefined
  return `${scope}:${targetId}`          // ← 没有 botId
}
```

而 `bindingForSession`（`channel.js:156-175`）反查时用：

```js
botId: found.botId ?? config.botId,     // ← 单 Bot 时能对上；多 Bot 时是猜
```

**关于「openid 是否真的会撞」——这一点必须标注为不确定**：
QQ openid 是 per-AppID 的，理论上不同 Bot 看到同一用户的 openid 不同，
那样就不会撞。**但**：
- 本项目**没有**任何代码或文档断言这一点；
- 迁移来的旧数据（`migrateLegacyBindings`）与手工 `/interlude im bind` 写入的值
  未必遵守该规律；
- 即便 openid 天然不同，**群聊**（`group:<group_openid>`）在多个 Bot 同群时
  群 openid 也可能相同——`scopeOf` 已经支持 `group`。

（待补充：确认 QQ openid 是否严格 per-AppID，尤其是群聊 openid）

**→ 解决方案见 §3 的 S-1。**

---

#### **A-2｜`sessionBindings` 缓存跨 Bot 串号**

**触发条件**：`bindingForSession` 的结果被缓存在 `sessionBindings`
（`channel.js:91`），但缓存键**只有 sessionId**，不含 botId。

**表现**：切换 Bot 后（或两个 Bot 同时在线时），
该会话的投递目标**仍指向旧 Bot**，直到进程重启。

**根因**：

```js
// lib/qq-im/channel.js:156-158
function bindingForSession(sessionId) {
  const cached = sessionBindings.get(sessionId)      // ← 键只有 sessionId
  if (cached) return cached
  ...
  sessionBindings.set(sessionId, resolved)
```

单 Bot 时这是纯优化；多 Bot 时它把「上一次解析结果」固化成了错误的权威。

**→ 解决方案见 §3 的 S-2。**

---

### B 档：功能失效 / 静默不工作

---

#### **B-1｜`imActive` 判定错乱，导致提示词口径给错**

**触发条件**：多 Bot 后 `imActiveFor`（`index.js:963`）的返回值
在「有绑定 / 无绑定」之间抖动，而 `canonInjectedIm` 只在**形态变化时**补注。

**表现**：
- 若某会话在「绑了 Bot-A」时注入过 rules（`canonInjectedIm = true`），
  之后解绑 Bot-A、改绑 Bot-B，`imActive` 仍是 `true` → **不补注**；
  这本身没问题；
- **但**若中间出现过一次 `imActive === false`（例如绑定表短暂读失败、
  或 Bot-B 未启动导致 `bindingForSession` 返回 undefined），
  就会触发一次**多余的口径切换重注入**，多消耗一段上下文；
- 更坏的情况：`canonInjectedIm` 被写成 `false`，
  而模型实际仍需按 IM 口径发言 → **它又不知道要调 `interlude_say`**，
  回到我们刚修好的那个故障形态。

**根因**：`imActive` 是**派生态**（由 `bindingFor` 现算），
而 `canonInjectedIm` 是**持久化的快照**。多 Bot 让派生态更容易波动，
两者的耦合被放大。

> 关联既有逻辑：`canonInjectedIm` 是我上一轮为修
> 「绑定在首轮之后才建立」引入的字段（见 `docs/fixes/诊断-QQ没收到回复.md`）。
> 多 Bot 会让这个字段的语义从「形态变过没有」变成「当前该按哪个形态」，
> **是本次需求的主要影响面之一**。

**→ 解决方案见 §3 的 S-3。**

---

#### **B-2｜`/interlude im` 系列命令只认单个 Bot**

**触发条件**：执行 `/interlude im discover` / `reconnect` / `rebind`。

**表现**：
- `im discover`（`index.js:1543`）写死 `qqIm.service.listTargets(qqIm.config.botId)`
  → **只列第一个 Bot** 的目标；
- `im reconnect`（`index.js:1554`）调 `qqIm.reconnect()` 无参 → 全局单实例语义，
  多 Bot 下只会重连一个；
- `im rebind`（`index.js:1563`）用 `discovered?.botId || qqIm.config.botId` 兜底
  → 多 Bot 下这是**猜**；
- 用户会看到「只有 1 个 bot」，误以为配置没生效。

> **⚠️ 本节修正（2026-09-17 实机验证）**：
> 本文档初版写「`im targets` 只列第一个 Bot」——**那是错的**。
> 实测 `im targets`（`index.js:1511`）走的是 `for (const bot of bots)` 遍历 `listBots()`，
> **多 Bot 下天然正确**；`im test`（`index.js:1525`）用 `bindingFor(key,…)` 按会话解析，同样正确。
> 真正写死单个 Bot 的只有 `discover` / `reconnect` / `rebind` 三个。
> 详见 `docs/design/方案-多QQBot绑定.md` 的验证记录 V6。

**根因**：`qqIm.config.botId` 是单值（`config.js` 的 `botId: nonEmpty(source.botId, 'qq')`），
而这三处逻辑假定它是权威。

**→ 解决方案见 §3 的 S-4。**

---

#### **B-3｜启动/重连只拉起一个 Bot**

**触发条件**：插件启动，或改设置触发 `applyConfigAndReconnect`。

**表现**：只有第一个 Bot 上线，其余 Bot 静默不发消息。
`/interlude im status` 会显示「已连接」，误导性强。

**根因**：

```js
// lib/qq-im/channel.js:98  只 new 一个
const channel = new QqChannel({ appId: config.appId, accountId: config.botId, ... })
```

且生命周期是全局的：`index.js:322` 的 `qqIm.start()`、
`index.js:2776` 的 `qqIm.stop()` 都是**单实例**语义。

**→ 解决方案见 §3 的 S-5。**

---

#### **B-4｜同一会话「群发到多个 Bot」会重复投递 / 计数错乱**

**触发条件**：**仅在 P4 被推翻时**（即需求要求一条消息发到多个 Bot）。

**表现**：
- `deliverImChunks` / `sendToTarget` 是单出口，做成循环后会：
  - `stats.outbound` 重复累加（`channel.js:239`）；
  - `lastImDelivery` 只留最后一次（`index.js` 记 `state.lastImDelivery`），
    用户看到「已发送 1 条」而实际发了 N 条；
  - `reachedOut` 每日配额（`handleAutoAdvance`）按「一次开口」计数，
    实际消耗 N 个 Bot 的额度 → **配额统计失真**。

**根因**：投递出口与记账都是「一次开口 = 一次投递」的模型。

**→ 解决方案见 §3 的 S-6（并建议在需求确认前不做）。**

---

### C 档：边界 / 迁移

---

#### **C-1｜旧绑定数据缺 `botId` 语义，迁移后归错 Bot**

**触发条件**：升级后首次启动，读取既有 `bindings.json`。

**表现**：旧记录的 `conversationKey` 不含 botId，反查时只能靠
`found.botId ?? config.botId` 兜底；若用户此时配置的 `botId` 变了，
旧绑定会被**归到新的 Bot** 上。

**根因**：`bindingForSession` 的兜底 `?? config.botId`（`channel.js:164`）
在单 Bot 时等价于「就是这个 Bot」，多 Bot 时变成**猜测**。

**→ 解决方案见 §3 的 S-7。**

---

#### **C-2｜专用模型/凭据缺失时的降级行为不一致**

**触发条件**：两个 Bot 中只有一个配了可用的 `secretRef`。

**表现**：实测已有先例——`state.json` 里留有
`"error": "无法解析 AppSecret（凭据服务不可用…），通道未启动。"`。
多 Bot 后这个错误需要**按 Bot 分别呈现**，否则用户不知道是哪个 Bot 挂了。

**根因**：`stats.lastError` 是**单个**字段（`channel.js:118`），
不是 per-bot 结构。

**→ 解决方案见 §3 的 S-8。**

---

## 三、解决方法

与 §2 逐条对应。

| 编号 | 对应 Bug | 解决方法 | 影响面 |
|---|---|---|---|
| **S-1** | A-1 | **把 `botId` 并入绑定主键**：`conversationKey` 改为 `` `${botId}:${scope}:${targetId}` ``，同步改 `conversationKeyOf` / `targetIdOf` / `scopeOf`（`binding.js:60-78`）与 `inbound.js:120` 的拼接。<br>**⚠️ 破坏性变更**：需一次性迁移（见 S-7）。 | `bindings.json` 结构、`inbound` 路由、`bindingForSession` 反查、`im bind` 命令参数 |
| **S-2** | A-2 | `sessionBindings` 缓存键改为 `` `${botId}${sessionId}` ``；或在 `bindings.set/remove` 时**主动失效**该 sessionId 的缓存（更稳，避免陈旧）。 | `channel.js:91` 及 `bindingForSession` |
| **S-3** | B-1 | 把注入判据从「形态布尔」升级为**显式形态键**：`canonInjectedIm` 存 `'im'` / `'story'` / `null`，并在**判定依据本身**（而非派生结果）变化时补注。<br>关键：`imActive` 取不到绑定时，**不要**立刻判为 `false`——先区分「确实没绑定」与「绑定表暂时读不到」。 | `lib/state.js` 的 `canonInjectedIm`、`lib/index.js` 的注入分支 |
| **S-4** | B-2 | `im discover` / `reconnect` / `rebind` 三处改为遍历全部 Bot（或按当前会话所属 Bot）；<br>`im targets` 与 `im test` **无需改动**（已实测天然支持多 Bot，见 B-2 的修正说明）；<br>`im bind` 的 `<botId> <targetId>` 形式保留不变。 | `index.js:1541-1601` 的三个子命令分支、`client.js` 的 im 页控件 |
| **S-5** | B-3 | 把 `installQqIm` 里单个 `channel` 改为 **`Map<botId, QqChannel>`**，`start/stop/applyConfig/reconnect` 全部改为按 Bot 迭代；`qqIm.status()` 返回 per-bot 状态。**这是本次改造的主体工作量。** | `lib/qq-im/channel.js` 全文、`lib/qq-im/connect.js`、`lib/index.js:314-322 / 2720-2776` 的生命周期调用 |
| **S-6** | B-4 | **建议不做**。若确需群发：把「一次开口」提升为**投递任务**对象，含 `targets[]` 与**去重后的**计数；`reachedOut` 与 `stats.outbound` 都改为按任务计。**成本高，且需求未确认（P4）。** | 投递出口、记账、配额 |
| **S-7** | C-1 | 迁移时给旧记录**显式补 `botId`**：旧数据一律标注为「迁移前的那个 Bot」（即当时 `config.botId`），并新增 `migratedFrom` 标记，便于排查。**不要**用运行时兜底 `?? config.botId` 猜。 | `buildReceipt`/`migrateLegacyBindings`、`bindings.json` |
| **S-8** | C-2 | `stats` 从单份改为 `Map<botId, stats>`；`state.json` 兼容读旧结构（旧结构视为「那个唯一的 Bot」）。 | `channel.js:113-125` 的 `stats`/`saveStats`、`/interlude im status` 渲染 |

### 建议的落地顺序

```
S-7（迁移方案先定） → S-1（主键） → S-5（多实例） → S-2 → S-4 → S-8 → S-3
```

理由：**S-7 必须先于 S-1**，否则主键一改，旧数据无法判断归属；
**S-5 是主体**，但可以独立于 S-1 开发（多实例能跑起来，只是绑定还可能串号）；
**S-3 放最后**，因为它依赖 `imActive` 的语义稳定下来。

---

## 四、需要新增 / 修改的状态字段

| 字段 / 结构 | 现状 | 变更 | 影响面 |
|---|---|---|---|
| `bindings.json` 的 key | `c2c:<openid>` | 加 `botId` 前缀 | **破坏性**，需迁移；`verify-accidents.mjs` 等测试的夹具要同步 |
| `bindings.json` 的 value | 已有 `botId` | 保留（冗余但便于自检） | 无 |
| `state.imBinding`（会话级） | `{botId, targetId, boundAt}` | **不变**——已经含 `botId`，无需改 | 无（这是本次需求最省的一块） |
| `state.canonInjectedIm` | `boolean \| null` | 建议改为 `'im' \| 'story' \| null` | `lib/state.js` 的 `emptyState`、`loadState`；`lib/index.js` 注入分支；**`test/canon-form.test.mjs` 需同步** |
| `qqIm.config` | `appId`/`botId`/`secretRef` 单值 | 增加 `bots: [...]` 数组（或 `appId` 等改为 per-bot 结构） | `lib/schema.js` 的 `Im` 块、`client.js` 的 im 页表单、`config.js` 的 `resolveConfig` |
| `stats`（通道运行统计） | 单份 | `Map<botId, stats>` | `channel.js:113-125`、`/interlude im status`、`state.json` |

### 与 `canonInjected*` 的交互（单独说明）

这是**本次需求最容易漏的一处**，因为它不在 `qq-im/` 目录里，而在 `lib/index.js` 的注入逻辑：

- 现有判据（`index.js:1031` 附近）：

```js
const formChanged = state.canonInjected === true && state.canonInjectedIm !== imActive
if (state.canonInjected !== true || formChanged) { ...补注... }
```

- `imActive` = `Boolean(bindingFor(key, state, cfg))`，是**派生态**；
- 多 Bot 后 `bindingFor` 多了一层「查哪个 Bot」，**失败面变大**
  （Bot 未启动、凭据缺失、绑定表读到半截）；
- 一旦某次派生出 `false`，就会写坏 `canonInjectedIm`，
  并且**多注入一次**切换说明。

**建议**：`imActive` 的计算要**区分三种态**——
「有绑定」/「确定无绑定」/「暂时判不出」，
第三种**不改** `canonInjectedIm`（保持上次的权威值）。

---

## 五、结论摘要

1. **可行，但前提明确**：在「多账号并存 + 会话级选择」的定义下为**有条件可行**；
   若要求「同一会话群发多个 Bot」，则降为**不可行需重设计**（P4 待确认）。
2. **最省的一块**：`state.imBinding` 与 `bindings.json` 的 value **已经含 `botId`**，
   会话级绑定粒度不需要新概念。
3. **最硬的三条约束**：通道单例（`channel.js:98`）、凭据单值（`schema.js:126-127`）、
   **绑定表主键不含 botId**（`binding.js:60-63`）。
4. **最高危的 bug 是 A-1（串号）**，且它是否真会发生**取决于 QQ openid 是否严格
   per-AppID** —— 这一点**我无法从代码确认**，标注为待确认。
   稳妥做法是**无论 openid 是否天然不同，都把 botId 并入主键**（S-1）。
5. **改造主体在 `lib/qq-im/channel.js`**（单例 → Map），
   加上一次 `bindings.json` 的破坏性迁移。
6. **别忘 `canonInjectedIm`**：它不在 `qq-im/` 里，但会被 `imActive` 的波动影响，
   是本需求最隐蔽的影响面。

---

## 六、待确认清单

以下均**无法从现有源码或需求原文确定**，需要产品/使用方明确后才能真正定方案：

1. （待补充：具体产品定义）「多 Bot」是多个 QQ 账号，还是同一账号多连接？
2. （待补充：绑定粒度）一个 DSH 会话是「同一时刻一个 Bot」还是「可多 Bot 并存」？
3. （待补充：切换方式）切换是否需要影响**历史消息**的归属，还是只影响**后续投递**？
4. （待补充）同一会话是否要求**并发群发**到多个 Bot？（决定 P4 与 B-4/S-6 是否要做）
5. （待补充）QQ openid 是否严格 per-AppID（含群聊 openid）？—— 决定 A-1 的紧急程度。
6. （待补充）是否需要 per-Bot 的**独立配额**（`proactive.maxPerDay`）与**独立发消息间隔**？
   现有 `proactive` 与 `messageIntervalMinutes` 都是全局单值。

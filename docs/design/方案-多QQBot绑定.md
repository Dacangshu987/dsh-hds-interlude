# 实施方案：im 页多 QQ Bot 绑定

> 前置：`docs/design/可行性-多QQBot绑定.md`（可行性结论）。
> 本文是**实施层**方案：经实机验证后落成的改造步骤、配置页改造、迁移脚本与测试清单。
> **本文只做方案，未修改任何源码。**

---

## 〇、验证基线（本次实机验证的结果）

先跑通再谈改造。所有结论都有可复现命令。

| # | 验证项 | 方式 | 结果 |
|---|---|---|---|
| V1 | im 相关测试基线 | 逐条运行 15 个 im/qq-im 测试 | **15/15 通过** |
| V2 | 绑定主键是否含 botId | 直接调 `conversationKeyOf({targetId, botId})` | **不含**——`botId` 被静默忽略 |
| V3 | 两 Bot 绑同一 key 的行为 | 用真实 `BindingStore` 跑两轮 `set()` | **后者覆盖前者**，且 `boundAt` 保留旧值（看不出覆盖过） |
| V4 | 通道是否单例 | grep `new QqChannel` | **1 处**（`channel.js:98`） |
| V5 | 生命周期是否全局 | grep `qqIm.(start\|stop\|reconnect)` | **全无参**（`index.js:314/322/1556/2720/2726/2776`） |
| V6 | 配置页字段模型 | 读 `client.js` 的 scalar 初值 | **18 个扁平标量**（`imAppId` / `imBotId` … 非数组） |
| V7 | 配置保存的深合并对数组的语义 | 复刻 `mergeLayers` 语义跑 4 个场景 | 数组**整体替换**；数组**元素不做深合并**（漏字段即丢配置） |
| V8 | 运行态 | 读 `integrations/dsh-qq-im/state.json` | 插件在跑，`outbound` 已从 2 增至 3（说明投递链路正常） |

### V6/V7 是配置页改造的关键依据

`client.js:146-150` 明确记录了宿主的保存语义：

> 宿主端 POST 走的是 `settingsScope.update()`，那是深合并（`mergeLayers`）——
> **字段缺席等于「保持原值」**。……显式送 `''` / `[]` 才能让合并用空值覆盖旧值。

实测结论（V7）：

| 场景 | 结果 | 含义 |
|---|---|---|
| 2 个 Bot → 1 个（送新数组） | 正确替换 | 删得掉 ✓ |
| 漏送 `bots` 字段 | 保持原值 | 不会误删 ✓ |
| 清空成 0 个（送 `[]`） | 清空 | 必须显式送 `[]` |
| **数组元素漏字段** | **整个对象被替换，字段丢失** | ⚠️ **必须每次送完整数组** |

最后一条是配置页最容易踩的坑：数组元素**不做深合并**，漏一个 `secretRef` 就静默丢配置。

### V2/V3 推翻了可行性报告里的一处说法

> 可行性报告 §B-2 写「`im targets` 只列第一个 Bot」——**这是错的**。

实测 `im targets`（`index.js:1511`）走的是 `listBots()` **遍历全部 Bot**，多 Bot 下天然正确。
真正写死单个 Bot 的是 **`im discover`**（`index.js:1543` 的 `qqIm.config.botId`）。

修正后的命令适配表：

| 子命令 | 位置 | 现状 | 多 Bot 下 |
|---|---|---|---|
| `bind` / `unbind` | L1486 / L1493 | 显式传 `<botId> <targetId>` | ✓ 已可用 |
| `targets` | L1501 | `listBots()` 遍历 | ✓ 天然正确 |
| `test` | L1524 | `bindingFor(key,…)` 按会话解析 | ✓ 天然正确 |
| `discover` | L1541 | **写死 `config.botId`** | ✗ 只列一个 |
| `reconnect` | L1554 | `qqIm.reconnect()` 无参 | ✗ 全局语义 |
| `rebind` | L1563 | `discovered?.botId \|\| config.botId` 兜底 | ⚠️ 兜底是猜 |

---

## 一、前提与范围

沿用可行性报告的 P1–P4（多账号并存 / 会话级粒度 / im 页最小功能集 / **不要求群发**），
并补两条实施口径：

- **P5**：配置页采用**列表式编辑**（可增删 Bot 行），而非给每个 Bot 一组固定字段。
  理由：Bot 数量不固定，固定字段会造成 UI 空位。
- **P6**：`botId` 沿用现有的「字符串标识」语义（如 `qq`、`qq-b`），
  **不引入新的 ID 体系**。理由：`bindings.json` 与 `state.imBinding` 里已经在用。

（待补充：具体产品定义 / 绑定粒度 / 切换方式）

---

## 二、分阶段改造

### 阶段 1｜数据层：绑定主键加 botId（**破坏性，先做迁移**）

**为什么先做**：不解决它，多 Bot 上线即串号（V3 已复现覆盖）。

**改动**：

| 文件 | 改动 |
|---|---|
| `lib/qq-im/binding.js` | `conversationKeyOf` 增加 `botId` 前缀；`targetIdOf` / `scopeOf` 同步支持新格式 |
| `lib/qq-im/inbound.js:120` | `const conversationKey = \`${scope}:${peerId}\`` 改为带上 botId |
| `lib/qq-im/binding.js` | 新增 `migrateBindingKeys()`：旧 `c2c:X` → `qq:c2c:X`（botId 取迁移时的 `config.botId`） |

**新格式**：`` `${botId}:${scope}:${targetId}` ``（例：`qq:c2c:4DDB1DAE…`）

**兼容读取**：`targetIdOf` / `scopeOf` 必须能解析**两种格式**，
否则旧数据在迁移前就崩。建议实现为「按 `:` 分段，2 段=旧、3 段=新」。

**风险**：格式含多个 `:`，而 `targetId` 本身可能含 `:`（群聊 openid 未必，但不应假设）。
→ 建议 `targetId` 取「前两段之后的所有内容」，而不是第三段。

（待补充：确认 QQ openid 是否可能含 `:`）

### 阶段 2｜通道层：单例 → 多实例（**主体工作量**）

**改动**：

| 文件 | 改动 |
|---|---|
| `lib/qq-im/channel.js` | `const channel = new QqChannel(...)` → `const channels = new Map()`；`start/stop/reconnect/applyConfig` 全部按 Bot 迭代 |
| `lib/qq-im/channel.js` | `sessionBindings` 缓存键加 botId（见 §三 B-2） |
| `lib/qq-im/channel.js` | `stats` → `Map<botId, stats>`，`state.json` 兼容读旧结构 |
| `lib/qq-im/config.js` | `resolveConfig` 支持 `bots: [...]`；**保留**顶层 `appId`/`botId`/`secretRef` 作为「单 Bot 的简写」，归一成 `bots: [那一个]` |
| `lib/index.js` | `qqIm.status()` / `service` 相关调用按 Bot 聚合 |

**关键设计：向后兼容的配置归一**

```
若 bots 非空            → 用 bots
否则若 appId 非空       → 归一成 bots: [{ botId: botId||'qq', appId, secretRef }]
否则                    → bots: []
```

这样**现有配置一个字段都不用改**就能继续跑。

### 阶段 3｜配置页改造（`lib/client.js`）

这是本需求**改动最集中、最容易做错**的一处。

#### 3.1 现状

`client.js` 的 im 区块是 **18 个扁平标量**（V6）：`imAppId` / `imBotId` / `imSecretRef` / …
读方向逐字段赋值（L237-261），写方向是硬编码对象字面量（L327-354）。

#### 3.2 改造方式

| 项 | 改法 |
|---|---|
| state | 新增 `imBots: []`（数组，元素为 `{botId, appId, secretRef}`）；**保留**旧标量以兼容 |
| 读方向 | `im.bots` 存在则填入 `imBots`；否则用 `[{botId: imBotId, appId: imAppId, secretRef: imSecretRef}]` 合成 |
| 写方向 | `payload.im.bots` = **完整数组**（见 §3.3 的强制要求） |
| UI | 列表式：每行三个输入框 + 「删除」；底部「添加 Bot」按钮 |
| 向后兼容 | 若 `imBots.length === 1`，**同时**写顶层 `appId`/`botId`/`secretRef`，让旧版本读得懂 |

#### 3.3 ⚠️ 三条硬约束（来自 V7 实测）

1. **必须每次送完整数组**。数组元素不做深合并，漏一个字段 → 该字段静默丢失。
   → 实现上：`imBots.map(b => ({ botId: b.botId, appId: b.appId, secretRef: b.secretRef }))`
   显式列全，**不要**用展开运算符透传（避免 `undefined` 混入）。
2. **清空要送 `[]`**，不能省略字段。否则旧 Bot 留在配置里（与 `plot.keywords` 同一个坑，
   `client.js:161-163` 已有先例可参照）。
3. **空串要显式送**（`''`），理由同上——这是面板既有的约定（`client.js:146-150`）。

#### 3.4 顺带要改的展示

`/interlude im status` 的渲染（`client.js:507` 附近）目前显示单个 AppID，
多 Bot 下要改为逐行显示。

### 阶段 4｜命令补齐

| 子命令 | 改法 |
|---|---|
| `im discover`（L1541） | 遍历全部 Bot；或改为「先看当前会话属于哪个 Bot」再列 |
| `im reconnect`（L1554） | 支持 `im reconnect [botId]`；不带参数则全部重连 |
| `im rebind`（L1563） | 去掉 `\|\| config.botId` 兜底，改为**显式要求**或按入站消息来源确定 |
| `im bind`（L1486） | 现有 `<botId> <targetId>` 形式**保持不变**（已显式），但补用法提示 |

---

## 三、Bug 清单与对策（实施视角）

沿用可行性报告的 A/B/C 编号，补充**本次实机验证**得到的具体证据与对策。

| 编号 | Bug | 实机证据 | 对策 |
|---|---|---|---|
| **A-1** | 绑定串号 | V2/V3：同一 key，后绑覆盖前绑，`boundAt` 保留旧值 | 阶段 1：主键加 botId + 迁移 |
| **A-2** | `sessionBindings` 缓存跨 Bot | 代码：缓存键仅 `sessionId`（`channel.js:91/158`） | 缓存键加 botId，**或**在 `bindings.set/remove` 时主动失效该 sessionId |
| **B-1** | `canonInjectedIm` 被判据抖动写坏 | 代码：`imActive` 是派生态，`canonInjectedIm` 是持久快照 | **区分三态**：有绑定 / 确定无绑定 / **暂时判不出**；第三种**不改** `canonInjectedIm` |
| **B-2** | 部分命令写死单 Bot | V6 修正：只有 `discover` / `reconnect` / `rebind` 需改 | 阶段 4 |
| **B-3** | 只拉起一个 Bot | V4/V5：单例 + 无参生命周期 | 阶段 2 |
| **B-4** | 群发时重复计数 | `stats.outbound`（`channel.js:239`）单份 | **建议不做**（P4 未确认）；若要做，见可行性报告 S-6 |
| **C-1** | 旧数据归错 Bot | 代码：`found.botId ?? config.botId`（`channel.js:164`） | 迁移时**显式补** botId，不靠运行时兜底猜 |
| **C-2** | 错误状态不区分 Bot | 实测 `state.json` 曾有 `无法解析 AppSecret` 单条记录 | `stats` 改 per-bot；`lastError` 记 botId |

### 新增（本次验证发现的）

| 编号 | Bug | 证据 | 对策 |
|---|---|---|---|
| **D-1** | **配置页漏字段静默丢配置** | V7 场景 4：数组元素整体替换 | §3.3 约束 1：显式列全字段 |
| **D-2** | **删除 Bot 后旧值残留** | V7 场景 3：不送 `[]` 则保留 | §3.3 约束 2：清空送 `[]` |
| **D-3** | 主键格式解析歧义 | 新格式含 2 个 `:`；若 `targetId` 含 `:` 则 `targetIdOf` 解析错 | `targetId` 取「前两段之后全部」，并补一条含 `:` 的用例 |

---

## 四、对 `canonInjected*` 的影响面（单独说明）

这是本需求**最隐蔽**的一处，因为它不在 `qq-im/` 目录里。

**现状**（`lib/index.js:1031` 附近）：

```js
const formChanged = state.canonInjected === true && state.canonInjectedIm !== imActive
if (state.canonInjected !== true || formChanged) { ...补注... }
```

**问题**：`imActive = Boolean(bindingFor(key, state, cfg))`（`index.js:963`）。
多 Bot 后 `bindingFor` 多了一层「查哪个 Bot」，**失败面变大**
（Bot 未启动 / 凭据缺失 / 绑定表读到半截）。
任何一次派生出 `false`，就会写坏 `canonInjectedIm`，并**多注入一次**切换说明。

**建议改法**：把布尔升级为**显式形态键**，并区分「判不出」：

| 字段 | 类型 | 语义 |
|---|---|---|
| `canonInjectedIm` | `'im' \| 'story' \| null` | 上次**按哪种形态**注入的 |
| 判不出时 | — | **不写**该字段，保持上次权威值 |

**影响文件/测试**：

- `lib/state.js`：`emptyState()` 的初值、`loadState()` 的归一
- `lib/index.js`：注入分支
- **`test/canon-form.test.mjs`**：现有 8 项断言基于布尔语义，**必须同步改**
- `docs/fixes/诊断-QQ没收到回复.md`：该字段的说明需更新

---

## 五、测试计划

### 5.1 必须先绿的既有测试（回归基线）

V1 已验证 15/15 通过。改造中**任何一步都要保持全绿**，
尤其是 `test/qq-im/binding.test.mjs` 与 `test/qq-im/inbound.test.mjs`
（主键改了它们必受影响）。

### 5.2 需新增的用例

| 用例 | 守什么 |
|---|---|
| 两个 Bot 绑同一 openid **不互相覆盖** | A-1（对应本次 V3 的复现脚本） |
| 旧格式 `c2c:X` 能读、迁移后变 `qq:c2c:X` | 阶段 1 兼容读取 |
| `targetId` 含 `:` 时解析正确 | D-3 |
| 配置页：从 2 Bot 删到 1 Bot 后配置正确 | D-2 |
| 配置页：漏字段时**不**静默丢（或至少断言送的是完整数组） | D-1 |
| `imActive` 判不出时 `canonInjectedIm` **不被改写** | B-1 |
| 单 Bot 旧配置（只有 `appId`）能归一成 `bots: [...]` | 阶段 2 向后兼容 |

### 5.3 承重验证（沿用仓库既有风格）

`test:loadbearing` 里的 `verify-*.mjs` 是「故意拆掉机制，证明测试会变红」。
本次建议新增一条：**拆掉绑定主键里的 botId，A-1 的用例必须变红**。

---

## 六、实施顺序（含串行/并行）

```
阶段 0  补 A-1 的复现用例（红）
   ↓
阶段 1  数据层：主键 + 迁移          ← 必须先于阶段 2
   ↓
阶段 2  通道层：多实例                ┐
   ∥                                  │ 可并行（改动文件不重叠）
阶段 3  配置页                        ┘
   ↓
阶段 4  命令补齐
   ↓
阶段 5  canonInjectedIm 语义升级 + 改 test/canon-form.test.mjs
```

**串行约束**：

- **阶段 1 必须最先**：主键是其它一切的基础，改晚了要重做测试。
- **阶段 2 与 3 可并行**：阶段 2 动 `lib/qq-im/`，阶段 3 动 `lib/client.js`，文件不重叠。
  但两者都要改 `lib/schema.js` 的 `Im` 块 → **schema 的改动建议由其中一方先落**。
- **阶段 5 放最后**：它依赖 `imActive` 语义稳定。

---

## 七、结论

1. **方案可行**，且**阶段 3（配置页）有一个明确的、可规避的技术陷阱**：
   深合并对数组元素不做合并，**必须每次送完整数组**（D-1/D-2，已实测）。
2. **阶段 2 是主体工作量**（单例 → Map），但可以独立于阶段 1 开发。
3. **阶段 1 是破坏性变更**，需要迁移脚本 + 兼容读取，**且必须最先做**。
4. **别忘 `canonInjectedIm`**（§四）：不在 `qq-im/` 里，但会被 `imActive` 的波动影响，
   且会牵动既有测试 `test/canon-form.test.mjs`。
5. **本次验证修正了上一份报告的一处错误**：`im targets` 早已支持多 Bot，
   真正写死的是 `im discover`。方案的阶段 4 据此缩小了范围。

---

## 八、待确认清单

1. （待补充：具体产品定义）「多 Bot」= 多个 QQ 账号？
2. （待补充：绑定粒度）同一会话是「同时一个」还是「可并存」？
3. （待补充：切换方式）切换是否影响历史消息归属，还是只影响后续投递？
4. （待补充）是否要求同一会话**并发群发**？（决定 B-4/S-6 做不做）
5. （待补充）QQ openid 是否严格 per-AppID？群聊 openid 是否可能含 `:`？（D-3）
6. （待补充）是否需要 per-Bot 的独立配额与发消息间隔？
   （现有 `proactive.maxPerDay` 与 `messageIntervalMinutes` 都是全局单值）
7. （待补充）旧配置迁移时，若用户当前 `config.botId` 已改，
   旧绑定应归到哪个 Bot？（C-1 的取值策略）

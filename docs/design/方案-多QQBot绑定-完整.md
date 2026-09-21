# 完整实施方案：im 页多 QQ Bot 绑定

> 需求确认（来自使用方）：
> - 「多 Bot」= **多个 QQ 机器人账号**（QQ 开放平台每人可申请 5 个）；
> - **一个机器人绑定一个会话**，但可以**新开会话**；
> - 具体操作与指令**参考 `dsh-im` 插件**；
> - **openid 都是独立的**。
>
> 参考实现：`@xmanrui/dsh-im`（本地 `~/.dsh/profiles/web/node_modules/@xmanrui/dsh-im`）。
>
> **实施状态：✅ 已实施**（2026-09-16，见文末《实施记录》）。本计划全部 7 个阶段
> 已落地，`npm run test:all` 全绿（含 4 个新增测试文件与 2 个承重验证）。
> 部分结论因实测被修订，修订处已就地标注。

---

## 〇、需求确认后的关键变化

你给的四条信息**直接消掉了我之前列的 5 条待确认项**，其中两条改变了方案：

| 原待确认项 | 你的答复 | 影响 |
|---|---|---|
| 「多 Bot」是什么 | **机器人账号**（开放平台 5 个/人） | 确认 P1；凭据是「多组 appId+secret」 |
| 绑定粒度 | **一个机器人绑一个会话，可新开会话** | 确认 P2/P3；**切换 = 新开会话**，不是会话内换 Bot |
| 参考实现 | **dsh-im** | 架构直接对标，不再自创 |
| openid 是否 per-AppID | **都是独立的** | **A-1 串号风险降级**——但主键仍应带 botId（见 §三） |

**最重要的变化**：「一个机器人绑定一个会话」意味着——**绑定关系是 `bot ↔ session` 的一对一**，
而不是「一个会话可挂多个 Bot」。这与 dsh-im 的模型**完全一致**，也让方案显著简化：
**不需要「投递扇出」**（原 P4/B-4/S-6 直接删除）。

---

## 一、参考实现：dsh-im 是怎么做的

我读了 dsh-im 的 QQ 通道源码。它的模型如下（附行号）：

### 1.1 配置：`bots: [...]` 数组，botId 从 appId 派生

`src/channels/qq/config-store.mjs:7`（`EMPTY_DOCUMENT`）、`:23`（`deriveQqBotIdentity`）、`:39`（`normalizeBot`）：

```js
const EMPTY_DOCUMENT = Object.freeze({ version: 1, bots: Object.freeze([]) });

export function deriveQqBotIdentity(appId) {
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return {
    botId:     `qq_${digest}`,                              // 派生，不是用户填
    secretRef: `DSH_QQBOT_APP_SECRET_${digest.toUpperCase()}`,
  };
}
```

要点：
- **配置存 `bots` 数组**，每条 `{botId, appId, secretRef, ownerUserOpenid, createdAt, connectedAt}`；
- **`botId` 由 `appId` 哈希派生**（`qq_<24位hex>`），不要求用户起名 → 避免重名与非法字符；
- **`secretRef` 也按 appId 派生** → 多 Bot 的凭据天然隔离，不会互相覆盖；
- `normalizeBot` 会**反过来校验** `deriveQqBotIdentity(appId) === botId`，防止手改配置造成不一致；
- `normalizeDocument` 拒绝**重复的 botId / appId / secretRef**（三者各自去重）。

### 1.2 生命周期：`Map<botId, runtime>` + per-bot 错误

`src/channels/qq/qq-controller.mjs:41-47`：

```js
#runtimes = new Map();     // botId -> runtime
#errors   = new Map();     // botId -> 错误  ← 与我方案里的 C-2 一致
#attempts = new Map();
```

`initialize()`（L75-97）**遍历全部 Bot** 逐个启动，单个失败只记进 `#errors`，不影响其它 Bot。

### 1.3 会话映射：**复合键 `botId + conversationKey`**

这是最关键的参考。`src/channels/shared/bot-workspace-store.mjs:105-108`：

```js
function conversationWorkspaceGenerationKey(botId, conversationKey) {
  // Conversation keys validated by conversationKeyOf never contain the null
  // separator, so the compound key stays unambiguous.
  return `${botIdOf(botId)}\u0000${conversationKeyOf(conversationKey)}`;
}
```

**dsh-im 用 `botId \0 conversationKey` 作复合键** —— 并且注释专门说明了
「用 NUL 作分隔符是因为 conversationKey 校验过不含 NUL，所以复合键无歧义」。

这条**正面印证**了我可行性报告里的 A-1 结论：多 Bot 场景下，
**会话映射的键必须带 botId**。dsh-im 自己就是这么做的。

另外 `ConversationStateStore`（`conversation-state-store.mjs`）里 `sessions: {key: sessionId}`，
`key` 就是上面那个复合键。

### 1.4 指令：`/new` 与 `/session`

`src/channels/shared/command-catalog.mjs`：

| 指令 | 说明 |
|---|---|
| `/new` | **开启一个全新会话** |
| `/session <ID 或序号>` | **将当前聊天绑定到指定会话** |
| `/sessionlist` | 列出会话 ID 和标题 |
| `/status` | 检查连接状态 |

**这正是你说的「一个机器人绑定一个会话，但可以新开会话」**：
- `/session` = 把当前聊天**指到**某个已有会话；
- `/new` = 丢掉绑定、**开一个新的**（对应 dsh-im 的 `#state.clearSession(conversationKey)`，
  见 `text-harness-bridge.mjs:640`）。

---

## 二、本项目的目标形态

对齐 dsh-im 后，本项目的目标形态：

### 2.1 配置态

```yaml
hds-interlude:
  im:
    enabled: true
    bots:
      - botId: qq_<hash1>          # 由 appId 派生
        appId: "1905583221"
        secretRef: DSH_QQBOT_APP_SECRET_<HASH1>
        alias: ""                  # 可选显示别名（Q群/私聊里好认）
      - botId: qq_<hash2>
        appId: "1905583222"
        secretRef: DSH_QQBOT_APP_SECRET_<HASH2>
```

**向后兼容**：沿用我原方案的归一策略——`bots` 为空但顶层 `appId` 非空时，
自动归一成 `bots: [{ botId: botId||'qq', appId, secretRef }]`。
**现有配置一个字段都不用改。**

### 2.2 绑定态：复合键

```json
{
  "version": 2,
  "bindings": {
    "qq_<hash1>\u0000c2c:<openid-A>": {
      "botId": "qq_<hash1>",
      "conversationKey": "c2c:<openid-A>",
      "sessionId": "session-…",
      "boundAt": "…"
    }
  }
}
```

**采用 dsh-im 的 `\0` 复合键**（而不是我原方案的 `botId:scope:targetId`），理由：

| | `\0` 复合键（dsh-im） | `:` 三段式（我原方案） |
|---|---|---|
| 歧义 | **无**（conversationKey 校验过不含 `\0`） | 有——若 targetId 含 `:` 则解析歧义（原 D-3） |
| 与参考实现一致 | ✅ | ✗ |
| JSON 可读性 | 稍差（`\u0000` 转义） | 好 |

**决定：采用 `\0`**。理由是与参考实现一致 + 消除 D-3 的解析歧义；
可读性的损失用一个 `debugKey()` 辅助函数在日志里还原即可。

### 2.3 指令（对齐 dsh-im，但适配本插件命名）

本插件现有命令前缀是 `/interlude im …`。新增两个**对齐 dsh-im 语义**的子命令：

| 新指令 | 对齐 dsh-im | 语义 |
|---|---|---|
| `/interlude im new` | `/new` | **为当前聊天开一个全新会话**（解绑 + 新建） |
| `/interlude im session <id\|序号>` | `/session` | **把当前聊天绑到指定会话** |
| `/interlude im sessions` | `/sessionlist` | 列出可绑定的会话 |

现有 `/interlude im bind <botId> <targetId>` **保留**（手工精确指定用的低层入口）。

---

## 三、bug 清单（据你的答复重新定级）

| 编号 | bug | 原级别 | **新级别** | 理由 |
|---|---|---|---|---|
| **A-1** | 绑定串号 | 🔴 最高危 | 🟡 **中** | 你说 **openid 都是独立的** → 不同 Bot 的 `c2c:<openid>` 天然不同，**实际不会撞** |
| **A-2** | `sessionBindings` 缓存跨 Bot | 🔴 | 🟡 **中** | 缓存键仍只有 sessionId；绑定变化 / 手动 rebind 后会返回陈旧值 |
| **B-1** | `canonInjectedIm` 被写坏 | 🟡 | 🟡 **中（不变）** | 与 openid 无关，多 Bot 让 `imActive` 派生失败面变大 |
| **B-2** | 命令写死单 Bot | 🟡 | 🟡 **中（范围缩小）** | 只需改 `discover`/`reconnect`/`rebind` |
| **B-3** | 只拉起一个 Bot | 🔴 | 🔴 **最高危** | 多 Bot 的核心功能，必须改 |
| **B-4** | 投递扇出计数错乱 | 🟡 | ⚪ **删除** | 你确认「一 Bot 绑一会话」，**不存在扇出** |
| **C-1** | 旧数据归错 Bot | 🟡 | 🟡 **中** | 迁移策略仍需明确取值 |
| **C-2** | 错误状态不区分 Bot | 🟢 | 🟡 **升为中** | 多 Bot 下「哪个 Bot 挂了」是刚需（dsh-im 有 `#errors` Map） |
| **D-1** | 配置页漏字段静默丢配置 | 🟡 | 🔴 **升为最高危** | 配置页从单 Bot 改多 Bot，**这是最容易踩且最隐蔽的坑** |
| **D-2** | 删除 Bot 后旧值残留 | 🟡 | 🟡 **中** | 同上，均属配置页 |
| **D-3** | 主键解析歧义 | 🟡 | ⚪ **解决** | 改用 `\0` 复合键后消除 |

**关于 A-1 降级的重要说明**：虽然 openid 独立使其不会实际发生，
我**仍然建议绑定键带 botId**。理由：
1. dsh-im 自己就这么做（§1.3），跟参考实现一致；
2. `migrateLegacyBindings` 与手工 `/interlude im bind` 写入的值不受 openid 规律约束；
3. 群聊 openid 的 per-AppID 性质**你未提及**（你只说了 openid 独立，未明确群聊）；
4. 带 botId 后主键语义自明，将来查出问题不需要再推演 openid 规律。

---

## 四、配置页改造（重点，含 D-1 的规避）

### 4.1 现状（已实测）

`lib/client.js` 的 im 区块是 **18 个扁平标量**（`imAppId` / `imBotId` / `imSecretRef` …），
读方向逐字段赋值（L237-261），写方向是硬编码对象字面量（L327-354）。

### 4.2 宿主保存语义（已实测，D-1 的根源）

`client.js:146-150` 自己记录了：宿主端 POST 走 **深合并**（`mergeLayers`），
**字段缺席 = 保持原值**。我实测了数组在深合并下的行为：

| 场景 | 结果 |
|---|---|
| 2 个 Bot → 1 个（送新数组） | 正确替换 ✅ |
| 漏送 `bots` 字段 | 保持原值 ✅ |
| 清空成 0 个（送 `[]`） | 必须显式送 `[]` |
| **数组元素漏字段** | 🔴 **整个对象被替换，字段静默丢失** |

**最后一条是 D-1**：数组元素**不做深合并**。漏一个 `secretRef` 就丢配置且用户无感。

### 4.3 改造方式

| 项 | 改法 |
|---|---|
| state | 新增 `imBots: []`，元素 `{botId, appId, secretRef, alias}` |
| 读方向 | `im.bots` 非空则填入；否则用顶层 `appId/botId/secretRef` **合成一条** |
| 写方向 | `payload.im.bots` = **完整数组**，逐字段显式列出 |
| UI | 列表式：每行 `appId` / `alias` / 「删除」；底部「添加机器人」 |
| 只读展示 | 每行的 `botId` / `secretRef` **由 appId 派生后展示**（不可编辑，对齐 dsh-im） |
| 数量上限 | 5（QQ 开放平台约束），超出时按钮禁用并提示 |
| 向后兼容 | `imBots.length === 1` 时**同时**写顶层 `appId`/`botId`/`secretRef` |

### 4.4 三条硬约束（D-1 / D-2 的规避）

```js
// ✅ 正确：显式列全每个字段，且每次送完整数组
bots: scalar.imBots.map(function (b) {
  return {
    botId:     String(b.botId || '').trim(),
    appId:     String(b.appId || '').trim(),
    secretRef: String(b.secretRef || '').trim(),
    alias:     String(b.alias || '').trim(),   // ← 空串也要送（见约束 3）
  }
}),
```

1. **必须每次送完整数组**——漏字段即静默丢失；
2. **清空要送 `[]`**，不能省略字段（参照 `client.js:161-163` 对 `plot.keywords` 的既有做法）；
3. **空串要显式送 `''`**——面板既有约定（`client.js:146-150`）。

**不要**用展开运算符透传（`{...b}`），否则 `undefined` 字段混入会让 `normalizeBot` 判为非法整条丢弃。

---

## 五、分阶段实施计划

### 阶段 0：补红（先写会失败的测试）

| 用例 | 守什么 |
|---|---|
| 两个 Bot 绑同一 openid，**各自独立** | A-1（即便 openid 独立，也守住语义） |
| `im` 配置从单 Bot 归一成 `bots: [...]` | 阶段 1 向后兼容 |
| 配置页：数组元素漏字段**不**静默丢 | D-1 |
| 配置页：清空送 `[]` 后旧 Bot 不残留 | D-2 |

### 阶段 1：数据层（`lib/qq-im/binding.js`）

1. 主键改**复合键** `${botId}\u0000${conversationKey}`（对齐 dsh-im）；
2. `targetIdOf` / `scopeOf` **按 conversationKey 部分解析**（不含 botId，无歧义）；
3. 新增 `botIdOfBinding(key)`；
4. `bindings.json` 版本号 `1 → 2`；
5. **迁移**：读 v1 时，用 `config.botId` 补全并改写为 v2；写回前**备份**原文件。

**迁移取值策略（原 C-1）**：旧记录一律归到「迁移时配置里的 `botId`」，
并加 `migratedFrom: 1` 标记便于排查。不用运行时兜底猜。

### 阶段 2：配置层（`lib/schema.js` + `lib/qq-im/config.js`）

1. `Im` 块新增 `bots: z.array(z.object({botId, appId, secretRef, alias}))`；
2. `resolveConfig` 归一：`bots` 为空 + `appId` 非空 → 合成单条；
3. 新增 `deriveBotIdentity(appId)`（对齐 dsh-im 的 sha256 前 24 位）；
4. 顶层 `appId`/`botId`/`secretRef` **保留为兼容字段**。

### 阶段 3：通道层（`lib/qq-im/channel.js`）—— **主体工作量**

| 改动 | 说明 |
|---|---|
| `const channel` → `const channels = new Map()` | 对齐 dsh-im 的 `#runtimes` |
| `start/stop/reconnect/applyConfig` | 全部按 Bot 迭代 |
| `stats` → `Map<botId, stats>` | 对齐 dsh-im 的 `#errors` 分桶（同时解决 C-2） |
| `sessionBindings` 缓存键 | **加 botId**（解决 A-2） |
| `bindingForSession` | 去掉 `?? config.botId` 兜底（解决 C-1） |
| `status()` | 返回 per-bot 数组 |

### 阶段 4：配置页（`lib/client.js`）—— 见 §四

### 阶段 5：指令（`lib/index.js`）

| 子命令 | 改动 |
|---|---|
| **新增** `im new` | 对齐 dsh-im `/new`：解绑当前聊天 + 新建会话 |
| **新增** `im session <id\|序号>` | 对齐 dsh-im `/session`：绑到指定会话 |
| **新增** `im sessions` | 对齐 dsh-im `/sessionlist` |
| `im discover` | 遍历全部 Bot（现在写死 `config.botId`） |
| `im reconnect` | 支持 `[botId]`，无参则全部 |
| `im rebind` | 去掉 `\|\| config.botId` 兜底 |
| `im targets` / `im test` | **无需改动**（已实测天然支持多 Bot） |

### 阶段 6：`canonInjected*` 语义升级

`imActive`（`index.js:963`）从布尔升级为**三态**：
`'im'` / `'story'` / **`'unknown'`（判不出时不写 `canonInjectedIm`）**。

牵动：`lib/state.js` 初值与归一、`lib/index.js` 注入分支、
**`test/canon-form.test.mjs`（8 项断言基于布尔语义，必须同步改）**。

---

## 六、实施顺序与并行关系

```
阶段 0（补红）
   ↓
阶段 1（绑定主键 + 迁移）        ← 必须先于阶段 3/5
   ↓
阶段 2（schema + config 归一）
   ↓
阶段 3（通道多实例）  ┐
                     ├─ 可并行（文件不重叠）
阶段 4（配置页）      ┘
   ↓
阶段 5（指令）
   ↓
阶段 6（canonInjectedIm）
```

**串行约束**：
- **阶段 1 最先**：主键是基础，改晚要重做测试；
- **阶段 3 与 4 可并行**：3 动 `lib/qq-im/`，4 动 `lib/client.js`；
  但**都要改 `lib/schema.js`** → schema 建议在阶段 2 一次改完，避免冲突；
- **阶段 6 最后**：依赖 `imActive` 语义稳定。

---

## 七、测试计划

### 7.1 回归基线

**已实测：15 个 im/qq-im 测试全绿**（本轮验证）。改造中每步都要保持全绿。

### 7.2 需新增

| 用例 | 守什么 |
|---|---|
| 两 Bot 绑同一 openid 互不影响 | A-1 |
| v1 → v2 迁移正确（含备份） | 阶段 1 |
| 复合键含 `\0` 时解析正确 | D-3 |
| 配置页 2→1 个 Bot 后配置正确 | D-2 |
| 配置页送的是**完整数组**（逐个字段断言） | **D-1** |
| 单 Bot 旧配置归一成 `bots:[…]` | 阶段 2 |
| `imActive` 判不出时 `canonInjectedIm` 不写 | B-1 |
| `im new` / `im session` 语义正确 | 阶段 5 |

### 7.3 承重验证（沿用仓库既有风格）

新增 `test/qq-im/verify-multibot-loadbearing.mjs`：
**拆掉复合键里的 botId**，A-1 的用例必须变红。

---

## 八、影响面汇总

| 文件 | 改动 | 破坏性 |
|---|---|---|
| `lib/qq-im/binding.js` | 复合键 + 迁移 | 🔴 **破坏性**（需迁移） |
| `lib/qq-im/config.js` | `bots` 归一 + 派生化 | 向后兼容 |
| `lib/qq-im/channel.js` | 单例 → Map（主体） | 内部 |
| `lib/schema.js` | 新增 `bots` 数组 | 向后兼容 |
| `lib/client.js` | 配置页列表式 + **完整数组写入** | 向后兼容 |
| `lib/index.js` | 命令 + `imActive` 三态 | 内部 |
| `lib/state.js` | `canonInjectedIm` 类型 | 内部 |
| `test/canon-form.test.mjs` | 8 项断言改布尔→三态 | 测试 |
| `bindings.json` | v1 → v2 | **需迁移** |

---

## 九、仍需你确认（3 条，都比之前具体）

1. **群聊 openid 是否也独立？** 你说了「openid 都是独立的」，
   但未明确是仅私聊还是含群聊。若群聊在多个 Bot 同群时相同，
   复合键就是**必需**而非「建议」。
2. **`botId` 用派生（`qq_<hash>`，对齐 dsh-im）还是允许用户自定义名字？**
   派生更省事、天然唯一、无需校验；自定义更可读（如 `qq-main`）。
   我倾向**派生为主 + 允许 `alias` 做显示别名**（dsh-im 也是这个分工：
   `botId` 派生、`alias` 可选，见 `bot-alias.mjs`）。
3. **5 个 Bot 的上限是否要硬校验？** 超限时报错还是静默忽略。

---

## 十、总结

1. **方案已可落地**，且**有权威参考**：dsh-im 的 QQ 通道就是这个模型，
   配置 `bots: []`、botId 派生、`Map<botId, runtime>`、**复合键 `botId\0conversationKey`**。
2. **你的答复消掉了最大的风险**：openid 独立 → A-1 从「最高危」降为「中」；
   「一 Bot 绑一会话」→ **B-4 投递扇出整条删除**。
3. **新的最高危项是 D-1**（配置页漏字段静默丢配置）——
   实测确认数组元素不做深合并，这是配置页改造最容易踩且最难发现的坑。
4. **主体工作量在阶段 3**（单例 → Map），**最需小心的是阶段 4**（配置页）。
5. **阶段 1 是唯一破坏性变更**，需要迁移 + 备份 + v1/v2 兼容读取。

---

## 附：实施记录（2026-09-16）

全部 7 个阶段已落地，`npm run test:all` 全绿（42 个脚本）。与计划的差异与实测修订如下：

| 阶段 | 状态 | 落地位置 | 实测修订 |
|---|---|---|---|
| 0 补红 | ✅ | 新增 `test/qq-im/multibot.test.mjs`、`test/client-multibot.test.mjs` | 无 |
| 1 数据层 | ✅ | `lib/qq-im/binding.js` | 迁移时**读入即改写** v2（load() 内同步迁移 + 备份 `bindings.json.bak-v1-*`），不必等显式触发 |
| 2 配置层 | ✅ | `lib/schema.js`（bots 数组）、`lib/qq-im/config.js`（`deriveBotIdentity` + `normalizeBotEntry` + 归一去重） | `normalizeBotEntry` 对「有 appId 但 botId 不符」**不整条丢弃**（避免 D-1 式静默丢），而是缺省才派生、显式值保留 |
| 3 通道层 | ✅ | `lib/qq-im/channel.js`（`Map<botId, QqChannel>` + `statsByBot`/`errorsByBot` + per-bot status） | `status()` 顶层保留聚合字段（started/ready/appId/lastError），新增 `bots[]` 明细——旧调用点零改动 |
| 4 配置页 | ✅ | `lib/client.js`（`imBots` 列表 + 完整数组写入 + 上限 5 + botId/secretRef 只读展示） | **botId/secretRef 用只读输入框 +「留空自动派生」提示**，不在浏览器端手写 sha256（后端 config.js 权威派生）；单 Bot 时顶层字段与 `bots[0]` 同步 |
| 5 指令 | ✅ | `lib/index.js`（`im new` / `im session` / `im sessions`；discover 遍历全部 Bot；reconnect `[botId]`；rebind 去 `config.botId` 兜底） | `im rebind` 保留**单 Bot 配置下的归属兜底**（只有一个机器人时归属无歧义），多 Bot 且无绑定才报错；`im new` 由 `createSessionFor` 之外**显式写回新绑定**（否则下一条消息会再自动建会话） |
| 6 三态 | ✅ | `lib/index.js`（`imActiveFor` 三态）、`test/canon-form.test.mjs`（重写断言） | `'unknown'`（IM 已启用但本会话未绑定）不写 `canonInjectedIm` 且**不参与 formChanged 对比**（否则每轮重注） |
| 7 承重 | ✅ | 新增 `test/qq-im/verify-multibot-loadbearing.mjs`（拆复合键 → A-1 变红） | 并入 `test:loadbearing` |

**额外修订（不在原计划内，实测暴露）**：
- `lib/qq-im/inbound.js`：`routeInbound` 带 botId 精确查绑定，未命中时退回「任意 bot 的该 conversationKey」（保留「换机器人不丢角色会话」的旧语义，`inbound.test.mjs` 既有用例钉死）。
- `lib/qq-im/credential-apply.js`：扫码落地在**多 Bot 配置下把新机器人追加进 `bots` 数组**、使用按 appId 派生的 secretRef 写凭据（凭据隔离）；单 Bot 旧路径行为不变（`credential-apply.test.mjs` 原有断言不动）。
- `bindings.json` 版本号 1 → 2；`state.json`（通道统计）版本 1 → 2（per-bot 分桶）。

**新增测试文件**：`test/qq-im/multibot.test.mjs`（15 项）、`test/qq-im/session-commands.test.mjs`（6 项）、`test/client-multibot.test.mjs`（6 项）、`test/qq-im/verify-multibot-loadbearing.mjs`（5 项）。
**既有测试**：`npm test` 全绿；`npm run test:loadbearing` 全绿。

---

## 二次改动（2026-09-16，按使用方追加需求）

| 需求 | 落地 |
|---|---|
| 删除配置页顶部「四个分区：故事 / 节奏 / 聊天 / 预设…」说明行 | `lib/client.js`：删除该行 |
| 「故事」Tab 改名「创作」 | `lib/client.js`：TABS label 改（id 不变，localStorage 记忆不受影响） |
| 新增「读取预设」功能 | 后端 `lib/index.js`：`savePreset` 额外写 `story.json` 快照（`agent.cordis.yml` 只有渲染文本、反解析不现实）；新增 `GET /api/hds-interlude/preset?id=…`（只读，仅认 `preset-hds-` 前缀防路径穿越）。前端 `lib/client.js`：预设列表每行加「读取」按钮，把设定填回创作草稿（不自动保存，点「保存」才生效）。测试：`test/client-preset-load.test.mjs`（3 项）+ `test/verify-preset-route.mjs`（6 项） |
| 扫码「重新扫码换绑」改为**新增**机器人 | `lib/qq-im/credential-apply.js`：扫码永远「新增」——有旧配置（显式 `bots` 或顶层 appId）时旧机器人合成/保留进 `bots` 数组，新扫的追加（appId 相同则覆盖该条 = 重扫同一 bot）；凭据写到新 bot 的派生引用（隔离）。按钮文案 `lib/client.js`：「重新扫码换绑」→「扫码添加新机器人」（`client-qr.test.mjs` 断言同步更新）。测试：`credential-apply.test.mjs` 新增「单 Bot 顶层扫新 bot → 旧保留、新追加」用例 |

---

## 三次改动（2026-09-17，事故修复：新 bot 自称江柚）

**症状**：新接入的 bot 在 QQ 里自称江柚。
**排查结论**（数据实证）：
- 绑定无串号：`bindings.json` 里新 bot `qq_9db5887b3c34ee704f9e42e1` 正确绑定到独立会话
  `session-137ae395`（自己的 openid），没有复用江柚旧会话。
- 该会话 `agentPreset: "standard"`（DSH 默认，非角色预设）、hds-interlude 状态
  `canonInjected=false`、`story=null`——**插件从未给它注入江柚人设**。
- **根因**：`interlude_state` 工具是**全局注册**的，任何会话都能调；而它的输出第一行是
  `- 主角：<全局配置角色名>`（`renderStatus` 读 `config.story.character.name`，与哪个 bot 无关）。
  模型在首轮主动调用 `interlude_state`（会话时间线可见 seq 14），读到「主角：江柚」后
  就以江柚身份自称。**人设是插件全局单例**（`settings.yaml` 的 `story` 就是江柚），
  多 bot 场景下所有 bot 共享同一个全局角色名，普通会话也能从工具读到。

**修复（止血）**：`lib/index.js` 的 `interlude_state` 增加**身份暴露 gate**——
非角色会话（`!isRoleplaySession(entry.agent, entry.state)`，即没有角色预设、
未 `/interlude on`）调用时返回「本会话未启用幕间层角色」，不再暴露主角名。
gate 刻意**不用** `isRoleplayState`（它会把「收到过 QQ 消息」的会话因 `lastUserAt`
误判为角色会话）。测试：`test/identity-gate.test.mjs`（止血部分 3 项）。

**架构级修复（per-bot 人设，使用方确认要方案 2）**：每个机器人可有**独立角色**。
- 配置形态：`im.bots[]` 每项新增 `agentPreset`（该 bot 自动建会话的默认角色预设）与
  `story`（可选，per-bot 人设；不填继承全局）——`lib/schema.js` + `lib/qq-im/config.js`
  （`normalizeBotEntry` 逐字段透传，不引入 undefined）。
- 自动建会话选预设：`lib/qq-im/channel.js` `createSessionFor` 改为
  `bot.agentPreset ?? 全局 im.agentPreset ?? 绑定角色名`（per-bot 优先）。
- 人设注入与身份暴露全部 per-bot：`lib/index.js` 新增 `storyForBot` / `storyForSession`
  （经绑定表反查会话所属 bot），canon 注入、`interlude_state` 主角名、`/interlude status`
  主角名、绑定写入的 `name`（`storyNameFor`）全部用它。
- 配置页：`lib/client.js` bot 行新增「角色预设（可选，per-bot）」输入框，
  `bots[]` 完整数组逐字段含 `agentPreset`（空串显式送）。
- 测试：`multibot.test.mjs`（归一透传 +1）、`create-session.test.mjs`（bot 预设优先 +1）、
  `identity-gate.test.mjs`（per-bot story 主角名 +1）、`client-multibot.test.mjs`
  （agentPreset 字段断言 + 填写用例 +2）。

**效果**：新 bot 在配置页填独立角色预设（如「苏念」）并保存后，它自动建出的会话用
**苏念**的预设与人设，`interlude_state` 主角名也是苏念——不再自称江柚；没配的 bot
（旧 bot）行为与改版前完全一致（继承全局江柚）。

---

## 五次改动（2026-09-17，读取预设：移到创作页下拉 + 修复老预设读取失败）

- **读取入口移到创作页**：`lib/client.js` 创作 Tab 顶部新增「从预设载入」下拉
  （选中即载入设定到草稿，不自动保存）；预设 Tab 移除「读取」按钮（保留保存/删除）。
- **老预设读取失败修复**：根因是 `story.json` 快照机制（2026-09-16）晚于江柚预设的
  保存时间（09-13），老预设目录里没有快照 → 读取 404 → 前端提示失败。
  修复：`lib/render.js` 新增 `parsePresetCard`（`renderPresetCard` 的逆操作，按小节
  标签把角色卡文本反解析回结构化 story）；`lib/index.js` 的 `readPresetStory` 在
  `story.json` 缺失时回退从 `agent.cordis.yml` 的角色卡文本反解析（卡片是保存那一刻
  的忠实快照）。已用真实江柚预设文件验证：主角名/角色设定/说话风格/剧情起点全部还原。
- 测试：`client-preset-load.test.mjs`（创作页下拉读取、预设页无读取按钮）、
  `verify-preset-route.mjs`（老预设无快照反解析、parsePresetCard roundtrip，8 项）。

---

## 六次改动（2026-09-17，创作页下拉新增「＋ 新建预设」）

创作页「从预设载入」下拉末尾新增「＋ 新建预设…」选项：选中后展开内联的名称输入 +
「创建预设」按钮，**把当前草稿直接保存为新预设**（不必先点「保存」）。
后端 `POST /api/hds-interlude/presets` 支持 `body.story`（前端传草稿）优先于
`current().story`；预设页的「保存当前设定为预设」行为不变（不传 story）。
测试：`client-preset-load.test.mjs`（下拉含新建项、草稿保存、POST 携带 story，4 项）、
`verify-preset-route.mjs`（POST 带 body.story 用例，9 项）。

---

## 七次改动（2026-09-18，删除链路：watch 竞态 + 删除后清绑定，重扫开新会话）

用户反馈「删除机器人后仍然连接着」。排查结论与修复：

- **watch 竞态**（`lib/index.js`）：配置热更新回调读 `current()`，而它由另一个 watch
  更新，触发顺序不保证——若先跑会读到旧配置（被删 bot 还在），`applyConfig` 不会
  stop 它 → 连接残留。改为**直接用 watch 的 `next` 参数**。
- **删除只改草稿**（UX）：`lib/client.js` 删除按钮点击后明确提示「点保存后连接才会
  断开并生效」（连接状态显示的是服务端已保存配置的实际运行状态，与草稿无关）。
- **删除后清绑定**（本次核心）：删除 bot 只改配置、不碰持久化的绑定表——旧绑定仍
  指向删除前的旧会话，重扫后消息又进旧会话。修复两处：
  1. `lib/qq-im/channel.js`：新增 `removeBotBindings(botId)`；`applyConfig` 检测到
     bot 从**旧配置**消失（不再只看 channels Map——没启动过的 bot 在 Map 里没有
     条目会漏）→ stop 连接 + 清该 bot 全部绑定。
  2. `lib/qq-im/credential-apply.js`：扫码落地时，若扫码的 botId **不在当前配置**
     （全新 bot 或刚被删除的 bot）→ 调 `channel.removeBotBindings` 清旧绑定，
     重扫接入后开新会话；已在配置里的 bot 正常重扫不清绑定（保留会话关系）。
     report 记 `staleBindingsCleared`。
- 测试：`apply-config-reconnect.test.mjs`（删除清绑定、清空 bots，7 项）、
  `credential-apply.test.mjs`（被删 bot 重扫清绑定、在配 bot 重扫不清，13 项）。

---

## 八次改动（2026-09-18，QQ 用户端机器人命令，参考 dsh-im 实现）

对齐 dsh-im 的 `SHARED_COMMAND_CATALOG`（`/new /session /sessionlist /status /help`），
让用户在 QQ 私聊里直接给机器人发命令，**不进模型**、结果回投。

- 新模块 `lib/qq-im/bot-commands.js`（依赖注入、可单测，同 credential-apply 模式）：
  - `createBotCommandHandler`：`/help` 命令列表；`/status` 连接+绑定状态；`/new`
    解绑+新建会话+绑回；`/sessionlist` 列出可绑定会话（序号从 0）；`/session <ID|序号>`
    绑到指定会话；未知命令提示 `/help`（不把 `/xxx` 当聊天内容灌给角色）。
  - `isBotCommandCandidate`：私聊、顶格 `/` 开头、单行（对齐 dsh-im 的判定；
    群聊无可靠「@ 我」信息故不响应）。
- `lib/qq-im/channel.js`：`installQqIm` 新增 `onBotCommand` 选项；`onQqMessage` 在
  路由前拦截命令候选 → 调回调 → **回投结果**（被动回复带 msgId，不耗主动额度；
  走 `messages` 数组原样发出，不过旁白清洗/分条）→ 不进模型、不污染 lastInbound。
  新增 `ingestMessage` 暴露（与 `createSessionFor` 同类，供测试驱动整条入站链路）。
- `lib/index.js`：注入 `createBotCommandHandler({ qqIm, listStoredStates, storyNameFor })`
  作为 onBotCommand（箭头延迟引用，同 resolvePreset 的 TDZ 处理）。
- `lib/schema.js` + `lib/qq-im/config.js`：新增 `im.botCommands` 开关（默认开）。
- 测试：`test/qq-im/bot-commands.test.mjs`（14 项：命令语义单测 +
  channel 拦截集成——命令回投不进模型、`handled:false`/普通消息/关开关照常注入、
  白名单外用户命令不响应）。

---

## 九次改动（2026-09-18，机器人小卡片 + 齿轮二级面板，参考 dsh-im 的 AccountCard）

设置页机器人列表从「大面板」改为**紧凑小卡片**（对齐 dsh-im `AccountCard` +
`CollapsibleAccountSection`）：
- 卡片头只显示：**别名**（无别名显示 botId 短名）、**状态点**（绿=已连接 / 黄=连接中 /
  红=未启动或出错，有 lastError 一律红）、**「检查于 HH:MM」小字**（前端拉取
  `/status` 的时刻）、最右 **⚙ 齿轮**；点卡片头或 ⚙ 展开/收起二级面板。
- **二级面板**（齿轮展开）：
  - AppID、显示别名（编辑）；
  - **会话存放工作区**（per-bot cwd，留空继承全局 im.cwd）；
  - **角色预设**（下拉选择已保存预设，per-bot agentPreset）；
  - **投递目标（双向同步消息）**：该 bot 的绑定列表（conversationKey → 会话），
    每条可**解绑**（新端点 `POST /api/hds-interlude/qq-im/unbind`）；
  - **白名单用户**（每行一个 openid，per-bot）；
  - 只读展示 botId / secretRef（派生）、删除机器人（需保存生效）。
- 数据层：`schema` `bots[]` 新增 `cwd` / `whitelist`；`config.normalizeBotEntry` 透传；
  `channel.createSessionFor` 用 `bot.cwd` 优先；`routeInbound` 白名单拦截
  （`not-whitelisted`，空数组=不限制）；命令拦截同样受白名单约束（防绕过）；
  `status` 的 `channel.bots[]` 每项带 `cwd/agentPreset/whitelist/bindings`。
- 测试：`client-multibot.test.mjs` 重写（卡片渲染、二级面板字段、D-1 完整数组含
  cwd/whitelist、D-2 删除；8 项）、`client-im.test.mjs` 适配（先展开卡片再编辑，
  17 项）、`multibot`（cwd/whitelist 透传 +1）、`inbound`（白名单路由 +4）、
  `create-session`（per-bot cwd +1）、`verify-preset-route`（解绑端点 +2）、
  `bot-commands`（白名单外命令不响应 +1）。

---

## 十次改动（2026-09-18，状态点原因可见 + 「预设/命令」页）

- **检测状态点红的原因**（实测日志）：
  - 最常见：**凭据解析失败**——日志「无法解析 AppSecret（bot qq：凭据服务不可用，
    且环境变量 DSH_QQBOT_APP_SECRET 未设置。），该通道未启动。」→ `errorsByBot`
    记录 → 卡片红点；
  - 其次：**4009 Session timed out 重连瞬间**（SDK 自动重连中，ready 短暂为 false，
    started 为 true → 黄点；连接彻底断开前短暂红）。
  - UI 增强（`lib/client.js`）：状态点旁显示**状态文本**（已连接 / 连接中 / 出错 /
    未启动 / 状态未知），出错时红字；点与文本都带 `title`（悬停看 `lastError` 全文）；
    二级面板顶部直接列出「连接异常：<原因>」。
- **机器人命令提示移入「预设」页，Tab 改名「预设/命令」**：预设 Tab 顶部新增
  「机器人命令（在 QQ 私聊发给机器人）」区块，列出 `/status /new /sessionlist
  /session <ID|序号> /help` 及说明；Tab 标签 `预设` → `预设/命令`（id 不变，
  localStorage 记忆不受影响）。
- 测试：`client-multibot`（+2：出错卡片红字 + 二级面板显示原因，总 10 项）、
  `client-preset-load`（Tab 名 + 命令说明断言，4 项）。

---

## 十一次改动（2026-09-18，工作区目录选择器 + 隐藏派生字段 + per-bot 命令开关）

按使用方要求调整机器人二级面板：

- **工作区改为目录选择器**（不再文本输入）：新增后端端点
  `POST /api/hds-interlude/fs/list`（只读列**目录**，不写盘不执行；返回
  `{path, home, entries:[{name,path,hidden}]}`，缺省从用户主目录起步）。
  前端二级面板「会话存放工作区」显示当前值（只读）+「选择…/清除」按钮，
  点击展开**目录选择面板**：路径输入 + 前往 + 主目录 + 子目录列表（隐藏目录
  折叠）+「选择此目录」；选定即写入 `bots[].cwd`。
- **移除 botId / secretRef 只读展示**：这两项是派生字段（`qq_<hash>` /
  `DSH_QQBOT_APP_SECRET_<HASH>`），按需求不再在面板显示。
- **per-bot 机器人命令开关**（控制权限）：`schema` `bots[].botCommands`
  （默认 true）+ `config` 透传 + 卡片二级面板「启用机器人命令」开关；
  channel 命令拦截要求**全局 `im.botCommands` 与「该 bot 的 botCommands」都为开**；
  关闭后该 bot 的命令全部按普通消息处理。
- 测试：`client-multibot`（目录选择器写入 cwd、命令开关默认开/关闭写 false、
  隐藏字段断言；总 12 项）、`client-im`（派生字段隐藏断言；17 项）、
  `verify-preset-route`（fs/list 列目录 + 不存在路径报错 + 405；13 项）、
  `multibot`（botCommands 透传 +1）、`bot-commands`（per-bot 关闭命令不响应 +1）。

---

## 十二次改动（2026-09-18，红点排查 + 错误规整 + 系统目录选择器）

**机器人都红点 + 「连接异常：[object Object]」的排查与修复**：
- `[object Object]` 根因：`errorsByBot` 存的是 `{at, error}` 对象，`status()`
  /日志/前端直接拼字符串 → 显示成 `[object Object]`。修复：`channel.status()`
  用 `normalizeErrorText` 把 lastError 统一规整为字符串；前端 `errText` 兜底。
- 红点根因（实测日志）：`.credentials.yaml` **里明明有** AppSecret，但凭据服务
  （dsh-credentials）在插件启动/扫码落地的某个窗口**未注册或 resolve 失败**，
  `resolveSecret` 报「凭据服务不可用，且环境变量未设置」→ `recordBotError` → 红点。
  修复（`lib/qq-im/qq.js`）：`resolveSecret` 增加**凭据文件兜底**——凭据服务缺失
  或「查无此凭据」时，只读 `$DSH_HOME/.credentials.yaml`（粗略行匹配、剥引号、
  静默失败）。实测：两个机器人的密钥均可直接从文件读出。
- **目录选择器改用系统选择器**：浏览器无原生「host 目录选择」能力，对齐 dsh-im
  的做法——优先 DSH 的 `uiWorkspace`/`workspaces.pickDirectory`（host 侧系统
  目录选择器，返回真实绝对路径）；不可用时回退自建 `fs/list` 浏览面板。
  前端 `apply(ctx)` 解析 picker 能力并缓存，`chooseWorkspaceDir` 优先系统选择器。
- 测试：新增 `credential-resolve.test.mjs`（文件兜底/引号剥除/环境变量优先/缺值抛错/
  服务优先，5 项）、`client-multibot`（对象错误规整不显示 [object Object]、
  系统选择器优先写路径；总 13 项）。

---

## 十三次改动（2026-09-18，workspaces 裸访问崩溃修复确认 + 目录选择器弹窗化 + 全局工作区选择）

- **确认使用方修复**（`client.js` apply）：`ctx.workspaces` 裸属性访问在 cordis
  严格代理（未 inject 的服务）下会抛 `cannot get property "workspaces" without inject`
  并让 loader apply 失败 → 已改为 `ctx.get('workspaces')` 探测（与 uiWorkspace 同款），
  仅无 `get` 的裸对象 ctx（测试 mock）才退裸属性。已确认代码并全量验证。
- **目录选择器弹窗化**：自建 `fs/list` 浏览从「内联面板」改为 **modal 弹窗**
  （全屏遮罩 + 居中面板，点遮罩/取消关闭）——「选择…」在无系统选择器时弹出窗口。
  系统选择器（`pickerApi.pickDirectory`）存在时仍是宿主原生弹窗。
- **全局默认工作区也改用目录选择器**：聊天页「全局默认工作区」从文本输入改为
  「当前值 + 选择…/清除」，选择逻辑与 bot 工作区共用（系统选择器优先，回退
  modal 弹窗，写入 `im.cwd`；modal 用 `bi='global'` 区分目标）。
- **Windows 资源管理器风格弹窗**（`lib/client.js`）：目录选择弹窗改为浅色
  Windows 观感——标题栏（标题 + ✕）、地址栏（⬆ 上一级 + 路径输入（回车直达）+
  前往）、主体**左「快速访问」侧边栏 + 右文件夹网格**（图标+名称格子，高亮当前
  路径）、底部状态栏（当前路径）+ 取消/选择此目录；点遮罩关闭。后端 `fs/list`
  响应新增 `quick`（主目录/桌面/下载/文档/图片/视频/音乐，存在才列）供侧边栏。
- 测试：`client-multibot`（全局工作区弹窗选择写入、弹窗关闭断言；总 14 项，
  文件夹格子改用 includes 查找）、`verify-preset-route`（quick 断言；13 项）。
  全量 `npm run test:all` 通过。

---

## 十五次改动（2026-09-18，全局默认角色预设改下拉）

聊天页「全局默认角色预设」从文本输入改为**下拉选择**（与 per-bot 角色预设一致）：
选项 = 已保存预设（`presets`），首项「（留空：按绑定里的角色名匹配）」；
选定写 `im.agentPreset`（`updateScalar`），保存后 `buildPayload` 原样落盘。
测试：`client-multibot`（下拉存在且含预设、默认留空、选择后写入 `im.agentPreset`；
总 16 项）。

---

## 十六次改动（2026-09-18，创作页导入/导出酒馆角色卡）

按确认的方案实现（导出只 JSON；first_mes/mes_example 并入；世界书并入文本；
**不新增 schema 字段 → 已有预设零迁移**）：

- 新模块 `lib/tavern-card.mjs`（node 侧纯函数，可单测）：
  - `storyToTavernCard`：Story → `chara_card_v2` JSON，`description` 合并
    profile/perspective/world/counterpart 段；`personality`=speech、`scenario`=
    startingPoint、`system_prompt`=boundaries、`post_history_instructions`=style、
    `tags`=keywords；**完整 Story 备份进 `extensions.dsh_hds_interlude.story`**（无损）。
  - `tavernCardToStory`：**优先读 extensions 备份（100% 还原）**；纯酒馆卡走
    字段映射 + first_mes 并入「开场白」、mes_example 并入 profile「示例对话」、
    character_book 内容并入 profile「世界书」段、keys/tags 并入 keywords。
  - `parsePngChara` / `buildPngCard`（tEXt/zTXt/iTXt chara；zlib 解压/压缩、
    CRC32），`parseTavernCardFile`（按魔数自动识别 JSON/PNG）。
- `lib/client.js`（浏览器内联等价版 + UI）：创作页新增「导入 / 导出（酒馆角色卡）」
  区块——「导出 JSON 角色卡」按钮（下载 `<角色名>.tavern.json`）；
  **拖放方框**（drag/drop + 点击选文件，.json/.png，10MB 上限）→ 解析 → 填入
  创作草稿（不自动保存，点「保存」生效）；文件仅在浏览器内存解析、不上传。
- 测试：新增 `test/tavern-card.test.mjs`（roundtrip 无损、纯酒馆卡映射、PNG
  构建→解析、JSON/PNG 分派、非法输入报错，8 项）；`client-preset-load`
  （导出按钮/拖放方框、拖入 JSON/PNG 填草稿、非法文件报错不清草稿、导出触发
  下载，总 9 项）。全量 `npm run test:all` 通过。

---

## 十七次改动（2026-09-18，载入预设 → 修改 → 保存直接对该预设生效）

创作页「从预设载入」选中预设后，修改草稿再点「保存」，除保存全局配置外，
**同步更新该预设**（下次载入即新内容）：

- 后端：新增 `updatePreset(id, story, name?)`（重写 story.json + agent.cordis.yml
  角色卡 + preset.yml，presets.json 的 name/description/updatedAt 更新，createdAt
  保留）；`/api/hds-interlude/presets` 支持 **PUT**（缺参 400 / 不存在 404）。
- 前端：`onSave` 成功后若 `presetLoadId` 非空且非「＋ 新建预设」→
  `updatePresetFromDraft(id)`（PUT 携带修改后的草稿），提示「已保存，并更新到预设
  「xxx」」，失败则提示「已保存到全局配置，但更新预设失败」；未选中预设时行为不变。
- 测试：`verify-preset-route`（PUT 更新后 GET 读回新 story、agent.cordis.yml 同步、
  缺参/不存在；15 项）、`client-preset-load`（载入→修改→保存发 PUT 且携带新草稿、
  未载入不发 PUT；总 11 项）。全量 `npm run test:all` 通过。

---

## 十八次改动（2026-09-18，导入角色卡默认为新建预设）

导入行为升级：拖入/选择角色卡解析成功后，**默认新建预设**（而不是只填草稿）：
- 解析成功 → 填入创作草稿 + 显示**「导入为预设」确认条**：
  「预设名：[输入框，默认 = 角色名，可改]（重名自动加 -2 后缀）[导入并新建预设] [取消]」；
- 点「导入并新建预设」→ POST /presets 以该名字创建预设（**重名自动加 -2/-3… 后缀**），
  创建后下拉自动选中它、草稿即导入内容，提示「已导入角色卡并新建预设「名」」；
  取消则只留草稿。
- 前端：新增 `uniquePresetName`（与已有预设名去重）与 `importCtx` 状态。
- 测试：`client-preset-load`（确认条默认角色名、点导入创建并选中、**重名预填 -2**、
  PNG 同流程、非法文件仍报错不清草稿；总 13 项）。全量 `npm run test:all` 通过。

---

## 十九次改动（2026-09-18，「预设/命令」页改为预设管理）

取消「输入预设名称保存新预设」的栏目（新建/载入已收敛到创作页），把预设区重设计为
**预设管理**：

- **UI**：区块改为「预设管理」，每行显示：预设名 + 更新时间（`updatedAt ?? createdAt`）
  + 「改名」「删除」。改名行内编辑：点「改名」→ 输入框（预填当前名）→ 确定/取消。
  删除保留原逻辑。空态提示引导到创作页新建/导入。
- **后端**：`updatePreset(id, story?, name?)`——`story` 可选（传则重写内容，不传只
  改名，内容不动）；`PUT /api/hds-interlude/presets` 改为 **id 必需、story 可选**
  （重命名只传 `{id, name}`）；`listMyPresets` 返回 `updatedAt`。
- 移除：前端 `onSavePreset`、`presetName` state、「保存当前设定为预设」区块
  （创作页「＋ 新建预设」与导入已覆盖新建）。
- 测试：`verify-preset-route`（只改名不动 story、列表更新名与 updatedAt、缺 id 400；
  16 项）、`client-preset-load`（无保存栏、有改名/删除/更新时间、重命名发 PUT 只带
  name；总 15 项）。全量 `npm run test:all` 通过。

---

## 二十次改动（2026-09-18，修复酒馆角色卡导入 base64 失败与拖放卡死）

线上导入真实 SillyTavern 卡时报 `Unexpected token 'e', "eyJzcGVj…" is not valid JSON`——
根因是 **SillyTavern 官方 PNG 卡的 `chara` 块存的是 base64 的 JSON**
（`btoa(unescape(encodeURIComponent(json)))`，即「UTF-8 字节 → base64」），而本插件
此前 `parsePngChara`/`tcParsePng` 直接 `JSON.parse(chara)`，等于把 base64 字符串当原始
JSON 解析。部分分发渠道的 `.json` 文件同样可能是 base64 文本。

- **解析（node + 浏览器两侧）**：新增 `parseCardText`（`lib/tavern-card.mjs`）/
  `tcParseCardText`（`lib/client.js`），判序「先原始 JSON、后 base64」——
  原始 JSON 兼容本插件旧导出的 PNG 卡；base64 字符串不可能同时是合法 JSON，两路不冲突。
  `parseCardJson`/`parsePngChara`/`tcParseJson`/`tcParsePng` 全部改走它。
- **导出对齐酒馆**：`buildPngCard` 的 `chara` 块改为 **base64**（不再是原始 JSON），
  使本插件导出的 PNG 卡能被 SillyTavern 直接导入。
- **拖放卡死**：拖放方框的 `dragenter/dragover/dragleave/drop` 统一
  `preventDefault + stopPropagation` 并设 `dropEffect='copy'`——不 preventDefault 浏览器
  会「打开」拖入的文件（SPA 里直接导航走、白屏/卡死）；不 stopPropagation 会冒泡到
  DSH 壳自己的 drop 处理。
- 测试：`tavern-card.test.mjs` 增「base64 chara 块 / base64 .json 文本 / 既非 JSON 也
  非 base64 报错」（10 项）；`client-preset-load` 增「拖入 base64 JSON 卡也能导入」
  （16 项）。

---

## 二十一次改动（2026-09-18，安全加固 + 状态回退丢字段等）

与酒馆卡修复同批的安全/健壮性加固：

- **路径穿越**：`readPresetStory`/`deletePreset`/`updatePreset` 的 `id` 原先只做
  `startsWith('preset-hds-')` 前缀校验，`preset-hds-../../../…` 能穿越出预设目录
  （`deletePreset` 可 `rmSync(recursive)` 删任意目录）。新增 `presetDirOf()`（白名单
  字符集 + `path.resolve` 后边界校验），三处调用点改用它；`verify-preset-route` 增两条
  穿越回归。
- **per-bot story 丢失**：`client.js` 的 `normalizeImBot` 原先不携带 `story` 字段，
  数组元素整替换会在「保存设置」时抹掉多 Bot 独立人设——改为透传 `story`。
- **日志回退丢字段**：`foldFromLog` 的 `cursor > total` 分支补回非日志派生字段
  （`roleplay`/`canonInjected`/`continuity`/`reachedOut*`/`lastAutoMessageAt`/
  `commitmentFingerprints` 等）。
- **im.enabled 口径统一**：`deliverInteractiveSpeech` 去掉 `im.enabled===false` 提前返回，
  与自动推进一致（以绑定为准）。
- **自言自语闸补齐**：交互式回复与到点提醒的显式发言分支各加 `looksLikeSelfNarration`。
- **统计落盘节流**：`saveStats` 合并同一 tick 的多次调用（`setTimeout(0)`），`stop()`
  同步 flush；`readBody` 加 1MB 上限。
- 测试：全量 `npm test` 通过。

---

## 二十二次改动（2026-09-19，QQ 机器人命令新增 /preset 更改角色预设）

用户从 QQ 里直接切换角色：`/presetlist` 列出可用角色预设（序号 + 角色名）；
`/preset <ID|序号|角色名>` 用该预设**新建一个会话并接管当前聊天**（与 `/new` 同一套
「解绑 → 建会话 → 绑回」，绑定名 = 新角色名），旧会话保留、可用 `/session` 绑回。

- **后端 `lib/qq-im/bot-commands.js`**：新增 `/presetlist`（列出可用预设）与
  `/preset`（必须携带 ID|序号|角色名，缺参提示先 /presetlist）；`/help` 与模块注释同步。
  依赖注入新增两个可选依赖 `listPresets()`（列出可切换预设）与
  `resolvePresetId(nameOrId)`（按名字/id 解析预设 id），缺省时优雅降级。
- **后端 `lib/qq-im/channel.js`**：`createSessionFor(conversationKey, message, botId, options)`——
  新增第 4 个可选参数 `{ presetId }`，显式指定优先于「bot.agentPreset → 全局 →
  绑定角色名」的默认解析链（旧调用点不受影响）。
- **后端 `lib/index.js`**：新增 `listRoleplayPresets()`（presets.json 里已落盘的
  roleplay 预设，含 `preset-hds-*`）；`handleBotCommand` 装配 `listPresets` /
  `resolvePresetId`。
- **前端 `lib/client.js`**：「预设/命令」页的机器人命令说明与 per-bot 命令开关标签
  加入 `/preset`。
- **文档**：`CONFIGURATION.md` 新增 §8.9「QQ 用户端命令」表（含 `/preset`）。
- 测试：`bot-commands.test.mjs` 新增 6 项（`/presetlist` 列表 / 无预设 / `/preset` 缺参
  提示用法 / 序号切换断言预设覆盖与绑定名 / 按名字匹配 / 找不到与越界），总 21 项；
  全量 `npm test` 通过。

---

## 二十三次改动（2026-09-19，QQ 群聊适配）

在既有 `im.group.enabled` 基础上补全群聊支持（@提及判定对齐 SDK 的 `mentionGate`）：

- **schema / config**：`im.group.mentionOnly`（默认 `true`）——群聊只响应 @机器人 的消息；
  `qq-im/config.js` 归一 `group: { enabled, mentionOnly }`。
- **入站 `lib/qq-im/inbound.js`**：
  - 新增 `isGroupMention(message, config)`：四信号判定（`GROUP_AT_MESSAGE_CREATE` 事件 /
    `mentions[].is_you` / 内容里的 `<@!appId>` / **内容以「@角色名」开头**——角色名由
    通道经 `config.mentionNames` 注入：绑定 name / bot 别名 / bot 人设名，覆盖用户
    「@江柚 你好」这种纯文本提及）；
  - `routeInbound`：群开启后先过 @门控（未 @ → `group-not-mentioned`）；未绑定 + 被 @ +
    `autoCreateSession` → 允许为该群建会话（此前只允许 c2c）；
  - `renderInboundText`：来源前缀区分「来自 QQ 群」/「来自 QQ」；@ 标记剥除放宽为
    `<@!?[^\s>]*>`（兼容数字与 openid 形态）。
- **投递 `lib/index.js`**：修复群投递 scope——`bindingFor` 透传绑定表里的 `scope`，
  `deliverToIm` 用 `scope` 区分 group/c2c 并把 `targetId` 剥离前缀后再交给通道
  （避免 `group:xxx` 被拼成 `group:group:xxx`）。
- **前端 `lib/client.js`**：「聊天 → 消息行为」新增「响应群聊消息」与「群聊仅响应
  @机器人」两个开关；来源前缀文案同步。
- **文档**：`CONFIGURATION.md` §8.3 入站表增 `im.group.mentionOnly` + 群聊适配要点
  （一个群一个角色会话、回复走群内被动引用）；§8.9 注明命令仅私聊可用；README 核心能力表
  提及群聊。
- 测试：`inbound.test.mjs` 更新群用例（@门控三态、群自动建会话、`isGroupMention` 三信号、
  `renderInboundText` 群前缀），总 31 项；全量 `npm test` 通过。

## 二十四次改动（2026-09-19，修复「每条消息发两遍」）

**现象**：群聊里一次主动开口之后，QQ 侧「对了 跟你说个离谱的事」「我家楼下那家面馆 涨价了」
「一碗涨两块」**每条都出现两遍**；而状态文件 `lastDelivery` 只记了 3 条。

**根因**：同一段 `interlude_say` 被两条投递路径各消费了一次。

| 路径 | 触发 | 门控 |
| --- | --- | --- |
| 主动投递 | `handleProactive` / `handleAutoAdvance` 自己 `agent.followup` 唤起，再用 `proactiveCapture` 取回发言 | **有**（发消息间隔、每日配额、自言自语闸） |
| 交互式回复 | `turn/end` → `deliverInteractiveSpeech`，从 `tool/call` 收集 | **无**（用户先说话，回一句不算主动打扰） |

插件唤起的回合同样会发出 `turn/end`，于是第二层把同一段话又投了一遍——文字重复之外，
它还**绕过了间隔与配额**（这正是两条路径门控口径不同的后果，不是冗余的小事）。

**修复**（`lib/index.js`）：

- 新增 `pluginDrivenTurns`（会话 id 集合）+ `markPluginDrivenTurn(key)`：在
  `handleProactive`（IM 直投 / `keepPassive` / 无绑定三条分支）与 `handleAutoAdvance`
  （`story-only` 与 `speak` 两条分支）**唤起之前**打标记。
- `tool/call` 收集器：命中标记则**不收集**——这些发言归主动路径。
- `deliverInteractiveSpeech`：入口再判一次 `pluginDrivenTurns.has(key)`（扫描与 `turn/end`
  存在竞态，标记可能已被清掉），作为防御性双保险。
- 标记生命周期：`turn/end` 时删除；`user/message` 时删除——**但 `source.kind === 'plugin'`
  的除外**。这一条是修复能否真在线上生效的关键：宿主在回合开始时会把 `followup` 的消息
  以 `user/message` 落进会话，若不排除它，标记会在 assistant 发言之前就被清掉，
  「每条发两遍」原样复现（单测夹具若不模拟这一步会给出假绿）。
- **`/interlude advance`（手动推进）刻意不标记**：它没有自己的捕获路径，
  它的 `interlude_say` 正是靠交互式回复送出去的；标记它会让手动推进彻底失声。

**测试**：`proactive-cold.test.mjs` 新增端到端用例「插件唤起的回合里调了 `interlude_say`
→ 只投一次」。夹具的假 agent 现在按 `options.speech` 补发 `tool/call` 事件，并照实
先发一条 `source.kind === 'plugin'` 的 `user/message`（与真宿主一致），复现线上现场；
两处各自单独拆掉都会让该用例报「实际发出 6 条」（每条两遍），修复后为 3 条。


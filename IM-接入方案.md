# dsh-hds-interlude 接入 IM 机器人：技术方案

> 插件版本：`dsh-hds-interlude@0.1.0`（刚完成 kind→origin 映射修复）
> 宿主基线：`@deepseek-ai/dsh@0.1.2-rc.1`，profile `C:\Users\31559\.dsh\profiles\web`
> IM 载体：`@xmanrui/dsh-im@4.15.0`（**本机已安装且已在 bundles 中**，作者 xmanrui）
> 依据：本机实际安装的源码 + 插件自身实现。凡未核实处均标注 `（待确认：…）`。

> **⚠️ 本文档正文（§1–§9）是 2026-09-11 的设计稿，部分前提已被推翻。**
> 实际落地情况与后续修订见 **§10**；其中「设计 A（复用 agent 通道）不可行」
> 与「投递目标必须人工绑定」两条是本次修复的重点，**§10.4 已废除后者**。
> 读正文时请以 §10 为准。

---

## 0. 一句话结论

**输入侧不需要改造**——因为 `dsh-im` 已经完成了「IM 消息 → DSH 会话」的桥接：每条 IM 消息就是一次 DSH agent 回合，插件的 `agent/pre-step` 注入天然生效。
**只需要改造"主动消息的输出投递"这一条路径**：把目前的 `agent.followup(...)` 与 IM 投递服务 `ctx.dshIm.send(...)` 对接。

---

## 1. 插件现状：输入输出与对外入口

### 1.1 插件对外暴露的东西（都是 DSH 原生扩展点）

| 方向 | 入口 | 位置 |
|---|---|---|
| 输入（读上下文） | `agent/pre-step` waterfall → 注入 `<幕间>` 块 | `lib/index.js` L296 |
| 输入（常驻提示词） | `ctx.systemPrompt.section()` × 2（canon / rules） | L284–293 |
| 模型可调工具 | `ctx.tools.register(defineTool)` × 6：`interlude_plan` / `interlude_alter` / `interlude_memory` / `interlude_agency` / `interlude_preplan` / `interlude_state` | L326–500 |
| 人类命令 | `ctx.commands.register({name:'interlude'})` | L520+ |
| 配置 | `ctx.settings.register('hds-interlude', Config)` | L94 |
| HTTP（设置页与预设） | `ctx.webServer.register({kind:'exact', path:'/api/hds-interlude/settings'｜'/presets'})` | L192+ |
| **主动输出** | **`agent.followup(createUserMessage({...}))`** | **L683 / L702** |
| 状态 | 每会话一份 JSON：`$DSH_HOME/hds-interlude/session-<id>.json` | `lib/state.js` |

### 1.2 当前"主动输出"的实际形态（关键）

插件不自己发消息，而是**唤起 agent 让它自己写**：

```js
// lib/index.js 后台扫描（每 checkIntervalMinutes 分钟）
agent.followup(createUserMessage({
  content: [{ type: 'text', text: renderProactiveText(target, now, zone, state) }],
  source: { kind: 'plugin', plugin: name, form: 'notice', summary: `幕间到点：${target.summary}` },
}))
```

即：**插件产出的是"给模型的指令"（`<幕间>` 块），不是最终给用户看的文案**。真正的文案由角色当场写。这个设计必须保留——它让主动消息带人设和上下文，而不是模板句。

### 1.3 需要改造的部分

| 需要改造 | 原因 |
|---|---|
| **主动消息的落点** | 目前 `agent.followup` 唤醒 agent 后，消息去向由「该会话绑定的输出通道」决定。若该会话是 IM 会话，需确认 dsh-im 会把这条（非用户触发的）assistant 消息投递回 IM。**这是本方案的核心待验证点。** |
| **会话 ↔ IM 目标的绑定** | 插件需要知道「这个会话对应哪个 botId/targetId」，才能在需要时直投或携带投递提示。 |
| **提醒类 intent 的投递语义** | 目前提醒只唤起 agent；IM 场景下需要保证「用户没在 IM 里说话时，消息也能推出去」。 |
| 其余（intents / agencyWindow / reachedOut / 容量校验） | **逻辑可原样复用**，只需按 §6 调整取值来源。 |

---

## 2. 目标 IM 平台与接入方式

### 2.1 本机可选平台（`dsh-im` 已内置适配器）

`plugin-src/host/channels/` 下已有：`feishu`、`weixin`、`dingtalk`、`wecom`、`qq`、`slack`、`telegram`、`discord`、`whatsapp`、`office`。

- **微信 / 企业微信 / 钉钉 / 飞书 / QQ**：走各平台官方机器人或 webhook，由 dsh-im 适配器托管（需要凭据）。
- **Telegram / Discord / Slack / WhatsApp**：同上。
- `office` 通道为特殊通道（不带 `deliveryService`，见 `index.mjs` L33）。

### 2.2 凭据与状态（dsh-im 已约定的位置）

| 内容 | 位置 |
|---|---|
| 凭据 | `ctx.credentials` → `$DSH_HOME/.credentials.yaml`（本机实测可见 `DSH_WEIXIN_BOT_TOKEN_*`、`DSH_QQBOT_APP_SECRET_*` 等 ref） |
| 通道运行时状态 | `$DSH_HOME/integrations/dsh-<channel>/`（每 bot 一个 `state.json`） |
| 界面语言等 | `$DSH_HOME/integrations/dsh-im/interface-language.json` |

### 2.3 待确认

- **（待确认：你要接哪个平台）**——不同平台的"主动推送"能力差异很大：
  - 微信/QQ 个人号：受平台风控，主动推送有严格限制（可能需"用户先说过话"的会话窗口）。
  - 飞书/钉钉/企微/Telegram/Slack：通常允许应用主动发消息（受各自频率与权限约束）。
- **（待确认：是否已有可用的 bot 凭据）**——本机 `.credentials.yaml` 里有微信/QQ 相关 ref，但是否有效、是否已完成扫码/授权，需要你在设置页确认。
- **（待确认：公网 webhook 是否需要）**——大部分平台需要公网可达的回调地址；dsh-im 的 HTTP 通道 (`delivery-http.mjs`) 是否配合隧道使用，需按其部署文档确认。

---

## 3. 消息链路设计

### 3.1 收（IM → 插件）——无需改造

```
用户在微信/QQ 发消息
      ↓  （平台适配器，dsh-im 负责：鉴权、去重、TTL、会话映射）
dsh-im 把它落成某个 DSH session 的 user message
      ↓
DSH agent loop 触发一次回合
      ↓
插件 agent/pre-step 注入 <幕间>（时间间隔 / 到期待办 / 气氛底色 / 日程）
      ↓
角色（模型）写回复 → 这是该 session 的 assistant message
      ↓  （dsh-im 负责：投递回原 IM 目标）
用户看到角色的回复
```

**结论**：输入链路完全复用现有实现，插件的 `agent/pre-step` / 工具 / 命令照常工作。

### 3.2 发（插件的主动消息 → IM）——两种可选设计

#### 设计 A：复用 agent 通道（推荐，改动最小）

```
后台扫描发现到期 intent（或达到自动推进间隔）
      ↓
插件 agent.followup(<幕间> 指令)
      ↓
agent 被唤醒 → 角色写出一条自然消息（带人设）
      ↓
该 assistant message 沿 session 的输出通道产出
      ↓
【待验证】dsh-im 是否会把这条投递到 IM 目标
```

- **优点**：文案由角色当场写，人设/上下文一致；插件不碰投递细节。
- **前提**：dsh-im 对"非用户触发的 assistant 消息"也会投递。
- **若前提不成立**：退化为设计 B。

#### 设计 B：直投（兜底，可靠性最高）

```
后台扫描发现到期 intent
      ↓
插件先让 agent 生成文案（followup 或直接读最近会话）
      ↓
插件调 ctx.dshIm.send(botId, targetId, text, options)
```

关键接口（**已从源码核实**）：

```js
// dsh-im 宿主通过 ctx.provide('dshIm', …) 暴露（index.mjs L76-82）
ctx.dshIm.send(botId, targetId, text, options)  // 主动投递
ctx.dshIm.listTargets(botId)                    // → [{ targetId, … }]
ctx.dshIm.listBots()                            // → [botId, …]
```

约束（`delivery-service.mjs` L3-5）：

```js
BOT_ID_PATTERN    = /^[A-Za-z0-9_-]{1,128}$/
TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/
CHANNEL_PATTERN   = /^[a-z][a-z0-9-]{0,31}$/
```

可选：**混合**——优先走 A；若在某会话上无法确认 IM 投递可达，则该会话**不启用**主动联系（宁可不发，也不发错地方）。

### 3.3 插件侧需要的改造（伪代码）

```js
// 新增：会话 → IM 投递目标 的绑定（来自 dsh-im 的会话同步或用户显式绑定）
const imBindingOf = (sessionKey) => imBindings.get(sessionKey)   // { botId, targetId, channel } | undefined

// 后台扫描：主动联系分支改造
if (capacity.allowed) {
  const binding = imBindingOf(key)
  if (binding) {
    // 设计 A：唤起 agent，由 dsh-im 投递（期望行为）
    target.status = 'delivered'
    state.reachedOut = (state.reachedOut ?? 0) + 1
    saveState(key, state)
    agent.followup(createUserMessage({ /* <幕间> 指令 */ }))
  } else {
    // 无 IM 绑定：保持现有行为（仅在 DSH 界面内唤起）
    agent.followup(createUserMessage({ /* <幕间> 指令 */ }))
  }
}
```

> 注意：**不要**在插件里硬编码平台凭据——一律走 `ctx.dshIm` / `ctx.credentials`，由 dsh-im 统一管理。

---

## 4. 定时类 intent（提醒）的调度与推送

### 4.1 现状（已实现且已验证）

```
用户："三分钟后提醒我喝水"
  → 角色调 interlude_plan 工具（本次修复后已确认会调）
  → 状态：intents:[{ id:'i1', kind:'reminder', dueAt, status:'pending' }]
      ↓  后台扫描每 checkIntervalMinutes（默认 5）分钟跑一次
  到期判定：now - intent.dueAt >= graceMinutes（默认 1 分钟）
      ↓  容量校验（见 §6）
  agent.followup(<幕间>：到期待办 …)   ← 修复后此处可正常放行
      ↓
  intent.status = 'delivered'，reachedOut += 1
```

**本次已修的三处**（都与本方案直接相关）：

| 修复 | 说明 |
|---|---|
| 规则要求模型用 `interlude_plan` 记录 | 此前模型只口头答应、不落库（`intents: []`） |
| `graceMinutes` 默认 10 → 1 | 3 分钟提醒此前要 13 分钟才触发 |
| **kind→origin 映射** | 此前 `reminder` 被映射成 `life-event`，被 `activityLoad: 'occupied'` 拦下；现映射为**承诺型**（`promise`），只受设备/隐私约束，不受"忙"约束 |

### 4.2 IM 侧的调度与长时运行风险

| 关注点 | 现状 | IM 场景需要做的 |
|---|---|---|
| 调度器 | 插件内 `setInterval`（`every()`，unref'd），随插件加载启动 | 需保证 DSH 进程常驻（见 §7） |
| 跨重启 | `intents` 已落盘（`state.json`），重启后仍在 | **重启后已到期的 intent 会被立即补发**——需确认是否符合预期（可能一次性涌出多条） |
| 时区 | `timeZone`（默认 `Asia/Shanghai`） | IM 用户可能跨时区，`（待确认：是否需要按用户时区）` |
| 平台限流 | 插件侧只有"每日上限 `maxPerDay`（默认 6）" | 需叠加平台侧频率限制（见 §5.3） |
| 免打扰 | `restWindows`（默认 23:00–07:00） | IM 场景建议保留，并按用户作息调整 |

---

## 5. 多用户/多会话的隔离、鉴权与限流

### 5.1 状态隔离（现状已天然支持）

- 插件状态**按 `session.id` 分文件**：`$DSH_HOME/hds-interlude/session-<id>.json`（`sessionKeyOf()` 取不到 id 时**整层静默关闭**，不会跨会话串状态）。
- `intents` / `agencyWindow` / `alter` / `preplan` / `reachedOut` 全在该文件内，天然按会话隔离。
- 后台扫描遍历 `liveAgents`（活跃会话表），对每个会话独立判定。

**IM 场景推论**：只要 dsh-im 为每个 IM 会话/用户建立独立 session，隔离就是**免费**的。需要确认的是：

- **（待确认：dsh-im 是"一个 IM 联系人 = 一个 DSH session"，还是"一个群 = 多 session"）**——这决定 `reachedOut` 计数与 `agencyWindow` 的粒度。
- **（待确认：群聊场景）** 插件目前的设计是"一个会话一个主剧本"；若一个群里有多人，角色对"当前说话人"的 `counterpart` 是共用的，可能需要按发言人细分。

### 5.2 鉴权

| 层 | 谁负责 | 说明 |
|---|---|---|
| IM 平台鉴权（AppID/Secret、webhook 验签） | **dsh-im**（`ctx.credentials` + 各通道适配器） | 插件**不应**接触凭据 |
| 插件设置页 HTTP 路由 | 宿主 webServer 自带会话鉴权 | 实测：无 token 访问返回 `unauthorized` |
| 插件工具/命令的调用者 | DSH agent 运行时 | `callerAgent(exec)` 解析调用方会话（已加 `liveAgents` 兜底） |

### 5.3 限流（插件侧已有 + 建议补充）

| 限流维度 | 现状 | 建议 |
|---|---|---|
| 每会话每日主动数 | `proactive.maxPerDay = 6` | 保持不变；IM 场景可按平台下调（如 3） |
| 主动联系最小间隔 | `agency.minimumProactiveIntervalMinutes = 60`（承诺型可绕过） | IM 场景建议保留普通类的 60 分钟 |
| 后台扫描周期 | `proactive.checkIntervalMinutes = 5` | 多用户下建议调到 10–15 分钟，降低空转 |
| **平台侧频率** | 无 | **需补充**：按平台限制做全局令牌桶（`（待确认：各平台主动消息频率上限）`） |
| **失败退避** | 无 | **需补充**：投递失败时 `intent` 不置 delivered、指数退避重试，避免死循环 |

---

## 6. agencyWindow 在 IM 场景的取值与容量校验调整

### 6.1 字段语义在 IM 场景下的映射

`agencyWindow` 三个枚举字段，在 IM 语境下应重新解释（模型给出的 `basis` 是自然语言依据）：

| 字段 | DSH 界面场景 | **IM 场景建议语义** |
|---|---|---|
| `activityLoad` | 角色在忙什么 | 角色"手上是否腾得出来"：`free` 午休/通勤，`occupied` 开会/正事，`overloaded` 睡觉/加班冲刺 |
| `privacy` | 旁边有没有人 | **"能不能当众看手机"**：`private` 独处，`shared` 有熟人在旁，`public` 人多/公共场合 |
| `deviceAccess` | 设备是否可用 | **"手机在不在手边"**：`available` 拿着手机，`limited` 只能瞄一眼，`unavailable` 手机不在身边/静音（这个字段在 IM 场景最有解释力） |

### 6.2 容量校验放行规则（现状 + 已做的调整）

`evaluateAgencyCapacity()`（`lib/agency.js`，逐行移植自原项目）的判定顺序：

```
1. 窗口缺失/过期                        → 拒绝 agency-window-missing-or-expired
2. deviceAccess = unavailable           → 拒绝 device-unavailable
3. deviceAccess = limited               → 拒绝 device-limited
4. activityLoad = overloaded            → 拒绝 schedule-overloaded
5. disclosure=personal 且 privacy≠private → 拒绝 privacy-insufficient
6. 非承诺型 且 距上次发言 < 最小间隔      → 拒绝 minimum-proactive-interval
7. activityLoad = occupied 且 非承诺型/非实用更新 → 拒绝 schedule-occupied
```

**本次已做的两处适配**（都在 `lib/index.js` 的扫描里，不改纯逻辑模块）：

```js
// ① 窗口缺失时不再硬拦（模型几乎不会主动报 agency，导致此前永远无法主动联系）
const agencyWindow = (state.agencyWindow && new Date(state.agencyWindow.validUntil) > nowDate)
  ? state.agencyWindow
  : { activityLoad: 'free', privacy: 'private', deviceAccess: 'available', validUntil: … }

// ② kind → origin 映射修正：承诺型不受"忙"约束
origin: (target.kind === 'promise' || target.kind === 'reminder'
  || target.kind === 'contact' || target.kind === 'reply') ? 'promise' : 'life-event'
```

### 6.3 IM 场景下的进一步建议

1. **`deviceAccess` 权重最高**，天然贴合 IM（"手机不在手边"是最合理的"不回消息"解释）。建议在规则里显式告诉模型这个语义（当前 `renderRules` 未展开三字段语义）。
2. **群聊 vs 私聊**应影响 `privacy` 的判定：群里发言默认更接近 `public`，宜对 `disclosure: 'personal'` 更严格。
3. **平台风控**应作为第 8 条硬约束：即使容量允许，平台不允许主动推送时也不发（标记 intent 延后而非投递失败）。
4. 建议把「投递可达性」纳入校验：无 IM 绑定 / 通道未连接（`bot-not-connected`）时不置 delivered。

---

## 7. 落地步骤与部署形态

### 7.1 分阶段落地

**阶段 0：确认前提（先做，决定后面怎么写）**
1. 确认 dsh-im 是否已配好至少一个通道（设置 → IM机器人，看通道是否显示已连接）。
2. 确认 dsh-im 是否把"非用户触发的 assistant 消息"投递回 IM（设计 A 是否成立）——**这是全案的关键分叉点**。
3. 确认 dsh-im 的会话粒度（一人一会话 / 一群一会话）。

**阶段 1：打通主动投递（最小可用）**
1. 在插件里实现 `imBindingOf(sessionKey)`：优先从 dsh-im 的会话同步信息推导；若拿不到，提供 `/interlude bind <botId> <targetId>` 命令手动绑定。
2. 主动联系分支：有绑定 → `agent.followup`（设计 A）；无绑定 → 保持现状。
3. 通过 `/interlude status` 增加一行"IM 绑定"以便排障。

**阶段 2：兜底直投（设计 B）**
1. 若阶段 1 验证下来设计 A 不成立，则用 `ctx.dshIm.send(botId, targetId, text)` 直投。
2. 文案来源：让 agent 先生成（followup 或一次轻量生成），**不要**用模板句——否则丢人设。

**阶段 3：加固**
1. 平台频率令牌桶 + 投递失败指数退避 + 不置 delivered。
2. `deviceAccess` 语义写进 `renderRules`；群聊 vs 私聊影响 `privacy`。
3. 跨重启补发策略（是否合并/丢弃过期 intent）。

### 7.2 部署形态

| 形态 | 说明 | 适用 |
|---|---|---|
| **随 DSH 进程常驻（推荐）** | 主动联系依赖进程内的 `setInterval`；DSH 常驻则调度常驻 | 个人自用、单机 |
| 独立调度进程 | 把"到期扫描"挪到外部（读同一个 `state.json`，或在 DSH 里暴露 HTTP 触发） | 需要 DSH 时开时关 |
| 多实例 | **当前架构不支持**：状态是本地 JSON、无分布式锁，多实例会重复投递 | 需先加外部锁与版本检查 |

> 本机实测：DSH 由 `DSHTray` 托管（日志 `dsh-out.log`）。用托盘常驻即可满足"进程常驻"。

---

## 8. 风险点

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| 1 | **平台主动推送限制**（尤其微信/QQ 个人号） | 到点发不出去，或账号受限 | 优先用允许主动推送的平台（Telegram/Slack/飞书/企微）；加平台级令牌桶 |
| 2 | **设计 A 不成立**（dsh-im 不投递非用户触发的消息） | 主动联系在 IM 侧静默失效 | 阶段 0 先验证；不成立则走设计 B 直投 |
| 3 | **重启后补发风暴** | 一次性涌出多条过期提醒 | 跨重启策略：过期超阈值的 intent 合并为一条或丢弃 |
| 4 | **投递失败被误标 delivered** | 用户收不到，且不再重试 | 改为"投递确认后才置 delivered" + 退避重试 |
| 5 | **群聊串味** | 角色把 A 的私事说给群 | 按会话隔离（现状已支持）；群聊收紧 `privacy` 判定 |
| 6 | **时区错位** | 半夜给用户推消息 | 按用户时区校准 `timeZone` 与 `restWindows` |
| 7 | **多实例重复投递** | 用户收到重复消息 | 不部署多实例；或加外部锁 |
| 8 | **模型不调工具**（历史问题） | intent 不落库 | 已加规则；可再加兜底：从会话文本里识别"提醒/答应"并自动落库 `（待确认：是否需要此兜底）` |

---

## 9. 待确认问题清单

1. **目标平台**：你要接哪个？（飞书 / 企业微信 / 钉钉 / QQ / 微信 / Telegram / Slack / Discord）
2. **bot 凭据**：是否已在「设置 → IM机器人」里配好并显示已连接？
3. **主动推送权限**：该平台是否允许应用主动发消息？有无会话窗口限制？
4. **dsh-im 投递语义**：非用户触发的 assistant 消息是否会被投递回 IM？（决定设计 A / B）
5. **会话粒度**：一个 IM 联系人 = 一个 DSH session？群聊如何处理？
6. **多用户**：这条角色是"一个人专属"还是"多人都能聊"？多人的话，角色对每个人的 `counterpart` 如何区分？
7. **公网可达性**：是否需要隧道/webhook？由 dsh-im 现有部署承担还是另配？
8. **作息与免打扰**：希望角色几点到几点不主动打扰？
9. **文案生成方式**：主动消息必须由角色当场写（推荐），还是允许模板句？

---

## 附：最小改造清单（给实现者）

> **状态：已实现（2026-09-11）**。实现时对原方案做了几处基于源码核实的调整，见下方「实现回填」。

| 文件 | 改动 |
|---|---|
| `lib/index.js` | ① `imBindingOf()` + `/interlude bind` 命令；② 主动联系分支按绑定选择 A/B；③ `/interlude status` 增加 IM 绑定行；④ 投递失败不置 delivered |
| `lib/render.js` | `renderRules()` 补充 `deviceAccess / privacy / activityLoad` 的 IM 语义说明 |
| `lib/schema.js` | 可选：新增 `im: { enabled, botId, targetId, maxPerDayOverride }` 配置段 |
| `README.md` | 新增「IM 接入」章节与排障步骤 |

---

## 10. 实现回填（2026-09-11 实际落地情况）

### 10.1 源码核实后的关键结论

原方案的**设计 A 不成立**，已确认走**设计 B（直投）**：

- dsh-im 的会话同步（`session-sync-coordinator.mjs`）只在 `state.origin === 'dsh'`
  且 `consumeDshImInputOrigin(...)` 为真时投递；`agent.followup()` 发起的回合 origin
  是 `other`，**永远不进这个通道**。所以「唤起即投递」是一条黑洞路径。
- `agent.followup(message)` 的签名只有入参、**没有回执也没有错误出口**
  （`dsh-agent/lib/types/runtime-types.d.ts`），因此插件无法知道角色写了什么。
- QQ 侧被动回复受平台限制：同一来消息的被动回复上限 4 条/小时
  （`@tencent-connect/qqbot-nodejs` 的 `ReplyLimiter`，默认 `limit: 4`）。
- `ctx.dshIm.send()` 要求目标**已注册**：未注册的 targetId 会抛 `unknown-target`
  （`delivery-service.mjs` L311-312）。所以必须先在设置里建目标，不能只填个名字。

### 10.2 与方案不同的实现选择

| 项 | 方案 | 实际实现 | 原因 |
|---|---|---|---|
| 触发方式 | A（靠 dsh-im 投递） | **B：followup 唤起 + 事件流取回文本 + `ctx.dshIm.send` 直投** | A 已被源码证伪 |
| 取回文本 | 未涉及 | 新增 `lib/capture.js`：监听 `session/event`，在 `assistant/message` 累积文本、`turn/end` 立即结算 | `followup` 无回执 |
| 分条 | 未涉及 | 新增 `lib/im.js`：`cleanImText`（去旁白/动作/Markdown）+ `splitImText`（按句/标点/宽度切，上限 4 条） | 真人聊天是一条一条发的 |
| 服务访问 | `ctx.dshIm?.send` | `resolveImService(ctx)` 包 try/catch | **Cordis 里访问未 inject 的服务会抛错**，可选链挡不住 |
| 记账 | 唤起即 `delivered` | 投递确认后才 `delivered`，失败退避重试（最多 3 次） | 见风险 #4 |
| 重启补发 | 未定 | 超 6 小时的到期待办标 `expired` 不补发；同批合并成一次开口 | 见风险 #3 |
| 自动推进 | 未涉及 | **有绑定的会话默认推 IM**（`im.deliverAutoAdvance` 默认 `true`，占一个每日名额）；没有绑定的 Web 会话只在本地补写 | 只关投递会让角色「说给空气听」（线上第 7 轮）；要收不到就关 `runtime.autoAdvanceEnabled` |

### 10.3 新增命令

```
/interlude im                 查看绑定、投递服务状态、上次投递结果
/interlude im targets         列出可用 Bot 与已注册目标（含 route），用于找到 botId/targetId
/interlude im discover        列出从「会话双向同步」自动发现的会话→目标映射（2026-09-12 新增）
/interlude im bind <bot> <t>  把本会话绑定到某个投递目标（优先级高于配置）
/interlude im unbind          解除会话绑定，回退到插件配置或自动发现
/interlude im test [a|b|c]    用 | 分隔多段做一次真实投递测试，验证「一条一条」效果
```

### 10.4 投递目标的取得方式（2026-09-12 修订）

**原文要求「必须人工去设置里建目标 + `/interlude im bind`」——这一条已被废除，
它本身就是「不主动回复」的根因。**

原因：把「主动开口能不能送出去」压在一个人工步骤上，任何一次忘记配置都会让
主动消息在聊天窗口里**静默消失**——插件内部记账显示成功，用户侧什么都没有。
线上实测正是如此：QQ 会话的 `reachedOut` 长期为 0，`imBinding` 从未设置。

现在改为**自动发现优先**（`im.autoDiscover`，默认开）：

```
$DSH_HOME/integrations/dsh-<channel>/workspaces.json
  └─ deliveryTargets[botId][targetId].sessionSync.conversationKey
$DSH_HOME/integrations/dsh-<channel>/{bots,accounts}/<botId>/state.json
  └─ sessions[conversationKey] = sessionId
```

dsh-im 的「会话双向同步」本来就把这两份映射写好了（它靠它们把 IM 消息路由进
会话），插件只做只读反查，因此长期有效、零维护。三层优先级：
会话级 `im bind` → 插件配置 `im.botId`/`im.targetId` → 自动发现。

仍然需要人工做的只有一件事：在 **设置 → IM机器人 → 目标行** 打开
**「会话双向同步」**开关。没有这一步，插件无从知道该往哪儿发
（`ctx.dshIm` 只暴露 `send`/`listBots`/`listTargets`，而 `listTargets`
恰好把 `conversationKey` 剥掉了），此时启动日志会显示 `开但未绑定目标`。

### 10.5 测试覆盖

`npm test` 共 130 项：逻辑层 26、IM 分条 32、主动投递 30、冷会话主动开口 21、
插件挂载 21、客户端冒烟 1。

其中主动投递部分覆盖：旁白剥离、分条上限、超出合并不丢字、emoji 不被切断、
中途失败如实记账、`sent !== true` 视为未确认、dsh-im 缺失时不崩、过期与合并策略。

冷会话主动开口部分（`test/proactive-cold.test.mjs`）覆盖本次修复的四个断点：

| 用例 | 防的是什么 |
|---|---|
| 自动发现绑定 | 忘了 `im bind` 就静默发不出去 |
| 旧状态文件迁移 | 升级后第一次扫描看不见历史会话 |
| 冷会话 + 磁盘待办 → 唤醒并投递 | 扫描只看 liveAgents，没人说话就永远轮不到 |
| 未来的到点时间挂精确定时器 | 「一分钟提醒」要等一个扫描周期才响 |
| 休息时段不吞承诺型待办 | 角色当场答应的事被「你该睡了」吞掉 |
| 投递失败保留待办 | 没送到却记成已送达 |
| 并发扫描每条待办只开口一次 | 两条扫描读到同一份 pending，同一句话说两遍 |
| 服务缺失时安静跳过 | Cordis 未声明服务会抛错，可选链挡不住，扫描刷屏 |


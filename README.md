# dsh-hds-interlude

> 聊天在幕前发生，生活在幕间继续。

**dsh-hds-interlude** 是把 Koishi 插件 [hds-interlude](https://github.com/euphoriaaaaaa1/hds-interlude)（持续叙事聊天框架 / 幕间系统）移植到 **DeepSeek Harness（dsh）** 的插件。

它给 dsh 的 agent 补上 hds-interlude 的核心能力：**时间感知的持续生活**——用户消息只是角色生活里发生的一件事，角色会先补写从故事游标到现在已经发生的生活，再决定看见、沉默、立即回复、延迟回复，或在合适时机主动开口。

---

## 与原项目的关系（重要）

- **纯逻辑模块逐行移植**：`clock.js`、`alter.js`、`agency.js`、`preplan.js` 四个模块是把原项目 `src/time.ts`、`src/alter.ts`、`src/agency.ts`、`src/schedule-preplan.ts` 的纯函数逐行翻译为 ESM（去类型标注，逻辑与语义保持一致），并配套 26 项单元测试逐函数验证。
- **DSH 集成层重写**：入口、注入、工具、命令、持久化落在 DSH 原生扩展点（`agent/pre-step`、`ctx.systemPrompt`、`ctx.tools`、`ctx.commands`、`ctx.settings`、`agent.followup`）上。
- **许可证**：本移植是原项目（AGPL-3.0）的**衍生作品**，因此按 **AGPL-3.0** 分发（见 `LICENSE`）。这意味着它可作为独立插件在 dsh 生态分发，但**不能并入 MIT 的 dsh 上游**。细节见 `MIGRATION.md`。

---

## 核心功能

| 能力 | 说明 | 落点 |
| --- | --- | --- |
| 幕间时钟 | 从 session 日志折叠出「距上次互动过了多久 / 现在几点 / 处在哪个时段」 | `agent/pre-step` 注入 `<幕间>` 块（每回合仅第一个 step 注入一次，避免多 step 回合重复） |
| 延迟意图 / 承诺回访 | 模型记下到点要处理的事，到期重新进入上下文 | `interlude_plan` 工具 + 后台扫描 |
| 情绪偏移追踪（Alter System） | 模型报告氛围净变化（-5..+5），累积过阈值成为底色，同向增强、反向消退 | `interlude_alter` 工具 |
| 主体行动窗口（Agency Window） | 日程负荷 / 隐私 / 设备构成主动联系的外部容量约束 | `interlude_agency` 工具 + 后台校验 |
| 近期日程（Schedule Preplan） | 周规律 + 日期例外，半日投影进提示词；固定日程边界作为自动推进锚点 | `interlude_preplan` 工具 |
| 长期事实 / 设定演化 | 承诺、事件、世界事实；非破坏性的 character/perspective/world/relationship 演化 | `interlude_memory` 工具 + `/interlude` 命令 |
| 主动联系 | 到期待办经 `agent.followup` 唤起一次自然开口；有绑定就直投聊天软件 | 后台扫描 |
| 故事续写 | 无对话时按「写故事间隔」续写角色的生活，**只留在 DSH 里**，是叙事 | 后台扫描 |
| 发言分离 | 只有角色在续写里**整句引号写出来的话**才会发给用户，并受「发消息间隔」与每日配额约束 | `lib/story.js` 判定 |

> **写故事 ≠ 发消息。** 这是两条独立的节奏：故事默认每 40 分钟续写一段（留在 DSH 里，
> 可以有旁白、动作、场景），发给用户的消息默认最多每 120 分钟一条，而且**只有在角色
> 真的说了话的那一轮**才发。两个间隔都能在设置里改；把 `im.autoMessage` 关掉就变成
> 「只写故事，一条都不发」（到点的提醒/承诺仍照常送达）。
> 判定为什么是确定性的、什么算「角色说了话」，见 `改版-故事续写与发言分离.md`。

---

## 架构与模块映射

| 本包文件 | 对应原项目 | 职责 |
| --- | --- | --- |
| `lib/clock.js` | `src/time.ts` | 时区校验、本地时间端点、日照时段、Intl formatter 缓存（逐行移植） |
| `lib/alter.js` | `src/alter.ts` | Alter 状态机、动态阈值、权重、提示词投影（逐行移植） |
| `lib/agency.js` | `src/agency.ts` | 行动窗口校验、容量矩阵、去重、重查时间（逐行移植） |
| `lib/preplan.js` | `src/schedule-preplan.ts` | 周规律/例外合并、日期展开、半日投影、推进锚点（逐行移植） |
| `lib/schema.js` | `src/index.ts` 的 `Config` | 配置契约（schemastery），节选 StoryDefaults/Runtime/Agency/Alter/Preplan |
| `lib/state.js` | `src/database.ts` + 部分 `service.ts` | 13 张表 → 每会话一个 JSON 文档；日志折叠、意图、事实、演化 |
| `lib/render.js` | `src/narrator.ts` 的提示词投影 | Canon 段、规则段、故事写作规则、幕间块、状态摘要 |
| `lib/story.js` | `src/narrator.ts` 的「自动 prose + 投递决策」 | 续写文本 → 台词的确定性提取、发言门控（间隔/配额/绑定） |
| `lib/index.js` | `src/index.ts` 外壳 + `service.ts` 编排 | 入口、注入、工具、命令、后台扫描 |

**未移植（DSH 无对应物）**：`database.ts`(Koishi SQLite)、`narrator.ts`(自建 OpenAI 调用，DSH 由 `ctx.llm` 提供)、`logging.ts`(颜文字日志)、`qq-face.ts`、群聊意愿、OneBot/NapCat、视觉、Puppeteer、表情包。详见 `MIGRATION.md`。

---

## 目录结构

```
dsh-hds-interlude/
├── lib/
│   ├── index.js       # 入口：name/inject/Config/apply
│   ├── schema.js      # 配置契约（schemastery）
│   ├── state.js       # 状态模型 + JSON 持久化 + 日志折叠
│   ├── render.js      # 提示词投影
│   ├── clock.js       # 时间（逐行移植 time.ts）
│   ├── alter.js       # 情绪偏移（逐行移植 alter.ts）
│   ├── agency.js      # 行动窗口（逐行移植 agency.ts）
│   └── preplan.js     # 近期日程（逐行移植 schedule-preplan.ts）
├── test/
│   ├── logic.test.mjs    # 26 项纯逻辑单元测试
│   └── plugin.test.mjs   # 18 项真实 cordis 挂载冒烟测试
├── cordis.patch.yml   # bundle 补丁（安装清单）
├── package.json
├── README.md
├── MIGRATION.md       # 功能对照表 + 行为差异
└── CONFIGURATION.md   # 配置项参考
```

---

## 构建

本包为纯 ESM JavaScript，**无需编译**。`lib/` 下的 `.js` 即运行产物，dsh 的 loader 直接加载。

若要打包成可发布的 tgz：

```bash
cd D:/ds-harness-test/111/dsh-hds-interlude
npm pack
```

---

## 安装

### 方式 A：link 本地目录（开发）

```bash
dsh plugin --profile web add link:D:/ds-harness-test/111/dsh-hds-interlude
```

### 方式 B：安装打包产物

```bash
cd ~/.dsh/profiles/web
pnpm add file:D:/ds-harness-test/111/dsh-hds-interlude
# 然后手动在 cordis.patch.yml 里插入本包的 bundle 行（见 cordis.patch.yml）
```

> ⚠️ 本机已知坑（已在技能库记录）：**先停掉 DSH 再安装**。`dsh plugin add` 会转发给 pnpm 做全量重链，DSH 运行时占用文件句柄会导致「拒绝访问 (os error 5)」并可能损坏 profile 的 node_modules。若发生，可用工作区里的 `dsh-node-modules-repair.mjs` 从暂存副本还原。

---

## 加载与启用

1. 确认 `cordis.patch.yml` 已进入 profile 名单（`dsh plugin add` 会自动写入 `dsh.profile.bundles`）。
2. 启动 / 重启 DSH：

```bash
dsh web        # 或 dsh --profile web
```

3. 启动成功后终端应打印一行：

```text
[hds-interlude] 幕间层已启用 时区=Asia/Shanghai 间隔提示=40分钟 Alter=开 Agency=开 Preplan=开 主动联系=开（每日上限 6） 设定=已填 设置面板=可用（设置 → 插件） IM 直投=开（自动发现 2 个会话目标）（启动即时判定）
```

没有这行说明插件未加载（回到安装章节排查）。

`IM 直投=` 一栏会如实报告当前能不能把主动开口送到聊天软件：

| 显示 | 含义 |
| --- | --- |
| `关（dsh-im 未加载）` | 没装 dsh-im；主动开口只能在 DSH 内部发生。 |
| `开（配置 a / b）` | 用了 `im.botId` / `im.targetId`，或该会话执行过 `im bind`。 |
| `开（自动发现 N 个会话目标）` | 从 dsh-im 的「会话双向同步」自动认出了 N 个会话的投递目标。**这是期望状态**，无需手工配置。 |
| `开但未绑定目标` | dsh-im 在跑，但没有任何目标开启「会话双向同步」，也没手工绑定。 |

> 启动那一行是**即时判定**：dsh-im 是个 8 MB 的大包，服务注册偏晚，
> 所以启动瞬间可能还查不到、显示成「未加载」。若 5 秒后它就绪，会再补一行
> `IM 直投状态已就绪：…`。**以补报那行为准**；到点投递发生在几分钟之后，
> 不受启动这一瞬影响。

---

## 配置

### 可视化面板（推荐）

插件在设置页注册了**一整个「幕间系统」页面**：打开 **设置 → 左侧导航里点「幕间系统」**（与 dsh-market 的「插件市场」、DSH-IM 的「IM机器人」同级）。可以在面板里直接编辑人设 / 价值观 / 世界观 / 对手戏 / 剧情、时区、间隔提示，以及主动联系 / 自动推进 / 行动窗口 / 情绪偏移 / 近期日程的开关。

### 运行状态（只读卡片）

面板最上方有一张**只读**的「运行状态」卡片，用来回答「插件现在到底在干什么」——不必再翻 `~/.dsh/hds-interlude/` 或反复敲 `/interlude status`：

| 区块 | 内容 |
| --- | --- |
| 统计 | **实时角色会话数**、待处理待办、已到点数、今日已主动联系 / 每日上限、在挂定时器数 |
| 下次主动开口 | 下一次预计会主动发消息的**时刻**与来源（到期待办 / 续写故事），并注明会不会真的投递到聊天软件 |
| 故事续写与发消息 | **写故事**开关与间隔（+随机抖动）、**发消息**开关与最小间隔，以及各实时会话的**下次续写时间** |
| 开关芯片 | 主动联系 / 写故事 / 自动发消息 / 行动窗口 / 情绪偏移 / 近期日程 / 唤醒冷会话 / 承诺兜底，实心=开、空心=关 |
| 定时 | 角色时区、扫描周期（兜底）、进行中扫描次数与历史失败待办数 |
| 即将到点 | 未来最近 8 条待办的摘要 + 类型 + 「几分钟后」 |

**它只读**：只发 `GET /api/hds-interlude/status`，宿主端那条路由也只实现 GET（其它方法一律 405）。
不写配置、不触发扫描、不唤醒任何会话，所以放在配置表单上方没有误触风险。
内容默认每 15 秒自动刷新（可勾掉），因为「到点 / 扫描」这类数字停在静态快照上会误导人。

> 「实时角色会话」只统计**真正在用幕间层**的会话（走角色预设 `agentPreset`，或被 `/interlude on`
> 标记）——普通 Web 会话不计入。冷会话不再作为统计数字展示，但它们挂着的待办仍会到点开口，
> 所以仍参与「下次主动开口」的推算。
> 「即将到点」只列**尚未到点**的待办，已到点的计入「已到点」统计。
>
> 「下次主动开口」刻意不假装精确：待办那条是确定的（到点 + 宽限），续写那条带随机抖动、
> 还要避开休息时段，所以给的是**区间**并如实标注；没绑定聊天软件时会写明「只在 DSH 内唤起」，
> 而不是让人以为手机会响。
>
> 「下次续写」与「下次真的会收到消息」是两件事，卡片分开说：续写那一行会写明这一轮是
> **「这一轮可能发消息」**还是**「只写故事」**；后者还会给出具体原因（还没到发消息间隔 / 今日名额
> 用完 / 本会话未绑定 / 自动发消息已关闭 / 续写里没有对用户说的话）。混成一句「仅本地」的话，
> 用户会以为功能坏了。
>
> ⚠️ 首次启用这张卡片要**重启 DSH**：它依赖宿主侧新注册的
> `/api/hds-interlude/status` 路由（在 `lib/index.js` 里）。重启后刷新页面即可；
> 之后只改卡片外观（`lib/client.js`）就不必再重启。

> ⚠️ 首次启用面板需要两步：① **重启 DSH**（让服务端重新读取 `package.json` 的 `dsh.client` 声明）；② 在浏览器里 **硬刷新**（Ctrl/Cmd+Shift+R），客户端才能拉到新的卡片模块。
>
> 之后**只改 `lib/client.js` 不需要重启 DSH**：客户端模块按文件内容算 revision，
> 改完**刷新页面**就拿到新代码（宿主会自动带上新的 `rev`）。
> 只有改动 `package.json` 的 `dsh.client` 声明、或改动宿主侧（`lib/*.js`、`lib/schema.js`）时才需要重启。

### 面板的输入约定

- **保存走深合并**：宿主端 `settingsScope.update()` 是 `mergeLayers` 深合并，
  **字段缺席 = 保持原值**。所以面板每次保存都会把**全部受管字段连同空串一起提交**
  （`buildStory` 由 `FIELDS` 生成），否则「清空某个框再保存」删不掉——旧值仍在配置里，
  刷新页面又冒出来。
- **数字 0 是合法值**：`间隔提示` 由 `parseGapNotice` 解析，`0` 表示「每次都要提示」，
  不会被当成「没填」而回退成默认的 30。
- **同一帧内多次改动互不覆盖**：所有 `setState` 都用函数式更新
  （`setDraft(prev => …)`）。React 会批处理同一 tick 内的多次更新，基于渲染快照
  更新会让后一次覆盖前一次——输入法组合输入、粘贴、自动填充都会触发这种序列。

### 手写配置（等价）

面板和手写 YAML 写的是**同一份数据**。配置走 DSH 的三层命名空间（schema 默认 → `cordis.patch.yml` base → 用户层 `~/.dsh/settings.yaml`）。改完保存，**下一次回复生效**，无需重启。

最小示例（写入 `~/.dsh/settings.yaml` 顶层段）：

```yaml
hds-interlude:
  timeZone: Asia/Shanghai
  story:
    character:
      name: 水濑
      profile: 在便利店打工的普通青年，习惯把话说一半又收回去。
      speech: 短句，少用感叹号，偶尔自嘲
    perspective: 他觉得人与人之间保持一点距离更自在。
    world:
      setting: 故事发生在一座沿海小城，时间偏近未来。
      location: 沿海小城
      supportingCast: 店长佐藤，总是多管闲事。
    counterpart:
      profile: 你是第一次来的客人。
      initial: 陌生而好奇
    plot:
      startingPoint: 某个雨夜，他收留了一只受伤的猫。
      style: 日常治愈向，慢节奏
      boundaries: 不写血腥、不写现实敏感事件
```

完整字段见 `CONFIGURATION.md`。

---

## 模型可调工具

| 工具 | 作用 |
| --- | --- |
| `interlude_plan` | 记下到点要处理的事（reply/reminder/followup/contact/promise） |
| `interlude_alter` | 报告本轮氛围净变化（-5..+5） |
| `interlude_memory` | 写入 / 关闭长期事实 |
| `interlude_agency` | 更新行动窗口（日程/隐私/设备） |
| `interlude_preplan` | 提出近期日程审查结论 |
| `interlude_state` | 读取当前幕间事实 |

## 管理命令 `/interlude`

```
status / context / schedule / memory / overlay / alter / agency / preplan / advance / im / on / off / purge
```

示例：`/interlude status`、`/interlude context`、`/interlude overlay clear character`、`/interlude purge`。

IM 相关：

```
/interlude im                    # 当前绑定、投递服务、上次投递结果
/interlude im discover           # 列出从会话双向同步发现的目标
/interlude im test 在忙吗|刚下楼买了瓶水   # 试投一条（用 | 分段）
/interlude im bind <botId> <targetId>     # 手工绑定本会话
/interlude im unbind             # 解除手工绑定（自动发现仍生效）
```

---

## 主动开口是怎么送出去的

「到点主动回复」要同时满足三个条件，缺一个都会表现为**什么都没发生**：

1. **承诺得先被记下来**。待办由 `interlude_plan` 写入，而模型偶尔会「嘴上答应、忘了记」——
   插件对此有确定性兜底（见「承诺兜底」一节）。
2. **会话能被唤醒**。用户不说话时那个会话没有实时 agent；扫描会遍历
   磁盘上的会话状态，必要时用 `sessionController.resolveAgent()` 把它唤醒。
   （见 `proactive.wakeIdleSessions`）
3. **能拿到 dsh-im 的投递服务**。dsh-im 在**它自己的 ctx** 上注册 `dshIm`，
   而 `ctx.dshIm` 属性访问只认本插件自己 inject 过的服务名——对这种跨作用域的服务
   **永远抛错**。所以必须用 `ctx.get('dshIm')`（见 `resolveImService`）。
   踩过一次：QQ 消息收得到、dsh-im 客户端模块也在 boot manifest 里，
   插件却报「未加载」，到点提醒全部退回被动分支、只留在 DSH 里。
4. **文本能回到聊天软件**。dsh-im 的会话同步只推送「用户在 DSH 里发起的回合」，
   主动回合的文本不会自动进 IM。插件因此自己截获角色当场写的话，再按真人
   发消息的方式分条直投——投递目标默认从 dsh-im 的「会话双向同步」自动发现。

任一环节失败都不会假装成功：待办保留为 `pending` 等下轮重试（连续失败 3 次才
放弃并记 `failed`），当日配额也不会被消耗。

---

## 验证

```bash
cd D:/ds-harness-test/111/dsh-hds-interlude
npm test                          # 全部用例
node test/verify-live.mjs         # 只读核验真实 ~/.dsh：自动发现 + 待办盘点
node test/verify-live-replay.mjs  # 用真实状态回放一次完整投递链路（不真发）
node test/forecast-live.mjs       # 只读预演：重启后会对哪些会话主动开口
node test/verify-status-route.mjs     # 只读核验「运行状态」路由：真实数据 + 只收 GET
node test/verify-status-aggregate.mjs # 用隔离临时目录核验 pending/due/failed/upcoming 口径
node test/verify-status-roleplay.mjs  # 核验「实时角色会话」只算真正在用幕间层的会话
```

`npm test` 覆盖 12 个套件：逻辑层 26 项、IM 分条 36 项、承诺兜底 18 项、主动投递 30 项、
冷会话主动开口 21 项、插件挂载 21 项、客户端卡片冒烟 1 项、**设置页输入 9 项**
（`test/client-input.test.mjs`）、**只读运行状态视图 16 项**（`test/status-view.test.mjs`），
以及三条只读核验脚本（含一条「自动推进的话有没有真的发出去」的变异测试）。
全部应在末尾打印「失败 0 项」。

`client-input.test.mjs` 用一套足够真实的 React 替身（`useState` 跨渲染保持 +
受控 input + 可重渲染）真的渲染面板、真的派发 `onChange`，并复刻宿主端的
`mergeLayers` 深合并来做「保存 → 重开面板」的往返断言。它覆盖三类输入问题：

| 用例 | 防的是什么 |
|---|---|
| 每个输入框的 onChange 都写回它自己那条路径 | 循环里用 `var` 造成闭包共享，打字串栏/弹回 |
| 清空字段后保存并重开，框里真的是空的 | 深合并不认缺席字段，空值删不掉 |
| 清空关键词后保存，重开不残留 | 空数组同样要显式提交 |
| 间隔提示填 0 不该被悄悄改成 30 | `\|\| 30` 把合法的 0 当假值吞掉 |
| 同一帧里改两个不同字段，两处都要留下 | 基于渲染快照更新，被批处理覆盖丢字 |
| 同一帧里改两个标量，两处都要留下 | 同上，标量那份状态 |

> 后三个脚本默认读 `$DSH_HOME`（或 `~/.dsh`），**只读、不写、不发**。
> 改动主动开口类逻辑后，建议先跑 `forecast-live.mjs` 看一眼真实数据上会发生什么——
> 「修复不主动回复」时若把门槛放得太松，重启瞬间会把积压的待办一起喷出去。

`test/commitment.test.mjs` 覆盖**承诺兜底**（见 `CONFIGURATION.md` 同名小节）：
模型答应了将来的时间点却没调 `interlude_plan` 时，插件按角色自己说过的话补记一条待办。
`test/verify-commitment-replay.mjs <decompressed.jsonl>` 用**真实会话日志**回放，
验证那条线上漏记的「三分钟后喊你」确实被接住。

> ⚠️ 写这类测试时注意：`check(label, fn)` **必须 `await fn()`**。
> 端到端用例都是 async 的，只写 `fn()` 不 await 会让断言失败变成无人接管的
> unhandled rejection——测试全绿，实际什么都没验证。这个坑真实踩过一次：
> 把整个兜底关掉，18 项照样「通过」。

---

## 行为差异

与原 hds-interlude 相比，本移植有几处**结构性**差异（无法回避），已在 `MIGRATION.md` 逐项说明，要点：

1. **主叙事模型**：原插件自己调用 OpenAI 兼容接口「写剧本」；dsh 里 agent 的原生回合就是那次写作，插件改为「注入上下文 + 提供结构化工具」。
2. **消息通道**：原插件面向 QQ（OneBot/NapCat）；dsh 的输入通道由宿主决定（Web UI / headless / dsh-im）。**接入 dsh-im 后主动开口会真正投递到聊天软件**（QQ、微信等），投递目标默认从「会话双向同步」自动发现——不再是「只在本地唤起」。
3. **持久化**：原插件 13 张 SQLite 表；本插件为每会话一个 JSON 文档。
4. **Alter 侧端模型**：原插件用独立模型生成氛围描述；本插件由主模型在工具调用里直接给出描述。

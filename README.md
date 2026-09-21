# dsh-hds-interlude

> 聊天在幕前发生，生活在幕间继续。

**dsh-hds-interlude** 是把 Koishi 插件 [hds-interlude](https://github.com/euphoriaaaaaa1/hds-interlude)（时间感知的持续叙事 / 幕间系统）移植到 **DeepSeek Harness（dsh）** 的插件：用户消息只是角色生活里发生的一件事，角色会先补写从上次到现在的生活，再决定看见、沉默、回复、延迟回复，或在合适时机主动开口。

- 许可：**AGPL-3.0**（原项目衍生作品）。第三方归属见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
- 迁移对照与行为差异见 [`MIGRATION.md`](./MIGRATION.md)；全部配置项见 [`CONFIGURATION.md`](./CONFIGURATION.md)。

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 幕间时钟 | 从会话日志折叠出「过了多久 / 现在几点 / 什么时段」，注入 `<幕间>` 块 |
| 到期待办 / 承诺回访 | `interlude_plan` 记下「到点要处理的事」，到期自动回到上下文并唤起 |
| 情绪偏移（Alter） | `interlude_alter` 报告氛围净变化，累积过阈值成为应答底色 |
| 行动窗口（Agency） | `interlude_agency` 用日程 / 隐私 / 设备约束主动联系 |
| 近期日程（Preplan） | `interlude_preplan` 维护周规律 + 例外，半日投影进提示词 |
| 长期事实 / 设定演化 | `interlude_memory` 维护承诺、事件、世界事实与累积性设定演化 |
| 自动生活推进 | 无对话时按「写故事间隔」续写角色生活（只留在 DSH 里） |
| 主动联系 | 到期待办经后台扫描唤起一次自然开口，有绑定则直投聊天软件 |
| **发言分离** | **只有 `interlude_say` 里的话会被发出**；正文（故事/旁白/思考）永不外发 |
| QQ 通道（内置） | 收：QQ 私聊 → DSH 会话（幂等）、**群聊（@机器人 触发，一个群一个角色会话）**；发：主动投递 + 交互式回复；自带绑定表 |
| 未绑定私聊自动接住 | **标准功能**：收到未绑定会话的 QQ 私聊时，自动新建 DSH 会话并绑定 |
| 群聊响应 | **标准功能**：响应群聊消息（需 QQ 开放平台开通群聊权限；一个群共用一个角色会话） |

> 上表最后两项是**默认行为**，设置面板里没有开关；如确需关闭，在 `settings.yaml` 里
> 显式写 `im.autoCreateSession: false` / `im.group.enabled: false`。面板保存不会覆盖这两项。

> **写故事 ≠ 发消息。** 故事默认每 40 分钟续写一段（留在 DSH 里，可有旁白/动作/场景），
> 发出去的消息默认最多每 120 分钟一条，且**只在角色真的说了话的那一轮**才发。
> 两个间隔都可配置；关掉 `im.autoMessage` 就变成「只写故事、一条都不发」（到点提醒仍照常送达）。

---

## 安装

```bash
# 方式 A：link 本地目录（开发）
dsh plugin --profile web add link:D:/ds-harness-test/111/dsh-hds-interlude

# 方式 B：安装打包产物
cd ~/.dsh/profiles/web && pnpm add file:D:/ds-harness-test/111/dsh-hds-interlude
```

> ⚠️ **先停掉 DSH 再安装**：`dsh plugin add` 会转发 pnpm 全量重链，DSH 运行时占用文件句柄
> 会导致「拒绝访问 (os error 5)」。

> QQ 通道经腾讯官方 SDK 收发消息（`qqbot-nodejs` 协议层 + `qqbot-connector` 扫码绑定，
> 运行时按需加载）。与 `@xmanrui/dsh-im` 的关系：本插件默认**不占用 `dshIm` 服务名**，可与 dsh-im 共存；
> 但两者同时开会**重复投递**，建议停用 dsh-im（profile 的 `cordis.patch.yml` 里 `disabled: true`）。
> 详见 `CONFIGURATION.md` §8。

---

## 快速上手

1. 启动 DSH，看到 `[hds-interlude] 幕间层已启用 …` 即加载成功。
2. 打开 **设置 → 幕间系统**：在「创作」页填主角/世界观/剧情，或直接**导入酒馆（SillyTavern）角色卡**（`.json` / `.png`）。
3. 「聊天」页可**扫码绑定** QQ 机器人（免手填 AppID/AppSecret），或手动填 AppID。
4. 在会话里给角色一个角色预设（或 `/interlude on` 标记），之后角色就在幕间「活」起来。

最小手写配置（`~/.dsh/settings.yaml` 顶层 `hds-interlude:` 段）：

```yaml
hds-interlude:
  timeZone: Asia/Shanghai
  story:
    character:
      name: 水濑
      profile: 在便利店打工的普通青年，习惯把话说一半又收回去。
      speech: 短句，少用感叹号，偶尔自嘲
    plot:
      startingPoint: 某个雨夜，他收留了一只受伤的猫。
      style: 日常治愈向，慢节奏
```

完整字段见 [`CONFIGURATION.md`](./CONFIGURATION.md)。

---

## 模型工具与管理命令

工具：`interlude_plan` / `interlude_alter` / `interlude_memory` / `interlude_agency` /
`interlude_preplan` / `interlude_state` / `interlude_say`。

命令（`/interlude`）：`status` / `context` / `schedule` / `memory` / `overlay` /
`alter` / `agency` / `preplan` / `advance` / `im` / `on` / `off` / `purge`。
IM 子命令见 `CONFIGURATION.md` §8.8。

---

## 运行环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 20.10**（建议 22 LTS） | 依赖 `node:fs` 的 `rm` 递归选项与稳定 ESM；低版本会在挂载时报语法/API 错 |
| DSH | `@deepseek-ai/dsh-agent` **≥ 0.1.5-rc.1** | 插件正文挂载依赖该版本的 `agents` / `systemPrompt` / `tools` 服务 |
| cordis | `@deepseek-ai/cordis` **^4.0.2** | `peerDependencies` 已锁定；补丁注入依赖 4.x 的 `webServer.register` 签名 |
| 操作系统 | Windows / Linux / macOS 均可 | 状态目录与文件名做了 `[A-Za-z0-9._-]` 白名单化，跨平台安全 |
| 磁盘 | 无硬性要求 | 每会话一份 JSON（通常 < 100 KB）；表情包缓存上限见 `MAX_STICKER_COUNT` |
| 网络 | QQ 通道需要 | 仅通道需要出网；不用 IM 时插件完全离线工作 |

**首次启动检查清单**

1. `dsh plugin --profile web list` 能看到 `dsh-hds-interlude`。
2. 启动日志出现 `[hds-interlude] 幕间层已启用 时区=… 写故事=…分钟 发消息=…分钟`。
3. **设置 → 幕间系统** 面板可用（不可用 = `peerDependencies` 里 `dsh-client-ui-settings` 没装上）。
4. 在会话里 `/interlude status` 返回当前会话的幕间快照。
5. （可选）扫码绑定 QQ 后，`/interlude im status` 显示 `connected: true`。

> 状态目录默认 `~/.dsh/hds-interlude/`。**升级前建议整目录备份**——它是全部角色生活、
> 承诺与待办的唯一来源。

---

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动日志没有 `幕间层已启用` | 插件没被 profile 加载 | 确认 `cordis.patch.yml` 里的 `insert` 行存在且 `name` 拼写正确 |
| 设置面板打不开 / 报缺插件 | `dsh-client-ui-settings` 未安装 | 按 `peerDependencies` 版本补齐后重装 |
| 安装时报 `拒绝访问 (os error 5)` | DSH 正在运行，文件句柄被占用 | **先停 DSH**，再执行 `dsh plugin add` |
| **正文被当成消息发出去了** | 这是最严重的故障 | 检查是否绕过 `interlude_say` 直接发了正文；跑 `npm test` 的 `story.test.mjs`（自言自语闸用例）确认门控还在 |
| 消息重复投递 | 同时装了 `@xmanrui/dsh-im` | 两者都注册会双投；在 profile 里 `disabled: true` 停用其中一个 |
| QQ 连不上（红点 + lastError） | 凭据缺失 / AppSecret 解析失败 | 看 **设置 → 幕间系统 → 聊天** 里的红色 `lastError` 原文；或用扫码绑定重新授权 |
| 到点提醒不响 | 后台扫描没看见冷会话 | 确认状态目录可读；`/interlude status` 里 `intents.pending` 是否 > 0 |
| 状态落盘失败告警刷屏 | 磁盘满 / 权限不足 | 日志有累计次数；修复后重启即可，期间对话不受影响（尽力而为语义） |

---

## 开发与验证

```bash
cd D:/ds-harness-test/111/dsh-hds-interlude
npm test                 # 全部用例（含承重验证，串行）
npm run test:loadbearing # 只跑承重验证
npm run test:live        # 只读核验真实 ~/.dsh（不写、不发）
npm run pack:dry         # 预演打包产物
```

> **承重验证（loadbearing）是什么**：这些用例会**故意拆掉**某个关键机制，断言测试随之变红，
> 再恢复机制。看到输出里的 `FAIL … → 红掉 N 条` **不是失败**，而是「这条测试确实在检验该机制」
> 的证据；整轮以退出码 0 结束才算通过。

---

## 目录结构

```
lib/
├── index.js        # 入口：注入 / 工具 / 命令 / 后台扫描 / 通道装配
├── schema.js       # 配置契约（schemastery）
├── state.js        # 每会话 JSON 持久化 + 日志折叠
├── render.js       # 提示词投影
├── story.js        # 续写 → 台词提取 + 发言门控
├── clock/alter/agency/preplan.js   # 原项目纯逻辑的逐行移植
├── im.js           # 分条与投递记账
├── tavern-card.mjs # 酒馆角色卡 ↔ Story 转换
├── vendor/         # 第三方移植（见 THIRD_PARTY_NOTICES.md）
├── net/            # safe-fetch.js：SSRF 防护（已备好，当前未接线，仅自测覆盖）
└── qq-im/          # 内置 QQ 通道
test/               # 测试（npm test 串行跑完）
```

---

## 许可证

**AGPL-3.0**（全文见 `LICENSE`）。本插件是 AGPL-3.0 的 hds-interlude 的衍生作品；
内嵌的 K0nd1us/QQ-agent 代码为 MIT。完整第三方归属与许可全文见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

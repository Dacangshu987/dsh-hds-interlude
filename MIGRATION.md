# 迁移说明：hds-interlude → dsh-hds-interlude

本文档说明从 Koishi 插件 hds-interlude（包名 koishi-plugin-hds-interlude，v0.1.4）迁移到本 dsh 插件后，哪些功能保留、哪些适配改造、哪些删除，以及行为上的结构性差异。

---

## 一、Console 配置分区对照

原项目有 14 个 Console 配置分区（实测 src/index.ts 的 Config 顶层键）。逐项对照：

| 原分区 | 本插件 | 状态 | 说明 |
| --- | --- | --- | --- |
| schedulePreplan | schedulePreplan | 保留 | 周规律 + 例外 + 半日投影 + 推进锚点，preplan.js 逐行移植 |
| agency | agency | 保留 | 容量矩阵、候选校验、重查时间，agency.js 逐行移植 |
| alterSystem | alterSystem | 保留 | 状态机、动态阈值、同向增强与反向消退，alter.js 逐行移植 |
| storyDefaults | story | 保留 | character(profile/speech)、perspective、world(setting/location/supportingCast)、counterpart(profile/initial)、plot(startingPoint/style/boundaries/keywords) 全部保留 |
| runtime | runtime | 部分保留 | 保留 autoAdvance / restWindows / memoryLimit 等；删除打字模拟与消息切分 |
| memory | 部分保留 | 部分保留 | 长期事实(facts)、设定演化(overlay)、perspective 保留；场景压缩与 Embedding 不做。连续性快照字段存在但**无写入路径**（见下） |
| sharedStory | 无 | 部分保留 | counterpart.profile/initial 落到 story.counterpart；跨账号投递与参与者白名单删除 |
| model | 无 | 删除 | 原插件自建模型调用与多提供商切换；dsh 由 ctx.llm 与 agent 预设决定模型 |
| onebot | 无 | 删除 | QQ 机器人、白名单、群聊、语音转写 |
| chatActions | 无 | 删除 | 引用回复、消息反应、原生表情 |
| stickers | 无 | 删除 | 依赖 QQ 表情与视觉模型 |
| browser | 无 | 删除 | DSH 原生提供 web_fetch 与 web_search |
| blindMode | 无 | 删除 | 原用于屏蔽其它 Koishi 插件命令；DSH 无此全局场景，可用 rules 覆盖 |
| logging | 无 | 删除 | DSH 有自己的日志体系；本插件用 [hds-interlude] 前缀 console 输出 |

### 原文档遗漏的分区：im（投递）

本插件有一个原项目没有对应分区的子系统：im。它承接的是原 onebot 分区里由 service 自己承担的投递职责——
因为 DSH 的输入通道是宿主提供的（Web UI / headless / dsh-im），插件不能自己发消息，只能通过 dsh-im 投递。

| 字段 | 作用 |
| --- | --- |
| im.autoDiscover | 从 dsh-im 的「会话双向同步」自动发现本会话投递目标，免手工绑定 |
| im.autoMessage | 故事里角色的发言是否自动发出（关掉 = 只写故事）。新增，原项目无对应 |
| im.messageIntervalMinutes | 两次自动发消息的最小间隔。新增，对应原项目没有的「写故事与发消息分离」 |
| im.chunking | 把一段话切成多条短消息，对齐真人发消息的节奏 |
| im.keepPassive | IM 投递失败时是否仍在本地会话留一次唤起（默认关，避免 Web 侧重复看到同一件事） |
| im.waitForTurnMs / timeoutMs | 唤起角色后等它写完的时限 / 单条投递超时 |
| im.enabled / botId / targetId | 手工绑定出口（默认走自动发现） |

原项目的投递由 service 直接调用 OneBot，不暴露为配置分区；本插件把它显式化成 im 分区。

---

## 二、行为差异（结构性）

### 1. 谁在写作（最重要的一条）

原项目：service.ts 自己调用兼容接口，一次调用同时产出「补写剧本 + 互动决定 + 结构化副产物」，插件自己管理打字模拟、分条与投递。

本插件：dsh agent 的原生回合就是那次「主叙事写作」。插件在 agent/pre-step 注入 Canon 段、规则段与幕间块，并提供 interlude_* 工具让模型记录结构化副产物。插件不自己调模型。

影响：模型的写作能力来自你在 dsh 里配置的 agent 与模型，而不是插件内部配置。

### 2. 消息通道

原项目：OneBot / NapCat QQ，私聊白名单、群聊、语音、图片 CQ 码、表情。

本插件：输入通道由宿主决定（Web UI / headless / dsh-im 接入的 QQ、微信等）。一个 agent 会话 = 一个主剧本 = 一位参与者。

注意：旧版本本文档曾写「无 IM 通道、主动开口只在本地唤起」，那是在接入 dsh-im 之前。现在主动开口会经 dsh-im 真正投递到聊天软件，且投递目标默认自动发现。

影响：仍无 QQ 账号白名单、无群聊、无语音转写、无表情包；但「消息能发到聊天软件」这一点与原项目一致了。

### 3. 一个尚未接线的字段：continuity

state.continuity 会被注入到每一条提示词里，但**没有任何工具写它**（六个 interlude_* 工具都不写），schema 里也没有对应配置。它目前恒为空，占着一个本来该放「连续性快照」的位置。原项目里对应的是 previousScenes / continuitySnapshot，由压缩模型维护。待办：要么给它一个写入路径，要么删掉。

### 4. 持久化

原项目：13 张 SQLite 表，全局写队列串行化，重试 7 次（service.ts 的 databaseWriteQueue）。

本插件：每会话一个 JSON 文档（$DSH_HOME/hds-interlude/<sessionId>.json），原子写入（tmp + rename），读取失败降级为空状态。互动时序不落盘，直接从 session 日志增量折叠。

已知差距（诚实记录）：我们没有原项目那样的写队列与重试。saveState 失败时静默吞掉，并发扫描与工具处理器也没有按会话串行化——这一条已记入待办，尚未实现。

### 5. Alter 侧端模型

原项目：累积过阈值后调用独立的侧端模型生成 1-2 句氛围描述。

本插件：主模型在 interlude_alter 工具的 note 参数里直接给出描述（少一次请求）。未给 note 时用方向默认文案。

### 6. 主动联系与故事续写

原项目：service 按意愿阈值与目标合法性自己投递；自动推进走「时间导演 beats 再渲染」两层。

本插件：后台扫描发现到期待办已过 grace 期，经 agency.js 的 evaluateAgencyCapacity 校验后唤起一次自然开口；故事续写按 autoAdvanceIntervalMinutes 唤起。无独立时间导演层。

### 7. 压缩 / Embedding / 剧情余波

原项目：后台压缩模型 + Embedding 语义检索 + 剧情余波注入。

本插件：不实现。长期事实由 interlude_memory 维护；上下文压缩交给 DSH 的 compaction；语义检索不做（参考项目用 embedding，DSH 侧不具备）。

### 8. 图片 / 语音 / 网页观察

原项目：vision sidecar、SnowLuma 语音、Puppeteer 只读浏览。

本插件：不做任何图片处理。图片能否被理解取决于宿主与所选模型是否支持视觉输入（DSH 会把图片作为附件交给模型，不支持视觉的模型会收到文本占位符）。本插件既不降采样也不做 OCR。

### 9. 结构化输出

原项目：让模型返回 JSON，四层强制（原生 JSON mode、合约文本、容错解析、语义恢复）。

本插件：不做原生结构化输出（DSH 的 LlmCallConfig 与 GenerateOptions 都不暴露 response_format）。改用工具即结构化输出的路子：interlude_* 工具的参数由 JSON Schema 强校验，这等价于强制 schema，只是走 tool call 而非 content。

---

## 三、许可证

原项目：AGPL-3.0。本包：AGPL-3.0。

四个纯逻辑模块（clock / alter / agency / preplan）是对原项目 src/time.ts、src/alter.ts、src/agency.ts、src/schedule-preplan.ts 的逐行翻译（已核对导出函数一一对应），因此本包整体构成原项目的衍生作品，必须沿用 AGPL-3.0。

对分发的影响：本包可作为独立插件在 dsh 生态分发，但不能并入 MIT 的 dsh 上游仓库（AGPL 与 MIT 不兼容）。若要并入，需对原项目的表达性代码做实质性重写。

### 与另一个同名思路插件（dsh-interlude）的关系

本仓库里还有另一个插件 dsh-interlude（525 行，MIT）。它是**独立写作**的：虽然思路同样借鉴原项目，但连函数名都不同（它用 resolveZone / localParts / dayPhase，原项目用 resolveTimezone / storyLocalTimeContext / localClockMinutes），也没有 alter / agency / preplan 这三个模块。
因此两者许可不同是合理的：dsh-interlude 按 MIT，本包（dsh-hds-interlude）按 AGPL-3.0。不要因为名字相近就把两者的许可证混为一谈。

## 四、本包相对原项目新增的能力

以下几条原项目没有，是本包补的。它们不是「移植差异」，而是独立的改进，因此单独列出：

1. **承诺兜底**：模型答应「三分钟后喊你」却忘了记账时，插件按角色自己说出口的时间承诺补记一条待办。原项目靠提示词约束，没有这层确定性兜底。
2. **重启恢复**：进程中断时卡在「投递中」的待办会被回收重试；停摆超过 6 小时的过期待办标记过期而不是补发（避免一次消息风暴）。原项目没有对应机制。
3. **投递重试不重新生成**：投递失败时保存写好的原文并重发同一段文字，不再唤起模型（既省一次全量上下文，也避免用户看到前后不一致的两版）。原项目把消息落库后重发，思路一致，本包按 DSH 的状态结构实现。
4. **长期事实按得分排序**：原项目有 importance / confidence / recency / semantic 加权（service.ts 的 factScore）；本包实现其中前三项（semantic 需要 embedding，DSH 侧不具备，故不加权而非给 0 分）。
5. **自言自语闸**：模型把思考过程当正文写时会拦截（检测「待办」「幕间」等内部词汇与自我指涉句式），并结算掉该待办而不是反复重试。原项目靠 JSON 结构化输出天然不会出现这个问题。

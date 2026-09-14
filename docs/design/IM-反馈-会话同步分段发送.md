## 给 dsh-im 作者的反馈：普通回复不支持按条分段发送

**标题**：会话同步（Session Sync）的 assistant 投递不支持分段发送，长回复一次发出

**环境**：`@xmanrui/dsh-im@4.20.0` + `@deepseek-ai/dsh@0.1.5-rc.2`，QQ 官方机器人通道

**现象**
同一句回复，两种触发方式表现不一致：
- 插件通过 `ctx.dshIm.send()` 主动投递时，回复按「真人发消息」的方式被切成多条（气泡分隔、条间留间隔）；
- 但用户主动发消息后，由 dsh-im 的会话同步（Session Sync）把角色回复发回时，**整段文本一次性发出**（一个气泡）。

会话日志里能确认：assistant 文本是完整一段（如 `"吃药。\n\n别装没看见，问你话呢"`），到 QQ 后是一个气泡，而不是两条。

**调用链（从源码读出）**
```
session/event (turn/end)
  → Eot (session-sync-coordinator) 累积的 d.assistant.text
  → sendSessionSyncText(botId, targetId, sessionId, text, {signal})
  → deliveryController.sendProactiveText(botId, target, text, {signal})
  → 渠道适配器一次 sendText(text)
```
`sendProactiveText` 的签名是 `(botId, target, text, {signal})`，**text 是一个字符串**，全程没有分条/分段环节。

**建议**
1. 在 Session Sync 的 assistant 投递前，按换行或长度把 `d.assistant.text` 切成多段，逐段调用 `sendProactiveText`（段间留一个可配置间隔，比如默认 400ms），与 `ctx.dshIm.send()` 的投递体验对齐；
2. 分条参数做成可配置（是否启用、单条最大字数、最多条数、条间间隔），默认值参考 IM 平台的单条上限（如 QQ 官方机器人同一条消息的约束）；
3. 最好在 dsh-im 设置页提供一个「回复分段发送」开关，而不是让下游每个插件各自实现。

**影响面**：所有走 Session Sync 的渠道（QQ / 微信 / 飞书等）的长回复都会受益；这属于通用需求，在 dsh-im 层做比每个下游插件各做一遍更合理。

---
**补充（可选）**：当前 dsh-im 的会话同步是「一次 turn/end 只发一次文本」。如果按段发送，建议同时处理「部分段成功、部分失败」的记账——逐段返回 sent/failed，让调用方知道哪几段真的发出去了（可参考 hds-interlude 的 `deliverImChunks` 做法：全部成功才算 ok，部分成功时如实报告已发送条数）。

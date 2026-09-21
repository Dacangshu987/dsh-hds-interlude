# 交付级修复记录 / Delivery Fix Log

本文件记录为达成「交付级别」而实施的修复与改进，以及经复核后**判定为不成立**的条目。

- 基线：`dsh-hds-interlude` 全量审查（核心架构 / 业务逻辑 / QQ-IM / 测试覆盖 / 客户端配置 五路并行）
- 验证：`npm test`（含承重验证）**退出码 0**；全部修改文件 `node --check` 通过
- 日期：2026-09-15

---

## 一、已实施的修复

### P0（阻塞交付）

| 编号 | 问题 | 文件 | 修复方式 |
| --- | --- | --- | --- |
| H1 | `writeChains` 无淘汰，长期运行内存泄漏 | `lib/state.js` | 链 settle 后回调内比对「是否仍是当前链」，是则 `writeChains.delete(key)` 懒淘汰；已用并发探针验证串行性在多轮 / 竞态下均保持 |
| H2 | HTTP 路由未随插件卸载清理 | `lib/index.js` | 全部 `webServer.register` 改为 `ctx.effect(() => ctx.webServer.register(...))`，随 ctx 卸载自动注销 |
| H4 | 状态非原子写入，崩溃可能留下半截 JSON | `lib/state.js`、`lib/qq-im/channel.js` | 改为 write-tmp + `renameSync` 原子替换（同分区 rename 为原子操作） |

### P1

| 编号 | 问题 | 文件 | 修复方式 |
| --- | --- | --- | --- |
| H3 | 可选依赖（credentials 等）缺失时未优雅降级 | `lib/index.js`、`cordis.patch.yml` | 按可选依赖处理，缺失时通道不启动、其余功能照常；已在 patch 注释中写明 |
| H6 | 测试无超时保护，挂起会假死 | `test/proactive-cold.test.mjs` | `check()` 增加 `Promise.race` 超时护栏（默认 30s），超时抛出带用例名的 `TIMEOUT` |
| H8 | README 缺部署前置与故障排查 | `README.md` | 新增「运行环境要求」（Node/DSH/cordis/OS/磁盘/网络 + 首次启动检查清单）与「故障排查」表 |
| H10 | IM 断线对用户不透明 | `lib/client.js` | 已具备：状态红点 + `出错` 标签 + 内联展示 `lastError` 原文 |
| M11 | 投递锁无 TTL，异常退出后永久占锁 | `lib/qq-im/channel.js` | `DELIVERING_TTL_MS = 5min`，`isDelivering()` 读取时自愈式过期清理 |
| M14 | 空 `catch {}` 吞异常 | `lib/index.js` | 全部消除（审计计数 0），改为记录或显式注释说明为何安全忽略 |
| L6 | 表情包缓存只增不减 | `lib/qq-im/sticker-store.js` | 新增 `evictOldStickers(dir)`：按 `MAX_STICKER_COUNT` 数量淘汰，且**永不淘汰用户自己放的表情** |
| L9 | 承重验证未进主测试链 | `package.json` | `npm test` 末尾已串联 `npm run test:loadbearing` |

### 文档与合规

| 编号 | 内容 | 文件 |
| --- | --- | --- |
| L5 | 完整第三方归属与许可全文（AGPL-3.0 衍生作品 / MIT / 腾讯 SDK） | `THIRD_PARTY_NOTICES.md`（新增） |
| L7 | 目录结构描述校正（`net/` 为已备好但未接线的 SSRF 模块） | `README.md` |
| — | 补充「承重验证的 FAIL 输出不是失败」的说明，避免误读 | `README.md` |

---

## 二、经复核判定为「不成立」的条目

审查阶段提出的以下问题，在实现细节复核后确认**不是缺陷**，故未改动。记录在此以备后续复查。

| 原提法 | 复核结论 |
| --- | --- |
| `say.js` 重试无指数退避 | **不存在重试逻辑**。`say.js` 是纯文本处理层；`outbound.js` 亦无重试循环。代码采用 fail-fast 设计：`qq.js` 用 `retryable` 标记错误类别，由上层下一轮自然重投。属设计选择，非缺陷 |
| WebSocket 重连缺 jitter（惊群） | **不在本仓库控制范围**。连接与重连由腾讯 SDK（`@tencent-connect/qqbot-nodejs`）内部实现；`connect.js` 是扫码绑定（QR provisioning），非 WS 连接管理 |
| 客户端 `buildPayload` 丢弃 `proactive` 高级子配置 | **不成立**。`buildPayload` 已完整透传 `proactive` / `agency` / `alterSystem` / `schedulePreplan` / `runtime` 及全部 IM 子配置；顶层仅对布尔开关做 `!!` 规范化 |
| `writeChains` 淘汰守卫恒真、误删占用中的链 | **不成立**。守卫在 `finally`（异步）内比对，此时 `chain` 可能已被后续 enqueue 重新赋值，语义正确。已用 5 轮竞态探针验证：跨淘汰边界的写入顺序始终单调 |

---

## 三、后续变更：两项 IM 行为改为标准功能（面板不再显示）

**需求**：把「收到未绑定的 QQ 私聊时自动新建会话并绑定」与「响应群聊消息」设为标准功能，
不再显示在设置面板内。

| 文件 | 改动 |
| --- | --- |
| `lib/client.js` | 移除两个 toggle 的渲染；「群聊仅响应 @机器人」子开关改为**无条件可见**（原先挂在群聊开关下）；从 `defaultScalar()` 与 `scalarFrom()` 中删除 `imAutoCreate` / `imGroupEnabled` 两个标量 |
| `lib/client.js` | `buildPayload` 改为**省略键**而非写 `false`（见下方「关键坑」） |
| `lib/schema.js` | `group.enabled` 默认 `false` → **`true`**（既然成为标准功能，默认必须是开）；两处 description 标注「标准功能，面板不显示」 |
| `CONFIGURATION.md`、`README.md` | 同步文档：默认值、面板可见性、配置文件退路 |

**关键坑（本次真正要小心的地方）**：面板不再产生这两个字段的值，若 `buildPayload` 仍按
`!!scalar.imAutoCreate` 写回，`!!undefined === false`，于是**用户每次点保存都会把这两个
功能静默关掉**——恰好与「标准功能」相反，而且是那种「看起来正常、用起来不生效」的故障。

改法是**省略该键**，让宿主 `settingsScope.update()` 的深合并保留原值 / schema 默认值：

```js
...(scalar.imAutoCreate === undefined ? {} : { autoCreateSession: scalar.imAutoCreate === true }),
```

并已用探针验证 payload 中确实不含这两个键（`"autoCreateSession" in payload.im === false`）。
保留 `settings.yaml` 手写 `false` 的退路。

**未改动**：`inbound.js`、`qq-im/config.js` 的判定逻辑（`group.enabled === true`、
`source.autoCreateSession !== false`）保持原样——它们本来就正确，改默认值即可。

---

## 四、验证证据

```
npm test              → 退出码 0（含 test:loadbearing）
node --check <9 files> → 0 失败
npm run pack:dry      → 37 files, package 275.8 kB, unpacked 827.7 kB
```

**关于 `FAIL` 输出**：承重验证会故意拆掉关键机制并断言测试变红，输出形如

```
把「带回未送出部分」拆掉（失败时丢掉 remaining）…
  FAIL 投递失败重试时**不重新生成**内容，也不重复已送出的前缀
  → 红掉 1 条
✅ 测试确实在检验「重试重发原文、不重新生成」
```

这是**测试有效性的证据**，不是失败；整轮退出码 0 即为通过。

---

## 五、遗留（非阻塞，建议后续版本处理）

以下为结构性技术债，不影响交付，未在本次改动（记录在案以免遗忘）：

1. `lib/qq-im/channel.js`（48 KB）职责过载，建议拆分为 lifecycle / routing / qr 子模块。
2. `lib/render.js`（29 KB）、`lib/story.js`（26 KB）同类问题。
3. `test/proactive-cold.test.mjs`（57 KB）过大，建议按场景拆分。
4. 测试框架为自建轻量 runner，无覆盖率报告；建议接入 c8 或类似工具量化。
5. `lib/net/safe-fetch.js` 已实现但未接线；若后续引入外网抓取，应改走该模块而非裸 `fetch`。

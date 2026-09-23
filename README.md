# dsh-hds-interlude

> 聊天在幕前发生，生活在幕间继续。

**dsh-hds-interlude** 是 Koishi 插件 [hds-interlude](https://github.com/euphoriaaaaaa1/hds-interlude)（AGPL-3.0）移植到 **DeepSeek Harness（dsh）** 的插件：时间感知的持续叙事 / 幕间系统。角色拥有连续的生活——用户消息只是其中一件事，她会先补写从上次到现在的生活，再决定看见、沉默、回复、延迟回复，或在合适时机主动开口。

## 🔄 与上游的移植对比

| 上游 hds-interlude | 本插件 | 说明 |
| --- | --- | --- |
| schedulePreplan / agency / alterSystem / story | ✅ 保留 | 纯逻辑逐行移植 |
| runtime / memory | ◐ 部分保留 | 保留自动推进 / 记忆 / 日程；删除打字模拟等 |
| model / onebot / browser / chatActions / stickers | ❌ 删除 | 模型由 DSH 提供；QQ 投递改为内置通道 |
| im（自建通道） | ✨ 新增 | QQ 扫码绑定 / 群聊 / 表情包 / 发言分离 |

迁移对照见 [`MIGRATION.md`](./MIGRATION.md)，第三方声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 📦 安装

```bash
dsh plugin add link:<你的本地路径>
```

配置见 [`CONFIGURATION.md`](./CONFIGURATION.md)。

## ⚖️ 许可

**AGPL-3.0**（上游衍生作品），全文见 [`LICENSE`](./LICENSE)。

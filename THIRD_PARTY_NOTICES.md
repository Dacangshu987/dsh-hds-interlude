# 第三方软件声明 / Third-Party Notices

本插件（`dsh-hds-interlude`）主体按 **GNU Affero General Public License v3.0（AGPL-3.0）**
分发（全文见根目录 `LICENSE`）。它基于 / 内嵌了下列第三方作品，这些作品各自保有
其版权与许可，与本插件的主许可相互独立。分发本插件时，本文件应随包一并分发。

---

## 1. hds-interlude（原项目）—— AGPL-3.0

- 项目：`koishi-plugin-hds-interlude`（作者 `euphoriaaaaaa1`）
- 仓库：<https://github.com/euphoriaaaaaa1/hds-interlude>
- 许可：GNU Affero General Public License v3.0

本插件是其**衍生作品**：`lib/clock.js`、`lib/alter.js`、`lib/agency.js`、
`lib/preplan.js` 分别是原项目 `src/time.ts`、`src/alter.ts`、`src/agency.ts`、
`src/schedule-preplan.ts` 的逐行翻译（去 TypeScript 类型标注，逻辑与语义保持一致）。

依据 AGPL-3.0 第 5 条，本插件整体（作为衍生作品）以 AGPL-3.0 分发；对原作品的修改
说明见 `MIGRATION.md`。原项目版权与许可声明随本文件的说明保留。

---

## 2. K0nd1us/QQ-agent —— MIT

以下文件内嵌 / 移植自 **K0nd1us/QQ-agent**（commit `72f537f9`，MIT License）：

- `lib/vendor/md-to-plain.js` —— `src/md-to-plain.js` 的 `mdToPlain` 移植；
- `lib/net/safe-fetch.js` —— `src/safe-fetch.js` 移植（仅将上游的全局配置读取改为参数注入）；
- `lib/state.js` 的 `createWriteChain` —— 取自 `src/util.js:147-155` 的 `createSendChain`。

MIT 许可全文（适用上述代码）：

```
MIT License

Copyright (c) 2026 Kondius

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. 腾讯 QQ 机器人 SDK（依赖，动态加载，不内嵌代码）

- `@tencent-connect/qqbot-nodejs`（**MIT**）—— 协议层，由 `lib/qq-im/qq.js` 动态加载；
- `@tencent-connect/qqbot-connector`（**UNLICENSED，专有许可**）—— 扫码 provisioning，
  由 `lib/qq-im/connect.js` 动态加载。

> 说明：`qqbot-connector` 在 npm 上标记为 `UNLICENSED`。本插件**不内嵌、不分发**其代码
> （npm 依赖在安装时解析，不进入发布 tarball），仅「扫码绑定」功能会动态加载它；手动填
> AppID + AppSecret 不依赖它。这与参考实现 `@xmanrui/dsh-im` 完全一致（后者同样把它列为
> 依赖）。其使用须遵守腾讯官方就 QQ 开放平台服务发布的条款。

---

## 4. qrcode —— MIT

`qrcode`（MIT，<https://github.com/soldair/node-qrcode>）—— 扫码绑定时把授权页 URL
渲染成二维码图片。由 `lib/qq-im/connect.js` 动态加载。

---

## 5. 传递依赖

- `zod`（MIT）—— 经 `@deepseek-ai/schemastery` 传递引入，本插件不直接依赖。

## 6. 平台 peer 依赖（非本包分发内容）

`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-*` 等均为
**MIT**，属于 DeepSeek Harness 宿主平台，作为 peerDependencies 由宿主提供，
不在本插件发布产物内。

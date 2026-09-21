# 诊断：QQ 没收到回复（session-58be9b68）

> 症状：用户从 QQ 发消息，界面里看到角色「回了」，但 QQ 上什么都没收到。
> 排查方式：把 DSH 会话日志解压后逐事件核对 + 回放本地判定函数。
> 结论：**模型把要说的话写进了正文，而没有调用 `interlude_say`**；
> 而提示词**从两个角度都在把它往这个方向推**。

---

## 一、怎么定位到的

### 1.1 先看投递链路有没有问题 —— 没有

`~/.dsh/integrations/dsh-qq-im/state.json` 记得很清楚：

```json
"lastDelivery": { "at": "2026-09-16T15:59:50.249Z", "ok": true, "sentCount": 2, "total": 2 }
"stats": { "inbound": 1, "outbound": 2 }
```

而且 `ok: true` 是**可信的**：`lib/qq-im/outbound.js:147` 只在传输层显式返回
`{ sent: true }` 时才记账（`if (result?.sent !== true) return partial('delivery-not-confirmed')`），
`lib/qq-im/qq.js` 的 `sendText` 确实返回 `{ sent: true, id }`。

**所以卡点在投递之前。**

### 1.2 解压会话日志，逐事件看

```
node decompress-zstd-frames.cjs \
  "~/.dsh/sessions/.../session-58be9b68-.../session.v3.jsonl.zstd" \
  qq-live.jsonl
# => {"frames":262,"failed":0,"bytes":605900,"lines":723}
```

最后几轮的事件序列：

```
2026/9/17 01:39:42  agent/inbox/spliced   ← QQ 入站「睡了？」
2026/9/17 01:39:42  turn/start            turn 65
2026/9/17 01:39:42  user/message          「对方（来自 QQ）：睡了？」
2026/9/17 01:39:48  assistant/message     ← 模型写了回复
2026/9/17 01:39:48  step/end
2026/9/17 01:39:48  turn/end
```

**整个 turn 65 没有任何 `tool/call` 事件。**

对比同一会话里**成功**发出去的那一轮（turn 64，23:59）：

```
23:59:42  assistant/message
23:59:42  tool/call        ← 调了 interlude_say
23:59:47  assistant/message
```

### 1.3 模型到底写了什么

从 `assistant/message` 里取出正文：

```
被你吵醒了

你是不打算睡了？

怎么了
```

把它喂进本地判定函数回放：

```
extractSpeech -> []                          ← 没有整行引号，提取不到
looksLikeSelfNarration.leak = false
decideAdvanceDelivery -> { mode: "story-only", messages: [], reason: "no-speech" }
```

`im.sayFallback: 'strict'` 下，只有 `interlude_say` 的内容会被发送。
没调工具 → `messages` 为空 → **一个字都发不出去**。

---

## 二、但模型是被误导的 —— 两个独立原因

排查时我一开始以为只是「模型忘了调工具」。继续往前追注入内容，发现不是。

### 2.1 模式行在教它「用引号」

那一轮模型实际收到的 `<幕间>` 块：

```
本轮模式：**可能发消息**。单独成行、用引号整句写出来的话会被发出去（最多 4 条，每条约 40 字以内）；
其余内容只是故事，对方看不到。
```

这来自 `lib/render.js` 的 `renderSpeechModeLine`。它是**改版前的规则** ——
当时台词确实从正文按「整行引号」提取。但发言方式后来换成了工具调用，
`strict` 下引号提取**完全不参与投递判定**。

于是提示词自相矛盾：一行说「用引号写就能发出去」，实际规则是「不调工具就什么都发不出去」。

### 2.2 更关键：规则段从来没告诉过它要用工具

`renderRules` 在 `imActive` 时会追加这段：

```
**要把话说给对方，就调用 `interlude_say`。**
  - 只有 interlude_say 里的内容会被发送；**其余正文……一条都不会发出去**。
```

**但这段从未注入过。** 在全部 723 条日志里搜 `要把话说给对方`，命中 **0 次**。

原因是 `canonInjected` 门控 —— 规则段只在首轮注入一次。对时间线：

| 时间 | 事件 |
|---|---|
| 2026-09-12 21:34 | 首轮注入 canon + rules。当时**还没有绑定** → 按「无绑定」口径，不含发言指引 |
| 2026-09-15 15:52 | QQ 绑定建立（`bindings.json` 的 `boundAt`） |
| 2026-09-17 01:39 | turn 65 故障 |

`canonInjected` 置位后**永不再注**，所以绑定建立之后也补不上。

**结果**：模型每一轮都能看到「本轮模式：**可能发消息**」（每回合注入），
却**从来没被告知过怎么发**（首轮注一次、且注错了口径）。

---

## 三、做了三处修改

### 3.1 `lib/render.js` — 模式行与投递规则同口径

```
本轮模式：**可能发消息**。要把话说给对方，就调用 **interlude_say**（最多 4 条，每条约 40 字以内）；
**正文里写的字一条都不会发出去**——想说什么就放进工具里，不想说话就别调用它。
```

删掉了「用引号」这个误导词，改成说工具。

### 3.2 `lib/index.js` + `lib/state.js` — 形态切换时补注规则段

新增 `state.canonInjectedIm`，记录**上次是按哪种形态注入的**。
判据从「注入过没有」改成「**按当前形态**注入过没有」：

```js
const formChanged = state.canonInjected === true && state.canonInjectedIm !== imActive
if (state.canonInjected !== true || formChanged) { ... }
```

形态从「无绑定」变成「有绑定」时，补一段口径更正（`IM_FORM_SWITCH_NOTICE`）
并重注规则段；canon 不再重发（省上下文）。

### 3.3 `lib/story.js` + `lib/index.js` — 补发兜底（你要求的"补发"）

在 `handleAutoAdvance` 的 `story-only` 分支加 `salvageBodySpeech`：
模型没调工具、但正文里**能安全认出来**是台词时，直接补发。

**边界（三条都满足才补发）：**

1. 只在 `reason === 'no-speech'` 时补 —— 被间隔/配额拦下的**不能**补，否则绕过节流；
2. 只认**整行引号**台词（复用 `extractSpeech` 既有判据，不新造一套）；
3. 必须过自言自语闸（正文整体 + 捞出的句子各过一次）。

**并且：模型已经调过工具时一律不补**，避免发两遍。

---

## 四、必须说清楚的一条能力边界

**turn 65 那种形态（不带引号的裸行），补发捞不出来。**

不是漏做，是**做不到安全地捞**。实测这一组：

| 输入 | 是台词吗？ |
|---|---|
| `她愣了一下。` + `你怎么才回` + `我等你半天了` | 像 |
| `她把杯子放下，走到窗边。外面下起了小雨……` | 不像（正常叙事） |

两者在**文本形态上不可区分**。强行把裸行当台词发出去，就会把叙事体发到聊天窗口 ——
那是比漏发更糟的故障。

而且 `looksLikeSelfNarration` 也帮不上：实测 `我组织一下：\n"今天不算，说完就睡"` 这类
「列候选台词」的判定是 `leak: false`（那道闸认的是「用户 / 待办 / 系统」这类**元词汇**，
不是引号），所以它既拦不住误发、也不能用来放行。

**所以对这类只记审计、不补发**：`looksLikeMissedSpeech` 会打一条 warn 日志。

这一条很关键 —— 这次排查最痛的地方就是**「用户说没收到，而我们这边日志一片安静」**。
加上审计后，下次同类情况在 DSH 日志里直接可见。

**真正的修法是 3.1 + 3.2**（让模型知道要用工具），而不是靠正则去猜正文。

---

## 五、验证

| 项 | 结果 |
|---|---|
| 新增用例 `test/say-backstop.test.mjs` | 12 项，含「已调工具不补发」「间隔拦下不补发」等反例 |
| 新增用例 `test/canon-form.test.mjs` | 8 项，含 `formChanged` 真值表 |
| 全套 `npm test` | **39/39 命令 exit 0**（逐条取 exit code，非只看汇总） |
| `npm run test:loadbearing` | **7/7 exit 0** |
| 承重验证（把模式行改回旧说法） | 测试立即变红：`必须告诉模型用工具，实际：…用引号整句写出来的话会被发出去…` |

修复后的实际输出（同一场景重放）：

```
模式行: 本轮模式：**可能发消息**。要把话说给对方，就调用 **interlude_say**……
规则段含 interlude_say: true
turn65 正文 可补发: false        ← 形态无法安全判定，刻意不发
turn65 正文 标记疑似漏发: true    ← 但会留日志
```

---

## 六、遗留

- **已有的会话需要一次"形态切换"才会补注**。`session-58be9b68` 的
  `canonInjectedIm` 目前是 `undefined`（旧状态没有这个字段），
  而 `undefined !== true` → 下次 `imActive` 为真时会触发一次补注。
  这正是想要的行为，但**意味着那一轮会多注入一段文本**（预期内）。
- 若想立刻生效而不等下一轮，可以 `/interlude purge` 后重启该会话
  （会重置 `canonInjected`，代价是丢该会话的幕间状态）。

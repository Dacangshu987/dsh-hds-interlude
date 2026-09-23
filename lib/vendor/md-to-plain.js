/**
 * Markdown → 纯文本 —— 让模型写的东西进聊天软件时不带标记符号。
 *
 * ## 来源与许可
 *
 * 移植自 **K0nd1us/QQ-agent**（MIT License, Copyright (c) 2026 Kondius）
 * 的 `src/md-to-plain.js` 中的 `mdToPlain`，commit `72f537f9`。
 * 上游为 QQ 群聊场景编写；本插件用于同一目的（把 agent 的 Markdown 回复
 * 转成适合 IM 发送的纯文本），只做了去掉无关导出与注释中文化。
 *
 * 依据 MIT 许可，保留上述版权声明即可自由使用、修改、分发。
 *
 * ## 为什么需要这一层
 *
 * 本地 `lib/im.js` 只负责**分条**（按句末标点 / 宽度切分），
 * 全仓此前没有任何 Markdown 处理 —— 而 `lib/render.js` 的 `storyRules`
 * 明确要求模型"该有旁白、动作、环境就写，不必把自己限制成一句一句的话"，
 * 于是模型输出的 `**强调**`、`` `code` ``、`## 标题`、`- 列表` 会原样发到 QQ。
 *
 * 注意本函数**只**处理文本形态，不碰分条逻辑：
 * 本地已有 `lib/im.js` 的 `splitImText`，此处**不**引入上游的 `splitForQQ`，
 * 避免两套切分逻辑互相打架。
 *
 * @module dsh-hds-interlude/vendor/md-to-plain
 */

/**
 * 把 Markdown 转成适合 IM 发送的纯文本。
 *
 * 保守策略：只**去掉标记符号**，不做语义改写（不转义、不折行、不改写链接目标）。
 * 反引号内与代码块内的内容一律保留，只是去掉围栏与反引号本身。
 *
 * @param {unknown} md 原始文本；非字符串按空串处理。
 * @returns {string} 去掉 Markdown 标记后的文本（首尾空白已 trim）。
 */
export function mdToPlain(md) {
  let s = String(md ?? '')

  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''))
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // 图片/链接：保留文字，链接附在括号里（IM 里多数可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url))
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '')
  // 引用符
  s = s.replace(/^>\s?/gm, '')
  // 列表符（保留项目符号的视觉提示，换成 •
  s = s.replace(/^\s*[-*+]\s+/gm, '• ')
  // 表格：去掉分隔行，再去掉首尾的竖线
  s = s
    .split('\n')
    .filter(line => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, '')))
    .join('\n')
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '')
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n')

  return s.trim()
}

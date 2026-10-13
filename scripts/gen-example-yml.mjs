/**
 * 生成 `hds-interlude.example.yml`（可直接粘进 profile 的 cordis.patch.yml）。
 *
 * 为什么用脚本生成而不是手写：默认值必须与 `lib/schema.js` **完全一致**。
 * 手写迟早会与 schema 漂移，而漂移的表现是「示例配置里某个字段名/默认值不对」，
 * 用户照抄之后才发现——那时已经很难判断是文档错还是插件错。
 *
 * 用法：node scripts/gen-example-yml.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

import { Config } from '../lib/schema.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 各段的一句话说明（与 CONFIGURATION.md 的口径一致）。 */
const SECTIONS = {
  enabled: '总开关。',
  timeZone: '角色所在 IANA 时区。',
  gapNoticeMinutes: '距上次互动超过多少分钟才在幕间块里提示「过了多久」。',
  alwaysReportTime: '每回合都注入当前时间。',
  rules: '替换常驻行为规则段（留空用内置文本）。',
  mainPrompt: '主体叙事提示词（可整体替换；留空用默认）。',
  formatPrompt: '输出格式附加说明（不能移除工具调用与分条合约）。',
  fixedPrompt: '插件所有者配置的附加固定指令。',
  stylePrompt: '文风指令（只作用于剧本散文）。',
  story: '故事档案：主角、世界、关系、地点、时区与文风。',
  runtime: '对话节奏与自动生活推进（写故事 / 发消息是两条独立节奏）。',
  proactive: '主动联系边界（到期待办时角色会不会自己开口）。',
  agency: '主体行动窗口（日程负荷 / 隐私 / 设备可用性）。',
  alterSystem: '情绪偏移追踪。',
  schedulePreplan: '近期日程层（周规律 + 日期例外）。',
  urge: 'Urge 弹性推进（可选，替代固定间隔）。',
  timelineDirector: '时间导演（自动推进时生成事件账本对齐时间线）。',
  longHorizon: '长线叙事催化器（实验，默认关）。',
  logging: '日志级别与内容脱敏。',
  blindMode: '失明模式（沉浸运行：静默日志，只留健康心跳）。',
  presetSync: '预设同步：从分享站按分享码拉取配置导入（默认关）。',
  blackBox: '旧名，等价于 blindMode.enabled（保留读取旧配置）。',
  im: '聊天软件通道（内置 QQ）。**凭据只存引用名，值留在凭据服务里。**',
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 把值渲染成 YAML（用 js-yaml，避免自己拼字符串出错）。
 *
 * `topLevel` 只在缩进 4 的那一层为真：注释按**顶层字段名**写，
 * 嵌套的同名字段（比如 `presetSync.enabled`）不该捡走顶层 `enabled` 的说明
 * ——那会生成看起来对、实际误导的注释。
 */
const render = (key, value, indent, topLevel) => {
  const pad = ' '.repeat(indent)
  const comment = topLevel ? SECTIONS[key] : undefined
  const head = comment ? `${pad}# ${comment}\n` : ''
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (!keys.length) return `${head}${pad}${key}: {}`
    // 分隔看**子字段所在的缩进**：顶层字段（缩进 4）之间空一行，便于阅读；
    // 段内字段（缩进 6 及更深）紧挨着，否则一份配置会散成几百行。
    const sep = indent + 2 === 4 ? '\n\n' : '\n'
    const body = keys.map(k => render(k, value[k], indent + 2, false)).join(sep)
    return `${head}${pad}${key}:\n${body}`
  }
  // 标量与数组：交给 js-yaml，再把整体右移 `indent` 个空格。
  const dumped = yaml.dump({ [key]: value }, { indent: 2, lineWidth: 160, noRefs: true })
    .replace(/^---\n/, '')
    .replace(/\n$/, '')
  return head + dumped.split('\n').map(line => pad + line).join('\n')
}

const defaults = Config({})
const body = Object.entries(defaults).map(([k, v]) => render(k, v, 4, true)).join('\n\n')

const file = `# dsh-hds-interlude 配置示例（**默认值全量**）
#
# 这份文件由 \`scripts/gen-example-yml.mjs\` 从 \`lib/schema.js\` **生成**，
# 所以字段名与默认值一定与插件一致。改了 schema 之后重新跑一次：
#
#   node scripts/gen-example-yml.mjs
#
# 用法：把下面 \`- id: hds-interlude\` 那一段整块粘进 profile 的
# \`cordis.patch.yml\`（通常位于 \`~/.dsh/profiles/<profile>/cordis.patch.yml\`），
# 按需改值。**只写你想改的字段也可以**——没写的用默认值。
#
# 凭据（\`im.secretRef\`）只写**引用名**，真正的值放在 DSH 的凭据服务里：
#   dsh credentials set DSH_QQBOT_APP_SECRET
#
# 分享码导入（presetSync）见文件末尾；它需要**公网可达**的分享站地址——
# 本插件的出站有 SSRF 防护，指向内网地址会被拦下。

- id: hds-interlude
  name: dsh-hds-interlude
  config:
${body}
`

const out = path.join(ROOT, 'hds-interlude.example.yml')
fs.writeFileSync(out, file, 'utf8')

// ── 自校验：生成的文件必须能被 YAML 解析，且 config 能被 schema 接受 ──
const parsed = yaml.load(fs.readFileSync(out, 'utf8'))
if (!Array.isArray(parsed) || parsed[0]?.id !== 'hds-interlude') {
  throw new Error('生成的文件不是合法的 cordis.patch.yml 片段')
}
const accepted = Config(parsed[0].config)
if (Object.keys(accepted).length !== Object.keys(defaults).length) {
  throw new Error('schema 拒绝或改动了某些段——生成器与 schema 不一致')
}
console.log(`已生成 ${path.relative(ROOT, out)}（${file.split('\n').length} 行，${Object.keys(defaults).length} 个顶层段）`)
console.log('已自校验：YAML 可解析 + schema 接受整份配置')

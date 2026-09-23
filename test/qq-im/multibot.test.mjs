/**
 * 多 QQ Bot 的数据层测试（阶段 1/2 的新增用例）。
 *
 * 覆盖设计文档的：
 *   - A-1：两个 Bot 绑同一 openid，各自独立（复合键 `botId\0conversationKey`）；
 *   - D-3：复合键含 `\0` 时解析正确（botIdOfBinding / debugKey）；
 *   - 阶段 1：v1 → v2 迁移正确（含备份原文件）；
 *   - 阶段 2：单 Bot 旧配置归一成 `bots:[…]`、botId/secretRef 由 appId 派生；
 *   - 入站路由：带 botId 的查找命中自己的绑定，不串号。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import fs from 'node:fs'
import path from 'node:path'

import {
  BindingStore, bindingKeyOf, botIdOfBinding, debugKey, conversationKeyOf,
  targetIdOf, scopeOf, bindingsFile, integrationHome,
} from '../../lib/qq-im/binding.js'
import { resolveConfig, deriveBotIdentity, normalizeBotEntry } from '../../lib/qq-im/config.js'
import { routeInbound } from '../../lib/qq-im/inbound.js'

let passed = 0
function check(label, fn) { fn(); passed += 1 }
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

let counter = 0
function tempHome() {
  counter += 1
  return caseDir('multibot')
}

/* ------------------------------------------------------------ A-1：复合键隔离 */

check('A-1：两个 Bot 绑同一 openid，各自独立（核心用例）', () => {
  const store = new BindingStore({ home: tempHome() })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botA', botId: 'qq_botA', name: '江柚' })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botB', botId: 'qq_botB', name: '阿澈' })

  // 各自命中自己的绑定，互不覆盖。
  eq(store.get('c2c:U1', 'qq_botA')?.sessionId, 'sess-botA', 'botA 应当命中自己的会话')
  eq(store.get('c2c:U1', 'qq_botB')?.sessionId, 'sess-botB', 'botB 应当命中自己的会话')
  eq(store.list().length, 2, '两条绑定都应存在')

  // 删除 botA 的绑定不影响 botB。
  eq(store.remove('c2c:U1', 'qq_botA'), true, '删除 botA 绑定应当成功')
  eq(store.get('c2c:U1', 'qq_botA'), undefined, 'botA 绑定应已删除')
  eq(store.get('c2c:U1', 'qq_botB')?.sessionId, 'sess-botB', 'botB 绑定不受影响')
})

check('A-1 承重前提：同一个 Bot 的同一 openid 幂等覆盖（同键才覆盖）', () => {
  const store = new BindingStore({ home: tempHome() })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq_a' })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-2', botId: 'qq_a' })
  eq(store.list().length, 1, '同一 Bot + 同一 openid 只该有一条')
  eq(store.get('c2c:U1', 'qq_a')?.sessionId, 'sess-2', '后写覆盖先写')
})

check('bySessionId 在多 Bot 下仍唯一（一 Bot 绑一会话）', () => {
  const store = new BindingStore({ home: tempHome() })
  store.set({ conversationKey: 'c2c:A', sessionId: 'sess-x', botId: 'bot1' })
  store.set({ conversationKey: 'c2c:B', sessionId: 'sess-y', botId: 'bot2' })
  eq(store.bySessionId('sess-x')?.botId, 'bot1', '按会话 id 反查应带出 botId')
  eq(store.bySessionId('sess-y')?.botId, 'bot2', '另一条亦然')
})

/* ------------------------------------------------------------ D-3：复合键解析 */

check('bindingKeyOf / botIdOfBinding：\0 复合键无歧义', () => {
  eq(bindingKeyOf('qq_abc', 'c2c:U1'), 'qq_abc\u0000c2c:U1', '复合键形状')
  eq(botIdOfBinding('qq_abc\u0000c2c:U1'), 'qq_abc', '反解 botId')
  eq(botIdOfBinding('c2c:U1'), undefined, '没有 \0 的键（v1 遗留）反解不出 botId')
  eq(botIdOfBinding(undefined), undefined, '非字符串返回 undefined')
})

check('debugKey 把复合键还原成可读形式（日志用）', () => {
  eq(debugKey('qq_abc\u0000c2c:U1'), 'qq_abc → c2c:U1', '可读形式')
  eq(debugKey('c2c:U1'), 'c2c:U1', 'v1 键原样返回')
})

/* ------------------------------------------------------------ 阶段 1：v1 → v2 迁移 */

check('v1 文件读入即迁移为 v2：botId 用迁移配置补全，原文件备份', () => {
  const home = tempHome()
  const dir = integrationHome(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = bindingsFile(home)
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    bindings: {
      'c2c:U1': { sessionId: 'sess-old', botId: 'qq_legacy', name: '江柚', boundAt: '2026-01-01T00:00:00.000Z' },
    },
  }), 'utf8')

  const store = new BindingStore({ home, legacyBotId: 'qq_migrated' })
  const found = store.get('c2c:U1', 'qq_legacy')
  eq(found?.sessionId, 'sess-old', '迁移后应能按复合键读到')
  eq(found?.migratedFrom, 1, '应带 migratedFrom:1 标记')

  // 落盘为 v2：键是复合键。
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq(onDisk.version, 2, '版本号应为 2')
  assert.ok('qq_legacy\u0000c2c:U1' in onDisk.bindings, '键应为复合键')

  // 原文件有备份。
  const backups = fs.readdirSync(dir).filter(name => name.startsWith('bindings.json.bak-'))
  assert.ok(backups.length >= 1, `应有备份文件，实际：${backups.join(',')}`)
  const backup = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8'))
  eq(backup.version, 1, '备份应是 v1 原文')
})

check('v1 记录没有 botId 时用迁移配置的 botId 补全', () => {
  const home = tempHome()
  fs.mkdirSync(integrationHome(home), { recursive: true })
  fs.writeFileSync(bindingsFile(home), JSON.stringify({
    version: 1,
    bindings: { 'c2c:U1': { sessionId: 'sess-old' } },
  }), 'utf8')

  const store = new BindingStore({ home, legacyBotId: 'qq_migrated' })
  const found = store.get('c2c:U1', 'qq_migrated')
  eq(found?.sessionId, 'sess-old', '迁移配置的 botId 应补全归属')
  eq(found?.botId, 'qq_migrated', 'botId 应为迁移值')
})

check('v2 文件直接读取，不再迁移', () => {
  const home = tempHome()
  fs.mkdirSync(integrationHome(home), { recursive: true })
  fs.writeFileSync(bindingsFile(home), JSON.stringify({
    version: 2,
    bindings: { 'qq_bot\u0000c2c:U1': { conversationKey: 'c2c:U1', sessionId: 'sess-v2', botId: 'qq_bot' } },
  }), 'utf8')

  const store = new BindingStore({ home })
  eq(store.get('c2c:U1', 'qq_bot')?.sessionId, 'sess-v2', 'v2 应直接读取')
  eq(store.migratedFrom, null, '不应发生迁移')
})

/* ------------------------------------------------------------ 阶段 2：配置归一 */

check('deriveBotIdentity：botId / secretRef 由 appId 派生（对齐 dsh-im）', () => {
  const d = deriveBotIdentity('1905583221')
  assert.ok(/^qq_[a-f0-9]{24}$/.test(d.botId), `botId 形状：${d.botId}`)
  assert.ok(/^DSH_QQBOT_APP_SECRET_[A-F0-9]{24}$/.test(d.secretRef), `secretRef 形状：${d.secretRef}`)
  // 确定性：同一个 appId 派生结果一致。
  eq(deriveBotIdentity('1905583221'), d, '同一 appId 派生结果必须一致')
  eq(deriveBotIdentity(''), undefined, '空 appId 返回 undefined')
})

check('阶段 2：bots 为空 + 顶层 appId 非空 → 自动归一成单条（旧配置一个字段不改）', () => {
  const resolved = resolveConfig({ enabled: true, appId: '1905583221', botId: 'qq', secretRef: 'DSH_QQBOT_APP_SECRET' })
  eq(resolved.bots.length, 1, '应归一成一条')
  eq(resolved.bots[0].appId, '1905583221', 'appId 保留')
  eq(resolved.bots[0].botId, 'qq', '显式 botId 保留')
  eq(resolved.bots[0].secretRef, 'DSH_QQBOT_APP_SECRET', '显式 secretRef 保留')
  eq(resolved.appId, '1905583221', '顶层兼容字段同步')
  eq(resolved.botId, 'qq', '顶层 botId 同步')
})

check('阶段 2：bot 缺 botId/secretRef 时由 appId 派生补齐', () => {
  const resolved = resolveConfig({ enabled: true, bots: [{ appId: '1905583221' }] })
  eq(resolved.bots.length, 1, '一条 bot')
  const d = deriveBotIdentity('1905583221')
  eq(resolved.bots[0].botId, d.botId, 'botId 应派生')
  eq(resolved.bots[0].secretRef, d.secretRef, 'secretRef 应派生')
})

check('阶段 2：多个 Bot 各自归一，重复 appId 被去重', () => {
  const resolved = resolveConfig({
    enabled: true,
    bots: [
      { appId: '1900000001', alias: '一号' },
      { appId: '1900000002', alias: '二号' },
      { appId: '1900000001', alias: '重复' },   // 与第一条重复 → 去重
    ],
  })
  eq(resolved.bots.length, 2, '重复条目应被去重')
  eq(resolved.bots[0].alias, '一号', '保留第一条')
  eq(resolved.bots[1].alias, '二号', '第二条保留')
})

check('阶段 2：per-bot 角色透传（agentPreset / story）', () => {
  const resolved = resolveConfig({
    enabled: true,
    bots: [
      { appId: '1900000001', alias: '一号', agentPreset: 'preset-su-nian' },
      { appId: '1900000002', alias: '二号', story: { character: { name: '阿澈' } } },
    ],
  })
  eq(resolved.bots[0].agentPreset, 'preset-su-nian', 'agentPreset 应透传')
  eq(resolved.bots[1].story?.character?.name, '阿澈', 'per-bot story 应透传')
  eq(resolved.bots[0].story, undefined, '未配 story 不产生字段')
  eq(resolved.bots[1].agentPreset, '', '未配 agentPreset 为空串')
})

check('normalizeBotEntry：整条无用（无 appId 无 botId）丢弃，不产生半截配置', () => {
  eq(normalizeBotEntry({}), undefined, '空条目丢弃')
  eq(normalizeBotEntry({ alias: '只有别名' }), undefined, '只有别名也丢弃')
  const ok = normalizeBotEntry({ appId: '1900000001', alias: 'x' })
  eq(ok.botId, deriveBotIdentity('1900000001').botId, '合法条目保留并派生')
})

check('阶段 2：per-bot cwd / whitelist 透传（卡片二级面板字段）', () => {
  const resolved = resolveConfig({
    enabled: true,
    bots: [
      { appId: '1900000001', cwd: 'D:/bot1', whitelist: ['U1', '', '  U2  '] },
      { appId: '1900000002' },
    ],
  })
  eq(resolved.bots[0].cwd, 'D:/bot1', 'cwd 应透传')
  eq(resolved.bots[0].whitelist, ['U1', 'U2'], 'whitelist 应过滤空串与空白')
  eq(resolved.bots[1].cwd, '', '未配 cwd 为空串')
  eq(resolved.bots[1].whitelist, [], '未配 whitelist 为空数组')
})

check('阶段 2：per-bot 机器人命令开关透传（缺省开）', () => {
  const resolved = resolveConfig({
    enabled: true,
    bots: [
      { appId: '1900000001' },
      { appId: '1900000002', botCommands: false },
    ],
  })
  eq(resolved.bots[0].botCommands, true, '缺省应为开')
  eq(resolved.bots[1].botCommands, false, '显式关闭应透传')
})

/* ------------------------------------------------------------ 入站路由：botId 不串号 */

check('入站路由：同 openid 消息按 botId 路由到各自绑定（A-1 的路由侧）', () => {
  const store = new BindingStore({ home: tempHome() })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botA', botId: 'qq_botA' })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-botB', botId: 'qq_botB' })

  const fromA = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: { botId: 'qq_botA' },
  })
  eq(fromA.sessionId, 'sess-botA', 'botA 的消息应进 botA 的会话')

  const fromB = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm2' },
    bindings: store,
    config: { botId: 'qq_botB' },
  })
  eq(fromB.sessionId, 'sess-botB', 'botB 的消息应进 botB 的会话')
})

check('入站路由：未指定 botId（旧调用）仍能按 conversationKey 找到（兼容路径）', () => {
  const store = new BindingStore({ home: tempHome() })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq_bot' })
  const route = routeInbound({
    message: { kind: 'c2c', senderId: 'U1', messageId: 'm1' },
    bindings: store,
    config: {},
  })
  eq(route.sessionId, 'sess-1', '兼容路径应命中')
})

console.log(`multibot.test.mjs：${passed} 项通过`)

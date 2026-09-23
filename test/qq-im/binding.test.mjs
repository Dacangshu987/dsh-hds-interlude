/**
 * binding.js 的测试：绑定持久化、原子写、遗留数据迁移。
 */
import assert from 'node:assert/strict'
import { caseDir } from '../helpers/tmp.mjs'
import fs from 'node:fs'
import path from 'node:path'

import {
  BindingStore, conversationKeyOf, targetIdOf, scopeOf,
  readLegacyBindings, migrateLegacyBindings, bindingsFile, integrationHome, dshHome,
} from '../../lib/qq-im/binding.js'

let passed = 0
function check(label, fn) { fn(); passed += 1 }
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

/** 每个用例一个独立目录，避免互相污染。 */
let counter = 0
function tempHome() {
  counter += 1
  return caseDir('bind')
}

/* ------------------------------------------------------------ 键解析 */

check('conversationKey 构造与反解', () => {
  eq(conversationKeyOf({ targetId: 'ABC' }), 'c2c:ABC', '默认 c2c')
  eq(conversationKeyOf({ scope: 'group', targetId: 'G1' }), 'group:G1', '群聊键')
  eq(conversationKeyOf({}), undefined, '缺 targetId 应当返回 undefined')
  eq(targetIdOf('c2c:ABC'), 'ABC', '反解 openid')
  eq(targetIdOf('group:G1'), 'G1', '反解群 id')
  eq(scopeOf('group:G1'), 'group', '反解 scope')
  eq(scopeOf('c2c:ABC'), 'c2c', '默认 scope')
})

/* ------------------------------------------------------------ 持久化 */

check('写入后能读回（跨实例，即真的落盘了）', () => {
  const home = tempHome()
  const a = new BindingStore({ home })
  a.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq', name: '江柚' })

  const b = new BindingStore({ home })
  const found = b.get('c2c:U1')
  eq(found?.sessionId, 'sess-1', '应当读回会话 id')
  eq(found?.name, '江柚', '应当读回名字')
})

check('幂等写入不重复落盘', () => {
  const home = tempHome()
  const store = new BindingStore({ home })
  const first = store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  eq(first.changed, true, '首次应当算变更')
  const second = store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  eq(second.changed, false, '完全相同不该算变更')
  eq(second.persisted, false, '不该再写一次盘')
})

check('bySessionId 反查', () => {
  const home = tempHome()
  const store = new BindingStore({ home })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  store.set({ conversationKey: 'c2c:U2', sessionId: 'sess-2', botId: 'qq' })
  eq(store.bySessionId('sess-2')?.conversationKey, 'c2c:U2', '应当反查到正确的键')
  eq(store.bySessionId('nope'), undefined, '查不到应当返回 undefined')
})

check('删除绑定', () => {
  const home = tempHome()
  const store = new BindingStore({ home })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  eq(store.remove('c2c:U1'), true, '删除应当成功')
  eq(store.get('c2c:U1'), undefined, '删掉就该查不到')
  eq(store.remove('c2c:U1'), false, '重复删除应当返回 false')
})

check('文件损坏时当作空表，不抛错', () => {
  const home = tempHome()
  fs.mkdirSync(integrationHome(home), { recursive: true })
  fs.writeFileSync(bindingsFile(home), '{ 这不是合法 JSON', 'utf8')
  const store = new BindingStore({ home })
  eq(store.list(), [], '损坏的文件应当被当作空表')
})

check('写入不留下临时文件', () => {
  const home = tempHome()
  const store = new BindingStore({ home })
  store.set({ conversationKey: 'c2c:U1', sessionId: 'sess-1', botId: 'qq' })
  const files = fs.readdirSync(integrationHome(home))
  assert.ok(!files.some(f => f.includes('.tmp-')), `不该留下临时文件：${files.join(',')}`)
})

check('缺参数的写入被拒绝', () => {
  const store = new BindingStore({ home: tempHome() })
  assert.throws(() => store.set({ conversationKey: '', sessionId: 'x' }), /conversationKey/, '缺键应当抛错')
  assert.throws(() => store.set({ conversationKey: 'c2c:U', sessionId: '' }), /sessionId/, '缺会话应当抛错')
})

/* ------------------------------------------------------------ 遗留迁移 */

check('从 dsh-im 的旧数据只读迁移', () => {
  const home = tempHome()
  const legacyDir = path.join(home, 'integrations', 'dsh-qq')
  fs.mkdirSync(path.join(legacyDir, 'bots', 'qq_bot1'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: {
      qq_bot1: {
        jiangyou: {
          name: '江柚',
          sessionSync: { conversationKey: 'c2c:OPENID1' },
        },
      },
    },
  }), 'utf8')
  fs.writeFileSync(path.join(legacyDir, 'bots', 'qq_bot1', 'state.json'), JSON.stringify({
    sessions: { 'c2c:OPENID1': 'session-abc' },
  }), 'utf8')

  const found = readLegacyBindings({ home })
  eq(found.length, 1, '应当迁出 1 条')
  eq(found[0].conversationKey, 'c2c:OPENID1', '会话键应当正确')
  eq(found[0].sessionId, 'session-abc', '会话 id 应当正确')
  eq(found[0].name, '江柚', '名字应当带上')
})

check('没有 sessionSync 时退回 targetId 作 openid', () => {
  const home = tempHome()
  const legacyDir = path.join(home, 'integrations', 'dsh-qq')
  fs.mkdirSync(path.join(legacyDir, 'bots', 'qq_bot1'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { qq_bot1: { OPENID2: { name: '某人' } } },
  }), 'utf8')
  fs.writeFileSync(path.join(legacyDir, 'bots', 'qq_bot1', 'state.json'), JSON.stringify({
    sessions: { 'c2c:OPENID2': 'session-xyz' },
  }), 'utf8')

  const found = readLegacyBindings({ home })
  eq(found.length, 1, '应当退回到用 targetId 拼键')
  eq(found[0].sessionId, 'session-xyz', '会话 id 应当正确')
})

check('旧数据缺失时安静返回空，不抛错', () => {
  eq(readLegacyBindings({ home: tempHome() }), [], '没有旧数据应当返回空数组')
})

check('migrateLegacyBindings 只在表为空时迁移', () => {
  const home = tempHome()
  const legacyDir = path.join(home, 'integrations', 'dsh-qq')
  fs.mkdirSync(path.join(legacyDir, 'bots', 'qq_bot1'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'workspaces.json'), JSON.stringify({
    deliveryTargets: { qq_bot1: { t1: { sessionSync: { conversationKey: 'c2c:A' } } } },
  }), 'utf8')
  fs.writeFileSync(path.join(legacyDir, 'bots', 'qq_bot1', 'state.json'), JSON.stringify({
    sessions: { 'c2c:A': 'session-1' },
  }), 'utf8')

  const store = new BindingStore({ home })
  eq(migrateLegacyBindings(store, { home }), 1, '首次应当迁 1 条')
  // 表非空时不该再迁（避免覆盖用户后来的手工绑定）。
  eq(migrateLegacyBindings(store, { home }), 0, '表非空时不该重复迁移')
})

check('dshHome 尊重 DSH_HOME 环境变量', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:/custom-home'
  try {
    eq(dshHome(), 'D:/custom-home', '应当使用环境变量')
    eq(dshHome('D:/explicit'), 'D:/explicit', '显式参数优先')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

console.log(`binding.test.mjs：${passed} 项通过`)

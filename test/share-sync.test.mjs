/**
 * 分享码同步（`lib/share-sync.js`）的用例。
 *
 * ## 这一层为什么必须测
 *
 * 它是**唯一会把外部数据写进用户配置**的入口。坏起来是**静默且危险**的：
 *   - **连接类字段漏进配置**：一份预设就能把 `apiKey` / `endpoint` / `proxyAgent`
 *     换掉，之后所有请求（含携带的凭据）都发去别人指定的地方；
 *   - **整段替换把本地清空**：远端少写一个键，本地那条设置就没了；
 *   - **story 被顺手覆盖**：只给「角色名」的预设若不判空，会把本地已有的
 *     长篇人设一起清掉；
 *   - **把无效响应当成有效预设**：网关错误页 / 旧接口 / 恶意响应都会变成配置。
 *
 * 所以这里的用例按「**先证明它挡得住**」来写，而不是只测正常路径。
 *
 * 运行：node test/share-sync.test.mjs
 */

import assert from 'node:assert/strict'

import {
  SHARE_SECTIONS, sanitizeSharePayload, normalizeShareCode, snapshotDeepCopy,
  diffSection, buildConfigPatch, storyDefaultsToStoryPatch, summarizeShare,
  formatDiffLines, normalizeShareVersion, fetchShare,
} from '../lib/share-sync.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}
const eq = (actual, expected, label) => assert.deepEqual(
  actual, expected,
  `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
)
const throws = (fn, label) => {
  let threw = false
  try { fn() } catch { threw = true }
  assert.ok(threw, label)
}

console.log('分享码同步')

/* ─────────────── A. 分享码 ─────────────── */

check('normalizeShareCode：大小写/连字符/空白都认，非法返回 null', () => {
  eq(normalizeShareCode('7G2M9QRS'), '7G2M9QRS', '规范形态')
  eq(normalizeShareCode('7g2m-9qrs'), '7G2M9QRS', '小写 + 连字符')
  eq(normalizeShareCode('  7G2M 9QRS '), '7G2M9QRS', '含空白')
  // Crockford base32 去掉易混字母：I / L / O / U 不合法。
  for (const bad of ['IIIIIIII', 'LLLLLLLL', 'OOOOOOOO', 'UUUUUUUU']) {
    eq(normalizeShareCode(bad), null, `${bad} 不该合法`)
  }
  for (const bad of ['', '1234', '123456789', 'ABC!DEFG', undefined, null]) {
    eq(normalizeShareCode(bad), null, `${JSON.stringify(bad)} 不该合法`)
  }
})

/* ─────────────── B. 清洗（安全边界） ─────────────── */

check('sanitizeSharePayload：白名单之外的分区整段剔除', () => {
  const { preset, removed } = sanitizeSharePayload({
    runtime: { a: 1 },
    // 连接/模型/开关类分区：**一个都不该进来**。
    im: { appId: '123', secretRef: 'X' },
    enabled: true,
    mainPrompt: '改人格',
    presetSync: { baseUrl: 'http://evil' },
    notASection: { x: 1 },
  })
  eq(Object.keys(preset), ['runtime'], '只剩白名单里的分区')
  assert.ok(removed.includes('im'), 'im 被剔除')
  assert.ok(removed.includes('enabled'), 'enabled 被剔除')
  assert.ok(removed.includes('mainPrompt'), 'mainPrompt 被剔除')
  assert.ok(removed.includes('presetSync'), 'presetSync 自身被剔除（防止预设改同步设置）')
  // 白名单里不含连接类分区——这是「连接类永不同步」的实现方式。
  assert.ok(!SHARE_SECTIONS.includes('im'), '白名单不该含 im')
})

check('sanitizeSharePayload：连接/敏感字段被**深度**剔除（含数组与嵌套）', () => {
  const { preset, removed } = sanitizeSharePayload({
    runtime: {
      keep: 1,
      apiKey: 'GONE',
      endpoint: 'GONE',
      proxyAgent: 'GONE',
      extraHeaders: { a: 1 },
      secretRef: 'GONE',
      appId: 'GONE',
      nested: { deep: { token: 'GONE', ok: 2 } },
      list: [{ password: 'GONE', ok: 3 }],
    },
  })
  eq(preset.runtime.keep, 1)
  eq(preset.runtime.apiKey, undefined, 'apiKey 被剔')
  eq(preset.runtime.endpoint, undefined, 'endpoint 被剔')
  eq(preset.runtime.proxyAgent, undefined, 'proxyAgent 被剔')
  eq(preset.runtime.extraHeaders, undefined, 'extraHeaders 被剔')
  eq(preset.runtime.secretRef, undefined, 'secretRef 被剔')
  eq(preset.runtime.appId, undefined, 'appId 被剔')
  eq(preset.runtime.nested.deep.token, undefined, '深层 token 被剔')
  eq(preset.runtime.nested.deep.ok, 2, '同层非敏感字段保留')
  eq(preset.runtime.list[0].password, undefined, '数组元素里的 password 被剔')
  eq(preset.runtime.list[0].ok, 3, '数组元素里的正常字段保留')
  assert.ok(removed.some(p => p.includes('nested.deep.token')), '剔除清单要带路径（便于排查）')
})

check('sanitizeSharePayload：非对象 payload 报错（不是静默当空）', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    throws(() => sanitizeSharePayload(bad), `${JSON.stringify(bad)} 应报错`)
  }
})

/* ─────────────── C. 差异与补丁 ─────────────── */

check('diffSection：added / changed / removedKeys 三类分开报', () => {
  eq(diffSection({ a: 1, b: 2 }, { a: 9, c: 3 }), {
    changed: ['a'], added: ['c'], removedKeys: ['b'],
  })
  // 键序不同不算「改过」（稳定序列化）。
  eq(diffSection({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }).changed, [], '键序不影响判定')
  eq(diffSection(undefined, { a: 1 }), { changed: [], added: ['a'], removedKeys: [] }, '本地为空')
})

check('buildConfigPatch：整段替换；story 默认不动，显式开启才替换', () => {
  const config = { runtime: { keepLocal: 1, dropMe: 2 }, story: { characterName: '旧' }, logging: { level: 'warn' } }
  const preset = { runtime: { fromRemote: 9 }, story: { characterName: '新' }, logging: { level: 'info' } }
  const patched = buildConfigPatch(config, preset, ['runtime', 'story', 'logging'])
  // 整段替换：本地多出的 dropMe 会消失，远端的 fromRemote 进来。
  eq(patched.runtime, { fromRemote: 9 }, 'runtime 整段替换')
  eq(patched.story, { characterName: '旧' }, 'story 默认不动')
  eq(patched.logging, { level: 'info' }, 'logging 替换')
  // 入参不被改动。
  eq(config.runtime, { keepLocal: 1, dropMe: 2 }, '入参不被改动')
  // 显式开启才连 story 一起替换。
  eq(buildConfigPatch(config, preset, ['story'], { includeStoryDefaults: true }).story, { characterName: '新' })
  // 不在白名单 / 远端没有这个分区 → 跳过。
  eq(buildConfigPatch(config, preset, ['im']).im, undefined, '非白名单分区不写入')
  eq(buildConfigPatch(config, { }, ['runtime']).runtime, { keepLocal: 1, dropMe: 2 }, '远端没有该分区 → 跳过（不清空）')
})

check('storyDefaultsToStoryPatch：**只覆盖远端给了的字段**（不顺手清空）', () => {
  // 只给角色名：不该同时产出 user / world / profile，否则本地已有的会被清掉。
  eq(storyDefaultsToStoryPatch({ characterName: '江柚' }), { character: { name: '江柚' } }, '只给名字')
  const full = storyDefaultsToStoryPatch({
    characterName: '江柚', characterProfile: '设定', userProfile: '用户', relationship: '旧识',
    world: '近未来', perspectives: ['甲', '  ', '乙'], location: '老城区', style: '克制',
  })
  eq(full.character, { name: '江柚', profile: '设定' })
  eq(full.user, { profile: '用户' })
  eq(full.relationship, '旧识')
  eq(full.world, '近未来')
  eq(full.perspectives, ['甲', '乙'], '空字符串条目被丢掉')
  eq(full.location, '老城区')
  // 空/坏输入 → 空补丁（不是把字段设成 undefined）。
  eq(storyDefaultsToStoryPatch(undefined), {}, '坏输入 → 空补丁')
  eq(storyDefaultsToStoryPatch({ characterName: '   ' }), {}, '纯空白不算给了')
})

check('snapshotDeepCopy：快照必须是深拷贝（否则回滚失效）', () => {
  const live = { runtime: { a: 1 } }
  const snap = snapshotDeepCopy(live)
  live.runtime.a = 999
  eq(snap.runtime.a, 1, '改原位不影响快照')
  assert.notEqual(snap, live, '不是同一个引用')
  eq(snapshotDeepCopy(undefined), undefined, 'undefined 原样')
})

check('normalizeShareVersion：rc46 与 1.0.1-rc46 视作同一版', () => {
  eq(normalizeShareVersion('1.0.1-rc46'), 'rc46')
  eq(normalizeShareVersion('RC46'), 'rc46')
  eq(normalizeShareVersion('rc46'), 'rc46')
  assert.notEqual(normalizeShareVersion('1.0.1-rc46'), normalizeShareVersion('1.0.1-rc50'))
})

/* ─────────────── D. 概览渲染 ─────────────── */

check('summarizeShare / formatDiffLines：把差异讲清楚，并如实报告剔除项', () => {
  const info = {
    title: '安静的关系', type: 'private', nsfw: true,
    author: { name: '某人' }, hdsi_version: '1.0.1-rc50', revision: 3,
    sections: ['runtime', 'logging'], payload: { runtime: { a: 1 }, logging: { level: 'info' } },
  }
  const summary = summarizeShare({
    info, config: { runtime: { a: 0 }, logging: {} }, sections: ['runtime', 'logging'],
    localVersion: '1.0.1-rc50', removed: ['im.apiKey'],
  })
  const text = formatDiffLines(summary).join('\n')
  assert.ok(text.includes('安静的关系'), '带标题')
  assert.ok(text.includes('@某人'), '带作者')
  assert.ok(text.includes('NSFW'), 'NSFW 要提醒')
  assert.ok(text.includes('已剔除 1 项'), '要如实告知剔除了连接类字段')
  assert.ok(text.includes('runtime'), '列出分区差异')
  // 版本不同要提醒。
  const warn = formatDiffLines(summarizeShare({
    info, config: {}, sections: ['runtime'], localVersion: '1.0.1-rc46',
  })).join('\n')
  assert.ok(warn.includes('版本差异'), '版本差异要提醒')
  // 同一版本不提醒。
  const quiet = formatDiffLines(summarizeShare({
    info, config: {}, sections: ['runtime'], localVersion: '1.0.1-rc50',
  })).join('\n')
  assert.ok(!quiet.includes('版本差异'), '同版本不提醒')
})

/* ─────────────── E. 拉取（错误分类） ─────────────── */

const okBody = (over = {}) => ({
  code: '7G2M9QRS', revision: 1, title: 'T', type: 'private', slug: 's', nsfw: false,
  author: { id: 1, name: '某人' }, hdsi_version: '1.0.1-rc50',
  sections: ['runtime'], payload: { runtime: { a: 1 } }, ...over,
})

check('fetchShare：正常拉取 → 清洗后的 info + 剔除清单', async () => {
  const result = await fetchShare({
    baseUrl: 'https://typ0.space/', code: '7g2m-9qrs',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://typ0.space/api/share/7G2M9QRS', 'URL 要去掉尾部斜杠并规范化码')
      return { status: 200, body: okBody({ payload: { runtime: { a: 1, apiKey: 'X' }, im: { appId: '1' } } }) }
    },
  })
  eq(result.info.code, '7G2M9QRS')
  eq(result.info.revision, 1)
  eq(result.info.sections, ['runtime'], 'sections 只留白名单里的')
  eq(result.cleaned.runtime.a, 1)
  eq(result.cleaned.runtime.apiKey, undefined, 'apiKey 已在插件侧被剔')
  eq(result.cleaned.im, undefined, 'im 整段不在白名单')
  assert.ok(result.removed.some(p => p.includes('apiKey')), '剔除清单带路径')
})

check('fetchShare：码格式不对**不发请求**', async () => {
  let called = 0
  await assert.rejects(
    () => fetchShare({ baseUrl: 'https://x', code: 'bad', fetchImpl: async () => { called += 1; return { status: 200, body: okBody() } } }),
    /分享码格式不正确/,
  )
  eq(called, 0, '不该打扰分享站')
  await assert.rejects(() => fetchShare({ baseUrl: '', code: '7G2M9QRS' }), /未配置分享站地址/)
})

check('fetchShare：404 / 429 / 异常状态各有各的话（用户能据此行动）', async () => {
  const at = (status, body) => fetchShare({ baseUrl: 'https://x', code: '7G2M9QRS', fetchImpl: async () => ({ status, body }) })
  await assert.rejects(() => at(404, {}), /不存在、已过期或不可用/)
  await assert.rejects(() => at(429, {}), /限流/)
  await assert.rejects(() => at(500, {}), /异常状态 500/)
})

check('fetchShare：**响应校验**——码不一致 / revision 非法 / sections 非法都当无效', async () => {
  const at = (body) => fetchShare({ baseUrl: 'https://x', code: '7G2M9QRS', fetchImpl: async () => ({ status: 200, body }) })
  await assert.rejects(() => at(okBody({ code: 'AAAAAAAA' })), /分享码与请求不一致/, '码不一致')
  await assert.rejects(() => at(okBody({ revision: 0 })), /revision 无效/, 'revision < 1')
  await assert.rejects(() => at(okBody({ revision: 1.5 })), /revision 无效/, 'revision 非整数')
  await assert.rejects(() => at(okBody({ sections: 'runtime' })), /sections 无效/, 'sections 非数组')
  await assert.rejects(() => at(okBody({ sections: [1] })), /sections 无效/, 'sections 元素非字符串')
  await assert.rejects(() => at('not json'), /响应格式异常/, '非对象响应')
  // 清洗后没有可应用分区 → 报错，而不是「应用了一个空预设」（那会把配置清空）。
  await assert.rejects(
    () => at(okBody({ payload: { im: { appId: '1' } } })),
    /没有可应用的分区/,
    '清洗后为空要报错',
  )
})

check('fetchShare：URL 里的分享码**规范化后**才拼进去（防注入）', async () => {
  let seen = ''
  await fetchShare({
    baseUrl: 'https://typ0.space', code: '7g2m-9qrs',
    fetchImpl: async (url) => { seen = url; return { status: 200, body: okBody() } },
  })
  eq(seen, 'https://typ0.space/api/share/7G2M9QRS')
  // 带路径穿越/额外字符的输入会被格式校验挡住，不会拼进 URL。
  await assert.rejects(
    () => fetchShare({ baseUrl: 'https://typ0.space', code: '../../etc/passwd', fetchImpl: async () => ({ status: 200, body: okBody() }) }),
    /分享码格式不正确/,
  )
})

console.log(`\n分享码同步：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

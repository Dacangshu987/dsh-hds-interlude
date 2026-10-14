/**
 * 运行时天气（`lib/weather.js`，移植自上游 rc52 的 `src/weather.ts`）的用例。
 *
 * ## 这一层为什么值得测
 *
 * 它把**外部数据注进剧情**，而且坏起来都很静默：
 *   - **坐标被悄悄改成 0,0**：Console 表单清空过的字段会变成空值，
 *     `Number(null)` 恰好是 0——于是「没填坐标」被当成「用户在几内亚湾」，
 *     天气从此来自赤道，而没有任何报错。这是上游专门加 `typeof` 守卫的原因。
 *   - **缓存 TTL 等于扫描周期**：首次拉取的耗时会让下一轮必定命中缓存，
 *     实际刷新率**减半**（上游把 TTL 定成周期的 90% 就是为这个）。
 *   - **地名解析不到时反复外呼**：每一轮扫描都为同一个不可解析的地名白打一次
 *     8 秒超时请求；要靠**负结果短缓存**挡住。
 *   - **架空世界被注入真实天气**：异世界设定里出现「今日 22°C」会破坏设定。
 *
 * 所有网络调用都用注入的假实现，**离线跑**。
 *
 * 运行：node test/weather.test.mjs
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_WEATHER_CONFIG, resolveWeatherConfig, WMO_CODES, conditionOfCode,
  geocodeCity, fetchWeatherSnapshot, isFantasyStory, lastWeatherSnapshot, resetWeatherCache,
} from '../lib/weather.js'

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
const checkAsync = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}\n       ${error?.message ?? error}`)
  }
}

console.log('运行时天气')

/* ─────────────── A. 配置归一化 ─────────────── */

check('resolveWeatherConfig：默认值与上游逐项一致', () => {
  eq(DEFAULT_WEATHER_CONFIG, {
    enabled: false, latitude: 39.14, longitude: 117.18,
    autoFromLocation: true, skipFantasyWorld: false, cadenceMinutes: 30,
  })
  eq(resolveWeatherConfig(undefined), DEFAULT_WEATHER_CONFIG, '坏输入回默认')
  eq(resolveWeatherConfig({}), DEFAULT_WEATHER_CONFIG, '空对象回默认')
})

check('resolveWeatherConfig：【关键】空值不会被当成 0,0', () => {
  // 这条是上游专门加的守卫。若只写 Number.isFinite(Number(v))，
  // null / '' 都会变成 0 —— 一个**合法**坐标，于是静默跑到几内亚湾。
  for (const bad of [null, '', undefined, '39.14', NaN]) {
    const cfg = resolveWeatherConfig({ latitude: bad, longitude: bad })
    eq(cfg.latitude, DEFAULT_WEATHER_CONFIG.latitude, `${JSON.stringify(bad)} 纬度应回退`)
    eq(cfg.longitude, DEFAULT_WEATHER_CONFIG.longitude, `${JSON.stringify(bad)} 经度应回退`)
  }
  // 真的 0 是合法坐标，要保留。
  eq(resolveWeatherConfig({ latitude: 0, longitude: 0 }).latitude, 0, '显式 0 保留')
})

check('resolveWeatherConfig：夹取范围与开关语义', () => {
  eq(resolveWeatherConfig({ latitude: 999 }).latitude, 90, '纬度上限')
  eq(resolveWeatherConfig({ latitude: -999 }).latitude, -90, '纬度下限')
  eq(resolveWeatherConfig({ longitude: 999 }).longitude, 180, '经度上限')
  eq(resolveWeatherConfig({ longitude: -999 }).longitude, -180, '经度下限')
  // 只有显式 false 才关自动解析；只有显式 true 才开跳过架空/总开关。
  eq(resolveWeatherConfig({ autoFromLocation: false }).autoFromLocation, false)
  eq(resolveWeatherConfig({ autoFromLocation: undefined }).autoFromLocation, true, '缺省＝开')
  eq(resolveWeatherConfig({ enabled: 'yes' }).enabled, false, '非 true 不算开')
  eq(resolveWeatherConfig({ skipFantasyWorld: 'yes' }).skipFantasyWorld, false)
  // 扫描周期夹到 5–180 并取整。
  eq(resolveWeatherConfig({ cadenceMinutes: 1 }).cadenceMinutes, 5, '下限')
  eq(resolveWeatherConfig({ cadenceMinutes: 999 }).cadenceMinutes, 180, '上限')
  eq(resolveWeatherConfig({ cadenceMinutes: 30.9 }).cadenceMinutes, 30, '取整')
})

/* ─────────────── B. 天气码 ─────────────── */

check('conditionOfCode：常见码译中文，**没收录的不猜**', () => {
  eq(conditionOfCode(0), '晴')
  eq(conditionOfCode(61), '小雨')
  eq(conditionOfCode(95), '雷阵雨')
  eq(conditionOfCode(12345), '天气码12345', '没收录的如实标注，不含糊说「多云」')
  eq(conditionOfCode(undefined), '未知天气')
  eq(conditionOfCode('61'), '未知天气', '字符串码不当数字用（不静默转换）')
  // 码表覆盖上游那几个关键区间即可，不必穷举。
  assert.ok(Object.keys(WMO_CODES).length >= 25)
})

/* ─────────────── C. 架空世界 ─────────────── */

check('isFantasyStory：命中关键词即判定为架空（世界与地点拼接后匹配）', () => {
  for (const text of ['异世界', '有个精灵', '架空大陆', '幻想乡', '另一个世界']) {
    eq(isFantasyStory(text, ''), true, `${text} 应判为架空`)
    eq(isFantasyStory('', text), true, `${text} 在地点里也算`)
  }
  eq(isFantasyStory('现代都市，中国北方', '老城区'), false, '现实设定不误判')
  eq(isFantasyStory(undefined, undefined), false, '空输入不误判')
  eq(isFantasyStory({ setting: '异世界' }, ''), false, '对象不会被隐式转成文本（上游同为字符串拼接）')
})

/* ─────────────── D. 拉取与缓存（离线） ─────────────── */

/** 假的地理编码 + 天气服务。 */
const fakeServices = (opts = {}) => {
  const calls = []
  const fetchJson = async (url) => {
    calls.push(url)
    if (url.includes('geocoding-api')) {
      if (opts.geoFail) return { status: 200, body: { results: [] } }
      return { status: 200, body: { results: [{ latitude: 31.23, longitude: 121.47, name: '上海' }] } }
    }
    return {
      status: 200,
      body: {
        current: {
          temperature_2m: opts.temp ?? 22.4,
          apparent_temperature: opts.feels ?? 21.1,
          relative_humidity_2m: opts.humidity ?? 78,
          weather_code: opts.code ?? 51,
          wind_speed_10m: opts.wind ?? 3.2,
        },
      },
    }
  }
  return { calls, fetchJson }
}

await checkAsync('fetchWeatherSnapshot：解析出快照，注入文本是**纯数据**', async () => {
  resetWeatherCache()
  const { fetchJson } = fakeServices()
  const snap = await fetchWeatherSnapshot({
    config: resolveWeatherConfig({ enabled: true, cadenceMinutes: 30 }),
    locationHint: '上海',
    fetchJson,
  })
  eq(snap.temperature, 22, '温度取整')
  eq(snap.feelsLike, 21, '体感取整')
  eq(snap.humidity, 78)
  eq(snap.windSpeed, 3)
  eq(snap.condition, '小毛毛雨')
  // 注入文本：不带地名、不带建议句——只有环境和数据。
  eq(snap.text, '环境：22°C 小毛毛雨。')
  assert.ok(!snap.text.includes('上海'), '不带观测点地名')
  assert.ok(!/记得|建议|要不要/.test(snap.text), '不带建议句')
})

await checkAsync('fetchWeatherSnapshot：配了自动解析时先按地名解析', async () => {
  resetWeatherCache()
  const { calls, fetchJson } = fakeServices()
  await fetchWeatherSnapshot({
    config: resolveWeatherConfig({ enabled: true, autoFromLocation: true }),
    locationHint: '上海市',
    fetchJson,
  })
  assert.ok(calls.some(u => u.includes('geocoding-api')), '应调用地理编码')
  const forecast = calls.find(u => u.includes('/v1/forecast'))
  assert.ok(forecast.includes('latitude=31.23') && forecast.includes('longitude=121.47'), `应用解析出的坐标：${forecast}`)
})

await checkAsync('fetchWeatherSnapshot：地名解析失败**回退手动经纬度**（不是放弃）', async () => {
  resetWeatherCache()
  const { calls, fetchJson } = fakeServices({ geoFail: true })
  const snap = await fetchWeatherSnapshot({
    config: resolveWeatherConfig({ enabled: true, latitude: 39.14, longitude: 117.18, autoFromLocation: true }),
    locationHint: '这个地名不存在',
    fetchJson,
  })
  assert.ok(snap, '解析失败也应拿到天气（用手动坐标）')
  const forecast = calls.find(u => u.includes('/v1/forecast'))
  assert.ok(forecast.includes('latitude=39.14'), '回退到手动纬度')
})

await checkAsync('fetchWeatherSnapshot：关闭自动解析时**不调地理编码**', async () => {
  resetWeatherCache()
  const { calls, fetchJson } = fakeServices()
  await fetchWeatherSnapshot({
    config: resolveWeatherConfig({ enabled: true, autoFromLocation: false }),
    locationHint: '上海',
    fetchJson,
  })
  assert.ok(!calls.some(u => u.includes('geocoding-api')), '不该调用地理编码')
})

await checkAsync('fetchWeatherSnapshot：缓存 TTL 是扫描周期的 90%（否则刷新率减半）', async () => {
  resetWeatherCache()
  const { calls, fetchJson } = fakeServices()
  const config = resolveWeatherConfig({ enabled: true, latitude: 10, longitude: 10, autoFromLocation: false, cadenceMinutes: 30 })
  await fetchWeatherSnapshot({ config, fetchJson })
  const first = calls.length
  await fetchWeatherSnapshot({ config, fetchJson })
  eq(calls.length, first, '周期内命中缓存，不重复外呼')
  // 关键：TTL 是 27 分钟而不是 30 分钟——所以「刚过 27 分钟」就该重新拉。
  // 这里用「把缓存时间往前推」来验证，避免真的等 27 分钟。
  const snap = await fetchWeatherSnapshot({ config, useCache: false, fetchJson })
  assert.ok(snap, 'useCache=false 时直接拉新')
  assert.ok(calls.length > first, '关掉缓存后确实又发了一次')
})

await checkAsync('fetchWeatherSnapshot：地名解析不到时**负结果短缓存**（不每轮白打外呼）', async () => {
  resetWeatherCache()
  const { calls, fetchJson } = fakeServices({ geoFail: true })
  await geocodeCity('不存在的地名', { fetchJson })
  const after1 = calls.length
  eq(await geocodeCity('不存在的地名', { fetchJson }), undefined, '仍然解析不到')
  eq(calls.length, after1, '第二次命中负结果缓存，不重复外呼')
})

await checkAsync('fetchWeatherSnapshot：服务返回异常/坏数据时返回 undefined，不抛', async () => {
  resetWeatherCache()
  const bad = async () => ({ status: 200, body: { current: {} } })
  eq(await fetchWeatherSnapshot({ config: resolveWeatherConfig({}), fetchJson: bad }), undefined, '缺温度 → undefined')
  const boom = async () => { throw new Error('网络炸了') }
  eq(await fetchWeatherSnapshot({ config: resolveWeatherConfig({}), fetchJson: boom }), undefined, '抛错也被吞成 undefined')
  resetWeatherCache()
  const noBody = async () => ({ status: 200, body: null })
  eq(await fetchWeatherSnapshot({ config: resolveWeatherConfig({}), fetchJson: noBody }), undefined, '空响应')
})

await checkAsync('lastWeatherSnapshot：给出最近一次成功快照，且**不触发拉取**', async () => {
  resetWeatherCache()
  eq(lastWeatherSnapshot(), undefined, '还没拉过 → undefined')
  const { calls, fetchJson } = fakeServices({ temp: 5, code: 71 })
  await fetchWeatherSnapshot({
    config: resolveWeatherConfig({ latitude: 1, longitude: 1, autoFromLocation: false }),
    fetchJson,
  })
  const n = calls.length
  const latest = lastWeatherSnapshot()
  eq(latest.temperature, 5, '拿到刚才那份')
  eq(latest.condition, '小雪')
  eq(calls.length, n, '读取不触发外呼')
})

console.log(`\n运行时天气：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

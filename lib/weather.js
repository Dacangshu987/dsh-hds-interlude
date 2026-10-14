/**
 * 运行时天气 —— 移植自上游 rc52 的 `src/weather.ts`（178 行，新【扩展 19】）。
 *
 * ## 上游怎么用它
 *
 * 从 Open-Meteo（免费、无需 Key）拉一次**实况天气**，格式化成一句纯数据
 * （`环境：22°C 小毛毛雨。`），作为一个**世界事件**注入剧本——于是角色知道
 * 「今天外面在下雨」，而不用模型自己编天气。注入方式是**滚动替换**：
 * 每次注入前把上一条天气事件标为过期，时间线上只留最新的一条。
 *
 * ## 三条刻意的设计（都来自上游，值得保留）
 *
 *   ① **纯数据、不带建议句、不带观测点地名**：注入的是「环境：22°C 小雨。」，
 *      不是「外面下雨了，你要不要带伞」。天气是**事实**，怎么反应由叙事决定。
 *   ② **复用世界事件管道**，不为它新增剧本类型——管道已经处理了到点注入、
 *      事实化与排查可见性。
 *   ③ **架空世界跳过**：异世界/精灵/幻想设定里没有真实天气这回事，
 *      注入「今日 22°C」会破坏设定（那种世界里模型即兴才是天气来源）。
 *
 * ## 本仓的一处刻意收紧：出站走 SSRF 防护
 *
 * 上游用 `ctx.http.get` 直连。本仓所有出站一律走 `lib/net/safe-fetch.js`
 * （DNS 固定 + 逐跳重校验 + 内网拦截），所以**天气服务地址是写死的公网域名**，
 * 不接受用户配置——这里没有 SSRF 面。测试用注入的 `fetchImpl` 离线跑。
 *
 * @module dsh-hds-interlude/weather
 */

import { safeFetch } from './net/safe-fetch.js'

/** 地理编码服务（城市名 → 经纬度）。 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

/** 实况天气服务。 */
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/** 默认配置（与上游 rc52 的 `DEFAULT_WEATHER_CONFIG` 逐项一致）。 */
export const DEFAULT_WEATHER_CONFIG = {
  enabled: false,
  latitude: 39.14,
  longitude: 117.18,
  autoFromLocation: true,
  skipFantasyWorld: false,
  cadenceMinutes: 30,
}

/**
 * 归一化天气配置。
 *
 * **注意 `typeof v !== 'number'` 那道前置守卫**：`Number(null)` 与 `Number('')`
 * 都是 `0`，而 0° / 0° 是几内亚湾——一个合法的坐标。Console 表单里清空过的
 * 字段会变成空值，若只写 `Number.isFinite(Number(v))` 就会被**静默**当成
 * 「用户在几内亚湾」，而不是走回退值。所以非 number 一律回退。
 *
 * @param {unknown} value 配置原值。
 * @returns {object} 归一化后的配置。
 */
export function resolveWeatherConfig(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const clamp = (v, min, max, fallback) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return Math.max(min, Math.min(max, v))
  }
  return {
    enabled: record.enabled === true,
    latitude: clamp(record.latitude, -90, 90, DEFAULT_WEATHER_CONFIG.latitude),
    longitude: clamp(record.longitude, -180, 180, DEFAULT_WEATHER_CONFIG.longitude),
    // 「没配」＝开（默认开自动解析），只有显式 false 才关。
    autoFromLocation: record.autoFromLocation !== false,
    skipFantasyWorld: record.skipFantasyWorld === true,
    cadenceMinutes: Math.floor(clamp(record.cadenceMinutes, 5, 180, DEFAULT_WEATHER_CONFIG.cadenceMinutes)),
  }
}

/**
 * WMO 天气码 → 中文。
 *
 * WMO 码是国际气象组织的标准枚举；这里只译出现的那几十个。
 * **没收录的码不猜**：退回 `天气码N`，如实告诉用户「有个我们没译的码」，
 * 而不是含糊地说「多云」。
 */
export const WMO_CODES = {
  0: '晴', 1: '基本晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '小冻毛毛雨', 57: '大冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '小冻雨', 67: '大冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
}

/** 把天气码译成中文；没收录的如实标注，不猜。 */
export function conditionOfCode(code) {
  if (typeof code !== 'number') return '未知天气'
  return WMO_CODES[code] ?? `天气码${code}`
}

/** 进程内快照缓存：`缓存键 → { snapshot, cachedAt }`。 */
const snapshotCache = new Map()
/** 进程内地理编码缓存：`城市名 → { lat, lon, name, cachedAt }`。 */
const geoCache = new Map()
/** 地理编码结果的有效期（24 小时）。 */
const GEO_CACHE_TTL = 24 * 3_600_000

/** 清空进程内缓存（测试与重置用）。 */
export function resetWeatherCache() {
  snapshotCache.clear()
  geoCache.clear()
}

/**
 * 城市名 → 经纬度（Open-Meteo 地理编码）。
 *
 * ## 两处防抖（都来自上游）
 *
 *   - **正向缓存 24 小时**：同一个地名不该每轮都解析一次；
 *   - **负结果短缓存**：解析不到的地名也缓存（约 10 分钟），否则每一轮扫描都会
 *     为它白打一次 8 秒超时的外呼。上游用的是「写入一个快要过期的空名条目」
 *     这个哨兵做法，这里保留同样语义。
 *
 * @param {string} city 地点描述（可能是一整句，交给服务端去猜）。
 * @param {object} [deps]
 * @param {(url: string) => Promise<{status: number, body: any}>} [deps.fetchJson]
 *   注入的 JSON 抓取（测试用）；省略则走 SSRF 防护层。
 * @returns {Promise<{lat: number, lon: number, name: string}|undefined>}
 */
export async function geocodeCity(city, { fetchJson } = {}) {
  const raw = String(city ?? '').trim()
  const key = raw.toLowerCase()
  if (!key) return undefined
  const cached = geoCache.get(key)
  if (cached && Date.now() - cached.cachedAt < GEO_CACHE_TTL) {
    return cached.name ? cached : undefined // 空名 = 负结果哨兵
  }
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(raw)}&count=1&language=zh&format=json`
  let body
  try {
    body = await (fetchJson
      ? (await fetchJson(url)).body
      : JSON.parse((await safeFetch(url)).body || 'null'))
  } catch {
    return undefined
  }
  const hit = body?.results?.[0]
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
    // 负结果：写一个「十分钟后就过期」的空名条目（上游同款哨兵）。
    geoCache.set(key, { lat: 0, lon: 0, name: '', cachedAt: Date.now() - GEO_CACHE_TTL + 10 * 60_000 })
    return undefined
  }
  const geo = { lat: hit.latitude, lon: hit.longitude, name: hit.name || raw, cachedAt: Date.now() }
  geoCache.set(key, geo)
  return geo
}

/**
 * 拉一份天气快照（失败一律 `undefined`，绝不抛）。
 *
 * ## 两个细节
 *
 *   - **地点解析顺序**：配了自动解析且给了地点提示时，先地理编码；
 *     **解析失败回退手动经纬度**，而不是放弃——手动坐标是回退值（配置项说明里写了）。
 *   - **缓存 TTL 取 cadence 的 90%**：若 TTL 正好等于扫描周期，首次拉取的耗时会让
 *     下一轮扫描必定命中缓存（年龄比周期小一点点），**实际刷新率减半**。
 *     留 10% 余量，保证每轮都能拉到新的。
 *
 * @param {object} args
 * @param {object} args.config 归一化后的天气配置。
 * @param {string} [args.locationHint] 故事设定里的地点。
 * @param {boolean} [args.useCache] 是否使用缓存（默认 true；测试可关）。
 * @param {(url: string) => Promise<{status: number, body: any}>} [args.fetchJson]
 *   注入的 JSON 抓取（测试用）。
 * @returns {Promise<object|undefined>} `{ temperature, feelsLike, humidity, windSpeed, condition, fetchedAt, text }`
 */
export async function fetchWeatherSnapshot({ config, locationHint, useCache = true, fetchJson } = {}) {
  const cfg = config ?? DEFAULT_WEATHER_CONFIG
  let lat = cfg.latitude
  let lon = cfg.longitude
  let cacheKey = `manual:${lat},${lon}`

  if (cfg.autoFromLocation && String(locationHint ?? '').trim()) {
    const geo = await geocodeCity(locationHint, { fetchJson })
    if (geo) {
      lat = geo.lat
      lon = geo.lon
      cacheKey = `auto:${geo.name}`
    }
    // 解析不到 → 用手动经纬度（上面那个 cacheKey 就是 manual）。
  }

  if (useCache) {
    const cached = snapshotCache.get(cacheKey)
    const ttl = cfg.cadenceMinutes * 60_000 * 0.9
    if (cached && Date.now() - cached.cachedAt < ttl) return cached.snapshot
  }

  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&timezone=auto'
  let body
  try {
    body = await (fetchJson
      ? (await fetchJson(url)).body
      : JSON.parse((await safeFetch(url)).body || 'null'))
  } catch {
    return undefined
  }
  const cur = body?.current
  if (!cur || typeof cur.temperature_2m !== 'number') return undefined

  const temperature = Math.round(cur.temperature_2m)
  const condition = conditionOfCode(cur.weather_code)
  const snapshot = {
    temperature,
    feelsLike: Math.round(cur.apparent_temperature ?? cur.temperature_2m),
    humidity: Math.round(cur.relative_humidity_2m ?? 0),
    windSpeed: Math.round(cur.wind_speed_10m ?? 0),
    condition,
    fetchedAt: Date.now(),
    // 注入文本：纯数据，不带观测点地名、不带任何建议句。
    text: `环境：${temperature}°C ${condition}。`,
  }
  snapshotCache.set(cacheKey, { snapshot, cachedAt: Date.now() })
  return snapshot
}

/**
 * 是不是**架空世界**（命中即跳过真实天气注入）。
 *
 * 上游把它做成「唯一权威拷贝」：天气扫描与播种器**共用同一判据**——
 * 播种器据此反过来**保留**天气切面（那些世界里模型即兴是唯一的天气来源）。
 * 两处各写一份必然漂移，所以这里也保持单一实现。
 *
 * @param {unknown} world 世界描述。
 * @param {unknown} location 地点描述。
 * @returns {boolean}
 */
export function isFantasyStory(world, location) {
  const text = String(world ?? '') + String(location ?? '')
  return /异世界|精灵|架空|幻想|另一个世界/.test(text)
}

/** 最近一次成功快照（不触发拉取）——供播种器协同判断天气是否已在生效。 */
export function lastWeatherSnapshot() {
  let latest
  for (const entry of snapshotCache.values()) {
    if (!latest || entry.snapshot.fetchedAt > latest.fetchedAt) latest = entry.snapshot
  }
  return latest
}

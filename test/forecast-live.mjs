/**
 * 只读预演：重启后，后台扫描会对真实 ~/.dsh 里的每个会话做什么决定。
 *
 * 这个预演很重要——修复「不主动回复」时如果把门槛放得太松，重启瞬间会把
 * 积压的待办一起喷出去，那比原 bug 更糟。这里逐条走一遍真实判定，
 * 但**不写任何文件、不发任何消息**。
 *
 * 运行：node test/forecast-live.mjs
 */
import { loadState, listStoredStates, dueIntents } from '../lib/state.js'
import { listDiscoveredBindings, clearImBindingCache } from '../lib/im-binding.js'
import { Config } from '../lib/schema.js'
import { inRestWindow, calendarDayKey } from '../lib/clock.js'

const STALE_INTENT_MS = 6 * 3600 * 1000
const MINUTE = 60 * 1000

const cfg = Config({ timeZone: 'Asia/Shanghai' })
const zone = cfg.timeZone
const now = Date.now()
const restWindows = cfg.runtime?.restWindows ?? []
const resting = inRestWindow(now, zone, restWindows)
const today = calendarDayKey(new Date(now), zone)

clearImBindingCache()
const bindings = new Map(listDiscoveredBindings({ ttlMs: 0 }).map(b => [b.sessionId, b]))

/** 复刻 lib/index.js 里 isRoleplayState 的判定（冷会话路径）。 */
function isRoleplayState(state) {
  if (cfg.runtime?.roleplayOnly === false) return true
  if (state?.roleplay === true) return true
  return state?.canonInjected === true
    || (Array.isArray(state?.intents) && state.intents.length > 0)
    || Number.isFinite(state?.lastUserAt)
}

const fmt = t => new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)

console.log(`现在 ${fmt(now)}（本地）  休息时段=${resting ? '是' : '否'}  时区=${zone}`)
console.log(`自动发现到 ${bindings.size} 个已开启会话同步的目标\n`)

const stored = listStoredStates()
let willFire = 0
const skipped = []

for (const { key, state } of stored) {
  // foldFromLog 不参与：冷会话只读磁盘。
  if (!isRoleplayState(state)) { skipped.push([key, '非角色会话']); continue }
  const binding = bindings.get(key)
  const pending = dueIntents(state, now)
    .filter(i => now - i.dueAt >= (cfg.proactive?.graceMinutes ?? 1) * MINUTE)
  const fresh = pending.filter(i => i.dueAt >= now - STALE_INTENT_MS)
  const stale = pending.filter(i => i.dueAt < now - STALE_INTENT_MS)

  if (pending.length === 0) { skipped.push([key, '无到期待办']); continue }
  if (fresh.length === 0) { skipped.push([key, `待办均已过期(${stale.length} 条)`]); continue }
  // 冷会话必须能投递才会被唤醒（纯 Web 会话留着，等下次打开时在幕间块里看到）。
  if (!binding) { skipped.push([key, `有 ${fresh.length} 条到期但无 IM 目标 → 不唤醒`]); continue }

  const target = fresh[0]
  const promised = ['promise', 'reminder', 'contact', 'reply'].includes(target.kind)
  if (resting && cfg.proactive?.duringSleep !== true && !(promised && cfg.proactive?.duringSleepPromises !== false)) {
    skipped.push([key, '休息时段让路']); continue
  }
  if ((state.reachedOut ?? 0) >= (cfg.proactive?.maxPerDay ?? 6)) { skipped.push([key, '已达当日上限']); continue }

  willFire += 1
  console.log(`🔔 会主动开口：${key}`)
  console.log(`   绑定 ${binding.botId} / ${binding.targetId}（${binding.channel}）  今日已主动 ${state.reachedOut ?? 0}/${cfg.proactive?.maxPerDay ?? 6}`)
  for (const i of fresh) {
    const late = Math.round((now - i.dueAt) / MINUTE)
    console.log(`   - (${i.id}) ${i.kind}「${i.summary}」到点 ${fmt(i.dueAt)}（已过 ${late} 分钟）${i === target ? '' : ' → 并入同一次开口'}`)
  }
  if (stale.length) console.log(`   （另有 ${stale.length} 条超过 6 小时，标 expired 不补发）`)
  console.log('')
}

console.log(`合计：${willFire} 个会话会在重启后主动开口，${skipped.length} 个被跳过`)
// 只列出「本来有到期的事、但这次不会开口」的——那才是需要人看一眼的。
const interesting = skipped.filter(([, why]) => why.startsWith('有 ') || why.includes('让路') || why.includes('上限'))
if (interesting.length) {
  console.log('\n其中「本来有到期的事但这次不开口」的：')
  for (const [key, why] of interesting) console.log(`   ${key.slice(0, 24)}…  ${why}`)
}

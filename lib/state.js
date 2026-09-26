/**
 * 幕间状态 —— DSH 侧对 hds-interlude 13 张数据表的等价物。
 *
 * 设计取舍（如实记录，见 MIGRATION.md）：
 * - 原项目用 Koishi `ctx.database`（SQLite）存 13 张表；
 *   DSH 无 `ctx.database`，这里退化为「每会话一个 JSON 文档」落在 `$DSH_HOME/hds-interlude/<sessionId>.json`。
 *   一个 DSH agent = 一个 session = 一个主剧本，因此单文档足以承载 Canon/facts/overlay/intents/agency/alter/preplan。
 * - 互动时序（谁在什么时候说过话）不落盘，直接从 session 日志增量折叠 —— 对齐 DSH 的
 *   「model-visible means logged」不变式，也避免了「用户消息时间」与「已注入快照」的重复计数。
 * - 读取失败一律降级为空状态，绝不让持久化问题打断一个回合。
 *
 * @module dsh-hds-interlude/state
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAlterSystemState, normalizeAlterSystemState } from './alter.js'
import { rankFactsByRecall } from './recall.js'
import { createLedger, normalizeLedger, groundedIds as groundedLedgerIds, DEFAULT_LEDGER_LIMIT, isOwnInjectedSource } from './script-entry.js'
import { createTimelineGuard, normalizeTimelineGuard } from './timeline-guard.js'
import { normalizeUrgeState } from './urge.js'
import { normalizeDeliveries } from './delivery-ledger.js'

/** 插件在日志 source 里的署名，用于把自己的注入排除在「用户说话」之外。 */
export const PLUGIN_NAME = 'hds-interlude'

const STATE_VERSION = 1
const MAX_INTENTS = 40
const MAX_FACTS = 200
/**
 * 条目账本保留上限。
 *
 * 为什么独立于 `script-entry.js` 的默认值再声明一次：状态文件的大小是**这个模块**
 * 的职责，裁剪策略要能在这里一眼看见。数值本身沿用上游同量级（够回溯若干轮幕间）。
 */
const MAX_LEDGER_ENTRIES = DEFAULT_LEDGER_LIMIT

/** 幕间数据目录：`$DSH_HOME/hds-interlude`（默认 `~/.dsh/hds-interlude`）。 */
export function interludeHome() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'hds-interlude')
}

/** 会话 id 可能含路径分隔符，落盘前做一次白名单化。 */
function safeFileName(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default'
}

/**
 * 每会话一条串行链，供 `withStateLock` 包住「读 → 改 → 写」临界区。
 *
 * 为什么需要：后台扫描用 `Promise.all(jobs)` 跨会话并发跑
 * （`lib/index.js` 的 runSweep），`inFlight` 只挡扫描入口、不覆盖工具处理器路径。
 * 两个路径同时对**同一 key** 做读改写时，后写的会覆盖先写的
 * （典型后果：丢掉 `delivered` 标记 → 重复投递）。
 *
 * 取舍：**跟着 key 分链**，不是一把全局大锁 —— 不同 key 之间仍可并行。
 *
 * 实现取自 K0nd1us/QQ-agent `src/util.js:147-155` 的 `createSendChain`
 * （MIT © 2026 Kondius），同一模式亦见 hds-interlude `src/service.ts:509` 的
 * `databaseWriteQueue`。链上单次失败**不中断**后续任务。
 */
function createWriteChain(key) {
  let chain = Promise.resolve()
  return function enqueue(task) {
    const next = chain.then(task, task)
    chain = next.then(() => undefined, () => undefined)
    const current = chain
    current.finally(() => {
      if (chain === current) {
        writeChains.delete(key)
      }
    })
    return next
  }
}

/** key -> enqueue；懒建，避免为从没写过的会话占位。 */
const writeChains = new Map()

function chainFor(key) {
  let chain = writeChains.get(key)
  if (!chain) {
    chain = createWriteChain(key)
    writeChains.set(key, chain)
  }
  return chain
}

/**
 * 落盘失败计数。**不再静默**——但也不打断对话。
 *
 * 之所以保留「尽力而为」的语义：一次落盘失败不该让用户这一轮说不了话。
 * 之所以必须记下来：静默丢写会丢掉 `delivered` 标记，导致**重复投递**，
 * 那是个用户看得见、却查不到原因的故障。
 */
const writeFailures = new Map()

/** 供 `/interlude status` 与测试读取的落盘健康度快照。 */
export function writeHealth() {
  const total = [...writeFailures.values()].reduce((sum, n) => sum + n, 0)
  return {
    failures: total,
    byKey: Object.fromEntries(writeFailures),
  }
}

/** 仅供测试：清空计数，避免用例间互相污染。 */
export function resetWriteHealth() {
  writeFailures.clear()
}

/**
 * 真正落盘。同步 fs —— 调用方已按 key 串行，故此处无需再考虑并发。
 * @returns {{ok: true} | {ok: false, error: Error}}
 */
function writeStateSync(key, state) {
  try {
    const dir = interludeHome()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safeFileName(key)}.json`)
    const tmp = `${file}.tmp`
    // 落盘时回填归属会话：后台扫描要在没人说话的冷会话上也能知道这份状态是谁的。
    if (state && typeof state === 'object') state.sessionId = String(key)
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    writeFailures.set(key, (writeFailures.get(key) ?? 0) + 1)
    console.warn(`[hds-interlude] 状态落盘失败（key=${key}，累计 ${writeFailures.get(key)} 次）：${err.message}`)
    return { ok: false, error: err }
  }
}

/** 会话标识；取不到返回 undefined（宁可无幕间，也不跨会话串状态）。 */
export function sessionKeyOf(agent) {
  const session = agent?.session
  const id = session?.id ?? session?.header?.id ?? session?.sessionId
  if (id === undefined || id === null || String(id).trim() === '') return undefined
  return String(id)
}

/** 全新状态。 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    /** 归属的会话 id；落盘时由 saveState 盖章，用于「冷会话」扫描反查。 */
    sessionId: null,
    /** 未知或未来的顶层字段（向前兼容）。 */
    extensions: {},
    lastSeenSeq: 0,
    turns: 0,
    lastUserAt: null,
    previousUserAt: null,
    lastAssistantAt: null,
    lastInjectedAt: null,
    /** Canonical Story（首次使用时从 config.story 拷贝）。 */
    story: null,
    /** 低频连续性快照（由模型经工具维护）。 */
    continuity: '',
    continuityUpdatedAt: null,
    /** 长期事实。 */
    facts: [],
    /** 非破坏性设定演化（character/perspective/relationship/world）。 */
    overlay: [],
    /** 意图：延迟回复 / 提醒 / 主动联系 / 承诺回访 / 跟进。 */
    intents: [],
    seq: 0,
    /** 主体行动窗口 + 主动联系候选（Agency Window）。 */
    agencyWindow: null,
    proactiveDrafts: [],
    proactiveFingerprints: [],
    /** 是否被标记为「角色会话」（/interlude on）。roleplayOnly 开启时仅此类会话生效。 */
    roleplay: false,
    /** 是否已注入人设/规则段（pre-step 首次角色回合注入一次，持久于会话日志）。 */
    canonInjected: false,
    /**
     * 上次注入规则段时**是不是 IM 形态**。
     *
     * 为什么需要单独记：规则段只有一份，但它注入的内容随 `imActive` 分叉 ——
     * IM 形态会多出一整段「怎么把话说出去」（调用 interlude_say）。
     * 而绑定可能**在首轮之后**才建立（例如先聊了几天，才把 QQ 接上）。
     *
     * 线上故障（session-xxx）：规则段在 2026-09-12 首轮注入时还没有绑定，
     * 于是只有故事口径；绑定在 09-15 才建立，而 `canonInjected` 已是 true、
     * 永不重注 —— 结果是模型**从来没被告知过要调用 interlude_say**，
     * 只会看到「可能发消息」的模式行，于是把话写在正文里，一个字都发不出去。
     *
     * 记下注入时的形态，就能在「现在有绑定、但当初是按无绑定注入的」补一次。
     * null 表示尚未注入过。
     */
    canonInjectedIm: null,
    reachedOut: 0,
    reachedOutDay: '',
    lastAutoAdvanceAt: null,
    /**
     * 上一次「自动发消息」的时刻。
     *
     * 与 lastAutoAdvanceAt（上一次**写故事**）分开记：写故事与发消息现在是两个
     * 独立节奏（写故事默认 40 分钟，发消息默认 120 分钟）。合成一个字段的话，
     * 每写一次故事就会把发消息间隔一起重置——间隔永远走不到头。
     *
     * 注意：到点的提醒 / 承诺回访**不**更新这个字段，它们是角色答应过的事，
     * 不该被「刚自动发过一条」挡住。
     */
    lastAutoMessageAt: null,
    /** 情绪偏移追踪（Alter System）。 */
    alter: createAlterSystemState(),
    /** 近期日程（Schedule Preplan）。 */
    preplan: null,
    /** 小型具体进行中细节（工作记录、密码等），自然过期，最高 10 条。 */
    workingDetails: [],
    /** 场景在场人员，最高 8 条。 */
    /**
     * 本地在场名单（由 `lib/life-handoff.js` 维护）。
     *
     * 每项 `{ name, status: 'present'|'off-scene', basis, sourceEntryIds, updatedAt }`，
     * `basis` 是**逐字引文**——这是与「模型随口说屋里有谁」的唯一区别。
     */
    scenePresence: [],
    /**
     * 场景帧：从条目账本**确定性投影**出的当前场景（place/activity/attention 等）。
     *
     * 注意它**不是**模型的自由文本，而是由 `scenePresence` + `workingDetails` +
     * agencyWindow 按规则算出来的只读快照，每个字段都带 `sources` 溯源。
     */
    sceneFrame: null,
    /**
     * 对话突发：一次连续对话的边界与起止（由 `scene-frame.js` 维护）。
     *
     * 用途是「把一连串来回当成一个单元」。**边界只由结构决定**——
     * 时间流逝本身不会开新的突发（那是上游明确的设计）。
     */
    dialogueBurst: null,
    /**
     * 活跃剧情余波：仍在影响她当下选择的具体事件。
     *
     * 与「长期事实」不同：余波是**会自然过期**的（默认 7 天）。它的意义是
     * 「这件事还没被故事吸收掉」——比如昨天的争执仍在影响今天的语气。
     * 过期不是删除，而是标记为不再注入（保留可追溯）。
     */
    activeConsequences: [],
    /** 时间线承载状态，最高 4 条。 */
    timelineCarry: [],
    /**
     * 以下三项是**运行时投递/模式记录**，不是未知字段。
     *
     * 为什么必须显式登记：`loadState` 会把「不在空状态里的键」迁进 `extensions`
     * 兜底桶（向前兼容）。这把 `lastAdvanceDelivery` / `lastImDelivery` /
     * `advanceMode` 一并吞掉了 —— 它们只由 index.js 在运行期写入，从未登记过，
     * 于是**每次读盘都读不回来**，表现为「自检回执永远为空」。
     * 踩过的坑：用例断言 `lastAdvanceDelivery.mode`，盘上确实写进去了，读出来却是
     * undefined，排查费了很久。新增运行期字段时，记得同时登记到这里。
     */
    /** 最近一次自动生活推进的投递结论（供自检/提示词判断上次发没发）。 */
    lastAdvanceDelivery: null,
    /** 最近一次 IM 投递回执（成功与否、条数、原因）。 */
    lastImDelivery: null,
    /** 本轮幕间推进的模式（speak / story-only），用于拼「本轮模式」行。 */
    advanceMode: null,
    /**
     * 自动推进的退避/熔断状态（`lib/timeline-guard.js`）。
     *
     * 为什么必须落盘：它是**跨扫描**的状态。只放内存的话，DSH 一重启，
     * 一个持续失败的会话又会从头开始烧 token。
     */
    timelineGuard: createTimelineGuard(),
    /** 上一次因熔断/退避跳过时记的原因，避免每轮刷屏（只在状态切换时说一次）。 */
    timelineGuardWarned: null,
    /**
     * 剧本条目账本（`lib/script-entry.js`）。
     *
     * 这是 Phase 2/3 的共同地基：scene-frame 的在场投影、knowledge-evidence 的
     * 逐字校验、life-handoff 的场景转换、development 的跨场景门控，全都要靠
     * 「带单调 id 的条目」才能说清「这条结论是从哪段原文来的」。
     *
     * **它不是日志派生物**：会话日志会被压缩/重置，而 `sourceEntryIds` 一旦
     * 悬空，溯源就变成谎言。所以账本独立落盘，并在日志回退时原样保留
     * （见 `foldFromLog`）。细节与理由见 `script-entry.js` 的模块注释。
     */
    ledger: createLedger(),
    /**
     * Urge 弹性推进状态（`lib/urge.js`）——推进节奏跟随消息热度。
     *
     * 默认空（`{version: 1, buckets: []}`）。开启 `cfg.urge.enabled` 后才写入；
     * 关闭/从未启用时保持空对象即可（所有读取都走 normalizeUrgeState 防御）。
     */
    urge: { version: 1, buckets: [] },
    /**
     * 时间导演账本（`lib/timeline-director.js`）——最近一次自动推进的事件账本。
     *
     * 只在 `cfg.timelineDirector.enabled` 时产生；与 `timelineCarry` 的区别：
     * `timelineCarry` 是**模型认可的**时间线承载，账本是**宿主解析出的**权威
     * 时间线（投影进下一轮提示）。解析失败时不落盘。
     */
    timelinePlan: null,
    /**
     * 投递账本（`lib/delivery-ledger.js`）——最近 N 次投递动作的分段状态。
     *
     * 每次投递（主动/交互式）后追加一条，段状态回写 delivered/partial/failed/
     * cancelled；`delivered` 是终态。上限 DEFAULT_DELIVERY_LIMIT（40 条）。
     */
    deliveries: [],
  }
}

/** 读取状态；任何异常降级为空状态，并用 Alter 规范化器修复字段。 */
export function loadState(key) {
  try {
    const file = path.join(interludeHome(), `${safeFileName(key)}.json`)
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== STATE_VERSION) return emptyState()
    const base = emptyState()
    const state = { ...base }
    
    // 未知字段：**保留在顶层**，同时镜像进 `extensions` 兜底桶。
    //
    // 为什么要保留顶层：早先的实现是 `{...base, ...parsed}`，未知键原样透传；
    // 改成「只进 extensions」之后，任何**没登记进 emptyState 的运行期字段**
    // 都会在每次读盘时无声消失。踩过的坑：`lastAdvanceDelivery` /
    // `lastImDelivery` / `advanceMode` 只由 index.js 在运行期写，漏登记后被
    // 吞掉，表现为「盘上有、读出来是 undefined」，排查了很久。
    // 现在两头都写：既有 extensions 的向前兼容，也不丢顶层语义。
    for (const [k, v] of Object.entries(parsed)) {
      if (k in base) {
        state[k] = v
      } else {
        state.extensions[k] = v
        state[k] = v
      }
    }

    state.alter = normalizeAlterSystemState(parsed.alter) ?? base.alter

    // 退避/熔断状态：坏值降级成「无失败」（宁可多重试一次，也不要凭坏数据
    // 把一个健康会话永久熔断）。
    state.timelineGuard = normalizeTimelineGuard(parsed.timelineGuard)

    // 条目账本：损坏一律降级成空账本（不抛错），并按上限裁剪。
    // 注意 `normalizeLedger` 会保住 `nextId`，**绝不让发号器回退**——
    // 否则裁剪之后新条目会撞上仍被 sourceEntryIds 引用着的旧 id。
    state.ledger = normalizeLedger(parsed.ledger, MAX_LEDGER_ENTRIES)
    
    // String length limits & Arrays
    state.facts = Array.isArray(parsed.facts) ? parsed.facts.map(f => ({
      ...f,
      content: typeof f.content === 'string' ? f.content.slice(0, 4000) : String(f.content || '').slice(0, 4000)
    })) : []
    
    state.overlay = Array.isArray(parsed.overlay) ? parsed.overlay.map(o => ({
      ...o,
      content: typeof o.content === 'string' ? o.content.slice(0, 1000) : String(o.content || '').slice(0, 1000)
    })) : []
    
    state.intents = Array.isArray(parsed.intents) ? parsed.intents : []
    state.proactiveDrafts = Array.isArray(parsed.proactiveDrafts) ? parsed.proactiveDrafts : []
    state.proactiveFingerprints = Array.isArray(parsed.proactiveFingerprints) ? parsed.proactiveFingerprints : []

    // Array length hard limits
    state.workingDetails = Array.isArray(parsed.workingDetails) 
      ? parsed.workingDetails.map(wd => ({
          ...wd,
          label: typeof wd.label === 'string' ? wd.label.slice(0, 80) : String(wd.label || '').slice(0, 80),
          value: typeof wd.value === 'string' ? wd.value.slice(0, 300) : String(wd.value || '').slice(0, 300)
        })).slice(-10) 
      : []

    // 在场名单：逐项规范化（老文件里可能只有 name）。
    // 未知 status 一律当 'off-scene' 更安全——宁可少报「在场」，也不要凭空多一个人。
    state.scenePresence = Array.isArray(parsed.scenePresence)
      ? parsed.scenePresence
        .filter(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim())
        .map(item => ({
          name: item.name.trim().slice(0, 128),
          status: item.status === 'present' ? 'present' : 'off-scene',
          basis: typeof item.basis === 'string' ? item.basis.slice(0, 500) : '',
          sourceEntryIds: Array.isArray(item.sourceEntryIds)
            ? groundedLedgerIds(state.ledger, item.sourceEntryIds)
            : [],
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
        }))
        .slice(-8)
      : []

    // 场景帧：坏值直接丢掉（它会由投影重新算出来，不需要从盘上抢救）。
    state.sceneFrame = normalizeSceneFrame(parsed.sceneFrame)

    // 对话突发：结构简单，坏值丢掉即可（下一轮会重新解析）。
    state.dialogueBurst = parsed.dialogueBurst && typeof parsed.dialogueBurst === 'object'
      && typeof parsed.dialogueBurst.id === 'string' && typeof parsed.dialogueBurst.startedAt === 'string'
      ? {
        id: parsed.dialogueBurst.id,
        frameId: typeof parsed.dialogueBurst.frameId === 'string' ? parsed.dialogueBurst.frameId : '',
        startedAt: parsed.dialogueBurst.startedAt,
        sourceEntryIds: Array.isArray(parsed.dialogueBurst.sourceEntryIds)
          ? groundedLedgerIds(state.ledger, parsed.dialogueBurst.sourceEntryIds) : [],
        ...(typeof parsed.dialogueBurst.scopeKey === 'string' ? { scopeKey: parsed.dialogueBurst.scopeKey } : {}),
        ...(Array.isArray(parsed.dialogueBurst.topicKeys)
          ? { topicKeys: parsed.dialogueBurst.topicKeys.filter(k => typeof k === 'string').slice(-12) } : {}),
      }
      : null

    // 活跃剧情余波：保留仍有效的，丢掉缺字段的。
    // **过期不是删除**——标记为过期后仍留在数组里（可追溯），只是不再注入。
    state.activeConsequences = Array.isArray(parsed.activeConsequences)
      ? parsed.activeConsequences
        .filter(item => item && typeof item === 'object'
          && typeof item.id === 'string' && item.id
          && typeof item.content === 'string' && item.content.trim())
        .map(item => ({
          id: item.id,
          content: item.content.trim().slice(0, 600),
          status: item.status === 'expired' || item.status === 'resolved' ? item.status : 'active',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
          expiresAt: typeof item.expiresAt === 'string' ? item.expiresAt : null,
          sourceEntryIds: Array.isArray(item.sourceEntryIds)
            ? groundedLedgerIds(state.ledger, item.sourceEntryIds) : [],
        }))
        .slice(-12)
      : []

    state.timelineCarry = Array.isArray(parsed.timelineCarry) 
      ? parsed.timelineCarry.filter(item => typeof item === 'string')
          .map(item => item.slice(0, 240))
          .slice(-4) 
      : []

    // Urge 状态：防御读取（坏值降级为空，不抛错）。
    state.urge = normalizeUrgeState(parsed.urge, Date.now())

    // 时间导演账本：只接受宿主解析出的形状（带 beats 数组）。
    state.timelinePlan = parsed.timelinePlan && typeof parsed.timelinePlan === 'object'
      && Array.isArray(parsed.timelinePlan.beats)
      ? parsed.timelinePlan
      : null

    // 投递账本：防御读取（损坏项丢弃、限量）。
    state.deliveries = normalizeDeliveries(parsed.deliveries)

    // Defensive numerics
    const safeInt = (val) => Number.isSafeInteger(val) ? val : null
    const finiteNum = (val) => Number.isFinite(val) ? val : null
    
    state.lastSeenSeq = safeInt(parsed.lastSeenSeq) ?? 0
    state.turns = safeInt(parsed.turns) ?? 0
    state.seq = safeInt(parsed.seq) ?? 0
    state.reachedOut = safeInt(parsed.reachedOut) ?? 0
    
    state.lastUserAt = finiteNum(parsed.lastUserAt) ?? null
    state.previousUserAt = finiteNum(parsed.previousUserAt) ?? null
    state.lastAssistantAt = finiteNum(parsed.lastAssistantAt) ?? null
    state.lastInjectedAt = finiteNum(parsed.lastInjectedAt) ?? null
    state.continuityUpdatedAt = finiteNum(parsed.continuityUpdatedAt) ?? null
    state.lastAutoAdvanceAt = finiteNum(parsed.lastAutoAdvanceAt) ?? null
    state.lastAutoMessageAt = finiteNum(parsed.lastAutoMessageAt) ?? null

    return state
  } catch {
    return emptyState()
  }
}

/**
 * 原子落盘 —— 失败**不再静默**，但仍不打断对话。
 *
 * ## 为什么是「同步写 + 每 key 顺序保证」而不是「异步队列」
 *
 * 第一版改成了 async 队列（Promise 链），结果打红了 3 个既有用例：
 * 它们 `saveState(k, s)` 之后**同一 tick 内**就 `loadState(k)` / `listStoredStates()`
 * 去读。这不是测试写得不好 —— 「写完立刻能读到」是调用方可以合理依赖的语义，
 * 悄悄把它变成异步会埋下时序陷阱。
 *
 * 所以这里保留**同步写入**（行为与改动前一致、调用点零改动），
 * 同时用**重入保护**消除原先真正的并发风险：
 *
 * - `writeStateSync` 内部只做「写 tmp → rename」，中间不 await，
 *   所以单次写入本身是原子的，**不会自我交错**；
 * - 真正的风险是**同一 key 的读-改-写序列**（读状态 → 改 → 写回）被并发执行，
 *   后者覆盖前者。这一点由调用方的 `inFlight`/`serial` 负责，
 *   本模块提供 `withStateLock` 供需要时包住整个读-改-写。
 *
 * ## 失败语义
 *
 * 失败**不再静默**：打 warn 日志 + 计入 `writeHealth()`。
 * 但仍**不抛错** —— 一次落盘失败不该让用户这一轮说不了话。
 *
 * @returns {{ok: boolean, error?: Error}} 本次写入结果。
 */
export function saveState(key, state) {
  return writeStateSync(key, state)
}

/**
 * 包住一段「读 → 改 → 写」的临界区，保证同一 key 不并发交叠。
 *
 * 用例：后台扫描的 `Promise.all` 会跨会话并发跑，若两个路径同时对同一 key
 * 做读改写，后写的会覆盖先写的（典型丢 `delivered` 标记 → 重复投递）。
 *
 * 实现是**每 key 一条 Promise 链**（链上单次失败不中断后续），
 * 取自 K0nd1us/QQ-agent `src/util.js:147-155` 的 `createSendChain`（MIT）；
 * 同模式亦见 hds-interlude `src/service.ts:509` 的 `databaseWriteQueue`。
 *
 * 注意：这是**协作式**的 —— 只有把整个读-改-写放进 `fn` 里才有效。
 * 单次 `saveState` 不需要它（本身就是同步原子的）。
 *
 * @template T
 * @param {string} key 会话 key
 * @param {() => T | Promise<T>} fn 临界区
 * @returns {Promise<T>}
 */
export function withStateLock(key, fn) {
  return chainFor(key)(fn)
}

/**
 * 列出磁盘上所有会话状态（含冷会话）。
 *
 * 为什么需要：后台扫描原先只遍历 `liveAgents`——而「用户没在说话」恰恰意味着
 * 那个会话没有实时 agent，于是「到点主动开口」永远轮不到它。扫描必须能看见
 * 落盘的状态文件，才能在需要时把它唤醒。
 *
 * 会话 id 优先取状态里盖的章；**旧文件没有章**（本次改动之前写的），此时回退到
 * 文件名——`safeFileName` 只对 `[A-Za-z0-9._-]` 之外的字白名单化，而 DSH 的会话 id
 * 形如 `session-<uuid>`，完全落在这个字符集内，所以文件名就等于会话 id。
 * 回退路径是必须的：否则升级后的第一次扫描看不见任何历史会话，
 * 「到点提醒」要等用户下次主动说话才活过来——而那正是我们要修的场景。
 *
 * 两条路径都拿不到就跳过：宁可不开口，也不猜错人。
 *
 * @returns {Array<{key: string, state: object}>}
 */
export function listStoredStates() {
  const out = []
  let files = []
  try {
    files = fs.readdirSync(interludeHome())
  } catch {
    return out
  }
  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith('.tmp.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(interludeHome(), file), 'utf8'))
      if (!parsed || parsed.version !== STATE_VERSION) continue
      const stamped = typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null
      // 文件名回退：只接受形状像会话 id 的（避免把 `default` 之类的兜底名当成会话）。
      const stem = file.slice(0, -'.json'.length)
      const fromFile = /^session-[A-Za-z0-9._-]+$/.test(stem) ? stem : null
      const key = stamped ?? fromFile
      if (!key) continue
      if (!stamped) parsed.sessionId = key
      out.push({ key, state: parsed })
    } catch {
      /* 单份状态坏掉不该拖垮扫描 */
    }
  }
  return out
}

/** 折叠一条已提交的会话事件进状态。 */
export function applyEvent(state, event) {
  const type = event?.type
  const time = Number(event?.time)
  if (type === 'user/message') {
    const source = event?.data?.source
    // 本插件注入的 followup 不是「用户说话」：更新 lastUserAt 会让幕间作息算错。
    // 判据见 isOwnInjectedSource（同时认 kind=插件名 与旧的 kind='plugin'）。
    if (isOwnInjectedSource(source)) return
    if (Number.isFinite(time)) {
      state.previousUserAt = state.lastUserAt
      state.lastUserAt = time
    }
    return
  }
  if (type === 'assistant/message') {
    if (Number.isFinite(time)) state.lastAssistantAt = time
    return
  }
  if (type === 'turn/end') {
    state.turns = (state.turns ?? 0) + 1
  }
}

/** 把日志推进到最新（就地折叠，返回同一份 state 引用）。 */
export function foldFromLog(agent, state) {
  const session = agent?.session
  const total = Number(session?.seq)
  if (!Number.isFinite(total) || typeof session?.eventAt !== 'function') return state

  let cursor = Number.isFinite(state.lastSeenSeq) ? state.lastSeenSeq : 0
  if (cursor > total) {
    // 日志回退（会话日志被压缩/重置）：只重置「可从日志重新折叠」的字段——
    // 互动时序（turns / lastUserAt / lastAssistantAt 等）由 applyEvent 从 0 重放。
    // 其余（意图/事实/演化/角色标记/推进水位/承诺指纹）都不是日志派生的，
    // 必须原样保留——否则一次日志回退就会丢掉角色身份与配额状态。
    const rebuilt = emptyState()
    Object.assign(state, rebuilt, {
      seq: state.seq,
      sessionId: state.sessionId,
      intents: state.intents,
      facts: state.facts,
      overlay: state.overlay,
      alter: state.alter,
      agencyWindow: state.agencyWindow,
      preplan: state.preplan,
      proactiveDrafts: state.proactiveDrafts,
      proactiveFingerprints: state.proactiveFingerprints,
      commitmentFingerprints: state.commitmentFingerprints,
      story: state.story,
      continuity: state.continuity,
      continuityUpdatedAt: state.continuityUpdatedAt,
      roleplay: state.roleplay,
      canonInjected: state.canonInjected,
      canonInjectedIm: state.canonInjectedIm,
      reachedOut: state.reachedOut,
      reachedOutDay: state.reachedOutDay,
      lastAutoAdvanceAt: state.lastAutoAdvanceAt,
      lastAutoMessageAt: state.lastAutoMessageAt,
      lastInjectedAt: state.lastInjectedAt,
      extensions: state.extensions,
      workingDetails: state.workingDetails,
      scenePresence: state.scenePresence,
      timelineCarry: state.timelineCarry,
      // 条目账本必须一起保留。
      //
      // 它**不是**日志派生物：`sourceEntryIds` 一旦因为日志回退而悬空，
      // 所有溯源（谁说了什么、她在哪、跨了几个场景）都会变成谎言。
      // 这与 intents/facts 是同一条理由——非日志派生的字段不能跟着重置。
      ledger: state.ledger,
      // 退避/熔断状态同样不是日志派生的：日志回退不该让一个持续失败的会话
      // 把失败计数清零、重新开始烧 token。
      timelineGuard: state.timelineGuard,
      timelineGuardWarned: state.timelineGuardWarned,
    })
    cursor = 0
  }
  for (let index = cursor; index < total; index += 1) {
    const event = session.eventAt(index)
    if (event) applyEvent(state, event)
  }
  state.lastSeenSeq = total
  return state
}

/* ------------------------------------------------------------------ 意图 */

export function addIntent(state, draft, now) {
  state.seq = (state.seq ?? 0) + 1
  const intent = {
    id: `i${state.seq}`,
    kind: draft.kind || 'followup',
    summary: draft.summary,
    dueAt: draft.dueAt,
    createdAt: now,
    status: 'pending',
  }
  state.intents.push(intent)
  if (state.intents.length > MAX_INTENTS) {
    const pending = state.intents.filter(item => item.status === 'pending')
    const settled = state.intents.filter(item => item.status !== 'pending').slice(-5)
    const merged = [...settled, ...pending]
    if (merged.length > MAX_INTENTS) {
      console.warn(`intents 超限 (${merged.length}>${MAX_INTENTS})，最老的待办将被截断`)
    }
    state.intents = merged.slice(-MAX_INTENTS)
  }
  return intent
}

export function dueIntents(state, now) {
  return (state.intents ?? [])
    .filter(item => item.status === 'pending' && Number.isFinite(item.dueAt) && item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
}

export function settleIntent(state, id, status = 'done') {
  const intent = (state.intents ?? []).find(item => item.id === id)
  if (!intent) return undefined
  intent.status = status
  intent.settledAt = Date.now()
  return intent
}

/* ------------------------------------------------------------ 长期事实 */

export function addFact(state, { scope, content, importance = 0.5, confidence = 0.5, knowledge }, now) {
  state.seq = (state.seq ?? 0) + 1
  const safeContent = typeof content === 'string' ? content.slice(0, 4000) : String(content || '').slice(0, 4000)
  const fact = {
    id: `f${state.seq}`,
    scope: scope || 'general',
    content: safeContent,
    status: 'active',
    importance: clamp(importance, 0, 1),
    confidence: clamp(confidence, 0, 1),
    createdAt: now,
    updatedAt: now,
    // 「上次被提到」的时间。排序里的时间衰减用它，而不是 createdAt——
    // 一条三个月前写下、但昨天又被说起的事，仍然是新鲜的。
    lastSeenAt: now,
  }
  // 认知证据：这条事实是**她的解读**还是**双方确认**。
  //
  // 为什么必须存下来：不存的话，下游只能看到一句「她答应了周末来」，
  // 无法区分那是对方真的答应了，还是她一厢情愿。而这个区别决定了
  // 下一轮她该继续等、还是该再问一次。
  if (knowledge && typeof knowledge === 'object') {
    fact.knowledge = knowledge
  }
  state.facts.push(fact)
  if (state.facts.length > MAX_FACTS) state.facts = state.facts.slice(-MAX_FACTS)
  return fact
}

/**
 * 长期事实的**排序**（不是简单取前 N 条）。
 *
 * 移植自参考项目 `service.ts:6687` 的 `factScore`：
 *
 * ```
 * score = importance×0.5 + confidence×0.35 + recency×0.15
 *       + semantic×0.55 + unresolved(promise)×0.2
 * recency = exp(-ageDays / 30)
 * ```
 *
 * 我们原先的「检索」是 `state.facts.filter(...).slice(0, memoryLimit)`——
 * **按插入顺序取前 N 条**。`importance` 字段一直在写，但**从不参与选择**；
 * 于是「三天前随口说的小事」会挤掉「上周那条要紧的承诺」。
 *
 * 这里实现前四项（纯计算）。`semantic` 项需要 embedding，DSH 侧不具备，
 * 因此**不加权**而不是给 0 分——否则每条事实都会被均等地压低，
 * 排序结果与不加这一项完全一样，只是白白多了个误导性的权重。
 *
 * @param {object} state 会话状态。
 * @param {number} [limit] 取前几条。
 * @param {number} [now] 当前时刻（注入以便测试）。
 * @param {object} [options]
 * @param {string} [options.query] 当前这句话（或 {@link recallFocus} 拼出的查询串）。
 *   给了就在排序里加入**词法相关度**（见 `lib/recall.js`）：只靠「重要度 + 新旧」
 *   的排序对「用户刚刚提到的那件事」完全无感，一条三个月前的高重要度事实会永远
 *   压过昨天刚聊到的细节。不给则维持原行为，排序完全不变。
 * @returns {Array<object>} 按得分降序的事实（只含 active）。
 */
export function rankFacts(state, limit = 20, now = Date.now(), options = {}) {
  const active = (state?.facts ?? []).filter(fact => fact.status === 'active')
  const scored = active.map(fact => {
    const seen = Number.isFinite(fact.lastSeenAt) ? fact.lastSeenAt
      : Number.isFinite(fact.updatedAt) ? fact.updatedAt
        : Number.isFinite(fact.createdAt) ? fact.createdAt : now
    const ageDays = Math.max(0, (now - seen) / 86_400_000)
    const recency = Math.exp(-ageDays / 30)
    // 未兑现的承诺多给一点权重——那是「还欠着的事」，最不该被挤掉。
    const unresolved = fact.scope === 'promise' && fact.status === 'active' ? 1 : 0
    const score = clamp(fact.importance ?? 0.5, 0, 1) * 0.5
      + clamp(fact.confidence ?? 0.5, 0, 1) * 0.35
      + recency * 0.15
      + unresolved * 0.2
    return { fact, score }
  })
  scored.sort((left, right) => right.score - left.score
    || (right.fact.updatedAt ?? 0) - (left.fact.updatedAt ?? 0))
  const top = scored.slice(0, Math.max(1, limit)).map(item => item.fact)
  const query = typeof options?.query === 'string' ? options.query.trim() : ''
  // 召回只在**真的给了查询**时介入；排序把它当「保底 + 证据」处理（见 recall.js）。
  if (!query) return top
  return rankFactsByRecall(top, query)
}

export function closeFact(state, id, status = 'resolved') {
  const fact = (state.facts ?? []).find(item => item.id === id)
  if (!fact) return undefined
  fact.status = status
  fact.updatedAt = Date.now()
  return fact
}

/* ------------------------------------------------------- 设定演化（Overlay） */

export function upsertOverlay(state, { layer, content }, now) {
  if (!['character', 'perspective', 'relationship', 'world'].includes(layer)) return undefined
  const existing = (state.overlay ?? []).find(item => item.layer === layer)
  const safeContent = typeof content === 'string' ? content.slice(0, 1000) : String(content || '').slice(0, 1000)
  const entry = {
    id: existing?.id ?? `o${(state.seq = (state.seq ?? 0) + 1)}`,
    layer,
    content: safeContent,
    evidence: (existing?.evidence ?? 0) + 1,
    appliedAt: now,
  }
  state.overlay = [...(state.overlay ?? []).filter(item => item.layer !== layer), entry]
  return entry
}

export function clearOverlay(state, layer) {
  if (layer === 'all') {
    state.overlay = []
    return true
  }
  if (!['character', 'perspective', 'relationship', 'world'].includes(layer)) return false
  state.overlay = (state.overlay ?? []).filter(item => item.layer !== layer)
  return true
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * 场景帧的读盘规范化。
 *
 * 规矩与别处一致：**坏值直接丢掉**，而不是从盘上抢救一个半残的帧——
 * 它本来就会被投影重新算出来，抢救反而可能留下一个字段自相矛盾的快照。
 *
 * 关键的一步是 `sources`：**没有溯源的字段会被丢弃**。
 * 这是上游的 `sceneFrameProvenanceErrors` 精神——帧里每个非空字段都必须能
 * 说出「我是从哪条原文来的」，否则它不该出现在给模型的上下文里。
 *
 * @param {unknown} value 盘上的 sceneFrame。
 * @returns {object|null}
 */
function normalizeSceneFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value
  const sources = raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources) ? raw.sources : {}
  const frame = {
    id: typeof raw.id === 'string' ? raw.id : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    sourceEntryIds: Array.isArray(raw.sourceEntryIds) ? raw.sourceEntryIds.filter(n => Number.isSafeInteger(n) && n > 0) : [],
    sources: {},
  }
  // 单值字段：有值**且**有溯源才保留。
  for (const field of ['place', 'ongoingActivity', 'attention', 'deviceAccess', 'privacy']) {
    const val = typeof raw[field] === 'string' ? raw[field].trim() : ''
    const ids = Array.isArray(sources[field]) ? sources[field].filter(n => Number.isSafeInteger(n) && n > 0) : []
    if (val && ids.length) {
      frame[field] = val.slice(0, 300)
      frame.sources[field] = ids
    }
  }
  // 数组字段同理。
  for (const field of ['presentPeople', 'openMotions', 'openTopics']) {
    const list = Array.isArray(raw[field]) ? raw[field].filter(x => typeof x === 'string' && x.trim()) : []
    const ids = Array.isArray(sources[field]) ? sources[field].filter(n => Number.isSafeInteger(n) && n > 0) : []
    if (list.length && ids.length) {
      frame[field] = list.map(x => x.slice(0, 300))
      frame.sources[field] = ids
    }
  }
  return frame
}


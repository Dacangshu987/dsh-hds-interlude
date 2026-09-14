/**
 * dsh-hds-interlude —— 浏览器半侧设置页（dsh-tavern 风格）
 *
 * 在设置页注册一整个「幕间系统」页面（settings.section 槽），页面内容用
 * `fetch('/api/hds-interlude/settings')` 读写宿主端 HTTP 路由（与 dsh-tavern 的
 * `/api/tavern/*` 同款机制），**不依赖 settingsScope**。
 *
 * - GET  /api/hds-interlude/settings  读取当前配置
 * - POST /api/hds-interlude/settings  写入增量补丁（宿主端 settingsScope.update 深合并）
 *
 * 加载方式：DSH 客户端加载器发现 `dsh.client.platform: web` 后按 `./client` 导出取到本文件，
 * 本文件调用全局 `window.__ModuleLoader__.load({ id, factory })` 注册插件。
 * factory 内部用加载器注入的 `require(...)` 取依赖（react / react/jsx-runtime）。
 * @module dsh-hds-interlude/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-hds-interlude',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var jsx = react.createElement

    /** 故事字段定义：分组 + 点路径 + 多行/单行 + 提示。 */
    var FIELDS = [
      { path: 'character.name', label: '主角名称', group: '人设', multiline: false, hint: '主角的称呼。' },
      { path: 'character.profile', label: '身份设定', group: '人设', multiline: true, hint: '身份、性格、作息、习惯、压力、行为边界。' },
      { path: 'character.speech', label: '说话风格', group: '人设', multiline: true, hint: '说话风格与口头习惯。' },
      { path: 'perspective', label: '价值观（外壳人格层）', group: '价值观', multiline: true, hint: '看待世界的方式，随剧情漂移，不改写人设。' },
      { path: 'world.setting', label: '世界设定', group: '世界观', multiline: true, hint: '时间、地点、社会与现实规则。' },
      { path: 'world.location', label: '主要地点', group: '世界观', multiline: false, hint: '主角主要活动地点。' },
      { path: 'world.supportingCast', label: '重要配角', group: '世界观', multiline: true, hint: '重要配角及其与主角的关系。' },
      { path: 'counterpart.profile', label: '对手背景', group: '对手戏', multiline: true, hint: '对话者的默认背景。' },
      { path: 'counterpart.initial', label: '初始关系', group: '对手戏', multiline: false, hint: '新参与者与主角的默认初始关系。' },
      { path: 'plot.startingPoint', label: '剧情起点', group: '剧情', multiline: true, hint: '你们现在是什么关系。' },
      { path: 'plot.style', label: '文风', group: '剧情', multiline: true, hint: '当前故事文风。' },
      { path: 'plot.boundaries', label: '禁则与边界', group: '剧情', multiline: true, hint: '禁则与边界。' },
    ]

    var GROUPS = ['人设', '价值观', '世界观', '对手戏', '剧情']

    var S = {
      card: { padding: '2px 0' },
      section: { marginBottom: 18 },
      heading: { fontSize: 13, fontWeight: 600, opacity: 0.85, margin: '0 0 10px', borderBottom: '1px solid rgba(127,127,127,0.2)', paddingBottom: 5 },
      field: { marginBottom: 12 },
      label: { display: 'block', fontSize: 12, opacity: 0.82, marginBottom: 4 },
      hint: { fontSize: 11, opacity: 0.5, margin: '3px 0 0' },
      row: { display: 'flex', gap: 14, flexWrap: 'wrap' },
      cell: { flex: '1 1 180px', marginBottom: 12 },
      input: { width: '100%', boxSizing: 'border-box', background: 'rgba(127,127,127,0.08)', color: 'inherit', border: '1px solid rgba(127,127,127,0.25)', borderRadius: 6, padding: '6px 8px', font: 'inherit', fontSize: 13 },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: 88, resize: 'vertical', background: 'rgba(127,127,127,0.08)', color: 'inherit', border: '1px solid rgba(127,127,127,0.25)', borderRadius: 6, padding: '6px 8px', font: 'inherit', fontSize: 13, lineHeight: 1.5 },
      toggle: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 },
      check: { width: 15, height: 15, accentColor: '#5f9be8' },
      toggleLabel: { fontSize: 13 },
      bar: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 },
      button: { background: 'rgba(127,127,127,0.16)', color: 'inherit', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, padding: '6px 16px', font: 'inherit', fontSize: 13, cursor: 'pointer' },
      status: { fontSize: 12, opacity: 0.7 },
      ok: { color: '#5fbf7f' },
      err: { color: '#e88888' },
      // 只读运行状态视图专用样式
      panel: { border: '1px solid rgba(127,127,127,0.22)', borderRadius: 8, padding: '10px 12px', marginBottom: 18, background: 'rgba(127,127,127,0.05)' },
      panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
      panelTitle: { fontSize: 13, fontWeight: 600, opacity: 0.85 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 },
      stat: { border: '1px solid rgba(127,127,127,0.16)', borderRadius: 6, padding: '7px 9px' },
      statNum: { fontSize: 17, fontWeight: 600, lineHeight: 1.2 },
      statLabel: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
      chipOn: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(95,191,127,0.16)', color: '#5fbf7f', border: '1px solid rgba(95,191,127,0.35)' },
      chipOff: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(127,127,127,0.12)', color: 'inherit', opacity: 0.55, border: '1px solid rgba(127,127,127,0.25)' },
      kv: { fontSize: 12, display: 'flex', gap: 8, padding: '3px 0', borderTop: '1px solid rgba(127,127,127,0.12)' },
      kvKey: { opacity: 0.6, flex: '0 0 auto', minWidth: 84 },
      kvVal: { flex: '1 1 auto', wordBreak: 'break-all' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      smallBtn: { background: 'rgba(127,127,127,0.16)', color: 'inherit', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, padding: '3px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer' },
    }

    function emptyStory() {
      return {
        character: { name: '', profile: '', speech: '' },
        perspective: '',
        world: { setting: '', location: '', supportingCast: '' },
        counterpart: { profile: '', initial: '' },
        plot: { startingPoint: '', style: '', boundaries: '', keywords: [] },
      }
    }

    function pickStrings(obj, keys) {
      var out = {}
      for (var i = 0; i < keys.length; i++) {
        var v = obj ? obj[keys[i]] : undefined
        if (typeof v === 'string' && v.length) out[keys[i]] = v
      }
      return out
    }

    function cloneStory(s) {
      var e = emptyStory()
      if (!s || typeof s !== 'object') return e
      if (s.character) Object.assign(e.character, pickStrings(s.character, ['name', 'profile', 'speech']))
      if (typeof s.perspective === 'string') e.perspective = s.perspective
      if (s.world) Object.assign(e.world, pickStrings(s.world, ['setting', 'location', 'supportingCast']))
      if (s.counterpart) Object.assign(e.counterpart, pickStrings(s.counterpart, ['profile', 'initial']))
      if (s.plot) {
        Object.assign(e.plot, pickStrings(s.plot, ['startingPoint', 'style', 'boundaries']))
        if (Array.isArray(s.plot.keywords)) e.plot.keywords = s.plot.keywords.slice()
      }
      return e
    }

    /**
     * 把草稿里的故事字段收成要提交的 payload。
     *
     * **面板管理的字段一个不落地写进去，包括空串和空数组。**
     * 为什么必须带空值：宿主端 POST 走的是 `settingsScope.update()`，那是深合并
     * （`mergeLayers`）——**字段缺席等于「保持原值」**。所以用户把某个框清空后保存，
     * 旧值会原样留在配置里，刷新页面又冒出来：字面上「删不掉」。
     * 显式送 `''` / `[]` 才能让合并用空值覆盖旧值。
     *
     * 顺带的好处：payload 由 FIELDS 生成，面板增删字段时不会再漏改这里。
     */
    function buildStory(draft) {
      var out = {}
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i]
        var value = getByPath(draft, f.path)
        setByPath(out, f.path, typeof value === 'string' ? value : '')
      }
      // 关键词同理：全删光时要送 []，否则旧关键词会留下。
      var keywords = draft && draft.plot && Array.isArray(draft.plot.keywords) ? draft.plot.keywords : []
      setByPath(out, 'plot.keywords', keywords.slice())
      return out
    }

    function getByPath(obj, path) {
      return path.split('.').reduce(function (o, k) { return o == null ? o : o[k] }, obj)
    }

    function setByPath(obj, path, value) {
      var keys = path.split('.')
      var o = obj
      for (var i = 0; i < keys.length - 1; i++) {
        var k = keys[i]
        if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}
        o = o[k]
      }
      o[keys[keys.length - 1]] = value
    }

    function defaultScalar() {
      return {
        timeZone: 'Asia/Shanghai',
        gapNoticeMinutes: 30,
        alwaysReportTime: false,
        proactiveEnabled: true,
        agencyEnabled: true,
        alterEnabled: true,
        preplanEnabled: true,
        autoAdvanceEnabled: true,
        // 写故事与发消息是两个独立节奏（见 CONFIGURATION.md）。
        autoAdvanceIntervalMinutes: 40,
        autoMessage: true,
        messageIntervalMinutes: 120,
      }
    }

    function scalarFrom(v) {
      var d = defaultScalar()
      if (!v || typeof v !== 'object') return d
      if (typeof v.timeZone === 'string' && v.timeZone) d.timeZone = v.timeZone
      if (Number.isFinite(v.gapNoticeMinutes)) d.gapNoticeMinutes = v.gapNoticeMinutes
      d.alwaysReportTime = !!v.alwaysReportTime
      d.proactiveEnabled = v.proactive ? v.proactive.enabled !== false : true
      d.agencyEnabled = v.agency ? v.agency.enabled !== false : true
      d.alterEnabled = v.alterSystem ? v.alterSystem.enabled !== false : true
      d.preplanEnabled = v.schedulePreplan ? v.schedulePreplan.enabled !== false : true
      d.autoAdvanceEnabled = v.runtime ? v.runtime.autoAdvanceEnabled !== false : true
      d.autoAdvanceIntervalMinutes = v.runtime && Number.isFinite(v.runtime.autoAdvanceIntervalMinutes)
        ? v.runtime.autoAdvanceIntervalMinutes : 40
      // autoMessage 是总开关，deliverAutoAdvance 是老的兼容开关：展示为「都开才开」，
      // 否则设置了 deliverAutoAdvance:false 的老用户会在面板上看到「开着」却收不到消息。
      var im = v.im || {}
      d.autoMessage = im.autoMessage !== false && im.deliverAutoAdvance !== false
      d.messageIntervalMinutes = Number.isFinite(im.messageIntervalMinutes) ? im.messageIntervalMinutes : 120
      return d
    }

    /**
     * 把「间隔提示（分钟）」的原始输入收成合法整数。
     *
     * 不能用 `Number(x) || 30`：用户明确填 0 时，`Number('0')` 是 0，而 0 是假值，
     * 于是被悄悄改成 30——填 0 想表达「每次都提示」，保存后却变成「超过 30 分钟才提示」。
     * 0 是 schema 允许的合法值（`min(0)`），必须原样保留。
     *
     * @param {unknown} raw 输入框里的原始值（通常是字符串）。
     * @returns {number} 0–1440 的整数；空输入回退到默认值。
     */
    function parseGapNotice(raw) {
      if (typeof raw === 'string' && raw.trim() === '') return 30
      var n = Number(raw)
      if (!Number.isFinite(n)) return 30
      return Math.min(1440, Math.max(0, Math.round(n)))
    }

    /**
     * 把分钟输入收成合法整数。
     *
     * 不能用 `Number(x) || fallback`：用户明确填 0 时（发消息间隔填 0 = 每轮有话就发），
     * `Number('0')` 是 0 而 0 是假值，会被悄悄改成默认值。0 是 schema 允许的合法值。
     *
     * @param {unknown} raw 输入框里的原始值。
     * @param {number} fallback 空输入时的回退值。
     * @param {number} min 下限（含）。
     * @param {number} max 上限（含）。
     */
    function parseMinutes(raw, fallback, min, max) {
      if (raw === undefined || raw === null || raw === '') return fallback
      var n = Number(raw)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }

    function buildPayload(draft, scalar) {
      var payload = {
        timeZone: String(scalar.timeZone || '').trim(),
        gapNoticeMinutes: parseGapNotice(scalar.gapNoticeMinutes),
        alwaysReportTime: !!scalar.alwaysReportTime,
        proactive: { enabled: !!scalar.proactiveEnabled },
        agency: { enabled: !!scalar.agencyEnabled },
        alterSystem: { enabled: !!scalar.alterEnabled },
        schedulePreplan: { enabled: !!scalar.preplanEnabled },
        runtime: {
          autoAdvanceEnabled: !!scalar.autoAdvanceEnabled,
          // schema 的下限是 5 分钟：更密的话每一轮续写都要真跑一次模型，没有意义。
          autoAdvanceIntervalMinutes: parseMinutes(scalar.autoAdvanceIntervalMinutes, 40, 5, 1440),
        },
        im: {
          autoMessage: !!scalar.autoMessage,
          // 0 是合法值（有话就发），下限因此是 0 而不是像写故事那样的 5。
          messageIntervalMinutes: parseMinutes(scalar.messageIntervalMinutes, 120, 0, 1440),
        },
      }
      // story 始终提交，且包含全部受管字段（含空值）——见 buildStory 的说明。
      payload.story = buildStory(draft)
      return payload
    }

    /** 把毫秒时间戳渲染成「几分钟前 / 几分钟后」这类人话。 */
    function relTime(target, now) {
      if (!Number.isFinite(target)) return '—'
      var diff = target - now
      var abs = Math.abs(diff)
      var text
      if (abs < 60000) text = '不到 1 分钟'
      else if (abs < 3600000) text = Math.round(abs / 60000) + ' 分钟'
      else if (abs < 86400000) { var h = Math.floor(abs / 3600000); var m = Math.round((abs % 3600000) / 60000); text = m ? h + ' 小时 ' + m + ' 分' : h + ' 小时' }
      else text = Math.round(abs / 86400000) + ' 天'
      return diff >= 0 ? text + '后' : text + '前'
    }

    function clockText(ts) {
      if (!Number.isFinite(ts)) return '—'
      var d = new Date(ts)
      var pad = function (n) { return n < 10 ? '0' + n : String(n) }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    var KIND_LABEL = { reply: '延迟回复', reminder: '提醒', followup: '跟进', contact: '主动联系', promise: '承诺回访' }

    /**
     * 「这一轮为什么不会发消息」的人话。
     *
     * 这几个原因是三种完全不同的处置，混成一句「仅本地」会让用户以为功能坏了：
     *   - message-interval / daily-quota：攒着，下次还会发；
     *   - no-binding：这个会话根本不接聊天软件，永远不发；
     *   - auto-message-disabled：用户自己关的；
     *   - no-speech：纯粹是这一轮角色没说话，很正常。
     */
    var SPEAK_BLOCKED_LABEL = {
      'message-interval': '还没到发消息间隔，攒着',
      'daily-quota': '今日主动联系名额用完',
      'no-binding': '本会话未绑定聊天软件',
      'auto-message-disabled': '自动发消息已关闭',
      'no-speech': '续写里没有对用户说的话',
    }

    function speakBlockedLabel(reason) {
      return SPEAK_BLOCKED_LABEL[reason] || reason || '未判定'
    }

    /**
     * 只读运行状态视图。
     *
     * **只读是刻意的**：它只 GET `/api/hds-interlude/status`，没有任何写操作，
     * 所以放在配置表单上方不会带来「误触改坏配置」的风险。
     * 宿主端那条路由同样只实现 GET（其余方法 405）。
     *
     * 默认每 15 秒自动刷新一次（可关），因为「到期待办 / 扫描」是有时间含义的数字，
     * 停在静态快照上会误导人。组件卸载时会清掉定时器。
     */
    function RuntimeStatusView() {
      var dataState = react.useState(null)
      var data = dataState[0]
      var setData = dataState[1]

      var errState = react.useState(null)
      var err = errState[0]
      var setErr = errState[1]

      var autoState = react.useState(true)
      var auto = autoState[0]
      var setAuto = autoState[1]

      var tickState = react.useState(Date.now())
      var tick = tickState[0]
      var setTick = tickState[1]

      function load() {
        fetch('/api/hds-interlude/status')
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) { setData(d.value || {}); setErr(null); setTick(Date.now()) }
            else setErr((d && d.error) || '未知错误')
          })
          .catch(function (e) { setErr(e && e.message ? e.message : String(e)) })
      }

      react.useEffect(function () { load() }, [])

      react.useEffect(function () {
        if (!auto) return undefined
        var id = setInterval(load, 15000)
        return function () { clearInterval(id) }
      }, [auto])

      if (err && !data) {
        return jsx('div', { style: S.panel }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '运行状态（只读）' })]),
          jsx('div', { style: S.err, children: '读取运行状态失败：' + err }),
        ])
      }
      if (!data) {
        return jsx('div', { style: S.panel }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '运行状态（只读）' })]),
          jsx('div', { style: S.hint, children: '读取中…' }),
        ])
      }

      var sess = data.sessions || {}
      var intents = data.intents || {}
      var proactive = data.proactive || {}
      var timers = data.timers || {}
      var toggles = data.toggles || {}
      var advance = data.advance || {}
      var timing = data.timing || {}
      var upcoming = Array.isArray(intents.upcoming) ? intents.upcoming : []
      var advanceRows = Array.isArray(advance.sessions) ? advance.sessions : []
      var next = proactive.next || null

      var stats = [
        { n: String(sess.live || 0), l: '实时角色会话' },
        { n: String(intents.pending || 0), l: '待处理待办' },
        { n: String(intents.dueNow || 0), l: '已到点' },
        { n: String(proactive.reachedOutToday || 0) + ' / ' + String(proactive.maxPerDay || 6), l: '今日已主动联系' },
        { n: String(timers.intentTimers || 0), l: '在挂定时器' },
      ]

      var toggleDefs = [
        ['proactive', '主动联系'],
        ['autoAdvance', '写故事'],
        ['autoMessage', '自动发消息'],
        ['agency', '行动窗口'],
        ['alter', '情绪偏移'],
        ['preplan', '近期日程'],
        ['wakeIdle', '唤醒冷会话'],
        ['commitmentBackstop', '承诺兜底'],
      ]

      /**
       * 「下一次主动发消息」的展示。
       *
       * 这里刻意不把它说成精确时刻：待办那条有确定时刻（到点+宽限），
       * 但自动推进带随机抖动、还会避开休息时段，所以给的是区间并如实标注。
       */
      function renderNextWake() {
        if (!next) {
          return jsx('div', { style: S.kvVal, children: '暂无预计的主动开口（没有待办，也未开启自动推进）。' })
        }
        var head = next.via === 'advance' ? '自动生活推进' : (KIND_LABEL[next.kind] || next.kind || '待办')
        var when = next.overdue
          ? '随时（已到点，等下次扫描补跑）'
          : relTime(next.at, tick) + (next.atLatest && next.atLatest !== next.at ? ' ~ ' + relTime(next.atLatest, tick) : '')
        var notes = []
        if (next.blockedByRest) notes.push('落在休息时段，实际会顺延')
        notes.push(next.pushToIm ? '会投递到聊天软件' : '只在 DSH 内唤起（本会话未绑定聊天软件）')
        return jsx('div', { style: S.kvVal }, [
          jsx('span', { style: { fontWeight: 600 }, children: when }),
          jsx('span', { style: Object.assign({}, S.mono, { opacity: 0.75 }), children: ' · ' + head }),
          jsx('div', { style: S.hint, children: (next.summary || '') + '　' + notes.join('；') }),
        ])
      }

      return jsx('div', { style: S.panel }, [
        jsx('div', { style: S.panelHead, key: 'h' }, [
          jsx('div', { style: S.panelTitle, children: '运行状态（只读）' }),
          jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            jsx('span', { style: S.hint, children: '更新于 ' + clockText(tick) }),
            jsx('label', { style: { fontSize: 11, opacity: 0.65, display: 'flex', alignItems: 'center', gap: 4 } }, [
              jsx('input', { type: 'checkbox', style: S.check, checked: auto, onChange: function (e) { setAuto(e.target.checked) } }),
              '自动刷新 15s',
            ]),
            jsx('button', { style: S.smallBtn, onClick: load, children: '刷新' }),
          ]),
        ]),

        jsx('div', { style: S.grid, key: 'g' }, stats.map(function (s, i) {
          return jsx('div', { style: S.stat, key: i }, [
            jsx('div', { style: S.statNum, children: s.n }),
            jsx('div', { style: S.statLabel, children: s.l }),
          ])
        })),

        jsx('div', { style: S.chipRow, key: 'c' }, toggleDefs.map(function (t) {
          var on = toggles[t[0]] !== false
          return jsx('span', { key: t[0], style: on ? S.chipOn : S.chipOff, children: (on ? '● ' : '○ ') + t[1] })
        })),

        // 下一次主动发消息预计时间 —— 卡片的核心诉求，放在最显眼的位置。
        jsx('div', { style: Object.assign({}, S.kv, { borderTop: 'none', paddingBottom: 8 }), key: 'next' }, [
          jsx('span', { style: Object.assign({}, S.kvKey, { minWidth: 110, fontWeight: 600 }), children: '下次主动开口' }),
          renderNextWake(),
        ]),

        jsx('div', { key: 'kv' }, [
          jsx('div', { style: S.kv, key: 'ch' }, [
            jsx('span', { style: S.kvKey, children: '主角' }),
            jsx('span', { style: S.kvVal, children: data.character || '（未设定）' }),
          ]),
          jsx('div', { style: S.kv, key: 'tz' }, [
            jsx('span', { style: S.kvKey, children: '时区' }),
            jsx('span', { style: S.kvVal, children: data.zone || '—' }),
          ]),
          jsx('div', { style: S.kv, key: 'scan' }, [
            jsx('span', { style: S.kvKey, children: '扫描周期' }),
            jsx('span', { style: S.kvVal, children: '每 ' + String(timing.checkIntervalMinutes || 5) + ' 分钟（兜底，到点另有精确定时器）' }),
          ]),
          jsx('div', { style: S.kv, key: 'scan2' }, [
            jsx('span', { style: S.kvKey, children: '进行中扫描' }),
            jsx('span', { style: S.kvVal, children: String(timers.scansInFlight || 0) + ' 次' + (intents.failed ? '；历史失败待办 ' + intents.failed + ' 项' : '') }),
          ]),
        ]),

        // 幕间推进状态：推进开关 + 目标间隔 + 各实时会话的下一次补齐时间。
        jsx('div', { key: 'adv' }, [
          jsx('div', { style: Object.assign({}, S.hint, { margin: '10px 0 4px' }) , children: '故事续写与发消息' }),
          jsx('div', { style: S.kv }, [
            jsx('span', { style: S.kvKey, children: '写故事' }),
            jsx('span', { style: S.kvVal, children: advance.enabled === false
              ? '已关闭（无对话时不再续写角色生活）'
              : '开启 · 每 ' + String(timing.autoAdvanceIntervalMinutes || 40) + ' 分钟'
                + '（+0~' + String(timing.autoAdvanceJitterMinutes || 0) + ' 分钟随机）' }),
          ]),
          jsx('div', { style: S.kv }, [
            jsx('span', { style: S.kvKey, children: '发消息' }),
            jsx('span', { style: S.kvVal, children: toggles.autoMessage === false
              ? '已关闭（只写故事，不打扰；到点提醒仍会送达）'
              : '自动 · 两次之间至少 ' + String(timing.messageIntervalMinutes || 120) + ' 分钟'
                + '（只在角色说了话的那一轮发）' }),
          ]),
          advance.enabled === false
            ? null
            : (advanceRows.length
              ? advanceRows.map(function (row, i) {
                  var when = Number.isFinite(row.nextAt) ? relTime(row.nextAt, tick) : '—'
                  var note = row.blockedByRest ? '（落在休息时段，会顺延）' : ''
                  // 「下次续写」与「下次真的会收到消息」不是一回事，面板上必须分开说。
                  var dest = row.pushToIm ? '这一轮可能发消息' : '只写故事（' + speakBlockedLabel(row.speakBlockedBy) + '）'
                  return jsx('div', { style: S.kv, key: 'a' + i }, [
                    jsx('span', { style: S.kvKey, children: '下次续写' }),
                    jsx('span', { style: S.kvVal }, [
                      jsx('span', { children: when }),
                      jsx('span', { style: Object.assign({}, S.mono, { opacity: 0.6 }), children: ' · ' + dest + ' ' + note }),
                    ]),
                  ])
                })
              : jsx('div', { style: S.kv }, [
                  jsx('span', { style: S.kvKey, children: '下次续写' }),
                  jsx('span', { style: S.kvVal, children: '当前没有实时角色会话，续写不会发生。' }),
                ])),
        ]),

        jsx('div', { key: 'up' }, [
          jsx('div', { style: Object.assign({}, S.hint, { margin: '10px 0 4px' }), children: '即将到点（未来最近 ' + upcoming.length + ' 条）' }),
          upcoming.length
            ? upcoming.map(function (it) {
                return jsx('div', { style: S.kv, key: it.sessionId + '/' + it.id }, [
                  jsx('span', { style: S.kvKey, children: '[' + (KIND_LABEL[it.kind] || it.kind) + ']' }),
                  jsx('span', { style: S.kvVal }, [
                    jsx('span', { children: it.summary || '（无描述）' }),
                    jsx('span', { style: Object.assign({}, S.mono, { opacity: 0.6 }), children: ' · ' + relTime(it.dueAt, tick) }),
                  ]),
                ])
              })
            : jsx('div', { style: S.hint, children: '没有挂起的待办。' }),
        ]),

        jsx('div', { style: Object.assign({}, S.hint, { marginTop: 8 }), key: 'foot', children: '本卡片只读，不会修改配置或触发扫描；数据来自插件内存与磁盘状态。「实时角色会话」只统计正在使用幕间层（角色预设或 /interlude on）的会话。' }),
      ])
    }

    function InterludeCard() {
      var statusState = react.useState('loading')
      var status = statusState[0]
      var setStatus = statusState[1]

      var draftState = react.useState(emptyStory())
      var draft = draftState[0]
      var setDraft = draftState[1]

      var scalarState = react.useState(defaultScalar())
      var scalar = scalarState[0]
      var setScalar = scalarState[1]

      var savingState = react.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]

      var messageState = react.useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]

      var dirtyState = react.useState(false)
      var dirty = dirtyState[0]
      var setDirty = dirtyState[1]

      var presetNameState = react.useState('')
      var presetName = presetNameState[0]
      var setPresetName = presetNameState[1]
      var presetsState = react.useState([])
      var presets = presetsState[0]
      var setPresets = presetsState[1]

      function refreshPresets() {
        fetch('/api/hds-interlude/presets')
          .then(function (r) { return r.json() })
          .then(function (d) { if (d && d.ok && Array.isArray(d.presets)) setPresets(d.presets) })
          .catch(function () {})
      }
      react.useEffect(function () { refreshPresets() }, [])

      react.useEffect(function () {
        fetch('/api/hds-interlude/settings')
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              var v = d.value || {}
              setDraft(cloneStory(v.story))
              setScalar(scalarFrom(v))
              setStatus('ready')
            } else {
              setMessage({ kind: 'err', text: '读取设置失败：' + ((d && d.error) || '未知错误') })
              setStatus('error')
            }
          })
          .catch(function (e) {
            setMessage({ kind: 'err', text: '读取设置失败：' + (e && e.message ? e.message : String(e)) })
            setStatus('error')
          })
      }, [])

      /**
       * 改写草稿里的一个点路径。
       *
       * 用**函数式** setDraft（`prev => …`），而不是去读渲染快照 `draft`。
       * React 会把同一个 tick 里的多次更新批处理掉：快速连续输入（连打、输入法
       * 组合、自动填充）时，第二次 onChange 拿到的 `draft` 可能还是本次渲染的旧值，
       * 于是第一次的输入被覆盖丢失。函数式更新永远基于最新值，从根上避免这种丢字。
       */
      function update(path, value) {
        setDraft(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          setByPath(next, path, value)
          return next
        })
        setDirty(true)
      }

      function updateKeywords(text) {
        var arr = text.split('\n').map(function (s) { return s.trim() }).filter(function (s) { return s.length })
        setDraft(function (prev) {
          var next = JSON.parse(JSON.stringify(prev))
          next.plot.keywords = arr
          return next
        })
        setDirty(true)
      }

      /**
       * 渲染一个故事字段。
       *
       * 必须是一个独立函数，**不能**把这段逻辑写在 `for (var fi…)` 循环体内：
       * `var` 是函数作用域，循环里的 `f` 只有一个绑定，所有 onChange 闭包都会
       * 读到循环结束后的那个值（= 最后一条字段 `plot.boundaries`）。
       * 症状是「在任意输入框里打字，字都写进了禁则与边界，自己的框弹回空」。
       * 用函数参数把当前的 f 固定住即可。
       */
      function renderField(f) {
        var value = getByPath(draft, f.path) || ''
        var control = f.multiline
          ? jsx('textarea', { style: S.textarea, value: value, placeholder: f.hint, onChange: function (e) { update(f.path, e.target.value) } })
          : jsx('input', { type: 'text', style: S.input, value: value, placeholder: f.hint, onChange: function (e) { update(f.path, e.target.value) } })
        return jsx('div', { style: S.field, key: f.path }, [
          jsx('label', { style: S.label, children: f.label }),
          control,
          jsx('div', { style: S.hint, children: f.hint }),
        ])
      }

      /** 同 update：用函数式更新，避免同一 tick 内多次改动互相覆盖（见 update 的说明）。 */
      function updateScalar(key, value) {
        setScalar(function (prev) {
          var next = Object.assign({}, prev)
          next[key] = value
          return next
        })
        setDirty(true)
      }

      function onSave() {
        setSaving(true)
        setMessage(null)
        var payload = buildPayload(draft, scalar)
        fetch('/api/hds-interlude/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) { setDirty(false); setMessage({ kind: 'ok', text: '已保存，下一次回复生效。' }) }
            else { setMessage({ kind: 'err', text: '保存失败：' + ((d && d.error) || '未知错误') }) }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '保存失败：' + (e && e.message ? e.message : String(e)) }) })
          .then(function () { setSaving(false) })
      }

      function onReset() {
        setDraft(emptyStory())
        setScalar(defaultScalar())
        setDirty(true)
        setMessage({ kind: 'ok', text: '已清空本页草稿，点「保存」生效。' })
      }

      function onSavePreset() {
        var nm = String(presetName || '').trim()
        if (!nm) { setMessage({ kind: 'err', text: '请先填预设名称' }); return }
        fetch('/api/hds-interlude/presets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: nm }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setPresetName('')
              setMessage({ kind: 'ok', text: '已保存预设「' + nm + '」，可在 DSH 的 Agent 预设里选择。' })
              refreshPresets()
            } else {
              setMessage({ kind: 'err', text: '保存预设失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '保存预设失败：' + (e && e.message ? e.message : String(e)) }) })
      }

      function onDeletePreset(id) {
        fetch('/api/hds-interlude/presets', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) refreshPresets()
            else setMessage({ kind: 'err', text: '删除失败：' + ((d && d.error) || '未知错误') })
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '删除失败：' + (e && e.message ? e.message : String(e)) }) })
      }

      if (status === 'loading') {
        return jsx('div', { style: S.status, children: '加载中…' })
      }
      if (status === 'error') {
        return jsx('div', { style: S.card }, [
          message ? jsx('div', { style: { color: '#e88888', marginBottom: 8 }, children: message.text }) : null,
          jsx('div', { style: S.hint, children: '请确认插件已加载（终端启动日志应有 [hds-interlude] 幕间层已启用），然后刷新本页。' }),
        ])
      }

      var children = []

      for (var gi = 0; gi < GROUPS.length; gi++) {
        var group = GROUPS[gi]
        var fields = FIELDS.filter(function (f) { return f.group === group })
        var fieldEls = []
        for (var fi = 0; fi < fields.length; fi++) {
          fieldEls.push(renderField(fields[fi]))
        }
        if (group === '剧情') {
          var kwText = (draft.plot && Array.isArray(draft.plot.keywords)) ? draft.plot.keywords.join('\n') : ''
          fieldEls.push(jsx('div', { style: S.field, key: 'plot.keywords' }, [
            jsx('label', { style: S.label, children: '关键词（每行一个）' }),
            jsx('textarea', { style: S.textarea, value: kwText, placeholder: '用于长期事实检索，每行一个', onChange: function (e) { updateKeywords(e.target.value) } }),
            jsx('div', { style: S.hint, children: '关键词，用于长期事实检索。' }),
          ]))
        }
        children.push(jsx('div', { style: S.section, key: group }, [jsx('div', { style: S.heading, children: group })].concat(fieldEls)))
      }

      children.push(jsx('div', { style: S.section, key: '时间与节奏' }, [
        jsx('div', { style: S.heading, children: '时间与节奏' }),
        jsx('div', { style: S.row }, [
          jsx('div', { style: S.cell }, [
            jsx('label', { style: S.label, children: '时区（IANA）' }),
            jsx('input', { type: 'text', style: S.input, value: scalar.timeZone, placeholder: 'Asia/Shanghai', onChange: function (e) { updateScalar('timeZone', e.target.value) } }),
            jsx('div', { style: S.hint, children: '角色所在时区，例如 Asia/Shanghai。' }),
          ]),
          jsx('div', { style: S.cell }, [
            jsx('label', { style: S.label, children: '间隔提示（分钟）' }),
            jsx('input', { type: 'number', style: S.input, value: scalar.gapNoticeMinutes, onChange: function (e) { updateScalar('gapNoticeMinutes', e.target.value) } }),
            jsx('div', { style: S.hint, children: '距上次互动超过多少分钟才提示「过了多久」。' }),
          ]),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.alwaysReportTime, onChange: function (e) { updateScalar('alwaysReportTime', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '每回合都注入当前时间' }),
        ]),
      ]))

      children.push(jsx('div', { style: S.section, key: '生活与主动' }, [
        jsx('div', { style: S.heading, children: '生活与主动' }),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.proactiveEnabled, onChange: function (e) { updateScalar('proactiveEnabled', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '主动联系（到期待办时角色会自己开口）' }),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.autoAdvanceEnabled, onChange: function (e) { updateScalar('autoAdvanceEnabled', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '写故事（无对话时续写角色的生活）' }),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.agencyEnabled, onChange: function (e) { updateScalar('agencyEnabled', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '主体行动窗口（日程/隐私/设备约束）' }),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.alterEnabled, onChange: function (e) { updateScalar('alterEnabled', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '情绪偏移追踪（Alter System）' }),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.preplanEnabled, onChange: function (e) { updateScalar('preplanEnabled', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '近期日程（Schedule Preplan）' }),
        ]),
      ]))

      /**
       * 故事与消息：这一节是改版的核心。
       *
       * 两块节奏分开：「写故事」决定多久续写一段生活（留在 DSH 里，是叙事），
       * 「发消息」决定多久允许把角色的发言真发到聊天软件。合成一个数字的话，
       * 用户只能二选一：要么故事够密、消息太吵，要么消息够静、故事断档。
       */
      children.push(jsx('div', { style: S.section, key: '故事与消息' }, [
        jsx('div', { style: S.heading, children: '故事与消息' }),
        jsx('div', { style: S.hint, children: '故事续写只留在 DSH 里；只有角色单独成行、用引号写出来的那句话才会发给用户。' }),
        jsx('div', { style: S.row }, [
          jsx('div', { style: S.cell }, [
            jsx('label', { style: S.label, children: '写故事间隔（分钟）' }),
            jsx('input', { type: 'number', style: S.input, min: 5, value: scalar.autoAdvanceIntervalMinutes, onChange: function (e) { updateScalar('autoAdvanceIntervalMinutes', e.target.value) } }),
            jsx('div', { style: S.hint, children: '无对话时，每隔多久续写一段角色的生活。只影响故事，不影响发消息。默认 40。' }),
          ]),
          jsx('div', { style: S.cell }, [
            jsx('label', { style: S.label, children: '发消息间隔（分钟）' }),
            jsx('input', { type: 'number', style: S.input, min: 0, value: scalar.messageIntervalMinutes, onChange: function (e) { updateScalar('messageIntervalMinutes', e.target.value) } }),
            jsx('div', { style: S.hint, children: '两次自动发消息之间至少隔多久。填 0 = 每轮有话就发。默认 120。到点的提醒不受它限制。' }),
          ]),
        ]),
        jsx('div', { style: S.toggle }, [
          jsx('input', { type: 'checkbox', style: S.check, checked: scalar.autoMessage, onChange: function (e) { updateScalar('autoMessage', e.target.checked) } }),
          jsx('span', { style: S.toggleLabel, children: '故事里角色的发言自动发出去（关掉 = 只写故事，不打扰；到点提醒仍会送达）' }),
        ]),
      ]))

      // 预设：保存当前设定为 DSH 的 Agent 预设
      children.push(jsx('div', { style: S.section, key: '预设' }, [
        jsx('div', { style: S.heading, children: '预设（保存后加入 DSH 的 Agent 预设）' }),
        jsx('div', { style: S.row }, [
          jsx('div', { style: S.cell }, [
            jsx('label', { style: S.label, children: '预设名称' }),
            jsx('input', { type: 'text', style: S.input, value: presetName, placeholder: '例如：雨夜来信', onChange: function (e) { setPresetName(e.target.value) } }),
          ]),
          jsx('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', marginBottom: 12 } }, [
            jsx('button', { style: S.button, onClick: onSavePreset, children: '保存当前设定为预设' }),
          ]),
        ]),
        presets.length
          ? jsx('div', { style: { marginTop: 4 } }, presets.map(function (p) {
              return jsx('div', { key: p.id, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.12)' } }, [
                jsx('span', { style: { fontSize: 13 } }, p.name),
                jsx('button', { style: Object.assign({}, S.button, { padding: '3px 10px', fontSize: 12 }), onClick: function () { onDeletePreset(p.id) }, children: '删除' }),
              ])
            }))
          : jsx('div', { style: S.hint, children: '还没有保存过预设。保存后，它会出现在 DSH 的 Agent 预设选择器里，开新会话可直接选用。' }),
      ]))

      var statusLine = dirty
        ? jsx('span', { style: S.status, children: '● 有未保存改动' })
        : jsx('span', { style: S.status, children: '已是最新' })
      var msgEl = message ? jsx('span', { style: message.kind === 'ok' ? S.ok : S.err, children: message.text }) : null

      return jsx('div', { style: S.card }, [
        jsx(RuntimeStatusView, { key: 'runtime-status' }),
        jsx('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 14 }, children: '人设 / 世界观 / 剧情 + 时间与节奏 + 生活与主动。改动在下一次回复生效。' }),
      ].concat(children).concat([
        jsx('div', { style: S.bar }, [
          jsx('button', { style: S.button, onClick: onSave, disabled: saving, children: saving ? '保存中…' : '保存' }),
          jsx('button', { style: S.button, onClick: onReset, disabled: saving, children: '重置本页' }),
          statusLine,
          msgEl,
        ]),
      ]))
    }

    /** 客户端插件入口：在设置页注册一整个「幕间系统」页面（settings.section 槽）。 */
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'hds-interlude',
            order: 41,
            label: function () { return '幕间系统' },
            inject: function () { return {} },
          },
          InterludeCard,
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 供测试直接渲染「运行状态」只读视图（DSH 客户端加载器只读 apply/inject，多挂一个
    // 命名导出不影响加载；有了它，测试不必穿透 InterludeCard 的加载/错误早退分支）。
    exports.RuntimeStatusView = RuntimeStatusView
    return module.exports
  },
})


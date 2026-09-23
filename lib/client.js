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

    /**
     * DSH 的目录选择能力（uiWorkspace / workspaces）：`pickDirectory` 在 host 侧
     * 打开系统目录选择器、返回真实绝对路径——工作区选择的优先途径。
     * apply(ctx) 里解析；测试或精简环境没有 → null，回退自建 fs/list 浏览面板。
     */
    var pickerApi = null

    /** 把错误规整成可读文本（后端 lastError 可能是对象/Error）。 */
    function errText(v) {
      if (v == null) return ''
      if (typeof v === 'string') return v
      if (v instanceof Error) return v.message || String(v)
      if (typeof v === 'object') {
        var t = v.error || v.message || v.text
        if (typeof t === 'string' && t) return t
      }
      try { return String(v) } catch (e) { return '未知错误' }
    }

    /* ═══ 酒馆角色卡（SillyTavern）导入/导出 —— 浏览器内联版 ═══
     * 与 lib/tavern-card.mjs 逻辑一致（那边 node 侧、可单测）；差异仅在
     * PNG zlib 解压用浏览器的 DecompressionStream。导出只做 JSON 卡；
     * 导入支持 .json 与 .png（tEXt/zTXt 的 chara 键）。 */

    function tcStr(v) { return typeof v === 'string' ? v.trim() : '' }
    function tcClone(v) { return JSON.parse(JSON.stringify(v ?? {})) }
    function tcDecode(bytes) { return new TextDecoder('utf-8').decode(bytes) }

    /** Story → 酒馆角色卡 v2（含 extensions.dsh_hds_interlude.story 无损备份）。 */
    function tcToCard(story) {
      var s = story || {}
      var c = s.character || {}
      var w = s.world || {}
      var cp = s.counterpart || {}
      var p = s.plot || {}
      var desc = []
      if (tcStr(c.profile)) desc.push(c.profile)
      if (tcStr(s.perspective)) desc.push('价值观：\n' + s.perspective)
      var worldLines = [
        tcStr(w.setting) || null,
        tcStr(w.location) ? '主要地点：' + w.location : null,
        tcStr(w.supportingCast) ? '配角：\n' + w.supportingCast : null,
      ].filter(Boolean)
      if (worldLines.length) desc.push('世界观：\n' + worldLines.join('\n'))
      var cpLines = [
        tcStr(cp.profile) || null,
        tcStr(cp.initial) ? '初始关系：' + cp.initial : null,
      ].filter(Boolean)
      if (cpLines.length) desc.push('对话者：\n' + cpLines.join('\n'))
      return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: tcStr(c.name),
          description: desc.join('\n\n'),
          personality: tcStr(c.speech),
          scenario: tcStr(p.startingPoint),
          first_mes: '',
          mes_example: '',
          creator_notes: '由 dsh-hds-interlude（幕间系统）导出',
          system_prompt: tcStr(p.boundaries),
          post_history_instructions: tcStr(p.style),
          alternate_greetings: [],
          character_book: undefined,
          tags: Array.isArray(p.keywords) ? p.keywords.filter(function (k) { return typeof k === 'string' && k.trim() }) : [],
          creator: 'dsh-hds-interlude',
          character_version: '1.0',
          extensions: { dsh_hds_interlude: { story: tcClone(story) } },
        },
      }
    }

    /** 酒馆角色卡 → Story（优先 extensions 备份；否则字段映射 + first_mes/示例/世界书并入）。 */
    function tcToStory(card) {
      var data = card && card.data ? card.data : (card || {})
      var ext = data && data.extensions && data.extensions.dsh_hds_interlude && data.extensions.dsh_hds_interlude.story
      if (ext && typeof ext === 'object' && !Array.isArray(ext)) return tcClone(ext)
      var story = { character: {}, world: {}, counterpart: {}, plot: {}, keywords: [] }
      story.character.name = tcStr(data.name) || '未命名角色'
      story.character.profile = tcStr(data.description)
      story.character.speech = tcStr(data.personality)
      story.plot.startingPoint = tcStr(data.scenario)
      if (tcStr(data.first_mes)) {
        story.plot.startingPoint = [story.plot.startingPoint, '开场白：' + String(data.first_mes).trim()].filter(Boolean).join('\n\n')
      }
      story.plot.boundaries = tcStr(data.system_prompt)
      story.plot.style = tcStr(data.post_history_instructions)
      if (tcStr(data.mes_example)) {
        story.character.profile = [story.character.profile, '（示例对话，来自角色卡）\n' + String(data.mes_example).trim()].filter(Boolean).join('\n\n')
      }
      var bookEntries = Array.isArray(data.character_book && data.character_book.entries) ? data.character_book.entries : []
      var bookLines = bookEntries.map(function (e) { return tcStr(e && e.content) }).filter(Boolean)
      if (bookLines.length) {
        story.character.profile = [story.character.profile, '（世界书条目）\n' + bookLines.join('\n---\n')].filter(Boolean).join('\n\n')
      }
      var bookKeys = []
      for (var i = 0; i < bookEntries.length; i++) {
        var keys = bookEntries[i] && bookEntries[i].keys
        if (Array.isArray(keys)) bookKeys.push.apply(bookKeys, keys.filter(function (k) { return typeof k === 'string' && k.trim() }))
      }
      var tags = Array.isArray(data.tags) ? data.tags.filter(function (t) { return typeof t === 'string' && t.trim() }) : []
      story.plot.keywords = Array.from(new Set(bookKeys.concat(tags)))
      return story
    }

    /**
     * 把一段文本解析成角色卡对象：先当原始 JSON，再当 base64（SillyTavern PNG 卡的
     * chara 块是 base64 的 JSON——直接 JSON.parse 会抛 `Unexpected token 'e', "eyJ…"`）。
     */
    function tcParseCardText(text) {
      // ① 原始 JSON（本插件旧导出的 PNG 卡、普通 .json 卡）。
      try {
        var p = JSON.parse(text)
        if (p && typeof p === 'object' && !Array.isArray(p)) return p
      } catch (e) { /* 非原始 JSON */ }
      // ② base64：SillyTavern 用 btoa(unescape(encodeURIComponent(json))) 存 chara 块，
      //    即「UTF-8 字节 → base64」；atob 解出二进制串，再用 TextDecoder 还原 UTF-8。
      try {
        var bin = atob(String(text).replace(/\s+/g, ''))
        var bytes = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        var p2 = JSON.parse(new TextDecoder('utf-8').decode(bytes))
        if (p2 && typeof p2 === 'object' && !Array.isArray(p2)) return p2
      } catch (e2) { /* 也不是 base64 */ }
      throw new Error('不是合法的角色卡 JSON（既非原始 JSON，也非 base64 JSON）')
    }

    /** JSON 文本 → 角色卡（校验角色名特征）。 */
    function tcParseJson(text) {
      var parsed = tcParseCardText(text)
      var name = (parsed && parsed.name) || (parsed && parsed.data && parsed.data.name)
      if (typeof name !== 'string') throw new Error('不是合法的角色卡 JSON（缺少角色名）')
      return parsed
    }

    /** 浏览器 zlib deflate 解压（zTXt 用）。 */
    function tcInflate(bytes) {
      var ds = new DecompressionStream('deflate')
      var stream = new Blob([bytes]).stream().pipeThrough(ds)
      return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf) })
    }

    /** PNG → chara 角色卡（async：zTXt 需要解压）。 */
    async function tcParsePng(bytes) {
      var sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      for (var i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('不是合法的 PNG 文件')
      var chunks = []
      var off = 8
      while (off + 8 <= bytes.length) {
        var len = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
        var type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
        var ds0 = off + 8
        var de = ds0 + len
        if (de > bytes.length) break
        if (type === 'tEXt') {
          var sep = bytes.indexOf(0, ds0)
          if (sep > ds0 && sep < de) {
            chunks.push({ type: type, keyword: tcDecode(bytes.subarray(ds0, sep)), text: tcDecode(bytes.subarray(sep + 1, de)) })
          }
        } else if (type === 'zTXt') {
          var sep2 = bytes.indexOf(0, ds0)
          if (sep2 > ds0 && sep2 + 2 <= de) {
            var kw = tcDecode(bytes.subarray(ds0, sep2))
            try {
              var plain = await tcInflate(bytes.subarray(sep2 + 2, de))
              chunks.push({ type: type, keyword: kw, text: tcDecode(plain) })
            } catch (e) { /* 解压失败跳过 */ }
          }
        }
        off = de + 4
      }
      for (var j = 0; j < chunks.length; j++) {
        if (chunks[j].keyword === 'chara') return tcParseCardText(chunks[j].text)
      }
      throw new Error('PNG 里没有找到 chara 角色卡数据')
    }

    /** 文件字节 → 角色卡（自动识别 JSON / PNG）。 */
    async function tcParseFile(bytes, name) {
      void name
      var isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      if (isPng) return tcParsePng(bytes)
      var text = tcDecode(bytes)
      if (!text.trim()) throw new Error('文件是空的')
      try {
        return tcParseJson(text)
      } catch (error) {
        throw new Error('不是合法的角色卡文件（既不是 JSON 也不是 PNG）：' + (error && error.message ? error.message : String(error)))
      }
    }

    /** 故事字段定义：分组 + 点路径 + 多行/单行 + 提示。 */
    var FIELDS = [
      { path: 'character.name', label: '主角名称', group: '角色', multiline: false, hint: '主角的称呼。' },
      { path: 'character.profile', label: '身份设定', group: '角色', multiline: true, hint: '身份、性格、作息、习惯、压力、行为边界。' },
      { path: 'character.speech', label: '说话风格', group: '角色', multiline: true, hint: '说话风格与口头习惯。' },
      { path: 'perspective', label: '价值观（外壳人格层）', group: '角色', multiline: true, hint: '看待世界的方式，随剧情漂移，不改写人设。' },
      { path: 'counterpart.profile', label: '对手背景', group: '关系', multiline: true, hint: '对话者的默认背景。' },
      { path: 'counterpart.initial', label: '初始关系', group: '关系', multiline: false, hint: '新参与者与主角的默认初始关系。' },
      { path: 'world.setting', label: '世界设定', group: '世界', multiline: true, hint: '时间、地点、社会与现实规则。' },
      { path: 'world.location', label: '主要地点', group: '世界', multiline: false, hint: '主角主要活动地点。' },
      { path: 'world.supportingCast', label: '重要配角', group: '世界', multiline: true, hint: '重要配角及其与主角的关系。' },
      { path: 'plot.startingPoint', label: '剧情起点', group: '剧情', multiline: true, hint: '你们现在是什么关系。' },
      { path: 'plot.style', label: '文风', group: '剧情', multiline: true, hint: '当前故事文风。' },
      { path: 'plot.boundaries', label: '禁则与边界', group: '剧情', multiline: true, hint: '禁则与边界。' },
    ]

    var GROUPS = ['角色', '关系', '世界', '剧情']

    /** 顶部 Tab：把五种性质不同的事拆开，别挤在一根滚动条里。 */
    var TABS = [
      { id: 'story', label: '创作' },
      { id: 'rhythm', label: '节奏' },
      { id: 'chat', label: '聊天' },
      { id: 'presets', label: '预设/命令' },
    ]

    /** 本地记住上次选的 Tab；读不到就回「故事」。 */
    function lastTab() {
      try {
        var saved = localStorage.getItem('dsh-hds-interlude-tab')
        for (var i = 0; i < TABS.length; i++) if (TABS[i].id === saved) return saved
      } catch (e) { /* 无 localStorage（如测试环境）就回默认 */ }
      return 'story'
    }
    function storeTab(id) {
      try { localStorage.setItem('dsh-hds-interlude-tab', id) } catch (e) { /* 忽略 */ }
    }

    /**
     * 视觉令牌（统一色板）——与既有语义色一致，抽成变量便于整体调整明暗主题。
     * 全部基于半透明中性灰 + 三态语义色，自适应宿主明暗背景。
     */
    var T = {
      accent: '#5f9be8',
      accentSoft: 'rgba(95,155,232,0.16)',
      ok: '#5fbf7f',
      warn: '#e8a33d',
      err: '#e88888',
      ink: 'rgba(127,127,127,0.10)',   // 输入/卡片底色
      inkSoft: 'rgba(127,127,127,0.06)', // 更浅的底色
      line: 'rgba(127,127,127,0.22)',  // 常规描边
      lineSoft: 'rgba(127,127,127,0.12)', // 弱描边
      lineStrong: 'rgba(127,127,127,0.32)', // 强描边（hover）
    }

    var S = {
      card: { padding: '4px 2px' },
      section: {
        marginBottom: 16,
        borderRadius: 10,
        border: '1px solid ' + T.lineSoft,
        background: T.inkSoft,
        padding: '12px 14px',
        transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease',
      },
      heading: {
        fontSize: 13, fontWeight: 700, opacity: 0.9,
        margin: '0 0 12px', padding: '0 0 5px 9px',
        borderLeft: '3px solid ' + T.accent,
        borderBottom: '1px solid ' + T.lineSoft,
        letterSpacing: '.01em',
      },
      field: { marginBottom: 12 },
      label: { display: 'block', fontSize: 12, opacity: 0.82, marginBottom: 4, fontWeight: 500 },
      hint: { fontSize: 11, opacity: 0.5, margin: '3px 0 0', lineHeight: 1.5 },
      row: { display: 'flex', gap: 14, flexWrap: 'wrap' },
      cell: { flex: '1 1 180px', marginBottom: 12 },
      input: {
        width: '100%', boxSizing: 'border-box',
        background: T.ink, color: 'inherit',
        border: '1px solid ' + T.line, borderRadius: 7,
        padding: '6px 9px', font: 'inherit', fontSize: 13,
        transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', minHeight: 88, resize: 'vertical',
        background: T.ink, color: 'inherit',
        border: '1px solid ' + T.line, borderRadius: 7,
        padding: '6px 9px', font: 'inherit', fontSize: 13, lineHeight: 1.5,
        transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease',
      },
      toggle: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, padding: '2px 0' },
      /**
       * 复选框开关：**纯内联样式实现，不依赖任何外部 CSS**。
       *
       * 为什么必须内联（踩过的坑）：早先版本把开关画法写在注入的全局 CSS 里
       * （`input[type=checkbox] { width: 34px ... }`），而内联样式优先级更高 ——
       * 本对象里的 `width/height` 会把它整个盖掉，于是开关被压成 15×15 的小圆、
       * 滑块被 `translateX` 推出盒子外，正是「开关渲染错乱」的根因。
       *
       * 现在的做法：轨道与滑块都用内联样式表达，`checked` 状态由**渲染期计算**
       * （`{@link checkStyle}`）而不是靠 CSS 的 `:checked` 选择器。这样：
       *   - 不会再有内联/外部的优先级冲突；
       *   - 即使设置页被渲染进 shadow DOM（外部样式表穿不进去）也照样正确；
       *   - 测试替身没有 CSS 引擎，也能直接断言这两个状态的内联样式差异。
       *
       * 滑块用 `radial-gradient` 背景图（不占 DOM），而不是 `::after` 伪元素：
       * `<input>` 是替换元素，伪元素在各浏览器上的支持并不一致。
       */
      checkBase: {
        appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
        boxSizing: 'border-box',
        width: 36, height: 20, borderRadius: 999, flex: '0 0 auto',
        border: '1px solid ' + T.lineStrong,
        backgroundRepeat: 'no-repeat',
        backgroundSize: '16px 16px',
        cursor: 'pointer', margin: 0,
        transition: 'background-color .18s ease, border-color .18s ease, background-position .18s ease',
      },
      /** 关：灰轨道 + 滑块靠左。 */
      checkOff: {
        backgroundColor: 'rgba(127,127,127,0.26)',
        backgroundImage: 'radial-gradient(circle, #ffffff 0 6.5px, rgba(255,255,255,0) 7px)',
        backgroundPosition: 'left 2px center',
      },
      /** 开：主色轨道 + 滑块靠右。 */
      checkOn: {
        backgroundColor: T.accent,
        backgroundImage: 'radial-gradient(circle, #ffffff 0 6.5px, rgba(255,255,255,0) 7px)',
        backgroundPosition: 'right 2px center',
      },
      toggleLabel: { fontSize: 13, cursor: 'default' },
      bar: {
        display: 'flex', gap: 10, alignItems: 'center', marginTop: 12,
        paddingTop: 12, borderTop: '1px solid ' + T.lineSoft,
      },
      button: {
        background: T.accentSoft, color: 'inherit',
        border: '1px solid ' + T.lineStrong, borderRadius: 7,
        padding: '7px 18px', font: 'inherit', fontSize: 13, fontWeight: 600,
        cursor: 'pointer', transition: 'background .15s ease, border-color .15s ease, transform .05s ease',
      },
      buttonPrimary: {
        background: T.accent, color: '#fff',
        border: '1px solid ' + T.accent, borderRadius: 7,
        padding: '7px 18px', font: 'inherit', fontSize: 13, fontWeight: 700,
        cursor: 'pointer', transition: 'filter .15s ease, transform .05s ease',
      },
      status: { fontSize: 12, opacity: 0.7, marginLeft: 'auto' },
      ok: { color: T.ok },
      err: { color: T.err },
      // 只读运行状态视图专用样式
      panel: {
        border: '1px solid ' + T.lineSoft, borderRadius: 10,
        padding: '12px 14px', marginBottom: 16,
        background: T.inkSoft,
      },
      panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
      panelTitle: { fontSize: 13, fontWeight: 700, opacity: 0.9 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 },
      stat: { border: '1px solid ' + T.lineSoft, borderRadius: 8, padding: '8px 10px', background: T.ink, transition: 'border-color .15s ease' },
      statNum: { fontSize: 17, fontWeight: 700, lineHeight: 1.2 },
      statLabel: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
      chipOn: { fontSize: 11, padding: '2px 9px', borderRadius: 999, background: 'rgba(95,191,127,0.16)', color: T.ok, border: '1px solid rgba(95,191,127,0.35)', fontWeight: 600 },
      chipOff: { fontSize: 11, padding: '2px 9px', borderRadius: 999, background: T.ink, color: 'inherit', opacity: 0.55, border: '1px solid ' + T.line },
      kv: { fontSize: 12, display: 'flex', gap: 8, padding: '4px 0', borderTop: '1px solid ' + T.lineSoft },
      kvKey: { opacity: 0.6, flex: '0 0 auto', minWidth: 84 },
      kvVal: { flex: '1 1 auto', wordBreak: 'break-all' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      smallBtn: { background: T.ink, color: 'inherit', border: '1px solid ' + T.line, borderRadius: 6, padding: '3px 11px', font: 'inherit', fontSize: 12, cursor: 'pointer', transition: 'background .15s ease, border-color .15s ease' },
      // Tab 导航
      tabs: {
        display: 'flex', gap: 4, marginBottom: 18,
        padding: '4px', borderRadius: 10,
        background: T.inkSoft, border: '1px solid ' + T.lineSoft,
      },
      tab: {
        padding: '6px 16px', fontSize: 13, background: 'transparent', color: 'inherit',
        border: 'none', borderRadius: 7, cursor: 'pointer', opacity: 0.55,
        transition: 'background .15s ease, opacity .15s ease, color .15s ease',
      },
      tabActive: {
        padding: '6px 16px', fontSize: 13, background: T.accentSoft, color: 'inherit',
        border: 'none', borderRadius: 7, cursor: 'pointer', opacity: 1, fontWeight: 700,
        boxShadow: 'inset 0 0 0 1px ' + T.accent,
      },
      // 展开/折叠
      advBtn: { background: 'transparent', color: 'inherit', border: 'none', padding: '4px 0', fontSize: 12, opacity: 0.65, cursor: 'pointer', marginBottom: 8, transition: 'opacity .15s ease' },
      advBody: { borderLeft: '2px solid ' + T.accent, paddingLeft: 12, marginBottom: 8, opacity: 0.95 },
      // 两列网格（功能开关等短控件用）
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '2px 14px' },
      // 机器人小卡片（对齐 dsh-im 的 AccountCard）
      botCard: { border: '1px solid ' + T.lineSoft, borderRadius: 10, marginBottom: 8, background: T.inkSoft, overflow: 'hidden', transition: 'border-color .15s ease, box-shadow .15s ease' },
      botCardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', cursor: 'pointer', gap: 8 },
      botCardOpen: { borderLeft: '3px solid ' + T.accent, borderLeftWidth: 3 },
      botDetails: { borderTop: '1px solid ' + T.lineSoft, padding: '10px 12px', background: T.ink },
      dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto' },
      dotGreen: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto', background: T.ok, boxShadow: '0 0 0 3px rgba(95,191,127,0.18)' },
      dotYellow: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto', background: T.warn },
      dotRed: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto', background: T.err, boxShadow: '0 0 0 3px rgba(232,136,136,0.18)' },
      dotGray: { width: 8, height: 8, borderRadius: 999, display: 'inline-block', flex: '0 0 auto', background: 'rgba(127,127,127,0.4)' },
      gearBtn: { background: 'transparent', color: 'inherit', border: '1px solid ' + T.line, borderRadius: 6, padding: '2px 9px', font: 'inherit', fontSize: 13, cursor: 'pointer', lineHeight: 1.4, transition: 'background .15s ease' },
      bindRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid ' + T.lineSoft },
      // 未保存改动徽章（胶囊）
      badge: { fontSize: 11, padding: '2px 10px', borderRadius: 999, fontWeight: 600 },
      badgeDirty: { background: 'rgba(232,163,61,0.18)', color: T.warn, border: '1px solid rgba(232,163,61,0.4)' },
      badgeClean: { background: 'rgba(95,191,127,0.14)', color: T.ok, border: '1px solid rgba(95,191,127,0.35)' },
    }

    /**
     * 复选框开关的内联样式：按 `checked` 在渲染期选择开/关两套轨道。
     *
     * @param {boolean} on 是否勾选。
     * @returns {object} 内联样式对象。
     */
    function checkStyle(on) {
      return Object.assign({}, S.checkBase, on ? S.checkOn : S.checkOff)
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
        // 第三轮对齐补齐：Urge 弹性推进 / 时间导演（默认关，与 schema 一致）。
        urgeEnabled: false,
        timelineDirectorEnabled: false,
        // 写故事与发消息是两个独立节奏（见 CONFIGURATION.md）。
        autoAdvanceIntervalMinutes: 40,
        autoMessage: true,
        messageIntervalMinutes: 120,
        // IM 通道（内置 QQ）。凭据只存**引用名**，值留在凭据服务里。
        imEnabled: false,
        imAppId: '',
        imSecretRef: 'DSH_QQBOT_APP_SECRET',
        imBotId: 'qq',
        // 多 Bot：完整的机器人列表（每项 {botId, appId, secretRef, alias}）。
        // 单 Bot 时与顶层 appId/botId/secretRef 保持同步。
        imBots: [],
        imAgentPreset: '',
        imCwd: '',
        imSayFallback: 'strict',
        // 表情包：目录（留空=默认）、四个开关。
        imStickerDir: '',
        imImagesEnabled: true,
        imHarvestInbound: true,
        imFaceEnabled: true,
        imInboundPrefix: true,
        imGroupMentionOnly: true,
        // 群聊发言意愿（关掉 @门控 后用它控制发言频率）。
        // 只暴露最常调的三个：开关 / 阈值（多沉默）/ 冷却（多久内不再回）。
        // 其余细调参数（probabilityAmplifier、decayHalfLifeSeconds、replyCost、
        // baseGain、quoteGain、keywordGain、keywords）留在 settings.yaml 里。
        imGroupWillingness: false,
        imGroupWillingnessThreshold: 0.24,
        imGroupWillingnessCooldownSeconds: 0,
        imDedupeMinutes: 10,
        imInteractive: true,
        imRequireInbound: true,
        imReplyWindowMinutes: 30,
        imMaxPerDay: 30,
        imMinIntervalMinutes: 1,
        imMaxChars: 40,
        imMaxMessages: 4,
        imChunkIntervalMs: 400,
      }
    }

    /** 归一一条面板里的机器人记录（逐字段显式 trim，绝不透传 undefined）。 */
    function normalizeImBot(b) {
      var out = {
        botId: String((b && b.botId) || '').trim(),
        appId: String((b && b.appId) || '').trim(),
        secretRef: String((b && b.secretRef) || '').trim(),
        alias: String((b && b.alias) || '').trim(),
        agentPreset: String((b && b.agentPreset) || '').trim(),
        cwd: String((b && b.cwd) || '').trim(),
        whitelist: Array.isArray(b && b.whitelist)
          ? b.whitelist.map(String).map(function (s) { return s.trim() }).filter(Boolean)
          : [],
        botCommands: (b && b.botCommands) !== false,
      }
      // per-bot 独立人设（story）必须在面板往返里透传。宿主的深合并在数组上做的是
      // **整体替换**而非逐字段合并（见 buildPayload 里那条实测结论），漏掉它就会在
      // 「保存设置」时把 per-bot story 静默抹掉——多 Bot 各自的角色人设直接丢失。
      var story = b && b.story
      if (story && typeof story === 'object' && !Array.isArray(story)) out.story = story
      return out
    }

    /** 配置里没有 bots 数组时，用顶层 appId/botId/secretRef 合成单条（向后兼容）。 */
    function synthesizeImBots(v) {
      var im = v && v.im ? v.im : {}
      return [{
        botId: typeof im.botId === 'string' && im.botId ? im.botId : 'qq',
        appId: typeof im.appId === 'string' ? im.appId : '',
        secretRef: typeof im.secretRef === 'string' && im.secretRef ? im.secretRef : 'DSH_QQBOT_APP_SECRET',
        alias: typeof im.alias === 'string' ? im.alias : '',
        agentPreset: '',
        cwd: '',
        whitelist: [],
        botCommands: true,
      }]
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
      // Urge / 时间导演：默认关，只有显式 true 才开（与 schema 一致）。
      d.urgeEnabled = !!(v.urge && v.urge.enabled === true)
      d.timelineDirectorEnabled = !!(v.timelineDirector && v.timelineDirector.enabled === true)
      d.autoAdvanceIntervalMinutes = v.runtime && Number.isFinite(v.runtime.autoAdvanceIntervalMinutes)
        ? v.runtime.autoAdvanceIntervalMinutes : 40
      // autoMessage 是总开关，deliverAutoAdvance 是老的兼容开关：展示为「都开才开」，
      // 否则设置了 deliverAutoAdvance:false 的老用户会在面板上看到「开着」却收不到消息。
      var im = v.im || {}
      d.autoMessage = im.autoMessage !== false && im.deliverAutoAdvance !== false
      d.messageIntervalMinutes = Number.isFinite(im.messageIntervalMinutes) ? im.messageIntervalMinutes : 120

      d.imEnabled = im.enabled === true
      // 多 Bot：有 bots 数组就用它；没有就用顶层字段合成一条（旧配置兼容）。
      d.imBots = Array.isArray(im.bots) && im.bots.length
        ? im.bots.map(normalizeImBot)
        : synthesizeImBots(v)
      // 顶层兼容字段与第一条 Bot 同步（面板主编辑器编辑的就是第一条）。
      var first = d.imBots[0] || { botId: 'qq', appId: '', secretRef: 'DSH_QQBOT_APP_SECRET', alias: '' }
      d.imAppId = typeof first.appId === 'string' ? first.appId : ''
      d.imSecretRef = typeof first.secretRef === 'string' && first.secretRef ? first.secretRef : 'DSH_QQBOT_APP_SECRET'
      d.imBotId = typeof first.botId === 'string' && first.botId ? first.botId : 'qq'
      // 自动新建会话用的角色预设与工作目录（决定「会话显不显示在你这个 workspace」）。
      d.imAgentPreset = typeof im.agentPreset === 'string' ? im.agentPreset : ''
      d.imCwd = typeof im.cwd === 'string' ? im.cwd : ''
      // 白名单式：任何非 loose 的值都按 strict 展示，与 schema 的归一保持一致。
      d.imSayFallback = im.sayFallback === 'loose' ? 'loose' : 'strict'
      // 表情包：目录与开关（缺省值与 schema 对齐）。
      d.imStickerDir = typeof im.stickerDir === 'string' ? im.stickerDir : ''
      d.imImagesEnabled = im.imagesEnabled !== false
      d.imHarvestInbound = im.harvestInbound !== false
      d.imFaceEnabled = im.faceEnabled !== false
      // 不用读 im.autoCreateSession / im.group.enabled：它们已是标准功能，
      // 面板没有对应控件。读了会得到「非 undefined」的标量，保存时反过来把
      // 功能写死成 false。让它们保持 undefined，保存时省略该键（见 buildPayload）。
      d.imInboundPrefix = im.inboundPrefix !== false
      var group = im.group || {}
      d.imGroupMentionOnly = group.mentionOnly !== false
      // 群聊意愿：只读面板管理的三个字段（其余保持 undefined → 不在 payload 里 →
      // 深合并保留用户手写的值，不会被面板覆盖掉）。
      var will = group.willingness || {}
      d.imGroupWillingness = will.enabled === true
      d.imGroupWillingnessThreshold = Number.isFinite(will.threshold) ? will.threshold : 0.24
      d.imGroupWillingnessCooldownSeconds = Number.isFinite(will.minReplyIntervalSeconds)
        ? will.minReplyIntervalSeconds : 0
      d.imDedupeMinutes = im.dedupe && Number.isFinite(im.dedupe.ttlMinutes) ? im.dedupe.ttlMinutes : 10

      var interactive = im.interactive || {}
      d.imInteractive = interactive.enabled !== false
      d.imRequireInbound = interactive.requireInbound !== false
      d.imReplyWindowMinutes = Number.isFinite(interactive.replyWindowMinutes) ? interactive.replyWindowMinutes : 30

      var proactive = im.proactive || {}
      d.imMaxPerDay = Number.isFinite(proactive.maxPerDay) ? proactive.maxPerDay : 30
      d.imMinIntervalMinutes = Number.isFinite(proactive.minIntervalMinutes) ? proactive.minIntervalMinutes : 1

      var chunking = im.chunking || {}
      d.imMaxChars = Number.isFinite(chunking.maxChars) ? chunking.maxChars : 40
      d.imMaxMessages = Number.isFinite(chunking.maxMessages) ? chunking.maxMessages : 4
      d.imChunkIntervalMs = Number.isFinite(chunking.minIntervalMs) ? chunking.minIntervalMs : 400
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

    /**
     * 把小数输入收进合法区间（用于阈值这类带小数的字段）。
     *
     * 与 parseMinutes 的区别：**不四舍五入**——意愿阈值 0.24 是合法的。
     *
     * @param {unknown} raw 输入框原始值。
     * @param {number} fallback 空输入时的回退值。
     * @param {number} min 下限（含）。
     * @param {number} max 上限（含）。
     */
    function parseFloatInRange(raw, fallback, min, max) {
      if (raw === undefined || raw === null || raw === '') return fallback
      var n = Number(raw)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    function buildPayload(draft, scalar) {
      /**
       * 多 Bot 的完整数组写入（D-1 的核心约束）。
       *
       * 宿主端 POST 走深合并（mergeLayers）：**数组元素不做深合并**，元素里漏一个
       * 字段 = 整个对象被替换、字段静默丢失（实测确认）。所以这里：
       *   1. 每次都送**完整数组**（`bots: scalar.imBots`）；
       *   2. 逐字段显式列出（不用展开运算符透传 `{...b}`——undefined 混入会让
       *      normalizeBotEntry 判为非法整条丢弃）；
       *   3. 空串显式送 `''`（清空才删得掉）。
       */
      var imBots = Array.isArray(scalar.imBots) ? scalar.imBots : []
      if (imBots.length === 0) {
        imBots = [{
          botId: scalar.imBotId,
          appId: scalar.imAppId,
          secretRef: scalar.imSecretRef,
          alias: '',
        }]
      }
      var bots = imBots.map(normalizeImBot)

      var payload = {
        timeZone: String(scalar.timeZone || '').trim(),
        gapNoticeMinutes: parseGapNotice(scalar.gapNoticeMinutes),
        alwaysReportTime: !!scalar.alwaysReportTime,
        proactive: { enabled: !!scalar.proactiveEnabled },
        agency: { enabled: !!scalar.agencyEnabled },
        alterSystem: { enabled: !!scalar.alterEnabled },
        schedulePreplan: { enabled: !!scalar.preplanEnabled },
        // 默认关的新开关：不勾 = 不送（走 schema 默认 false），勾了才写 true。
        ...(scalar.urgeEnabled ? { urge: { enabled: true } } : {}),
        ...(scalar.timelineDirectorEnabled ? { timelineDirector: { enabled: true } } : {}),
        runtime: {
          autoAdvanceEnabled: !!scalar.autoAdvanceEnabled,
          // schema 的下限是 5 分钟：更密的话每一轮续写都要真跑一次模型，没有意义。
          autoAdvanceIntervalMinutes: parseMinutes(scalar.autoAdvanceIntervalMinutes, 40, 5, 1440),
        },
        im: {
          autoMessage: !!scalar.autoMessage,
          // 0 是合法值（有话就发），下限因此是 0 而不是像写故事那样的 5。
          messageIntervalMinutes: parseMinutes(scalar.messageIntervalMinutes, 120, 0, 1440),

          /**
           * IM 通道。
           *
           * 注意这里**只写引用名**（`secretRef`），从不写 AppSecret 的值——
           * 值由凭据服务管理（`.credentials.yaml` / 环境变量），
           * 面板只负责指向它。这与本插件「配置里不放密钥」的设计一致。
           *
           * 顶层 appId/botId/secretRef 保留为兼容字段（与 bots[0] 同步），
           * 让旧调用点与旧配置继续工作；多 Bot 的真正载体是 `bots` 数组。
           */
          enabled: !!scalar.imEnabled,
          bots,
          appId: bots[0]?.appId ?? '',
          secretRef: bots[0]?.secretRef ?? 'DSH_QQBOT_APP_SECRET',
          botId: bots[0]?.botId ?? 'qq',
          // 自动新建会话用：角色预设 + 工作目录（workspace）。
          agentPreset: String(scalar.imAgentPreset || '').trim(),
          cwd: String(scalar.imCwd || '').trim(),
          // 面板只给两个选项；写错的值按 strict 处理（与 schema 的归一一致）。
          sayFallback: scalar.imSayFallback === 'loose' ? 'loose' : 'strict',
          // 表情包：目录留空交给宿主用默认目录（不要在这里填默认值——
          // 那会把「跟随默认」固化成一个绝对路径，以后改默认值就不生效了）。
          stickerDir: String(scalar.imStickerDir || '').trim(),
          imagesEnabled: !!scalar.imImagesEnabled,
          harvestInbound: !!scalar.imHarvestInbound,
          faceEnabled: !!scalar.imFaceEnabled,
          /**
           * 这两项已改为**标准功能**，不再在设置面板暴露。
           *
           * 关键：面板不再产生它们的值，所以这里**不能**写 `!!scalar.xxx`——
           * 那会把「面板没这个字段」误读成「用户关掉了它」，于是每次保存都把
           * 功能静默关掉（正好与「标准功能」相反）。
           *
           * 只在标量里确实拿到值时才写；否则**省略该键**，让 schema 的
           * 默认值（true）生效。这也保留了用户手改 settings.yaml 关闭它的退路。
           */
          ...(scalar.imAutoCreate === undefined ? {} : { autoCreateSession: scalar.imAutoCreate === true }),
          inboundPrefix: !!scalar.imInboundPrefix,
          group: {
            ...(scalar.imGroupEnabled === undefined ? {} : { enabled: scalar.imGroupEnabled === true }),
            mentionOnly: scalar.imGroupMentionOnly !== false,
            /*
             * 群聊意愿：**只写面板管的那三个字段**。
             *
             * 宿主端 POST 是深合并，所以 `willingness` 下没被写到的字段
             * （probabilityAmplifier / decayHalfLifeSeconds / replyCost / keywords …）
             * 会保留用户在 settings.yaml 里的手写值——面板不会把它们抹掉。
             * 反过来如果这里展开整个对象，就得把每个默认值也复制一份，
             * 以后上游调默认值就会和面板打架（踩过这个坑，见 autoCreateSession 的注释）。
             */
            willingness: {
              enabled: scalar.imGroupWillingness === true,
              threshold: parseFloatInRange(scalar.imGroupWillingnessThreshold, 0.24, 0, 10),
              minReplyIntervalSeconds: parseMinutes(scalar.imGroupWillingnessCooldownSeconds, 0, 0, 86400),
            },
          },
          dedupe: {
            ttlMinutes: parseMinutes(scalar.imDedupeMinutes, 10, 1, 1440),
          },
          interactive: {
            enabled: !!scalar.imInteractive,
            requireInbound: !!scalar.imRequireInbound,
            replyWindowMinutes: parseMinutes(scalar.imReplyWindowMinutes, 30, 1, 1440),
          },
          proactive: {
            maxPerDay: parseMinutes(scalar.imMaxPerDay, 30, 1, 200),
            minIntervalMinutes: parseMinutes(scalar.imMinIntervalMinutes, 1, 0, 1440),
          },
          chunking: {
            maxChars: parseMinutes(scalar.imMaxChars, 40, 1, 500),
            maxMessages: parseMinutes(scalar.imMaxMessages, 4, 1, 10),
            minIntervalMs: parseMinutes(scalar.imChunkIntervalMs, 400, 0, 10000),
          },
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
    function RuntimeStatusView(opts) {
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
        return jsx('div', { style: S.panel, className: 'hdsi' }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '运行状态（只读）' })]),
          jsx('div', { style: S.err, children: '读取运行状态失败：' + err }),
        ])
      }
      if (!data) {
        return jsx('div', { style: S.panel, className: 'hdsi' }, [
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
      var channel = data.channel || {}

      /**
       * IM 通道状态行。
       *
       * 这一项最容易静默失败：AppID 填错、密钥没配、SDK 没装，
       * 都不会报错，只会让角色不说话。所以把「连没连上、为什么没连上」
       * 直接摆出来，而不是等用户去翻日志。
       * 完整诊断卡与设置页「聊天」Tab 的压缩版共用同一份渲染。
       */
      function channelRows(ch) {
        // 最近一次入站路由的诊断。「收消息不回复」据此分诊：
        //   - null：SDK 从没把消息交进来（订阅/后台权限问题）
        //   - delivered：消息进了会话但模型没回应
        //   - ignore/error：路由环节丢弃
        // 注意：不能用 var inboundDiag = ch.lastInbound ? jsx(..., inboundDiag...) : null ——
        // 初始化表达式里自引用 inboundDiag 拿到的是 undefined（hoisting），
        // 一访问 inboundDiag.status 就崩，整个设置页变空白（线上事故）。
        var li = ch.lastInbound
        var inboundDiag = li
          ? jsx('div', { style: S.kv, key: 'ch-inbound' }, [
              jsx('span', { style: S.kvKey, children: '最近入站' }),
              jsx('span', { style: S.kvVal, children: 'status=' + String(li.status)
                + (li.reason ? ' (' + li.reason + ')' : '')
                + (li.senderId ? ' · 来自 ' + String(li.senderId).slice(0, 12) : '')
                + ' @ ' + String(li.at || '').slice(11, 19) }),
            ])
          : null
        return [
          jsx('div', { style: S.kv, key: 'ch-status' }, [
            jsx('span', { style: S.kvKey, children: '通道' }),
            jsx('span', { style: S.kvVal, children: ch.enabled !== true
              ? '未启用（到「聊天」页里打开开关）'
              : (ch.connected
                  ? '已连接 · AppID ' + (ch.appId || '—') + ' · 策略 ' + (ch.sayFallback || 'strict')
                  : (ch.started ? '连接中…' : '未启动' + (ch.appId ? '' : '（缺 AppID）'))) }),
          ]),
          ch.enabled !== true || ch.connected
            ? null
            : jsx('div', { style: S.kv, key: 'ch-reason' }, [
                jsx('span', { style: S.kvKey, children: '未连上的原因' }),
                // lastError 是插件启动时记录的真实失败原因（含 AppSecret 解析、
                // 凭据无效等）；只有从未启动过才落到下面的提示。
                jsx('span', { style: S.kvVal, children: ch.lastError
                  ? ch.lastError
                  : '通道尚未启动。若刚扫码绑定，请稍候或执行 /interlude im reconnect；若一直未启动，检查上方凭据设置。' }),
              ]),
          jsx('div', { style: S.kv, key: 'ch-stats' }, [
            jsx('span', { style: S.kvKey, children: '投递统计' }),
            jsx('span', { style: S.kvVal, children: '已绑定 ' + String(ch.bindings || 0) + ' 个会话 · 收 '
              + String(ch.inbound || 0) + ' 条 / 发 ' + String(ch.outbound || 0) + ' 条' }),
          ]),
          inboundDiag,
        ].filter(Boolean)
      }

      /**
       * 压缩版：只渲染「连接状态」几行，供设置页「聊天」Tab 使用。
       * 缺省（不传 compact）渲染完整诊断卡——测试与旧行为不变。
       */
      var compact = opts && opts.compact === true
      if (compact) {
        return jsx('div', { style: S.panel, className: 'hdsi' }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '连接状态' })]),
          jsx('div', { key: 'im' }, channelRows(channel)),
          jsx('div', { style: Object.assign({}, S.hint, { marginTop: 6 }), children: '数据来自 /api/hds-interlude/status，只读。' }),
        ])
      }

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

      return jsx('div', { style: S.panel, className: 'hdsi' }, [
        jsx('div', { style: S.panelHead, key: 'h' }, [
          jsx('div', { style: S.panelTitle, children: '运行状态（只读）' }),
          jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            jsx('span', { style: S.hint, children: '更新于 ' + clockText(tick) }),
            jsx('label', { style: { fontSize: 11, opacity: 0.65, display: 'flex', alignItems: 'center', gap: 4 } }, [
              jsx('input', { type: 'checkbox', style: checkStyle(auto), checked: auto, onChange: function (e) { setAuto(e.target.checked) } }),
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

        /**
         * IM 通道状态（完整诊断卡保留这一节；设置页「聊天」Tab 用上面的压缩版）。
         */
        jsx('div', { key: 'im' }, [
          jsx('div', { style: Object.assign({}, S.hint, { margin: '10px 0 4px' }), children: 'IM 机器人' }),
        ].concat(channelRows(channel))),

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

    /**
     * QQ 扫码绑定面板（聊天 Tab 用）。
     *
     * 与 dsh-im 对齐：手机 QQ 扫一下腾讯官方授权页，自动拿到 AppID/AppSecret，
     * 免去手动去开放平台创建、再把密钥贴进来的流程。扫码轮询由插件进程内的
     * connector SDK 完成，这里只负责「展示二维码 → 轮询状态 → 提示结果」。
     *
     * 端点：
     *   GET  /api/hds-interlude/qq-connect          → 当前状态（含 qrDataUrl）
     *   POST /api/hds-interlude/qq-connect          → 开始生成二维码
     *   POST /api/hds-interlude/qq-connect/cancel   → 取消
     */
    function QrConnectPanel() {
      var st = react.useState({ phase: 'idle', qrDataUrl: null, error: null })
      var state = st[0]
      var setState = st[1]

      /** 轮询定时器；phase 到终态（done/failed/cancelled）时停。 */
      var pollRef = react.useRef(null)
      /** 记住上次见到的二维码版本；服务器刷新二维码时用来提示「请扫新码」。null=还没见过码。 */
      var lastRevRef = react.useRef(null)

      var TERMINAL = { done: true, failed: true, cancelled: true }

      /**
       * 解析扫码接口的响应。
       *
       * 为什么不能直接 `r.json()`：后端若没加载新代码（请重启 DSH），
       * `/qq-connect` 路由不存在，响应体是空或 `not found` 文本——
       * `r.json()` 会抛 "Unexpected token 'o', ... is not valid JSON"，
       * 用户看到的是毫无线索的英文，而不是「该怎么修」。
       * 这里统一兜底：响应不是 JSON 时给一段可读的排查提示。
       */
      function readQrResponse(r) {
        return r.json().catch(function () {
          // 后端 404 / 空响应：说明 /qq-connect 路由没生效。
          return {
            ok: false,
            error: '扫码服务未就绪：插件后端可能还在跑旧代码。请重启 DSH（或 /interlude im 看通道状态）后再试。',
          }
        })
      }

      /**
       * 是否该停轮询。
       *
       * done 但还没有 lastApply（凭据落地报告）时**不算终态**：
       * 后端 onSuccess 先置 phase='done' 再 await 凭证落地，
       * lastApply 是异步回填的。若把 done 当终态立刻停轮询，
       * 用户就永远卡在「正在应用凭据…」看不到三环结果是✓还是✗。
       */
      function isTerminal(v) {
        if (v.phase === 'done') return Boolean(v.lastApply)
        return TERMINAL[v.phase] === true
      }

      /** 拉一次状态；非终态（含 done 但还没落地报告）时继续轮询（2 秒）。 */
      function pollOnce() {
        fetch('/api/hds-interlude/qq-connect')
          .then(readQrResponse)
          .then(function (d) {
            var v = d && d.ok ? (d.value || {}) : { phase: 'failed', error: (d && d.error) || '未知错误' }
            setState(v)
            if (!isTerminal(v) && !pollRef.current) {
              pollRef.current = setTimeout(function () { pollRef.current = null; pollOnce() }, 2000)
            }
          })
          .catch(function (e) {
            setState({ phase: 'failed', error: e && e.message ? e.message : String(e) })
          })
      }

      /** 开始扫码。begin 是服务端幂等的：重复点不会开第二个任务。 */
      function begin() {
        fetch('/api/hds-interlude/qq-connect', { method: 'POST' })
          .then(readQrResponse)
          .then(function (d) {
            var v = d && d.ok ? (d.value || {}) : { phase: 'failed', error: (d && d.error) || '未知错误' }
            setState(v)
            if (!isTerminal(v)) {
              pollRef.current = setTimeout(function () { pollRef.current = null; pollOnce() }, 2000)
            }
          })
          .catch(function (e) {
            setState({ phase: 'failed', error: e && e.message ? e.message : String(e) })
          })
      }

      /** 取消；随后回到 idle，允许再来一次。 */
      function cancel() {
        if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
        fetch('/api/hds-interlude/qq-connect/cancel', { method: 'POST' })
          .then(readQrResponse)
          .then(function (d) {
            var v = d && d.ok ? (d.value || {}) : { phase: 'cancelled' }
            setState(v)
          })
          .catch(function () { setState({ phase: 'idle', qrDataUrl: null, error: null }) })
      }

      // 挂载时探一次状态：面板刷新后若扫码还在进行，直接续上，不用重扫。
      react.useEffect(function () { pollOnce() }, [])

      if (state.phase === 'done') {
        // 凭据落地报告：写凭据 / 更新配置 / 重连通道 各步成败。
        // 这是用户问「扫码后是否正常写入」的直接答案，也解释了
        // 为什么有时会卡在「连接中」——重连那一步可能失败。
        var apply = state.lastApply
        var applyLines = []
        if (apply && typeof apply === 'object') {
          var cred = apply.credential
          var cfg = apply.config
          var rc = apply.reconnect
          if (cred) applyLines.push(jsx('div', { style: S.kv, key: 'lk-cred' },
            jsx('span', { style: S.kvVal, children: (cred.ok ? '✓ ' : '✗ ') + '写入凭据服务（' + String(apply.secretRef || '—') + '）' + (cred.error ? '：' + cred.error : '') }),
          ))
          if (cfg) applyLines.push(jsx('div', { style: S.kv, key: 'lk-cfg' },
            jsx('span', { style: S.kvVal, children: (cfg.ok ? '✓ ' : '✗ ') + '更新配置（AppID ' + String(state.credentials?.appId || '') + '）' + (cfg.error ? '：' + cfg.error : '') }),
          ))
          if (rc) applyLines.push(jsx('div', { style: S.kv, key: 'lk-rc' },
            jsx('span', { style: S.kvVal, children: (rc.ok ? '✓ ' : '✗ ') + '重连通道' + (rc.error ? '：' + rc.error : (rc.skipped ? '（' + rc.skipped + '）' : '')) }),
          ))
          if (apply.error) applyLines.push(jsx('div', { style: Object.assign({}, S.err, { marginTop: 4 }), key: 'lk-err' }, '落地失败：' + apply.error))
        }
        return jsx('div', { style: S.panel, key: 'qr', className: 'hdsi' }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '扫码绑定' })]),
          jsx('div', { style: S.kv }, [
            jsx('span', { style: S.kvKey, children: '结果' }),
            jsx('span', { style: Object.assign({}, S.kvVal, { color: '#5fbf7f' }), children: '已扫码，正在应用凭据…' }),
          ]),
          applyLines.length ? jsx('div', { key: 'apply', marginTop: 2 }, applyLines) : null,
          jsx('div', { style: S.hint, children: '应用完成即自动重连；若上方有 ✗，说明对应一步失败，请按提示处理后再试。' }),
        ])
      }

      if (state.phase === 'qr' || state.phase === 'starting') {
        // 二维码过期后服务器会自动刷新（qrRevision 递增）。扫旧码会失败——
        // 腾讯侧该任务已作废，手机上会显示「连接失败」。这里提示用户换新码。
        // 首次见码（lastRevRef 为 null）只记录不提示：那是正常的第一张码。
        var justRefreshed = false
        if (state.phase === 'qr') {
          if (lastRevRef.current !== null && state.qrRevision !== lastRevRef.current) {
            justRefreshed = true
          }
          lastRevRef.current = state.qrRevision
        }
        var qrImg = state.qrDataUrl
          ? jsx('img', { src: state.qrDataUrl, alt: 'QQ 扫码绑定二维码', style: { width: 160, height: 160, borderRadius: 8, border: '1px solid rgba(127,127,127,0.3)' } })
          : jsx('div', { style: { width: 160, height: 160, borderRadius: 8, border: '1px dashed rgba(127,127,127,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, opacity: 0.6 }, children: '二维码生成中…' })
        return jsx('div', { style: S.panel, key: 'qr', className: 'hdsi' }, [
          jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '扫码绑定' })]),
          jsx('div', { style: S.row }, [
            jsx('div', { style: { flex: '0 0 auto' } }, qrImg),
            jsx('div', { style: { flex: '1 1 auto' } }, [
              jsx('div', { style: { fontSize: 13, fontWeight: 600 }, children: state.phase === 'starting' ? '正在生成二维码…' : '用手机 QQ 扫一扫' }),
              justRefreshed
                ? jsx('div', { style: Object.assign({}, S.hint, { color: '#e8a33d', fontWeight: 600, marginBottom: 4 }), children: '二维码已刷新，请扫左侧的新码（旧码已失效）。' })
                : null,
              jsx('ol', { style: { fontSize: 12, opacity: 0.75, margin: '6px 0', paddingLeft: 18 } }, [
                jsx('li', { children: '打开手机 QQ，扫描左侧二维码' }),
                jsx('li', { children: '在腾讯授权页确认创建/绑定机器人' }),
                jsx('li', { children: '回到这里，等待连接完成（无需手填 AppID/AppSecret）' }),
              ]),
              state.error
                ? jsx('div', { style: Object.assign({}, S.err, { marginBottom: 6 }), children: String(state.error) })
                : null,
              jsx('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } }, [
                jsx('button', { style: S.smallBtn, onClick: cancel, children: '取消' }),
                jsx('span', { style: S.hint, children: '二维码有效期较短，请尽快扫码；超时自动刷新' }),
              ]),
            ]),
          ]),
        ])
      }

      // idle / failed / cancelled：给一个明显的开始按钮。
      // 若已配置过（重启后扫码状态虽丢，但配置与凭据已持久化），
      // 不再诱导重新扫码——直接告诉用户「已绑定、会随配置自动重连」。
      var conf = state.configured
      var alreadyBound = state.phase === 'idle' && conf && conf.configured === true
      return jsx('div', { style: S.panel, key: 'qr', className: 'hdsi' }, [
        jsx('div', { style: S.panelHead }, [jsx('div', { style: S.panelTitle, children: '扫码绑定' })]),
        alreadyBound
          ? jsx('div', { style: S.kv }, [
              jsx('span', { style: S.kvKey, children: '状态' }),
              jsx('span', { style: Object.assign({}, S.kvVal, { color: '#5fbf7f' }), children: '已绑定（AppID ' + String(conf.appId || '—') + '），无需重新扫码。' }),
            ])
          : jsx('div', { style: S.hint, children: '不用去开放平台手动创建：手机 QQ 扫码授权后，AppID 与 AppSecret 自动写入本机凭据服务。' }),
        alreadyBound
          ? jsx('div', { style: S.hint, children: '凭据与绑定都已落盘，重启 DSH 后通道会自动用它们重连。要换一个机器人再扫下面的按钮。' })
          : null,
        state.phase === 'failed'
          ? jsx('div', { style: Object.assign({}, S.err, { marginBottom: 8 }), children: '扫码失败：' + String(state.error || '未知错误') })
          : null,
        state.phase === 'cancelled'
          ? jsx('div', { style: Object.assign({}, S.hint, { color: '#5fbf7f', marginBottom: 8 }), children: '已取消。' })
          : null,
        jsx('button', { style: alreadyBound ? S.smallBtn : S.button, onClick: begin, children: alreadyBound ? '扫码添加新机器人' : '扫码绑定 QQ 机器人' }),
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

      // 「预设管理」重命名中的预设 id 与输入值。
      var renamingState = react.useState({ id: null, name: '' })
      var renaming = renamingState[0]
      var setRenaming = renamingState[1]
      var presetsState = react.useState([])
      var presets = presetsState[0]
      var setPresets = presetsState[1]

      /* Tab 状态（记住上次选的页）。必须和上面的 hook 一起放在最顶部：
       * 下面有 status==='loading' 的早退 return，hook 若放在 return 之后，
       * 首帧（loading）不会执行、重渲染（ready）才执行 —— React 会报
       * 「rendered more hooks than during the previous render」并让整页崩掉（白屏）。
       */
      var tabState = react.useState(lastTab())
      var tab = tabState[0]
      var setTab = tabState[1]
      var imAdvState = react.useState(false)
      var imAdv = imAdvState[0]
      var setImAdv = imAdvState[1]
      // 创作页「从预设载入」下拉当前选中的预设 id。
      var presetLoadState = react.useState('')
      var presetLoadId = presetLoadState[0]
      var setPresetLoadId = presetLoadState[1]
      // 创作页「新建预设」的名称输入。
      var newPresetNameState = react.useState('')
      var newPresetName = newPresetNameState[0]
      var setNewPresetName = newPresetNameState[1]
      // 机器人运行状态 + 最近检查时间（来自 /status 的 channel.bots）。
      var botStatusState = react.useState({ bots: [], at: 0 })
      var botStatus = botStatusState[0]
      var setBotStatus = botStatusState[1]
      // 当前展开二级面板的机器人 botId（null = 全部收起）。
      var openBotIdState = react.useState(null)
      var openBotId = openBotIdState[0]
      var setOpenBotId = openBotIdState[1]
      // 解绑进行中的 conversationKey（防连点）。
      var unbindingState = react.useState(null)
      var unbinding = unbindingState[0]
      var setUnbinding = unbindingState[1]
      // 正在发送测试消息的 conversationKey（防连点）。
      var imTestingState = react.useState(null)
      var imTesting = imTestingState[0]
      var setImTesting = imTestingState[1]
      // 目录选择器：{ bi, path, home, entries, error } 或 null（未打开）。
      var dirPickerState = react.useState(null)
      var dirPicker = dirPickerState[0]
      var setDirPicker = dirPickerState[1]
      // 表情库预览：{ dir, defaultDir, stats, list, error }。
      var stickerInfoState = react.useState({ dir: '', defaultDir: '', stats: null, list: [] })
      var stickerInfo = stickerInfoState[0]
      var setStickerInfo = stickerInfoState[1]
      var stickersLoadingState = react.useState(false)
      var stickersLoading = stickersLoadingState[0]
      var setStickersLoading = stickersLoadingState[1]
      // 导入待确认：{ name, story } 或 null（解析成功、等待用户确认新建预设）。
      var importCtxState = react.useState(null)
      var importCtx = importCtxState[0]
      var setImportCtx = importCtxState[1]

      /** 与已有预设不重名：冲突则加 -2/-3… 后缀。 */
      function uniquePresetName(existingNames, name) {
        var exists = new Set(existingNames.map(String).filter(Boolean))
        var base = String(name || '').trim() || '角色'
        if (!exists.has(base)) return base
        var i = 2
        while (exists.has(base + '-' + i)) i += 1
        return base + '-' + i
      }

      /** 拉取某目录的子目录列表（目录选择器用）。 */
      function fetchDirList(targetPath, bi) {
        fetch('/api/hds-interlude/fs/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: targetPath || '' }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setDirPicker({ bi: bi, path: d.path, home: d.home, entries: d.entries || [], error: null })
            } else {
              setDirPicker({ bi: bi, path: targetPath || '', home: '', entries: [], error: (d && d.error) || '无法读取目录' })
            }
          })
          .catch(function (e) { setDirPicker({ bi: bi, path: targetPath || '', home: '', entries: [], error: e && e.message ? e.message : String(e) }) })
      }

      /**
       * 选择工作区目录：优先用 DSH 的系统目录选择器（`pickDirectory`，host 侧弹窗、
       * 返回真实绝对路径）；不可用时回退到自建 fs/list 浏览弹窗。
       */
      function chooseWorkspaceDir(bot, bi) {
        if (pickerApi && typeof pickerApi.pickDirectory === 'function') {
          Promise.resolve()
            .then(function () { return pickerApi.pickDirectory() })
            .then(function (selected) {
              if (selected) { updateImBot(bi, 'cwd', String(selected)); setDirPicker(null) }
            })
            .catch(function (e) { setMessage({ kind: 'err', text: '选择目录失败：' + (e && e.message ? e.message : String(e)) }) })
          return
        }
        fetchDirList(bot.cwd, bi)
      }

      /** 全局默认工作区（im.cwd）的目录选择：同样优先系统选择器，回退弹窗。 */
      function chooseGlobalCwd() {
        if (pickerApi && typeof pickerApi.pickDirectory === 'function') {
          Promise.resolve()
            .then(function () { return pickerApi.pickDirectory() })
            .then(function (selected) {
              if (selected) { updateScalar('imCwd', String(selected)); setDirPicker(null) }
            })
            .catch(function (e) { setMessage({ kind: 'err', text: '选择目录失败：' + (e && e.message ? e.message : String(e)) }) })
          return
        }
        fetchDirList(scalar.imCwd, 'global')
      }

      /**
       * 表情包目录的目录选择：与工作区选择**同一套方式**
       * （优先 DSH 系统目录选择器，不可用时回退自建 fs/list 浏览弹窗）。
       *
       * 用 'sticker' 作为 dirPicker 的 target 标记，弹窗选中后写回 imStickerDir。
       */
      function chooseStickerDir() {
        if (pickerApi && typeof pickerApi.pickDirectory === 'function') {
          Promise.resolve()
            .then(function () { return pickerApi.pickDirectory() })
            .then(function (selected) {
              if (selected) { updateScalar('imStickerDir', String(selected)); setDirPicker(null) }
            })
            .catch(function (e) { setMessage({ kind: 'err', text: '选择目录失败：' + (e && e.message ? e.message : String(e)) }) })
          return
        }
        fetchDirList(scalar.imStickerDir, 'sticker')
      }

      /** 拉取表情库内容（供设置页展示缩略图）。 */
      function refreshStickers() {
        setStickersLoading(true)
        var target = scalar.imStickerDir || ''
        fetch('/api/hds-interlude/stickers' + (target ? ('?dir=' + encodeURIComponent(target)) : ''))
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setStickerInfo({ dir: d.dir, defaultDir: d.defaultDir, stats: d.stats, list: d.stickers || [] })
            } else {
              setStickerInfo({ dir: target, defaultDir: '', stats: null, list: [], error: (d && d.error) || '读取失败' })
            }
          })
          .catch(function (e) {
            setStickerInfo({ dir: target, defaultDir: '', stats: null, list: [], error: (e && e.message) || String(e) })
          })
          .then(function () { setStickersLoading(false) })
      }

      /**
       * 拉取机器人运行状态（连接绿/红点、投递目标列表）并记录检查时间。
       * 挂载、保存成功后、解绑后都刷新。
       */
      function refreshBotStatus() {        fetch('/api/hds-interlude/status')
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setBotStatus({ bots: (d.value && d.value.channel && d.value.channel.bots) || [], at: Date.now() })
            }
          })
          .catch(function () {})
      }

      /** 某个 botId 的运行状态（找不到返回 undefined）。 */
      function botStatusOf(botId) {
        for (var i = 0; i < botStatus.bots.length; i++) {
          if (botStatus.bots[i].botId === botId) return botStatus.bots[i]
        }
        return undefined
      }

      /** 解绑该机器人的一条投递目标（双向同步消息关系），成功后刷新状态。 */
      function unbindTarget(botId, conversationKey) {
        if (unbinding) return
        setUnbinding(conversationKey)
        fetch('/api/hds-interlude/qq-im/unbind', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId: botId, conversationKey: conversationKey }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            setUnbinding(null)
            if (d && d.ok && d.removed) {
              refreshBotStatus()
              setMessage({ kind: 'ok', text: '已解绑 ' + conversationKey + '。之后该聊天会重新自动建会话。' })
            } else {
              setMessage({ kind: 'err', text: '解绑失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setUnbinding(null); setMessage({ kind: 'err', text: '解绑失败：' + (e && e.message ? e.message : String(e)) }) })
      }

      /**
       * 发送一条测试消息，确认这条投递目标能不能真的收到。
       *
       * 走**真实投递链路**（后端 deliverToIm → 分条 → 通道），不是模拟：
       * 失败时把具体原因（没绑定 / 通道没启动 / 平台拒绝）如实显示出来，
       * 而不是笼统报一句「失败」——这类静默失败正是最难排查的。
       */
      function sendImTest(botId, conversationKey) {
        if (imTesting) return
        setImTesting(conversationKey)
        setMessage({ kind: 'ok', text: '正在发送测试消息…' })
        fetch('/api/hds-interlude/im-test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botId: botId, conversationKey: conversationKey }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            setImTesting(null)
            if (d && d.ok) {
              setMessage({
                kind: 'ok',
                text: '测试消息已发出（' + d.sentCount + '/' + d.total + ' 条 → ' + (d.target && d.target.conversationKey) + '）。'
                  + '如果 QQ 那边没收到，检查机器人是否被对方拉黑/免打扰，或通道是否在线。',
              })
              return
            }
            setMessage({ kind: 'err', text: '测试消息发送失败：' + ((d && d.error) || '未知错误') })
          })
          .catch(function (e) {
            setImTesting(null)
            setMessage({ kind: 'err', text: '测试消息发送失败：' + (e && e.message ? e.message : String(e)) })
          })
      }

      function refreshPresets() {
        fetch('/api/hds-interlude/presets')
          .then(function (r) { return r.json() })
          .then(function (d) { if (d && d.ok && Array.isArray(d.presets)) setPresets(d.presets) })
          .catch(function () {})
      }
      react.useEffect(function () { refreshPresets() }, [])
      react.useEffect(function () { refreshBotStatus() }, [])

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

      /**
       * 更新第 i 个机器人的一条字段（多 Bot 列表编辑）。
       *
       * 用函数式更新（同 updateScalar 的理由：同一 tick 内的连续输入不互相覆盖）。
       * i=0 时同步镜像到顶层兼容字段（imAppId/imSecretRef/imBotId/imAlias），
       * 让 buildPayload 之外的旧读取点也看到最新值。
       */
      function updateImBot(i, field, value) {
        setScalar(function (prev) {
          var next = Object.assign({}, prev)
          var bots = Array.isArray(prev.imBots) ? prev.imBots.slice() : []
          if (!bots[i]) bots[i] = { botId: '', appId: '', secretRef: '', alias: '' }
          bots[i] = Object.assign({}, bots[i])
          bots[i][field] = value
          next.imBots = bots
          if (i === 0) {
            if (field === 'appId') next.imAppId = value
            else if (field === 'secretRef') next.imSecretRef = value
            else if (field === 'botId') next.imBotId = value
          }
          return next
        })
        setDirty(true)
      }

      /** 添加一个机器人（上限 5，QQ 开放平台约束）。 */
      function addImBot() {
        setScalar(function (prev) {
          var bots = Array.isArray(prev.imBots) ? prev.imBots.slice() : []
          if (bots.length >= 5) return prev
          bots.push({ botId: '', appId: '', secretRef: '', alias: '' })
          return Object.assign({}, prev, { imBots: bots })
        })
        setDirty(true)
      }

      /** 删除第 i 个机器人（至少保留 1 个）。 */
      function removeImBot(i) {
        setScalar(function (prev) {
          var bots = Array.isArray(prev.imBots) ? prev.imBots.slice() : []
          if (bots.length <= 1) return prev
          bots.splice(i, 1)
          var next = Object.assign({}, prev, { imBots: bots })
          // 删掉的是第一条时，顶层兼容字段同步到新第一条。
          var first = bots[0] || { botId: 'qq', appId: '', secretRef: 'DSH_QQBOT_APP_SECRET', alias: '' }
          next.imAppId = first.appId
          next.imSecretRef = first.secretRef
          next.imBotId = first.botId
          return next
        })
        setDirty(true)
        // 明确提示：删除只是从**本页草稿**移除，必须点「保存」才会真正断开该机器人的连接。
        setMessage({ kind: 'ok', text: '已从列表移除。点「保存」后该机器人的连接才会断开并生效。' })
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
            if (d && d.ok) {
              setDirty(false)
              setMessage({ kind: 'ok', text: '已保存，下一次回复生效。' })
              // 机器人列表/连接状态可能变了（增删 bot），刷新卡片状态。
              refreshBotStatus()
              // 草稿来自某个预设（下拉选中）→ 同步更新该预设，让修改直接对它生效。
              if (presetLoadId && presetLoadId !== '__new__') {
                updatePresetFromDraft(presetLoadId)
              }
            }
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

      /* ---- 预设管理：重命名（新建/载入在创作页） ---- */

      function startRename(preset) {
        setRenaming({ id: preset && preset.id, name: String((preset && preset.name) || '') })
      }

      function cancelRename() {
        setRenaming({ id: null, name: '' })
      }

      function confirmRename() {
        var nm = String(renaming.name || '').trim()
        if (!renaming.id) return
        if (!nm) { setMessage({ kind: 'err', text: '预设名不能为空' }); return }
        fetch('/api/hds-interlude/presets', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: renaming.id, name: nm }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setRenaming({ id: null, name: '' })
              setMessage({ kind: 'ok', text: '已重命名为「' + nm + '」' })
              refreshPresets()
            } else {
              setMessage({ kind: 'err', text: '重命名失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '重命名失败：' + (e && e.message ? e.message : String(e)) }) })
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

      /**
       * 读取预设：把某个已保存预设的 story 设定填回创作表单草稿。
       *
       * 只改草稿、不自动保存——用户确认后点「保存」才生效（与「重置本页」同一契约，
       * 避免读取动作悄悄把磁盘上的配置改掉）。
       */
      function onLoadPreset(preset) {
        if (!preset || typeof preset.id !== 'string') return
        fetch('/api/hds-interlude/preset?id=' + encodeURIComponent(preset.id))
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok && d.story) {
              setDraft(cloneStory(d.story))
              setDirty(true)
              setMessage({ kind: 'ok', text: '已把预设「' + String(preset.name || '') + '」的设定填入草稿，点「保存」生效。' })
            } else {
              setMessage({ kind: 'err', text: '读取预设失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '读取预设失败：' + (e && e.message ? e.message : String(e)) }) })
      }

      /**
       * 新建预设：把**当前草稿**直接保存为一个新预设（创作页「＋ 新建预设」入口）。
       *
       * 与预设页的「保存当前设定为预设」不同：那里保存的是服务端已生效配置的 story，
       * 这里把正在编辑的草稿存进去——刚写完的角色设定不用先点「保存」就能存成预设。
       */
      /**
       * 导入酒馆角色卡文件：解析成功 → 填入创作草稿 + 显示「导入为预设」确认条
       * （默认新建预设，名字 = 角色名，可改，重名自动加 -2 后缀）。
       */
      function handleImportFile(file) {
        if (!file) return
        if ((file.size || 0) > 10 * 1024 * 1024) {
          setMessage({ kind: 'err', text: '文件过大（超过 10MB），已放弃。' })
          return
        }
        var fileName = String(file.name || '')
        Promise.resolve()
          .then(function () { return file.arrayBuffer() })
          .then(function (buf) { return tcParseFile(new Uint8Array(buf), fileName) })
          .then(function (card) {
            var story = tcToStory(card)
            var roleName = String(story.character && story.character.name ? story.character.name : '').trim()
              || fileName.replace(/\.[^.]+$/, '').trim()
              || '角色'
            setDraft(cloneStory(story))
            setDirty(true)
            // 默认名去重；用户可改，提交时再次去重。
            setImportCtx({ name: uniquePresetName((presets || []).map(function (p) { return p.name }), roleName), story: story })
          })
          .catch(function (e) {
            setMessage({ kind: 'err', text: '导入失败：' + (e && e.message ? e.message : String(e)) })
          })
      }

      /**
       * 确认导入：以输入的名字新建预设（重名自动加后缀），并选中它。
       */
      function doCreateFromImport() {
        if (!importCtx) return
        var finalName = uniquePresetName((presets || []).map(function (p) { return p.name }), importCtx.name)
        fetch('/api/hds-interlude/presets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: finalName, story: importCtx.story }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setImportCtx(null)
              setPresetLoadId(d.preset && d.preset.id ? d.preset.id : '')
              setMessage({ kind: 'ok', text: '已导入角色卡并新建预设「' + finalName + '」（点「保存」把设定写入全局配置）。' })
              refreshPresets()
            } else {
              setMessage({ kind: 'err', text: '导入/新建预设失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) {
            setMessage({ kind: 'err', text: '导入/新建预设失败：' + (e && e.message ? e.message : String(e)) })
          })
      }

      /**
       * 导出酒馆 JSON 角色卡（当前草稿 → 下载 .tavern.json）。
       */
      function exportCardDownload() {
        var card = tcToCard(draft)
        var json = JSON.stringify(card, null, 2)
        var blob = new Blob([json], { type: 'application/json' })
        var url = URL.createObjectURL(blob)
        var name = (draft.character && draft.character.name) ? String(draft.character.name).trim() : '角色'
        var a = document.createElement('a')
        a.href = url
        a.download = name + '.tavern.json'
        if (document.body) document.body.appendChild(a)
        a.click()
        if (a.remove) a.remove()
        URL.revokeObjectURL(url)
        setMessage({ kind: 'ok', text: '已导出酒馆角色卡 ' + name + '.tavern.json（可在 SillyTavern 导入）。' })
      }

      /**
       * 把当前草稿写回已保存的预设（PUT /presets）。
       * 创作页「载入预设 → 修改 → 点保存」直接对该预设生效。
       */
      function updatePresetFromDraft(id) {
        fetch('/api/hds-interlude/presets', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id, story: draft }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setMessage({ kind: 'ok', text: '已保存，并更新到预设「' + String((d.preset && d.preset.name) || '') + '」' })
              refreshPresets()
            } else {
              setMessage({ kind: 'err', text: '已保存到全局配置，但更新预设失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '已保存到全局配置，但更新预设失败：' + (e && e.message ? e.message : String(e)) }) })
      }

      function onCreatePreset() {
        var nm = String(newPresetName || '').trim()
        if (!nm) { setMessage({ kind: 'err', text: '请先填预设名称' }); return }
        fetch('/api/hds-interlude/presets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: nm, story: draft }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setNewPresetName('')
              setPresetLoadId('')
              setMessage({ kind: 'ok', text: '已把当前草稿保存为预设「' + nm + '」' })
              refreshPresets()
            } else {
              setMessage({ kind: 'err', text: '创建预设失败：' + ((d && d.error) || '未知错误') })
            }
          })
          .catch(function (e) { setMessage({ kind: 'err', text: '创建预设失败：' + (e && e.message ? e.message : String(e)) }) })
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

      /* ---------- Tab 内容 ---------- */
      var children = []

      function renderTabBar() {
        return jsx('div', { style: S.tabs }, TABS.map(function (t) {
          return jsx('button', {
            key: t.id,
            style: t.id === tab ? S.tabActive : S.tab,
            onClick: function () { setTab(t.id); storeTab(t.id) },
            children: t.label,
          })
        }))
      }

      /* ============ Tab：创作（人设与剧情） ============ */
      if (tab === 'story') {
        // 从已保存的预设载入：下拉选择即读取，把设定填进下面的创作草稿。
        // 下拉末尾有「＋ 新建预设」：把当前草稿直接存成新预设。
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '载入预设' }, [
          jsx('div', { style: S.heading, children: '从预设载入' }),
          jsx('select', {
            style: S.input,
            value: presetLoadId,
            onChange: function (e) {
              var id = e.target.value
              setPresetLoadId(id)
              if (!id) return
              if (id === '__new__') {
                // 新建预设：从**空白草稿**开始——避免把旧角色的设定误存进新预设。
                // 清空后用户新写的内容会在点「创建预设」时被保存。
                setDraft(emptyStory())
                setDirty(true)
                setMessage({ kind: 'ok', text: '已清空草稿，开始编辑新预设的设定；填好后点「创建预设」。' })
                return
              }
              var preset = presets.find(function (p) { return p.id === id })
              onLoadPreset(preset || { id: id, name: '' })
            },
          }, [
            jsx('option', { value: '', children: '— 选择已保存的预设，载入其设定 —' }),
          ].concat(presets.map(function (p) {
            return jsx('option', { key: p.id, value: p.id, children: p.name || p.id })
          })).concat([
            jsx('option', { key: '__new__', value: '__new__', children: '＋ 新建预设…' }),
          ])),
          presetLoadId === '__new__'
            ? jsx('div', { style: { marginTop: 8 } }, [
                jsx('div', { style: S.row }, [
                  jsx('div', { style: S.cell }, [
                    jsx('label', { style: S.label, children: '新预设名称' }),
                    jsx('input', { type: 'text', style: S.input, value: newPresetName, placeholder: '例如：雨夜来信', onChange: function (e) { setNewPresetName(e.target.value) } }),
                  ]),
                  jsx('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', marginBottom: 12 } }, [
                    jsx('button', { style: S.button, onClick: onCreatePreset, children: '创建预设' }),
                  ]),
                ]),
                jsx('div', { style: S.hint, children: '把当前草稿直接保存为新预设（不必先点「保存」）。' }),
              ])
            : null,
          jsx('div', { style: S.hint, children: '把某个已保存预设的角色设定填入下方草稿（不自动保存，点「保存」生效）。在「预设」页可删除预设。' }),
        ]))

        // 导入 / 导出（酒馆角色卡文件）。
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '导入导出' }, [
          jsx('div', { style: S.heading, children: '导入 / 导出（兼容酒馆角色卡）' }),
          // 导出：当前草稿 → .tavern.json。
          jsx('div', { style: { marginBottom: 8 } }, [
            jsx('button', { style: S.button, onClick: exportCardDownload, children: '导出 JSON 角色卡' }),
            jsx('div', { style: S.hint, children: '把当前草稿导出为酒馆（SillyTavern）可导入的角色卡 .json（含完整幕间设定备份）。' }),
          ]),
          // 导入：拖放方框 + 点击选文件。
          jsx('div', {
            style: {
              border: '2px dashed rgba(127,127,127,0.45)',
              borderRadius: 8,
              padding: '16px 12px',
              textAlign: 'center',
              cursor: 'pointer',
              fontSize: 12,
              color: 'inherit',
              opacity: 0.9,
            },
            onClick: function () {
              var el = document && document.getElementById ? document.getElementById('hds-interlude-card-input') : null
              if (el) el.click()
            },
            // 拖放必须在这一整条链上同时 preventDefault + stopPropagation：
            // 不 preventDefault，浏览器会「打开」拖进来的文件（SPA 里直接导航走、白屏/卡死）；
            // 不 stopPropagation，事件会冒泡到 DSH 壳自己的 drop 处理（把文件当别的用途吃进去）。
            onDragEnter: function (e) {
              if (e && e.preventDefault) e.preventDefault()
              if (e && e.stopPropagation) e.stopPropagation()
            },
            onDragOver: function (e) {
              if (e && e.preventDefault) e.preventDefault()
              if (e && e.stopPropagation) e.stopPropagation()
              if (e && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
            },
            onDragLeave: function (e) {
              if (e && e.preventDefault) e.preventDefault()
              if (e && e.stopPropagation) e.stopPropagation()
            },
            onDrop: function (e) {
              if (e && e.preventDefault) e.preventDefault()
              if (e && e.stopPropagation) e.stopPropagation()
              var files = e && e.dataTransfer && e.dataTransfer.files
              if (files && files.length) handleImportFile(files[0])
            },
            children: '把角色卡（.json / .png）拖到这里，或点击选择文件',
          }),
          jsx('input', {
            type: 'file', id: 'hds-interlude-card-input', accept: '.json,.png', style: { display: 'none' },
            onChange: function (e) {
              var f = e && e.target && e.target.files && e.target.files[0]
              if (f) handleImportFile(f)
              if (e && e.target) e.target.value = ''
            },
          }),
          // 导入确认条：解析成功后默认新建预设（名字 = 角色名，可改，重名 -2 后缀）。
          importCtx
            ? jsx('div', { style: { marginTop: 8, border: '1px solid rgba(95,155,232,0.5)', borderRadius: 6, padding: 8, background: 'rgba(95,155,232,0.06)' } }, [
                jsx('label', { style: S.label, children: '导入为预设（默认角色名；重名自动加 -2 后缀）' }),
                jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                  jsx('input', {
                    type: 'text', style: Object.assign({}, S.input, { flex: '1 1 auto' }),
                    value: importCtx.name, spellCheck: false,
                    onChange: function (e) { setImportCtx(Object.assign({}, importCtx, { name: e.target.value })) },
                  }),
                  jsx('button', { style: S.button, onClick: doCreateFromImport, children: '导入并新建预设' }),
                  jsx('button', { style: S.smallBtn, onClick: function () { setImportCtx(null) }, children: '取消' }),
                ]),
              ])
            : null,
          jsx('div', { style: S.hint, children: '支持酒馆角色卡 JSON 与 PNG（tEXt/zTXt chara）。导入会新建预设（默认用角色名），并载入下方草稿；文件只在浏览器内存解析，不上传。' }),
        ]))
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
          children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: group }, [jsx('div', { style: S.heading, children: group })].concat(fieldEls)))
        }
      }

      /* ============ Tab：节奏（行为节律） ============ */
      if (tab === 'rhythm') {
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '时间' }, [
          jsx('div', { style: S.heading, children: '时间' }),
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
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.alwaysReportTime), checked: scalar.alwaysReportTime, onChange: function (e) { updateScalar('alwaysReportTime', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '每回合都注入当前时间' }),
          ]),
        ]))

        /**
         * 消息节奏：两块节奏分开。
         * 「写故事」决定多久续写一段生活（留在 DSH 里，是叙事），
         * 「发消息」决定多久允许把角色的发言真发到聊天软件。合成一个数字的话，
         * 用户只能二选一：要么故事够密、消息太吵，要么消息够静、故事断档。
         */
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '消息节奏' }, [
          jsx('div', { style: S.heading, children: '消息节奏' }),
          jsx('div', { style: S.hint, children: '故事续写只留在 DSH 里；只有角色单独成行、用引号写出来的那句话才会发给用户。' }),
          jsx('div', { style: S.row }, [
            jsx('div', { style: S.cell }, [
              jsx('label', { style: S.label, children: '写故事间隔（分钟）' }),
              jsx('input', { type: 'number', style: S.input, min: 5, value: scalar.autoAdvanceIntervalMinutes, onChange: function (e) { updateScalar('autoAdvanceIntervalMinutes', e.target.value) } }),
              jsx('div', { style: S.hint, children: '无对话时，每隔多久续写一段角色的生活。默认 40。' }),
            ]),
            jsx('div', { style: S.cell }, [
              jsx('label', { style: S.label, children: '发消息间隔（分钟）' }),
              jsx('input', { type: 'number', style: S.input, min: 0, value: scalar.messageIntervalMinutes, onChange: function (e) { updateScalar('messageIntervalMinutes', e.target.value) } }),
              jsx('div', { style: S.hint, children: '两次自动发消息之间至少隔多久。填 0 = 每轮有话就发。默认 120。到点的提醒不受它限制。' }),
            ]),
          ]),
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.autoMessage), checked: scalar.autoMessage, onChange: function (e) { updateScalar('autoMessage', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '故事里角色的发言自动发出去（关掉 = 只写故事，不打扰；到点提醒仍会送达）' }),
          ]),
        ]))

        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '功能' }, [
          jsx('div', { style: S.heading, children: '功能开关' }),
          jsx('div', { style: S.grid2 }, [
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.proactiveEnabled), checked: scalar.proactiveEnabled, onChange: function (e) { updateScalar('proactiveEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '主动联系' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.autoAdvanceEnabled), checked: scalar.autoAdvanceEnabled, onChange: function (e) { updateScalar('autoAdvanceEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '写故事（自动续写）' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.agencyEnabled), checked: scalar.agencyEnabled, onChange: function (e) { updateScalar('agencyEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '主体行动窗口' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.alterEnabled), checked: scalar.alterEnabled, onChange: function (e) { updateScalar('alterEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '情绪偏移（Alter）' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.preplanEnabled), checked: scalar.preplanEnabled, onChange: function (e) { updateScalar('preplanEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '近期日程' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.urgeEnabled), checked: scalar.urgeEnabled, onChange: function (e) { updateScalar('urgeEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: 'Urge 弹性推进' }),
            ]),
            jsx('div', { style: S.toggle }, [
              jsx('input', { type: 'checkbox', style: checkStyle(scalar.timelineDirectorEnabled), checked: scalar.timelineDirectorEnabled, onChange: function (e) { updateScalar('timelineDirectorEnabled', e.target.checked) } }),
              jsx('span', { style: S.toggleLabel, children: '时间导演' }),
            ]),
          ]),
          jsx('div', { style: S.hint, children: '悬停解释：主动联系=到期待办时角色会自己开口；写故事=无对话时续写角色生活；行动窗口=日程/隐私/设备约束；情绪偏移=氛围追踪；近期日程=周规律+例外；Urge 弹性推进=推进节奏随消息热度伸缩；时间导演=自动推进时生成事件账本对齐时间线。' }),
        ]))
      }

      /* ============ Tab：聊天（通道与消息行为） ============ */
      if (tab === 'chat') {
        // 连接状态：最容易静默失败的一项，摆在最上面。
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '连接状态' }, [
          jsx('div', { style: S.heading, children: '连接状态' }),
          jsx(RuntimeStatusView, { compact: true, key: 'status-compact' }),
        ]))

        // 扫码绑定：与 dsh-im 对齐，免手填凭据。
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '扫码绑定' }, [
          jsx(QrConnectPanel, { key: 'qr-connect' }),
        ]))

        // 多 Bot 小卡片（对齐 dsh-im 的 AccountCard + 齿轮二级面板）：
        // 卡片只显示「别名 + 状态点 + 最近检查时间 + ⚙」，点 ⚙ 展开二级面板
        // （AppID / 别名 / 工作区 / 角色预设下拉 / 投递目标 / 白名单）。
        // 必须用独立函数渲染：`var bi` 是函数作用域，循环体内闭包会共享最后一个 bi。
        function shortBotName(bot) {
          return bot.alias
            || (String(bot.botId || '').length > 12 ? String(bot.botId).slice(0, 12) + '…' : String(bot.botId || '未命名'))
        }
        function renderBotCard(bot, bi) {
          var st = botStatusOf(bot.botId)
          // 状态语义（dsh-im 的 BotStatusMeta 同款）：绿=已连接 / 黄=连接中 /
          // 红=未启动或出错（有 lastError 一律红）/ 灰=暂无状态数据。
          // title 让鼠标悬停就能看到「为什么是这个颜色」——红点最常见的原因是
          // 凭据解析失败（AppSecret 未配）或 SDK 断线重连中。
          var stateLabel = '未启动'
          var dotStyle = S.dotRed
          if (!st) { stateLabel = '状态未知'; dotStyle = S.dotGray }
          else if (st.ready) { stateLabel = '已连接'; dotStyle = S.dotGreen }
          else if (st.started) { stateLabel = '连接中'; dotStyle = S.dotYellow }
          if (st && st.lastError) { stateLabel = '出错'; dotStyle = S.dotRed }
          var dotTitle = stateLabel
          if (st && st.lastError) dotTitle = '出错：' + errText(st.lastError)
          else if (!st) dotTitle = '暂无状态数据（未连接服务）'
          var isOpen = openBotId === bot.botId
          var checked = botStatus.at ? '检查于 ' + clockText(botStatus.at) : '检查于 —'
          return jsx('div', {
            key: 'bot-' + bi,
            style: Object.assign({}, S.botCard, isOpen ? S.botCardOpen : {}),
          }, [
            jsx('div', { style: S.botCardHead, onClick: function () { setOpenBotId(isOpen ? null : bot.botId) } }, [
              jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0 } }, [
                jsx('span', { style: dotStyle, title: dotTitle }),
                jsx('span', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortBotName(bot)),
                // 状态文本：红点旁边直接写明「出错」，配合悬停 title 看原因。
                jsx('span', {
                  style: Object.assign({ fontSize: 11, flex: '0 0 auto' }, st && st.lastError ? { color: '#e88888' } : { opacity: 0.55 }),
                  title: dotTitle,
                  children: '· ' + stateLabel,
                }),
                jsx('span', { style: { fontSize: 11, opacity: 0.5, flex: '0 0 auto' } }, 'AppID ' + String(bot.appId || '—')),
              ]),
              jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
                jsx('span', { style: { fontSize: 11, opacity: 0.5 } }, checked),
                jsx('button', {
                  style: S.gearBtn,
                  'aria-label': isOpen ? '收起设置' : '打开设置',
                  // e 在测试替身里可能不传（无真实事件对象），stopPropagation 需防御。
                  onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); setOpenBotId(isOpen ? null : bot.botId) },
                  children: '⚙',
                }),
              ]),
            ]),
            isOpen ? renderBotDetails(bot, bi, st) : null,
          ])
        }

        /** 目录选择器弹窗（modal）：遮罩 + 居中面板，点遮罩或取消关闭。 */
        function renderDirPickerModal() {
          if (!dirPicker) return null
          var p = dirPicker
          var shown = (p.entries || []).filter(function (e) { return !e.hidden })
          var hiddenCount = (p.entries || []).length - shown.length
          var close = function () { setDirPicker(null) }
          var applyPath = function (path) {
            if (p.bi === 'global') {
              updateScalar('imCwd', path)
            } else if (p.bi === 'sticker') {
              updateScalar('imStickerDir', path)
            } else {
              updateImBot(p.bi, 'cwd', path)
            }
            setDirPicker(null)
          }
          // 上一级目录（去掉末尾一段；盘符根不动）。
          var parentPath = function (path) {
            if (!path) return path
            var norm = String(path).replace(/[\\/]+$/, '')
            var idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'))
            return idx <= 0 ? norm : norm.slice(0, idx)
          }
          // 快速访问（Windows 资源管理器侧边栏）：后端给的标准目录；缺省补主目录。
          var quick = (p.quick && p.quick.length)
            ? p.quick
            : (p.home ? [{ name: '主目录', path: p.home }] : [])
          // Windows 资源管理器观感：浅色面板自成一体（深色页面里是它自己的窗口）。
          var W = {
            head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid #d9d9d9', background: '#e8e8e8', borderTopLeftRadius: 8, borderTopRightRadius: 8 },
            title: { fontSize: 13, fontWeight: 600, color: '#1a1a1a' },
            bar: { display: 'flex', gap: 6, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid #d9d9d9', background: '#f0f0f0' },
            addr: { flex: '1 1 auto', boxSizing: 'border-box', padding: '4px 8px', border: '1px solid #b5b5b5', borderRadius: 3, font: 'inherit', fontSize: 12, color: '#1a1a1a', background: '#fff' },
            btn: { background: '#f5f5f5', color: '#1a1a1a', border: '1px solid #b0b0b0', borderRadius: 3, padding: '3px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
            body: { display: 'flex', flex: '1 1 auto', minHeight: 230 },
            sidebar: { width: 148, flex: '0 0 auto', borderRight: '1px solid #d9d9d9', background: '#fafafa', overflowY: 'auto', padding: '4px 0' },
            quickItem: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 10px', fontSize: 12, cursor: 'pointer', background: 'transparent', border: 'none', color: '#1a1a1a', textAlign: 'left', font: 'inherit' },
            quickActive: { background: '#e5f1fb', outline: '1px solid #cce4f7' },
            grid: { flex: '1 1 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 2, padding: 8, overflowY: 'auto', alignContent: 'start', background: '#fff' },
            tile: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 4px', cursor: 'pointer', background: 'transparent', border: '1px solid transparent', borderRadius: 3, color: '#1a1a1a', font: 'inherit', fontSize: 11, minWidth: 0 },
            tileSel: { background: '#e5f1fb', borderColor: '#cce4f7' },
            icon: { fontSize: 22, lineHeight: 1 },
            fname: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' },
            footer: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderTop: '1px solid #d9d9d9', background: '#f0f0f0', borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
            status: { fontSize: 11, color: '#555', flex: '1 1 auto', wordBreak: 'break-all', minWidth: 0 },
            err: { color: '#c42b1c', fontSize: 12, padding: '6px 10px', background: '#fff' },
            closeX: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: '#555', padding: '0 4px' },
          }
          return jsx('div', {
            style: {
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.45)', zIndex: 1000,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            // 点遮罩关闭（e 在测试替身里可能不传，防御）。
            onClick: function (e) { if (!e || e.target === e.currentTarget) close() },
          }, [
            jsx('div', {
              style: {
                background: '#f5f5f5', color: '#1a1a1a',
                border: '1px solid #7a7a7a', borderRadius: 8,
                width: 540, maxWidth: '94vw', maxHeight: '84vh',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 10px 36px rgba(0,0,0,0.55)',
              },
            }, [
              // 标题栏（资源管理器窗口标题）。
              jsx('div', { style: W.head }, [
                jsx('span', { style: W.title, children: '选择工作区目录' }),
                jsx('button', { style: W.closeX, onClick: close, children: '✕' }),
              ]),
              // 地址栏：上一级 + 路径输入 + 前往（刷新）。
              jsx('div', { style: W.bar }, [
                jsx('button', { style: W.btn, title: '上一级', onClick: function () { fetchDirList(parentPath(p.path), p.bi) }, children: '⬆' }),
                jsx('input', {
                  type: 'text', style: W.addr, spellCheck: false, value: p.path || '',
                  onChange: function (e) { setDirPicker(Object.assign({}, p, { path: e.target.value })) },
                  onKeyDown: function (e) { if (e && e.key === 'Enter') fetchDirList(p.path, p.bi) },
                }),
                jsx('button', { style: W.btn, onClick: function () { fetchDirList(p.path, p.bi) }, children: '前往' }),
              ]),
              // 主体：左侧快速访问 + 右侧文件夹网格。
              jsx('div', { style: W.body }, [
                jsx('div', { style: W.sidebar }, quick.map(function (q) {
                  var active = q.path === p.path
                  return jsx('button', {
                    key: q.path,
                    style: Object.assign({}, W.quickItem, active ? W.quickActive : {}),
                    title: q.path,
                    onClick: function () { fetchDirList(q.path, p.bi) },
                    children: '📁 ' + q.name,
                  })
                })),
                jsx('div', { style: W.grid }, [
                  shown.map(function (e) {
                    return jsx('button', {
                      key: e.path,
                      style: Object.assign({}, W.tile, e.path === p.path ? W.tileSel : {}),
                      title: e.path,
                      onClick: function () { fetchDirList(e.path, p.bi) },
                      children: [
                        jsx('div', { style: W.icon, children: '📁' }),
                        jsx('div', { style: W.fname, children: e.name }),
                      ],
                    })
                  }),
                  hiddenCount > 0
                    ? jsx('div', { style: { gridColumn: '1 / -1', fontSize: 11, color: '#888', padding: '4px' }, children: '（还有 ' + hiddenCount + ' 个隐藏目录未显示）' })
                    : null,
                ]),
              ]),
              // 错误行。
              p.error ? jsx('div', { style: W.err, children: p.error }) : null,
              // 底部：当前路径（状态栏）+ 确定/取消。
              jsx('div', { style: W.footer }, [
                jsx('span', { style: W.status, children: p.path || '' }),
                jsx('button', { style: W.btn, onClick: close, children: '取消' }),
                jsx('button', { style: Object.assign({}, W.btn, { background: '#e8f0fe', borderColor: '#7f9ddb' }), onClick: function () { applyPath(p.path) }, children: '选择此目录' }),
              ]),
            ]),
          ])
        }

        /** 二级面板：该机器人的连接配置、投递目标与白名单。 */
        function renderBotDetails(bot, bi, st) {
          var whitelistText = Array.isArray(bot.whitelist) ? bot.whitelist.join('\n') : ''
          var bindings = st && Array.isArray(st.bindings) ? st.bindings : []
          return jsx('div', { style: S.botDetails }, [
            // 出错原因直接摆出来：红点/未连接时这里显示 lastError，展开即见。
            st && st.lastError
              ? jsx('div', { style: { fontSize: 12, color: '#e88888', marginBottom: 8 }, children: '连接异常：' + errText(st.lastError) })
              : null,
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: 'AppID' }),
                jsx('input', { type: 'text', style: S.input, value: bot.appId || '', placeholder: '例如 1905583221', onChange: function (e) { updateImBot(bi, 'appId', e.target.value) } }),
              ]),
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '显示别名' }),
                jsx('input', { type: 'text', style: S.input, value: bot.alias || '', placeholder: '例如 江柚', onChange: function (e) { updateImBot(bi, 'alias', e.target.value) } }),
              ]),
            ]),
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '会话存放工作区（workspace）' }),
                jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                  jsx('span', { style: Object.assign({}, S.mono, { fontSize: 12, flex: '1 1 auto', wordBreak: 'break-all', opacity: bot.cwd ? 0.85 : 0.5 }) }, bot.cwd || '（未设置，继承全局）'),
                  jsx('button', { style: S.smallBtn, onClick: function () { chooseWorkspaceDir(bot, bi) }, children: '选择…' }),
                  bot.cwd ? jsx('button', { style: S.smallBtn, onClick: function () { updateImBot(bi, 'cwd', '') }, children: '清除' }) : null,
                ]),
                jsx('div', { style: S.hint, children: '这个机器人自动新建的会话落在这里；DSH 会话列表按 workspace 分组。' }),
              ]),
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '角色预设' }),
                jsx('select', {
                  style: S.input,
                  value: bot.agentPreset || '',
                  onChange: function (e) { updateImBot(bi, 'agentPreset', e.target.value) },
                }, [
                  jsx('option', { value: '', children: '（留空：继承全局 / 按绑定角色名匹配）' }),
                ].concat(presets.map(function (p) {
                  return jsx('option', { key: p.id, value: p.id, children: p.name || p.id })
                }))),
                jsx('div', { style: S.hint, children: '每个机器人配不同预设，就是不同的「人」。' }),
              ]),
            ]),
            // 投递目标：该 bot 的聊天 ↔ 会话绑定（双向同步消息）。
            jsx('div', { style: { marginTop: 8 } }, [
              jsx('label', { style: S.label, children: '投递目标（双向同步消息）' }),
              bindings.length === 0
                ? jsx('div', { style: S.hint, children: '暂无绑定：该机器人收到新私聊会自动建会话并绑定。' })
                : jsx('div', {}, bindings.map(function (b) {
                    return jsx('div', { key: b.conversationKey, style: S.bindRow }, [
                      jsx('span', { style: { flex: '1 1 auto', wordBreak: 'break-all' } }, String(b.conversationKey) + (b.name ? '（' + b.name + '）' : '')),
                      jsx('span', { style: { fontSize: 11, opacity: 0.6, flex: '0 0 auto' } }, String(b.sessionId).slice(0, 16) + '…'),
                      // 发送测试消息：走真实投递链路（分条 + 通道），用来确认「这条聊天能不能收到」。
                      jsx('button', {
                        style: Object.assign({}, S.smallBtn, { color: T.accent, borderColor: T.accent }),
                        disabled: imTesting === b.conversationKey,
                        onClick: function () { sendImTest(bot.botId, b.conversationKey) },
                        children: imTesting === b.conversationKey ? '发送中…' : '发送测试',
                      }),
                      jsx('button', {
                        style: Object.assign({}, S.smallBtn, { color: '#e88888' }),
                        disabled: unbinding === b.conversationKey,
                        onClick: function () { unbindTarget(bot.botId, b.conversationKey) },
                        children: unbinding === b.conversationKey ? '解绑中…' : '解绑',
                      }),
                    ])
                  })),
              jsx('div', { style: S.hint, children: '「发送测试」会给这条聊天发一条带「投递测试」字样的消息——QQ 里收到即说明通道通；发不出去会在上方弹出具体原因（没绑定 / 通道没启动 / 平台拒绝）。' }),
            ]),
            // 白名单用户（per-bot）。
            jsx('div', { style: { marginTop: 8 } }, [
              jsx('label', { style: S.label, children: '白名单用户（每行一个 QQ openid）' }),
              jsx('textarea', {
                style: Object.assign({}, S.textarea, { minHeight: 56 }),
                value: whitelistText,
                placeholder: '留空 = 不限制；填了只有列表内的用户能私聊这个机器人',
                onChange: function (e) { updateImBot(bi, 'whitelist', e.target.value.split('\n')) },
              }),
            ]),
            // per-bot 机器人命令开关（控制权限）。
            jsx('div', { style: Object.assign({}, S.toggle, { marginTop: 6 }) }, [
              jsx('input', {
                type: 'checkbox', style: checkStyle(bot.botCommands !== false),
                checked: bot.botCommands !== false,
                onChange: function (e) { updateImBot(bi, 'botCommands', e.target.checked) },
              }),
              jsx('span', { style: S.toggleLabel, children: '启用机器人命令（/help /status /new /session /sessionlist /presetlist /preset）' }),
            ]),
            jsx('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 } }, [
              imBots.length > 1
                ? jsx('button', { style: Object.assign({}, S.smallBtn, { color: '#e88888' }), onClick: function () { removeImBot(bi) }, children: '删除机器人' })
                : null,
              jsx('span', { style: S.hint, children: '改完点底部「保存」生效。' }),
            ]),
          ])
        }

        var imBots = Array.isArray(scalar.imBots) && scalar.imBots.length
          ? scalar.imBots
          : [{ botId: scalar.imBotId, appId: scalar.imAppId, secretRef: scalar.imSecretRef, alias: '', agentPreset: '', cwd: '', whitelist: [], botCommands: true }]
        var botRows = []
        for (var bi = 0; bi < imBots.length; bi++) {
          botRows.push(renderBotCard(imBots[bi] || {}, bi))
        }
        botRows.push(jsx('div', { key: 'add-bot', style: { marginTop: 4 } }, [
          jsx('button', {
            style: Object.assign({}, S.smallBtn, imBots.length >= 5 ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
            disabled: imBots.length >= 5,
            onClick: addImBot,
            children: imBots.length >= 5 ? '最多 5 个机器人（QQ 开放平台上限）' : '+ 添加机器人',
          }),
        ]))

        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '通道设置' }, [
          jsx('div', { style: S.heading, children: 'QQ 机器人' }),
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.imEnabled), checked: scalar.imEnabled, onChange: function (e) { updateScalar('imEnabled', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '启用 QQ 机器人通道' }),
          ]),
          jsx('div', { key: 'bot-list', style: { marginTop: 2 } }, botRows),
          // 全局默认工作区 / 角色预设（per-bot 面板里留空时继承）。
          jsx('div', { style: S.row }, [
            jsx('div', { style: S.cell }, [
              jsx('label', { style: S.label, children: '全局默认工作区（workspace）' }),
              jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                jsx('span', { style: Object.assign({}, S.mono, { fontSize: 12, flex: '1 1 auto', wordBreak: 'break-all', opacity: scalar.imCwd ? 0.85 : 0.5 }) }, scalar.imCwd || '（留空 = 跟随你最近活跃会话的目录）'),
                jsx('button', { style: S.smallBtn, onClick: chooseGlobalCwd, children: '选择…' }),
                scalar.imCwd ? jsx('button', { style: S.smallBtn, onClick: function () { updateScalar('imCwd', '') }, children: '清除' }) : null,
              ]),
              jsx('div', { style: S.hint, children: '机器人未单独设置工作区时继承此项。留空则跟随你当前打开的那个 workspace。' }),
            ]),
            jsx('div', { style: S.cell }, [
              jsx('label', { style: S.label, children: '全局默认角色预设' }),
              jsx('select', {
                style: S.input,
                value: scalar.imAgentPreset || '',
                onChange: function (e) { updateScalar('imAgentPreset', e.target.value) },
              }, [
                jsx('option', { value: '', children: '（留空：按绑定里的角色名匹配）' }),
              ].concat(presets.map(function (p) {
                return jsx('option', { key: p.id, value: p.id, children: p.name || p.id })
              }))),
              jsx('div', { style: S.hint, children: '机器人未单独设置角色预设时继承此项。' }),
            ]),
          ]),
          // ── 表情包 / 图片 ────────────────────────────────────────────────
          jsx('div', { key: 'sticker-block', style: { marginTop: 10 } }, [
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '表情包目录' }),
                jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                  jsx('span', {
                    style: Object.assign({}, S.mono, {
                      fontSize: 12, flex: '1 1 auto', wordBreak: 'break-all',
                      opacity: scalar.imStickerDir ? 0.85 : 0.5,
                    }),
                  }, scalar.imStickerDir || ('（默认）' + (stickerInfo.defaultDir || '…'))),
                  jsx('button', { style: S.smallBtn, onClick: chooseStickerDir, children: '选择…' }),
                  scalar.imStickerDir ? jsx('button', { style: S.smallBtn, onClick: function () { updateScalar('imStickerDir', '') }, children: '清除' }) : null,
                ]),
                jsx('div', { style: S.hint, children: '角色发表情时若只给名字，就从这里找；对方发来的表情也会自动存进来。留空用默认目录（跨项目共享）。' }),
              ]),
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '图片与表情' }),
                jsx('div', { style: S.toggle }, [
                  jsx('input', { type: 'checkbox', style: checkStyle(scalar.imImagesEnabled), checked: scalar.imImagesEnabled, onChange: function (e) { updateScalar('imImagesEnabled', e.target.checked) } }),
                  jsx('span', { style: S.toggleLabel, children: '允许角色发表情包 / 图片' }),
                ]),
                jsx('div', { style: S.toggle }, [
                  jsx('input', { type: 'checkbox', style: checkStyle(scalar.imHarvestInbound), checked: scalar.imHarvestInbound, onChange: function (e) { updateScalar('imHarvestInbound', e.target.checked) } }),
                  jsx('span', { style: S.toggleLabel, children: '把对方发来的图片存进表情库' }),
                ]),
                jsx('div', { style: S.toggle }, [
                  jsx('input', { type: 'checkbox', style: checkStyle(scalar.imFaceEnabled), checked: scalar.imFaceEnabled, onChange: function (e) { updateScalar('imFaceEnabled', e.target.checked) } }),
                  jsx('span', { style: S.toggleLabel, children: 'QQ 原生表情（[微笑] 这类）双向适配' }),
                ]),
                jsx('div', { style: S.hint, children: '回复对话、到点提醒、自动生活推进都能发表情。关掉「存进表情库」后，对方发来的图片地址过期就无法再用了。' }),
              ]),
            ]),
            // 表情库预览 + 刷新。
            jsx('div', { style: { marginTop: 8 } }, [
              jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 } }, [
                jsx('button', { style: S.smallBtn, disabled: stickersLoading, onClick: refreshStickers, children: stickersLoading ? '读取中…' : '刷新表情库' }),
                stickerInfo.stats
                  ? jsx('span', { style: S.hint, children: '共 ' + stickerInfo.stats.total + ' 个（自有 ' + stickerInfo.stats.mine + '，来自 ' + stickerInfo.stats.senders + ' 位联系人）' })
                  : null,
                stickerInfo.error ? jsx('span', { style: Object.assign({}, S.hint, { color: '#e88888' }), children: String(stickerInfo.error) }) : null,
              ]),
              stickerInfo.list.length > 0
                ? jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, stickerInfo.list.slice(0, 60).map(function (item, si) {
                    return jsx('div', {
                      key: String(item.path || si),
                      title: item.name + (item.source === 'inbound' ? '（来自对方）' : '（自有）'),
                      style: { width: 64, textAlign: 'center' },
                    }, [
                      jsx('img', {
                        src: item.thumb,
                        alt: item.name,
                        style: {
                          width: 56, height: 56, objectFit: 'cover',
                          borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)',
                        },
                      }),
                      jsx('div', { style: { fontSize: 10, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name || ''),
                    ])
                  }))
                : jsx('div', { style: S.hint, children: stickersLoading ? '读取中…' : '表情库还是空的。把表情包图片放进上面的目录（或它的 mine/ 子目录）即可；对方发来的图片会自动存进来。' }),
            ]),
          ]),
        ]))

        // 目录选择弹窗（bot 或全局工作区共用；pickerApi 不可用时弹出）。
        children.push(dirPicker ? renderDirPickerModal() : null)

        // 高级选项：默认折叠，90% 用户用不到。
        children.push(jsx('button', {
          style: S.advBtn,
          onClick: function () { setImAdv(!imAdv) },
          children: imAdv ? '高级选项 ▾' : '高级选项 ▸',
        }))
        if (imAdv) {
          children.push(jsx('div', { style: S.advBody, key: 'im-adv' }, [
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '降级策略' }),
                jsx('select', {
                  style: S.input,
                  value: scalar.imSayFallback,
                  onChange: function (e) { updateScalar('imSayFallback', e.target.value) },
                }, [
                  jsx('option', { value: 'strict', children: 'strict —— 只发 interlude_say 里的话（推荐）' }),
                  jsx('option', { value: 'loose', children: 'loose —— 过渡期，会从正文里猜' }),
                ]),
                jsx('div', { style: S.hint, children: 'strict 下不调 interlude_say 就什么都不发：思考不会外泄，代价是偶尔少说一句。' }),
              ]),
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '每天主动消息上限' }),
                jsx('input', { type: 'number', style: S.input, min: 1, value: scalar.imMaxPerDay, onChange: function (e) { updateScalar('imMaxPerDay', e.target.value) } }),
                jsx('div', { style: S.hint, children: 'QQ 平台硬限制；到点的提醒/承诺不受这条限制。' }),
              ]),
            ]),
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '两次主动消息最小间隔（分钟）' }),
                jsx('input', { type: 'number', style: S.input, min: 0, value: scalar.imMinIntervalMinutes, onChange: function (e) { updateScalar('imMinIntervalMinutes', e.target.value) } }),
                jsx('div', { style: S.hint, children: '防止连续投递触发平台限流。' }),
              ]),
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '单条字数上限' }),
                jsx('input', { type: 'number', style: S.input, min: 1, value: scalar.imMaxChars, onChange: function (e) { updateScalar('imMaxChars', e.target.value) } }),
                jsx('div', { style: S.hint, children: '超过就按语义边界切成多条，像真人发消息。默认 40。' }),
              ]),
            ]),
            jsx('div', { style: S.row }, [
              jsx('div', { style: S.cell }, [
                jsx('label', { style: S.label, children: '一次最多几条' }),
                jsx('input', { type: 'number', style: S.input, min: 1, value: scalar.imMaxMessages, onChange: function (e) { updateScalar('imMaxMessages', e.target.value) } }),
                jsx('div', { style: S.hint, children: '超出的字数会并进前面的消息，不会丢内容。默认 4。' }),
              ]),
            ]),
          ]))
        }

        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '消息行为' }, [
          jsx('div', { style: S.heading, children: '消息行为' }),
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.imInteractive), checked: scalar.imInteractive, onChange: function (e) { updateScalar('imInteractive', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '交互式回复：你在 DSH 界面说话时，角色的话也回到 QQ' }),
          ]),
          scalar.imInteractive
            ? jsx('div', { style: S.toggle }, [
                jsx('input', { type: 'checkbox', style: checkStyle(scalar.imRequireInbound), checked: scalar.imRequireInbound, onChange: function (e) { updateScalar('imRequireInbound', e.target.checked) } }),
                jsx('span', { style: S.toggleLabel, children: '仅当该 QQ 会话发过消息时才回投（建议开着）' }),
              ])
            : null,
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.imInboundPrefix), checked: scalar.imInboundPrefix, onChange: function (e) { updateScalar('imInboundPrefix', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '给收到的 QQ 消息加「来自 QQ / QQ 群」的来源前缀' }),
          ]),
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.imGroupMentionOnly), checked: scalar.imGroupMentionOnly, onChange: function (e) { updateScalar('imGroupMentionOnly', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '群聊仅响应 @机器人 的消息' }),
          ]),
          // 关掉 @门控 时给出明确警告：不开意愿的话群里每条消息都会触发角色。
          scalar.imGroupMentionOnly
            ? jsx('div', { style: S.hint, children: '开着最省心：只有被 @ 时才回应。关掉它就必须配合下面的「发言意愿」，否则群里每条消息都会触发一次完整回合。' })
            : jsx('div', { style: Object.assign({}, S.hint, { color: T.warn }) }, '已关掉 @ 门控 —— 建议同时开启下面的「发言意愿」，否则群里每条消息都会触发角色（很吵、也费额度）。'),
          jsx('div', { style: S.toggle }, [
            jsx('input', { type: 'checkbox', style: checkStyle(scalar.imGroupWillingness), checked: scalar.imGroupWillingness, onChange: function (e) { updateScalar('imGroupWillingness', e.target.checked) } }),
            jsx('span', { style: S.toggleLabel, children: '群聊发言意愿：判断这条要不要回（不是每条都接）' }),
          ]),
          scalar.imGroupWillingness
            ? jsx('div', { style: Object.assign({}, S.row, { marginTop: 4, marginBottom: 4 }) }, [
                jsx('div', { style: S.cell }, [
                  jsx('label', { style: S.label, children: '意愿阈值' }),
                  jsx('input', {
                    type: 'number', step: '0.01', min: 0, max: 10, style: S.input,
                    value: scalar.imGroupWillingnessThreshold,
                    onChange: function (e) { updateScalar('imGroupWillingnessThreshold', e.target.value) },
                  }),
                  jsx('div', { style: S.hint, children: '低于它就不回。默认 0.24；调大 = 更沉默（0.5 左右很安静，1 以上基本只在被 @ 时说话）。' }),
                ]),
                jsx('div', { style: S.cell }, [
                  jsx('label', { style: S.label, children: '最小回复间隔（秒）' }),
                  jsx('input', {
                    type: 'number', min: 0, max: 86400, style: S.input,
                    value: scalar.imGroupWillingnessCooldownSeconds,
                    onChange: function (e) { updateScalar('imGroupWillingnessCooldownSeconds', e.target.value) },
                  }),
                  jsx('div', { style: S.hint, children: '距上次群内发言不足这么久就不回（被 @ 仍会回）。0 = 不限制；建议 60~300。' }),
                ]),
              ])
            : null,
          jsx('div', { style: S.hint, children: '意愿的细调参数（概率放大、衰减半衰期、每次回复消耗、关键词等）在 settings.yaml 的 im.group.willingness 里；面板不会覆盖它们。被 @ 时永远强制回应。' }),
          jsx('div', { style: S.hint, children: '状态与绑定查看：在会话里执行 /interlude im（也可用 /interlude im targets、/interlude im test 试投一条）。' }),
        ]))
      }

      /* ============ Tab：预设 / 命令 ============ */
      if (tab === 'presets') {
        // 机器人命令说明（在 QQ 私聊里直接给机器人发，不进模型、结果回投）。
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '机器人命令' }, [
          jsx('div', { style: S.heading, children: '机器人命令（在 QQ 私聊发给机器人）' }),
          jsx('div', { style: { fontSize: 12, lineHeight: 1.7 } }, [
            jsx('div', {}, jsx('code', { style: S.mono }, '/status'), '　查看连接与绑定状态'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/new'), '　开启一个全新会话'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/sessionlist'), '　列出可绑定的会话'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/session <ID|序号>'), '　把当前聊天绑到指定会话'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/presetlist'), '　列出可用角色预设'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/preset <ID|序号|角色名>'), '　切换角色预设'),
            jsx('div', {}, jsx('code', { style: S.mono }, '/help'), '　显示全部可用命令'),
          ]),
          jsx('div', { style: S.hint, children: '命令由插件直接处理并回投结果，不经过模型；未绑定时会话发消息会自动新建。' }),
        ]))

        /* ============ 预设管理 ============ */
        children.push(jsx('div', { style: S.section, className: 'hdsi-section', key: '预设管理' }, [
          jsx('div', { style: S.heading, children: '预设管理' }),
          jsx('div', { style: S.hint, children: '管理已保存的预设（重命名 / 删除）。新建与载入在「创作」页：从预设下拉选择载入、「＋ 新建预设」保存当前草稿，或直接导入酒馆角色卡。' }),
          presets.length
            ? jsx('div', { style: { marginTop: 6 } }, presets.map(function (p) {
                var isRenaming = renaming.id === p.id
                var timeLabel = (p.updatedAt || p.createdAt)
                  ? '更新于 ' + clockText(p.updatedAt || p.createdAt)
                  : ''
                return jsx('div', {
                  key: p.id,
                  style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.12)' },
                }, [
                  isRenaming
                    ? jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: '1 1 auto' } }, [
                        jsx('input', {
                          type: 'text', style: Object.assign({}, S.input, { flex: '1 1 auto' }),
                          value: renaming.name,
                          onChange: function (e) { setRenaming({ id: p.id, name: e.target.value }) },
                        }),
                        jsx('button', { style: S.smallBtn, onClick: confirmRename, children: '确定' }),
                        jsx('button', { style: S.smallBtn, onClick: cancelRename, children: '取消' }),
                      ])
                    : jsx('span', { style: { fontSize: 13, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name),
                  jsx('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' } }, [
                    jsx('span', { style: { fontSize: 11, opacity: 0.5 }, children: timeLabel }),
                    jsx('button', { style: Object.assign({}, S.button, { padding: '3px 10px', fontSize: 12 }), onClick: function () { startRename(p) }, children: '改名' }),
                    jsx('button', { style: Object.assign({}, S.button, { padding: '3px 10px', fontSize: 12 }), onClick: function () { onDeletePreset(p.id) }, children: '删除' }),
                  ]),
                ])
              }))
            : jsx('div', { style: S.hint, children: '还没有保存过预设。在「创作」页可从下拉「＋ 新建预设」创建，或导入酒馆角色卡。' }),
        ]))
      }

      var statusLine = dirty
        ? jsx('span', { style: Object.assign({}, S.badge, S.badgeDirty), children: '● 有未保存改动' })
        : jsx('span', { style: Object.assign({}, S.badge, S.badgeClean), children: '✓ 已是最新' })
      var msgEl = message ? jsx('span', { style: message.kind === 'ok' ? S.ok : S.err, children: message.text }) : null

      return jsx('div', { style: S.card, className: 'hdsi' }, [
        renderTabBar(),
      ].concat(children).concat([
        jsx('div', { style: S.bar }, [
          jsx('button', { style: S.buttonPrimary, onClick: onSave, disabled: saving, children: saving ? '保存中…' : '保存' }),
          jsx('button', { style: S.button, onClick: onReset, disabled: saving, children: '重置本页' }),
          statusLine,
          msgEl,
        ]),
      ]))
    }

    /**
     * 注入设置页的全局视觉 CSS（hover / focus / 自定义 switch 等内联样式做不到的效果）。
     *
     * 只在**真实浏览器环境**执行：测试替身的 `window` 只有 `__ModuleLoader__`、
     * 没有 `document`，这里直接跳过——DOM 结构与 hook 数量都不受影响。
     * 幂等：同一份样式只注入一次。
     */
    function injectPageStyles() {
      if (typeof document === 'undefined' || !document.head || typeof document.getElementById !== 'function') return
      if (document.getElementById('hdsi-page-styles')) return
      var style = document.createElement('style')
      style.id = 'hdsi-page-styles'
      style.textContent = [
        /* 输入控件聚焦：accent 光环（替代默认 outline，观感更柔和） */
        '.hdsi input:not([type=checkbox]):focus-visible, .hdsi textarea:focus-visible, .hdsi select:focus-visible {',
        '  outline: none;',
        '  border-color: rgba(95,155,232,0.7) !important;',
        '  box-shadow: 0 0 0 3px rgba(95,155,232,0.18);',
        '  background-color: rgba(95,155,232,0.06);',
        '}',
        /*
         * 输入控件 hover：边框轻微提亮。
         *
         * 必须 `!important`：这些控件的边框由**内联样式**给出，而内联样式优先级高于
         * 本表里的普通规则 —— 不加 !important 的话这条 hover 根本不会生效
         * （同一条坑也适用于下面的分区卡片悬浮）。
         */
        '.hdsi input:not([type=checkbox]):hover, .hdsi textarea:hover, .hdsi select:hover {',
        '  border-color: rgba(127,127,127,0.42) !important;',
        '}',
        /* 按钮 hover / 按下反馈（内联样式未占用 filter/transform，无需 !important） */
        '.hdsi button:hover { filter: brightness(1.08); }',
        '.hdsi button:active { transform: translateY(1px); }',
        '.hdsi button:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }',
        /* 分区卡片悬浮：同样要盖过内联边框 */
        '.hdsi-section:hover { border-color: rgba(127,127,127,0.3) !important; }',
        /*
         * 开关（checkbox）本身**不再由本表绘制**：轨道与滑块都在 `S.checkBase/On/Off`
         * 里以内联样式表达，`checked` 状态由渲染期计算（见 checkStyle 的注释）。
         * 这里只补一个键盘聚焦环 —— 因为 `appearance: none` 会去掉原生焦点样式。
         */
        '.hdsi input[type=checkbox]:focus-visible { box-shadow: 0 0 0 3px rgba(95,155,232,0.28); }',
      ].join('\n')
      document.head.appendChild(style)
    }

    /** 客户端插件入口：在设置页注册一整个「幕间系统」页面（settings.section 槽）。 */
    function apply(ctx) {
      // 视觉增强：注入一段全局 CSS，给设置页补上内联样式做不到的交互反馈
      // （hover / focus / 自定义 checkbox 开关）。只在真实浏览器环境执行——
      // 测试替身没有 document，直接跳过，DOM 结构与 hook 数量都不受影响。
      injectPageStyles()

      // 解析 DSH 的目录选择能力（优先 uiWorkspace，回退 workspaces）——
      // 工作区「选择…」用系统目录选择器，失败/缺失时回退自建 fs/list 浏览。
      // 注意：cordis 代理对未在 inject 声明的服务做属性访问会抛错而不是返回
      // undefined（inject 只声明了 ['slots']），所以必须用 ctx.get 探测；
      // 没有 ctx.get 的裸对象 ctx（测试 mock）才退回裸属性读取。
      var uiWorkspace = (typeof ctx.get === 'function') ? ctx.get('uiWorkspace') : undefined
      var workspaces = (typeof ctx.get === 'function') ? ctx.get('workspaces') : ctx.workspaces
      var pickerSource = (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function')
        ? uiWorkspace
        : workspaces
      pickerApi = (pickerSource && typeof pickerSource.pickDirectory === 'function'
        && typeof pickerSource.listDirectory === 'function')
        ? pickerSource
        : null
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
    // 扫码绑定面板：同上，直接渲染以供测试驱动扫码流程。
    exports.QrConnectPanel = QrConnectPanel
    return module.exports
  },
})


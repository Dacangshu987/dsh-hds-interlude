/**
 * 设置页样式注入（`lib/client.js` 的 `injectPageStyles`）的用例。
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑以前**完全没有测试覆盖**，而它恰恰是「开关渲染错乱」那次事故的另一半：
 *   - 注入失败（没有 document / head）→ 必须安静跳过，不能崩掉整个设置页；
 *   - 注入成功 → 必须真的进 head，且只注入一次（apply 可能被调用多次）；
 *   - 注入的样式**不得**再包含 checkbox 的尺寸/外观规则——开关已经改成内联样式，
 *     若这里再写一份，就会重演「内联与外部互相打架」的老问题。
 *
 * 运行：node test/client-styles.test.mjs
 */
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
/** 支持同步与异步用例：async 用例必须被 await，否则抛错会逃逸成 unhandled rejection。 */
async function ok(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

/** 造一个最小可用的假 document（只需支持 createElement/head/getElementById）。 */
function makeFakeDocument() {
  const appended = []
  const byId = new Map()
  return {
    appended,
    head: {
      appendChild(node) {
        appended.push(node)
        if (node && node.id) byId.set(node.id, node)
        return node
      },
    },
    getElementById(id) { return byId.get(id) || null },
    createElement(tag) { return { tag, id: '', textContent: '' } },
  }
}

/**
 * 加载 client.js 的工厂并返回 exports。
 *
 * 每次都用带 cache-buster 的 URL 重新导入：模块体只在首次求值一次，而
 * 「有没有 document」会决定 apply 的行为，所以每个用例都要拿到全新的模块实例。
 */
async function loadClient() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
  const mockRequire = (spec) => {
    if (spec === 'react') {
      // apply() 不渲染组件，只需要一个占位 react 即可。
      return {
        useState: (init) => [init, () => {}],
        useEffect: () => {},
        useRef: (init) => ({ current: init }),
        createElement: () => null,
      }
    }
    throw new Error('unexpected require: ' + spec)
  }
  await import(new URL('../lib/client.js', import.meta.url).href + '?t=' + Date.now() + Math.random())
  assert.ok(captured, 'client.js 应通过 __ModuleLoader__ 注册模块')
  return captured.factory(mockRequire)
}

/** 造一个够用的假 ctx（apply 只用到 get/slots）。 */
function makeCtx() {
  return {
    get: () => undefined,
    slots: {
      inject: () => {},
      register: () => ({}),
    },
  }
}

/** 在「有假 document」的环境里跑一段，结束后清理全局。 */
async function withDocument(doc, fn) {
  globalThis.document = doc
  try {
    await fn()
  } finally {
    delete globalThis.document
  }
}

console.log('设置页样式注入')

await ok('有 document 时注入样式表，且进 head', async () => {
  const doc = makeFakeDocument()
  await withDocument(doc, async () => {
    const client = await loadClient()
    client.apply(makeCtx())
    assert.equal(doc.appended.length, 1, '应注入一份样式表')
    assert.equal(doc.appended[0].id, 'hdsi-page-styles', '样式表应带固定 id')
    assert.ok(doc.appended[0].textContent.length > 0, '样式表内容不应为空')
  })
})

await ok('注入是幂等的（apply 多次也只注入一份）', async () => {
  const doc = makeFakeDocument()
  await withDocument(doc, async () => {
    const client = await loadClient()
    client.apply(makeCtx())
    client.apply(makeCtx())
    client.apply(makeCtx())
    assert.equal(doc.appended.length, 1, '重复 apply 不该重复注入')
  })
})

await ok('没有 document 时安静跳过（设置页不会因此崩掉）', async () => {
  delete globalThis.document
  const client = await loadClient()
  assert.doesNotThrow(() => client.apply(makeCtx()), '缺少 document 不该抛错')
})

await ok('有 document 但没有 head 时也安静跳过', async () => {
  globalThis.document = { createElement: () => ({ id: '', textContent: '' }), getElementById: () => null }
  try {
    const client = await loadClient()
    assert.doesNotThrow(() => client.apply(makeCtx()), '缺少 head 不该抛错')
  } finally {
    delete globalThis.document
  }
})

await ok('注入的 CSS 不再包含 checkbox 的尺寸/外观规则（开关已改为内联样式）', async () => {
  // 回归：早先这里写了 `input[type=checkbox] { width: 34px; height: 18px ... }`
  // 与 `::after` 滑块，而 S.check 的内联 width/height 优先级更高 —— 两者打架，
  // 开关被压成 15×15、滑块被推出盒子外。现在绘制权归内联样式，这里不许再插手。
  const doc = makeFakeDocument()
  await withDocument(doc, async () => {
    const client = await loadClient()
    client.apply(makeCtx())
    const css = doc.appended[0].textContent
    assert.ok(!/input\[type=checkbox\]\s*\{[^}]*width/.test(css), '不应再给 checkbox 设 width')
    assert.ok(!/input\[type=checkbox\][^{]*::after/.test(css), '不应再用 ::after 画滑块')
    assert.ok(!/input\[type=checkbox\]:checked/.test(css), '不应再用 :checked 控制开态（改由渲染期计算）')
    // 键盘聚焦环要保留：appearance:none 会去掉原生焦点样式。
    assert.match(css, /input\[type=checkbox\]:focus-visible/, '应保留键盘聚焦环')
  })
})

await ok('注入的 CSS 用 .hdsi 作用域限定（不影响其他插件的设置页）', async () => {
  const doc = makeFakeDocument()
  await withDocument(doc, async () => {
    const client = await loadClient()
    client.apply(makeCtx())
    const css = doc.appended[0].textContent
    const rules = css.split('\n').filter(line => line.includes('{'))
    assert.ok(rules.length > 0, '应有多条规则')
    for (const rule of rules) {
      assert.ok(rule.includes('.hdsi'), `规则必须限定在 .hdsi 作用域内：${rule}`)
    }
  })
})

await ok('悬停规则带 !important（否则盖不过内联边框）', async () => {
  // 内联的 border 优先级高于外部规则：不加 !important 的话 hover 边框提亮无效。
  const doc = makeFakeDocument()
  await withDocument(doc, async () => {
    const client = await loadClient()
    client.apply(makeCtx())
    const css = doc.appended[0].textContent
    const hoverRules = css.split('\n').filter(line => line.includes(':hover') && line.includes('border-color'))
    assert.ok(hoverRules.length > 0, '应有悬停边框规则')
    for (const rule of hoverRules) {
      assert.ok(rule.includes('!important'), `悬停边框规则需要 !important：${rule}`)
    }
  })
})

/* ------------------------------------------------------- 汇总 */

if (failed > 0) {
  console.log(`\n${failed} 个用例失败（共 ${passed + failed}）`)
  process.exit(1)
}
console.log(`\n全部通过（${passed} 个用例）`)

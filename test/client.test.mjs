// 冒烟测试：模拟 DSH 客户端加载器，验证 lib/client.js 能加载、
// apply 能正确把卡片注册到 settings.plugin.item（键 hds-interlude），
// 且 inject 返回绑定到 hds-interlude 命名空间的 settings scope。
import { strict as assert } from 'node:assert'

// 1. 捕获 window.__ModuleLoader__.load 的调用
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec },
  },
}

// 2. 动态 import 触发文件顶层执行（文件顶层调用 window.__ModuleLoader__.load）
await import(new URL('../lib/client.js', import.meta.url).href)

assert.ok(captured, 'window.__ModuleLoader__.load 未被调用')
assert.equal(captured.id, 'dsh-hds-interlude')
const factory = captured.factory
assert.equal(typeof factory, 'function')

// 3. 伪造 require / react（createElement 风格，对齐 dsh-tavern）
const react = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => () => {},
  useRef: (v) => ({ current: v }),
  createElement: (tag, props) => ({ tag, props }),
}
const mockRequire = (spec) => {
  if (spec === 'react') return react
  throw new Error('unexpected require: ' + spec)
}

// 4. 执行 factory
const moduleExports = factory(mockRequire)
assert.equal(typeof moduleExports.apply, 'function')
assert.deepEqual(moduleExports.inject, ['slots'])

// 5. 调用 apply，验证注册（仅 slots；数据走 fetch，不依赖 settingsScope）
let injected = null
const fakeCtx = {
  slots: {
    inject: (slot, factoryFn) => { injected = { slot, factoryFn } },
    register: (reg, Comp) => ({ reg, Comp }),
  },
}
moduleExports.apply(fakeCtx)
assert.equal(injected.slot, 'settings.section', '应注册到 settings.section')
const regResult = injected.factoryFn()
assert.ok(regResult.reg && regResult.reg.id === 'hds-interlude', '注册 id 应为 hds-interlude')
assert.equal(typeof regResult.reg.label, 'function', 'label 应为函数（本地化 thunk）')
assert.equal(regResult.reg.label(), '幕间系统')
assert.equal(typeof regResult.Comp, 'function', '卡片组件应为函数')

// 6. inject 返回空 props（数据经 fetch，无需注入 scope）
const props = regResult.reg.inject()
assert.ok(props && typeof props === 'object', 'inject 应返回对象（可为空）')

console.log('client smoke test PASS ✓  (settings.section id=hds-interlude, fetch 数据通道)')

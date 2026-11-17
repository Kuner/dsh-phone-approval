// Smoke test for client.js: loads the browser module with a stub React and a mocked
// Client context, checks the sidebar entry and main page registrations, and renders
// the page and icon once. Run: node test/client-smoke.mjs

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let failures = 0
const check = (name, ok) => {
  if (!ok) failures += 1
  console.log(ok ? 'PASS' : 'FAIL', name)
}

// Single-pass stub React: hooks return initial values, effects do not run.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
}

let module
const window = { __ModuleLoader__: { load: (definition) => { module = definition } } }
const sandbox = { window, globalThis: {}, console, fetch: async () => ({ ok: false, json: async () => ({}) }) }
sandbox.globalThis = sandbox
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
check('module id', module?.id === 'dsh-phone-approval')

const plugin = module.factory(name => (name === 'react' ? React : undefined))
check('inject', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale']))

const registrations = []
const dictionaries = {}
const ctx = {
  effect: fn => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
    bind: ns => key => dictionaries[ns].zh[key],
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(ctx)

const main = registrations.find(r => r.options.name === 'main')
const entry = registrations.find(r => r.options.name === 'sidebar.panellist')
check('main panel registered', main?.options.key === 'phone-approval')
check('sidebar entry registered with same id', entry?.options.id === 'phone-approval' && entry.options.label() === '手机审批')
check('no plugin detail registration', !registrations.some(r => r.options.name.startsWith('plugins.')))
check('zh and en share keys', JSON.stringify(Object.keys(dictionaries.phoneApproval.zh).sort()) === JSON.stringify(Object.keys(dictionaries.phoneApproval.en).sort()))

const t = key => dictionaries.phoneApproval.zh[key] ?? `[${key}]`
const text = node => (node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : typeof node.type === 'function' ? text(node.type(node.props))
  : (node.children ?? []).map(text).join(''))

const icon = entry.component({ size: 16 })
check('icon renders svg', icon.type === 'svg' && icon.props.width === 16)

let page = text(main.component({ t }))
check('page without admin shows hint', page.includes('手机审批与通知') && page.includes('无法连接插件后台'))

sandbox.__DSH_PHONE_APPROVAL_ADMIN__ = { url: 'http://127.0.0.1:1', token: 'x' }
page = text(main.component({ t }))
check('page with admin starts loading', page.includes('正在读取状态'))
check('no missing copy', !/\[\w+\]/.test(page))

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

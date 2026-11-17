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
// It also enforces React's hook-order rule: every render of one component type must
// call the same number of hooks, or real React throws and blanks the page.
let currentHooks
const hookCounts = new Map()
const hook = () => { if (currentHooks) currentHooks.count += 1 }
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (init) => {
    hook()
    let value = typeof init === 'function' ? init() : init
    // Let a test render components as if a null state (such as a revealed secret) were set.
    if (value === null && React.seedNull) value = React.seedNull
    // Let a test jump the page straight to a loaded state.
    if (value && value.kind === 'loading' && React.readyStatus) return [{ kind: 'ready', status: React.readyStatus }, () => {}]
    return [value, () => {}]
  },
  useEffect: () => { hook() },
  useCallback: (fn) => { hook(); return fn },
  useRef: (value) => { hook(); return { current: value } },
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
  : Array.isArray(node) ? node.map(text).join('') : typeof node.type === 'function' ? text(renderComponent(node))
  : (node.children ?? []).map(text).join(''))
function renderComponent(node) {
  const outer = currentHooks
  currentHooks = { count: 0 }
  try {
    return node.type(node.props)
  } finally {
    const counts = hookCounts.get(node.type) ?? new Set()
    counts.add(currentHooks.count)
    hookCounts.set(node.type, counts)
    currentHooks = outer
  }
}

const icon = entry.component({ size: 16 })
check('icon renders svg', icon.type === 'svg' && icon.props.width === 16)

let page = text(main.component({ t }))
check('page without admin shows hint', page.includes('手机审批与通知') && page.includes('无法连接插件后台'))

sandbox.__DSH_PHONE_APPROVAL_ADMIN__ = { url: 'http://127.0.0.1:1', token: 'x' }
page = text(main.component({ t }))
check('page with admin starts loading', page.includes('正在读取状态'))
check('no missing copy', !/\[\w+\]/.test(page))

const config = {
  server: 'http://127.0.0.1:8080',
  events: { approval: true, question: true, completed: false, error: false },
  completedScope: 'human', includeDetails: true, minTurnSeconds: 0,
  phoneApproval: { enabled: true, questions: true, publicUrl: '', ttlSeconds: 600 },
}
const baseStatus = {
  version: 'x',
  bark: { configured: true, masked: 'ab…cd', server: config.server, serverOk: true },
  encryption: { configured: true, enabled: false, algorithm: 'AES256', mode: 'CBC', padding: 'pkcs7' },
  phone: { enabled: true, listening: true, url: 'https://x/', port: 1, httpsPort: 2, active: true, passkey: { enrolled: true, matchesUrl: true } },
  tailscale: { installed: true, running: true, serveOk: true, dnsName: 'x' },
  config, configWritable: true,
}
for (const encryption of [{ ...baseStatus.encryption }, { ...baseStatus.encryption, enabled: true }, { ...baseStatus.encryption, configured: false }]) {
  React.readyStatus = { ...baseStatus, encryption }
  let rendered = ''
  try { rendered = text(main.component({ t })) } catch (error) { rendered = 'THREW ' + error.message }
  const state = !encryption.configured ? 'off' : encryption.enabled ? 'on' : 'pending'
  check(`full page renders (encryption ${state})`, !rendered.startsWith('THREW') && rendered.includes('加密推送')
    && rendered.includes('推送哪些消息') && rendered.includes('只推需要我处理的') && rendered.includes('手机审批与服务器')
    && !/\[\w+\]/.test(rendered))
  if (rendered.startsWith('THREW')) console.log(rendered)
}
// Render again with every null state set (the encryption key revealed, messages shown).
React.seedNull = { key: 'K'.repeat(32), iv: 'I'.repeat(16), text: 'msg', tone: 'ok' }
for (const encryption of [{ ...baseStatus.encryption }, { ...baseStatus.encryption, enabled: true }]) {
  React.readyStatus = { ...baseStatus, encryption }
  let rendered = ''
  try { rendered = text(main.component({ t })) } catch (error) { rendered = 'THREW ' + error.message }
  check(`page renders with the key revealed (encryption ${encryption.enabled ? 'on' : 'pending'})`,
    !rendered.startsWith('THREW') && rendered.includes('K'.repeat(32)) && rendered.includes('复制'))
}
React.seedNull = undefined
React.readyStatus = undefined
const unstable = [...hookCounts].filter(([, counts]) => counts.size > 1).map(([fn, counts]) => `${fn.name}: ${[...counts]}`)
check('every component calls the same number of hooks on every render', unstable.length === 0)
if (unstable.length) console.log('  hook counts changed:', unstable.join('; '))

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

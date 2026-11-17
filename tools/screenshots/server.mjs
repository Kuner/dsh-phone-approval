// Screenshot harness: serves the plugin's real settings page (client.js) and phone page
// (page.js) with demo data and the DSH theme stylesheet. Usage: node server.mjs <repoDir> <themeCss> <port>
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [repo, themeCss, port] = process.argv.slice(2)
const { PAGE_HTML } = await import(join(repo, 'page.js'))
const here = new URL('.', import.meta.url).pathname

const HOST = 'mac.tail1234.ts.net'
const URL_BASE = `https://${HOST}:8443/`
const now = Date.now()

function status(enc) {
  return {
    version: '1.3.2',
    bark: { configured: true, masked: 'Gk7pQ••••••••••x2Qa', credential: 'DSH_BARK_KEY', server: 'http://127.0.0.1:8080', serverOk: true },
    encryption: {
      configured: enc !== 'off', enabled: enc === 'on', createdAt: now,
      algorithm: 'AES256', mode: 'CBC', padding: 'pkcs7',
    },
    phone: {
      enabled: true, listening: true, url: URL_BASE, autoUrl: true, httpsPort: 8443, port: 47391, active: true,
      passkey: { enrolled: true, rpId: HOST, createdAt: Date.parse('2026-11-16T15:01:00Z'), matchesUrl: true },
    },
    tailscale: { installed: true, running: true, dnsName: HOST, httpsEnabled: true, serveOk: true, url: URL_BASE },
    config: {
      server: 'http://127.0.0.1:8080',
      events: { approval: true, question: true, completed: true, error: true },
      includeDetails: true, completedScope: 'human', minTurnSeconds: 30,
      phoneApproval: { enabled: true, questions: true, publicUrl: '', ttlSeconds: 600 },
    },
    configWritable: true,
  }
}

const base = { session: '发布 v2.26.0', expiresAt: now + 9 * 60 * 1000 + 12000, rpId: HOST, enrolled: true, credentialId: 'AAAA', challenge: 'AAAA' }
const approval = {
  ...base, kind: 'approval', status: 'pending', tool: 'bash',
  reason: 'escalate sandbox to danger-full-access: 把 v2.26.0 部署到生产服务器，需要访问网络和部署密钥。',
  command: './scripts/release.sh --tag v2.26.0 --yes\n\n（目录：/Users/me/projects/trading-app）',
}
const PHONE = {
  approval,
  enroll: { ...approval, enrolled: false, credentialId: undefined, challenge: undefined, enroll: { challenge: 'AAAA', userId: 'AAAA' } },
  question: {
    ...base, kind: 'question', status: 'pending', expiresAt: now + 5 * 3600 * 1000 + 42 * 60 * 1000,
    questions: [{
      id: 'gate', header: '发布门禁 v2.26.0', multiSelect: false,
      question: 'v2.26.0 已合并并打 tag，CI 全部通过，审查 3 轮通过。本次发布包含数据库迁移 018（只新增表，不改已有数据）。\n\n确认发布吗？',
      options: [
        { label: '确认发布 (Recommended)', description: '运行 release.sh --tag v2.26.0 --yes，部署后核对生产验证和日志。' },
        { label: '先不发布', description: '保持 v2.25.0，继续开发下一个需求。' },
      ],
    }],
  },
}

const SETTINGS = (theme, enc, card) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="/theme.css">
<style>html,body{margin:0;height:100%}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}#app{height:100vh}
${card ? `.dpa-heading{display:none!important}.dpa-content{padding:24px!important;max-width:none}.dpa-root>.dpa-card:not(:nth-child(${card})){display:none}` : ''}</style>
<script src="/react.js"></script><script src="/react-dom.js"></script></head>
<body${theme === 'dark' ? ' data-ds-dark-theme' : ''}><div id="app"></div>
<script>
globalThis.__DSH_PHONE_APPROVAL_ADMIN__ = { url: location.origin + '/admin/${enc}', token: 'demo' }
window.__ModuleLoader__ = { load(def) { window.__def = def } }
</script><script src="/client.js"></script>
<script>
const plugin = __def.factory(n => n === 'react' ? React : undefined)
const dicts = {}, regs = []
plugin.apply({ effect: f => f(), locale: { register: (ns, d) => { dicts[ns] = d; return () => {} }, bind: ns => k => dicts[ns].zh[k] },
  slots: { inject: (n, f) => f(), register: (o, c) => { regs.push({ o, c }); return () => {} } } })
const main = regs.find(r => r.o.name === 'main')
ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(main.c, { t: k => dicts.phoneApproval.zh[k] }))
</script></body></html>`

const send = (res, type, body, code = 200) => { res.writeHead(code, { 'content-type': type }); res.end(body) }
createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/settings') return send(res, 'text/html; charset=utf-8', SETTINGS(url.searchParams.get('theme'), url.searchParams.get('enc') ?? 'on', url.searchParams.get('card')))
  if (p === '/frame') return send(res, 'text/html; charset=utf-8', `<!doctype html><style>html,body{margin:0;background:#000}iframe{border:0;width:390px;height:844px;display:block}</style><iframe src="${url.searchParams.get('src')}"></iframe>`)
  if (p === '/theme.css') return send(res, 'text/css', readFileSync(themeCss))
  if (p === '/react.js') return send(res, 'text/javascript', readFileSync(join(here, 'node_modules/react/umd/react.production.min.js')))
  if (p === '/react-dom.js') return send(res, 'text/javascript', readFileSync(join(here, 'node_modules/react-dom/umd/react-dom.production.min.js')))
  if (p === '/client.js') return send(res, 'text/javascript', readFileSync(join(repo, 'client.js')))
  const admin = /^\/admin\/(\w+)(\/.*)$/.exec(p)
  if (admin) {
    if (admin[2] === '/status') return send(res, 'application/json', JSON.stringify(status(admin[1])))
    if (admin[2] === '/encryption/reveal') return send(res, 'application/json', JSON.stringify({ key: 'ExampleKeyOnly-DoNotUse-12345678', iv: 'ExampleIV-000000' }))
    return send(res, 'application/json', '{"ok":true}')
  }
  const phone = /^\/(api\/)?a\/(\w+)$/.exec(p)
  if (phone) return phone[1] ? send(res, 'application/json', JSON.stringify(PHONE[phone[2]])) : send(res, 'text/html; charset=utf-8', PAGE_HTML)
  send(res, 'text/plain', 'not found', 404)
}).listen(Number(port), '127.0.0.1', () => console.log('listening', port))

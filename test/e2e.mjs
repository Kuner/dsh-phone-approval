// End-to-end test with a mocked DSH context and a software WebAuthn authenticator.
// Run: node test/e2e.mjs   (uses loopback ports 47398/47399; stubs Bark pushes)

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const { apply, stripMarkdown, ADMIN_GLOBAL } = await import(new URL('../index.js', import.meta.url))

const ORIGIN = 'https://test.example:8443'
const RPID = 'test.example'
const PORT = 47399
const ADMIN_PORT = 47398
const sha = d => createHash('sha256').update(d).digest()
const b64u = b => Buffer.from(b).toString('base64url')
let failures = 0
const check = (name, ok) => {
  if (!ok) failures += 1
  console.log(ok ? 'PASS' : 'FAIL', name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- minimal CBOR encoder for the software authenticator
function head(major, n) {
  if (n < 24) return Buffer.from([major << 5 | n])
  if (n < 256) return Buffer.from([major << 5 | 24, n])
  const b = Buffer.alloc(3)
  b[0] = major << 5 | 25
  b.writeUInt16BE(n, 1)
  return b
}
function enc(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]) }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])])
  throw new Error('enc')
}

// --- software authenticator (ES256, user verification always "passes")
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = publicKey.export({ format: 'jwk' })
const credId = randomBytes(16)
function authData(extra) {
  const counter = Buffer.alloc(4)
  return Buffer.concat([sha(RPID), Buffer.from([0x01 | 0x04 | (extra ? 0x40 : 0)]), counter, extra ?? Buffer.alloc(0)])
}
function register(challenge) {
  const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
  const len = Buffer.alloc(2)
  len.writeUInt16BE(credId.length)
  const ad = authData(Buffer.concat([Buffer.alloc(16), len, credId, cose]))
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN }))
  return {
    id: b64u(credId),
    clientDataJSON: b64u(cd),
    attestationObject: b64u(enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
  }
}
function assert(challenge, { tamper = false } = {}) {
  const ad = authData()
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }))
  const sig = sign('sha256', tamper ? Buffer.from('other') : Buffer.concat([ad, sha(cd)]), privateKey)
  return { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) }
}

// --- mocked DSH context
const pushes = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.day.app')) {
    pushes.push(JSON.parse(init.body))
    return { ok: true, status: 200, text: async () => '' }
  }
  return realFetch(url, init)
}
const refs = new Map([['DSH_BARK_KEY', 'KEY12345']])
const records = new Map()
const credentials = {
  resolve: async ref => (refs.has(ref) ? { value: refs.get(ref) } : undefined),
  describe: async ref => (refs.has(ref) ? { configured: true, masked: '••••2345' } : { configured: false }),
  set: async (ref, value) => { refs.set(ref, value) },
  unset: async (ref) => { refs.delete(ref) },
  readRecord: async key => records.get(key),
  modifyRecord: async (key, mutate) => {
    const next = await mutate(records.get(key))
    if (next !== undefined) records.set(key, next)
    return records.get(key)
  },
  deleteRecord: async (key) => { records.delete(key) },
}
const lateAnswers = []
let acceptLate = true
const userQuestions = { answer: (agent, callId, answer) => { if (!acceptLate) return false; lateAnswers.push({ agent, callId, answer }); return true } }
const edits = []
const configEditor = { edit: async (entry, change) => { edits.push(change({ phoneApproval: { port: PORT } })) } }
const handlers = {}
const effects = []
let indexInject
const ctx = {
  fiber: { entry: { id: 'phone-approval' } },
  logger: { warn: (...a) => console.log('  WARN', ...a), info: (...a) => console.log('  INFO', ...a) },
  effect(f) { const d = f(); if (typeof d === 'function') effects.push(d) },
  on(name, f) { handlers[name] = f },
  inject(names, cb) { cb({ on: (name, f) => { if (name === 'webserver/index-inject') indexInject = f } }) },
  get: name => ({
    credentials,
    configEditor,
    userQuestions,
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  })[name],
}

apply(ctx, { phoneApproval: { publicUrl: `${ORIGIN}/`, port: PORT, adminPort: ADMIN_PORT, ttlSeconds: 2, questionTtlSeconds: 30 } })
await sleep(300)

// --- admin token injection
const ownerRows = []
indexInject(ownerRows, { principal: { kind: 'owner' } })
const guestRows = []
indexInject(guestRows, { principal: { kind: 'liveshare' } })
const admin = ownerRows.find(row => row.name === ADMIN_GLOBAL)?.value
check('admin token injected for owner only', Boolean(admin?.token) && guestRows.length === 0)
const adminCall = (path, body, token = admin.token) => realFetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json() }))

check('admin rejects missing token', (await adminCall('/status', undefined, 'wrong')).status === 401)
let status = (await adminCall('/status')).json
check('status: bark configured + phone url', status.bark.configured && status.phone.url === `${ORIGIN}/` && status.phone.listening)
check('bark key from pasted URL', (await adminCall('/bark-key', { key: 'https://api.day.app/AbCdEf123456/hello' })).status === 200 && refs.get('DSH_BARK_KEY') === 'AbCdEf123456')
check('bad bark key rejected', (await adminCall('/bark-key', { key: 'x y' })).status === 400)
const before = pushes.length
check('test push', (await adminCall('/test-push', {})).status === 200 && pushes.length === before + 1)
check('config validation', (await adminCall('/config', { patch: { minTurnSeconds: -1 } })).status === 400)
const saved = await adminCall('/config', { patch: { minTurnSeconds: 30, events: { completed: false }, phoneApproval: { ttlSeconds: 300 } } })
check('config save merges', saved.status === 200 && edits.at(-1).minTurnSeconds === 30 && edits.at(-1).events.completed === false
  && edits.at(-1).phoneApproval.port === PORT && edits.at(-1).phoneApproval.ttlSeconds === 300)

// --- legacy passkey record is migrated
records.set('bark-notify/passkey', { kind: 'grant', payload: { credentialId: 'old', jwk: {}, signCount: 0, rpId: RPID } })
status = (await adminCall('/status')).json
check('legacy passkey migrated', status.phone.passkey.enrolled === true && records.has('phone-approval/passkey') && !records.has('bark-notify/passkey'))
check('reset passkey', (await adminCall('/passkey/reset', {})).status === 200 && !records.has('phone-approval/passkey'))

// --- approval flows
const base = `http://127.0.0.1:${PORT}`
const api = (token, path = '', body, origin = ORIGIN) => realFetch(`${base}/api/a/${token}${path}`, body === undefined
  ? {}
  : { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, json: await r.json() }))
const session = { id: 'sess1234abcd', header: {} }
const agent = { session }
handlers['session/event'](session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'rm -rf build && npm run deploy', workdir: '/repo' }) }, time: 0 })

function startApproval() {
  const toolSignal = new AbortController()
  const req = { agent: { session }, toolName: 'bash', callId: 'c1', reason: 'escalate **sandbox** to `danger-full-access`', signal: toolSignal.signal }
  let desktopSignal
  let resolveDesktop
  const next = () => { desktopSignal = req.signal; return new Promise((resolve) => { resolveDesktop = resolve }) }
  const result = handlers['approval/request'](req, next)
  return { result, toolSignal, desktop: () => desktopSignal, resolveDesktop: o => resolveDesktop(o) }
}
const tokenOf = () => new URL(pushes.at(-1).url).pathname.split('/').pop()

let a = startApproval()
await sleep(50)
let t = tokenOf()
check('push carries link + markdown stripped', pushes.at(-1).url.startsWith(`${ORIGIN}/a/`) && !pushes.at(-1).body.includes('**'))
const page = await realFetch(`${base}/a/${t}`)
check('page served', page.status === 200 && (await page.text()).includes('DSH 审批'))
let v = (await api(t)).json
check('view shows command, not enrolled', v.command.includes('npm run deploy') && v.enrolled === false && Boolean(v.enroll?.challenge))
check('wrong origin rejected', (await api(t, '/enroll', register(v.enroll.challenge), 'https://evil.example')).status === 403)
check('wrong challenge rejected', (await api(t, '/enroll', register('nope'))).status === 400)
v = (await api(t)).json
let r = await api(t, '/enroll', register(v.enroll.challenge))
check('enroll ok', r.status === 200 && r.json.state.enrolled && Boolean(r.json.state.challenge))
check('re-enroll refused', (await api(t, '/enroll', register(r.json.state.challenge))).status !== 200)
v = (await api(t)).json
check('tampered signature rejected', (await api(t, '/decide', { decision: 'allow', assertion: assert(v.challenge, { tamper: true }) })).status === 403)
check('allow without assertion rejected', (await api(t, '/decide', { decision: 'allow' })).status === 403)
v = (await api(t)).json
const used = v.challenge
r = await api(t, '/decide', { decision: 'allow', assertion: assert(v.challenge) })
check('allow ok', r.status === 200 && r.json.state.status === 'allowed')
check('waterfall returns allowed-once', (await a.result) === 'allowed-once')
check('desktop prompt withdrawn', a.desktop().aborted === true && a.toolSignal.signal.aborted === false)
check('replay refused', (await api(t, '/decide', { decision: 'allow', assertion: assert(used) })).status === 409)

a = startApproval()
await sleep(50)
t = tokenOf()
r = await api(t, '/decide', { decision: 'reject' })
check('phone reject → rejected', r.status === 200 && (await a.result) === 'rejected' && a.desktop().aborted)

a = startApproval()
await sleep(50)
t = tokenOf()
a.resolveDesktop('allowed-once')
check('desktop wins → allowed-once', (await a.result) === 'allowed-once')
check('phone page shows elsewhere', (await api(t)).json.status === 'elsewhere')

a = startApproval()
await sleep(50)
t = tokenOf()
a.toolSignal.abort()
check('tool cancel → cancelled', (await a.result) === 'cancelled' && (await api(t)).json.status === 'cancelled')

a = startApproval()
await sleep(50)
t = tokenOf()
a.resolveDesktop('unavailable')
const raced = await Promise.race([a.result, sleep(300).then(() => 'still-waiting')])
check('no desktop answerer keeps waiting for phone', raced === 'still-waiting')
check('link expiry → unavailable', (await a.result) === 'unavailable' && (await api(t)).json.status === 'expired')

// --- question flows (release-gate style ask_user_question)
const GATE = [{
  id: 'gate-053', header: '发布门禁 v2.26.0', question: '053 已合并。\n\n确认发布吗？',
  options: [{ label: '确认发布，用默认值 (Recommended)', description: '运行 release.sh' }, { label: '先不发布' }],
}]
function startQuestion({ timed = false } = {}) {
  const toolSignal = new AbortController()
  const req = { questions: GATE, agent, signal: toolSignal.signal, ...(timed ? { wait: { callId: 'q-timed', timed: true } } : {}) }
  let desktopSignal
  let resolveDesktop
  let rejectDesktop
  const next = () => { desktopSignal = req.signal; return new Promise((res, rej) => { resolveDesktop = res; rejectDesktop = rej }) }
  const result = handlers['user-questions/request'](req, next)
  result.catch(() => {})
  return { result, toolSignal, desktop: () => desktopSignal, resolveDesktop: v => resolveDesktop(v), rejectDesktop: e => rejectDesktop(e) }
}
const answerBody = (challenge, answers) => ({ decision: 'answer', answers, assertion: assert(challenge) })
const GO = [{ id: 'gate-053', selected: ['确认发布，用默认值 (Recommended)'] }]

const pushesBefore = pushes.length
handlers['session/event'](session, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: GATE }) }, time: 0 })
check('no plain question push when phone questions are ready', pushes.length === pushesBefore)

let q = startQuestion()
await sleep(50)
t = tokenOf()
check('question push carries link', pushes.at(-1).title.startsWith('❓') && pushes.at(-1).url.startsWith(`${ORIGIN}/a/`) && pushes.at(-1).body.includes('确认发布吗'))
v = (await api(t)).json
check('question view lists options', v.kind === 'question' && v.questions[0].options.length === 2 && v.enrolled === true && Boolean(v.challenge))
check('answer without Face ID rejected', (await api(t, '/decide', { decision: 'answer', answers: GO })).status === 403)
v = (await api(t)).json
check('unknown option rejected', (await api(t, '/decide', answerBody(v.challenge, [{ id: 'gate-053', selected: ['随便发'] }]))).status === 400)
check('empty answer rejected', (await api(t, '/decide', answerBody(v.challenge, [{ id: 'gate-053', selected: [] }]))).status === 400)
check('two choices on single-select rejected', (await api(t, '/decide', answerBody(v.challenge, [{ id: 'gate-053', selected: ['先不发布', '确认发布，用默认值 (Recommended)'] }]))).status === 400)
v = (await api(t)).json
r = await api(t, '/decide', answerBody(v.challenge, GO))
check('phone answer accepted', r.status === 200 && r.json.state.status === 'answered')
check('waterfall returns the phone answer', JSON.stringify(await q.result) === JSON.stringify({ answers: GO }))
check('desktop question withdrawn', q.desktop().aborted === true && q.toolSignal.signal.aborted === false)

q = startQuestion()
await sleep(50)
t = tokenOf()
v = (await api(t)).json
r = await api(t, '/decide', answerBody(v.challenge, [{ id: 'gate-053', selected: [], custom: '等我看完日志再说' }]))
check('custom text answer', r.status === 200 && (await q.result).answers[0].custom === '等我看完日志再说')

q = startQuestion()
await sleep(50)
t = tokenOf()
q.resolveDesktop({ answers: [{ id: 'gate-053', selected: ['先不发布'] }] })
check('desktop answer wins', (await q.result).answers[0].selected[0] === '先不发布' && (await api(t)).json.status === 'elsewhere')

q = startQuestion()
await sleep(50)
t = tokenOf()
q.rejectDesktop(Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' }))
await sleep(50)
v = (await api(t)).json
check('no desktop answerer keeps the phone link open', v.status === 'pending')
await api(t, '/decide', answerBody(v.challenge, GO))
check('phone answers when desktop is absent', JSON.stringify(await q.result) === JSON.stringify({ answers: GO }))

// Timed question whose foreground window closed: the call returns pending, the phone answers later.
q = startQuestion({ timed: true })
await sleep(50)
t = tokenOf()
const timeout = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })
q.toolSignal.abort(timeout)
let thrown
try { await q.result } catch (error) { thrown = error }
check('timed-out question rethrows the timeout', thrown === timeout)
check('continued question link stays open', (await api(t)).json.status === 'pending')
v = (await api(t)).json
r = await api(t, '/decide', answerBody(v.challenge, GO))
check('continued answer goes through userQuestions.answer', r.status === 200 && lateAnswers.length === 1
  && lateAnswers[0].callId === 'q-timed' && lateAnswers[0].agent === agent && JSON.stringify(lateAnswers[0].answer) === JSON.stringify({ answers: GO }))

q = startQuestion({ timed: true })
await sleep(50)
t = tokenOf()
q.toolSignal.abort(timeout)
await q.result.catch(() => {})
handlers['session/event'](session, { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'q-timed', outcome: 'answered' } }, time: 0 })
check('desktop late reply closes the continued link', (await api(t)).json.status === 'elsewhere')

q = startQuestion({ timed: true })
await sleep(50)
t = tokenOf()
q.toolSignal.abort(timeout)
await q.result.catch(() => {})
acceptLate = false
v = (await api(t)).json
r = await api(t, '/decide', answerBody(v.challenge, GO))
check('already-answered continued question reports elsewhere', r.status === 409 && r.json.state.status === 'elsewhere')

q = startQuestion()
await sleep(50)
t = tokenOf()
q.toolSignal.abort(new Error('turn cancelled'))
await q.result.catch(() => {})
check('cancelled question closes the link', (await api(t)).json.status === 'cancelled')

check('unknown token 404', (await api('zzz')).status === 404)
check('root 404', (await realFetch(`${base}/`)).status === 404)
check('stripMarkdown', stripMarkdown('## 标题\n**粗体** `code` [link](http://x)') === '标题\n粗体 code link')

for (const dispose of effects) dispose()
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

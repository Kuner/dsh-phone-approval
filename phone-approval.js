// Phone approval: a loopback HTTP server (exposed to the tailnet by `tailscale serve`)
// that lets the owner allow (Face ID passkey required) or reject one pending approval
// through a one-time, short-lived link delivered by Bark.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { PAGE_HTML } from './page.js'
import { b64url, verifyAssertion, verifyRegistration } from './webauthn.js'

const PASSKEY_RECORD = 'phone-approval/passkey'
// Earlier releases were named dsh-bark-notify; an enrolled passkey is migrated once.
const LEGACY_PASSKEY_RECORD = 'bark-notify/passkey'
const MAX_BODY_BYTES = 64 * 1024
const MAX_FAILED_ASSERTIONS = 5
// Keep settled entries briefly so an open page can show the final state.
const SETTLED_RETENTION_MS = 10 * 60 * 1000

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

const newChallenge = () => b64url(randomBytes(32))

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** A minimal static HTML page for links opened outside an approval flow. */
function infoPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>DSH</title><style>body{margin:0;padding:48px 24px;font:17px/1.5 -apple-system,"PingFang SC",sans-serif;text-align:center}
h1{font-size:22px}p{color:#888}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`
}

export class PhoneApproval {
  /**
   * @param options - { logger, getCredentials, host, port, ttlSeconds }
   */
  constructor(options) {
    this.logger = options.logger
    this.getCredentials = options.getCredentials
    this.host = options.host
    this.port = options.port
    this.ttlMs = options.ttlSeconds * 1000
    this.entries = new Map()
    this.server = undefined
    this.ready = false
    this.passkeyCache = undefined
    this.base = undefined
    this.origin = undefined
    this.rpId = undefined
  }

  /**
   * Set the HTTPS URL the phone opens; the passkey is bound to its host name.
   * @param publicUrl - e.g. https://mac.tailnet.ts.net:8443/, or undefined when unknown.
   */
  setPublicUrl(publicUrl) {
    if (!publicUrl) {
      this.base = this.origin = this.rpId = undefined
      return
    }
    const url = new URL(publicUrl)
    if (url.protocol !== 'https:') throw new Error('publicUrl must be an https:// URL (Face ID requires HTTPS)')
    const base = url.href.endsWith('/') ? url.href : `${url.href}/`
    if (base === this.base) return
    this.base = base
    this.origin = url.origin
    this.rpId = url.hostname
    this.passkeyCache = undefined
  }

  /** Whether approval links can be issued right now. */
  get available() {
    return this.ready && this.base !== undefined
  }

  start() {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.warn(`phone-approval: phone approval request failed: ${String(error?.message ?? error)}`)
        if (!res.headersSent) this.json(res, 500, { error: 'internal error' })
        else res.end()
      })
    })
    server.on('error', (error) => {
      this.ready = false
      this.logger.warn(`phone-approval: phone approval server error: ${String(error?.message ?? error)}`)
    })
    server.listen(this.port, this.host, () => {
      this.ready = true
      this.logger.info?.(`phone-approval: approval page server listening on http://${this.host}:${this.port}`)
    })
    this.server = server
  }

  stop() {
    this.ready = false
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') this.finish(entry, 'cancelled', 'expired')
      clearTimeout(entry.timer)
    }
    this.entries.clear()
    this.server?.close()
    this.server?.closeAllConnections?.()
    this.server = undefined
  }

  /**
   * Open one phone decision window.
   * @param info - approval: { kind: 'approval', session, tool, reason, command };
   *   question: { kind: 'question', session, questions }.
   * @returns { url, result, settle, setCommit } — `result` resolves to 'allowed-once' or
   *   'rejected' for approvals, `{ answers }` for questions, or 'expired'.
   */
  create(info, { ttlMs = this.ttlMs } = {}) {
    const token = b64url(randomBytes(32))
    let resolve
    const result = new Promise((r) => { resolve = r })
    const entry = {
      token,
      info: { kind: 'approval', ...info },
      status: 'pending',
      expiresAt: Date.now() + ttlMs,
      challenge: newChallenge(),
      enrollChallenge: newChallenge(),
      enrollUserId: b64url(randomBytes(16)),
      failures: 0,
      resolve,
      timer: undefined,
      // Optional async hook run before a phone decision is accepted; a throw keeps the link open.
      commit: undefined,
      committing: false,
    }
    entry.timer = setTimeout(() => this.finish(entry, 'expired', 'expired'), ttlMs)
    entry.timer.unref?.()
    this.entries.set(token, entry)
    return {
      url: `${this.base}a/${token}`,
      result,
      // Called when the request was decided elsewhere (desktop) or withdrawn.
      settle: status => this.finish(entry, status, 'expired'),
      setCommit: (fn) => { entry.commit = fn },
      get pending() { return entry.status === 'pending' },
    }
  }

  finish(entry, status, outcome) {
    if (entry.status !== 'pending') return
    entry.status = status
    clearTimeout(entry.timer)
    entry.resolve(outcome)
    entry.timer = setTimeout(() => this.entries.delete(entry.token), SETTLED_RETENTION_MS)
    entry.timer.unref?.()
  }

  async readPasskey() {
    if (this.passkeyCache !== undefined) return this.passkeyCache
    const credentials = this.getCredentials()
    if (!credentials || this.rpId === undefined) return null
    let record = await credentials.readRecord(PASSKEY_RECORD)
    if (record === undefined) {
      const legacy = await credentials.readRecord(LEGACY_PASSKEY_RECORD)
      if (legacy?.kind === 'grant') {
        await credentials.modifyRecord(PASSKEY_RECORD, async current => (current === undefined ? legacy : undefined))
        await credentials.deleteRecord?.(LEGACY_PASSKEY_RECORD)
        record = await credentials.readRecord(PASSKEY_RECORD)
        this.logger.info?.('phone-approval: migrated passkey from bark-notify/passkey')
      }
    }
    const payload = record?.kind === 'grant' ? record.payload : undefined
    const valid = payload && typeof payload.credentialId === 'string' && payload.jwk && payload.rpId === this.rpId
    // Cache only a found passkey, so a record written elsewhere is picked up on the next read.
    this.passkeyCache = valid ? payload : undefined
    return valid ? payload : null
  }

  /** Describe the enrolled passkey without exposing key material. */
  async passkeyInfo() {
    const credentials = this.getCredentials()
    if (!credentials) return { enrolled: false }
    await this.readPasskey() // performs the one-time legacy migration
    const record = await credentials.readRecord(PASSKEY_RECORD)
    const payload = record?.kind === 'grant' ? record.payload : undefined
    if (!payload) return { enrolled: false }
    return { enrolled: true, rpId: payload.rpId, createdAt: payload.createdAt, matchesUrl: payload.rpId === this.rpId }
  }

  /** Forget the enrolled passkey; the next approval link offers enrollment again. */
  async resetPasskey() {
    const credentials = this.getCredentials()
    if (!credentials) throw new Error('DSH credentials store is unavailable')
    await credentials.deleteRecord(PASSKEY_RECORD)
    await credentials.deleteRecord(LEGACY_PASSKEY_RECORD)
    this.passkeyCache = undefined
  }

  async writePasskey(mutate) {
    const credentials = this.getCredentials()
    if (!credentials) throw new Error('DSH credentials store is unavailable')
    let written
    await credentials.modifyRecord(PASSKEY_RECORD, async (current) => {
      const next = await mutate(current?.kind === 'grant' ? current.payload : undefined)
      if (next === undefined) return undefined
      written = next
      return { kind: 'grant', payload: next }
    })
    this.passkeyCache = undefined
    return written
  }

  async view(entry) {
    const passkey = await this.readPasskey()
    const base = {
      kind: entry.info.kind,
      status: entry.status,
      session: entry.info.session,
      ...(entry.info.kind === 'question'
        ? { questions: entry.info.questions, answers: entry.answers }
        : { tool: entry.info.tool, reason: entry.info.reason, command: entry.info.command }),
      expiresAt: entry.expiresAt,
      rpId: this.rpId,
      enrolled: Boolean(passkey),
    }
    if (entry.status !== 'pending') return base
    return passkey
      ? { ...base, credentialId: passkey.credentialId, challenge: entry.challenge }
      : { ...base, enroll: { challenge: entry.enrollChallenge, userId: entry.enrollUserId } }
  }

  json(res, status, body) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  async readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(chunk)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 })
    }
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://local')
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'a') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
      return
    }
    if (parts[0] !== 'api') {
      // Pages a phone opens directly (the test push link, a mistyped link) get HTML,
      // never JSON, which iOS Safari would offer as a "document.json" download.
      const home = req.method === 'GET' && parts.length === 0
      res.writeHead(home ? 200 : 404, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
      res.end(infoPage(home ? '✅ 手机能连到 DSH 审批服务' : '链接无效或已失效',
        home ? '审批和提问推送里的链接会在这里打开。' : '请回到电脑上处理。'))
      return
    }
    if (parts[1] !== 'a' || parts.length < 3) {
      this.json(res, 404, { error: 'not found' })
      return
    }
    const entry = this.entries.get(parts[2])
    if (entry === undefined) {
      this.json(res, 404, { error: 'unknown or expired link' })
      return
    }
    const action = parts[3]

    if (req.method === 'GET' && action === undefined) {
      this.json(res, 200, await this.view(entry))
      return
    }
    if (req.method !== 'POST' || (action !== 'enroll' && action !== 'decide')) {
      this.json(res, 404, { error: 'not found' })
      return
    }
    // Same-origin POSTs only: the page is served from the tailnet origin.
    if (req.headers.origin !== this.origin) {
      this.json(res, 403, { error: 'origin not allowed' })
      return
    }
    let body
    try {
      body = await this.readBody(req)
    } catch (error) {
      this.json(res, error.status ?? 400, { error: error.message })
      return
    }
    if (entry.status !== 'pending') {
      this.json(res, 409, { error: '请求已结束', state: await this.view(entry) })
      return
    }
    if (action === 'enroll') await this.enroll(entry, body, res)
    else await this.decide(entry, body, res)
  }

  async enroll(entry, body, res) {
    const expected = { challenge: entry.enrollChallenge, origin: this.origin, rpId: this.rpId }
    entry.enrollChallenge = newChallenge()
    let credential
    try {
      credential = verifyRegistration(body, expected)
    } catch (error) {
      this.json(res, 400, { error: `注册失败：${error.message}`, state: await this.view(entry) })
      return
    }
    let refused = false
    await this.writePasskey(async (current) => {
      // Enrollment is only possible while no passkey exists; re-enrolling requires
      // resetting it from the plugin's settings page on the Mac.
      if (current && current.rpId === this.rpId) {
        refused = true
        return undefined
      }
      return credential
    })
    if (refused) {
      this.json(res, 409, { error: '已经注册过 Face ID', state: await this.view(entry) })
      return
    }
    this.logger.info?.('phone-approval: phone approval passkey enrolled')
    this.json(res, 200, { ok: true, state: await this.view(entry) })
  }

  /**
   * Verify the Face ID assertion in `body`; on failure the response is written.
   * @returns whether the caller may proceed.
   */
  async checkFaceId(entry, body, res) {
    const passkey = await this.readPasskey()
    if (!passkey) {
      this.json(res, 409, { error: '请先注册 Face ID', state: await this.view(entry) })
      return false
    }
    const expected = { challenge: entry.challenge, origin: this.origin, rpId: this.rpId }
    // Every challenge is single-use, successful or not.
    entry.challenge = newChallenge()
    let signCount
    try {
      signCount = verifyAssertion(body.assertion, passkey, expected)
    } catch (error) {
      entry.failures += 1
      this.logger.warn(`phone-approval: Face ID check failed: ${error.message}`)
      if (entry.failures >= MAX_FAILED_ASSERTIONS) this.finish(entry, 'expired', 'expired')
      this.json(res, 403, { error: `验证失败：${error.message}`, state: await this.view(entry) })
      return false
    }
    if (entry.status !== 'pending') {
      this.json(res, 409, { error: '请求已结束', state: await this.view(entry) })
      return false
    }
    if (signCount !== passkey.signCount) {
      await this.writePasskey(async current => (current ? { ...current, signCount } : undefined))
    }
    return true
  }

  /** Run the entry's commit hook once; on failure the response is written and the link stays open. */
  async commitDecision(entry, outcome, res) {
    if (entry.commit === undefined) return true
    if (entry.committing) {
      this.json(res, 409, { error: '正在提交，请稍候', state: await this.view(entry) })
      return false
    }
    entry.committing = true
    try {
      await entry.commit(outcome)
      return true
    } catch (error) {
      const message = String(error?.message ?? error)
      this.logger.warn(`phone-approval: could not deliver the phone decision: ${message}`)
      if (error?.settled) this.finish(entry, error.settled, 'expired')
      this.json(res, 409, { error: `提交失败：${message}`, state: await this.view(entry) })
      return false
    } finally {
      entry.committing = false
    }
  }

  async decide(entry, body, res) {
    if (entry.info.kind === 'question') {
      await this.answer(entry, body, res)
      return
    }
    if (body?.decision === 'reject') {
      // Rejecting is always safe, so it does not require Face ID.
      this.finish(entry, 'rejected', 'rejected')
      this.json(res, 200, { ok: true, state: await this.view(entry) })
      return
    }
    if (body?.decision !== 'allow') {
      this.json(res, 400, { error: 'unknown decision' })
      return
    }
    if (!(await this.checkFaceId(entry, body, res))) return
    this.finish(entry, 'allowed', 'allowed-once')
    this.json(res, 200, { ok: true, state: await this.view(entry) })
  }

  async answer(entry, body, res) {
    if (body?.decision !== 'answer') {
      this.json(res, 400, { error: 'unknown decision' })
      return
    }
    let answers
    try {
      answers = normalizeAnswers(entry.info.questions, body.answers)
    } catch (error) {
      this.json(res, 400, { error: error.message, state: await this.view(entry) })
      return
    }
    // An answer can authorize work (for example a release gate), so it needs Face ID too.
    if (!(await this.checkFaceId(entry, body, res))) return
    const outcome = { answers }
    if (!(await this.commitDecision(entry, outcome, res))) return
    entry.answers = answers
    this.finish(entry, 'answered', outcome)
    this.json(res, 200, { ok: true, state: await this.view(entry) })
  }
}

const MAX_CUSTOM_CHARS = 2000

/**
 * Validate a phone answer batch against the asked questions: one item per question,
 * selected labels drawn from the offered options, single-select at most one choice,
 * and a non-empty choice or custom text for every question.
 * @returns the normalized `answers` array in question order.
 */
export function normalizeAnswers(questions, raw) {
  if (!Array.isArray(raw)) throw new Error('answers must be a list')
  const byId = new Map()
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || byId.has(item.id)) throw new Error('每个问题只能回答一次')
    byId.set(item.id, item)
  }
  if (byId.size !== questions.length) throw new Error('请回答所有问题')
  return questions.map((question) => {
    const item = byId.get(question.id)
    if (item === undefined) throw new Error('请回答所有问题')
    const labels = new Set((question.options ?? []).map(option => option.label))
    const selected = Array.isArray(item.selected) ? [...new Set(item.selected.map(String))] : []
    for (const label of selected) {
      if (!labels.has(label)) throw new Error(`「${label}」不是这个问题的选项`)
    }
    const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
    if (Array.from(custom).length > MAX_CUSTOM_CHARS) throw new Error('自定义回答太长')
    if (question.multiSelect !== true) {
      if (selected.length > 1) throw new Error('这个问题只能选一项')
      // Single-select: custom text replaces the choice, as in the desktop UI.
      if (custom) return { id: question.id, selected: [], custom }
    }
    if (selected.length === 0 && !custom) throw new Error(`请回答：${question.header || question.question.slice(0, 20)}`)
    return { id: question.id, selected, ...(custom ? { custom } : {}) }
  })
}

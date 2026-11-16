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
   * @param info - { session, tool, reason, command } shown on the page.
   * @returns { url, result, settle } — `result` resolves to 'allowed-once', 'rejected', or 'expired'.
   */
  create(info) {
    const token = b64url(randomBytes(32))
    let resolve
    const result = new Promise((r) => { resolve = r })
    const entry = {
      token,
      info,
      status: 'pending',
      expiresAt: Date.now() + this.ttlMs,
      challenge: newChallenge(),
      enrollChallenge: newChallenge(),
      enrollUserId: b64url(randomBytes(16)),
      failures: 0,
      resolve,
      timer: undefined,
    }
    entry.timer = setTimeout(() => this.finish(entry, 'expired', 'expired'), this.ttlMs)
    entry.timer.unref?.()
    this.entries.set(token, entry)
    return {
      url: `${this.base}a/${token}`,
      result,
      // Called when the request was decided elsewhere (desktop) or withdrawn.
      settle: status => this.finish(entry, status, 'expired'),
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
      status: entry.status,
      session: entry.info.session,
      tool: entry.info.tool,
      reason: entry.info.reason,
      command: entry.info.command,
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
    if (parts[0] !== 'api' || parts[1] !== 'a' || parts.length < 3) {
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

  async decide(entry, body, res) {
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
    const passkey = await this.readPasskey()
    if (!passkey) {
      this.json(res, 409, { error: '请先注册 Face ID', state: await this.view(entry) })
      return
    }
    const expected = { challenge: entry.challenge, origin: this.origin, rpId: this.rpId }
    // Every challenge is single-use, successful or not.
    entry.challenge = newChallenge()
    let signCount
    try {
      signCount = verifyAssertion(body.assertion, passkey, expected)
    } catch (error) {
      entry.failures += 1
      this.logger.warn(`phone-approval: phone approval Face ID check failed: ${error.message}`)
      if (entry.failures >= MAX_FAILED_ASSERTIONS) this.finish(entry, 'expired', 'expired')
      this.json(res, 403, { error: `验证失败：${error.message}`, state: await this.view(entry) })
      return
    }
    if (entry.status !== 'pending') {
      this.json(res, 409, { error: '请求已结束', state: await this.view(entry) })
      return
    }
    if (signCount !== passkey.signCount) {
      await this.writePasskey(async current => (current ? { ...current, signCount } : undefined))
    }
    this.finish(entry, 'allowed', 'allowed-once')
    this.json(res, 200, { ok: true, state: await this.view(entry) })
  }
}

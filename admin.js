// Loopback-only admin API for the plugin's settings page inside DSH.
//
// The port is never published by `tailscale serve`, and every request must carry the
// bearer token that the Host injects only into pages rendered for the owner Peer, so
// neither other tailnet devices nor arbitrary local web pages can drive it.

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const MAX_BODY_BYTES = 16 * 1024

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function tokenMatches(header, token) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!match) return false
  const given = Buffer.from(match[1].trim())
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export class AdminServer {
  /**
   * @param options - { logger, host, port, token, routes } where routes maps
   *   `METHOD /path` to async (body) => JSON result.
   */
  constructor(options) {
    this.logger = options.logger
    this.host = options.host
    this.port = options.port
    this.token = options.token
    this.routes = options.routes
    this.server = undefined
  }

  start() {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.warn(`phone-approval: admin request failed: ${String(error?.message ?? error)}`)
        if (!res.headersSent) this.json(res, 500, { error: String(error?.message ?? error) })
        else res.end()
      })
    })
    server.on('error', (error) => {
      this.logger.warn(`phone-approval: admin server error: ${String(error?.message ?? error)}`)
    })
    server.listen(this.port, this.host)
    this.server = server
  }

  stop() {
    // Let an in-flight request (for example the config save that restarts this
    // plugin) finish writing its answer.
    this.server?.close()
    this.server?.closeIdleConnections?.()
    this.server = undefined
  }

  json(res, status, body) {
    res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' })
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    if (!tokenMatches(req.headers.authorization, this.token)) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    const path = new URL(req.url ?? '/', 'http://local').pathname
    const route = this.routes[`${req.method} ${path}`]
    if (route === undefined) {
      this.json(res, 404, { error: 'not found' })
      return
    }
    let body = {}
    if (req.method === 'POST') {
      try {
        body = await this.readBody(req)
      } catch (error) {
        this.json(res, error.status ?? 400, { error: error.message })
        return
      }
    }
    try {
      this.json(res, 200, await route(body))
    } catch (error) {
      this.json(res, error.status ?? 400, { error: String(error?.message ?? error) })
    }
  }
}

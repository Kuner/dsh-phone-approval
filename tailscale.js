// Read-mostly helpers around the local Tailscale CLI: connection state, the MagicDNS
// name used to build the phone approval URL, and the `tailscale serve` mapping that
// publishes the loopback approval server to the tailnet over HTTPS.

import { execFile } from 'node:child_process'

// GUI-launched apps often lack Homebrew or /usr/local/bin on PATH, so probe known locations.
const CANDIDATES = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
]

function run(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

let binaryPromise
function findBinary() {
  binaryPromise ??= (async () => {
    for (const candidate of CANDIDATES) {
      const result = await run(candidate, ['version'], 4000)
      if (result.ok) return candidate
    }
    return undefined
  })()
  return binaryPromise.then((binary) => {
    if (binary === undefined) binaryPromise = undefined // retry later, e.g. after installation
    return binary
  })
}

function parseJson(text) {
  try {
    // Some builds print a warning line before the JSON document.
    const start = text.indexOf('{')
    return start >= 0 ? JSON.parse(text.slice(start)) : undefined
  } catch {
    return undefined
  }
}

/**
 * Inspect Tailscale for the phone approval setup.
 * @param httpsPort - tailnet HTTPS port the approval page is published on.
 * @param localPort - loopback port of the approval server.
 */
export async function tailscaleStatus(httpsPort, localPort) {
  const binary = await findBinary()
  if (binary === undefined) return { installed: false, running: false, serveOk: false }
  const status = parseJson((await run(binary, ['status', '--json'])).stdout)
  const running = status?.BackendState === 'Running'
  const dnsName = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : undefined
  const httpsEnabled = Array.isArray(status?.CertDomains) && status.CertDomains.length > 0
  let serveOk = false
  if (running) {
    const serve = parseJson((await run(binary, ['serve', 'status', '--json'])).stdout)
    for (const [hostPort, web] of Object.entries(serve?.Web ?? {})) {
      if (!hostPort.endsWith(`:${httpsPort}`)) continue
      const proxy = web?.Handlers?.['/']?.Proxy
      if (typeof proxy === 'string' && new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${localPort}/?$`).test(proxy)) {
        serveOk = true
      }
    }
  }
  return {
    installed: true,
    running,
    dnsName,
    httpsEnabled,
    serveOk,
    url: running && dnsName ? `https://${dnsName}:${httpsPort}/` : undefined,
  }
}

/** Publish the loopback approval server to the tailnet (HTTPS, tailnet only — never Funnel). */
export async function enableServe(httpsPort, localPort) {
  const binary = await findBinary()
  if (binary === undefined) return { ok: false, error: '没有找到 tailscale 命令' }
  const result = await run(binary, ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], 20000)
  return result.ok
    ? { ok: true }
    : { ok: false, error: (result.stderr || result.stdout || 'tailscale serve failed').trim().slice(0, 500) }
}

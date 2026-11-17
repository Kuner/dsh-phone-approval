// DSH phone approval: push DSH attention events to an iPhone through Bark
// (https://bark.day.app), answer approval requests from the phone with Face ID,
// and manage everything from a settings page on the plugin's DSH detail page.
//
// Notifications observe committed `session/event` appends only. Phone approval adds
// one `approval/request` waterfall listener that races a phone decision against the
// regular answerers (the desktop approval panel): whichever decides first wins, and
// when the phone wins the desktop prompt is withdrawn through the request signal.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AdminServer } from './admin.js'
import { PhoneApproval } from './phone-approval.js'
import { enableServe, tailscaleStatus } from './tailscale.js'

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

// Survives plugin restarts within one DSH process, so a settings page that was
// opened before a config save keeps working.
const ADMIN_TOKEN = randomBytes(32).toString('base64url')
export const ADMIN_GLOBAL = '__DSH_PHONE_APPROVAL_ADMIN__'

const DEFAULTS = {
  server: 'https://api.day.app',
  credential: 'DSH_BARK_KEY',
  events: {
    approval: true,
    question: true,
    completed: true,
    error: true,
  },
  // Skip "completed" pushes for turns shorter than this many seconds (0 = always push).
  minTurnSeconds: 0,
  // Include approval reasons, question text, and answer previews in the push body.
  includeDetails: true,
  // Optional URL opened when a non-approval notification is tapped.
  openUrl: '',
  group: 'DSH',
  timeoutMs: 10000,
  phoneApproval: {
    enabled: true,
    // HTTPS URL the phone opens; empty = https://<this Mac's MagicDNS name>:<httpsPort>/ from Tailscale.
    publicUrl: '',
    httpsPort: 8443,
    host: '127.0.0.1',
    port: 47391,
    // Loopback admin API for the settings page; never published to the tailnet.
    adminPort: 47392,
    // How long each phone approval link stays valid.
    ttlSeconds: 600,
    // Answer agent questions (ask_user_question, plan reviews) on the phone; answers need Face ID.
    questions: true,
    // Questions such as release gates can wait for hours, so their links live longer.
    questionTtlSeconds: 21600,
  },
}

const QUESTION_TOOLS = new Set(['ask_user_question'])
const MAX_TRACKED_CALLS = 30
const TAILSCALE_REFRESH_MS = 60 * 1000

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  config.events = { ...DEFAULTS.events, ...(raw?.events ?? {}) }
  config.phoneApproval = { ...DEFAULTS.phoneApproval, ...(raw?.phoneApproval ?? {}) }
  config.server = String(config.server).replace(/\/+$/, '')
  return config
}

/** Remove common Markdown so push bodies read as plain text. */
export function stripMarkdown(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\|/g, ' ')
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

function assistantText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function questionText(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments)
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
    return questions.map(q => q?.question).filter(q => typeof q === 'string').join(' / ')
  } catch {
    return ''
  }
}

function errorText(reason) {
  const error = reason?.error
  if (!error) return ''
  return [error.code, error.message].filter(v => typeof v === 'string' && v.length > 0).join(': ')
}

/** Human-readable description of a tool call for the phone page (never pushed). */
export function describeCall(call) {
  if (!call) return ''
  let args
  try {
    args = JSON.parse(call.arguments)
  } catch {
    return Array.from(String(call.arguments ?? '')).slice(0, 4000).join('')
  }
  if (args && typeof args.command === 'string') {
    const where = typeof args.workdir === 'string' ? `\n\n（目录：${args.workdir}）` : ''
    return `${args.command}${where}`
  }
  const json = JSON.stringify(args, null, 2) ?? ''
  return json.length > 4000 ? `${json.slice(0, 3999)}…` : json
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/** Validate a settings-page edit; only known fields with the right types pass. */
export function sanitizeConfigPatch(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') throw fail('invalid settings')
  if (patch.server !== undefined) {
    const url = new URL(String(patch.server))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('Bark 服务器地址必须是 http(s) URL')
    out.server = url.href.replace(/\/+$/, '')
  }
  if (patch.events !== undefined) {
    out.events = {}
    for (const key of Object.keys(DEFAULTS.events)) {
      if (patch.events[key] !== undefined) out.events[key] = Boolean(patch.events[key])
    }
  }
  if (patch.includeDetails !== undefined) out.includeDetails = Boolean(patch.includeDetails)
  if (patch.minTurnSeconds !== undefined) {
    const value = Number(patch.minTurnSeconds)
    if (!Number.isInteger(value) || value < 0 || value > 86400) throw fail('“最短轮次”必须是 0–86400 的整数')
    out.minTurnSeconds = value
  }
  if (patch.phoneApproval !== undefined) {
    const phone = patch.phoneApproval
    out.phoneApproval = {}
    if (phone.enabled !== undefined) out.phoneApproval.enabled = Boolean(phone.enabled)
    if (phone.questions !== undefined) out.phoneApproval.questions = Boolean(phone.questions)
    if (phone.publicUrl !== undefined) {
      const text = String(phone.publicUrl).trim()
      if (text !== '' && new URL(text).protocol !== 'https:') throw fail('审批页地址必须是 https:// 开头')
      out.phoneApproval.publicUrl = text
    }
    if (phone.ttlSeconds !== undefined) {
      const value = Number(phone.ttlSeconds)
      if (!Number.isInteger(value) || value < 60 || value > 3600) throw fail('链接有效期必须是 60–3600 秒')
      out.phoneApproval.ttlSeconds = value
    }
  }
  return out
}

function mergeConfig(current, patch) {
  const base = current && typeof current === 'object' ? current : {}
  return {
    ...base,
    ...patch,
    ...(patch.events ? { events: { ...(base.events ?? {}), ...patch.events } } : {}),
    ...(patch.phoneApproval ? { phoneApproval: { ...(base.phoneApproval ?? {}), ...patch.phoneApproval } } : {}),
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const phoneConfig = config.phoneApproval
  const logger = ctx.logger
  const entry = ctx.fiber?.entry
  // Per-session transient state: turn start, latest assistant text, recent tool calls.
  const sessions = new Map()
  let warnedMissingKey = false
  let warnedSignalSwap = false
  let disposed = false

  const stateOf = (session) => {
    let state = sessions.get(session.id)
    if (state === undefined) {
      state = { turnStartedAt: undefined, lastText: '', calls: new Map() }
      sessions.set(session.id, state)
    }
    return state
  }

  const sessionLabel = (session) => {
    let title
    try {
      title = ctx.get('sessionTitle')?.get(session)?.title
    } catch {
      title = undefined
    }
    return clip(title || `会话 ${String(session?.id ?? '').slice(0, 8)}`, 40)
  }

  const resolveKey = async () => {
    const credentials = ctx.get('credentials')
    const hit = credentials ? await credentials.resolve(config.credential) : undefined
    return hit?.value?.trim() || undefined
  }

  /** Send one Bark push; resolves { ok, error? } and never throws. */
  const push = async ({ title, body, level, url }) => {
    if (disposed) return { ok: false, error: 'plugin stopped' }
    const key = await resolveKey()
    if (key === undefined) {
      if (!warnedMissingKey) {
        warnedMissingKey = true
        logger.warn(`phone-approval: credential ${config.credential} is not set; notifications are skipped`)
      }
      return { ok: false, error: '还没有设置 Bark key' }
    }
    warnedMissingKey = false
    const target = url || config.openUrl
    const payload = {
      device_key: key,
      title,
      body: body || ' ',
      group: config.group,
      level,
      ...(target ? { url: target } : {}),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await fetch(`${config.server}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = clip(await response.text().catch(() => ''), 200)
        logger.warn(`phone-approval: push failed with HTTP ${response.status}`)
        return { ok: false, error: `Bark 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}` }
      }
      return { ok: true }
    } catch (error) {
      logger.warn(`phone-approval: push failed: ${String(error?.message ?? error)}`)
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  const send = (notification) => {
    // Fire and forget: session/event observers must stay synchronous and cheap.
    void push(notification).catch(() => {})
  }

  // ---- Phone approval -------------------------------------------------------

  const phone = new PhoneApproval({
    logger,
    getCredentials: () => ctx.get('credentials'),
    host: phoneConfig.host,
    port: phoneConfig.port,
    ttlSeconds: phoneConfig.ttlSeconds,
  })
  let tailscale = { installed: false, running: false, serveOk: false }

  const refreshTailscale = async () => {
    try {
      tailscale = await tailscaleStatus(phoneConfig.httpsPort, phoneConfig.port)
    } catch (error) {
      tailscale = { installed: false, running: false, serveOk: false, error: String(error?.message ?? error) }
    }
    if (disposed) return tailscale
    try {
      // An explicit URL wins; otherwise use the MagicDNS URL once `tailscale serve` maps it here.
      phone.setPublicUrl(phoneConfig.publicUrl || (tailscale.serveOk ? tailscale.url : undefined))
    } catch (error) {
      logger.warn(`phone-approval: ${String(error?.message ?? error)}`)
      phone.setPublicUrl(undefined)
    }
    return tailscale
  }

  const phoneActive = () => phoneConfig.enabled && config.events.approval && phone.available
  const phoneQuestionsActive = () => phoneConfig.enabled && phoneConfig.questions && config.events.question && phone.available
  // Question links whose tool call already returned "pending": answered later through userQuestions.answer().
  const continuedQuestions = new Map()

  if (phoneConfig.enabled) {
    ctx.effect(() => {
      phone.start()
      void refreshTailscale()
      const timer = setInterval(() => { void refreshTailscale() }, TAILSCALE_REFRESH_MS)
      timer.unref?.()
      return () => {
        clearInterval(timer)
        phone.stop()
      }
    })
  }

  const handleApproval = async (req, next) => {
    if (disposed || !phoneActive() || (await resolveKey()) === undefined) return next()
    const session = req.agent?.session
    const original = req.signal
    if (original?.aborted) return next()

    const call = session ? sessions.get(session.id)?.calls.get(req.callId) : undefined
    const isSubagent = session?.header?.origin === 'subagent'
    const label = session ? sessionLabel(session) : 'DSH'
    const link = phone.create({
      session: `${label}${isSubagent ? '（子 agent）' : ''}`,
      tool: req.toolName,
      reason: req.reason ?? '',
      command: describeCall(call),
    })

    // Give the desktop answerers a signal we can abort when the phone decides first.
    // The Remote gateway reads `request.signal` when it forwards the prompt and
    // withdraws the desktop panel once that signal aborts.
    const desktopAbort = new AbortController()
    try {
      req.signal = original ? AbortSignal.any([original, desktopAbort.signal]) : desktopAbort.signal
    } catch {
      if (!warnedSignalSwap) {
        warnedSignalSwap = true
        logger.warn('phone-approval: cannot attach a withdrawal signal; the desktop prompt may stay open after a phone decision')
      }
    }

    const reason = config.includeDetails ? clip(stripMarkdown(req.reason ?? ''), 160) : ''
    send({
      title: `🔐 需要审批${isSubagent ? '（子 agent）' : ''}：${label}`,
      body: [`工具：${req.toolName ?? '未知'}`, reason, '点开可在手机上审批'].filter(Boolean).join('\n'),
      level: 'timeSensitive',
      url: link.url,
    })

    const desktop = Promise.resolve().then(next)
    desktop.catch(() => {})

    const winner = await new Promise((resolve) => {
      let desktopUnavailable = false
      let phoneExpired = false
      desktop.then(
        (outcome) => {
          if (outcome === 'unavailable') {
            // No desktop answerer: keep waiting for the phone until its link expires.
            desktopUnavailable = true
            if (phoneExpired) resolve({ source: 'desktop', outcome })
            return
          }
          resolve({ source: 'desktop', outcome })
        },
        () => {
          desktopUnavailable = true
          if (phoneExpired) resolve({ source: 'desktop', outcome: 'unavailable' })
        },
      )
      link.result.then((outcome) => {
        if (outcome === 'expired') {
          phoneExpired = true
          if (desktopUnavailable) resolve({ source: 'desktop', outcome: 'unavailable' })
          return
        }
        resolve({ source: 'phone', outcome })
      })
      original?.addEventListener('abort', () => resolve({ source: 'abort', outcome: 'cancelled' }), { once: true })
    })

    if (winner.source === 'phone') {
      desktopAbort.abort(new Error('phone-approval: answered on the phone'))
      logger.info?.(`phone-approval: approval for ${req.toolName} answered on the phone: ${winner.outcome}`)
    } else {
      link.settle(winner.source === 'abort' ? 'cancelled' : 'elsewhere')
    }
    return winner.outcome
  }

  const isNoProvider = error => error?.code === 'NO_PROVIDER'

  const handleQuestion = async (req, next) => {
    const agent = req.agent
    if (disposed || !phoneQuestionsActive() || agent === undefined || !Array.isArray(req.questions)
      || (await resolveKey()) === undefined) return next()
    const original = req.signal
    if (original?.aborted) return next()

    const session = agent.session
    const label = sessionLabel(session)
    const questions = req.questions.map(q => ({
      id: q.id,
      question: String(q.question ?? ''),
      ...(q.header ? { header: String(q.header) } : {}),
      ...(q.detail ? { detail: String(q.detail) } : {}),
      options: (q.options ?? []).map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: q.multiSelect === true,
    }))
    const link = phone.create({ kind: 'question', session: label, questions }, { ttlMs: phoneConfig.questionTtlSeconds * 1000 })

    // Same withdrawal mechanism as approvals: the desktop question panel follows this signal.
    const desktopAbort = new AbortController()
    try {
      req.signal = original ? AbortSignal.any([original, desktopAbort.signal]) : desktopAbort.signal
    } catch {
      if (!warnedSignalSwap) {
        warnedSignalSwap = true
        logger.warn('phone-approval: cannot attach a withdrawal signal; the desktop question may stay open after a phone answer')
      }
    }

    const first = questions[0]
    const summary = config.includeDetails
      ? clip(stripMarkdown([first.header, first.question].filter(Boolean).join('：')), 160)
      : ''
    send({
      title: `❓ 等待你回答：${label}`,
      body: [summary, questions.length > 1 ? `共 ${questions.length} 个问题` : '', '点开可在手机上回答'].filter(Boolean).join('\n'),
      level: 'timeSensitive',
      url: link.url,
    })

    const desktop = Promise.resolve().then(next)
    desktop.catch(() => {})

    const winner = await new Promise((resolve) => {
      let desktopFailure
      let phoneExpired = false
      desktop.then(
        answer => resolve({ source: 'desktop', answer }),
        (error) => {
          // No connected desktop answerer: keep waiting for the phone.
          if (isNoProvider(error) && !phoneExpired) {
            desktopFailure = error
            return
          }
          resolve({ source: 'desktop-error', error })
        },
      )
      link.result.then((outcome) => {
        if (outcome === 'expired') {
          phoneExpired = true
          if (desktopFailure !== undefined) resolve({ source: 'desktop-error', error: desktopFailure })
          return
        }
        resolve({ source: 'phone', answer: outcome })
      })
      original?.addEventListener('abort', () => resolve({ source: 'abort', reason: original.reason }), { once: true })
    })

    switch (winner.source) {
      case 'phone':
        desktopAbort.abort(new Error('phone-approval: answered on the phone'))
        logger.info?.('phone-approval: question answered on the phone')
        return winner.answer
      case 'desktop':
        link.settle('elsewhere')
        return winner.answer
      case 'desktop-error':
        link.settle('cancelled')
        throw winner.error
      default: {
        const callId = req.wait?.callId
        if (winner.reason?.code === 'ASK_TIMED_OUT' && callId !== undefined && link.pending) {
          // The tool call returns "pending" and the question stays answerable; keep the phone link.
          link.setCommit(async ({ answers }) => {
            const service = ctx.get('userQuestions')
            if (!service) throw new Error('DSH 问答服务不可用')
            if (!service.answer(agent, callId, { answers })) {
              throw Object.assign(new Error('这个问题已经在电脑上回答了'), { settled: 'elsewhere' })
            }
          })
          continuedQuestions.set(callId, link)
          void link.result.then(() => continuedQuestions.delete(callId))
        } else {
          link.settle('cancelled')
        }
        throw winner.reason
      }
    }
  }

  if (phoneConfig.enabled) {
    // Prepend so these listeners wrap the desktop forwarders registered by the Remote bridge.
    ctx.on('approval/request', function (req, next) {
      return handleApproval(req, next)
    }, true)
    ctx.on('user-questions/request', function (req, next) {
      return handleQuestion(req, next)
    }, true)
  }

  // ---- Settings page admin API ---------------------------------------------

  const credentialsOrFail = () => {
    const credentials = ctx.get('credentials')
    if (!credentials) throw fail('DSH 凭据服务不可用', 503)
    return credentials
  }

  const routes = {
    'GET /status': async () => {
      const credentials = ctx.get('credentials')
      const bark = credentials ? await credentials.describe(config.credential) : { configured: false }
      await refreshTailscale()
      return {
        version: VERSION,
        bark: { configured: Boolean(bark.configured), masked: bark.masked, credential: config.credential },
        phone: {
          enabled: phoneConfig.enabled,
          listening: phone.ready,
          url: phone.base,
          autoUrl: !phoneConfig.publicUrl,
          httpsPort: phoneConfig.httpsPort,
          port: phoneConfig.port,
          active: phoneActive(),
          passkey: await phone.passkeyInfo(),
        },
        tailscale,
        config: {
          server: config.server,
          events: config.events,
          includeDetails: config.includeDetails,
          minTurnSeconds: config.minTurnSeconds,
          phoneApproval: {
            enabled: phoneConfig.enabled,
            questions: phoneConfig.questions,
            publicUrl: phoneConfig.publicUrl,
            ttlSeconds: phoneConfig.ttlSeconds,
          },
        },
        configWritable: Boolean(entry && ctx.get('configEditor')),
      }
    },
    'POST /bark-key': async (body) => {
      const credentials = credentialsOrFail()
      let key = typeof body.key === 'string' ? body.key.trim() : ''
      // Accept a pasted Bark URL such as https://api.day.app/<key>/...
      const fromUrl = /^https?:\/\/[^/]+\/([A-Za-z0-9]{8,})(?:\/|$)/.exec(key)
      if (fromUrl) key = fromUrl[1]
      if (key === '') {
        await credentials.unset(config.credential)
        return { ok: true, configured: false }
      }
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw fail('Bark key 格式不对：应为 App 首页链接中的那段字母数字')
      await credentials.set(config.credential, key)
      return { ok: true, configured: true }
    },
    'POST /test-push': async () => {
      const result = await push({
        title: '🔔 DSH 测试推送',
        body: phoneActive() ? '推送正常。手机审批已就绪，点开可打开审批页地址。' : '推送正常。',
        level: 'active',
        url: phone.base,
      })
      if (!result.ok) throw fail(result.error ?? '推送失败', 502)
      return { ok: true }
    },
    'POST /passkey/reset': async () => {
      await phone.resetPasskey()
      return { ok: true }
    },
    'POST /tailscale/serve': async () => {
      const result = await enableServe(phoneConfig.httpsPort, phoneConfig.port)
      if (!result.ok) throw fail(result.error, 502)
      await refreshTailscale()
      return { ok: true, tailscale }
    },
    'POST /config': async (body) => {
      const editor = ctx.get('configEditor')
      if (!entry || !editor) throw fail('当前配置不支持从页面保存，请编辑 cordis.patch.yml', 409)
      const patch = sanitizeConfigPatch(body.patch)
      // Saving restarts this plugin with the new configuration; the admin server
      // lets this request finish before it closes.
      await editor.edit(entry, current => mergeConfig(current, patch))
      return { ok: true }
    },
  }

  const admin = new AdminServer({
    logger,
    host: '127.0.0.1',
    port: phoneConfig.adminPort,
    token: ADMIN_TOKEN,
    routes,
  })
  ctx.effect(() => {
    admin.start()
    return () => admin.stop()
  })

  // Hand the admin endpoint to the owner's DSH page only.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table, peer) => {
      if (peer?.principal?.kind !== 'owner') return
      table.push({
        kind: 'global',
        name: ADMIN_GLOBAL,
        value: { url: `http://127.0.0.1:${phoneConfig.adminPort}`, token: ADMIN_TOKEN, version: VERSION },
      })
    })
  })

  // ---- Notifications --------------------------------------------------------

  ctx.effect(() => () => {
    disposed = true
    sessions.clear()
  })

  ctx.on('session/disposed', (session) => {
    sessions.delete(session.id)
  })

  ctx.on('session/event', (session, event) => {
    const isSubagent = session?.header?.origin === 'subagent'
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start': {
        stateOf(session).turnStartedAt = event.time
        stateOf(session).lastText = ''
        return
      }
      case 'user/message': {
        // A late reply to a continued question, sent from the desktop: close its phone link.
        const source = data.source
        if (source?.kind === 'user-question-reply') continuedQuestions.get(source.callId)?.settle('elsewhere')
        return
      }
      case 'assistant/message': {
        const text = assistantText(data.message)
        if (text.trim()) stateOf(session).lastText = text
        return
      }
      case 'approval/asked': {
        // With phone approval ready, the waterfall listener sends the push with a link.
        if (!config.events.approval || phoneActive()) return
        const reason = config.includeDetails ? clip(stripMarkdown(data.reason ?? ''), 160) : ''
        const who = isSubagent ? '（子 agent）' : ''
        send({
          title: `🔐 需要审批${who}：${sessionLabel(session)}`,
          body: [`工具：${data.toolName ?? '未知'}`, reason].filter(Boolean).join('\n'),
          level: 'timeSensitive',
        })
        return
      }
      case 'tool/call': {
        const calls = stateOf(session).calls
        calls.set(data.callId, { name: data.name, arguments: data.arguments })
        if (calls.size > MAX_TRACKED_CALLS) calls.delete(calls.keys().next().value)
        // With phone questions ready, the question listener sends the push with a link.
        if (!config.events.question || !QUESTION_TOOLS.has(data.name) || phoneQuestionsActive()) return
        const text = config.includeDetails ? clip(stripMarkdown(questionText(data.arguments)), 160) : ''
        send({
          title: `❓ 等待你回答：${sessionLabel(session)}`,
          body: text || 'agent 正在等待你的回答',
          level: 'timeSensitive',
        })
        return
      }
      case 'turn/end': {
        const state = stateOf(session)
        const reason = data.reason ?? {}
        const startedAt = state.turnStartedAt
        const lastText = state.lastText
        state.turnStartedAt = undefined
        state.lastText = ''
        state.calls.clear()
        // Subagent turns report back to their parent; only top-level sessions notify.
        if (isSubagent) return
        if (reason.kind === 'completed' || reason.kind === 'max-tokens') {
          if (!config.events.completed) return
          const seconds = startedAt === undefined ? Infinity : (event.time - startedAt) / 1000
          if (seconds < config.minTurnSeconds) return
          send({
            title: `✅ 已完成：${sessionLabel(session)}`,
            body: config.includeDetails ? clip(stripMarkdown(lastText), 180) : '',
            level: 'active',
          })
        } else if (reason.kind === 'error') {
          if (!config.events.error) return
          send({
            title: `⚠️ 出错：${sessionLabel(session)}`,
            body: config.includeDetails ? clip(errorText(reason), 180) : '',
            level: 'timeSensitive',
          })
        }
        return
      }
      default:
    }
  })
}

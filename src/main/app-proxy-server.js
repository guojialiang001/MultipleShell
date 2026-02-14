const http = require('http')
const https = require('https')

const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504]

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'host'
])

const toPositiveInt = (value, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const clampString = (value, maxLen) => {
  const s = String(value == null ? '' : value)
  if (!maxLen || s.length <= maxLen) return s
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`
}

const isBreakerFailureStatusCode = (statusCode) =>
  statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)

const normalizeHeaderValue = (value) => {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  return String(value)
}

const toLowerMap = (headers) => {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k || '').trim().toLowerCase()
    if (!key) continue
    out[key] = normalizeHeaderValue(v)
  }
  return out
}

const sanitizeRequestHeaders = (headers) => {
  const out = {}
  const lower = toLowerMap(headers)
  for (const [key, value] of Object.entries(lower)) {
    if (!value) continue
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    out[key] = value
  }
  return out
}

const sanitizeResponseHeaders = (headers) => {
  const out = {}
  const lower = toLowerMap(headers)
  for (const [key, value] of Object.entries(lower)) {
    if (!value) continue
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    out[key] = value
  }
  return out
}

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '')
const trimLeadingSlash = (value) => String(value || '').replace(/^\/+/, '')

const splitPathAndSearch = (forwardPath) => {
  const raw = String(forwardPath || '/')
  const idx = raw.indexOf('?')
  if (idx < 0) return { path: raw || '/', search: '' }
  return {
    path: raw.slice(0, idx) || '/',
    search: raw.slice(idx)
  }
}

const mergeTargetUrl = (baseUrl, forwardPath) => {
  const base = new URL(baseUrl)
  const { path, search } = splitPathAndSearch(forwardPath)

  const normalizedBasePath = `/${trimLeadingSlash(trimTrailingSlash(base.pathname || '/'))}`
  let normalizedForwardPath = `/${trimLeadingSlash(path || '/')}`
  if (normalizedForwardPath === '//') normalizedForwardPath = '/'

  // OpenAI-compatible providers often configure base_url ending with /v1.
  // Requests also come in as /v1/*, so drop one prefix to avoid /v1/v1/*.
  if (normalizedBasePath.endsWith('/v1') && normalizedForwardPath.startsWith('/v1/')) {
    normalizedForwardPath = normalizedForwardPath.slice(3)
  }

  const mergedPath =
    normalizedBasePath === '/'
      ? normalizedForwardPath
      : `${normalizedBasePath}${normalizedForwardPath === '/' ? '' : normalizedForwardPath}`

  const out = new URL(base.toString())
  out.pathname = mergedPath || '/'
  out.search = search || ''
  return out
}

const readRequestBody = (req, maxBytes = 10 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        const err = new Error(`Request body too large (${total} > ${maxBytes})`)
        err.code = 'MPS_PROXY_BODY_TOO_LARGE'
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)))
    req.on('error', reject)
    req.on('aborted', () => {
      const err = new Error('Client aborted request')
      err.code = 'MPS_PROXY_CLIENT_ABORTED'
      reject(err)
    })
  })

const createBreakerState = () => ({
  mode: 'closed',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  openedAt: null,
  halfOpenInFlight: 0,
  lastFailureAt: null,
  lastFailureReason: null
})

class AppProxyServer {
  constructor() {
    this.server = null
    this.origin = null
    this.listenHost = '127.0.0.1'
    this.listenPort = null
    this.startPromise = null
    this.sessions = new Map()
  }

  async ensureStarted() {
    if (this.server && this.origin) return this.origin
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          }
          const payload = { error: err?.message || String(err || 'unknown error') }
          try {
            res.end(JSON.stringify(payload))
          } catch (_) {
            try {
              res.end('{"error":"proxy internal error"}')
            } catch (_) {}
          }
        })
      })

      server.on('error', (err) => {
        reject(err)
      })

      server.listen(0, this.listenHost, () => {
        const addr = server.address()
        if (!addr || typeof addr !== 'object') {
          reject(new Error('Failed to resolve app proxy listen address'))
          return
        }
        this.server = server
        this.listenPort = addr.port
        this.origin = `http://${this.listenHost}:${this.listenPort}`
        resolve(this.origin)
      })
    })

    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  getOrigin() {
    return this.origin
  }

  upsertSession(sessionId, sessionInfo) {
    const id = String(sessionId || '').trim()
    if (!id) return false
    if (!sessionInfo || typeof sessionInfo !== 'object') return false

    const appKey = String(sessionInfo.appKey || '').trim()
    const orderedProviderIds = Array.isArray(sessionInfo.orderedProviderIds)
      ? sessionInfo.orderedProviderIds.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    const providerById = new Map()
    for (const raw of Array.isArray(sessionInfo.providers) ? sessionInfo.providers : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const providerId = String(raw.id || '').trim()
      const upstreamBaseUrl = String(raw.upstreamBaseUrl || '').trim()
      if (!providerId || !upstreamBaseUrl) continue
      providerById.set(providerId, {
        id: providerId,
        upstreamBaseUrl,
        upstreamHeaders: toLowerMap(raw.upstreamHeaders)
      })
    }

    if (providerById.size === 0 || orderedProviderIds.length === 0) return false

    const retry = sessionInfo.retry && typeof sessionInfo.retry === 'object' ? sessionInfo.retry : {}
    const maxAttempts = toPositiveInt(retry.maxAttempts, 2)
    const upstreamTimeoutMs = toPositiveInt(retry.upstreamTimeoutMs, 30000)
    const retryStatusCodes = Array.isArray(retry.retryStatusCodes)
      ? retry.retryStatusCodes.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.floor(x))
      : [...DEFAULT_RETRY_STATUS_CODES]

    const breakerRaw = sessionInfo.breaker && typeof sessionInfo.breaker === 'object' ? sessionInfo.breaker : {}
    const breakerEnabled = Boolean(sessionInfo.breakerEnabled)
    const breakerConfig = {
      failureThreshold: toPositiveInt(breakerRaw.failureThreshold, 3),
      openDurationMs: toPositiveInt(breakerRaw.openDurationMs, 60000),
      halfOpenMaxInFlight: toPositiveInt(breakerRaw.halfOpenMaxInFlight, 1),
      successToClose: toPositiveInt(breakerRaw.successToClose, 1)
    }

    const prev = this.sessions.get(id)
    const prevStates =
      prev && prev.breaker && prev.breaker.stateByProviderId instanceof Map ? prev.breaker.stateByProviderId : null
    const stateByProviderId = new Map()
    for (const providerId of providerById.keys()) {
      const prevState = prevStates ? prevStates.get(providerId) : null
      const next = prevState && typeof prevState === 'object' ? { ...prevState } : createBreakerState()
      // Keep shape stable in case older sessions stored fewer fields.
      if (!next.mode) next.mode = 'closed'
      if (next.openedAt == null) next.openedAt = null
      if (next.consecutiveFailures == null) next.consecutiveFailures = 0
      if (next.consecutiveSuccesses == null) next.consecutiveSuccesses = 0
      if (next.halfOpenInFlight == null) next.halfOpenInFlight = 0
      if (next.lastFailureAt == null) next.lastFailureAt = null
      if (next.lastFailureReason == null) next.lastFailureReason = null
      stateByProviderId.set(providerId, next)
    }

    this.sessions.set(id, {
      id,
      appKey,
      orderedProviderIds,
      providerById,
      failoverEnabled: Boolean(sessionInfo.failoverEnabled),
      breaker: {
        enabled: breakerEnabled,
        config: breakerConfig,
        stateByProviderId
      },
      retry: {
        maxAttempts,
        upstreamTimeoutMs,
        retryStatusCodes
      },
      createdAt: new Date().toISOString()
    })

    return true
  }

  removeSession(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return
    this.sessions.delete(id)
  }

  async close() {
    this.sessions.clear()
    const server = this.server
    this.server = null
    this.origin = null
    this.listenPort = null
    if (!server) return
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch (_) {
        resolve()
      }
    })
  }

  buildStatusPayload() {
    const sessions = []
    for (const session of this.sessions.values()) {
      const breaker = session.breaker && typeof session.breaker === 'object' ? session.breaker : null
      const breakerCfg = breaker && breaker.config && typeof breaker.config === 'object' ? breaker.config : {}
      const now = Date.now()

      sessions.push({
        sessionId: session.id,
        appKey: session.appKey,
        createdAt: session.createdAt,
        failoverEnabled: session.failoverEnabled,
        breakerEnabled: Boolean(breaker?.enabled),
        breakerConfig: {
          failureThreshold: toPositiveInt(breakerCfg.failureThreshold, 3),
          openDurationMs: toPositiveInt(breakerCfg.openDurationMs, 60000),
          halfOpenMaxInFlight: toPositiveInt(breakerCfg.halfOpenMaxInFlight, 1),
          successToClose: toPositiveInt(breakerCfg.successToClose, 1)
        },
        orderedProviderIds: [...session.orderedProviderIds],
        providers: session.orderedProviderIds
          .filter((id) => session.providerById.has(id))
          .map((id) => {
            const p = session.providerById.get(id)
            const st =
              breaker && breaker.stateByProviderId instanceof Map ? breaker.stateByProviderId.get(id) : null
            const openedAt = st && Number.isFinite(st.openedAt) ? st.openedAt : null
            const openRemainingMs =
              st && st.mode === 'open' && openedAt != null
                ? Math.max(0, toPositiveInt(breakerCfg.openDurationMs, 60000) - (now - openedAt))
                : 0
            return {
              id: p.id,
              upstreamBaseUrl: p.upstreamBaseUrl,
              headerKeys: Object.keys(p.upstreamHeaders || {}),
              breaker: st
                ? {
                    mode: st.mode,
                    consecutiveFailures: Number(st.consecutiveFailures || 0),
                    openedAt,
                    openRemainingMs,
                    halfOpenInFlight: Number(st.halfOpenInFlight || 0),
                    lastFailureAt: st.lastFailureAt == null ? null : Number(st.lastFailureAt),
                    lastFailureReason: st.lastFailureReason == null ? null : String(st.lastFailureReason)
                  }
                : null
            }
          })
      })
    }

    return {
      origin: this.origin,
      listenHost: this.listenHost,
      listenPort: this.listenPort,
      sessionCount: sessions.length,
      sessions
    }
  }

  async handleRequest(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    const urlObj = new URL(String(req.url || '/'), this.origin || 'http://127.0.0.1')
    const pathname = urlObj.pathname

    if (method === 'GET' && pathname === '/__status') {
      const payload = this.buildStatusPayload()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload, null, 2))
      return
    }

    const routeMatch = pathname.match(/^\/s\/([^/]+)(\/.*)?$/)
    if (!routeMatch) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const sessionId = String(routeMatch[1] || '').trim()
    const forwardPath = `${routeMatch[2] || '/'}${urlObj.search || ''}`
    const session = this.sessions.get(sessionId)
    if (!session) {
      res.writeHead(410, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Proxy session not found or expired' }))
      return
    }

    const requestBody = await readRequestBody(req)
    await this.forwardWithFailover(req, res, session, method, forwardPath, requestBody)
  }

  getOrInitBreakerState(session, providerId) {
    const breaker = session && session.breaker && typeof session.breaker === 'object' ? session.breaker : null
    if (!breaker || !(breaker.stateByProviderId instanceof Map)) return null
    const id = String(providerId || '').trim()
    if (!id) return null
    if (breaker.stateByProviderId.has(id)) return breaker.stateByProviderId.get(id)
    const next = createBreakerState()
    breaker.stateByProviderId.set(id, next)
    return next
  }

  breakerAllow(session, providerId) {
    const breaker = session && session.breaker && typeof session.breaker === 'object' ? session.breaker : null
    if (!breaker || !breaker.enabled) return true
    const st = this.getOrInitBreakerState(session, providerId)
    if (!st) return true

    const cfg = breaker.config && typeof breaker.config === 'object' ? breaker.config : {}
    const now = Date.now()

    if (st.mode === 'open') {
      const openedAt = Number.isFinite(st.openedAt) ? st.openedAt : null
      const openMs = toPositiveInt(cfg.openDurationMs, 60000)
      if (openedAt != null && now - openedAt >= openMs) {
        st.mode = 'half_open'
        st.consecutiveSuccesses = 0
        st.halfOpenInFlight = 0
      } else {
        return false
      }
    }

    if (st.mode === 'half_open') {
      const limit = toPositiveInt(cfg.halfOpenMaxInFlight, 1)
      if (Number(st.halfOpenInFlight || 0) >= limit) return false
      st.halfOpenInFlight = Number(st.halfOpenInFlight || 0) + 1
      return true
    }

    return true
  }

  breakerOnSuccess(session, providerId) {
    const breaker = session && session.breaker && typeof session.breaker === 'object' ? session.breaker : null
    if (!breaker || !breaker.enabled) return
    const st = this.getOrInitBreakerState(session, providerId)
    if (!st) return

    const cfg = breaker.config && typeof breaker.config === 'object' ? breaker.config : {}
    const successToClose = toPositiveInt(cfg.successToClose, 1)

    if (st.mode === 'half_open') {
      st.halfOpenInFlight = Math.max(0, Number(st.halfOpenInFlight || 0) - 1)
      st.consecutiveSuccesses = Number(st.consecutiveSuccesses || 0) + 1
      st.consecutiveFailures = 0
      if (st.consecutiveSuccesses >= successToClose) {
        st.mode = 'closed'
        st.openedAt = null
        st.consecutiveSuccesses = 0
        st.consecutiveFailures = 0
        st.halfOpenInFlight = 0
      }
      return
    }

    st.mode = 'closed'
    st.openedAt = null
    st.consecutiveFailures = 0
    st.consecutiveSuccesses = 0
    st.halfOpenInFlight = 0
  }

  breakerOnFailure(session, providerId, reason) {
    const breaker = session && session.breaker && typeof session.breaker === 'object' ? session.breaker : null
    if (!breaker || !breaker.enabled) return
    const st = this.getOrInitBreakerState(session, providerId)
    if (!st) return

    const cfg = breaker.config && typeof breaker.config === 'object' ? breaker.config : {}
    const failureThreshold = toPositiveInt(cfg.failureThreshold, 3)
    const now = Date.now()

    st.lastFailureAt = now
    st.lastFailureReason = clampString(reason?.message || reason?.reason || reason?.error || reason, 220)

    if (st.mode === 'half_open') {
      st.halfOpenInFlight = Math.max(0, Number(st.halfOpenInFlight || 0) - 1)
      st.mode = 'open'
      st.openedAt = now
      st.consecutiveSuccesses = 0
      st.consecutiveFailures = Math.max(Number(st.consecutiveFailures || 0), failureThreshold)
      return
    }

    if (st.mode === 'open') return

    st.consecutiveFailures = Number(st.consecutiveFailures || 0) + 1
    st.consecutiveSuccesses = 0
    if (st.consecutiveFailures >= failureThreshold) {
      st.mode = 'open'
      st.openedAt = now
    }
  }

  breakerOnNeutralEnd(session, providerId) {
    const breaker = session && session.breaker && typeof session.breaker === 'object' ? session.breaker : null
    if (!breaker || !breaker.enabled) return
    const st = this.getOrInitBreakerState(session, providerId)
    if (!st) return
    if (st.mode === 'half_open') {
      st.halfOpenInFlight = Math.max(0, Number(st.halfOpenInFlight || 0) - 1)
    }
  }

  async forwardWithFailover(req, res, session, method, forwardPath, requestBody) {
    const ordered = Array.isArray(session.orderedProviderIds) ? session.orderedProviderIds : []
    const providers = ordered.map((id) => session.providerById.get(id)).filter(Boolean)
    if (providers.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'No upstream providers configured' }))
      return
    }

    const retryCodes = new Set(session.retry.retryStatusCodes || [])
    const failoverEnabled = Boolean(session.failoverEnabled)
    const maxAttempts = Math.max(1, Math.min(providers.length, failoverEnabled ? Number(session.retry.maxAttempts || 2) : 1))
    const timeoutMs = Math.max(1000, Number(session.retry.upstreamTimeoutMs || 30000))

    let failoverFrom = null
    let lastError = null

    const tried = new Set()
    let upstreamRequests = 0

    const pickNextProvider = () => {
      for (const p of providers) {
        if (!p || !p.id) continue
        if (tried.has(p.id)) continue

        if (!failoverEnabled && tried.size > 0) return null

        if (session.breaker?.enabled) {
          const allowed = this.breakerAllow(session, p.id)
          if (!allowed) {
            tried.add(p.id)
            if (!failoverEnabled) {
              lastError = new Error('Circuit breaker open')
              break
            }
            if (!failoverFrom) failoverFrom = p.id
            continue
          }
        }

        return p
      }
      return null
    }

    while (upstreamRequests < maxAttempts) {
      const provider = pickNextProvider()
      if (!provider) break
      tried.add(provider.id)
      upstreamRequests += 1

      let hasWrittenToClient = false
      let breakerShouldFailByStatus = false
      let statusCode = 0

      try {
        const { upstreamReq, upstreamRes } = await this.sendToUpstream({
          provider,
          reqHeaders: req.headers,
          method,
          forwardPath,
          requestBody,
          timeoutMs
        })

        statusCode = Number(upstreamRes.statusCode || 502)
        breakerShouldFailByStatus = isBreakerFailureStatusCode(statusCode)

        const canRetryByStatus =
          failoverEnabled &&
          upstreamRequests < maxAttempts &&
          retryCodes.has(statusCode)

        if (canRetryByStatus) {
          if (breakerShouldFailByStatus) this.breakerOnFailure(session, provider.id, { reason: `HTTP ${statusCode}` })
          failoverFrom = failoverFrom || provider.id
          upstreamRes.resume()
          continue
        }

        const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers)
        responseHeaders['x-mps-provider'] = provider.id
        responseHeaders['x-mps-failover'] = failoverFrom ? '1' : '0'
        if (failoverFrom) responseHeaders['x-mps-failover-from'] = failoverFrom

        res.writeHead(statusCode, responseHeaders)
        hasWrittenToClient = true

        const outcome = await new Promise((resolve, reject) => {
          let settled = false
          const done = (fn) => (arg) => {
            if (settled) return
            settled = true
            fn(arg)
          }

          const onResolve = done((value) => resolve(value))
          const onReject = done((err) => reject(err))

          upstreamRes.on('end', () => onResolve({ kind: 'end' }))
          upstreamRes.on('error', onReject)
          upstreamReq.on('error', onReject)
          res.on('close', () => {
            if (!upstreamReq.destroyed) upstreamReq.destroy()
            onResolve({ kind: 'client_close' })
          })
          upstreamRes.pipe(res)
        })

        if (outcome && outcome.kind === 'end') {
          if (breakerShouldFailByStatus) {
            this.breakerOnFailure(session, provider.id, { reason: `HTTP ${statusCode}` })
          } else {
            this.breakerOnSuccess(session, provider.id)
          }
        } else if (outcome && outcome.kind === 'client_close') {
          this.breakerOnNeutralEnd(session, provider.id)
        }

        return
      } catch (err) {
        lastError = err
        this.breakerOnFailure(session, provider.id, err)
        if (hasWrittenToClient || res.headersSent || res.writableEnded) {
          if (!res.writableEnded) {
            try {
              res.destroy(err)
            } catch (_) {}
          }
          return
        }
        if (!failoverEnabled || upstreamRequests >= maxAttempts) break
        failoverFrom = failoverFrom || provider.id
      }
    }

    const message = lastError?.message || 'All upstream providers failed'
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: message }))
  }

  sendToUpstream({ provider, reqHeaders, method, forwardPath, requestBody, timeoutMs }) {
    const target = mergeTargetUrl(provider.upstreamBaseUrl, forwardPath || '/')
    const transport = target.protocol === 'https:' ? https : http

    const headers = sanitizeRequestHeaders(reqHeaders)
    if (provider.upstreamHeaders && typeof provider.upstreamHeaders === 'object') {
      for (const [k, v] of Object.entries(provider.upstreamHeaders)) {
        const key = String(k || '').trim().toLowerCase()
        if (!key) continue
        headers[key] = normalizeHeaderValue(v)
      }
    }

    if (method === 'GET' || method === 'HEAD') {
      delete headers['content-length']
    } else {
      headers['content-length'] = String(requestBody.length)
    }

    return new Promise((resolve, reject) => {
      const upstreamReq = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method,
          path: `${target.pathname}${target.search}`,
          headers
        },
        (upstreamRes) => {
          resolve({ upstreamReq, upstreamRes })
        }
      )

      upstreamReq.on('error', reject)
      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq.destroy(new Error(`Upstream timeout after ${timeoutMs}ms`))
      })

      if (method !== 'GET' && method !== 'HEAD' && requestBody.length > 0) {
        upstreamReq.write(requestBody)
      }
      upstreamReq.end()
    })
  }
}

module.exports = AppProxyServer

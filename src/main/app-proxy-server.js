const http = require('http')
const https = require('https')

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
    const maxAttemptsRaw = Number(retry.maxAttempts)
    const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.floor(maxAttemptsRaw) : 2
    const timeoutRaw = Number(retry.upstreamTimeoutMs)
    const upstreamTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 30000
    const retryStatusCodes = Array.isArray(retry.retryStatusCodes)
      ? retry.retryStatusCodes.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.floor(x))
      : [408, 429, 500, 502, 503, 504]

    this.sessions.set(id, {
      id,
      appKey,
      orderedProviderIds,
      providerById,
      failoverEnabled: Boolean(sessionInfo.failoverEnabled),
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
      sessions.push({
        sessionId: session.id,
        appKey: session.appKey,
        createdAt: session.createdAt,
        failoverEnabled: session.failoverEnabled,
        orderedProviderIds: [...session.orderedProviderIds],
        providers: session.orderedProviderIds
          .filter((id) => session.providerById.has(id))
          .map((id) => {
            const p = session.providerById.get(id)
            return {
              id: p.id,
              upstreamBaseUrl: p.upstreamBaseUrl,
              headerKeys: Object.keys(p.upstreamHeaders || {})
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

  async forwardWithFailover(req, res, session, method, forwardPath, requestBody) {
    const ordered = Array.isArray(session.orderedProviderIds) ? session.orderedProviderIds : []
    const providers = ordered.map((id) => session.providerById.get(id)).filter(Boolean)
    if (providers.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'No upstream providers configured' }))
      return
    }

    const retryCodes = new Set(session.retry.retryStatusCodes || [])
    const maxAttempts = Math.max(
      1,
      Math.min(
        providers.length,
        session.failoverEnabled ? Number(session.retry.maxAttempts || 2) : 1
      )
    )
    const timeoutMs = Math.max(1000, Number(session.retry.upstreamTimeoutMs || 30000))

    let failoverFrom = null
    let lastError = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const provider = providers[attempt]
      if (!provider) continue
      let hasWrittenToClient = false

      try {
        const { upstreamReq, upstreamRes } = await this.sendToUpstream({
          provider,
          reqHeaders: req.headers,
          method,
          forwardPath,
          requestBody,
          timeoutMs
        })

        const statusCode = Number(upstreamRes.statusCode || 502)
        const canRetryByStatus =
          session.failoverEnabled &&
          attempt + 1 < maxAttempts &&
          retryCodes.has(statusCode)

        if (canRetryByStatus) {
          failoverFrom = provider.id
          upstreamRes.resume()
          continue
        }

        const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers)
        responseHeaders['x-mps-provider'] = provider.id
        responseHeaders['x-mps-failover'] = attempt > 0 ? '1' : '0'
        if (attempt > 0 && failoverFrom) responseHeaders['x-mps-failover-from'] = failoverFrom

        res.writeHead(statusCode, responseHeaders)
        hasWrittenToClient = true

        await new Promise((resolve, reject) => {
          let settled = false
          const done = (fn) => (arg) => {
            if (settled) return
            settled = true
            fn(arg)
          }

          const onResolve = done(() => resolve())
          const onReject = done((err) => reject(err))

          upstreamRes.on('end', onResolve)
          upstreamRes.on('error', onReject)
          upstreamReq.on('error', onReject)
          res.on('close', () => {
            if (!upstreamReq.destroyed) upstreamReq.destroy()
            onResolve()
          })
          upstreamRes.pipe(res)
        })

        return
      } catch (err) {
        lastError = err
        if (hasWrittenToClient || res.headersSent || res.writableEnded) {
          if (!res.writableEnded) {
            try {
              res.destroy(err)
            } catch (_) {}
          }
          return
        }
        if (!session.failoverEnabled || attempt + 1 >= maxAttempts) break
        failoverFrom = provider.id
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

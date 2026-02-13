const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504]

const VALID_PROXY_IMPLEMENTATIONS = new Set(['off', 'app', 'ccswitch'])
const VALID_QUEUE_MODES = new Set(['failover-queue', 'all-providers', 'custom'])

const normalizeId = (value) => String(value || '').trim()

const normalizeProxyHost = (host) => {
  const raw = String(host || '').trim()
  if (!raw) return '127.0.0.1'
  const lower = raw.toLowerCase()
  if (lower === '0.0.0.0' || lower === '::' || lower === '[::]') return '127.0.0.1'
  return raw
}

const buildProxyOrigin = (host, port) => {
  const safeHost = normalizeProxyHost(host)
  const p = Number(port)
  const safePort = Number.isFinite(p) && p > 0 ? Math.floor(p) : 15721
  const hostPart = safeHost.includes(':') && !safeHost.startsWith('[') ? `[${safeHost}]` : safeHost
  return `http://${hostPart}:${safePort}`
}

const joinUrl = (origin, pathname) =>
  `${String(origin || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`

const asStringArray = (value) => {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const id = normalizeId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const toFiniteNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const toPositiveInt = (value, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const normalizeProviders = (providers) => {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(providers) ? providers : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = normalizeId(raw.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      inFailoverQueue: Boolean(raw.inFailoverQueue),
      isCurrent: Boolean(raw.isCurrent),
      sortIndex: raw.sortIndex == null ? null : toFiniteNumber(raw.sortIndex, null),
      raw
    })
  }
  return out
}

const sortByFailoverPriority = (a, b) => {
  const aKey = Number.isFinite(a.sortIndex) ? a.sortIndex : 999999
  const bKey = Number.isFinite(b.sortIndex) ? b.sortIndex : 999999
  if (aKey !== bKey) return aKey - bKey
  return a.id.localeCompare(b.id)
}

const pickPrimaryProviderId = (providers, requestedProviderId, currentProviderId) => {
  if (!Array.isArray(providers) || providers.length === 0) return null
  const ids = new Set(providers.map((p) => p.id))
  const requested = normalizeId(requestedProviderId)
  const current = normalizeId(currentProviderId)
  if (requested && ids.has(requested)) return requested
  if (current && ids.has(current)) return current
  const markedCurrent = providers.find((p) => p.isCurrent)
  if (markedCurrent) return markedCurrent.id
  return providers[0].id
}

const applyAllowDeny = (ids, allow, deny) => {
  let out = Array.isArray(ids) ? [...ids] : []
  const allowSet = new Set(asStringArray(allow))
  const denySet = new Set(asStringArray(deny))

  if (allowSet.size > 0) {
    out = out.filter((id) => allowSet.has(id))
  }
  if (denySet.size > 0) {
    out = out.filter((id) => !denySet.has(id))
  }
  return out
}

function buildQueueFromCCSwitchProviders(
  providers,
  requestedProviderId,
  currentProviderId,
  queueMode = 'failover-queue',
  allow,
  deny
) {
  const normalizedProviders = normalizeProviders(providers)
  if (normalizedProviders.length === 0) {
    return {
      primaryProviderId: null,
      orderedProviderIds: []
    }
  }

  const effectiveQueueMode = VALID_QUEUE_MODES.has(queueMode) ? queueMode : 'failover-queue'
  const primaryProviderId = pickPrimaryProviderId(normalizedProviders, requestedProviderId, currentProviderId)
  if (!primaryProviderId) {
    return {
      primaryProviderId: null,
      orderedProviderIds: []
    }
  }

  const failoverCandidates = normalizedProviders
    .filter((p) => p.inFailoverQueue && p.id !== primaryProviderId)
    .sort(sortByFailoverPriority)
    .map((p) => p.id)

  const allCandidates = normalizedProviders
    .filter((p) => p.id !== primaryProviderId)
    .sort(sortByFailoverPriority)
    .map((p) => p.id)

  let orderedProviderIds = []
  if (effectiveQueueMode === 'all-providers') {
    orderedProviderIds = [primaryProviderId, ...allCandidates]
  } else {
    orderedProviderIds = [primaryProviderId, ...failoverCandidates]
  }

  if (effectiveQueueMode === 'custom') {
    orderedProviderIds = applyAllowDeny(orderedProviderIds, allow, deny)
    if (orderedProviderIds.length > 0 && orderedProviderIds[0] !== primaryProviderId) {
      orderedProviderIds = [orderedProviderIds[0], ...orderedProviderIds.filter((id) => id !== orderedProviderIds[0])]
    }
  }

  const deduped = []
  const seen = new Set()
  for (const id of orderedProviderIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    deduped.push(id)
  }

  return {
    primaryProviderId: deduped[0] || null,
    orderedProviderIds: deduped
  }
}

const resolveAppKeyFromType = (type) => {
  const t = String(type || '').trim().toLowerCase()
  if (t === 'claude-code') return 'claude'
  if (t === 'codex') return 'codex'
  if (t === 'opencode') return 'opencode'
  return ''
}

const resolveProxyAppKey = (appKey) => (appKey === 'opencode' ? 'codex' : appKey)

const resolveBooleanOrNull = (value, hasKey) => {
  if (!hasKey) return null
  return Boolean(value)
}

const normalizeProxyImplementation = (template) => {
  const raw = String(template?.proxyImplementation || '').trim().toLowerCase()
  if (VALID_PROXY_IMPLEMENTATIONS.has(raw)) return raw
  return Boolean(template?.useCCSwitchProxy) ? 'ccswitch' : 'app'
}

const normalizeQueueMode = (template) => {
  const raw = String(template?.proxyQueueMode || '').trim().toLowerCase()
  if (VALID_QUEUE_MODES.has(raw)) return raw
  return 'failover-queue'
}

const normalizeRetryStatusCodes = (retryConfig) => {
  const arr = Array.isArray(retryConfig?.retryStatusCodes)
    ? retryConfig.retryStatusCodes
    : DEFAULT_RETRY_STATUS_CODES
  const out = []
  const seen = new Set()
  for (const value of arr) {
    const code = toPositiveInt(value, 0)
    if (code <= 0 || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out.length > 0 ? out : [...DEFAULT_RETRY_STATUS_CODES]
}

function mergeEffectiveProxyPolicy({ template, snapshot, appKey, appProxyOrigin = null }) {
  const baseTemplate = template && typeof template === 'object' ? template : {}
  const resolvedAppKey = normalizeId(appKey) || resolveAppKeyFromType(baseTemplate.type)
  const proxyAppKey = resolveProxyAppKey(resolvedAppKey)
  const providers = Array.isArray(snapshot?.apps?.[resolvedAppKey]?.providers)
    ? snapshot.apps[resolvedAppKey].providers
    : []

  const requestedProviderId = normalizeId(baseTemplate.ccSwitchProviderId)
  const currentProviderId = normalizeId(snapshot?.apps?.[resolvedAppKey]?.currentId)
  const queueMode = normalizeQueueMode(baseTemplate)
  const queueResult = buildQueueFromCCSwitchProviders(
    providers,
    requestedProviderId,
    currentProviderId,
    queueMode,
    baseTemplate.proxyAllowProviderIds,
    baseTemplate.proxyDenyProviderIds
  )

  const proxyCfg = proxyAppKey ? snapshot?.proxy?.[proxyAppKey] : null
  const hasProxyEnabled = proxyCfg && Object.prototype.hasOwnProperty.call(proxyCfg, 'proxyEnabled')
  const hasEnabled = proxyCfg && Object.prototype.hasOwnProperty.call(proxyCfg, 'enabled')
  const hasAutoFailoverEnabled = proxyCfg && Object.prototype.hasOwnProperty.call(proxyCfg, 'autoFailoverEnabled')

  const serverEnabled = resolveBooleanOrNull(proxyCfg?.proxyEnabled, hasProxyEnabled)
  const appEnabled = hasEnabled
    ? Boolean(proxyCfg.enabled)
    : hasProxyEnabled
      ? Boolean(proxyCfg.proxyEnabled)
      : null
  const autoFailoverEnabled = resolveBooleanOrNull(proxyCfg?.autoFailoverEnabled, hasAutoFailoverEnabled)

  const listenOrigin = proxyCfg ? buildProxyOrigin(proxyCfg.listenAddress, proxyCfg.listenPort) : null
  const openAIBase = listenOrigin ? joinUrl(listenOrigin, '/v1') : null

  const proxyEnabled = baseTemplate.proxyEnabled == null
    ? Boolean(baseTemplate.useCCSwitchProxy)
    : Boolean(baseTemplate.proxyEnabled)
  const proxyImplementation = normalizeProxyImplementation(baseTemplate)
  const respectCCSwitchProxyConfig = baseTemplate.respectCCSwitchProxyConfig !== false

  const proxyAllowedByCC = appEnabled == null ? true : appEnabled === true
  const failoverAllowedByCC = autoFailoverEnabled == null ? true : autoFailoverEnabled === true
  const effectiveProxyEnabled = proxyEnabled && (respectCCSwitchProxyConfig ? proxyAllowedByCC : true)

  const appFailoverEnabled =
    baseTemplate.appFailoverEnabled == null
      ? (respectCCSwitchProxyConfig ? failoverAllowedByCC : true)
      : Boolean(baseTemplate.appFailoverEnabled)

  const appBreakerEnabled =
    baseTemplate.appBreakerEnabled == null
      ? true
      : Boolean(baseTemplate.appBreakerEnabled)

  const ccProxyOk = serverEnabled === true && appEnabled === true && Boolean(listenOrigin)
  const ccFailoverOk = ccProxyOk && autoFailoverEnabled === true
  const appProxyOk = queueResult.orderedProviderIds.length > 0 && Boolean(appProxyOrigin)

  let routeMode = 'direct'
  let circuitBreakerMode = 'off'

  if (effectiveProxyEnabled && proxyImplementation !== 'off') {
    if (proxyImplementation === 'ccswitch' && ccProxyOk) {
      routeMode = 'ccswitch-proxy'
      circuitBreakerMode = ccFailoverOk ? 'ccswitch' : 'off'
    } else if (proxyImplementation === 'app' && appProxyOk) {
      routeMode = 'app-proxy'
      circuitBreakerMode = appFailoverEnabled || appBreakerEnabled ? 'app' : 'off'
    }
  }

  const breakerCfg = baseTemplate.breakerConfig && typeof baseTemplate.breakerConfig === 'object'
    ? baseTemplate.breakerConfig
    : {}
  const retryCfg = baseTemplate.retryConfig && typeof baseTemplate.retryConfig === 'object'
    ? baseTemplate.retryConfig
    : {}

  return {
    appKey: resolvedAppKey,
    source: 'ccswitch',
    wantUseCCSwitch: Boolean(baseTemplate.useCCSwitch) || proxyEnabled,
    wantUseProxy: proxyEnabled,
    proxyImplementation,
    respectCCSwitchProxyConfig,
    requestedProviderId: requestedProviderId || null,
    ccProxy: {
      listenOrigin,
      openAIBase,
      serverEnabled,
      appEnabled,
      autoFailoverEnabled
    },
    queue: {
      source: 'ccswitch',
      mode: queueMode,
      primaryProviderId: queueResult.primaryProviderId,
      orderedProviderIds: queueResult.orderedProviderIds
    },
    appProxy: {
      enabled: routeMode === 'app-proxy',
      origin: appProxyOrigin || null,
      openAIBase: appProxyOrigin ? joinUrl(appProxyOrigin, '/v1') : null
    },
    appFailover: {
      enabled: appFailoverEnabled,
      maxAttempts: toPositiveInt(retryCfg.maxAttempts, 2),
      commitDelayMs: Math.max(0, toFiniteNumber(retryCfg.commitDelayMs, 0)),
      commitBytes: Math.max(0, toFiniteNumber(retryCfg.commitBytes, 0)),
      retryStatusCodes: normalizeRetryStatusCodes(retryCfg),
      upstreamTimeoutMs: Math.max(1000, toPositiveInt(retryCfg.upstreamTimeoutMs, 30000))
    },
    appBreaker: {
      enabled: appBreakerEnabled,
      failureThreshold: Math.max(1, toPositiveInt(breakerCfg.failureThreshold, 3)),
      openDurationMs: Math.max(1000, toPositiveInt(breakerCfg.openDurationMs, 60000)),
      halfOpenMaxInFlight: Math.max(1, toPositiveInt(breakerCfg.halfOpenMaxInFlight, 1)),
      successToClose: Math.max(1, toPositiveInt(breakerCfg.successToClose, 1))
    },
    routeMode,
    circuitBreakerMode
  }
}

module.exports = {
  buildProxyOrigin,
  joinUrl,
  resolveAppKeyFromType,
  resolveProxyAppKey,
  buildQueueFromCCSwitchProviders,
  mergeEffectiveProxyPolicy
}

const pty = require('node-pty')
const { v4: uuidv4 } = require('uuid')
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const shellMonitor = require('./shell-monitor')
const ccSwitch = require('./ccswitch')
const AppProxyServer = require('./app-proxy-server')
const { mergeEffectiveProxyPolicy, resolveAppKeyFromType } = require('./ccswitch-policy')

// Upstream OpenCode reads `.opencode.json` from `$XDG_CONFIG_HOME/opencode/.opencode.json` (and other default paths).
// Keep this template minimal; MultipleShell injects a per-template `data.directory` when materializing.
const OPENCODE_CONFIG_TEMPLATE = '{\n  \n}\n'
const OPENCODE_PERMISSION_TEMPLATE = { edit: 'ask', bash: 'ask', webfetch: 'allow' }
const PROMPT_MARKER = '__MPS_PROMPT__'

const sleepSync = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n)
  } catch (_) {
    // ignore
  }
}

const clonePlain = (value) => {
  try {
    return structuredClone(value)
  } catch (_) {
    return JSON.parse(JSON.stringify(value))
  }
}

const isImportedFromCCSwitch = (cfg) => {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
  if (cfg.importSource === 'ccswitch') return true

  // Back-compat: stable prefix + provider id indicates an imported CC Switch template.
  const id = typeof cfg.id === 'string' ? cfg.id : ''
  const providerId = typeof cfg.ccSwitchProviderId === 'string' ? cfg.ccSwitchProviderId.trim() : ''
  if (id.startsWith('ccswitch-') && providerId) return true

  // Extra heuristic: some older exports may keep the "CC Switch - ..." name.
  const name = typeof cfg.name === 'string' ? cfg.name : ''
  if (name.startsWith('CC Switch - ') && providerId) return true

  return false
}

const parseJsonObject = (raw) => {
  try {
    if (raw == null) return null
    const text = String(raw || '').trim()
    if (!text) return null
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch (_) {
    return null
  }
}

const ensureObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return {}
}

const deleteKeyDeep = (value, key) => {
  const targetKey = String(key || '')
  if (!targetKey) return

  const stack = [value]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue

    if (Array.isArray(cur)) {
      for (const item of cur) {
        if (item && typeof item === 'object') stack.push(item)
      }
      continue
    }

    for (const [k, v] of Object.entries(cur)) {
      if (k === targetKey) {
        try {
          delete cur[k]
        } catch (_) {}
        continue
      }
      if (v && typeof v === 'object') stack.push(v)
    }
  }
}

const mergeObjectsWithEnv = (base, extra) => {
  const a = ensureObject(base)
  const b = ensureObject(extra)
  const out = { ...a, ...b }
  const envA = ensureObject(a.env)
  const envB = ensureObject(b.env)
  if (Object.keys(envA).length > 0 || Object.keys(envB).length > 0) {
    out.env = { ...envA, ...envB }
  }
  return out
}

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
  const safePort = Number.isFinite(p) && p > 0 ? p : 15721
  const hostPart = safeHost.includes(':') && !safeHost.startsWith('[') ? `[${safeHost}]` : safeHost
  return `http://${hostPart}:${safePort}`
}

const joinUrl = (origin, pathname) =>
  `${String(origin || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`

const rewriteTomlBaseUrl = (toml, baseUrl) => {
  const raw = String(toml || '')
  if (!raw.trim()) return { text: raw, replaced: false }

  let replaced = false
  const next = raw.replace(/(^\s*base_url\s*=\s*)"[^"]*"/gmi, (_m, p1) => {
    replaced = true
    return `${p1}"${String(baseUrl || '').replace(/"/g, '\\"')}"`
  })

  return { text: next, replaced }
}

const makeCodexProxyToml = (baseUrl) => {
  const safe = String(baseUrl || '')
  return (
    'model_provider = "ccswitch"\n' +
    'model = "gpt-4o"\n' +
    'disable_response_storage = true\n' +
    '\n' +
    '[model_providers.ccswitch]\n' +
    'name = "CC Switch Proxy"\n' +
    `base_url = "${safe.replace(/"/g, '\\"')}"\n` +
    'wire_api = "responses"\n' +
    'requires_openai_auth = true\n'
  )
}

const firstNonEmptyString = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

const parseTomlScalar = (toml, key) => {
  const raw = String(toml || '')
  if (!raw) return ''
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"]+)"\\s*$`, 'gmi')
  const m = re.exec(raw)
  return m ? String(m[1] || '').trim() : ''
}

const parseTomlEnvHeaderMappings = (toml) => {
  const out = []
  const raw = String(toml || '')
  if (!raw) return out

  for (const m of raw.matchAll(/env_http_headers\s*=\s*\{([^}]*)\}/gmi)) {
    const body = m[1] || ''
    for (const kv of body.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) {
      const headerName = String(kv[1] || '').trim()
      const envName = String(kv[2] || '').trim()
      if (!headerName || !envName) continue
      out.push({ headerName, envName })
    }
  }
  return out
}

const resolveEnvValue = (auth, envName) => {
  const name = String(envName || '').trim()
  if (!name) return ''
  if (auth && typeof auth === 'object' && !Array.isArray(auth) && typeof auth[name] === 'string') {
    const v = auth[name].trim()
    if (v) return v
  }
  const fromEnv = String(process.env[name] || '').trim()
  return fromEnv || ''
}

const addHeader = (headers, name, value) => {
  const key = String(name || '').trim().toLowerCase()
  const val = String(value || '').trim()
  if (!key || !val) return
  headers[key] = val
}

const normalizeUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.toString().replace(/\/+$/, '')
  } catch (_) {
    return ''
  }
}

const extractOpenAIUpstream = (provider) => {
  if (!provider || typeof provider !== 'object') return null

  const settings = ensureObject(provider.settingsConfig)
  const auth = ensureObject(settings.auth)
  const toml = typeof settings.config === 'string' ? settings.config : ''

  const baseUrl = firstNonEmptyString(
    parseTomlScalar(toml, 'base_url'),
    settings.base_url,
    settings.baseUrl,
    settings.baseURL,
    provider?.endpoints?.[0]?.baseUrl,
    provider?.endpoints?.[0]?.base_url,
    provider?.endpoints?.[0]?.url
  )
  const upstreamBaseUrl = normalizeUrl(baseUrl)
  if (!upstreamBaseUrl) return null

  const upstreamHeaders = {}
  const bearerVar = parseTomlScalar(toml, 'bearer_token_env_var')
  const envKeyVar = parseTomlScalar(toml, 'env_key')
  const bearerToken = resolveEnvValue(auth, bearerVar)
  const envKeyToken = resolveEnvValue(auth, envKeyVar)

  if (bearerToken) addHeader(upstreamHeaders, 'authorization', `Bearer ${bearerToken}`)

  for (const mapping of parseTomlEnvHeaderMappings(toml)) {
    const value = resolveEnvValue(auth, mapping.envName)
    if (!value) continue
    addHeader(upstreamHeaders, mapping.headerName, value)
  }

  if (!upstreamHeaders.authorization) {
    const openaiApiKey = firstNonEmptyString(
      auth.OPENAI_API_KEY,
      auth.openai_api_key,
      auth.api_key,
      envKeyToken
    )
    if (openaiApiKey) addHeader(upstreamHeaders, 'authorization', `Bearer ${openaiApiKey}`)
  }

  return {
    id: String(provider.id || '').trim(),
    upstreamBaseUrl,
    upstreamHeaders
  }
}

const extractAnthropicUpstream = (provider) => {
  if (!provider || typeof provider !== 'object') return null
  const settings = ensureObject(provider.settingsConfig)
  const env = ensureObject(settings.env)

  const upstreamBaseUrl = normalizeUrl(
    firstNonEmptyString(
      env.ANTHROPIC_BASE_URL,
      settings.ANTHROPIC_BASE_URL
    )
  )
  if (!upstreamBaseUrl) return null

  const token = firstNonEmptyString(
    env.ANTHROPIC_AUTH_TOKEN,
    settings.ANTHROPIC_AUTH_TOKEN,
    env.ANTHROPIC_API_KEY,
    settings.ANTHROPIC_API_KEY
  )

  const upstreamHeaders = {}
  if (token) addHeader(upstreamHeaders, 'x-api-key', token)

  const anthropicVersion = firstNonEmptyString(
    env.ANTHROPIC_VERSION,
    settings.ANTHROPIC_VERSION
  )
  if (anthropicVersion) addHeader(upstreamHeaders, 'anthropic-version', anthropicVersion)

  return {
    id: String(provider.id || '').trim(),
    upstreamBaseUrl,
    upstreamHeaders
  }
}

const extractOpenCodeUpstream = (provider) => {
  if (!provider || typeof provider !== 'object') return null

  const fragment = extractOpenCodeProviderFragment(provider.settingsConfig, provider.id)
  const options = ensureObject(fragment?.options)

  const baseUrl = firstNonEmptyString(
    options.baseURL,
    options.baseUrl,
    fragment?.baseURL,
    fragment?.baseUrl
  )

  const upstreamBaseUrl = normalizeUrl(baseUrl)
  if (!upstreamBaseUrl) return null

  const upstreamHeaders = {}
  const headersObj = ensureObject(options.headers)
  for (const [name, value] of Object.entries(headersObj)) {
    if (typeof value !== 'string') continue
    addHeader(upstreamHeaders, name, value)
  }

  const apiKey = firstNonEmptyString(options.apiKey, options.api_key)
  if (apiKey && !upstreamHeaders.authorization && !upstreamHeaders['x-api-key']) {
    addHeader(upstreamHeaders, 'authorization', `Bearer ${apiKey}`)
  }

  return {
    id: String(provider.id || '').trim(),
    upstreamBaseUrl,
    upstreamHeaders
  }
}

const extractProviderUpstream = (appKey, provider) => {
  if (appKey === 'claude') return extractAnthropicUpstream(provider)
  if (appKey === 'opencode') return extractOpenCodeUpstream(provider) || extractOpenAIUpstream(provider)
  return extractOpenAIUpstream(provider)
}

const extractOpenCodeProviderFragment = (settingsConfig, providerId) => {
  if (!settingsConfig || typeof settingsConfig !== 'object' || Array.isArray(settingsConfig)) return null

  const configObj = settingsConfig
  if (configObj.$schema || configObj.provider) {
    const providerBlock = configObj.provider
    if (providerBlock && typeof providerBlock === 'object' && !Array.isArray(providerBlock)) {
      if (providerId && providerBlock[providerId]) return providerBlock[providerId]
    }
  }

  return configObj
}

const resolveWindowsUserHomeOnC = () => {
  const normalize = (p) => String(p || '').trim().replace(/[\\/]+$/, '')
  const isGood = (p) => {
    const v = normalize(p)
    if (!v) return false
    if (!path.isAbsolute(v)) return false
    try {
      return fs.existsSync(v)
    } catch (_) {
      return false
    }
  }

  const fromEnv = normalize(process.env.USERPROFILE || process.env.HOME || '')
  if (fromEnv.toLowerCase().startsWith('c:\\') && isGood(fromEnv)) return fromEnv

  const fromApp = (() => {
    try {
      return normalize(app.getPath('home'))
    } catch (_) {
      return ''
    }
  })()
  if (fromApp.toLowerCase().startsWith('c:\\') && isGood(fromApp)) return fromApp

  const fromOs = normalize(os.homedir())
  if (fromOs.toLowerCase().startsWith('c:\\') && isGood(fromOs)) return fromOs

  const username = String(process.env.USERNAME || '').trim()
  if (username) {
    const guess = `C:\\Users\\${username}`
    if (isGood(guess)) return guess
  }

  if (isGood(fromEnv)) return fromEnv
  if (isGood(fromApp)) return fromApp
  if (isGood(fromOs)) return fromOs
  return normalize(fromEnv || fromApp || fromOs || 'C:\\')
}

const ensureWindowsClaudeJson = (homeOnC) => {
  const home = String(homeOnC || '').trim()
  if (!home) return null

  const target = path.join(home, '.claude.json')
  try {
    if (fs.existsSync(target)) return target
  } catch (_) {
    // continue
  }

  const candidates = []
  const pushHome = (p) => {
    const v = String(p || '').trim()
    if (!v) return
    if (v.toLowerCase() === home.toLowerCase()) return
    candidates.push(v)
  }

  // Try to migrate an existing .claude.json from other home paths (e.g. legacy D:\Users\...).
  pushHome(process.env.USERPROFILE)
  pushHome(process.env.HOME)
  try {
    pushHome(app.getPath('home'))
  } catch (_) {}
  try {
    pushHome(os.homedir())
  } catch (_) {}

  for (const h of candidates) {
    const src = path.join(h, '.claude.json')
    try {
      if (!fs.existsSync(src)) continue
      fs.copyFileSync(src, target)
      return target
    } catch (_) {
      // continue
    }
  }

  try {
    fs.writeFileSync(target, '{}\n', 'utf8')
    return target
  } catch (_) {
    return null
  }
}

const installClaudeJsonIntoProfile = (profileHome, windowsHomeOnC) => {
  const homeOnC = String(windowsHomeOnC || '').trim()
  if (!homeOnC) return { mode: 'none' }

  const globalPath = ensureWindowsClaudeJson(homeOnC)
  if (!globalPath) return { mode: 'none' }

  const target = path.join(String(profileHome || ''), '.claude.json')
  const sanitizeExistingTarget = () => {
    try {
      if (!fs.existsSync(target)) return { ok: false }
      const raw = fs.readFileSync(target, 'utf8')
      const doc = parseJsonObject(raw)
      if (!doc) return { ok: false }
      deleteKeyDeep(doc, 'lastSessionId')
      deleteKeyDeep(doc, 'projects')
      fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      return { ok: true }
    } catch (_) {
      return { ok: false }
    }
  }

  // If a previous version created a hardlink/symlink to the global .claude.json,
  // break that link to avoid config bleed across templates.
  try {
    if (fs.existsSync(target)) {
      try {
        const lst = fs.lstatSync(target)
        if (lst.isSymbolicLink()) {
          fs.rmSync(target, { force: true })
        } else {
          try {
            const stTarget = fs.statSync(target)
            const stGlobal = fs.statSync(globalPath)
            if (stTarget.dev === stGlobal.dev && stTarget.ino && stTarget.ino === stGlobal.ino) {
              fs.rmSync(target, { force: true })
            } else {
              sanitizeExistingTarget()
              return { mode: 'existing' }
            }
          } catch (_) {
            sanitizeExistingTarget()
            return { mode: 'existing' }
          }
        }
      } catch (_) {
        sanitizeExistingTarget()
        return { mode: 'existing' }
      }
    }
  } catch (_) {}

  try {
    // Copy while stripping session-carrying fields that can cause cross-profile bleed.
    // Claude Code is expected to keep this file as JSON; if parsing fails, fall back to a raw copy.
    try {
      const raw = fs.readFileSync(globalPath, 'utf8')
      const doc = parseJsonObject(raw)
      if (doc) {
        deleteKeyDeep(doc, 'lastSessionId')
        deleteKeyDeep(doc, 'projects')
        fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8')
      } else {
        fs.copyFileSync(globalPath, target)
      }
    } catch (_) {
      fs.copyFileSync(globalPath, target)
    }
    return { mode: 'copy' }
  } catch (_) {
    return { mode: 'none' }
  }
}

class PTYManager {
  constructor() {
    this.sessions = new Map()
    this.codexTempHomes = new Map()
    this.appProxyServer = new AppProxyServer()
  }

  async ensureAppProxyOrigin() {
    try {
      return await this.appProxyServer.ensureStarted()
    } catch (err) {
      console.warn('[PTYManager] Failed to start app-level proxy:', err)
      return null
    }
  }

  buildAppProxyProviders(appKey, providers, orderedProviderIds) {
    const providerMap = new Map()
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue
      const id = String(provider.id || '').trim()
      if (!id) continue
      providerMap.set(id, provider)
    }

    const out = []
    for (const id of Array.isArray(orderedProviderIds) ? orderedProviderIds : []) {
      const providerId = String(id || '').trim()
      if (!providerId) continue
      const provider = providerMap.get(providerId)
      if (!provider) continue
      const upstream = extractProviderUpstream(appKey, provider)
      if (!upstream || !upstream.upstreamBaseUrl) continue
      out.push({
        id: providerId,
        upstreamBaseUrl: upstream.upstreamBaseUrl,
        upstreamHeaders: upstream.upstreamHeaders || {}
      })
    }
    return out
  }

  getCodexPersistDir(configId) {
    const id = typeof configId === 'string' ? configId.trim() : ''
    if (!id) return null
    return path.join(app.getPath('userData'), 'codex-runtime', id, 'persist')
  }

  getCodexPersistWhitelist() {
    const defaults = ['history.jsonl']
    const raw = String(process.env.MPS_CODEX_PERSIST_WHITELIST || '').trim()
    if (!raw) return defaults

    const out = []
    for (const chunk of raw.split(/[;,]/g)) {
      const trimmed = String(chunk || '').trim()
      if (!trimmed) continue
      if (path.isAbsolute(trimmed)) continue

      const normalized = trimmed.replace(/\\/g, '/')
      const parts = normalized.split('/').filter(Boolean)
      if (parts.length === 0) continue
      if (parts.some((p) => p === '.' || p === '..')) continue
      if (!parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) continue
      const baseName = parts[parts.length - 1].toLowerCase()
      if (baseName === 'config.toml' || baseName === 'auth.json') continue

      out.push(parts.join(path.sep))
    }

    return out.length > 0 ? Array.from(new Set(out)) : defaults
  }

  acquireCodexPersistLock(persistDir) {
    const dir = String(persistDir || '').trim()
    if (!dir) return null

    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (_) {
      return null
    }

    const lockPath = path.join(dir, '.mps-codex-sync.lock')
    const timeoutMs = Number(process.env.MPS_CODEX_PERSIST_LOCK_TIMEOUT_MS || 5000)
    const staleMs = Number(process.env.MPS_CODEX_PERSIST_LOCK_STALE_MS || 120000)
    const started = Date.now()

    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        try {
          fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
        } catch (_) {}
        return { lockPath, fd }
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return null

        let isStale = false
        try {
          const stat = fs.statSync(lockPath)
          if (Number.isFinite(staleMs) && staleMs > 0) {
            isStale = Date.now() - stat.mtimeMs > staleMs
          }
        } catch (_) {}

        if (isStale) {
          try {
            fs.rmSync(lockPath, { force: true })
          } catch (_) {}
          continue
        }

        if (Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - started > timeoutMs) {
          return null
        }

        sleepSync(50)
      }
    }
  }

  releaseCodexPersistLock(lock) {
    if (!lock) return
    try {
      if (typeof lock.fd === 'number') fs.closeSync(lock.fd)
    } catch (_) {}
    try {
      fs.rmSync(lock.lockPath, { force: true })
    } catch (_) {}
  }

  restoreCodexPersistedFiles(configId, codexHome) {
    const persistDir = this.getCodexPersistDir(configId)
    if (!persistDir) return { persistDir: null, baselines: {}, whitelist: [] }

    const whitelist = this.getCodexPersistWhitelist()
    const baselines = {}

    const lock = this.acquireCodexPersistLock(persistDir)
    try {
      if (process.env.MPS_CODEX_CLEAR_HISTORY === '1') {
        for (const rel of whitelist) {
          try {
            fs.rmSync(path.join(persistDir, rel), { force: true })
          } catch (_) {}
        }
      }

      for (const rel of whitelist) {
        const src = path.join(persistDir, rel)
        if (!fs.existsSync(src)) {
          baselines[rel] = 0
          continue
        }

        const dest = path.join(codexHome, rel)
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
        } catch (_) {}

        try {
          fs.copyFileSync(src, dest)
        } catch (_) {}

        try {
          baselines[rel] = fs.statSync(src).size
        } catch (_) {
          baselines[rel] = 0
        }
      }
    } finally {
      this.releaseCodexPersistLock(lock)
    }

    return { persistDir, baselines, whitelist }
  }

  readFileSliceSync(filePath, start) {
    const safeStart = Math.max(0, Number(start) || 0)
    const stat = fs.statSync(filePath)
    const size = Number(stat?.size || 0)
    if (size <= safeStart) return Buffer.alloc(0)

    const len = size - safeStart
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      const bytes = fs.readSync(fd, buf, 0, len, safeStart)
      return bytes === len ? buf : buf.subarray(0, Math.max(0, bytes))
    } finally {
      try {
        fs.closeSync(fd)
      } catch (_) {}
    }
  }

  appendBufferWithNewline(destPath, buf) {
    if (!buf || buf.length === 0) return

    let needsNewline = false
    try {
      const stat = fs.statSync(destPath)
      const size = Number(stat?.size || 0)
      if (size > 0) {
        const fd = fs.openSync(destPath, 'r')
        try {
          const last = Buffer.alloc(1)
          fs.readSync(fd, last, 0, 1, size - 1)
          const lastByte = last[0]
          const firstByte = buf[0]
          const endsNl = lastByte === 0x0a || lastByte === 0x0d
          const startsNl = firstByte === 0x0a || firstByte === 0x0d
          needsNewline = !endsNl && !startsNl
        } finally {
          try {
            fs.closeSync(fd)
          } catch (_) {}
        }
      }
    } catch (_) {
      // ignore
    }

    try {
      if (needsNewline) fs.appendFileSync(destPath, '\n')
    } catch (_) {}

    try {
      fs.appendFileSync(destPath, buf)
    } catch (_) {}
  }

  persistCodexTempFiles(sessionInfo) {
    if (!sessionInfo || typeof sessionInfo !== 'object') return

    const home = typeof sessionInfo.home === 'string' ? sessionInfo.home : ''
    const configId = typeof sessionInfo.configId === 'string' ? sessionInfo.configId : ''
    const persistDir = typeof sessionInfo.persistDir === 'string' ? sessionInfo.persistDir : ''
    const baselines = sessionInfo.baselines && typeof sessionInfo.baselines === 'object' ? sessionInfo.baselines : {}
    const whitelist = Array.isArray(sessionInfo.whitelist) ? sessionInfo.whitelist : this.getCodexPersistWhitelist()

    if (!home || !persistDir || !configId) return

    const lock = this.acquireCodexPersistLock(persistDir)
    try {
      for (const rel of whitelist) {
        const src = path.join(home, rel)
        if (!fs.existsSync(src)) continue

        const dest = path.join(persistDir, rel)
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
        } catch (_) {}

        if (!fs.existsSync(dest)) {
          try {
            fs.copyFileSync(src, dest)
          } catch (_) {}
          continue
        }

        let baseSize = 0
        if (typeof baselines?.[rel] === 'number') baseSize = baselines[rel]

        let srcSize = 0
        try {
          srcSize = fs.statSync(src).size
        } catch (_) {
          srcSize = 0
        }

        let start = 0
        if (baseSize > 0 && srcSize >= baseSize) {
          start = baseSize
        } else if (baseSize > 0 && srcSize < baseSize) {
          // Codex rewrote/truncated the file; fall back to appending the whole file.
          start = 0
        }

        let chunk = Buffer.alloc(0)
        try {
          chunk = this.readFileSliceSync(src, start)
        } catch (_) {
          chunk = Buffer.alloc(0)
        }

        if (chunk.length === 0) continue
        this.appendBufferWithNewline(dest, chunk)
      }
    } finally {
      this.releaseCodexPersistLock(lock)
    }
  }

  normalizeEnvObject(obj) {
    const out = {}
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
    const ALLOWED_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/i
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).trim()
      if (!key) continue
      if (!ALLOWED_ENV_VAR_PATTERN.test(key)) {
        console.warn(`[PTYManager] Skipping invalid env var name: ${key}`)
        continue
      }
      out[key] = v == null ? '' : String(v)
    }
    return out
  }

  escapeForPSSingleQuoted(value) {
    return String(value ?? '')
      .replace(/\r/g, '')
      .replace(/\n/g, '`n')
      .replace(/'/g, "''")
  }

  applyEnvInPowerShellSession(ptyProcess, envVars, profileName) {
    const entries = Object.entries(envVars || {})
    if (entries.length === 0) return

    const pairs = entries
      .filter(([k]) => String(k || '').trim())
      .map(([k, v]) => `'${this.escapeForPSSingleQuoted(k)}'='${this.escapeForPSSingleQuoted(v)}'`)
      .join(';')

    // Set env vars in-session (Process scope) without echoing secrets to the terminal.
    // If you need a visible confirmation for debugging, set MPS_DEBUG_ENV_APPLY=1.
    const debug = process.env.MPS_DEBUG_ENV_APPLY === '1'
    const safeProfile = this.escapeForPSSingleQuoted(profileName || '')
    const cmd =
      `$__mps=@{${pairs}};` +
      `foreach($k in $__mps.Keys){[Environment]::SetEnvironmentVariable($k,$__mps[$k],'Process')};` +
      (debug ? `Write-Host "[mps] env applied (${entries.length}) ${safeProfile}";` : '') +
      `Remove-Variable __mps -ErrorAction SilentlyContinue`

    ptyProcess.write(`${cmd}\r`)
  }

  ensureCodexHome(sessionId, config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'codex') return null

    const configId = typeof config?.id === 'string' ? config.id.trim() : ''
    const configToml = typeof config?.codexConfigToml === 'string' ? config.codexConfigToml : ''
    const authJson = typeof config?.codexAuthJson === 'string' ? config.codexAuthJson : ''

    if (!configToml.trim() && !authJson.trim()) return null

    // Important: Codex may write/modify files under CODEX_HOME (e.g., notice flags, tokens).
    // We keep the user's configured sources in userData/codex-homes/<configId>/, but run each
    // session with an isolated temp CODEX_HOME so the source files never drift.
    const codexHome = path.join(os.tmpdir(), `mps-codex-home-${sessionId}`)
    try {
      fs.mkdirSync(codexHome, { recursive: true })
    } catch (_) {
      return null
    }

    try {
      let restored = { persistDir: null, whitelist: [], baselines: {} }
      try {
        restored = this.restoreCodexPersistedFiles(configId, codexHome)
      } catch (_) {
        restored = { persistDir: null, whitelist: [], baselines: {} }
      }

      if (configToml.trim()) {
        fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml, 'utf8')
      }
      if (authJson.trim()) {
        fs.writeFileSync(path.join(codexHome, 'auth.json'), authJson, 'utf8')
      }
      this.codexTempHomes.set(sessionId, {
        home: codexHome,
        configId,
        persistDir: restored.persistDir,
        whitelist: restored.whitelist,
        baselines: restored.baselines
      })
      return codexHome
    } catch (_) {
      try {
        if (process.env.MPS_KEEP_CODEX_HOME !== '1') fs.rmSync(codexHome, { recursive: true, force: true })
      } catch (_) {}
      return null
    }
  }

  cleanupCodexHome(sessionId) {
    const info = this.codexTempHomes.get(sessionId)
    if (!info) return
    this.codexTempHomes.delete(sessionId)

    try {
      this.persistCodexTempFiles(info)
    } catch (err) {
      console.warn('[PTYManager] Failed to persist Codex runtime state:', err)
    }

    const home = typeof info === 'string' ? info : String(info.home || '')
    if (!home) return

    if (process.env.MPS_KEEP_CODEX_HOME === '1') return
    try {
      if (fs.existsSync(home)) {
        fs.rmSync(home, { recursive: true, force: true })
      }
    } catch (err) {
      console.error(`[PTYManager] Failed to cleanup ${home}:`, err)
    }
  }

  cleanupOrphanedTempDirs() {
    const tmpDir = os.tmpdir()
    try {
      const entries = fs.readdirSync(tmpDir)
      for (const entry of entries) {
        if (entry.startsWith('mps-codex-home-')) {
          const fullPath = path.join(tmpDir, entry)
          fs.rmSync(fullPath, { recursive: true, force: true })
        }
      }
    } catch (err) {
      console.warn('[PTYManager] Failed to cleanup orphaned temp dirs:', err)
    }
  }

  syncClaudeProfileFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'claude-code') return null
    const id = typeof config?.id === 'string' ? config.id.trim() : ''
    if (!id) return null

    const settingsJson = typeof config?.claudeSettingsJson === 'string' ? config.claudeSettingsJson : ''
    const payload = settingsJson.trim() ? settingsJson : '{}'

    const profileHome = path.join(app.getPath('userData'), 'claude-homes', id)
    try {
      fs.mkdirSync(profileHome, { recursive: true })
      fs.writeFileSync(path.join(profileHome, 'settings.json'), payload, 'utf8')

      // Keep Claude Code sessions pinned to C:\Users\<name>\.claude.json on Windows.
      // Always copy .claude.json into the per-template profile dir. We intentionally do NOT
      // hardlink/symlink because Claude Code can write to this file and we must avoid config bleed.
      const windowsHome = process.platform === 'win32' ? resolveWindowsUserHomeOnC() : ''
      if (windowsHome) {
        installClaudeJsonIntoProfile(profileHome, windowsHome)
      }

      // History retention:
      // Default: preserve `history.jsonl` in the per-template profile so Claude Code can resume.
      // Opt-in clear: set MPS_CLAUDE_CLEAR_HISTORY=1.
      if (process.env.MPS_CLAUDE_CLEAR_HISTORY === '1') {
        const candidates = [
          path.join(profileHome, 'history.jsonl'),
          path.join(profileHome, '.claude', 'history.jsonl')
        ]
        for (const candidate of candidates) {
          try {
            fs.rmSync(candidate, { force: true })
          } catch (_) {
            // ignore
          }
        }
      }

      return profileHome
    } catch (_) {
      return null
    }
  }

  syncCodexProfileFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'codex') return null
    const id = typeof config?.id === 'string' ? config.id.trim() : ''
    if (!id) return null

    const toml = typeof config?.codexConfigToml === 'string' ? config.codexConfigToml : ''
    const auth = typeof config?.codexAuthJson === 'string' ? config.codexAuthJson : ''

    const profileHome = path.join(app.getPath('userData'), 'codex-homes', id)
    try {
      fs.mkdirSync(profileHome, { recursive: true })
      fs.writeFileSync(path.join(profileHome, 'config.toml'), toml, 'utf8')
      fs.writeFileSync(path.join(profileHome, 'auth.json'), auth, 'utf8')
      return profileHome
    } catch (_) {
      return null
    }
  }

  syncOpenCodeProfileFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'opencode') return null
    const id = typeof config?.id === 'string' ? config.id.trim() : ''
    if (!id) return null

    const opencodeConfigJson =
      typeof config?.opencodeConfigJson === 'string' ? config.opencodeConfigJson : ''
    const payload = opencodeConfigJson.trim() ? opencodeConfigJson : OPENCODE_CONFIG_TEMPLATE

    const userData = app.getPath('userData')
    const profileHome = path.join(userData, 'opencode-homes', id)
    const runtimeDir = path.join(userData, 'opencode-runtime', id)
    const configDir = path.join(profileHome, 'opencode')
    try {
      fs.mkdirSync(configDir, { recursive: true })
      fs.mkdirSync(runtimeDir, { recursive: true })

      const configPath = path.join(configDir, '.opencode.json')
      const doc = parseJsonObject(payload)
      if (doc) {
        const next = ensureObject(clonePlain(doc))
        next.data = ensureObject(next.data)
        if (typeof next.data.directory !== 'string' || !next.data.directory.trim()) {
          next.data.directory = runtimeDir
        }
        fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
      } else {
        fs.writeFileSync(configPath, payload, 'utf8')
      }

      return {
        profileHome,
        xdgConfigHome: profileHome,
        configPath,
        runtimeDir
      }
    } catch (_) {
      return null
    }
  }

  extractCodexTempEnvVars(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'codex') return {}

    const configToml = typeof config?.codexConfigToml === 'string' ? config.codexConfigToml : ''
    const authRaw = typeof config?.codexAuthJson === 'string' ? config.codexAuthJson : ''

    let auth = null
    try {
      const trimmed = String(authRaw || '').trim()
      auth = trimmed ? JSON.parse(trimmed) : null
    } catch (_) {
      auth = null
    }

    const out = {}
    const setStr = (k, v) => {
      const key = String(k || '').trim()
      if (!key) return
      if (typeof v !== 'string') return
      out[key] = v
    }

    // Minimal/low-risk mappings from auth.json -> env vars.
    // Only map "api_key" to OPENAI_API_KEY; do NOT map access_token/refresh_token.
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      if (typeof auth.OPENAI_API_KEY === 'string') setStr('OPENAI_API_KEY', auth.OPENAI_API_KEY)
      if (!out.OPENAI_API_KEY && typeof auth.api_key === 'string') setStr('OPENAI_API_KEY', auth.api_key)
      if (!out.OPENAI_API_KEY && typeof auth.openai_api_key === 'string') setStr('OPENAI_API_KEY', auth.openai_api_key)

      if (typeof auth.OPENAI_ORGANIZATION === 'string') setStr('OPENAI_ORGANIZATION', auth.OPENAI_ORGANIZATION)
      if (!out.OPENAI_ORGANIZATION && typeof auth.organization === 'string') setStr('OPENAI_ORGANIZATION', auth.organization)

      if (typeof auth.OPENAI_PROJECT === 'string') setStr('OPENAI_PROJECT', auth.OPENAI_PROJECT)
      if (!out.OPENAI_PROJECT && typeof auth.project === 'string') setStr('OPENAI_PROJECT', auth.project)
    }

    // Discover which env var names config.toml expects (env_key, env_http_headers, bearer_token_env_var),
    // then fill them from auth.json if auth.json provides same-named keys.
    const needed = new Set()
    const addNeeded = (name) => {
      const v = String(name || '').trim()
      if (!v) return
      needed.add(v)
    }

    const toml = String(configToml || '')

    // Apply [shell_environment_policy].set into the current PowerShell session env.
    // This is TOML; we intentionally support only the common single-line map form.
    for (const m of toml.matchAll(/^\s*set\s*=\s*\{([^}]*)\}\s*$/gmi)) {
      const body = m[1] || ''
      for (const kv of body.matchAll(/(?:^|,)\s*("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*=\s*"([^"]*)"\s*/g)) {
        const k = kv[2]
        const v = kv[3]
        if (out[k] == null) out[k] = v
      }
    }

    for (const m of toml.matchAll(/^\s*env_key\s*=\s*"([^"]+)"\s*$/gmi)) addNeeded(m[1])
    for (const m of toml.matchAll(/^\s*bearer_token_env_var\s*=\s*"([^"]+)"\s*$/gmi)) addNeeded(m[1])

    for (const m of toml.matchAll(/env_http_headers\s*=\s*\{([^}]*)\}/gmi)) {
      const body = m[1] || ''
      for (const kv of body.matchAll(/"[^"]+"\s*=\s*"([^"]+)"/g)) addNeeded(kv[1])
    }

    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      for (const name of Array.from(needed)) {
        if (out[name] != null) continue
        if (typeof auth[name] === 'string') setStr(name, auth[name])
      }
    }

    return out
  }

  async resolveCCSwitchRuntimeConfig(config, options = {}) {
    const base = config && typeof config === 'object' ? clonePlain(config) : {}
    const compatProxyEnabled =
      base?.proxyEnabled == null ? Boolean(base?.useCCSwitchProxy) : Boolean(base?.proxyEnabled)
    const useCCSwitch = Boolean(base?.useCCSwitch) || compatProxyEnabled
    if (!useCCSwitch) return { config: base, extraEnv: {} }

    // Safety: only allow CC Switch runtime rewrites for templates imported from CC Switch.
    // This prevents accidental bleed-over when users switch between CC Switch and built-in configs.
    if (!isImportedFromCCSwitch(base)) {
      base.useCCSwitch = false
      base.useCCSwitchProxy = false
      base.proxyEnabled = false
      base.proxyImplementation = 'off'
      base.ccSwitchProviderId = ''
      return { config: base, extraEnv: {} }
    }

    const type = typeof base?.type === 'string' ? base.type : ''
    const appKey = resolveAppKeyFromType(type)
    if (!appKey) return { config: base, extraEnv: {} }

    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : ''
    const snapshot = await ccSwitch.listProviders()
    const appProxyOrigin = await this.ensureAppProxyOrigin()
    let policy = mergeEffectiveProxyPolicy({
      template: base,
      snapshot,
      appKey,
      appProxyOrigin
    })

    const providers = Array.isArray(snapshot?.apps?.[appKey]?.providers)
      ? snapshot.apps[appKey].providers
      : []
    const requestedProviderId = typeof base?.ccSwitchProviderId === 'string' ? base.ccSwitchProviderId.trim() : ''
    const currentProviderId = String(snapshot?.apps?.[appKey]?.currentId || '').trim()

    const preferredProviderId = policy?.queue?.primaryProviderId || requestedProviderId || currentProviderId
    let provider = preferredProviderId
      ? providers.find((p) => p && p.id === preferredProviderId)
      : null
    if (!provider && providers.length > 0) provider = providers[0]

    if (!provider && policy.routeMode !== 'ccswitch-proxy') {
      throw new Error(`CC Switch provider not found for ${appKey} (id=${preferredProviderId || '<current>'})`)
    }

    let proxyOrigin = null
    let proxyOpenAIBase = null
    let proxyPlaceholderToken = 'ccswitch'

    if (policy.routeMode === 'ccswitch-proxy') {
      proxyOrigin = policy.ccProxy.listenOrigin
      proxyOpenAIBase = policy.ccProxy.openAIBase
      proxyPlaceholderToken = 'ccswitch'
    } else if (policy.routeMode === 'app-proxy') {
      if (!sessionId || !appProxyOrigin) {
        policy = { ...policy, routeMode: 'direct', circuitBreakerMode: 'off' }
      } else {
        const appProxyProviders = this.buildAppProxyProviders(
          appKey,
          providers,
          policy?.queue?.orderedProviderIds || []
        )
        if (appProxyProviders.length === 0) {
          policy = { ...policy, routeMode: 'direct', circuitBreakerMode: 'off' }
        } else {
          const orderedProviderIds = appProxyProviders.map((p) => p.id)
          const registered = this.appProxyServer.upsertSession(sessionId, {
            appKey,
            orderedProviderIds,
            providers: appProxyProviders,
            failoverEnabled: Boolean(policy?.appFailover?.enabled),
            retry: policy?.appFailover || {}
          })

          if (!registered) {
            policy = { ...policy, routeMode: 'direct', circuitBreakerMode: 'off' }
          } else {
            const sessionProxyOrigin = joinUrl(appProxyOrigin, `/s/${encodeURIComponent(sessionId)}`)
            proxyOrigin = sessionProxyOrigin
            proxyOpenAIBase = joinUrl(sessionProxyOrigin, '/v1')
            proxyPlaceholderToken = 'mps-proxy'
          }
        }
      }
    }

    const extraEnv = {}

    if (type === 'claude-code') {
      const baseSettings = parseJsonObject(base?.claudeSettingsJson) || {}
      const providerSettings = ensureObject(provider?.settingsConfig)

      const merged = mergeObjectsWithEnv(baseSettings, providerSettings)
      if (policy.routeMode === 'ccswitch-proxy' || policy.routeMode === 'app-proxy') {
        if (proxyOrigin) {
          merged.env = ensureObject(merged.env)
          merged.env.ANTHROPIC_BASE_URL = proxyOrigin
          merged.env.ANTHROPIC_AUTH_TOKEN = proxyPlaceholderToken
        }
      }

      // Claude Code reads env vars from settings.json. Keep them file-based to avoid leaking in the terminal.
      base.claudeSettingsJson = JSON.stringify(merged, null, 2)
      base.useCCSwitch = true
      base.useCCSwitchProxy = policy.routeMode === 'ccswitch-proxy'
      base.proxyEnabled = compatProxyEnabled
      base.proxyImplementation = policy.proxyImplementation
      return { config: base, extraEnv }
    }

    if (type === 'codex') {
      const settings = ensureObject(provider?.settingsConfig)
      const providerToml = typeof settings?.config === 'string' ? settings.config : ''
      const providerAuth = ensureObject(settings?.auth)

      let toml =
        providerToml ||
        (typeof base?.codexConfigToml === 'string' ? base.codexConfigToml : '')

      let authObj =
        Object.keys(providerAuth).length > 0
          ? clonePlain(providerAuth)
          : (parseJsonObject(base?.codexAuthJson) || {})

      if ((policy.routeMode === 'ccswitch-proxy' || policy.routeMode === 'app-proxy') && proxyOpenAIBase) {
        const rewritten = rewriteTomlBaseUrl(toml, proxyOpenAIBase)
        toml = rewritten.replaced ? rewritten.text : makeCodexProxyToml(proxyOpenAIBase)

        authObj = ensureObject(authObj)
        authObj.OPENAI_API_KEY = proxyPlaceholderToken
        authObj.api_key = proxyPlaceholderToken
        authObj.openai_api_key = proxyPlaceholderToken

        extraEnv.OPENAI_BASE_URL = proxyOpenAIBase
        extraEnv.OPENAI_API_BASE = proxyOpenAIBase
      }

      base.codexConfigToml = String(toml || '')
      base.codexAuthJson = JSON.stringify(authObj, null, 2)
      base.useCCSwitch = true
      base.useCCSwitchProxy = policy.routeMode === 'ccswitch-proxy'
      base.proxyEnabled = compatProxyEnabled
      base.proxyImplementation = policy.proxyImplementation
      return { config: base, extraEnv }
    }

    if (type === 'opencode') {
      const providerSettings = provider ? extractOpenCodeProviderFragment(provider.settingsConfig, provider.id) : null
      const providerIdForConfig =
        provider?.id ||
        preferredProviderId ||
        policy?.queue?.primaryProviderId ||
        'ccswitch'

      const baseDoc =
        parseJsonObject(base?.opencodeConfigJson) ||
        parseJsonObject(OPENCODE_CONFIG_TEMPLATE) || {
          $schema: 'https://opencode.ai/config.json',
          permission: OPENCODE_PERMISSION_TEMPLATE
        }

      if (!baseDoc.$schema) baseDoc.$schema = 'https://opencode.ai/config.json'
      if (!baseDoc.permission || typeof baseDoc.permission !== 'object' || Array.isArray(baseDoc.permission)) {
        baseDoc.permission = OPENCODE_PERMISSION_TEMPLATE
      }

      const providerBlock = ensureObject(baseDoc.provider)
      const fragment = providerSettings ? clonePlain(providerSettings) : null

      let nextFragment =
        fragment ||
        ((policy.routeMode === 'ccswitch-proxy' || policy.routeMode === 'app-proxy') && (proxyOpenAIBase || proxyOrigin)
          ? {
              npm: '@ai-sdk/openai-compatible',
              name: 'CC Switch Proxy',
              options: { baseURL: proxyOpenAIBase || proxyOrigin, apiKey: proxyPlaceholderToken },
              models: {}
            }
          : null)

      if ((policy.routeMode === 'ccswitch-proxy' || policy.routeMode === 'app-proxy') && proxyOrigin) {
        nextFragment = ensureObject(nextFragment)
        nextFragment.options = ensureObject(nextFragment.options)
        const npm = String(nextFragment.npm || '').toLowerCase()
        const baseURL =
          npm.includes('anthropic') || npm.includes('claude') || npm.includes('openrouter')
            ? proxyOrigin
            : proxyOpenAIBase || proxyOrigin
        nextFragment.options.baseURL = baseURL
        nextFragment.options.apiKey = proxyPlaceholderToken
      }

      if (nextFragment) {
        providerBlock[providerIdForConfig] = nextFragment
      }
      baseDoc.provider = providerBlock

      base.opencodeConfigJson = JSON.stringify(baseDoc, null, 2)
      base.useCCSwitch = true
      base.useCCSwitchProxy = policy.routeMode === 'ccswitch-proxy'
      base.proxyEnabled = compatProxyEnabled
      base.proxyImplementation = policy.proxyImplementation
      return { config: base, extraEnv }
    }

    base.useCCSwitch = true
    base.useCCSwitchProxy = policy.routeMode === 'ccswitch-proxy'
    base.proxyEnabled = compatProxyEnabled
    base.proxyImplementation = policy.proxyImplementation
    return { config: base, extraEnv }
  }
  
  async createSession(config, workingDir, mainWindow) {
    const sessionId = uuidv4()
    const resolved = await this.resolveCCSwitchRuntimeConfig(config, { sessionId })
    const effectiveConfig = resolved?.config || config
    const extraEnv = resolved?.extraEnv && typeof resolved.extraEnv === 'object' ? resolved.extraEnv : {}

    const type = typeof effectiveConfig?.type === 'string' ? effectiveConfig.type : ''
    const isCodex = type === 'codex'
    const isClaudeCode = type === 'claude-code'
    const cfgEnv = (isCodex || isClaudeCode) ? {} : this.normalizeEnvObject(effectiveConfig?.envVars)

    // Working directory is selected only when creating a new tab/session.
    // Do not persist/associate it with the template/profile itself.
    let cwd = workingDir || process.env.USERPROFILE

    // Only inject environment variables into the PowerShell session (per-process).
    // Source of truth is the user config JSON's env (stored as config.envVars).
    const codexTempEnv = this.extractCodexTempEnvVars(effectiveConfig)
    const env = { ...process.env, ...cfgEnv, ...extraEnv, ...codexTempEnv }

    const claudeProfileHome = this.syncClaudeProfileFiles(effectiveConfig)
    if (claudeProfileHome) {
      env.CLAUDE_CONFIG_DIR = claudeProfileHome
    }

    // Claude Code loads "Project settings" from <cwd>/.claude/settings.json.
    // If we default to the real user home dir on Windows (which usually has ~/.claude),
    // those project settings can override the per-template CLAUDE_CONFIG_DIR and cause
    // cross-template config bleed (e.g. CC Switch vs non-CC Switch).
    // Only when the user didn't explicitly pick a workingDir, default to the isolated profile dir.
    if (isClaudeCode && !workingDir && claudeProfileHome) {
      cwd = claudeProfileHome
    }

    // Claude Code uses the Windows user home for ~/.claude.json.
    // We always isolate it to the per-template profile dir to avoid config bleed across templates.
    if (isClaudeCode && process.platform === 'win32') {
      const desiredHome = claudeProfileHome || ''
      if (!desiredHome) {
        // best-effort: keep the default inherited USERPROFILE
      } else {
        env.USERPROFILE = desiredHome
        env.HOME = desiredHome
        const drive = desiredHome.slice(0, 2)
        const rest = desiredHome.slice(2).replace(/\//g, '\\')
        if (/^[A-Za-z]:$/.test(drive)) env.HOMEDRIVE = drive
        if (rest.startsWith('\\')) env.HOMEPATH = rest
      }
    }

    const opencodeProfile = this.syncOpenCodeProfileFiles(effectiveConfig)
    if (opencodeProfile && opencodeProfile.xdgConfigHome) {
      env.XDG_CONFIG_HOME = opencodeProfile.xdgConfigHome
      env.MPS_OPENCODE_PROFILE_HOME = opencodeProfile.profileHome
      env.MPS_OPENCODE_DATA_DIR = opencodeProfile.runtimeDir
    }

    // Codex: create an isolated CODEX_HOME with per-template config.toml/auth.json,
    // then inject CODEX_HOME as a process-scoped env var (temporary, per session).
    const profileHome = this.syncCodexProfileFiles(effectiveConfig)
    const codexHome = this.ensureCodexHome(sessionId, effectiveConfig)
    let psArgs = []
    let psStartupCmd = ''
    if (codexHome) {
      const configId = typeof effectiveConfig?.id === 'string' ? effectiveConfig.id.trim() : ''
      if (configId) {
        env.MPS_CODEX_PROFILE_HOME = profileHome || path.join(app.getPath('userData'), 'codex-homes', configId)
      }
      env.CODEX_HOME = codexHome
      env.CODEX_CONFIG_TOML_PATH = path.join(codexHome, 'config.toml')
      env.CODEX_AUTH_JSON_PATH = path.join(codexHome, 'auth.json')
      // Convenience aliases (some users expect these names).
      env.CODEX_CONFIG_TOML = env.CODEX_CONFIG_TOML_PATH
      env.CODEX_AUTH_JSON = env.CODEX_AUTH_JSON_PATH

      // Some Windows pty stacks can be picky about inheriting *new* env vars.
      // For Codex, redundantly set the non-secret path vars via -Command at startup (no echo in the terminal).
      const homeQ = this.escapeForPSSingleQuoted(codexHome)
      const tomlQ = this.escapeForPSSingleQuoted(env.CODEX_CONFIG_TOML_PATH)
      const authQ = this.escapeForPSSingleQuoted(env.CODEX_AUTH_JSON_PATH)
      const profileQ = this.escapeForPSSingleQuoted(env.MPS_CODEX_PROFILE_HOME || '')
      const cmd =
        `$env:CODEX_HOME='${homeQ}';` +
        `$env:CODEX_CONFIG_TOML_PATH='${tomlQ}';` +
        `$env:CODEX_AUTH_JSON_PATH='${authQ}';` +
        `$env:CODEX_CONFIG_TOML='${tomlQ}';` +
        `$env:CODEX_AUTH_JSON='${authQ}';` +
        (env.MPS_CODEX_PROFILE_HOME ? `$env:MPS_CODEX_PROFILE_HOME='${profileQ}';` : '') +
        `Write-Host "[mps] CODEX_HOME=$env:CODEX_HOME";` +
        `Write-Host "[mps] CODEX_CONFIG_TOML=$env:CODEX_CONFIG_TOML";` +
        `Write-Host "[mps] CODEX_AUTH_JSON=$env:CODEX_AUTH_JSON";` +
        (env.MPS_CODEX_PROFILE_HOME ? `Write-Host "[mps] MPS_CODEX_PROFILE_HOME=$env:MPS_CODEX_PROFILE_HOME";` : '')
      psStartupCmd = cmd
    }

    // Optional but recommended: emit a prompt marker that ShellMonitor can detect reliably.
    // It tries to keep the terminal UX unchanged by printing the marker, carriage-returning,
    // and clearing the line before returning the original prompt.
    const enablePromptMarker = process.env.MPS_DISABLE_PROMPT_MARKER !== '1'
    if (enablePromptMarker) {
      const inject =
        'try{' +
        'if(-not $global:__MPS_PROMPT_INSTALLED){' +
        '$global:__MPS_PROMPT_INSTALLED=$true;' +
        '$global:__MPS_ORIG_PROMPT=$function:prompt;' +
        'function global:prompt{' +
        // NOTE: Use [char]27 instead of `e for compatibility with Windows PowerShell 5.1
        // (which would otherwise render "e[2K" as literal text in the prompt).
        'try{Write-Host -NoNewline (\"' + PROMPT_MARKER + '`r\" + [char]27 + \"[2K\")}catch{};' +
        '& $global:__MPS_ORIG_PROMPT' +
        '}' +
        '}' +
        '}catch{}'
      psStartupCmd = psStartupCmd ? `${psStartupCmd};${inject}` : inject
    }

    if (psStartupCmd) {
      psArgs = ['-NoExit', '-Command', psStartupCmd]
    }
    
    const sendToWindow = (channel, payload) => {
      // Newer multi-instance mode: allow passing a custom sender function.
      if (typeof mainWindow === 'function') {
        try {
          mainWindow(channel, payload)
        } catch (_) {}
        return
      }

      if (!mainWindow || typeof mainWindow !== 'object') return
      if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) return
      const contents = mainWindow.webContents
      if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return
      contents.send(channel, payload)
    }

    let ptyProcess = null
    try {
      ptyProcess = pty.spawn('powershell.exe', psArgs, {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: cwd,
        env: env
      })
    } catch (err) {
      this.appProxyServer.removeSession(sessionId)
      throw err
    }

    shellMonitor.registerSession(sessionId, type, {
      configName: typeof effectiveConfig?.name === 'string' ? effectiveConfig.name : '',
      cwd
    })
    
    ptyProcess.onData(data => {
      sendToWindow('terminal:data', { sessionId, data })
      shellMonitor.onData(sessionId, data)
    })
    
    ptyProcess.onExit(({ exitCode }) => {
      sendToWindow('terminal:exit', { sessionId, code: exitCode })
      shellMonitor.onExit(sessionId, exitCode)
      this.cleanupCodexHome(sessionId)
      this.appProxyServer.removeSession(sessionId)
      this.sessions.delete(sessionId)
    })
    
    this.sessions.set(sessionId, ptyProcess)

    // Env vars are already injected via pty.spawn(..., env). For non-Codex profiles we also
    // mirror them via SetEnvironmentVariable so they're guaranteed to be visible in-session.
    // For Codex we avoid echoing a long "set env" command that confuses users.
    if (!isCodex && !isClaudeCode) {
      this.applyEnvInPowerShellSession(ptyProcess, { ...cfgEnv }, effectiveConfig?.name || '')
    }
    
    return sessionId
  }
  
  writeToSession(sessionId, data) {
    const session = this.sessions.get(sessionId)
    if (session) session.write(data)
  }
  
  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (session) session.resize(cols, rows)
  }
  
  killSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.kill()
      this.sessions.delete(sessionId)
    }

    this.cleanupCodexHome(sessionId)
    this.appProxyServer.removeSession(sessionId)
    shellMonitor.unregisterSession(sessionId)
  }
  
  killAllSessions() {
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        session.kill()
      } catch (_) {}
      this.appProxyServer.removeSession(sessionId)
      shellMonitor.unregisterSession(sessionId)
    }
    this.sessions.clear()
    // Best-effort cleanup for any remaining Codex homes.
    for (const sid of Array.from(this.codexTempHomes.keys())) {
      this.cleanupCodexHome(sid)
    }
  }
}

module.exports = new PTYManager()

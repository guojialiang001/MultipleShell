const fs = require('fs')
const os = require('os')
const path = require('path')

const CC_SWITCH_APP_ID = 'com.ccswitch.desktop'
const STORE_FILE = 'app_paths.json'
const STORE_KEY_APP_CONFIG_DIR = 'app_config_dir_override'

const resolveHomeDir = () => {
  const envHome = process.platform === 'win32' ? String(process.env.HOME || '').trim() : ''
  if (envHome) return envHome

  try {
    return os.homedir()
  } catch (_) {
    return String(process.env.USERPROFILE || process.env.HOME || '.')
  }
}

const expandTilde = (inputPath) => {
  const raw = String(inputPath || '').trim()
  if (!raw) return raw
  if (raw === '~') return resolveHomeDir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(resolveHomeDir(), raw.slice(2))
  }
  return raw
}

const readJsonFileSafe = (filePath) => {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

const tryResolveConfigDirFromStore = () => {
  const appData =
    String(process.env.APPDATA || '').trim() ||
    (() => {
      try {
        const { app } = require('electron')
        return app?.getPath?.('appData') || ''
      } catch (_) {
        return ''
      }
    })() ||
    resolveHomeDir()

  const candidates = [
    path.join(appData, CC_SWITCH_APP_ID, STORE_FILE),
    path.join(appData, 'CC Switch', STORE_FILE),
    path.join(appData, 'CCSwitch', STORE_FILE)
  ]

  for (const storePath of candidates) {
    const data = readJsonFileSafe(storePath)
    if (!data || typeof data !== 'object') continue

    const raw = data[STORE_KEY_APP_CONFIG_DIR]
    if (typeof raw !== 'string') continue

    const resolved = expandTilde(raw)
    if (!resolved) continue
    if (!fs.existsSync(resolved)) continue

    return { configDir: resolved, source: 'store', storePath }
  }

  return null
}

const resolveConfigDir = () => {
  const envOverride = String(
    process.env.MPS_CC_SWITCH_CONFIG_DIR || process.env.CC_SWITCH_CONFIG_DIR || ''
  ).trim()
  if (envOverride) {
    return { configDir: expandTilde(envOverride), source: 'env', storePath: null }
  }

  const store = tryResolveConfigDirFromStore()
  if (store) return store

  return {
    configDir: path.join(resolveHomeDir(), '.cc-switch'),
    source: 'default',
    storePath: null
  }
}

const resolveDbPath = (configDir) => path.join(configDir, 'cc-switch.db')
const resolveLogPath = (configDir) => path.join(configDir, 'logs', 'cc-switch.log')

function detect() {
  const { configDir, source, storePath } = resolveConfigDir()
  const dbPath = resolveDbPath(configDir)
  const configDirExists = fs.existsSync(configDir)
  const dbExists = fs.existsSync(dbPath)

  return {
    exists: Boolean(configDirExists && dbExists),
    reason: !configDirExists ? 'CONFIG_DIR_NOT_FOUND' : !dbExists ? 'DB_NOT_FOUND' : null,
    configDir,
    dbPath,
    source,
    storePath: storePath || null
  }
}

const safeJsonParse = (value, fallback) => {
  try {
    if (value == null) return fallback
    const text = typeof value === 'string' ? value : String(value)
    const trimmed = text.trim()
    if (!trimmed) return fallback
    return JSON.parse(trimmed)
  } catch (_) {
    return fallback
  }
}

let sqlInitPromise = null
const getSqlJs = async () => {
  if (sqlInitPromise) return sqlInitPromise

  let initSqlJs = null
  try {
    initSqlJs = require('sql.js')
    initSqlJs = initSqlJs.default || initSqlJs
  } catch (err) {
    const e = new Error('Missing dependency: sql.js. Run `npm i sql.js` in MultipleShell.')
    e.cause = err
    throw e
  }

  const baseDir = (() => {
    try {
      return path.dirname(require.resolve('sql.js/dist/sql-wasm.js'))
    } catch (_) {}

    try {
      return path.dirname(require.resolve('sql.js'))
    } catch (_) {}

    return null
  })()

  sqlInitPromise = initSqlJs({
    locateFile: (file) => (baseDir ? path.join(baseDir, file) : file)
  })

  return sqlInitPromise
}

const rowsFromExec = (result) => {
  if (!Array.isArray(result) || result.length === 0) return []
  const entry = result[0]
  const columns = Array.isArray(entry?.columns) ? entry.columns : []
  const values = Array.isArray(entry?.values) ? entry.values : []
  if (columns.length === 0 || values.length === 0) return []

  return values.map((row) => {
    const obj = {}
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
    return obj
  })
}

const readSettingsCurrentProviders = (configDir) => {
  const settingsPath = path.join(configDir, 'settings.json')
  const settings = readJsonFileSafe(settingsPath)
  if (!settings || typeof settings !== 'object') return { settingsPath, current: {} }

  const getId = (key) => {
    const v = settings[key]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  return {
    settingsPath,
    current: {
      claude: getId('currentProviderClaude'),
      codex: getId('currentProviderCodex'),
      gemini: getId('currentProviderGemini'),
      opencode: getId('currentProviderOpencode')
    }
  }
}

async function listProviders() {
  const { configDir, source, storePath } = resolveConfigDir()
  const dbPath = resolveDbPath(configDir)

  if (!fs.existsSync(dbPath)) {
    const err = new Error(`CC Switch database not found: ${dbPath}`)
    err.code = 'CCSWITCH_DB_NOT_FOUND'
    throw err
  }

  const dbBytes = fs.readFileSync(dbPath)
  const SQL = await getSqlJs()
  const db = new SQL.Database(new Uint8Array(dbBytes))

  try {
    const providerRows = rowsFromExec(
      db.exec(
        `SELECT id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue
         FROM providers
         ORDER BY app_type, COALESCE(sort_index, 999999), id ASC`
      )
    )

    const endpointRows = rowsFromExec(
      db.exec(
        `SELECT provider_id, app_type, url, added_at
         FROM provider_endpoints
         ORDER BY added_at ASC, url ASC`
      )
    )

    let proxyRows = []
    try {
      proxyRows = rowsFromExec(
        db.exec(
          `SELECT app_type, listen_address, listen_port, proxy_enabled, enabled, auto_failover_enabled
           FROM proxy_config`
        )
      )
    } catch (_) {
      // Back-compat: old proxy_config schema may not have app_type (single row table).
      try {
        const legacy = rowsFromExec(
          db.exec(
            `SELECT listen_address, listen_port, proxy_enabled, enabled, auto_failover_enabled
             FROM proxy_config
             LIMIT 1`
          )
        )
        if (legacy.length > 0) {
          const row = legacy[0]
          proxyRows = ['claude', 'codex', 'gemini'].map((app_type) => ({ ...row, app_type }))
        }
      } catch (_) {
        proxyRows = []
      }
    }

    const endpointsByProvider = new Map()
    for (const row of endpointRows) {
      const key = `${row.app_type || ''}:${row.provider_id || ''}`
      if (!endpointsByProvider.has(key)) endpointsByProvider.set(key, [])
      endpointsByProvider.get(key).push({
        url: row.url,
        addedAt: row.added_at == null ? null : Number(row.added_at)
      })
    }

    const byApp = {
      claude: { currentIdDb: null, providers: [] },
      codex: { currentIdDb: null, providers: [] },
      gemini: { currentIdDb: null, providers: [] },
      opencode: { currentIdDb: null, providers: [] }
    }

    for (const row of providerRows) {
      const appType = String(row.app_type || '').trim()
      const id = String(row.id || '').trim()
      if (!appType || !id) continue

      const provider = {
        id,
        appType,
        name: String(row.name || ''),
        settingsConfig: safeJsonParse(row.settings_config, null),
        websiteUrl: typeof row.website_url === 'string' ? row.website_url : null,
        category: typeof row.category === 'string' ? row.category : null,
        createdAt: row.created_at == null ? null : Number(row.created_at),
        sortIndex: row.sort_index == null ? null : Number(row.sort_index),
        notes: typeof row.notes === 'string' ? row.notes : null,
        icon: typeof row.icon === 'string' ? row.icon : null,
        iconColor: typeof row.icon_color === 'string' ? row.icon_color : null,
        meta: safeJsonParse(row.meta, {}),
        isCurrent: Boolean(row.is_current),
        inFailoverQueue: Boolean(row.in_failover_queue),
        endpoints: endpointsByProvider.get(`${appType}:${id}`) || []
      }

      if (!Object.prototype.hasOwnProperty.call(byApp, appType)) {
        byApp[appType] = { currentIdDb: null, providers: [] }
      }
      byApp[appType].providers.push(provider)
      if (provider.isCurrent) byApp[appType].currentIdDb = id
    }

    const settingsCurrent = readSettingsCurrentProviders(configDir)

    const enrichApp = (appKey) => {
      const app = byApp[appKey] || { currentIdDb: null, providers: [] }
      const ids = new Set(app.providers.map((p) => p.id))
      const currentFromSettings = settingsCurrent.current[appKey] || null

      const currentId =
        (currentFromSettings && ids.has(currentFromSettings) && currentFromSettings) ||
        (app.currentIdDb && ids.has(app.currentIdDb) && app.currentIdDb) ||
        null

      return {
        currentId,
        currentFrom:
          currentId === currentFromSettings
            ? 'settings'
            : currentId === app.currentIdDb
            ? 'db'
            : null,
        providers: app.providers
      }
    }

    const proxy = {}
    for (const row of proxyRows) {
      const appType = String(row.app_type || '').trim()
      if (!appType) continue
      const listenAddress = typeof row.listen_address === 'string' ? row.listen_address : '127.0.0.1'
      const listenPortRaw = row.listen_port == null ? 15721 : Number(row.listen_port)
      const listenPort = Number.isFinite(listenPortRaw) && listenPortRaw > 0 ? listenPortRaw : 15721
      proxy[appType] = {
        listenAddress,
        listenPort,
        proxyEnabled: Boolean(row.proxy_enabled),
        enabled: Boolean(row.enabled),
        autoFailoverEnabled: Boolean(row.auto_failover_enabled)
      }
    }

    return {
      source: {
        configDir,
        dbPath,
        source,
        storePath: storePath || null,
        settingsPath: settingsCurrent.settingsPath
      },
      proxy,
      apps: {
        claude: enrichApp('claude'),
        codex: enrichApp('codex'),
        gemini: enrichApp('gemini'),
        opencode: enrichApp('opencode')
      }
    }
  } finally {
    db.close()
  }
}

const sanitizeId = (input) =>
  String(input || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120)

const sanitizeClaudeSettings = (settings) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {}
  const out = { ...settings }
  delete out.api_format
  delete out.apiFormat
  delete out.openrouter_compat_mode
  delete out.openrouterCompatMode
  return out
}

const extractOpenCodeProviderFragment = (settingsConfig, providerId) => {
  if (!settingsConfig || typeof settingsConfig !== 'object') return settingsConfig

  if (settingsConfig.$schema || settingsConfig.provider) {
    const providerBlock = settingsConfig.provider
    if (providerBlock && typeof providerBlock === 'object' && !Array.isArray(providerBlock)) {
      if (providerBlock[providerId]) return providerBlock[providerId]
    }
  }

  return settingsConfig
}

const OPENCODE_PERMISSION_TEMPLATE = {
  edit: 'ask',
  bash: 'ask',
  webfetch: 'allow'
}

function toMultipleShellConfigs(providerSnapshot) {
  const out = []
  const apps = providerSnapshot?.apps || {}

  for (const p of apps?.claude?.providers || []) {
    const settings = sanitizeClaudeSettings(p.settingsConfig || {})
    out.push({
      id: `ccswitch-claude-${sanitizeId(p.id)}`,
      type: 'claude-code',
      name: `CC Switch - ${p.name || p.id}`,
      importSource: 'ccswitch',
      useCCSwitch: true,
      useCCSwitchProxy: false,
      ccSwitchProviderId: p.id,
      envVars: {},
      claudeSettingsJson: JSON.stringify(settings, null, 2),
      codexConfigToml: '',
      codexAuthJson: '',
      opencodeConfigJson: ''
    })
  }

  for (const p of apps?.codex?.providers || []) {
    const settings = p.settingsConfig && typeof p.settingsConfig === 'object' ? p.settingsConfig : {}
    const auth = settings && typeof settings.auth === 'object' && settings.auth ? settings.auth : {}
    const configToml = typeof settings.config === 'string' ? settings.config : ''

    out.push({
      id: `ccswitch-codex-${sanitizeId(p.id)}`,
      type: 'codex',
      name: `CC Switch - ${p.name || p.id}`,
      importSource: 'ccswitch',
      useCCSwitch: true,
      useCCSwitchProxy: false,
      ccSwitchProviderId: p.id,
      envVars: {},
      claudeSettingsJson: '',
      codexConfigToml: String(configToml || ''),
      codexAuthJson: JSON.stringify(auth, null, 2),
      opencodeConfigJson: ''
    })
  }

  for (const p of apps?.opencode?.providers || []) {
    const fragment = extractOpenCodeProviderFragment(p.settingsConfig || {}, p.id) || {}
    const config = {
      $schema: 'https://opencode.ai/config.json',
      permission: OPENCODE_PERMISSION_TEMPLATE,
      provider: {
        [p.id]: fragment
      }
    }

    out.push({
      id: `ccswitch-opencode-${sanitizeId(p.id)}`,
      type: 'opencode',
      name: `CC Switch - ${p.name || p.id}`,
      importSource: 'ccswitch',
      useCCSwitch: true,
      useCCSwitchProxy: false,
      ccSwitchProviderId: p.id,
      envVars: {},
      claudeSettingsJson: '',
      codexConfigToml: '',
      codexAuthJson: '',
      opencodeConfigJson: JSON.stringify(config, null, 2)
    })
  }

  return out
}

async function importProviders(configManager, options = {}) {
  if (!configManager || typeof configManager.saveConfig !== 'function') {
    throw new Error('importProviders requires configManager')
  }

  const snapshot = options && typeof options === 'object' && options.snapshot ? options.snapshot : await listProviders()
  const configs = toMultipleShellConfigs(snapshot).map((cfg) => {
    const next = cfg && typeof cfg === 'object' ? { ...cfg } : cfg
    if (!next || typeof next !== 'object') return next

    const type = typeof next.type === 'string' ? next.type : ''
    const proxyAppKey = type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : type === 'opencode' ? 'codex' : ''
    const proxyCfg = proxyAppKey ? snapshot?.proxy?.[proxyAppKey] : null

    // If CC Switch proxy + auto-failover is enabled for this app, default imports to using the proxy.
    // This makes the terminal clients send requests directly to the CC Switch proxy address, which is
    // required for failover semantics to take effect.
    const proxyEnabled = Boolean(proxyCfg && proxyCfg.proxyEnabled)
    const enabled = Boolean(proxyCfg && proxyCfg.enabled)
    const autoFailoverEnabled = Boolean(proxyCfg && proxyCfg.autoFailoverEnabled)
    const shouldUseProxy = proxyEnabled && enabled && autoFailoverEnabled

    if (shouldUseProxy) {
      next.useCCSwitch = true
      next.useCCSwitchProxy = true
    }

    return next
  })

  // "Overwrite import": remove previously imported CC Switch templates first,
  // then re-import from the current CC Switch snapshot.
  // This keeps the app in sync (including removals) and avoids stale templates.
  try {
    const existing = typeof configManager.loadConfigs === 'function' ? configManager.loadConfigs() : []
    const list = Array.isArray(existing) ? existing : []
    const isImportedFromCCSwitch = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return false
      if (cfg.importSource === 'ccswitch') return true
      // Back-compat: stable prefix + provider id indicates an imported CC Switch template.
      const id = typeof cfg.id === 'string' ? cfg.id : ''
      const providerId = typeof cfg.ccSwitchProviderId === 'string' ? cfg.ccSwitchProviderId.trim() : ''
      return id.startsWith('ccswitch-') && Boolean(providerId)
    }

    const importedIds = list
      .filter(isImportedFromCCSwitch)
      .map((c) => c.id)
      .filter((id) => typeof id === 'string' && id.trim())

    if (typeof configManager.deleteConfig === 'function') {
      for (const id of importedIds) {
        try {
          configManager.deleteConfig(id)
        } catch (_) {}
      }
    }
  } catch (_) {}

  for (const cfg of configs) {
    configManager.saveConfig(cfg)
  }

  return configManager.loadConfigs()
}

module.exports = {
  detect,
  listProviders,
  importProviders,
  toMultipleShellConfigs,
  tailRequestPaths
}

function tailRequestPaths(options = {}) {
  const { configDir } = resolveConfigDir()
  const logPath = resolveLogPath(configDir)
  const appType = typeof options?.appType === 'string' ? options.appType.trim().toLowerCase() : ''
  const limitRaw = options?.limit == null ? 50 : Number(options.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50
  const maxBytes = 256 * 1024

  if (!fs.existsSync(logPath)) return { logPath, lines: [] }

  let text = ''
  try {
    const stat = fs.statSync(logPath)
    const size = stat.size || 0
    const start = size > maxBytes ? size - maxBytes : 0
    const fd = fs.openSync(logPath, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      try { fs.closeSync(fd) } catch (_) {}
    }
  } catch (_) {
    try {
      text = fs.readFileSync(logPath, 'utf8')
    } catch (_) {
      return { logPath, lines: [] }
    }
  }

  const out = []
  const rows = String(text || '').split(/\r?\n/).filter(Boolean)
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i]
    const idx = line.indexOf('[REQ]')
    if (idx < 0) continue
    const m = line.slice(idx).match(/^\[REQ\]\s+app=([a-z0-9_-]+)\s+path=(.+)$/i)
    if (!m) continue
    const a = String(m[1] || '').trim().toLowerCase()
    const p = String(m[2] || '').trim()
    if (appType && a !== appType) continue
    out.push({ appType: a, path: p, raw: line })
    if (out.length >= limit) break
  }

  return { logPath, lines: out.reverse() }
}


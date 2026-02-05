const fs = require('fs')
const path = require('path')
const { app, safeStorage, dialog } = require('electron')
const { v4: uuidv4 } = require('uuid')

const VALID_TYPES = new Set(['claude-code', 'codex', 'opencode'])

class ConfigManager {
  constructor() {
    this.configs = []
    this._storeCache = null
    this._notifiedEncryptionUnavailable = false
    this._lastLoadInfo = null
    this._lastSeedFromLegacy = false
  }

  getCodexHomesRoot() {
    return path.join(app.getPath('userData'), 'codex-homes')
  }

  getCodexHomePath(configId) {
    const id = typeof configId === 'string' ? configId.trim() : ''
    if (!id) return null
    return path.join(this.getCodexHomesRoot(), id)
  }

  getClaudeHomesRoot() {
    return path.join(app.getPath('userData'), 'claude-homes')
  }

  getClaudeHomePath(configId) {
    const id = typeof configId === 'string' ? configId.trim() : ''
    if (!id) return null
    return path.join(this.getClaudeHomesRoot(), id)
  }

  getOpenCodeHomesRoot() {
    return path.join(app.getPath('userData'), 'opencode-homes')
  }

  getOpenCodeHomePath(configId) {
    const id = typeof configId === 'string' ? configId.trim() : ''
    if (!id) return null
    return path.join(this.getOpenCodeHomesRoot(), id)
  }

  getOpenCodeConfigTemplate() {
    // Upstream OpenCode reads `.opencode.json` and merges config from `$XDG_CONFIG_HOME/opencode/.opencode.json`.
    // Keep the default template minimal; MultipleShell will inject a per-template `data.directory` when materializing.
    return '{\n  \n}\n'
  }

  getClaudeSettingsTemplate() {
    return JSON.stringify(
      {
        env: {
          ANTHROPIC_AUTH_TOKEN: 'your_zhipu_api_key',
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1
        }
      },
      null,
      2
    )
  }

  setSecurePermissions(targetPath, isDirectory = false) {
    try {
      const mode = isDirectory ? 0o700 : 0o600
      fs.chmodSync(targetPath, mode)
    } catch (_) {
      // chmod may not work properly on Windows; ignore errors
    }
  }

  ensureSecureRootDirectories() {
    const roots = [
      this.getClaudeHomesRoot(),
      this.getCodexHomesRoot(),
      this.getOpenCodeHomesRoot(),
      path.join(app.getPath('userData'), 'codex-runtime'),
      path.join(app.getPath('userData'), 'opencode-runtime'),
      app.getPath('userData')
    ]
    for (const root of roots) {
      try {
        if (fs.existsSync(root)) {
          this.setSecurePermissions(root, true)
        }
      } catch (_) {
        // ignore
      }
    }
  }

  writeClaudeHomeFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'claude-code') return

    const claudeHome = this.getClaudeHomePath(config?.id)
    if (!claudeHome) return

    const settingsJson = typeof config?.claudeSettingsJson === 'string' ? config.claudeSettingsJson : ''
    const payload = settingsJson.trim() ? settingsJson : '{}'

    fs.mkdirSync(claudeHome, { recursive: true })
    this.setSecurePermissions(claudeHome, true)
    const filePath = path.join(claudeHome, 'settings.json')
    fs.writeFileSync(filePath, payload, 'utf8')
    this.setSecurePermissions(filePath, false)
  }

  deleteClaudeHomeFiles(configId) {
    const claudeHome = this.getClaudeHomePath(configId)
    if (!claudeHome) return
    try {
      fs.rmSync(claudeHome, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  }

  writeOpenCodeHomeFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'opencode') return

    const openCodeHome = this.getOpenCodeHomePath(config?.id)
    if (!openCodeHome) return

    const opencodeConfigJson =
      typeof config?.opencodeConfigJson === 'string' ? config.opencodeConfigJson : ''
    const payload = opencodeConfigJson.trim() ? opencodeConfigJson : this.getOpenCodeConfigTemplate()

    fs.mkdirSync(openCodeHome, { recursive: true })
    this.setSecurePermissions(openCodeHome, true)

    const parseJsonObject = (raw) => {
      try {
        const text = String(raw || '').trim()
        if (!text) return null
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed
      } catch (_) {
        return null
      }
    }

    const ensurePlainObject = (value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? value : {}

    const userData = app.getPath('userData')
    const id = path.basename(openCodeHome)
    const runtimeDir = path.join(userData, 'opencode-runtime', id)

    const configDir = path.join(openCodeHome, 'opencode')
    fs.mkdirSync(configDir, { recursive: true })
    this.setSecurePermissions(configDir, true)

    fs.mkdirSync(runtimeDir, { recursive: true })
    this.setSecurePermissions(runtimeDir, true)

    const filePath = path.join(configDir, '.opencode.json')
    const doc = parseJsonObject(payload)
    if (doc) {
      doc.data = ensurePlainObject(doc.data)
      if (typeof doc.data.directory !== 'string' || !doc.data.directory.trim()) {
        doc.data.directory = runtimeDir
      }
      fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    } else {
      fs.writeFileSync(filePath, payload, 'utf8')
    }
    this.setSecurePermissions(filePath, false)
  }

  deleteOpenCodeHomeFiles(configId) {
    const openCodeHome = this.getOpenCodeHomePath(configId)
    if (!openCodeHome) return
    try {
      fs.rmSync(openCodeHome, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }

    // Clean up per-template runtime state as well.
    try {
      const id = typeof configId === 'string' ? configId.trim() : ''
      if (!id) return
      const runtimeDir = path.join(app.getPath('userData'), 'opencode-runtime', id)
      fs.rmSync(runtimeDir, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  }

  writeCodexHomeFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'codex') return

    const codexHome = this.getCodexHomePath(config?.id)
    if (!codexHome) return

    const toml = typeof config?.codexConfigToml === 'string' ? config.codexConfigToml : ''
    const auth = typeof config?.codexAuthJson === 'string' ? config.codexAuthJson : ''

    fs.mkdirSync(codexHome, { recursive: true })
    this.setSecurePermissions(codexHome, true)
    const configPath = path.join(codexHome, 'config.toml')
    const authPath = path.join(codexHome, 'auth.json')
    fs.writeFileSync(configPath, toml, 'utf8')
    fs.writeFileSync(authPath, auth, 'utf8')
    this.setSecurePermissions(configPath, false)
    this.setSecurePermissions(authPath, false)

    // Codex runtime state is synced (whitelist-based) into a stable per-template directory
    // so tool history can be retained across MultipleShell restarts.
    try {
      const userData = app.getPath('userData')
      const id = path.basename(codexHome)
      const persistDir = path.join(userData, 'codex-runtime', id, 'persist')
      fs.mkdirSync(persistDir, { recursive: true })
      this.setSecurePermissions(path.dirname(persistDir), true)
      this.setSecurePermissions(persistDir, true)
    } catch (_) {
      // ignore
    }
  }

  deleteCodexHomeFiles(configId) {
    const codexHome = this.getCodexHomePath(configId)
    if (codexHome) {
      try {
        fs.rmSync(codexHome, { recursive: true, force: true })
      } catch (_) {
        // ignore
      }
    }

    // Clean up per-template runtime state as well.
    try {
      const id = typeof configId === 'string' ? configId.trim() : ''
      if (!id) return
      const runtimeDir = path.join(app.getPath('userData'), 'codex-runtime', id)
      fs.rmSync(runtimeDir, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  }
  
  loadConfigs() {
    const store = this.loadStore()
    this.configs = store.configs
    // Keep Claude/Codex/OpenCode source files in sync.
    try {
      this.ensureSecureRootDirectories()
      for (const cfg of this.configs) {
        this.writeClaudeHomeFiles(cfg)
        this.writeCodexHomeFiles(cfg)
        this.writeOpenCodeHomeFiles(cfg)
      }
    } catch (_) {
      // ignore
    }
    return store.configs
  }

  reloadConfigs() {
    this._storeCache = null
    return this.loadConfigs()
  }

  getLastLoadInfo() {
    return this._lastLoadInfo
  }
  
  saveConfig(config) {
    const store = this.loadStore()

    const incoming = this.normalizeConfig(config)
    const idx = store.configs.findIndex(c => c.id === incoming.id)

    const now = new Date().toISOString()
    if (idx === -1) {
      store.configs.push({ ...incoming, createdAt: now, updatedAt: now })
    } else {
      const prev = store.configs[idx]
      store.configs[idx] = { ...incoming, createdAt: prev.createdAt || now, updatedAt: now }
    }

    store.updatedAt = new Date().toISOString()
    this.writeStore(store)

    try { this.writeClaudeHomeFiles(incoming) } catch (_) {}

    // Codex configs must be file-backed. Mirror the two source files under userData.
    try { this.writeCodexHomeFiles(incoming) } catch (_) {}

    // OpenCode configs are written to an app-level config file.
    try { this.writeOpenCodeHomeFiles(incoming) } catch (_) {}

    this.configs = store.configs
    return store.configs
  }
  
  deleteConfig(configId) {
    const store = this.loadStore()
    store.configs = store.configs.filter(c => c.id !== configId)
    store.updatedAt = new Date().toISOString()
    this.writeStore(store)

    try { this.deleteClaudeHomeFiles(configId) } catch (_) {}

    try { this.deleteCodexHomeFiles(configId) } catch (_) {}

    try { this.deleteOpenCodeHomeFiles(configId) } catch (_) {}

    this.configs = store.configs
    return store.configs
  }

  getEncryptedStorePath() {
    const userData = app.getPath('userData')
    return path.join(userData, 'configs.v1.enc')
  }


  getStorePath() {
    return this.getEncryptedStorePath()
  }

  notifyEncryptionUnavailable() {
    if (process.env.MPS_SUPPRESS_DIALOGS === '1') {
      app.quit()
      return
    }
    if (this._notifiedEncryptionUnavailable) return
    this._notifiedEncryptionUnavailable = true

    const message = [
      '当前系统不支持 Electron safeStorage 加密。',
      '',
      '应用需要系统密钥链服务才能安全存储配置：',
      '- Windows: DPAPI',
      '- macOS: Keychain',
      '- Linux: libsecret',
      '',
      '应用将退出以保护您的数据安全。'
    ].join('\n')

    try {
      dialog.showMessageBoxSync({
        type: 'error',
        title: '加密存储不可用',
        message,
        buttons: ['退出']
      })
    } catch (_) {}
    app.quit()
  }

  notifyRecoveredFromCorrupt(backupPath) {
    if (process.env.MPS_SUPPRESS_DIALOGS === '1') return
    try {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: '配置已自动恢复',
        message: `配置文件无法读取，已自动恢复为默认配置。\n备份文件：\n${backupPath}`
      })
    } catch (_) {
      // ignore
    }
  }

  isEncryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (_) {
      return false
    }
  }

  ensureEncryptionAvailable() {
    const ok = this.isEncryptionAvailable()
    if (!ok) {
      this._lastLoadInfo = { status: 'encryption-unavailable', at: new Date().toISOString() }
      this.notifyEncryptionUnavailable()
    }
    return ok
  }

  loadStore() {
    if (this._storeCache) return this._storeCache

    const encPath = this.getEncryptedStorePath()
    const encryptionOk = this.ensureEncryptionAvailable()
    if (!encryptionOk) {
      throw new Error('加密存储不可用，应用无法启动')
    }

    const now = () => new Date().toISOString()

    const loadEncrypted = () => {
      if (!fs.existsSync(encPath)) return null
      const payloadB64 = fs.readFileSync(encPath, 'utf8')
      const encrypted = Buffer.from(payloadB64, 'base64')
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted)
      return this.normalizeStore(parsed)
    }

    const seedAndPersist = (status) => {
      const seeded = this.normalizeStore(this.seedInitialStore())
      this.writeStore(seeded)
      this._lastLoadInfo = { status, at: now(), migratedFromLegacy: this._lastSeedFromLegacy }
      return seeded
    }

    try {
      const store = loadEncrypted()
      if (!store) {
        const created = seedAndPersist('created')
        this._storeCache = created
        return created
      }
      this._storeCache = store
      this._lastLoadInfo = { status: 'loaded', at: now() }
      return store
    } catch (err) {
      console.warn('[ConfigManager] Store corrupted/unreadable; backing up and recreating defaults.', err)
      let backupPath = null
      try {
        if (fs.existsSync(encPath)) {
          backupPath = `${encPath}.corrupt.${Date.now()}.bak`
          fs.renameSync(encPath, backupPath)
        }
      } catch (_) {}

      const seeded = this.normalizeStore(this.seedInitialStore())
      try { this.writeStore(seeded) } catch (_) {}
      if (backupPath) this.notifyRecoveredFromCorrupt(backupPath)
      this._lastLoadInfo = { status: 'recovered-from-corrupt', at: now(), backupPath }
      this._storeCache = seeded
      return seeded
    }
  }

  normalizeStore(store) {
    const now = new Date().toISOString()
    const normalizedConfigs = Array.isArray(store?.configs) ? store.configs.map(c => this.normalizeConfig(c)) : []
    const validConfigs = normalizedConfigs.filter(cfg => VALID_TYPES.has(cfg.type))
    const configs = validConfigs.length > 0
      ? validConfigs
      : this.createDefaultConfigs()

    return {
      version: 1,
      updatedAt: typeof store?.updatedAt === 'string' ? store.updatedAt : now,
      configs
    }
  }

  normalizeConfig(config) {
    const now = new Date().toISOString()
    const id = typeof config?.id === 'string' && config.id.trim() ? config.id : uuidv4()

    const typeRaw = typeof config?.type === 'string' ? config.type.trim().toLowerCase() : ''
    const inferredFromName = (() => {
      const nameLower = typeof config?.name === 'string' ? config.name.toLowerCase() : ''
      if (nameLower.includes('codex')) return 'codex'
      if (nameLower.includes('opencode')) return 'opencode'
      if (nameLower.includes('claude')) return 'claude-code'
      return ''
    })()
    const type = VALID_TYPES.has(typeRaw) ? typeRaw : inferredFromName

    const envVars =
      (config?.envVars && typeof config.envVars === 'object' && !Array.isArray(config.envVars)) ? config.envVars : {}

    const rawClaudeSettings =
      typeof config?.claudeSettingsJson === 'string'
        ? config.claudeSettingsJson
        : (typeof config?.claudeSettings === 'string' ? config.claudeSettings : null)

    const claudeSettingsJson =
      rawClaudeSettings != null
        ? rawClaudeSettings
        : (type === 'claude-code' && Object.keys(envVars).length > 0
          ? JSON.stringify({ env: envVars }, null, 2)
          : '')

    const rawOpenCodeConfig =
      typeof config?.opencodeConfigJson === 'string'
        ? config.opencodeConfigJson
        : (typeof config?.opencodeConfig === 'string' ? config.opencodeConfig : '')

    const opencodeConfigJson =
      rawOpenCodeConfig
        ? rawOpenCodeConfig
        : (type === 'opencode' ? this.getOpenCodeConfigTemplate() : '')

    const useCCSwitch = Boolean(config?.useCCSwitch)
    const useCCSwitchProxy = Boolean(config?.useCCSwitchProxy)
    const ccSwitchProviderId =
      typeof config?.ccSwitchProviderId === 'string' ? config.ccSwitchProviderId : ''

    const importSource = (() => {
      const raw = typeof config?.importSource === 'string' ? config.importSource.trim().toLowerCase() : ''
      if (raw === 'ccswitch') return 'ccswitch'

      // Back-compat: older CC Switch imports used a stable id prefix and provider id.
      const name = typeof config?.name === 'string' ? config.name : ''
      const hasLegacyId = typeof id === 'string' && id.startsWith('ccswitch-')
      const hasProviderId = typeof ccSwitchProviderId === 'string' && ccSwitchProviderId.trim()
      const looksLikeCCSwitch = name.startsWith('CC Switch - ')
      if (hasLegacyId && hasProviderId && looksLikeCCSwitch) return 'ccswitch'

      return ''
    })()

    return {
      id,
      type,
      name: typeof config?.name === 'string' ? config.name : 'Unnamed',
      // Working directory is not persisted in templates; it's chosen only when creating a new tab.
      workingDirectory: '',
      envVars,
      useCCSwitch: useCCSwitch || useCCSwitchProxy,
      useCCSwitchProxy,
      ccSwitchProviderId,
      importSource,
      claudeSettingsJson: typeof claudeSettingsJson === 'string' ? claudeSettingsJson : '',
      codexConfigToml: typeof config?.codexConfigToml === 'string' ? config.codexConfigToml : '',
      codexAuthJson: typeof config?.codexAuthJson === 'string' ? config.codexAuthJson : '',
      opencodeConfigJson: typeof opencodeConfigJson === 'string' ? opencodeConfigJson : '',
      updatedAt: typeof config?.updatedAt === 'string' ? config.updatedAt : now,
      createdAt: typeof config?.createdAt === 'string' ? config.createdAt : now
    }
  }

  writeStore(store) {
    const normalized = this.normalizeStore(store)
    this._storeCache = normalized

    if (!this.isEncryptionAvailable()) {
      throw new Error('加密存储不可用，无法保存配置')
    }

    const json = JSON.stringify(normalized)
    const encrypted = safeStorage.encryptString(json)
    const payloadB64 = encrypted.toString('base64')
    const encPath = this.getEncryptedStorePath()
    const dirPath = path.dirname(encPath)
    fs.mkdirSync(dirPath, { recursive: true })
    this.setSecurePermissions(dirPath, true)
    const tmpPath = `${encPath}.tmp`
    fs.writeFileSync(tmpPath, payloadB64, 'utf8')
    this.setSecurePermissions(tmpPath, false)
    fs.renameSync(tmpPath, encPath)
    this.setSecurePermissions(encPath, false)
  }

  seedInitialStore() {
    const legacy = this.loadLegacyConfigs()
    this._lastSeedFromLegacy = legacy.length > 0
    const configs = legacy.length > 0 ? legacy : this.createDefaultConfigs()

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      configs
    }
  }

  createDefaultConfigs() {
    const now = new Date().toISOString()
    return [
      { id: uuidv4(), type: 'claude-code', name: 'Claude Code', workingDirectory: '', envVars: {}, useCCSwitch: false, useCCSwitchProxy: false, ccSwitchProviderId: '', importSource: '', claudeSettingsJson: this.getClaudeSettingsTemplate(), codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: '', createdAt: now, updatedAt: now },
      { id: uuidv4(), type: 'codex', name: 'Codex', workingDirectory: '', envVars: {}, useCCSwitch: false, useCCSwitchProxy: false, ccSwitchProviderId: '', importSource: '', claudeSettingsJson: '', codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: '', createdAt: now, updatedAt: now },
      { id: uuidv4(), type: 'opencode', name: 'OpenCode', workingDirectory: '', envVars: {}, useCCSwitch: false, useCCSwitchProxy: false, ccSwitchProviderId: '', importSource: '', claudeSettingsJson: '', codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: this.getOpenCodeConfigTemplate(), createdAt: now, updatedAt: now }
    ]
  }

  loadLegacyConfigs() {
    const dirsToTry = [
      // Dev: old behavior was workspace-root/configs
      path.join(__dirname, '../../configs'),
      // Packaged: configs might be shipped alongside app resources
      path.join(app.getAppPath(), 'configs')
    ]

    for (const dir of dirsToTry) {
      try {
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        if (files.length === 0) continue

        const parsed = []
        for (const f of files) {
          const content = fs.readFileSync(path.join(dir, f), 'utf8')
          const cfg = JSON.parse(content)
          const baseName = path.basename(f, '.json')
          const baseLower = baseName.toLowerCase()

          const inferredType =
            baseLower.includes('claude') ? 'claude-code' :
            baseLower.includes('codex') ? 'codex' :
            baseLower.includes('opencode') ? 'opencode' :
            (typeof cfg?.type === 'string' ? cfg.type : '')

          // Support both:
          // - app legacy shape: { name, envVars, ... }
          // - tool-ish shape: { env: { ... } } (e.g. Claude Code)
          const envVars =
            (cfg?.envVars && typeof cfg.envVars === 'object' && !Array.isArray(cfg.envVars)) ? cfg.envVars :
            (cfg?.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) ? cfg.env :
            (cfg?.ENV && typeof cfg.ENV === 'object' && !Array.isArray(cfg.ENV)) ? cfg.ENV :
            {}

          parsed.push(this.normalizeConfig({
            ...cfg,
            type: inferredType,
            name: typeof cfg?.name === 'string' && cfg.name.trim() ? cfg.name : baseName,
            envVars,
            // Ensure we don't import a persisted working directory.
            workingDirectory: ''
          }))
        }
        const filtered = parsed.filter(cfg => VALID_TYPES.has(cfg.type))
        if (filtered.length === 0) continue
        return filtered
      } catch (_) {
        // ignore and keep trying
      }
    }

    return []
  }
}

module.exports = new ConfigManager()

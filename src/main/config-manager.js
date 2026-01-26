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
    return '{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": {\n    "edit": "ask",\n    "bash": "ask",\n    "webfetch": "allow"\n  }\n}\n'
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

  writeClaudeHomeFiles(config) {
    const type = typeof config?.type === 'string' ? config.type : ''
    if (type !== 'claude-code') return

    const claudeHome = this.getClaudeHomePath(config?.id)
    if (!claudeHome) return

    const settingsJson = typeof config?.claudeSettingsJson === 'string' ? config.claudeSettingsJson : ''
    const payload = settingsJson.trim() ? settingsJson : '{}'

    fs.mkdirSync(claudeHome, { recursive: true })
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), payload, 'utf8')
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
    fs.writeFileSync(path.join(openCodeHome, 'opencode.json'), payload, 'utf8')
  }

  deleteOpenCodeHomeFiles(configId) {
    const openCodeHome = this.getOpenCodeHomePath(configId)
    if (!openCodeHome) return
    try {
      fs.rmSync(openCodeHome, { recursive: true, force: true })
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
    fs.writeFileSync(path.join(codexHome, 'config.toml'), toml, 'utf8')
    fs.writeFileSync(path.join(codexHome, 'auth.json'), auth, 'utf8')
  }

  deleteCodexHomeFiles(configId) {
    const codexHome = this.getCodexHomePath(configId)
    if (!codexHome) return
    try {
      fs.rmSync(codexHome, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  }
  
  loadConfigs() {
    const store = this.loadStore()
    this.configs = store.configs
    // Keep Claude/Codex/OpenCode source files in sync.
    try {
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

  getPlainStorePath() {
    const userData = app.getPath('userData')
    return path.join(userData, 'configs.v1.json')
  }

  getStorePath() {
    return this.getEncryptedStorePath()
  }

  notifyEncryptionUnavailable() {
    if (process.env.MPS_SUPPRESS_DIALOGS === '1') return
    if (this._notifiedEncryptionUnavailable) return
    this._notifiedEncryptionUnavailable = true

    const message = [
      '当前系统不支持 Electron safeStorage 加密（safeStorage.isEncryptionAvailable() = false）。',
      '应用将改用未加密的本地文件保存配置（configs.v1.json，位于用户数据目录）。',
      '',
      '建议：检查系统密钥链/凭据服务是否可用，或更换支持的环境。'
    ].join('\n')

    try {
      dialog.showMessageBoxSync({
        type: 'error',
        title: '配置加密不可用',
        message
      })
    } catch (_) {
      // ignore
    }
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
    const plainPath = this.getPlainStorePath()
    const encryptionOk = this.ensureEncryptionAvailable()
    const now = () => new Date().toISOString()

    const loadPlain = () => {
      if (!fs.existsSync(plainPath)) return null
      const raw = fs.readFileSync(plainPath, 'utf8')
      const parsed = JSON.parse(raw)
      return this.normalizeStore(parsed)
    }

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
      this._lastLoadInfo = {
        status,
        at: now(),
        migratedFromLegacy: this._lastSeedFromLegacy
      }
      return seeded
    }

    try {
      let store = null
      if (encryptionOk) {
        store = loadEncrypted() || loadPlain()
        if (!store) {
          store = seedAndPersist('created')
          this._storeCache = store
          return store
        }
        this._storeCache = store
        if (!fs.existsSync(encPath)) {
          try { this.writeStore(store) } catch (_) {}
        }
        this._lastLoadInfo = { status: 'loaded', at: now() }
        return store
      }

      store = loadPlain()
      if (!store) {
        store = seedAndPersist('created-plain')
        this._storeCache = store
        return store
      }
      this._storeCache = store
      this._lastLoadInfo = { status: 'loaded-plain', at: now() }
      return store
    } catch (err) {
      // Corrupted or unreadable store: back it up and recreate defaults.
      console.warn('[ConfigManager] Store corrupted/unreadable; backing up and recreating defaults.', err)
      let backupPath = null
      const badPath = encryptionOk ? encPath : plainPath
      try {
        if (fs.existsSync(badPath)) {
          backupPath = `${badPath}.corrupt.${Date.now()}.bak`
          fs.renameSync(badPath, backupPath)
        }
      } catch (_) {
        // ignore
      }

      let recovered = null
      if (encryptionOk) {
        try {
          recovered = loadPlain()
        } catch (_) {
          recovered = null
        }
      }

      const seeded = recovered || this.normalizeStore(this.seedInitialStore())
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
    const configs = normalizedConfigs.length > 0
      ? normalizedConfigs
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

    return {
      id,
      type,
      name: typeof config?.name === 'string' ? config.name : 'Unnamed',
      // Working directory is not persisted in templates; it's chosen only when creating a new tab.
      workingDirectory: '',
      envVars,
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

    const json = JSON.stringify(normalized)
    const encryptionOk = this.isEncryptionAvailable()

    const encPath = this.getEncryptedStorePath()
    const plainPath = this.getPlainStorePath()

    if (encryptionOk) {
      try {
        const encrypted = safeStorage.encryptString(json)
        const payloadB64 = encrypted.toString('base64')
        fs.mkdirSync(path.dirname(encPath), { recursive: true })
        const tmpPath = `${encPath}.tmp`
        fs.writeFileSync(tmpPath, payloadB64, 'utf8')
        fs.renameSync(tmpPath, encPath)
        return
      } catch (err) {
        console.warn('[ConfigManager] Encryption failed; falling back to plain store.', err)
      }
    }

    fs.mkdirSync(path.dirname(plainPath), { recursive: true })
    const tmpPath = `${plainPath}.tmp`
    fs.writeFileSync(tmpPath, json, 'utf8')
    fs.renameSync(tmpPath, plainPath)
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
      { id: uuidv4(), type: 'claude-code', name: 'Claude Code', workingDirectory: '', envVars: {}, claudeSettingsJson: this.getClaudeSettingsTemplate(), codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: '', createdAt: now, updatedAt: now },
      { id: uuidv4(), type: 'codex', name: 'Codex', workingDirectory: '', envVars: {}, claudeSettingsJson: '', codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: '', createdAt: now, updatedAt: now },
      { id: uuidv4(), type: 'opencode', name: 'OpenCode', workingDirectory: '', envVars: {}, claudeSettingsJson: '', codexConfigToml: '', codexAuthJson: '', opencodeConfigJson: this.getOpenCodeConfigTemplate(), createdAt: now, updatedAt: now }
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
        return parsed
      } catch (_) {
        // ignore and keep trying
      }
    }

    return []
  }
}

module.exports = new ConfigManager()

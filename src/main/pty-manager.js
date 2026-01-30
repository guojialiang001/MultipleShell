const pty = require('node-pty')
const { v4: uuidv4 } = require('uuid')
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const shellMonitor = require('./shell-monitor')

const OPENCODE_CONFIG_TEMPLATE = '{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": {\n    "edit": "ask",\n    "bash": "ask",\n    "webfetch": "allow"\n  }\n}\n'
const PROMPT_MARKER = '__MPS_PROMPT__'

class PTYManager {
  constructor() {
    this.sessions = new Map()
    this.codexTempHomes = new Map()
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
      if (configToml.trim()) {
        fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml, 'utf8')
      }
      if (authJson.trim()) {
        fs.writeFileSync(path.join(codexHome, 'auth.json'), authJson, 'utf8')
      }
      this.codexTempHomes.set(sessionId, codexHome)
      return codexHome
    } catch (_) {
      try {
        if (process.env.MPS_KEEP_CODEX_HOME !== '1') fs.rmSync(codexHome, { recursive: true, force: true })
      } catch (_) {}
      return null
    }
  }

  cleanupCodexHome(sessionId) {
    const home = this.codexTempHomes.get(sessionId)
    if (!home) return
    this.codexTempHomes.delete(sessionId)
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

    const profileHome = path.join(app.getPath('userData'), 'opencode-homes', id)
    try {
      fs.mkdirSync(profileHome, { recursive: true })
      const configPath = path.join(profileHome, 'opencode.json')
      fs.writeFileSync(configPath, payload, 'utf8')
      return configPath
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
  
  createSession(config, workingDir, mainWindow) {
    const sessionId = uuidv4()
    const type = typeof config?.type === 'string' ? config.type : ''
    const isCodex = type === 'codex'
    const isClaudeCode = type === 'claude-code'
    const cfgEnv = (isCodex || isClaudeCode) ? {} : this.normalizeEnvObject(config?.envVars)

    // Working directory is selected only when creating a new tab/session.
    // Do not persist/associate it with the template/profile itself.
    const cwd = workingDir || process.env.USERPROFILE

    // Only inject environment variables into the PowerShell session (per-process).
    // Source of truth is the user config JSON's env (stored as config.envVars).
    const codexTempEnv = this.extractCodexTempEnvVars(config)
    const env = { ...process.env, ...cfgEnv, ...codexTempEnv }

    const claudeProfileHome = this.syncClaudeProfileFiles(config)
    if (claudeProfileHome) {
      env.CLAUDE_CONFIG_DIR = claudeProfileHome
    }

    const opencodeConfigPath = this.syncOpenCodeProfileFiles(config)
    if (opencodeConfigPath) {
      env.OPENCODE_CONFIG = opencodeConfigPath
    }

    // Codex: create an isolated CODEX_HOME with per-template config.toml/auth.json,
    // then inject CODEX_HOME as a process-scoped env var (temporary, per session).
    const profileHome = this.syncCodexProfileFiles(config)
    const codexHome = this.ensureCodexHome(sessionId, config)
    let psArgs = []
    let psStartupCmd = ''
    if (codexHome) {
      const configId = typeof config?.id === 'string' ? config.id.trim() : ''
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
      if (!mainWindow || mainWindow.isDestroyed()) return
      const contents = mainWindow.webContents
      if (!contents || contents.isDestroyed()) return
      contents.send(channel, payload)
    }

    const ptyProcess = pty.spawn('powershell.exe', psArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: cwd,
      env: env
    })

    shellMonitor.registerSession(sessionId, type, {
      configName: typeof config?.name === 'string' ? config.name : '',
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
      this.sessions.delete(sessionId)
    })
    
    this.sessions.set(sessionId, ptyProcess)

    // Env vars are already injected via pty.spawn(..., env). For non-Codex profiles we also
    // mirror them via SetEnvironmentVariable so they're guaranteed to be visible in-session.
    // For Codex we avoid echoing a long "set env" command that confuses users.
    if (!isCodex && !isClaudeCode) {
      this.applyEnvInPowerShellSession(ptyProcess, { ...cfgEnv }, config?.name || '')
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
    shellMonitor.unregisterSession(sessionId)
  }
  
  killAllSessions() {
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        session.kill()
      } catch (_) {}
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

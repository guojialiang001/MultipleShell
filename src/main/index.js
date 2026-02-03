const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, shell } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')
const builtInConfig = require('./built-in-config-manager')
const configManager = require('./config-manager')
const ccSwitch = require('./ccswitch')
const draftManager = require('./draft-manager')
const ptyManager = require('./pty-manager')
const shellMonitor = require('./shell-monitor')
const { initAgent } = require('./agent')


let mainWindow
let selectFolderPromise
let monitorTickInterval = null
let agent = null
let agentInitPromise = null
let clientUserDataDir = null
let autoUpdater = null

const updateState = {
  state: 'idle',
  version: null,
  progress: null,
  error: null
}
let updaterReady = false
let updateInterval = null

const getAutoUpdater = () => {
  if (autoUpdater) return autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
    return autoUpdater
  } catch (err) {
    console.warn('[mps] Failed to load electron-updater:', err)
    return null
  }
}

const pushUpdateState = (patch = {}) => {
  Object.assign(updateState, patch)
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update:status', updateState)
  }
  if (agent && agent.role === 'host' && typeof agent.broadcast === 'function') {
    agent.broadcast('update.status', updateState)
  }
}

const initAutoUpdater = () => {
  const updateUrl = process.env.MPS_UPDATE_URL
  const allowDev = process.env.MPS_UPDATE_DEV === '1'

  if (!updateUrl) {
    pushUpdateState({ state: 'disabled', error: null })
    return
  }

  if (!app.isPackaged && !allowDev) {
    pushUpdateState({ state: 'disabled', error: null })
    return
  }

  const updater = getAutoUpdater()
  if (!updater) {
    pushUpdateState({ state: 'disabled', error: 'electron-updater unavailable' })
    return
  }

  updaterReady = true
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.setFeedURL({ provider: 'generic', url: updateUrl })

  updater.on('checking-for-update', () => {
    pushUpdateState({ state: 'checking', error: null })
  })

  updater.on('update-available', (info) => {
    pushUpdateState({ state: 'available', version: info?.version || null, error: null })
  })

  updater.on('update-not-available', () => {
    pushUpdateState({ state: 'not-available', error: null })
  })

  updater.on('download-progress', (progress) => {
    const percent = Math.round(progress?.percent || 0)
    pushUpdateState({ state: 'downloading', progress: percent, error: null })
  })

  updater.on('update-downloaded', (info) => {
    pushUpdateState({ state: 'downloaded', version: info?.version || null, error: null })
  })

  updater.on('error', (err) => {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  })

  updater.checkForUpdates().catch((err) => {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  })

  updateInterval = setInterval(() => {
    updater.checkForUpdates().catch(() => {})
  }, 6 * 60 * 60 * 1000)
}

const ensureClientUserData = () => {
  const base =
    String(process.env.LOCALAPPDATA || '').trim() ||
    (() => {
      try {
        return app.getPath('temp')
      } catch (_) {
        return ''
      }
    })() ||
    os.tmpdir()

  const dir = path.join(base, 'MultipleShell', 'clients', String(process.pid))
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (_) {}

  try {
    app.setPath('userData', dir)
  } catch (err) {
    console.warn('[mps] Failed to set client userData:', err)
  }

  return dir
}

const initAgentEarly = () => {
  if (agentInitPromise) return agentInitPromise
  agentInitPromise = (async () => {
    try {
      const instance = await initAgent()
      if (instance.role === 'client') {
        clientUserDataDir = ensureClientUserData()
      }
      agent = instance
      return instance
    } catch (err) {
      console.warn('[mps] initAgent failed, falling back to standalone host mode:', err)
      agent = { role: 'host', broadcast: () => {}, setRequestHandler: () => {}, onNotification: () => {} }
      return agent
    }
  })()
  return agentInitPromise
}

const transcribeAudio = async ({ audioData, format = 'webm' }) => {
  if (!audioData) {
    throw new Error('Invalid audioData')
  }
  if (format && !/^[a-z0-9]+$/.test(format)) {
    throw new Error('Invalid format')
  }

  const apiKey = builtInConfig.getVoiceApiKey()
  if (!apiKey) {
    throw new Error('API密钥未配置')
  }

  const buffer = Buffer.isBuffer(audioData)
    ? audioData
    : Array.isArray(audioData)
    ? Buffer.from(audioData)
    : Buffer.from(audioData)

  const boundary = '----' + Math.random().toString(36).substring(2)
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`
    ),
    buffer,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nFunAudioLLM/SenseVoiceSmall\r\n--${boundary}--\r\n`
    )
  ]
  const body = Buffer.concat(parts)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.siliconflow.cn',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            res.statusCode === 200 ? resolve(parsed) : reject(new Error(parsed.message || data))
          } catch {
            reject(new Error(data))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: true,
    icon: path.join(__dirname, '../../build/icon.ico'),
    resizable: true,
    maximizable: true,
    minimizable: true,       // 保留最小化
    fullscreenable: false,   // 禁止全屏
    center: true,           // 居中显示
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.setMenuBarVisibility(false)

  const session = mainWindow.webContents.session
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'microphone') {
      callback(true)
      return
    }
    if (permission !== 'media') {
      callback(false)
      return
    }

    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
    const mediaType = details?.mediaType
    const wantsVideo = mediaTypes.includes('video') || mediaType === 'video'
    const wantsAudio = mediaTypes.includes('audio') || mediaType === 'audio' || (!mediaTypes.length && !mediaType)
    callback(wantsAudio && !wantsVideo)
  })

  session.setPermissionCheckHandler((webContents, permission, origin, details) => {
    if (permission === 'microphone') return true
    if (permission !== 'media') return false
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
    const mediaType = details?.mediaType
    const wantsVideo = mediaTypes.includes('video') || mediaType === 'video'
    const wantsAudio = mediaTypes.includes('audio') || mediaType === 'audio' || (!mediaTypes.length && !mediaType)
    return wantsAudio && !wantsVideo
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools()
    }
  })
}

const sendToRenderer = (channel, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const contents = mainWindow.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send(channel, payload)
}

const sessionRegistry = new Map()
const getSessionsList = () =>
  Array.from(sessionRegistry.values()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))

const broadcastSessionsChanged = () => {
  const list = getSessionsList()
  sendToRenderer('sessions:changed', list)
  if (agent && agent.role === 'host') {
    agent.broadcast('sessions.changed', list)
  }
}

const forwardHostNotification = (method, params) => {
  if (method === 'terminal.data') return sendToRenderer('terminal:data', params)
  if (method === 'terminal.exit') return sendToRenderer('terminal:exit', params)
  if (method === 'sessions.changed') return sendToRenderer('sessions:changed', params)
  if (method === 'monitor.update') return sendToRenderer('monitor:update', params)
  if (method === 'update.status') return sendToRenderer('update:status', params)
}

const sendFromHostPty = (channel, payload) => {
  // Host instance also has a local UI.
  sendToRenderer(channel, payload)

  if (agent && agent.role === 'host') {
    if (channel === 'terminal:data') agent.broadcast('terminal.data', payload)
    if (channel === 'terminal:exit') agent.broadcast('terminal.exit', payload)
  }

  if (channel === 'terminal:exit') {
    const sid = payload?.sessionId
    if (typeof sid === 'string' && sid) {
      if (sessionRegistry.delete(sid)) broadcastSessionsChanged()
    }
  }
}

shellMonitor.on('update', (payload) => {
  sendToRenderer('monitor:update', payload)
  if (agent && agent.role === 'host') {
    agent.broadcast('monitor.update', payload)
  }
})

// Phase 4: elect Host/Client role before app.whenReady() so a Client can switch its Chromium
// profile directory early (avoids concurrent access to the Host profile).
initAgentEarly().catch(() => {})

app.whenReady().then(async () => {
  await initAgentEarly()

  if (agent.role === 'host' && typeof agent.setRequestHandler === 'function') {
    agent.setRequestHandler(async (method, params) => {
      if (method === 'terminal.create') {
        const config = params?.config
        const workingDir = typeof params?.workingDir === 'string' ? params.workingDir : ''
        if (!config || typeof config !== 'object') throw new Error('Invalid config')

        const sessionId = await ptyManager.createSession(config, workingDir, sendFromHostPty)
        sessionRegistry.set(sessionId, {
          sessionId,
          title: typeof config?.name === 'string' ? config.name : 'Unnamed',
          config: {
            id: typeof config?.id === 'string' ? config.id : '',
            type: typeof config?.type === 'string' ? config.type : '',
            name: typeof config?.name === 'string' ? config.name : ''
          },
          workingDir: workingDir || '',
          createdAt: new Date().toISOString()
        })
        broadcastSessionsChanged()
        return sessionId
      }

      if (method === 'terminal.write') {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
        const data = typeof params?.data === 'string' ? params.data : ''
        if (!sessionId.trim()) throw new Error('Invalid sessionId')
        if (data.length > 1024 * 1024) throw new Error('Data too large')
        shellMonitor.onUserInput(sessionId, data)
        ptyManager.writeToSession(sessionId, data)
        return true
      }

      if (method === 'terminal.resize') {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
        const cols = params?.cols
        const rows = params?.rows
        if (!sessionId.trim()) throw new Error('Invalid sessionId')
        if (!Number.isInteger(cols) || cols < 1 || cols > 1000) throw new Error('Invalid cols')
        if (!Number.isInteger(rows) || rows < 1 || rows > 1000) throw new Error('Invalid rows')
        ptyManager.resizeSession(sessionId, cols, rows)
        return true
      }

      if (method === 'terminal.kill') {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
        if (!sessionId.trim()) throw new Error('Invalid sessionId')
        ptyManager.killSession(sessionId)
        if (sessionRegistry.delete(sessionId)) broadcastSessionsChanged()
        return true
      }

      if (method === 'sessions.list') return getSessionsList()
      if (method === 'monitor.getStates') return shellMonitor.getAllStates()

      if (method === 'configs.list') return configManager.loadConfigs()
      if (method === 'configs.save') {
        const config = params?.config
        if (!config || typeof config !== 'object') throw new Error('Invalid config')
        return configManager.saveConfig(config)
      }
      if (method === 'configs.delete') {
        const configId = typeof params?.configId === 'string' ? params.configId : ''
        if (!configId.trim()) throw new Error('Invalid configId')
        return configManager.deleteConfig(configId)
      }

      if (method === 'ccswitch.providers.list') return ccSwitch.listProviders()
      if (method === 'ccswitch.providers.import') return ccSwitch.importProviders(configManager)
      if (method === 'ccswitch.requests.tail') return ccSwitch.tailRequestPaths(params || {})

      if (method === 'drafts.load') return draftManager.loadDraft(params?.key)
      if (method === 'drafts.save') return draftManager.saveDraft(params?.key, params?.value)
      if (method === 'drafts.delete') return draftManager.deleteDraft(params?.key)

      if (method === 'update.getStatus') return updateState
      if (method === 'update.check') {
        const updater = getAutoUpdater()
        if (!updaterReady) return updateState
        if (!updater) return updateState
        try {
          await updater.checkForUpdates()
        } catch (err) {
          pushUpdateState({ state: 'error', error: err?.message || String(err) })
        }
        return updateState
      }
      if (method === 'update.quitAndInstall') {
        const updater = getAutoUpdater()
        if (!updaterReady) return false
        if (!updater) return false
        updater.quitAndInstall()
        return true
      }

      if (method === 'voice.getApiKey') return builtInConfig.getVoiceApiKey()
      if (method === 'voice.setApiKey') {
        const key = params?.key
        if (typeof key !== 'string') throw new Error('Invalid API key')
        builtInConfig.setVoiceApiKey(key)
        return { success: true }
      }
      if (method === 'voice.transcribe') {
        return transcribeAudio(params || {})
      }

      if (method === 'remote.applyRdpConfig') {
        return applyRdpConfig(params || {})
      }

      throw new Error(`Unknown method: ${method}`)
    })
  }
  if (agent.role === 'client') {
    agent.onNotification((method, params) => forwardHostNotification(method, params))
  }

  // Only the Host process should touch shared temp dirs (e.g. Codex CODEX_HOME staging)
  // otherwise a Client could delete directories still in use by the Host.
  if (agent.role === 'host') {
    ptyManager.cleanupOrphanedTempDirs()
  }

  if (agent.role === 'host') {
    configManager.loadConfigs()
  }
  Menu.setApplicationMenu(null)
  createWindow()

  // When running multi-instance, only Host should perform "side-effect" background work.
  if (agent.role === 'host') {
    initAutoUpdater()
    monitorTickInterval = setInterval(() => {
      shellMonitor.tick()
    }, 1000)
  }

  // Send initial sessions list to renderer (Host has state; Client will call sessions:list).
  if (agent.role === 'host') {
    broadcastSessionsChanged()
  }
})

app.on('window-all-closed', () => {
  if (agent && agent.role === 'host') {
    ptyManager.killAllSessions()
    sessionRegistry.clear()
    broadcastSessionsChanged()
    if (monitorTickInterval) {
      clearInterval(monitorTickInterval)
      monitorTickInterval = null
    }
  }
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('get-configs', () => {
  if (agent && agent.role === 'client') return agent.call('configs.list', {})
  return configManager.loadConfigs()
})

ipcMain.handle('save-config', (event, config) => {
  if (agent && agent.role === 'client') return agent.call('configs.save', { config })
  return configManager.saveConfig(config)
})

ipcMain.handle('delete-config', (event, configId) => {
  if (agent && agent.role === 'client') return agent.call('configs.delete', { configId })
  return configManager.deleteConfig(configId)
})

ipcMain.handle('ccswitch:listProviders', async () => {
  if (agent && agent.role === 'client') return agent.call('ccswitch.providers.list', {})
  return ccSwitch.listProviders()
})

ipcMain.handle('ccswitch:detect', async () => {
  if (agent && agent.role === 'client') {
    try {
      await agent.call('ccswitch.providers.list', {})
      return { exists: true }
    } catch (err) {
      return { exists: false, reason: 'REMOTE_ERROR', message: err?.message ? String(err.message) : String(err || '') }
    }
  }
  return ccSwitch.detect()
})

ipcMain.handle('claude:checkClaudeJsonLink', async () => {
  const result = { supported: false, method: null, error: null }
  const tmpRoot = os.tmpdir()
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, 'mps-claude-link-'))
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'ok\n', 'utf8')

    // Prefer hardlink (no admin required). If it fails, try symlink.
    try {
      const hard = path.join(dir, 'hard.txt')
      fs.linkSync(target, hard)
      result.supported = true
      result.method = 'hardlink'
      return result
    } catch (_) {}

    try {
      const sym = path.join(dir, 'sym.txt')
      fs.symlinkSync(target, sym, 'file')
      result.supported = true
      result.method = 'symlink'
      return result
    } catch (err) {
      result.supported = false
      result.method = null
      result.error = err?.message ? String(err.message) : String(err || 'unknown error')
      return result
    }
  } catch (err) {
    result.supported = false
    result.method = null
    result.error = err?.message ? String(err.message) : String(err || 'unknown error')
    return result
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (_) {}
    }
  }
})

ipcMain.handle('ccswitch:importProviders', async () => {
  if (agent && agent.role === 'client') return agent.call('ccswitch.providers.import', {})
  return ccSwitch.importProviders(configManager)
})

ipcMain.handle('ccswitch:tailRequestPaths', async (_event, payload) => {
  if (agent && agent.role === 'client') return agent.call('ccswitch.requests.tail', payload || {})
  return ccSwitch.tailRequestPaths(payload || {})
})

ipcMain.handle('create-terminal', async (event, config, workingDir) => {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid config')
  }
  if (workingDir && typeof workingDir !== 'string') {
    throw new Error('Invalid workingDir')
  }

  if (agent && agent.role === 'client') {
    return agent.call('terminal.create', { config, workingDir: workingDir || '' })
  }

  const sessionId = await ptyManager.createSession(config, workingDir, sendFromHostPty)
  sessionRegistry.set(sessionId, {
    sessionId,
    title: typeof config?.name === 'string' ? config.name : 'Unnamed',
    config: {
      id: typeof config?.id === 'string' ? config.id : '',
      type: typeof config?.type === 'string' ? config.type : '',
      name: typeof config?.name === 'string' ? config.name : ''
    },
    workingDir: workingDir || '',
    createdAt: new Date().toISOString()
  })
  broadcastSessionsChanged()
  return sessionId
})

ipcMain.handle('write-terminal', (event, sessionId, data) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Invalid sessionId')
  }
  if (typeof data !== 'string') {
    throw new Error('Invalid data')
  }
  if (data.length > 1024 * 1024) {
    throw new Error('Data too large')
  }

  if (agent && agent.role === 'client') {
    return agent.call('terminal.write', { sessionId, data })
  }

  shellMonitor.onUserInput(sessionId, data)
  ptyManager.writeToSession(sessionId, data)
})

ipcMain.handle('resize-terminal', (event, sessionId, cols, rows) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Invalid sessionId')
  }
  if (!Number.isInteger(cols) || cols < 1 || cols > 1000) {
    throw new Error('Invalid cols')
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 1000) {
    throw new Error('Invalid rows')
  }

  if (agent && agent.role === 'client') {
    return agent.call('terminal.resize', { sessionId, cols, rows })
  }

  ptyManager.resizeSession(sessionId, cols, rows)
})

ipcMain.handle('kill-terminal', (event, sessionId) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Invalid sessionId')
  }

  if (agent && agent.role === 'client') {
    return agent.call('terminal.kill', { sessionId })
  }

  ptyManager.killSession(sessionId)
  if (sessionRegistry.delete(sessionId)) broadcastSessionsChanged()
})

ipcMain.handle('monitor:getStates', () => {
  if (agent && agent.role === 'client') return agent.call('monitor.getStates', {})
  return shellMonitor.getAllStates()
})

ipcMain.handle('sessions:list', () => {
  if (agent && agent.role === 'client') return agent.call('sessions.list', {})
  return getSessionsList()
})

const FORBIDDEN_PATHS = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files',
  'C:\\Program Files (x86)'
]

function isPathSafe(selectedPath) {
  if (!selectedPath) return false
  const normalized = path.normalize(selectedPath).toLowerCase()
  return !FORBIDDEN_PATHS.some(forbidden =>
    normalized.startsWith(path.normalize(forbidden).toLowerCase())
  )
}

ipcMain.handle('select-folder', async () => {
  if (selectFolderPromise) {
    const result = await selectFolderPromise
    return result.canceled ? null : result.filePaths[0]
  }
  selectFolderPromise = dialog.showOpenDialog({ properties: ['openDirectory'] })
  try {
    const result = await selectFolderPromise
    if (!result.canceled && result.filePaths[0]) {
      const selectedPath = result.filePaths[0]
      if (!isPathSafe(selectedPath)) {
        dialog.showErrorBox('路径不安全', '不允许选择系统目录')
        return null
      }
      return selectedPath
    }
    return null
  } finally {
    selectFolderPromise = null
  }
})

ipcMain.handle('get-default-cwd', () => {
  return process.env.USERPROFILE || ''
})

ipcMain.handle('app:getVersion', () => app.getVersion())

ipcMain.handle('update:getStatus', () => {
  if (agent && agent.role === 'client') return agent.call('update.getStatus', {})
  return updateState
})

ipcMain.handle('update:check', async () => {
  if (agent && agent.role === 'client') return agent.call('update.check', {})
  if (!updaterReady) return updateState
  const updater = getAutoUpdater()
  if (!updater) return updateState
  try {
    await updater.checkForUpdates()
  } catch (err) {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  }
  return updateState
})

ipcMain.handle('update:quitAndInstall', () => {
  if (agent && agent.role === 'client') return agent.call('update.quitAndInstall', {})
  if (!updaterReady) return false
  const updater = getAutoUpdater()
  if (!updater) return false
  updater.quitAndInstall()
  return true
})

ipcMain.handle('voice:getApiKey', () => {
  if (agent && agent.role === 'client') return agent.call('voice.getApiKey', {})
  return builtInConfig.getVoiceApiKey()
})

ipcMain.handle('voice:setApiKey', (_, key) => {
  if (agent && agent.role === 'client') return agent.call('voice.setApiKey', { key })
  if (typeof key !== 'string') {
    throw new Error('Invalid API key')
  }
  builtInConfig.setVoiceApiKey(key)
  return { success: true }
})

ipcMain.handle('voice:transcribe', async (_, payload) => {
  if (agent && agent.role === 'client') return agent.call('voice.transcribe', payload || {})
  return transcribeAudio(payload || {})
})

ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})

ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close()
})

ipcMain.handle('clipboard:writeText', (event, text) => {
  clipboard.writeText(text == null ? '' : String(text))
  return true
})

ipcMain.handle('clipboard:readText', () => {
  return clipboard.readText()
})

ipcMain.handle('shell:openExternal', async (event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Invalid url')
  }
  if (url.length > 4096) {
    throw new Error('URL too long')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch (_) {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported protocol')
  }

  await shell.openExternal(url)
  return true
  })

const runPowerShell = (scriptText) =>
  new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptText], {
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      const message = (stderr || stdout || '').trim() || `PowerShell exited with code ${code}`
      const err = new Error(message)
      err.code = code
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    })
  })

const resolveRemoteAppExePath = () => {
  const override = String(process.env.MPS_REMOTEAPP_EXE_PATH ?? '').trim()
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`MPS_REMOTEAPP_EXE_PATH not found: ${override}`)
    }
    return override
  }

  const currentExe = String(app.getPath('exe') ?? '').trim()

  // Packaged app: use the real installed executable path.
  if (app.isPackaged) return currentExe

  // Dev mode: avoid registering "electron.exe", which will show "electron.exe path-to-app".
  const exeName = path.basename(currentExe).toLowerCase()
  if (exeName !== 'electron.exe') return currentExe

  const repoRoot = path.resolve(__dirname, '../..')
  const productExe = 'MultipleShell.exe'

  const candidates = []

  // 1) Prefer the unpacked build output when developing (matches the current repo code/version).
  const archFolder = process.arch === 'ia32' ? 'ia32' : process.arch === 'arm64' ? 'arm64' : 'x64'
  candidates.push(path.join(repoRoot, 'release', archFolder, 'win-unpacked', productExe))

  try {
    const releaseDir = path.join(repoRoot, 'release')
    const entries = fs.readdirSync(releaseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      candidates.push(path.join(releaseDir, entry.name, 'win-unpacked', productExe))
    }
  } catch (_) {}

  // 2) Fall back to common install locations (in case you're running dev but have installed the app).
  const localAppData = String(process.env.LOCALAPPDATA ?? '').trim()
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'MultipleShell', productExe))
  }

  const programFiles = String(process.env.ProgramFiles ?? '').trim()
  if (programFiles) {
    candidates.push(path.join(programFiles, 'MultipleShell', productExe))
  }

  const programFilesX86 = String(process.env['ProgramFiles(x86)'] ?? '').trim()
  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, 'MultipleShell', productExe))
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }

  throw new Error(
    'Cannot resolve MultipleShell.exe for RemoteApp registration. Build (release/*/win-unpacked), install the app, or set MPS_REMOTEAPP_EXE_PATH.'
  )
}

ipcMain.handle('app:getInstanceCount', async () => {
  if (process.platform !== 'win32') return 1

  const exeName = 'MultipleShell.exe'
  const script = `
$ErrorActionPreference = "Stop"
$exe = "${exeName}"

$procs = @()
try {
  $procs = Get-CimInstance Win32_Process -Filter ("Name='" + $exe + "'") -ErrorAction SilentlyContinue
} catch {
  $procs = @()
}

if (-not $procs) {
  Write-Output 0
  exit 0
}

# One Electron app instance roughly maps to one "browser" (main) process which does not have --type=...
$mainCount = ($procs | Where-Object { $_.CommandLine -notmatch "--type=" } | Measure-Object).Count
Write-Output $mainCount
`

  try {
    const { stdout } = await runPowerShell(script)
    const raw = String(stdout || '').trim()
    const count = Number.parseInt(raw, 10)
    return Number.isFinite(count) ? count : 0
  } catch (err) {
    console.warn('[mps] app:getInstanceCount failed', err)
    return 0
  }
})

const applyRdpConfig = async (payload) => {
  if (process.platform !== 'win32') {
    throw new Error('RDP config is only supported on Windows')
  }

  const port = Number.parseInt(String(payload?.systemRdpPort ?? ''), 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Invalid systemRdpPort')
  }

  const remoteAppAlias = 'MultipleShell'
  const exePath = resolveRemoteAppExePath()
  const psPayload = { port, alias: remoteAppAlias, exePath }
  const psJson = JSON.stringify(psPayload).replace(/'/g, "''")

  const script = `
$ErrorActionPreference = "Stop"
$payload = '${psJson}' | ConvertFrom-Json
$port = [int]$payload.port
$alias = [string]$payload.alias
$exePath = [string]$payload.exePath

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run MultipleShell as Administrator to apply RDP config."
}

function Set-RegistryDword {
  Param([string]$Path,[string]$Name,[int]$Value)
  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
}

function Set-RegistryString {
  Param([string]$Path,[string]$Name,[string]$Value)
  New-ItemProperty -Path $Path -Name $Name -PropertyType String -Value $Value -Force | Out-Null
}

# Enable RDP + NLA
Set-RegistryDword -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0
Set-RegistryDword -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name "UserAuthentication" -Value 1

# Windows Firewall: inbound TCP
if (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue) {
  $ruleName = "MultipleShell-RDP-" + $port
  $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-NetFirewallRule -Name $ruleName -DisplayName ("MultipleShell RDP (TCP " + $port + ")") -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort $port -Profile Any | Out-Null
  }
}

# RemoteApp allow list (mstsc: remoteapplicationprogram:s:||<alias>)
$base = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Terminal Server\\TSAppAllowList"
if (-not (Test-Path -LiteralPath $base)) { New-Item -Path $base -Force | Out-Null }
Set-RegistryDword -Path $base -Name "fDisabledAllowList" -Value 0

$appsKey = Join-Path $base "Applications"
if (-not (Test-Path -LiteralPath $appsKey)) { New-Item -Path $appsKey -Force | Out-Null }

$appKey = Join-Path $appsKey $alias
if (-not (Test-Path -LiteralPath $appKey)) { New-Item -Path $appKey -Force | Out-Null }

Set-RegistryString -Path $appKey -Name "Name" -Value $alias
Set-RegistryString -Path $appKey -Name "Path" -Value $exePath
Set-RegistryString -Path $appKey -Name "IconPath" -Value $exePath
Set-RegistryDword -Path $appKey -Name "IconIndex" -Value 0
Set-RegistryDword -Path $appKey -Name "ShowInTSWA" -Value 1
Set-RegistryDword -Path $appKey -Name "CommandLineSetting" -Value 0
Set-RegistryString -Path $appKey -Name "RequiredCommandLine" -Value ""
`

  await runPowerShell(script)
  return { ok: true, port, alias: remoteAppAlias, exePath }
}

ipcMain.handle('remote:applyRdpConfig', async (event, payload) => {
  if (agent && agent.role === 'client') {
    return agent.call('remote.applyRdpConfig', payload || {})
  }
  return applyRdpConfig(payload || {})
})

ipcMain.handle('draft:load', (event, key) => {
  if (agent && agent.role === 'client') return agent.call('drafts.load', { key })
  return draftManager.loadDraft(key)
})

ipcMain.handle('draft:save', (event, key, value) => {
  if (agent && agent.role === 'client') return agent.call('drafts.save', { key, value })
  return draftManager.saveDraft(key, value)
})

ipcMain.handle('draft:delete', (event, key) => {
  if (agent && agent.role === 'client') return agent.call('drafts.delete', { key })
  return draftManager.deleteDraft(key)
})


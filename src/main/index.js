const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const configManager = require('./config-manager')
const draftManager = require('./draft-manager')
const ptyManager = require('./pty-manager')
const voiceService = require('./voice-service')


let mainWindow
let selectFolderPromise

const updateState = {
  state: 'idle',
  version: null,
  progress: null,
  error: null
}
let updaterReady = false
let updateInterval = null

const pushUpdateState = (patch = {}) => {
  Object.assign(updateState, patch)
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update:status', updateState)
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

  updaterReady = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl })

  autoUpdater.on('checking-for-update', () => {
    pushUpdateState({ state: 'checking', error: null })
  })

  autoUpdater.on('update-available', (info) => {
    pushUpdateState({ state: 'available', version: info?.version || null, error: null })
  })

  autoUpdater.on('update-not-available', () => {
    pushUpdateState({ state: 'not-available', error: null })
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress?.percent || 0)
    pushUpdateState({ state: 'downloading', progress: percent, error: null })
  })

  autoUpdater.on('update-downloaded', (info) => {
    pushUpdateState({ state: 'downloaded', version: info?.version || null, error: null })
  })

  autoUpdater.on('error', (err) => {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  })

  autoUpdater.checkForUpdates().catch((err) => {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  })

  updateInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 6 * 60 * 60 * 1000)
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

app.whenReady().then(() => {
  ptyManager.cleanupOrphanedTempDirs()
  configManager.loadConfigs()
  Menu.setApplicationMenu(null)
  createWindow()
  initAutoUpdater()
})

app.on('window-all-closed', () => {
  ptyManager.killAllSessions()
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('get-configs', () => configManager.loadConfigs())

ipcMain.handle('save-config', (event, config) => configManager.saveConfig(config))

ipcMain.handle('delete-config', (event, configId) => configManager.deleteConfig(configId))

ipcMain.handle('create-terminal', (event, config, workingDir) => {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid config')
  }
  if (workingDir && typeof workingDir !== 'string') {
    throw new Error('Invalid workingDir')
  }
  return ptyManager.createSession(config, workingDir, mainWindow)
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
  ptyManager.resizeSession(sessionId, cols, rows)
})

ipcMain.handle('kill-terminal', (event, sessionId) => {
  ptyManager.killSession(sessionId)
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

ipcMain.handle('update:getStatus', () => updateState)

ipcMain.handle('update:check', async () => {
  if (!updaterReady) return updateState
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    pushUpdateState({ state: 'error', error: err?.message || String(err) })
  }
  return updateState
})

ipcMain.handle('update:quitAndInstall', () => {
  if (!updaterReady) return false
  autoUpdater.quitAndInstall()
  return true
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

ipcMain.handle('draft:load', (event, key) => {
  return draftManager.loadDraft(key)
})

ipcMain.handle('draft:save', (event, key, value) => {
  return draftManager.saveDraft(key, value)
})

ipcMain.handle('draft:delete', (event, key) => {
  return draftManager.deleteDraft(key)
})


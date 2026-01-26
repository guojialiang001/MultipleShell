const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu } = require('electron')
const path = require('path')
const configManager = require('./config-manager')
const draftManager = require('./draft-manager')
const ptyManager = require('./pty-manager')

const TRANSCRIPTION_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions'
const TRANSCRIPTION_TOKEN = 'sk-yyqmrkevamdfuilmfdlfmjzuatoytqlywfalkjkfrzkffvdr'
const TRANSCRIPTION_MODEL = 'FunAudioLLM/SenseVoiceSmall'

let mainWindow
let selectFolderPromise

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
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
      nodeIntegration: false
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
  configManager.loadConfigs()
  Menu.setApplicationMenu(null)
  createWindow()
})

app.on('window-all-closed', () => {
  ptyManager.killAllSessions()
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('get-configs', () => configManager.loadConfigs())

ipcMain.handle('save-config', (event, config) => configManager.saveConfig(config))

ipcMain.handle('delete-config', (event, configId) => configManager.deleteConfig(configId))

ipcMain.handle('create-terminal', (event, config, workingDir) => {
  return ptyManager.createSession(config, workingDir, mainWindow)
})

ipcMain.handle('write-terminal', (event, sessionId, data) => {
  ptyManager.writeToSession(sessionId, data)
})

ipcMain.handle('resize-terminal', (event, sessionId, cols, rows) => {
  ptyManager.resizeSession(sessionId, cols, rows)
})

ipcMain.handle('kill-terminal', (event, sessionId) => {
  ptyManager.killSession(sessionId)
})

ipcMain.handle('select-folder', async () => {
  if (selectFolderPromise) {
    const result = await selectFolderPromise
    return result.canceled ? null : result.filePaths[0]
  }
  selectFolderPromise = dialog.showOpenDialog({ properties: ['openDirectory'] })
  try {
    const result = await selectFolderPromise
    return result.canceled ? null : result.filePaths[0]
  } finally {
    selectFolderPromise = null
  }
})

ipcMain.handle('get-default-cwd', () => {
  return process.env.USERPROFILE || ''
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

ipcMain.handle('audio:transcribe', async (event, payload) => {
  const audioBuffer = payload?.audioBuffer
  if (!audioBuffer) {
    throw new Error('Missing audio buffer')
  }

  const fileName = payload?.fileName || 'voice.wav'
  const mimeType = payload?.mimeType || 'application/octet-stream'
  const model = payload?.model || TRANSCRIPTION_MODEL

  if (typeof fetch !== 'function') {
    throw new Error('Fetch API unavailable')
  }
  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    throw new Error('FormData API unavailable')
  }

  const buffer = Buffer.from(audioBuffer)
  const form = new FormData()
  const blob = new Blob([buffer], { type: mimeType })
  form.append('file', blob, fileName)
  form.append('model', model)

  const response = await fetch(TRANSCRIPTION_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TRANSCRIPTION_TOKEN}`,
      Accept: '*/*',
      'User-Agent': 'Apifox/1.0.0 (https://apifox.com)'
    },
    body: form
  })

  const raw = await response.text()
  let data = null
  try {
    data = JSON.parse(raw)
  } catch (_) {
    data = { text: raw }
  }

  if (!response.ok) {
    const message = data?.message || data?.error || raw || `HTTP ${response.status}`
    throw new Error(message)
  }

  return data
})

const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const configManager = require('./config-manager')
const draftManager = require('./draft-manager')
const ptyManager = require('./pty-manager')
const shellMonitor = require('./shell-monitor')
const voiceService = require('./voice-service')


let mainWindow
let selectFolderPromise
let monitorTickInterval = null

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

shellMonitor.on('update', (payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const contents = mainWindow.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send('monitor:update', payload)
})

app.whenReady().then(() => {
  ptyManager.cleanupOrphanedTempDirs()
  configManager.loadConfigs()
  Menu.setApplicationMenu(null)
  createWindow()
  initAutoUpdater()

  monitorTickInterval = setInterval(() => {
    shellMonitor.tick()
  }, 1000)
})

app.on('window-all-closed', () => {
  ptyManager.killAllSessions()
  if (monitorTickInterval) {
    clearInterval(monitorTickInterval)
    monitorTickInterval = null
  }
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
  ptyManager.resizeSession(sessionId, cols, rows)
})

ipcMain.handle('kill-terminal', (event, sessionId) => {
  ptyManager.killSession(sessionId)
})

ipcMain.handle('monitor:getStates', () => shellMonitor.getAllStates())

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

ipcMain.handle('remote:applyRdpConfig', async (event, payload) => {
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


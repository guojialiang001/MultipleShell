const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getConfigs: () => ipcRenderer.invoke('get-configs'),
  ccSwitchListProviders: () => ipcRenderer.invoke('ccswitch:listProviders'),
  ccSwitchImportProviders: () => ipcRenderer.invoke('ccswitch:importProviders'),
  ccSwitchTailRequestPaths: (payload) => ipcRenderer.invoke('ccswitch:tailRequestPaths', payload),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  deleteConfig: (configId) => ipcRenderer.invoke('delete-config', configId),
  createTerminal: (config, workingDir) => ipcRenderer.invoke('create-terminal', config, workingDir),
  writeToTerminal: (sessionId, data) => ipcRenderer.invoke('write-terminal', sessionId, data),
  resizeTerminal: (sessionId, cols, rows) => ipcRenderer.invoke('resize-terminal', sessionId, cols, rows),
  killTerminal: (sessionId) => ipcRenderer.invoke('kill-terminal', sessionId),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getDefaultCwd: () => ipcRenderer.invoke('get-default-cwd'),
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  appGetInstanceCount: () => ipcRenderer.invoke('app:getInstanceCount'),
  updateGetStatus: () => ipcRenderer.invoke('update:getStatus'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateQuitAndInstall: () => ipcRenderer.invoke('update:quitAndInstall'),
  monitorGetStates: () => ipcRenderer.invoke('monitor:getStates'),
  sessionsList: () => ipcRenderer.invoke('sessions:list'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  remoteApplyRdpConfig: (payload) => ipcRenderer.invoke('remote:applyRdpConfig', payload),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  draftLoad: (key) => ipcRenderer.invoke('draft:load', key),
  draftSave: (key, value) => ipcRenderer.invoke('draft:save', key, value),
  draftDelete: (key) => ipcRenderer.invoke('draft:delete', key),
  voiceGetApiKey: () => ipcRenderer.invoke('voice:getApiKey'),
  voiceSetApiKey: (key) => ipcRenderer.invoke('voice:setApiKey', key),
  voiceTranscribe: (audioData, format) => ipcRenderer.invoke('voice:transcribe', { audioData, format }),
  onTerminalData: (sessionId, callback) => {
    const handler = (event, { sessionId: sid, data }) => {
      if (sid === sessionId) callback(data)
    }
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onUpdateStatus: (callback) => {
    const handler = (event, payload) => callback(payload)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  },
  onMonitorUpdate: (callback) => {
    const handler = (event, payload) => callback(payload)
    ipcRenderer.on('monitor:update', handler)
    return () => ipcRenderer.removeListener('monitor:update', handler)
  },
  onSessionsChanged: (callback) => {
    const handler = (event, payload) => callback(payload)
    ipcRenderer.on('sessions:changed', handler)
    return () => ipcRenderer.removeListener('sessions:changed', handler)
  },

  onTerminalExit: (sessionId, callback) => {
    const handler = (event, { sessionId: sid, code }) => {
      if (sid === sessionId) callback(code)
    }
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  }
})

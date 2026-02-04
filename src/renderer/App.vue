<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import MenuBar from './components/MenuBar.vue'
import TabBar from './components/TabBar.vue'
import Terminal from './components/Terminal.vue'
import ConfigSelector from './components/ConfigSelector.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import RemotePanel from './components/RemotePanel.vue'

const { t } = useI18n()

const UI_MODE_STORAGE_KEY = 'mps.uiMode'
const MONITOR_THUMBNAIL_MODE_KEY = 'mps.monitor.thumbnailMode' // card | terminal

const normalizeMonitorThumbnailMode = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'terminal') return 'terminal'
  return 'card'
}

const readMonitorThumbnailMode = () => {
  try {
    return normalizeMonitorThumbnailMode(localStorage.getItem(MONITOR_THUMBNAIL_MODE_KEY))
  } catch (_) {
    return 'card'
  }
}

const getInitialUiMode = () => {
  try {
    const saved = localStorage.getItem(UI_MODE_STORAGE_KEY)
    if (saved === 'shell' || saved === 'monitor' || saved === 'remote') return saved
  } catch (_) {}
  return 'shell'
}

const tabs = ref([])
const activeTabId = ref(null)
const uiMode = ref(getInitialUiMode()) // shell | monitor
const monitorThumbnailMode = ref(readMonitorThumbnailMode())
const monitorDockOpen = ref(false)
const showConfigSelector = ref(false)
const configSelectorMode = ref('create') // create | manage
const pendingTabId = ref(null)
const pendingCreatedSessionId = ref(null)
const configTemplates = ref([])
const defaultCwd = ref('')
const isVoicePreparing = ref(false)
const isVoiceRecording = ref(false)
const isVoiceTranscribing = ref(false)
const voiceStatus = ref('')
const voiceError = ref('')
let voicePrepareTimer = null
let mediaRecorder = null
let mediaStream = null
let recordedChunks = []
let recordingMimeType = ''
let unsubscribeSessionsChanged = null

const refreshMonitorThumbnailMode = () => {
  monitorThumbnailMode.value = readMonitorThumbnailMode()
}

const handleMonitorSettings = () => {
  refreshMonitorThumbnailMode()
}

const VOICE_ARM_DELAY_MS = 1100
const TRANSCRIPTION_MODEL = 'FunAudioLLM/SenseVoiceSmall'

const activeCwd = computed(() => {
  const tab = tabs.value.find(t => t.id === activeTabId.value)
  const cwd = (tab?.workingDir && String(tab.workingDir)) ? String(tab.workingDir) : ''
  return cwd || defaultCwd.value || t('configSelector.userProfile')
})

const voiceButtonText = computed(() => {
  if (isVoicePreparing.value) return t('voice.cancel')
  if (isVoiceRecording.value) return t('voice.stop')
  if (isVoiceTranscribing.value) return t('voice.processing')
  return t('voice.start')
})

const voiceButtonDisabled = computed(() => {
  if (isVoiceRecording.value || isVoicePreparing.value) return false
  if (isVoiceTranscribing.value) return true
  return !activeTabId.value
})

const closeConfigSelector = () => {
  showConfigSelector.value = false
  if (pendingTabId.value) {
    const idx = tabs.value.findIndex(t => t.id === pendingTabId.value)
    if (idx !== -1) {
      // 记住删除pending标签页之前的活跃标签页
      const wasActivePending = activeTabId.value === pendingTabId.value

      tabs.value.splice(idx, 1)

      // 只有当被删除的pending标签页是当前活跃的时，才需要切换活跃标签页
      if (wasActivePending) {
        // 查找上一个活跃的非pending标签页，如果没有则选择任意一个非pending标签页
        const nonPendingTabs = tabs.value.filter(t => !t.pending)
        if (nonPendingTabs.length > 0) {
          // 选择最后一个非pending标签页（通常是用户之前使用的）
          activeTabId.value = nonPendingTabs[nonPendingTabs.length - 1].id
        } else {
          // 如果完全没有非pending标签页，设置为null
          activeTabId.value = null
        }
      }
      // 如果pending标签页不是当前活跃的，那么activeTabId.value保持不变，不影响用户当前正在使用的标签页
    }
    pendingTabId.value = null
    pendingCreatedSessionId.value = null
  }
}

const normalizeSessionTabs = (sessions) => {
  const list = Array.isArray(sessions) ? sessions : []
  return list.map((s) => ({
    id: s?.sessionId,
    title: s?.title || s?.config?.name || '',
    config: s?.config || {},
    workingDir: s?.workingDir || ''
  })).filter((t) => typeof t.id === 'string' && t.id.trim())
}

const applySessionsToTabs = (sessions) => {
  const sessionTabs = normalizeSessionTabs(sessions)
  const pendingTabs = tabs.value.filter((t) => t && t.pending)

  // Keep session tabs as source of truth; keep local pending placeholders for UX.
  tabs.value = [...sessionTabs, ...pendingTabs]

  // Resolve "pending -> created session" once the Host reports the new session.
  if (pendingTabId.value && pendingCreatedSessionId.value) {
    const sid = pendingCreatedSessionId.value
    if (sessionTabs.some((t) => t.id === sid)) {
      tabs.value = tabs.value.filter((t) => !t.pending)
      activeTabId.value = sid
      pendingTabId.value = null
      pendingCreatedSessionId.value = null
    }
  }

  const hasActive = tabs.value.some((t) => t.id === activeTabId.value)
  if (!hasActive) {
    const firstSession = sessionTabs[0]
    activeTabId.value = firstSession ? firstSession.id : (pendingTabs[0]?.id || null)
  }
}

const createTab = async (config, workingDir) => {
  // Creating a terminal should always return the user to the Shell view.
  // This also avoids accidental mode switches (e.g. Remote) during fast modal close.
  uiMode.value = 'shell'
  monitorDockOpen.value = false
  try {
    localStorage.setItem(UI_MODE_STORAGE_KEY, 'shell')
  } catch (_) {}

  const plainConfig = (() => {
    try { return structuredClone(config) } catch (_) { return JSON.parse(JSON.stringify(config)) }
  })()

  // Ensure we have a local placeholder while the Host creates the real session.
  if (!pendingTabId.value) {
    const tempId = `pending-${Date.now()}`
    tabs.value.push({ id: tempId, titleKey: 'tabs.newTabPlaceholder', pending: true })
    activeTabId.value = tempId
    pendingTabId.value = tempId
  }

  const sessionId = await window.electronAPI.createTerminal(plainConfig, workingDir)
  pendingCreatedSessionId.value = sessionId
  showConfigSelector.value = false

  // Best-effort refresh in case sessions:changed arrives before our listener is ready.
  if (window?.electronAPI?.sessionsList) {
    try {
      const sessions = await window.electronAPI.sessionsList()
      applySessionsToTabs(sessions)
    } catch (_) {}
  }
}

const updateTabConfig = (config) => {
  if (!activeTabId.value) return
  const index = tabs.value.findIndex(t => t.id === activeTabId.value)
  if (index === -1) return
  tabs.value[index].config = { ...config }
  tabs.value[index].title = config.name
}

const loadConfigTemplates = async () => {
  configTemplates.value = await window.electronAPI.getConfigs()
}

const importFromCCSwitch = async () => {
  if (!window?.electronAPI?.ccSwitchImportProviders) return
  try {
    const updated = await window.electronAPI.ccSwitchImportProviders()
    if (Array.isArray(updated)) {
      configTemplates.value = updated
      return
    }
  } catch (err) {
    console.error('[mps] ccSwitchImportProviders failed', err)
  }
  await loadConfigTemplates()
}

const saveConfigTemplate = async (config) => {
  try {
    const updated = await window.electronAPI.saveConfig(config)
    if (Array.isArray(updated)) {
      configTemplates.value = updated
      return
    }
  } catch (err) {
    console.error('[mps] saveConfig failed', err)
  }
  await loadConfigTemplates()
}

const deleteConfigTemplate = async (configId) => {
  await window.electronAPI.deleteConfig(configId)
  await loadConfigTemplates()
}

const newTab = () => {
  const tempId = `pending-${Date.now()}`
  tabs.value.push({ id: tempId, titleKey: 'tabs.newTabPlaceholder', pending: true })
  activeTabId.value = tempId
  pendingTabId.value = tempId
  configSelectorMode.value = 'create'
  showConfigSelector.value = true
}

const openConfigManager = () => {
  configSelectorMode.value = 'manage'
  showConfigSelector.value = true
}

const switchUiMode = (nextMode) => {
  const normalized = nextMode === 'monitor' ? 'monitor' : nextMode === 'remote' ? 'remote' : 'shell'
  if (uiMode.value === normalized) return
  uiMode.value = normalized
  if (normalized !== 'shell') monitorDockOpen.value = false
  try {
    localStorage.setItem(UI_MODE_STORAGE_KEY, normalized)
  } catch (_) {}
  if (normalized === 'shell' || (normalized === 'monitor' && monitorThumbnailMode.value === 'terminal')) {
    nextTick(() => {
      try {
        window.dispatchEvent(new Event('resize'))
      } catch (_) {}
    })
  }
}

const switchConfigMode = (mode) => {
  configSelectorMode.value = mode
  showConfigSelector.value = true
}

const closeTab = async (tabId) => {
  const target = tabs.value.find(t => t.id === tabId)
  if (target?.pending) {
    const index = tabs.value.findIndex(t => t.id === tabId)
    if (index !== -1) tabs.value.splice(index, 1)
    if (pendingTabId.value === tabId) pendingTabId.value = null
    if (pendingTabId.value === null) pendingCreatedSessionId.value = null
    showConfigSelector.value = false
    if (activeTabId.value === tabId) {
      activeTabId.value = tabs.value.length > 0 ? tabs.value[0].id : null
    }
    return
  }
  await window.electronAPI.killTerminal(tabId)
  if (window?.electronAPI?.sessionsList) {
    try {
      const sessions = await window.electronAPI.sessionsList()
      applySessionsToTabs(sessions)
    } catch (_) {}
  }
}

onMounted(async () => {
  refreshMonitorThumbnailMode()
  window.addEventListener('mps:monitor-settings', handleMonitorSettings)

  await loadConfigTemplates()
  if (window?.electronAPI?.getDefaultCwd) {
    try {
      defaultCwd.value = await window.electronAPI.getDefaultCwd()
    } catch (_) {
      defaultCwd.value = ''
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault()
      newTab()
    }
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault()
      if (activeTabId.value) closeTab(activeTabId.value)
    }
  })

  if (window?.electronAPI?.onSessionsChanged) {
    unsubscribeSessionsChanged = window.electronAPI.onSessionsChanged((sessions) => {
      applySessionsToTabs(sessions)
    })
  }

  if (window?.electronAPI?.sessionsList) {
    try {
      const sessions = await window.electronAPI.sessionsList()
      applySessionsToTabs(sessions)
    } catch (_) {}
  }

  // Default UX: show config selector only when there are no running sessions.
  if (tabs.value.filter((t) => !t.pending).length === 0) {
    showConfigSelector.value = true
  }
})

onUnmounted(() => {
  window.removeEventListener('mps:monitor-settings', handleMonitorSettings)
  if (unsubscribeSessionsChanged) {
    unsubscribeSessionsChanged()
    unsubscribeSessionsChanged = null
  }
})

const clearVoiceTimer = () => {
  if (voicePrepareTimer) {
    clearTimeout(voicePrepareTimer)
    voicePrepareTimer = null
  }
}

const stopMediaStream = () => {
  if (!mediaStream) return
  mediaStream.getTracks().forEach(track => track.stop())
  mediaStream = null
}

const resetVoiceState = () => {
  isVoicePreparing.value = false
  isVoiceRecording.value = false
  isVoiceTranscribing.value = false
  clearVoiceTimer()
  stopMediaStream()
  mediaRecorder = null
  recordedChunks = []
  recordingMimeType = ''
}

const pickRecordingMimeType = () => {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  const candidates = [
    'audio/mpeg',
    'audio/webm;codecs=opus',
    'audio/webm'
  ]
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

const normalizeMimeType = (mimeType) => String(mimeType || '').toLowerCase()

const resolveRecordingInfo = (blob) => {
  const rawType = normalizeMimeType(blob?.type)
  if (rawType.startsWith('audio/mpeg')) return { fileName: 'voice.mp3', mimeType: 'audio/mpeg' }
  if (rawType.startsWith('audio/wav')) return { fileName: 'voice.wav', mimeType: 'audio/wav' }
  if (rawType.startsWith('audio/webm')) return { fileName: 'voice.webm', mimeType: 'audio/webm' }
  return { fileName: 'voice.webm', mimeType: blob?.type || 'audio/webm' }
}

const shouldConvertToWav = (mimeType) => {
  const normalized = normalizeMimeType(mimeType)
  if (!normalized) return false
  if (normalized.startsWith('audio/mpeg')) return false
  if (normalized.startsWith('audio/webm')) return false
  if (normalized.startsWith('audio/wav')) return false
  return true
}

const encodeWav = (audioBuffer) => {
  const numChannels = audioBuffer.numberOfChannels
  const sampleRate = audioBuffer.sampleRate
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = audioBuffer.length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  const channelData = []
  for (let channel = 0; channel < numChannels; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel))
  }

  let offset = 44
  for (let i = 0; i < audioBuffer.length; i += 1) {
    for (let channel = 0; channel < numChannels; channel += 1) {
      let sample = channelData[channel][i]
      sample = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return buffer
}

const convertToWav = async (blob) => {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)()
  try {
    const rawBuffer = await blob.arrayBuffer()
    const audioBuffer = await audioContext.decodeAudioData(rawBuffer)
    const wavBuffer = encodeWav(audioBuffer)
    return new Blob([wavBuffer], { type: 'audio/wav' })
  } finally {
    await audioContext.close().catch(() => {})
  }
}

const sendTranscriptToTerminal = (text) => {
  const content = String(text || '').trim()
  if (!content) return
  if (!activeTabId.value) {
    voiceError.value = t('voice.noActiveTerminal')
    return
  }
  window.electronAPI.writeToTerminal(activeTabId.value, content)
}

const submitForTranscription = async (audioBlob, fileName, mimeType) => {
  if (!window?.electronAPI?.voiceTranscribe) {
    throw new Error('Transcription API unavailable')
  }
  const audioBuffer = await audioBlob.arrayBuffer()
  const audioArray = Array.from(new Uint8Array(audioBuffer))
  const format = mimeType.split('/')[1] || 'webm'
  return window.electronAPI.voiceTranscribe(audioArray, format)
}

const handleRecordingStop = async () => {
  const chunks = recordedChunks
  recordedChunks = []
  stopMediaStream()

  if (!chunks.length) {
    voiceError.value = t('voice.noResult')
    isVoiceTranscribing.value = false
    voiceStatus.value = ''
    return
  }

  try {
    let blob = new Blob(chunks, { type: recordingMimeType || 'audio/webm' })
    let { fileName, mimeType } = resolveRecordingInfo(blob)

    if (shouldConvertToWav(mimeType)) {
      try {
        blob = await convertToWav(blob)
        fileName = 'voice.wav'
        mimeType = 'audio/wav'
      } catch (err) {
        console.error(err)
        const fallback = resolveRecordingInfo(blob)
        fileName = fallback.fileName
        mimeType = fallback.mimeType
      }
    }

    const result = await submitForTranscription(blob, fileName, mimeType)
    const text = result?.text ? String(result.text) : ''
    if (!text) {
      voiceError.value = t('voice.noResult')
      voiceStatus.value = ''
    } else {
      sendTranscriptToTerminal(text)
      voiceStatus.value = t('voice.done')
      setTimeout(() => {
        if (!isVoiceRecording.value && !isVoicePreparing.value) voiceStatus.value = ''
      }, 2000)
    }
  } catch (err) {
    console.error(err)
    voiceError.value = t('voice.failed')
    voiceStatus.value = ''
  } finally {
    isVoiceTranscribing.value = false
    mediaRecorder = null
    recordingMimeType = ''
  }
}

const startRecording = async () => {
  if (!navigator?.mediaDevices?.getUserMedia) {
    voiceError.value = t('voice.permissionDenied')
    voiceStatus.value = ''
    isVoicePreparing.value = false
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    voiceError.value = t('voice.failed')
    voiceStatus.value = ''
    isVoicePreparing.value = false
    return
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recordingMimeType = pickRecordingMimeType()
    mediaRecorder = new MediaRecorder(mediaStream, recordingMimeType ? { mimeType: recordingMimeType } : undefined)
    recordedChunks = []

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data)
    }

    mediaRecorder.onstop = () => {
      handleRecordingStop().catch((err) => {
        console.error(err)
        resetVoiceState()
        voiceError.value = t('voice.failed')
        voiceStatus.value = ''
      })
    }

    mediaRecorder.onerror = (event) => {
      console.error(event?.error || event)
      resetVoiceState()
      voiceError.value = t('voice.failed')
      voiceStatus.value = ''
    }

    mediaRecorder.start()
    isVoiceRecording.value = true
    isVoicePreparing.value = false
    voiceStatus.value = t('voice.recording')
  } catch (err) {
    console.error(err)
    resetVoiceState()
    voiceError.value = t('voice.permissionDenied')
    voiceStatus.value = ''
  }
}

const stopRecording = () => {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return
  isVoiceRecording.value = false
  isVoiceTranscribing.value = true
  voiceStatus.value = t('voice.processing')
  try {
    mediaRecorder.stop()
  } catch (err) {
    console.error(err)
    resetVoiceState()
    voiceError.value = t('voice.failed')
  }
}

const toggleVoiceCapture = () => {
  voiceError.value = ''

  if (isVoicePreparing.value) {
    clearVoiceTimer()
    isVoicePreparing.value = false
    voiceStatus.value = ''
    return
  }

  if (isVoiceRecording.value) {
    stopRecording()
    return
  }

  if (isVoiceTranscribing.value) return

  if (!activeTabId.value) {
    voiceError.value = t('voice.noActiveTerminal')
    return
  }

  isVoicePreparing.value = true
  voiceStatus.value = t('voice.preparing')
  clearVoiceTimer()
  voicePrepareTimer = setTimeout(() => {
    voicePrepareTimer = null
    startRecording()
  }, VOICE_ARM_DELAY_MS)
}
</script>

<template>
  <div class="app">
    <MenuBar :mode="uiMode" @changeMode="switchUiMode" @openConfig="openConfigManager" />

    <TabBar
      v-if="uiMode === 'shell' && tabs.length > 0"
      :tabs="tabs"
      :activeTabId="activeTabId"
      :activeCwd="activeCwd"
      @update:activeTabId="activeTabId = $event"
      @close="closeTab"
      @new="newTab"
    />

    <div class="content">
      <teleport to="body">
        <Transition name="fade">
          <div v-if="showConfigSelector" class="modal-overlay">
            <div class="modal-container">
              <ConfigSelector
                :mode="configSelectorMode"
                :configTemplates="configTemplates"
                :currentTabConfig="activeTabId ? tabs.find(t => t.id === activeTabId)?.config : null"
                @create="createTab"
                @update="updateTabConfig"
                @saveTemplate="saveConfigTemplate"
                @deleteTemplate="deleteConfigTemplate"
                @importFromCCSwitch="importFromCCSwitch"
                @close="closeConfigSelector"
                @switchMode="switchConfigMode"
              />
            </div>
          </div>
        </Transition>
      </teleport>

      <div
        class="shell-view"
        :class="{ 'shell-view--inactive': uiMode !== 'shell' }"
        v-show="uiMode === 'shell' || (uiMode === 'monitor' && monitorThumbnailMode === 'terminal')"
      >
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="terminal-wrapper"
          :class="{
            'terminal-wrapper--active': tab.id === activeTabId,
            'terminal-wrapper--preview': tab.id !== activeTabId && monitorThumbnailMode === 'terminal'
          }"
          v-show="tab.id === activeTabId || monitorThumbnailMode === 'terminal'"
        >
          <Terminal v-if="!tab.pending" :sessionId="tab.id" :isActive="uiMode === 'shell' && tab.id === activeTabId" />
        </div>

        <button
          v-if="tabs.length > 0 && !showConfigSelector"
          class="monitor-dock-toggle"
          type="button"
          :class="{ 'monitor-dock-toggle--open': monitorDockOpen }"
          @click="monitorDockOpen = !monitorDockOpen"
        >
          {{ t('menu.modeMonitor') }}
        </button>

        <MonitorPanel
          v-if="uiMode === 'shell' && monitorDockOpen && !showConfigSelector"
          variant="dock"
          :tabs="tabs"
          :defaultCwd="defaultCwd"
          :activeSessionId="activeTabId"
          @close="monitorDockOpen = false"
          @focus="activeTabId = $event"
          @open="(id) => { activeTabId = id; monitorDockOpen = false }"
        />

        <div v-if="tabs.length === 0 && !showConfigSelector" class="empty-state">
          <div class="empty-card">
            <div class="empty-icon">⌨️</div>
            <h2>{{ t('app.noActiveTerminals') }}</h2>
            <p>{{ t('app.pressCtrlT', { shortcut: 'Ctrl+T' }) }}</p>
            <button class="primary-btn large-btn" @click="newTab">
              <span>+</span> {{ t('app.newTerminal') }}
            </button>
          </div>
        </div>

        <div class="voice-bar">
          <button
            class="voice-btn"
            :class="{
              'voice-btn--arming': isVoicePreparing,
              'voice-btn--recording': isVoiceRecording
            }"
            :disabled="voiceButtonDisabled"
            @click="toggleVoiceCapture"
          >
            <span class="voice-indicator" aria-hidden="true"></span>
            {{ voiceButtonText }}
          </button>
          <div class="voice-meta">
            <span v-if="voiceStatus" class="voice-status">{{ voiceStatus }}</span>
            <span v-if="voiceError" class="voice-error">{{ voiceError }}</span>
          </div>
        </div>
      </div>

      <div class="monitor-view" v-show="uiMode === 'monitor'">
        <MonitorPanel
          variant="page"
          :tabs="tabs"
          :defaultCwd="defaultCwd"
          :activeSessionId="activeTabId"
          @focus="activeTabId = $event"
          @open="(id) => { activeTabId = id; switchUiMode('shell') }"
        />
      </div>

      <div class="remote-view" v-show="uiMode === 'remote'">
        <RemotePanel />
      </div>

    </div>
  </div>
</template>

<style>
:root {
  /* Ultra Dark Theme - Pure Black & Comfortable */
  --bg-color: #000000; /* Pure Black */
  --surface-color: #0a0a0a; /* Almost Black */
  --surface-hover: #161616; /* Subtle dark gray for hover */
  --surface-active: #222222; /* Active state */
  --border-color: #1f1f1f; /* Very subtle border */
  
  --primary-color: #3b82f6; /* Vivid Blue for contrast on black */
  --primary-hover: #60a5fa;
  
  --text-primary: #ededed; /* High contrast white */
  --text-secondary: #888888; /* Neutral gray */
  
  --danger-color: #ef4444;
  --success-color: #22c55e;
  --warning-color: #eab308;
  
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  
  /* Consistent Rounded Corners */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px; /* For main app corners */
  
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
  
  --transition-fast: 0.15s cubic-bezier(0.2, 0, 0, 1);
  --transition-normal: 0.3s cubic-bezier(0.2, 0, 0, 1);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body,
html {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: transparent; /* Essential for rounded corners */
}

#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: transparent;
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  padding: 4px; /* Padding for window resize handle / shadow space if needed, or 0 if frameless */
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--bg-color);
  overflow: hidden;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05);
}

.content {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.shell-view,
.monitor-view,
.remote-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-color);
  border-bottom-left-radius: var(--radius-lg);
  border-bottom-right-radius: var(--radius-lg);
}

.shell-view {
  position: relative;
}

.shell-view--inactive {
  opacity: 0;
  pointer-events: none;
}

.monitor-view {
  position: absolute;
  inset: 0;
  z-index: 1200;
  background-color: var(--bg-color);
}

.terminal-wrapper {
  flex: 1;
  width: 100%;
  min-height: 0;
  background-color: var(--bg-color);
  position: relative;
}

.terminal-wrapper--preview {
  position: absolute;
  left: 0;
  top: 0;
  width: 960px;
  height: 540px;
  flex: none;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  visibility: hidden;
}

.monitor-dock-toggle {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 1600;
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid rgba(59, 130, 246, 0.3);
  background: rgba(0, 0, 0, 0.6);
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  backdrop-filter: blur(16px);
  box-shadow: var(--shadow-md);
  transition: all var(--transition-normal);
}

.monitor-dock-toggle:hover {
  transform: translateY(-2px);
  background: rgba(59, 130, 246, 0.15);
  border-color: var(--primary-color);
}

.monitor-dock-toggle--open {
  border-color: var(--surface-active);
  background: var(--surface-hover);
  color: var(--text-primary);
}

/* Modal Overlay */
.modal-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  z-index: 2500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.modal-container {
  min-width: 480px;
  max-width: 90%;
  animation: modal-slide-up 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: var(--shadow-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

@keyframes modal-slide-up {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Empty State */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  background-color: var(--bg-color);
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  text-align: center;
  padding: 40px;
  border-radius: var(--radius-lg);
  border: 1px dashed var(--border-color);
  background: var(--surface-color);
}

.empty-icon {
  font-size: 56px;
  margin-bottom: 8px;
  opacity: 0.6;
  filter: grayscale(1);
  color: var(--text-secondary);
}

.empty-card h2 {
  font-weight: 600;
  font-size: 20px;
  color: var(--text-primary);
}

.empty-card p {
  color: var(--text-secondary);
  font-size: 15px;
}

.voice-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-top: 1px solid var(--border-color);
  background: var(--surface-color);
}

.voice-btn {
  background: var(--surface-hover);
  color: var(--text-primary);
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border-color);
  transition: all var(--transition-fast);
}

.voice-btn:hover:not(:disabled) {
  background: var(--surface-active);
  border-color: var(--text-secondary);
}

.voice-btn--arming {
  background: var(--warning-color);
  color: #000000;
  border-color: transparent;
}

.voice-btn--recording {
  background: var(--danger-color);
  color: #ffffff;
  border-color: transparent;
}

.voice-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-secondary);
  box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
  transition: background 0.2s ease;
}

.voice-btn--recording .voice-indicator {
  background: #ffffff;
  animation: pulse 1.5s ease-in-out infinite;
}

.voice-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 14px;
}

.voice-status {
  color: var(--text-secondary);
  font-family: monospace;
}

.voice-error {
  color: var(--danger-color);
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.6);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(248, 81, 73, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(248, 81, 73, 0);
  }
}

kbd {
  background: var(--surface-active);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
  font-size: 0.85em;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

/* Buttons */
button {
  cursor: pointer;
  border: none;
  font-family: inherit;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}

.primary-btn {
  background-color: var(--primary-color);
  color: #ffffff;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
}

.primary-btn:hover {
  background-color: var(--primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

.primary-btn:active {
  transform: translateY(0);
}

.primary-btn.large-btn {
  padding: 12px 24px;
  font-size: 15px;
}

/* Scrollbars - Stealth Mode */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--surface-active);
  border: 2px solid var(--bg-color); /* Creates padding effect */
  border-radius: 99px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-secondary);
}

::-webkit-scrollbar-corner {
  background: transparent;
}
</style>

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
  }
}

const createTab = async (config, workingDir) => {
  const plainConfig = (() => {
    try { return structuredClone(config) } catch (_) { return JSON.parse(JSON.stringify(config)) }
  })()

  const sessionId = await window.electronAPI.createTerminal(plainConfig, workingDir)
  if (pendingTabId.value) {
    const index = tabs.value.findIndex(t => t.id === pendingTabId.value)
    if (index !== -1) {
      tabs.value[index] = {
        id: sessionId,
        title: plainConfig.name,
        config: { ...plainConfig },
        workingDir: workingDir || ''
      }
      activeTabId.value = sessionId
    }
    pendingTabId.value = null
  } else {
    tabs.value.push({
      id: sessionId,
      title: plainConfig.name,
      config: { ...plainConfig },
      workingDir: workingDir || ''
    })
    activeTabId.value = sessionId
  }
  showConfigSelector.value = false
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
    showConfigSelector.value = false
    if (activeTabId.value === tabId) {
      activeTabId.value = tabs.value.length > 0 ? tabs.value[0].id : null
    }
    return
  }
  await window.electronAPI.killTerminal(tabId)
  const index = tabs.value.findIndex(t => t.id === tabId)
  if (index !== -1) tabs.value.splice(index, 1)
  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value.length > 0 ? tabs.value[0].id : null
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

  showConfigSelector.value = true
})

onUnmounted(() => {
  window.removeEventListener('mps:monitor-settings', handleMonitorSettings)
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
              @close="closeConfigSelector"
              @switchMode="switchConfigMode"
            />
          </div>
        </div>
      </Transition>

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
  --bg-color: #0a0a0a; /* Neutral Deep Black */
  --surface-color: #161616; /* Soft Dark Gray */
  --surface-hover: #222222;
  --surface-active: #333333;
  --border-color: #262626;
  
  --primary-color: #3f72c4; /* Soft Blue - Comfortable */
  --primary-hover: #2d5fb3;
  
  --text-primary: #e5e5e5; /* Soft White */
  --text-secondary: #a3a3a3; /* Neutral Gray */
  
  --danger-color: #f87171; /* Soft Red */
  --success-color: #4ade80; /* Soft Green */
  
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body,
html,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: transparent;
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 14px;
  border-radius: var(--radius-lg);
  clip-path: inset(0 round var(--radius-lg));
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background-color: var(--bg-color);
  clip-path: inset(0 round var(--radius-lg));
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
}

.terminal-wrapper {
  flex: 1;
  width: 100%;
  min-height: 0;
  background-color: var(--bg-color);
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
}

.monitor-dock-toggle {
  position: absolute;
  right: 16px;
  bottom: 72px;
  z-index: 1600;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(63, 114, 196, 0.55);
  background: rgba(63, 114, 196, 0.18);
  color: #bfdbfe;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.02em;
  backdrop-filter: blur(8px);
}

.monitor-dock-toggle:hover {
  transform: translateY(-1px);
  background: rgba(63, 114, 196, 0.24);
}

.monitor-dock-toggle--open {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
}

/* Modal Overlay */
.modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-container {
  min-width: 480px;
  max-width: 90%;
  animation: modal-slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modal-slide-up {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.98);
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
  gap: 16px;
  text-align: center;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 8px;
  opacity: 0.8;
}

.empty-card h2 {
  font-weight: 600;
  font-size: 18px;
  color: var(--text-primary);
}

.empty-card p {
  color: var(--text-secondary);
  font-size: 14px;
}

.voice-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--surface-color);
}

.voice-btn {
  background: var(--surface-hover);
  color: var(--text-primary);
  padding: 8px 14px;
  border-radius: var(--radius-md);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
}

.voice-btn--arming {
  background: var(--surface-active);
}

.voice-btn--recording {
  background: var(--danger-color);
  color: #ffffff;
}

.voice-btn:disabled {
  opacity: 0.6;
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
  animation: pulse 1.2s ease-in-out infinite;
}

.voice-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.voice-status {
  color: var(--text-secondary);
}

.voice-error {
  color: var(--danger-color);
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
  }
}

kbd {
  background: var(--surface-active);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-family: monospace;
  font-size: 0.9em;
  border: 1px solid var(--border-color);
}

/* Buttons */
button {
  cursor: pointer;
  border: none;
  font-family: inherit;
  transition: all 0.2s;
}

.primary-btn {
  background-color: var(--primary-color);
  color: white;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.primary-btn:hover {
  background-color: var(--primary-hover);
}

.primary-btn.large-btn {
  padding: 10px 24px;
  font-size: 15px;
}

/* Scrollbars */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--surface-active);
  border-radius: var(--radius-sm);
  border: 2px solid var(--bg-color);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-secondary);
}
</style>

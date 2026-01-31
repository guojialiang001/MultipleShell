<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../i18n'
import { validateHttpUrl } from '../utils/http-url'

const props = defineProps({
  mode: {
    type: String,
    default: 'shell'
  }
})

const emit = defineEmits(['openConfig', 'changeMode'])
const showSettings = ref(false)
const version = ref('')
const updateState = ref({ state: 'idle' })
let unsubscribeUpdate = null

const { t, locale } = useI18n()

const REMOTE_BASE_URL_KEY = 'mps.remote.baseUrl'
const REMOTE_REMOTEAPP_ENABLED_KEY = 'mps.remote.remoteAppEnabled'
const REMOTE_REMOTEAPP_CLIENT_ID_KEY = 'mps.remote.remoteAppClientId'
const REMOTE_VNC_CLIENT_ID_KEY = 'mps.remote.vncClientId'
const REMOTE_CLIENT_ID_BASE64_KEY = 'mps.remote.clientIdBase64'
const REMOTE_SYSTEM_RDP_PORT_KEY = 'mps.remote.systemRdpPort'
const REMOTE_RDP_CONFIGURED_KEY = 'mps.remote.rdpConfigured'
const MONITOR_THUMBNAIL_MODE_KEY = 'mps.monitor.thumbnailMode' // card | terminal

const REMOTE_APP_ALIAS = '||MultipleShell'

const readLocalStorage = (key, fallback = '') => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : String(value)
  } catch (_) {
    return fallback
  }
}

const writeLocalStorage = (key, value) => {
  try {
    localStorage.setItem(key, value)
  } catch (_) {}
}

const notifyRemoteSettingsChanged = () => {
  try {
    window.dispatchEvent(new Event('mps:remote-settings'))
  } catch (_) {}
}

const notifyMonitorSettingsChanged = () => {
  try {
    window.dispatchEvent(new Event('mps:monitor-settings'))
  } catch (_) {}
}

const parseBool = (value, fallback = false) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

const normalizeMonitorThumbnailMode = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'terminal') return 'terminal'
  return 'card'
}

const remoteBaseUrl = ref(readLocalStorage(REMOTE_BASE_URL_KEY, ''))
const remoteAppEnabled = ref(parseBool(readLocalStorage(REMOTE_REMOTEAPP_ENABLED_KEY, '0'), false))
const remoteAppClientId = ref(readLocalStorage(REMOTE_REMOTEAPP_CLIENT_ID_KEY, ''))
const vncClientId = ref(readLocalStorage(REMOTE_VNC_CLIENT_ID_KEY, ''))
const clientIdBase64 = ref(parseBool(readLocalStorage(REMOTE_CLIENT_ID_BASE64_KEY, '0'), false))
const systemRdpPort = ref(readLocalStorage(REMOTE_SYSTEM_RDP_PORT_KEY, '3389') || '3389')
const rdpConfigured = ref(parseBool(readLocalStorage(REMOTE_RDP_CONFIGURED_KEY, '0'), false))
const monitorThumbnailMode = ref(normalizeMonitorThumbnailMode(readLocalStorage(MONITOR_THUMBNAIL_MODE_KEY, 'card')))

const remoteBaseUrlValidation = computed(() => validateHttpUrl(remoteBaseUrl.value))
const remoteBaseUrlError = computed(() => {
  const result = remoteBaseUrlValidation.value
  if (result.isEmpty || result.isValid) return ''
  if (result.error === 'whitespace') return t('remote.urlHasSpacesHint')
  if (result.error === 'protocol') return t('remote.urlUnsupportedProtocolHint')
  return t('remote.urlInvalidHint')
})
const remoteBaseUrlWarning = computed(() => {
  const result = remoteBaseUrlValidation.value
  if (!result.isValid) return ''
  if (result.warning === 'http') return t('remote.urlHttpWarningHint')
  return ''
})

const systemRdpPortError = computed(() => {
  const raw = String(systemRdpPort.value ?? '').trim()
  if (!raw) return t('remote.systemRdpPortInvalidHint')
  const port = Number.parseInt(raw, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) return t('remote.systemRdpPortInvalidHint')
  return ''
})

const refreshRemoteSettings = () => {
  remoteBaseUrl.value = readLocalStorage(REMOTE_BASE_URL_KEY, '')
  remoteAppEnabled.value = parseBool(readLocalStorage(REMOTE_REMOTEAPP_ENABLED_KEY, '0'), false)
  remoteAppClientId.value = readLocalStorage(REMOTE_REMOTEAPP_CLIENT_ID_KEY, '')
  vncClientId.value = readLocalStorage(REMOTE_VNC_CLIENT_ID_KEY, '')
  clientIdBase64.value = parseBool(readLocalStorage(REMOTE_CLIENT_ID_BASE64_KEY, '0'), false)
  systemRdpPort.value = readLocalStorage(REMOTE_SYSTEM_RDP_PORT_KEY, '3389') || '3389'
  rdpConfigured.value = parseBool(readLocalStorage(REMOTE_RDP_CONFIGURED_KEY, '0'), false)
}

const clearRemoteSettings = () => {
  const confirmed = window.confirm ? window.confirm(t('remote.clearSettingsConfirm')) : true
  if (!confirmed) return

  remoteBaseUrl.value = ''
  remoteAppEnabled.value = false
  remoteAppClientId.value = ''
  vncClientId.value = ''
  clientIdBase64.value = false
  systemRdpPort.value = '3389'
}

watch(remoteBaseUrl, (value) => {
  writeLocalStorage(REMOTE_BASE_URL_KEY, String(value ?? ''))
  notifyRemoteSettingsChanged()
})
watch(remoteAppEnabled, (value) => {
  writeLocalStorage(REMOTE_REMOTEAPP_ENABLED_KEY, value ? '1' : '0')
  notifyRemoteSettingsChanged()
})
watch(remoteAppClientId, (value) => {
  writeLocalStorage(REMOTE_REMOTEAPP_CLIENT_ID_KEY, String(value ?? ''))
  notifyRemoteSettingsChanged()
})
watch(vncClientId, (value) => {
  writeLocalStorage(REMOTE_VNC_CLIENT_ID_KEY, String(value ?? ''))
  notifyRemoteSettingsChanged()
})
watch(clientIdBase64, (value) => {
  writeLocalStorage(REMOTE_CLIENT_ID_BASE64_KEY, value ? '1' : '0')
  notifyRemoteSettingsChanged()
})
watch(systemRdpPort, (value) => {
  writeLocalStorage(REMOTE_SYSTEM_RDP_PORT_KEY, String(value ?? ''))
  notifyRemoteSettingsChanged()
})
watch(rdpConfigured, (value) => {
  writeLocalStorage(REMOTE_RDP_CONFIGURED_KEY, value ? '1' : '0')
  notifyRemoteSettingsChanged()
})
watch(monitorThumbnailMode, (value) => {
  const normalized = normalizeMonitorThumbnailMode(value)
  if (value !== normalized) {
    monitorThumbnailMode.value = normalized
    return
  }
  writeLocalStorage(MONITOR_THUMBNAIL_MODE_KEY, normalized)
  notifyMonitorSettingsChanged()
})

const updateStatus = computed(() => updateState.value?.state || 'idle')
const updateProgress = computed(() => {
  const raw = Number(updateState.value?.progress)
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null
})
const versionLabel = computed(() => (version.value ? `v${version.value}` : ''))
const updateLabel = computed(() => {
  const status = updateStatus.value
  const nextVersion = updateState.value?.version ? `v${updateState.value.version}` : ''

  if (status === 'checking') return t('updates.checking')
  if (status === 'available') return nextVersion ? t('updates.availableWithVersion', { version: nextVersion }) : t('updates.available')
  if (status === 'downloading') return t('updates.downloading', { progress: updateProgress.value ?? 0 })
  if (status === 'downloaded') return t('updates.downloaded')
  if (status === 'not-available') return t('updates.latest')
  if (status === 'error') return t('updates.error')
  if (status === 'disabled') return t('updates.disabled')
  return t('updates.check')
})
const updateChipClass = computed(() => ({
  'update-chip--latest': updateStatus.value === 'not-available',
  'update-chip--available': updateStatus.value === 'available' || updateStatus.value === 'downloaded',
  'update-chip--downloading': updateStatus.value === 'checking' || updateStatus.value === 'downloading',
  'update-chip--error': updateStatus.value === 'error',
  'update-chip--disabled': updateStatus.value === 'disabled'
}))
const updateActionDisabled = computed(() =>
  updateStatus.value === 'checking' || updateStatus.value === 'downloading' || updateStatus.value === 'disabled'
)
const updateTitle = computed(() => {
  if (updateStatus.value === 'downloaded') return t('updates.actionRestart')
  if (updateStatus.value === 'disabled') return t('updates.disabled')
  return t('updates.actionCheck')
})

const rdpApplyState = ref('idle') // idle | loading | loaded | error
let rdpApplyTimer = null

const armRdpApplyState = () => {
  if (rdpApplyTimer) clearTimeout(rdpApplyTimer)
  rdpApplyTimer = setTimeout(() => {
    rdpApplyState.value = 'idle'
    rdpApplyTimer = null
  }, 1400)
}

const applyRdpConfig = async () => {
  if (rdpApplyState.value === 'loading') return
  if (rdpConfigured.value) return
  if (systemRdpPortError.value) {
    rdpApplyState.value = 'error'
    armRdpApplyState()
    return
  }

  if (!window?.electronAPI?.remoteApplyRdpConfig) {
    rdpApplyState.value = 'error'
    armRdpApplyState()
    return
  }

  if (window?.electronAPI?.appGetInstanceCount) {
    try {
      const count = await window.electronAPI.appGetInstanceCount()
      if (Number.isFinite(count) && count > 1) {
        if (window?.alert) window.alert(t('remote.rdpMultiAppRunningHint', { count }))
        rdpApplyState.value = 'error'
        armRdpApplyState()
        return
      }
    } catch (err) {
      console.warn('[mps] appGetInstanceCount failed', err)
    }
  }

  const port = Number.parseInt(String(systemRdpPort.value ?? '').trim(), 10)

  rdpApplyState.value = 'loading'
  try {
    await window.electronAPI.remoteApplyRdpConfig({ systemRdpPort: port })
    rdpConfigured.value = true
    rdpApplyState.value = 'loaded'
    armRdpApplyState()
  } catch (err) {
    console.error('[mps] applyRdpConfig failed', err)
    rdpApplyState.value = 'error'
    armRdpApplyState()
  }
}

const openConfig = () => {
  emit('openConfig')
}

const setMode = (nextMode) => {
  if (!nextMode || nextMode === props.mode) return
  emit('changeMode', nextMode)
}

const openSettings = () => {
  showSettings.value = true
}


const minimizeWindow = () => {
  window?.electronAPI?.windowMinimize?.()
}

const toggleMaximizeWindow = () => {
  window?.electronAPI?.windowToggleMaximize?.()
}

const showClosePrompt = ref(false)
const closePromptInput = ref('')
const closeInputRef = ref(null)

const isCloseInputValid = computed(() => closePromptInput.value.trim().toLowerCase() === 'close')

const openClosePrompt = () => {
  closePromptInput.value = ''
  showClosePrompt.value = true
  nextTick(() => closeInputRef.value?.focus())
}

const dismissClosePrompt = () => {
  showClosePrompt.value = false
  closePromptInput.value = ''
}

const confirmClosePrompt = () => {
  if (!isCloseInputValid.value) return
  dismissClosePrompt()
  window?.electronAPI?.windowClose?.()
}

const closeWindow = () => {
  openClosePrompt()
}

const changeLanguage = (next) => {
  setLocale(next)
  showSettings.value = false
}

const closeSettings = () => {
  showSettings.value = false
}

onMounted(async () => {
  refreshRemoteSettings()
  window.addEventListener('mps:remote-settings', refreshRemoteSettings)

  if (window?.electronAPI?.appGetVersion) {
    try {
      version.value = await window.electronAPI.appGetVersion()
    } catch (_) {}
  }

  if (window?.electronAPI?.updateGetStatus) {
    try {
      syncUpdateState(await window.electronAPI.updateGetStatus())
    } catch (_) {}
  }

  if (window?.electronAPI?.onUpdateStatus) {
    unsubscribeUpdate = window.electronAPI.onUpdateStatus(syncUpdateState)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('mps:remote-settings', refreshRemoteSettings)

  if (unsubscribeUpdate) {
    unsubscribeUpdate()
    unsubscribeUpdate = null
  }

  if (rdpApplyTimer) {
    clearTimeout(rdpApplyTimer)
    rdpApplyTimer = null
  }
})


const handleUpdateAction = () => {
  if (updateActionDisabled.value) return
  if (updateStatus.value === 'downloaded') {
    window?.electronAPI?.updateQuitAndInstall?.()
    return
  }
  window?.electronAPI?.updateCheck?.()
}

const syncUpdateState = (payload) => {
  if (payload && typeof payload === 'object') updateState.value = payload
}

</script>

<template>
  <div class="menu-bar">
    <div class="left-actions">
      <div class="mode-toggle" role="tablist" aria-label="mode">
        <button
          class="mode-btn"
          type="button"
          :class="{ active: props.mode === 'shell' }"
          @click="setMode('shell')"
        >
          {{ t('menu.modeShell') }}
        </button>
        <button
          class="mode-btn"
          type="button"
          :class="{ active: props.mode === 'monitor' }"
          @click="setMode('monitor')"
        >
          {{ t('menu.modeMonitor') }}
        </button>
        <button
          class="mode-btn"
          type="button"
          :class="{ active: props.mode === 'remote' }"
          @click="setMode('remote')"
        >
          {{ t('menu.modeRemote') }}
        </button>
      </div>
      <button class="menu-btn" @click="openConfig">
        <span class="btn-text">{{ t('menu.manageTemplates') }}</span>
      </button>
    </div>

    <div class="spacer"></div>

    <div class="right-actions">
      <button class="menu-btn" @click="openSettings">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l0 0a2 2 0 0 1 0 2.83l0 0a2 2 0 0 1-2.83 0l0 0a1.65 1.65 0 0 0-1.82-.33l0 0a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2l0 0a2 2 0 0 1-2-2v0a1.65 1.65 0 0 0-1-1.51l0 0a1.65 1.65 0 0 0-1.82.33l0 0a2 2 0 0 1-2.83 0l0 0a2 2 0 0 1 0-2.83l0 0a1.65 1.65 0 0 0 .33-1.82l0 0a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2l0 0a2 2 0 0 1 2-2h0a1.65 1.65 0 0 0 1.51-1l0 0a1.65 1.65 0 0 0-.33-1.82l0 0a2 2 0 0 1 0-2.83l0 0a2 2 0 0 1 2.83 0l0 0a1.65 1.65 0 0 0 1.82.33l0 0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2l0 0a2 2 0 0 1 2 2v0a1.65 1.65 0 0 0 1 1.51l0 0a1.65 1.65 0 0 0 1.82-.33l0 0a2 2 0 0 1 2.83 0l0 0a2 2 0 0 1 0 2.83l0 0a1.65 1.65 0 0 0-.33 1.82l0 0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2l0 0a2 2 0 0 1-2 2h0a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <span class="btn-text">{{ t('menu.settings') }}</span>
      </button>
      <div class="window-controls">
        <button class="window-btn" type="button" title="Minimize" @click="minimizeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="1" y1="5" x2="9" y2="5"></line>
          </svg>
        </button>
        <button class="window-btn" type="button" title="Maximize" @click="toggleMaximizeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3">
            <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="0.8"></rect>
          </svg>
        </button>
        <button class="window-btn window-btn-close" type="button" title="Close" @click="closeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="1.5" y1="1.5" x2="8.5" y2="8.5"></line>
            <line x1="8.5" y1="1.5" x2="1.5" y2="8.5"></line>
          </svg>
        </button>
      </div>
    </div>
  </div>
  <teleport to="body">
    <transition name="fade">
      <div v-if="showSettings" class="settings-overlay" @click="closeSettings">
        <div class="settings-modal" @click.stop>
          <div class="settings-header">
            <h3 class="settings-title">{{ t('menu.settings') }}</h3>
            <button class="close-btn" type="button" :title="t('common.close')" @click="closeSettings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <div class="settings-body">
            <div class="section-label">{{ t('menu.language') }}</div>
            <div class="lang-options">
              <button
                class="lang-option"
                type="button"
                :class="{ active: locale === 'zh-CN' }"
                @click="changeLanguage('zh-CN')"
              >
                <span class="lang-left">
                  <span class="tag">ZH</span>
                  <span>{{ t('language.zhCN') }}</span>
                </span>
                <span v-if="locale === 'zh-CN'" class="check" aria-hidden="true">OK</span>
              </button>

              <button
                class="lang-option"
                type="button"
                :class="{ active: locale === 'en' }"
                @click="changeLanguage('en')"
              >
                <span class="lang-left">
                  <span class="tag">EN</span>
                  <span>{{ t('language.en') }}</span>
                </span>
                <span v-if="locale === 'en'" class="check" aria-hidden="true">OK</span>
              </button>
            </div>

            <div class="section-label section-label--tight">{{ t('monitor.settings.title') }}</div>
            <div class="lang-options">
              <button class="lang-option" :class="{ active: monitorThumbnailMode === 'card' }" @click="monitorThumbnailMode = 'card'">
                <span class="lang-left">
                  <span class="tag">CARD</span>
                  <span>{{ t('monitor.settings.modeCard') }}</span>
                </span>
                <span v-if="monitorThumbnailMode === 'card'" class="check" aria-hidden="true">OK</span>
              </button>
              <button
                class="lang-option"
                :class="{ active: monitorThumbnailMode === 'terminal' }"
                @click="monitorThumbnailMode = 'terminal'"
              >
                <span class="lang-left">
                  <span class="tag">TTY</span>
                  <span>{{ t('monitor.settings.modeTerminal') }}</span>
                </span>
                <span v-if="monitorThumbnailMode === 'terminal'" class="check" aria-hidden="true">OK</span>
              </button>
            </div>
            <div class="update-hint">{{ t('monitor.settings.hint') }}</div>

            <div class="section-label section-label--tight">{{ t('remote.title') }}</div>
            <div class="remote-card">
              <label class="toggle-row">
                <input class="toggle-input" type="checkbox" v-model="remoteAppEnabled" />
                <span class="toggle-label">{{ t('remote.remoteAppEnabled') }}</span>
              </label>

              <label class="toggle-row">
                <input class="toggle-input" type="checkbox" v-model="clientIdBase64" />
                <span class="toggle-label">{{ t('remote.clientIdBase64') }}</span>
              </label>

              <div class="field">
                <div class="field-label">{{ t('remote.systemRdpPort') }}</div>
                <input
                  v-model="systemRdpPort"
                  class="field-input"
                  :class="{ 'field-input--error': !!systemRdpPortError }"
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  :placeholder="t('remote.systemRdpPortPlaceholder')"
                  spellcheck="false"
                />
                <div v-if="systemRdpPortError" class="field-hint field-hint--error">{{ systemRdpPortError }}</div>
              </div>

              <div class="field">
                <div class="field-label">{{ t('remote.baseUrl') }}</div>
                <input
                  v-model="remoteBaseUrl"
                  class="field-input"
                  :class="{ 'field-input--error': !!remoteBaseUrlError }"
                  type="text"
                  :placeholder="t('remote.baseUrlPlaceholder')"
                  spellcheck="false"
                />
                <div v-if="remoteBaseUrlError" class="field-hint field-hint--error">{{ remoteBaseUrlError }}</div>
                <div v-else-if="remoteBaseUrlWarning" class="field-hint field-hint--warn">{{ remoteBaseUrlWarning }}</div>
              </div>

              <div class="field">
                <div class="field-label">{{ t('remote.remoteAppClientId') }}</div>
                <input
                  v-model="remoteAppClientId"
                  class="field-input"
                  type="text"
                  :placeholder="t('remote.remoteAppNamePlaceholder')"
                  spellcheck="false"
                />
                <div class="field-hint field-hint--muted">
                  {{ t('remote.remoteAppAliasLabel') }}: <span class="remote-alias">{{ REMOTE_APP_ALIAS }}</span>
                </div>
              </div>

              <div class="field">
                <div class="field-label">{{ t('remote.vncClientId') }}</div>
                <input
                  v-model="vncClientId"
                  class="field-input"
                  type="text"
                  :placeholder="t('remote.vncNamePlaceholder')"
                  spellcheck="false"
                />
              </div>

              <div class="remote-hint">{{ t('remote.hint') }}</div>

              <div class="remote-hint remote-hint--status">
                {{ t('remote.rdpConfigStatus') }}:
                <span class="remote-status" :class="{ 'remote-status--on': rdpConfigured }">
                  {{ rdpConfigured ? t('remote.rdpConfigured') : t('remote.rdpNotConfigured') }}
                </span>
              </div>

              <div class="remote-actions">
                <button
                  class="remote-load-btn"
                  type="button"
                  :disabled="rdpApplyState === 'loading' || !!systemRdpPortError || rdpConfigured"
                  @click="applyRdpConfig"
                >
                  {{
                    rdpConfigured
                      ? t('remote.rdpConfigured')
                      : rdpApplyState === 'loading'
                      ? t('remote.loading')
                      : rdpApplyState === 'loaded'
                        ? t('remote.loaded')
                        : rdpApplyState === 'error'
                          ? t('remote.loadFailed')
                          : t('remote.loadRdpConfig')
                  }}
                </button>
                <button class="remote-clear-btn" type="button" @click="clearRemoteSettings">
                  {{ t('remote.clearSettings') }}
                </button>
              </div>
            </div>

            <div class="section-label section-label--tight">{{ t('updates.title') }}</div>
            <div class="update-card">
              <div class="update-row">
                <span class="version-tag">{{ versionLabel }}</span>
                <button
                  class="update-chip"
                  :class="updateChipClass"
                  :title="updateTitle"
                  :disabled="updateActionDisabled"
                  @click="handleUpdateAction"
                >
                  {{ updateLabel }}
                </button>
              </div>
              <div v-if="updateStatus === 'error' && updateState.error" class="update-hint">{{ updateState.error }}</div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>


  <Transition name="fade">
    <div v-if="showClosePrompt" class="tab-close-overlay" @click.self="dismissClosePrompt">
      <div class="tab-close-modal" @click.stop>
        <div class="tab-close-header">{{ t('app.confirmExitTitle') }}</div>
        <div class="tab-close-message">{{ t('app.confirmExitPrompt', { keyword: 'close' }) }}</div>
        <input
          ref="closeInputRef"
          v-model="closePromptInput"
          class="tab-close-input"
          :placeholder="t('app.confirmExitPlaceholder', { keyword: 'close' })"
          @keydown.enter.prevent="confirmClosePrompt"
          @keydown.esc.prevent="dismissClosePrompt"
        />
        <div class="tab-close-actions">
          <button class="tab-close-btn tab-close-btn--ghost" type="button" @click="dismissClosePrompt">
            {{ t('common.cancel') }}
          </button>
          <button
            class="tab-close-btn tab-close-btn--danger"
            type="button"
            :disabled="!isCloseInputValid"
            @click="confirmClosePrompt"
          >
            {{ t('common.close') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.menu-bar {
  background: var(--surface-color);
  border-bottom: 1px solid var(--border-color);
  padding: 0 12px;
  display: flex;
  height: 40px;
  align-items: center;
  user-select: none;
  -webkit-app-region: drag;
}

.spacer {
  flex: 1;
}

.left-actions,
.right-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-toggle {
  display: inline-flex;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.04);
  padding: 2px;
  -webkit-app-region: no-drag;
}

.mode-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  transition: background 0.15s ease, color 0.15s ease;
  -webkit-app-region: no-drag;
}

.mode-btn:hover {
  color: var(--text-primary);
}

.mode-btn.active {
  background: rgba(63, 114, 196, 0.22);
  color: #bfdbfe;
}

.version-tag {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.update-card {
  background: var(--surface-hover);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.remote-card {
  background: var(--surface-hover);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.toggle-input {
  width: 14px;
  height: 14px;
  accent-color: var(--primary-color);
}

.toggle-label {
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.92);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.7);
}

.field-input {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.field-input:focus {
  border-color: rgba(59, 130, 246, 0.6);
}

.field-input--error {
  border-color: rgba(239, 68, 68, 0.72);
}

.field-hint {
  font-size: 11px;
  line-height: 1.4;
}

.field-hint--muted {
  color: var(--text-secondary);
}

.remote-alias {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-weight: 900;
  color: rgba(255, 255, 255, 0.85);
}

.field-hint--error {
  color: rgba(252, 165, 165, 0.95);
}

.field-hint--warn {
  color: rgba(253, 224, 71, 0.95);
}

.remote-hint {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.remote-hint--status {
  margin-top: 8px;
}

.remote-status {
  font-weight: 800;
  color: rgba(255, 255, 255, 0.75);
}

.remote-status--on {
  color: rgba(34, 197, 94, 0.9);
}

.remote-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.remote-load-btn {
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(59, 130, 246, 0.42);
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
  font-size: 12px;
  font-weight: 800;
}

.remote-load-btn:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.26);
  border-color: rgba(59, 130, 246, 0.55);
}

.remote-load-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.remote-clear-btn {
  padding: 6px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.remote-clear-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.update-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-hint {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.update-chip {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  transition: all 0.2s ease;
}

.update-chip:hover:not(:disabled) {
  transform: translateY(-1px);
}

.update-chip:disabled {
  opacity: 0.6;
  cursor: default;
}

.update-chip--latest {
  background: rgba(74, 222, 128, 0.12);
  border-color: rgba(74, 222, 128, 0.35);
  color: #86efac;
}

.update-chip--available {
  background: rgba(59, 130, 246, 0.18);
  border-color: rgba(59, 130, 246, 0.45);
  color: #93c5fd;
}

.update-chip--downloading {
  background: rgba(250, 204, 21, 0.18);
  border-color: rgba(250, 204, 21, 0.4);
  color: #fde047;
}

.update-chip--error {
  background: rgba(248, 113, 113, 0.2);
  border-color: rgba(248, 113, 113, 0.5);
  color: #fecaca;
}

.update-chip--disabled {
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.menu-btn {
  background: transparent;
  border: none;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
  -webkit-app-region: no-drag;
}

.menu-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.window-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.window-btn {
  width: 36px;
  height: 28px;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
}

.window-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.window-btn-close:hover {
  background: rgba(239, 68, 68, 0.18);
  color: #ffffff;
}

.btn-icon {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  opacity: 0.85;
}

.btn-text {
  font-size: 13px;
  font-weight: 600;
}

.settings-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 2000;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 52px 12px 12px 12px; /* leave room for the top bar */
}

.settings-modal {
  width: 340px;
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: 0 18px 28px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  animation: modal-pop 0.16s ease-out;
}

@keyframes modal-pop {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--surface-hover);
  border-bottom: 1px solid var(--border-color);
}

.settings-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: var(--surface-active);
  color: var(--text-primary);
}

.settings-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}

.section-label {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
  margin-bottom: 10px;
}

.section-label--tight {
  margin-top: 12px;
  margin-bottom: 6px;
}

.lang-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lang-option {
  background: var(--surface-hover);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  padding: 10px 10px;
  cursor: pointer;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: all 0.15s ease;
}

.lang-option:hover {
  border-color: var(--surface-active);
  transform: translateY(-1px);
}

.lang-option.active {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.35);
}

.lang-left {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.tag {
  width: 28px;
  height: 22px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.check {
  font-weight: 900;
  color: rgba(255, 255, 255, 0.9);
}

/* Animation */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.tab-close-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tab-close-modal {
  width: min(420px, 90vw);
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
}

.tab-close-header {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.tab-close-message {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.tab-close-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  outline: none;
  font-size: 13px;
}

.tab-close-input:focus {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
}

.tab-close-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.tab-close-btn {
  padding: 6px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  transition: all 0.2s;
}

.tab-close-btn--ghost:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.tab-close-btn--danger {
  border-color: rgba(239, 68, 68, 0.6);
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.1);
}

.tab-close-btn--danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  color: #fecaca;
}

.tab-close-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

</style>

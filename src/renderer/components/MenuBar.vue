<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../i18n'

const emit = defineEmits(['openConfig'])
const showSettings = ref(false)
const version = ref('')
const updateState = ref({ state: 'idle' })
let unsubscribeUpdate = null

const { t, locale } = useI18n()

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

const openConfig = () => {
  emit('openConfig')
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
  if (unsubscribeUpdate) {
    unsubscribeUpdate()
    unsubscribeUpdate = null
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

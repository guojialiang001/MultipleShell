<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../i18n'

const emit = defineEmits(['openConfig'])
const showSettings = ref(false)
const { t, locale } = useI18n()

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

const closeWindow = () => {
  window?.electronAPI?.windowClose?.()
}

const changeLanguage = (next) => {
  setLocale(next)
  showSettings.value = false
}

const closeSettings = () => {
  showSettings.value = false
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
        <span class="btn-icon" aria-hidden="true">‚öôÔ∏è</span>
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
                  <span class="tag">‰∏</span>
                  <span>{{ t('language.zhCN') }}</span>
                </span>
                <span v-if="locale === 'zh-CN'" class="check" aria-hidden="true">‚ú</span>
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
                <span v-if="locale === 'en'" class="check" aria-hidden="true">‚ú</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
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
  border-radius: 6px;
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
  font-size: 14px;
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
  border-radius: 6px;
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
</style>

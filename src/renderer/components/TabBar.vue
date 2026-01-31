<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import claudeIcon from '../assets/icons/claude.svg'
import codexIcon from '../assets/icons/codex.svg'
import opencodeIcon from '../assets/icons/opencode.ico'

const props = defineProps({
  tabs: { type: Array, required: true },
  activeTabId: { type: [String, null], default: null },
  activeCwd: { type: String, default: '' }
})

const emit = defineEmits(['update:activeTabId', 'close', 'new'])
const { t } = useI18n()

const ICONS = {
  'claude-code': { src: claudeIcon },
  codex: { src: codexIcon },
  opencode: { src: opencodeIcon }
}

const KNOWN_TYPES = new Set(['claude-code', 'codex', 'opencode'])

const normalizeType = (type) => (typeof type === 'string' ? type.trim().toLowerCase() : '')

const inferTypeFromText = (text) => {
  const t = String(text || '').toLowerCase()
  if (!t) return ''
  if (t.includes('codex')) return 'codex'
  if (t.includes('opencode')) return 'opencode'
  if (t.includes('claude')) return 'claude-code'
  return ''
}

const getTabType = (tab) => {
  const raw = normalizeType(tab?.config?.type)
  const inferred = inferTypeFromText(tab?.config?.name || tab?.title || '')

  if (KNOWN_TYPES.has(raw)) {
    // If the saved type looks wrong but the name/title clearly indicates a different tool,
    // prefer the inferred one to avoid showing the wrong icon.
    if (inferred && inferred !== raw) return inferred
    return raw
  }

  return inferred
}

const getTabGroupKey = (tab) => {
  const cfg = tab?.config
  const id = typeof cfg?.id === 'string' ? cfg.id.trim() : ''
  if (id) return `id:${id}`
  const name = typeof cfg?.name === 'string' ? cfg.name.trim() : ''
  if (name) return `name:${name}`
  const type = typeof cfg?.type === 'string' ? cfg.type.trim() : ''
  if (type) return `type:${type}`
  return 'default'
}

const tabIndexById = computed(() => {
  const out = new Map()
  const counts = new Map()

  for (const tab of props.tabs || []) {
    if (tab?.pending) continue
    const key = getTabGroupKey(tab)
    const next = (counts.get(key) || 0) + 1
    counts.set(key, next)
    out.set(tab.id, next)
  }

  return out
})

const getDisplayTitle = (tab) => {
  const base = tab?.titleKey ? t(tab.titleKey) : (tab?.title || t('tabs.untitled'))
  if (tab?.pending) return base
  const idx = tabIndexById.value.get(tab?.id)
  if (!idx) return base
  return `${base} #${idx}`
}

const getIconSrc = (type) => ICONS[type]?.src || ''

const getIconLabel = (type) => {
  if (type === 'claude-code') return 'Cl'
  if (type === 'codex') return 'Cx'
  if (type === 'opencode') return 'OC'
  return 'PC'
}

const activeTab = computed(() => props.tabs?.find((tab) => tab.id === props.activeTabId) || null)
const activeTabTitle = computed(() => {
  if (activeTab.value) return getDisplayTitle(activeTab.value)
  if (props.tabs?.length) return getDisplayTitle(props.tabs[0])
  return t('tabs.untitled')
})

const tabsRef = ref(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
const hasOverflow = ref(false)
let resizeObserver
let scrollHandler
let resizeHandler

const updateScrollState = () => {
  const el = tabsRef.value
  if (!el) return
  const maxScrollLeft = el.scrollWidth - el.clientWidth
  hasOverflow.value = maxScrollLeft > 1
  canScrollLeft.value = el.scrollLeft > 0
  canScrollRight.value = el.scrollLeft < maxScrollLeft - 1
}

const scrollTabs = (direction) => {
  const el = tabsRef.value
  if (!el) return
  const amount = Math.max(140, Math.floor(el.clientWidth * 0.6))
  el.scrollBy({ left: amount * direction, behavior: 'smooth' })
}

const showClosePrompt = ref(false)
const closePromptTab = ref(null)
const closePromptInput = ref('')
const closeInputRef = ref(null)

const closePromptMessage = computed(() => {
  if (!closePromptTab.value) return ''
  return t('tabs.confirmClosePrompt', {
    name: getDisplayTitle(closePromptTab.value),
    keyword: 'close'
  })
})

const isCloseInputValid = computed(() => closePromptInput.value.trim().toLowerCase() === 'close')

const openClosePrompt = (tab) => {
  if (tab?.pending) {
    emit('close', tab.id)
    return
  }
  closePromptTab.value = tab
  closePromptInput.value = ''
  showClosePrompt.value = true
  nextTick(() => closeInputRef.value?.focus())
}

const dismissClosePrompt = () => {
  showClosePrompt.value = false
  closePromptTab.value = null
  closePromptInput.value = ''
}

const confirmClosePrompt = () => {
  if (!closePromptTab.value || !isCloseInputValid.value) return
  emit('close', closePromptTab.value.id)
  dismissClosePrompt()
}

onMounted(() => {
  const el = tabsRef.value
  if (!el) return
  scrollHandler = () => updateScrollState()
  resizeHandler = () => updateScrollState()
  el.addEventListener('scroll', scrollHandler, { passive: true })
  window.addEventListener('resize', resizeHandler)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => updateScrollState())
    resizeObserver.observe(el)
  }
  nextTick(() => updateScrollState())
})

onBeforeUnmount(() => {
  const el = tabsRef.value
  if (el && scrollHandler) {
    el.removeEventListener('scroll', scrollHandler)
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler)
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
  }
})

watch(
  () => props.tabs?.length,
  () => nextTick(() => updateScrollState())
)
</script>

<template>
  <div class="tab-bar">
    <div class="tab-row">
      <button
        v-if="hasOverflow"
        class="scroll-btn"
        type="button"
        :disabled="!canScrollLeft"
        aria-label="Scroll left"
        @click="scrollTabs(-1)"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div ref="tabsRef" class="tabs">
        <div
          v-for="tab in props.tabs"
          :key="tab.id"
          :class="['tab', { active: tab.id === props.activeTabId }]"
          @click="emit('update:activeTabId', tab.id)"
        >
          <span :class="['tab-icon', `tool-${getTabType(tab) || 'pc'}`]" aria-hidden="true">
            <img v-if="getIconSrc(getTabType(tab))" class="tab-icon-img" :src="getIconSrc(getTabType(tab))" alt="" />
            <template v-else>{{ getIconLabel(getTabType(tab)) }}</template>
          </span>
          <span class="tab-title">{{ getDisplayTitle(tab) }}</span>
          <button class="close-btn" @click.stop="openClosePrompt(tab)" :title="t('tabs.close')">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <button class="new-tab-btn" @click="emit('new')" :title="t('tabs.newTabShortcut', { shortcut: 'Ctrl+T' })">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 1V13M1 7H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <button
        v-if="hasOverflow"
        class="scroll-btn"
        type="button"
        :disabled="!canScrollRight"
        aria-label="Scroll right"
        @click="scrollTabs(1)"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <div class="path-bar" :title="props.activeCwd || ''">
      <div class="path-segment path-segment--tab">
        <span class="path-label">{{ t('tabs.tab') }}</span>
        <span class="path-tab">{{ activeTabTitle }}</span>
      </div>
      <span class="path-divider" aria-hidden="true"></span>
      <div class="path-segment path-segment--cwd">
        <span class="path-label">{{ t('tabs.cwd') }}</span>
        <span class="path-value">{{ props.activeCwd || '' }}</span>
      </div>
    </div>
  </div>

  <Transition name="fade">
    <div v-if="showClosePrompt" class="tab-close-overlay" @click.self="dismissClosePrompt">
      <div class="tab-close-modal" @click.stop>
        <div class="tab-close-header">{{ t('tabs.confirmCloseTitle') }}</div>
        <div class="tab-close-message">{{ closePromptMessage }}</div>
        <input
          ref="closeInputRef"
          v-model="closePromptInput"
          class="tab-close-input"
          :placeholder="t('tabs.confirmClosePlaceholder', { keyword: 'close' })"
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
            {{ t('tabs.close') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tab-bar {
  background: var(--surface-color);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.tab-row {
  display: flex;
  align-items: center;
  padding: 8px 8px 0 8px; /* Bottom is 0 because tabs sit on the bottom line */
  gap: 8px;
  overflow: hidden;
}

.tab-row::-webkit-scrollbar {
  height: 4px;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 0;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none; /* Firefox */
}
.tabs::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}

.path-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 8px 12px;
  border-top: 1px solid var(--border-color);
  background: var(--surface-hover);
  color: var(--text-secondary);
  font-size: 12px;
  user-select: none;
}

.path-segment {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.path-segment--tab {
  flex: 0 1 auto;
  max-width: 240px;
}

.path-segment--cwd {
  flex: 1;
  min-width: 0;
}

.path-divider {
  width: 1px;
  height: 14px;
  background: var(--border-color);
  opacity: 0.6;
}

.path-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.path-tab {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
  max-width: 240px;
}

.path-value {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
  color: var(--text-primary);
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  min-width: 88px;
  max-width: 240px;
  flex: 1 1 0;
  transition: all 0.2s ease;
  position: relative;
  user-select: none;
  overflow: hidden;
}

.tab:first-child {
  border-top-left-radius: var(--radius-md);
}

.tab:last-child {
  border-top-right-radius: var(--radius-md);
}

.tab + .tab {
  border-left: 1px solid var(--border-color);
}

.tab:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.tab.active {
  background: var(--surface-active);
  color: var(--text-primary);
  border-color: var(--border-color);
  position: relative;
}

/* Active Indicator */
.tab.active::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 1px;
  background: rgba(147, 197, 253, 0.9);
  border-radius: var(--radius-sm);
}

.tab-icon {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  text-transform: none;
  opacity: 0.9;
  color: rgba(255, 255, 255, 0.92);
  background: linear-gradient(135deg, #3f3f46, #27272a);
}

.tab-icon-img {
  width: 16px;
  height: 16px;
  display: block;
  object-fit: contain;
}

.tab.active .tab-icon {
  opacity: 1;
}

.tab-icon.tool-claude-code {
  background: rgba(217, 119, 87, 0.18);
}

.tab-icon.tool-codex {
  background: rgba(255, 255, 255, 0.06);
}

.tab-icon.tool-opencode {
  background: transparent;
}

.tab-icon.tool-opencode .tab-icon-img {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
}

.tab-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scroll-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  cursor: pointer;
  width: 26px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  margin-bottom: 4px;
  flex: 0 0 auto;
}

.scroll-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.scroll-btn:disabled {
  opacity: 0.35;
  cursor: default;
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

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0; /* Hidden by default */
  transition: all 0.2s;
  width: 20px;
  height: 20px;
}

.tab:hover .close-btn,
.tab.active .close-btn {
  opacity: 1;
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  color: var(--danger-color);
}

.new-tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  flex: 0 0 auto;
  margin-left: 5px;
  margin-bottom: 4px; /* Align visually with tabs */
}

.new-tab-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
</style>

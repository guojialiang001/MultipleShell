<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SessionThumbnail from './SessionThumbnail.vue'
import { getAllTerminalPreviews, onTerminalPreviewUpdate } from '../utils/terminal-preview-store'

const props = defineProps({
  variant: {
    type: String,
    default: 'page' // page | dock
  },
  tabs: {
    type: Array,
    default: () => []
  },
  defaultCwd: {
    type: String,
    default: ''
  },
  activeSessionId: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['focus', 'open', 'close'])

const { t } = useI18n()

const MONITOR_THUMBNAIL_MODE_KEY = 'mps.monitor.thumbnailMode' // card | terminal

const sessions = ref([])
const now = ref(Date.now())
const collapsed = ref(false)
const thumbnailMode = ref('card')
const previews = ref({})
let unsubscribe = null
let unsubscribePreviews = null
let clockTimer = null

const readLocalStorage = (key, fallback = '') => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : String(value)
  } catch (_) {
    return fallback
  }
}

const normalizeThumbnailMode = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'terminal') return 'terminal'
  return 'card'
}

const refreshThumbnailMode = () => {
  thumbnailMode.value = normalizeThumbnailMode(readLocalStorage(MONITOR_THUMBNAIL_MODE_KEY, 'card'))
}

const tabsById = computed(() => {
  const map = new Map()
  for (const tab of props.tabs || []) {
    if (!tab || typeof tab !== 'object') continue
    if (typeof tab.id !== 'string') continue
    map.set(tab.id, tab)
  }
  return map
})

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

const tabOrderById = computed(() => {
  const map = new Map()
  for (const [index, tab] of (props.tabs || []).entries()) {
    if (!tab || typeof tab !== 'object') continue
    if (typeof tab.id !== 'string') continue
    map.set(tab.id, index)
  }
  return map
})

const mergedSessions = computed(() => {
  const map = tabsById.value
  return sessions.value
    .filter(Boolean)
    .map((s) => {
      const tab = map.get(s.sessionId)
      return {
        ...s,
        title: tab ? getDisplayTitle(tab) : s.sessionId,
        workingDir: tab?.workingDir || props.defaultCwd || ''
      }
    })
    .sort((a, b) => {
      const tabIndex = tabOrderById.value.get(a.sessionId) ?? Number.POSITIVE_INFINITY
      const tabIndexB = tabOrderById.value.get(b.sessionId) ?? Number.POSITIVE_INFINITY
      const d = tabIndex - tabIndexB
      if (d !== 0) return d
      const aKey = String(a.title || a.sessionId || '')
      const bKey = String(b.title || b.sessionId || '')
      return aKey.localeCompare(bKey)
    })
})

const stats = computed(() => {
  const out = {
    starting: 0,
    running: 0,
    idle: 0,
    completed: 0,
    stuck: 0,
    error: 0,
    stopped: 0
  }
  for (const s of sessions.value) {
    if (!s || typeof s !== 'object') continue
    if (out[s.status] == null) continue
    out[s.status] += 1
  }
  return out
})

const applyUpdate = ({ sessionId, state }) => {
  if (typeof sessionId !== 'string' || !sessionId) return
  const index = sessions.value.findIndex((s) => s && s.sessionId === sessionId)

  if (!state) {
    if (index >= 0) sessions.value.splice(index, 1)
    return
  }

  if (index >= 0) sessions.value[index] = state
  else sessions.value.push(state)
}

const focusSession = (sessionId) => {
  emit('focus', sessionId)
}

const openSession = (sessionId) => {
  emit('open', sessionId)
}

const toggleCollapsed = () => {
  collapsed.value = !collapsed.value
}

const closeDock = () => {
  emit('close')
}

const previewUrlFor = (sessionId) => {
  const map = previews.value || {}
  if (!sessionId) return ''
  return map[sessionId] || ''
}

onMounted(() => {
  refreshThumbnailMode()
  window.addEventListener('mps:monitor-settings', refreshThumbnailMode)
  previews.value = getAllTerminalPreviews()
  unsubscribePreviews = onTerminalPreviewUpdate(({ sessionId, url }) => {
    if (!sessionId) return
    if (!url) {
      const next = { ...(previews.value || {}) }
      delete next[sessionId]
      previews.value = next
      return
    }
    previews.value = { ...(previews.value || {}), [sessionId]: url }
  })

  if (window?.electronAPI?.monitorGetStates) {
    window.electronAPI.monitorGetStates().then((states) => {
      sessions.value = Array.isArray(states) ? states : []
    })
  }

  if (window?.electronAPI?.onMonitorUpdate) {
    unsubscribe = window.electronAPI.onMonitorUpdate(applyUpdate)
  }

  clockTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  window.removeEventListener('mps:monitor-settings', refreshThumbnailMode)
  if (typeof unsubscribePreviews === 'function') unsubscribePreviews()
  unsubscribePreviews = null

  if (typeof unsubscribe === 'function') unsubscribe()
  unsubscribe = null

  if (clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
})
</script>

<template>
  <div class="monitor-panel" :class="[`monitor-panel--${variant}`]">
    <div class="monitor-header">
      <div class="monitor-title">{{ t('monitor.title') }}</div>
      <div class="monitor-stats">
        <span class="stat-item stat-item--running">{{ t('monitor.stats.running') }}: {{ stats.running }}</span>
        <span class="stat-item stat-item--completed">{{ t('monitor.stats.completed') }}: {{ stats.completed }}</span>
        <span class="stat-item stat-item--stuck">{{ t('monitor.stats.stuck') }}: {{ stats.stuck }}</span>
        <span class="stat-item stat-item--error">{{ t('monitor.stats.error') }}: {{ stats.error }}</span>
        <button
          v-if="variant === 'dock'"
          class="dock-btn"
          type="button"
          @click="toggleCollapsed"
        >
          {{ collapsed ? t('monitor.expand') : t('monitor.collapse') }}
        </button>
        <button
          v-if="variant === 'dock'"
          class="dock-btn dock-btn--close"
          type="button"
          :aria-label="t('common.close')"
          @click="closeDock"
        >
          {{ t('common.close') }}
        </button>
      </div>
    </div>

    <div v-if="!collapsed && mergedSessions.length === 0" class="monitor-empty">
      <div class="monitor-empty-title">{{ t('monitor.emptyTitle') }}</div>
      <div class="monitor-empty-hint">{{ t('monitor.emptyHint') }}</div>
    </div>

    <div v-else-if="!collapsed" class="monitor-grid">
      <SessionThumbnail
        v-for="session in mergedSessions"
        :key="session.sessionId"
        :session="session"
        :viewMode="thumbnailMode"
        :previewUrl="previewUrlFor(session.sessionId)"
        :now="now"
        :active="session.sessionId === activeSessionId"
        @focus="focusSession"
        @open="openSession"
      />
    </div>
  </div>
</template>

<style scoped>
.monitor-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px 14px 16px 14px;
  gap: 12px;
}

.monitor-panel--page {
  background: radial-gradient(circle at 20% 0%, rgba(63, 114, 196, 0.14), transparent 45%),
    radial-gradient(circle at 90% 20%, rgba(74, 222, 128, 0.1), transparent 45%),
    var(--bg-color);
}

.monitor-panel--dock {
  position: absolute;
  right: 16px;
  bottom: 120px;
  width: min(420px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: var(--radius-lg);
  background: rgba(22, 22, 22, 0.92);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(10px);
  z-index: 1600;
}

.monitor-panel--dock .monitor-grid {
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  padding-right: 0;
}

.monitor-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  position: relative;
  z-index: 2;
}

.monitor-title {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.85);
}

.monitor-stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.stat-item--running {
  color: rgba(74, 222, 128, 0.92);
}

.stat-item--completed {
  color: rgba(134, 239, 172, 0.88);
}

.stat-item--stuck {
  color: rgba(251, 191, 36, 0.92);
}

.stat-item--error {
  color: rgba(248, 113, 113, 0.92);
}

.dock-btn {
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.82);
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
}

.dock-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.dock-btn--close {
  border-color: rgba(248, 113, 113, 0.35);
  background: rgba(248, 113, 113, 0.12);
  color: #fecaca;
}

.dock-btn--close:hover {
  background: rgba(248, 113, 113, 0.18);
}

.monitor-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-auto-flow: row;
  align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  padding-right: 2px;
}

.monitor-empty {
  flex: 1;
  min-height: 0;
  border: 1px dashed rgba(255, 255, 255, 0.16);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.03);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 24px;
}

.monitor-empty-title {
  font-weight: 700;
  color: var(--text-primary);
}

.monitor-empty-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>

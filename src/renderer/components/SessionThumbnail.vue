<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import claudeIcon from '../assets/icons/claude.svg'
import codexIcon from '../assets/icons/codex.svg'
import opencodeIcon from '../assets/icons/opencode.ico'

const props = defineProps({
  session: {
    type: Object,
    required: true
  },
  now: {
    type: Number,
    required: true
  },
  active: {
    type: Boolean,
    default: false
  },
  viewMode: {
    type: String,
    default: 'card' // card | terminal
  },
  previewUrl: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['focus', 'open'])

const { t } = useI18n()

const workingDirText = computed(() => {
  const wd = String(props.session?.workingDir || '').trim()
  return wd || t('configSelector.userProfile')
})

const typeIconUrl = computed(() => {
  const type = props.session?.configType
  if (type === 'claude-code') return claudeIcon
  if (type === 'codex') return codexIcon
  if (type === 'opencode') return opencodeIcon
  return ''
})

const typeIconText = computed(() => {
  const type = props.session?.configType
  if (type === 'claude-code') return 'C'
  if (type === 'codex') return 'X'
  if (type === 'opencode') return 'O'
  return '?'
})

const typeIconClass = computed(() => {
  const type = props.session?.configType
  if (type === 'claude-code') return 'type-icon--claude'
  if (type === 'codex') return 'type-icon--codex'
  if (type === 'opencode') return 'type-icon--opencode'
  return 'type-icon--unknown'
})

const statusLabel = computed(() => {
  const s = props.session?.status
  if (s === 'starting') return t('monitor.status.starting')
  if (s === 'running') return t('monitor.status.running')
  if (s === 'idle') return t('monitor.status.idle')
  if (s === 'completed') return t('monitor.status.completed')
  if (s === 'stuck') return t('monitor.status.stuck')
  if (s === 'error') return t('monitor.status.error')
  if (s === 'stopped') return t('monitor.status.stopped')
  return String(s || '')
})

const hasErrors = computed(() => Number(props.session?.errorCount || 0) > 0)

const durationText = computed(() => {
  const start = Number(props.session?.startTime || 0)
  if (!start) return '—'
  const end = Number(props.session?.endTime || props.now || Date.now())
  return formatDuration(Math.max(0, end - start))
})

const sinceActiveText = computed(() => {
  const last = Number(props.session?.lastActivityTime || 0)
  if (!last) return '—'
  const now = Number(props.now || Date.now())
  return formatDuration(Math.max(0, now - last))
})

const outputLineCountText = computed(() => String(Number(props.session?.outputLineCount || 0)))

const previewText = computed(() => {
  const status = String(props.session?.status || '').trim()
  const lastLine = String(props.session?.lastLine || '').trim()
  const lastErrorLine = String(props.session?.lastErrorLine || '').trim()
  if (status === 'error' && lastErrorLine) return lastErrorLine
  return lastLine || '—'
})

const handleFocus = () => {
  emit('focus', props.session.sessionId)
}

const handleOpen = () => {
  emit('open', props.session.sessionId)
}

const isPreviewDebugEnabled = () => {
  if (process.env.NODE_ENV === 'development') return true
  try {
    const raw = String(localStorage.getItem('mps.debug.preview') || '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
  } catch (_) {
    return false
  }
}

const handlePreviewError = () => {
  if (!isPreviewDebugEnabled()) return
  const url = String(props.previewUrl || '')
  const scheme = url.startsWith('blob:') ? 'blob' : url.startsWith('data:') ? 'data' : url ? 'other' : 'empty'
  console.warn('[mps] preview img failed to load', { sessionId: props.session?.sessionId, scheme, length: url.length })
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
</script>

<template>
  <div
    class="thumb"
    :class="[
      `status-${session.status}`,
      { 'thumb--active': active }
    ]"
    @click="handleFocus"
    @dblclick="handleOpen"
  >
    <div class="thumb-top">
      <div class="thumb-left">
        <div class="type-icon" :class="typeIconClass" aria-hidden="true">
          <img v-if="typeIconUrl" class="type-icon-img" :src="typeIconUrl" alt="" />
          <span v-else class="type-icon-fallback">{{ typeIconText }}</span>
        </div>
        <div class="thumb-title">
          <div class="thumb-name" :title="`${session.title} — ${workingDirText}`">
            {{ session.title }} <span class="thumb-cwd">— {{ workingDirText }}</span>
          </div>
        </div>
      </div>
      <div class="thumb-badges">
        <span class="badge badge--status">{{ statusLabel }}</span>
        <span v-if="hasErrors" class="badge badge--error">{{ session.errorCount }}</span>
        <button class="open-icon-btn" type="button" :aria-label="t('monitor.open')" :title="t('monitor.open')" @click.stop="handleOpen">
          ↗
        </button>
      </div>
    </div>

    <div v-if="viewMode === 'terminal'" class="thumb-terminal">
      <img v-if="previewUrl" class="thumb-terminal-img" :src="previewUrl" alt="" @error="handlePreviewError" />
      <div v-else class="thumb-terminal-placeholder">{{ t('monitor.snapshotPending') }}</div>
    </div>

    <div v-else class="thumb-card">
      <div
        class="thumb-card-preview"
        :class="{ 'thumb-card-preview--error': session.status === 'error' }"
        :title="previewText"
      >
        {{ previewText }}
      </div>
      <div class="thumb-card-meta">
        <div class="thumb-card-metric">
          <div class="thumb-card-metric-label">{{ t('monitor.card.duration') }}</div>
          <div class="thumb-card-metric-value">{{ durationText }}</div>
        </div>
        <div class="thumb-card-metric">
          <div class="thumb-card-metric-label">{{ t('monitor.card.sinceActive') }}</div>
          <div class="thumb-card-metric-value">{{ sinceActiveText }}</div>
        </div>
        <div class="thumb-card-metric">
          <div class="thumb-card-metric-label">{{ t('monitor.card.lines') }}</div>
          <div class="thumb-card-metric-value">{{ outputLineCountText }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thumb {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius-lg);
  background: rgba(22, 22, 22, 0.82);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 200px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.thumb:hover {
  border-color: rgba(255, 255, 255, 0.24);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.42);
}

.thumb--active {
  border-color: rgba(63, 114, 196, 0.65);
  box-shadow: 0 0 0 2px rgba(63, 114, 196, 0.15), 0 10px 24px rgba(0, 0, 0, 0.35);
}

.thumb-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.thumb-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.thumb-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.thumb-name {
  font-weight: 750;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thumb-cwd {
  font-size: 11px;
  font-weight: 650;
  color: rgba(255, 255, 255, 0.55);
}

.type-icon {
  width: 20px;
  height: 20px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  overflow: hidden;
  flex-shrink: 0;
}

.type-icon-img {
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.type-icon-fallback {
  font-size: 10px;
  font-weight: 900;
}

.type-icon--claude {
  border-color: rgba(251, 191, 36, 0.45);
  background: rgba(251, 191, 36, 0.14);
  color: #fde68a;
}

.type-icon--codex {
  border-color: rgba(59, 130, 246, 0.45);
  background: rgba(59, 130, 246, 0.16);
  color: #bfdbfe;
}

.type-icon--opencode {
  border-color: rgba(74, 222, 128, 0.45);
  background: rgba(74, 222, 128, 0.14);
  color: #86efac;
}

.type-icon--unknown {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.85);
}

.thumb-badges {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}

.badge {
  font-size: 9px;
  font-weight: 800;
  border-radius: 999px;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.8);
}

.badge--error {
  background: rgba(248, 113, 113, 0.18);
  border-color: rgba(248, 113, 113, 0.5);
  color: #fecaca;
}

.open-icon-btn {
  width: 22px;
  height: 22px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.78);
  font-weight: 900;
  line-height: 1;
  cursor: pointer;
}

.open-icon-btn:hover {
  border-color: rgba(255, 255, 255, 0.24);
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.thumb-terminal {
  flex: 1;
  min-height: 0;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0a0a0a;
  padding: 4px 6px;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
}

.thumb-terminal-pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 10px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.82);
  white-space: pre-wrap;
  word-break: break-word;
  width: 100%;
}

.thumb-terminal-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: auto;
}

.thumb-terminal-placeholder {
  width: 100%;
  height: 100%;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8px;
}

.thumb-card {
  flex: 1;
  min-height: 0;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(10, 10, 10, 0.55);
  padding: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thumb-card-preview {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0a0a0a;
  padding: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 10px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.82);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
}

.thumb-card-preview--error {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(248, 113, 113, 0.08);
  color: #fecaca;
}

.thumb-card-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.thumb-card-metric {
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  padding: 4px 6px;
  min-width: 0;
}

.thumb-card-metric-label {
  font-size: 9px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 0.01em;
}

.thumb-card-metric-value {
  font-size: 11px;
  font-weight: 900;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-running .badge--status {
  background: rgba(74, 222, 128, 0.12);
  border-color: rgba(74, 222, 128, 0.35);
  color: #86efac;
}

.status-starting .badge--status {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.35);
  color: #bfdbfe;
}

.status-idle .badge--status {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.35);
  color: #fde68a;
}

.status-stuck .badge--status {
  background: rgba(251, 146, 60, 0.16);
  border-color: rgba(251, 146, 60, 0.4);
  color: #fdba74;
}

.status-completed .badge--status {
  background: rgba(74, 222, 128, 0.12);
  border-color: rgba(74, 222, 128, 0.35);
  color: #86efac;
}

.status-stopped .badge--status {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.65);
}

.status-error .badge--status {
  background: rgba(248, 113, 113, 0.18);
  border-color: rgba(248, 113, 113, 0.5);
  color: #fecaca;
}
</style>

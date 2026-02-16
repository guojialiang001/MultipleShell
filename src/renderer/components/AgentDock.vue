<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Terminal from './Terminal.vue'

const props = defineProps({
  open: { type: Boolean, default: true },
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: [String, null], default: null }
})

const emit = defineEmits(['toggle'])

const { t } = useI18n()

const plannerSessionId = ref('')
const logs = ref([])
const inputText = ref('')
const actionError = ref('')
const outputRef = ref(null)
let unsubscribe = null

const clampText = (value, max = 5000) => {
  const text = String(value ?? '')
  const m = Number(max)
  if (!Number.isFinite(m) || m <= 0) return ''
  if (text.length <= m) return text
  if (m <= 3) return text.slice(0, m)
  return text.slice(0, m - 3) + '...'
}

const formatTime = (iso) => {
  const raw = String(iso || '').trim()
  if (!raw) return ''
  // Prefer stable HH:MM:SS without locale quirks.
  const t = raw.includes('T') ? raw.split('T')[1] : raw
  return String(t).replace('Z', '').slice(0, 8)
}

const plannerLabel = computed(() => {
  const sid = String(plannerSessionId.value || '').trim()
  if (!sid) return ''
  const tab = (props.tabs || []).find((x) => x && x.id === sid)
  const title = String(tab?.title || tab?.config?.name || '').trim()
  return title ? `${title} (${sid})` : sid
})

const canBindToActive = computed(() => Boolean(props.activeTabId))
const canSend = computed(() => Boolean(String(inputText.value || '').trim()))

const isOutputAtBottom = () => {
  const el = outputRef.value
  if (!el) return true
  const gap = 24
  return el.scrollTop + el.clientHeight >= el.scrollHeight - gap
}

const scrollOutputToBottom = async () => {
  await nextTick()
  const el = outputRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

const applyLogEntry = async (entry) => {
  if (!entry || typeof entry !== 'object') return

  if (entry.type === 'clear') {
    logs.value = []
    return
  }

  if (typeof entry.plannerSessionId === 'string') {
    plannerSessionId.value = entry.plannerSessionId
  }

  const wasAtBottom = isOutputAtBottom()
  logs.value.push(entry)
  if (logs.value.length > 400) logs.value.splice(0, logs.value.length - 400)
  if (wasAtBottom) await scrollOutputToBottom()
}

const loadState = async () => {
  if (!window?.electronAPI?.agentGetState) return
  try {
    const state = await window.electronAPI.agentGetState()
    const sid = typeof state?.plannerSessionId === 'string' ? state.plannerSessionId : ''
    plannerSessionId.value = sid
    const list = Array.isArray(state?.logs) ? state.logs : []
    logs.value = list.slice(-400)
    await scrollOutputToBottom()
  } catch (err) {
    console.warn('[mps] agentGetState failed', err)
  }
}

const bindToActiveTab = async () => {
  actionError.value = ''
  const sid = typeof props.activeTabId === 'string' ? props.activeTabId.trim() : ''
  if (!sid) return
  if (!window?.electronAPI?.agentSetPlanner) return
  try {
    const res = await window.electronAPI.agentSetPlanner(sid)
    if (typeof res?.plannerSessionId === 'string') plannerSessionId.value = res.plannerSessionId
  } catch (err) {
    actionError.value = err?.message ? String(err.message) : String(err || '')
  }
}

const clearLogs = async () => {
  actionError.value = ''
  if (!window?.electronAPI?.agentClearLogs) return
  try {
    await window.electronAPI.agentClearLogs()
  } catch (err) {
    actionError.value = err?.message ? String(err.message) : String(err || '')
  }
}

const sendToPlanner = async () => {
  actionError.value = ''
  const text = String(inputText.value || '')
  if (!text.trim()) return
  if (!window?.electronAPI?.agentSend) return
  try {
    await window.electronAPI.agentSend({ text, enter: true })
    inputText.value = ''
  } catch (err) {
    actionError.value = err?.message ? String(err.message) : String(err || '')
  }
}

const formatDetail = (entry) => {
  const out = {}
  if (entry.toolId) out.toolId = entry.toolId
  if (entry.method) out.method = entry.method
  if (entry.params) out.params = entry.params
  if (entry.ok != null) out.ok = entry.ok
  if (entry.result) out.result = entry.result
  if (entry.error) out.error = entry.error
  return clampText(JSON.stringify(out, null, 2), 6000)
}

onMounted(async () => {
  await loadState()
  if (window?.electronAPI?.onAgentLog) {
    unsubscribe = window.electronAPI.onAgentLog((entry) => {
      applyLogEntry(entry)
    })
  }
})

onUnmounted(() => {
  if (typeof unsubscribe === 'function') unsubscribe()
  unsubscribe = null
})

watch(
  () => props.open,
  async (open) => {
    if (open) await scrollOutputToBottom()
  }
)
</script>

<template>
  <div class="agent-dock" :class="{ 'agent-dock--open': open }">
    <div class="agent-header">
      <div class="agent-title">
        {{ t('agent.title') }}
        <span v-if="plannerLabel" class="agent-planner">· {{ plannerLabel }}</span>
        <span v-else class="agent-planner agent-planner--empty">· {{ t('agent.noPlanner') }}</span>
      </div>
      <div class="agent-actions">
        <button class="agent-btn" type="button" :disabled="!canBindToActive" @click="bindToActiveTab">
          {{ t('agent.bindActive') }}
        </button>
        <button class="agent-btn" type="button" @click="clearLogs">
          {{ t('agent.clear') }}
        </button>
        <button class="agent-btn agent-btn--toggle" type="button" @click="emit('toggle')">
          {{ open ? t('agent.collapse') : t('agent.expand') }}
        </button>
      </div>
    </div>

    <div v-show="open" class="agent-body">
      <div class="agent-panels">
        <div class="agent-panel agent-panel--dialog">
          <Terminal v-if="plannerSessionId" class="agent-terminal" :sessionId="plannerSessionId" :isActive="false" />
          <div v-else class="agent-terminal-empty">{{ t('agent.noPlanner') }}</div>
        </div>

        <div class="agent-panel agent-panel--display">
          <div ref="outputRef" class="agent-output">
            <div v-if="logs.length === 0" class="agent-empty">{{ t('agent.empty') }}</div>
            <div v-for="entry in logs" :key="entry.id" class="agent-entry">
              <div class="agent-line">
                <span class="agent-ts">{{ formatTime(entry.ts) }}</span>
                <span class="agent-type" :class="`agent-type--${entry.type}`">{{ entry.type }}</span>
                <span class="agent-msg">{{ entry.message || '' }}</span>
              </div>
              <pre v-if="entry.params || entry.result || entry.error" class="agent-detail">{{ formatDetail(entry) }}</pre>
            </div>
          </div>
        </div>
      </div>

      <div class="agent-input">
        <textarea
          v-model="inputText"
          class="agent-textarea"
          rows="2"
          :placeholder="t('agent.placeholder')"
          @keydown.ctrl.enter.prevent="sendToPlanner"
        ></textarea>
        <button class="agent-send" type="button" :disabled="!canSend" @click="sendToPlanner">
          {{ t('agent.send') }}
        </button>
      </div>

      <div v-if="actionError" class="agent-error">{{ actionError }}</div>
    </div>
  </div>
</template>

<style scoped>
.agent-dock {
  height: var(--mps-agent-dock-height, 260px);
  border-top: 1px solid var(--border-color);
  background: var(--surface-color);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
}

.agent-title {
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-planner {
  font-weight: 500;
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-planner--empty {
  opacity: 0.8;
}

.agent-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.agent-btn {
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: var(--surface-hover);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 12px;
  transition: all var(--transition-fast);
}

.agent-btn:hover:not(:disabled) {
  background: var(--surface-active);
  border-color: var(--text-secondary);
}

.agent-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-btn--toggle {
  color: var(--primary-color);
  border-color: rgba(59, 130, 246, 0.35);
}

.agent-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-color);
}

.agent-panels {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
}

.agent-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.agent-panel--dialog {
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.agent-terminal {
  flex: 1;
  min-height: 0;
}

.agent-terminal-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 12px;
}

.agent-output {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.25);
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
  font-size: 12px;
  line-height: 1.45;
}

.agent-empty {
  color: var(--text-secondary);
  padding: 10px 0;
}

.agent-entry {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.agent-line {
  display: flex;
  gap: 10px;
  align-items: baseline;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-ts {
  color: rgba(255, 255, 255, 0.45);
  flex-shrink: 0;
}

.agent-type {
  color: rgba(255, 255, 255, 0.65);
  flex-shrink: 0;
}

.agent-type--tool_result {
  color: rgba(74, 222, 128, 0.9);
}

.agent-type--risk_confirm,
.agent-type--risk_blocked {
  color: rgba(251, 191, 36, 0.92);
}

.agent-type--planner_send {
  color: rgba(96, 165, 250, 0.9);
}

.agent-detail {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.82);
  overflow-x: auto;
  max-height: 180px;
}

.agent-input {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--surface-color);
}

.agent-textarea {
  flex: 1;
  min-height: 0;
  resize: none;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  background: rgba(0, 0, 0, 0.35);
  color: var(--text-primary);
  outline: none;
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
  font-size: 12px;
}

.agent-textarea:focus {
  border-color: rgba(59, 130, 246, 0.6);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
}

.agent-send {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(59, 130, 246, 0.35);
  background: rgba(59, 130, 246, 0.15);
  color: var(--text-primary);
  font-weight: 800;
  font-size: 12px;
  transition: all var(--transition-fast);
}

.agent-send:hover:not(:disabled) {
  background: rgba(59, 130, 246, 0.25);
  border-color: rgba(96, 165, 250, 0.9);
}

.agent-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-error {
  padding: 8px 16px 12px 16px;
  color: var(--danger-color);
  font-size: 12px;
}
</style>

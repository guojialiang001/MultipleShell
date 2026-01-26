<script setup>
import { ref, watch, computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  config: { type: Object, default: null }
})

const emit = defineEmits(['save', 'cancel'])
const { t } = useI18n()

const form = ref({
  id: null,
  type: '',
  name: '',
  envVars: {}
})

const configJsonText = ref(JSON.stringify({ env: {} }, null, 2))
const claudeSettingsJsonText = ref(JSON.stringify({ env: {} }, null, 2))
const opencodeConfigJsonText = ref('')
const parseError = ref('')
const envJsonError = ref('')
const claudeSettingsJsonError = ref('')
const codexConfigTomlError = ref('')
const codexAuthJsonError = ref('')
const jsonDirty = ref(false)
const claudeSettingsDirty = ref(false)
const opencodeConfigDirty = ref(false)

const codexConfigTomlText = ref('')
const codexAuthJsonText = ref('')
const codexActive = ref('config') // config | auth
const codexPanelOpen = ref(false)

const autosaveState = ref('idle') // idle | saving | saved | error
let autosaveTimer = null
const lastLoadedConfigUpdatedAt = ref(null)

const TYPE_OPTIONS = computed(() => [
  { value: 'claude-code', label: t('configEditor.types.claudeCode') },
  { value: 'codex', label: t('configEditor.types.codex') },
  { value: 'opencode', label: t('configEditor.types.opencode') }
])

const isCodex = computed(() => form.value.type === 'codex')
const isClaudeCode = computed(() => form.value.type === 'claude-code')
const isOpenCode = computed(() => form.value.type === 'opencode')

const getTemplateJsonForType = (type) => {
  return JSON.stringify({ env: {} }, null, 2)
}

const getClaudeSettingsTemplate = () =>
  JSON.stringify(
    {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'your_zhipu_api_key',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1
      }
    },
    null,
    2
  )

const getOpenCodeConfigTemplate = () =>
  JSON.stringify(
    {
      '$schema': 'https://opencode.ai/config.json',
      permission: {
        edit: 'ask',
        bash: 'ask',
        webfetch: 'allow'
      }
    },
    null,
    2
  )

const codexDraftKey = computed(() => {
  if (!isCodex.value) return null
  const id = form.value.id || '__new__'
  return `codex-editor:${id}`
})

const activeCodexText = computed({
  get() {
    return codexActive.value === 'auth' ? codexAuthJsonText.value : codexConfigTomlText.value
  },
  set(v) {
    if (codexActive.value === 'auth') codexAuthJsonText.value = v
    else codexConfigTomlText.value = v
  }
})

const autosaveLabel = computed(() => {
  if (!isCodex.value) return ''
  if (autosaveState.value === 'saving') return t('configEditor.autosave.saving')
  if (autosaveState.value === 'saved') return t('configEditor.autosave.saved')
  if (autosaveState.value === 'error') return t('configEditor.autosave.error')
  return t('configEditor.autosave.idle')
})

const codexSplit = computed(() => isCodex.value && codexPanelOpen.value)

const toggleCodexPanel = (nextActive) => {
  if (!isCodex.value) return
  if (nextActive === 'config' || nextActive === 'auth') codexActive.value = nextActive
  if (!codexPanelOpen.value) {
    codexPanelOpen.value = true
    return
  }
  // If already open, clicking the same section closes; clicking the other switches.
  if (nextActive && nextActive !== codexActive.value) return
  codexPanelOpen.value = false
}

const loadCodexDraftIfNewer = async () => {
  if (!isCodex.value) return
  if (!window?.electronAPI?.draftLoad) return

  const key = codexDraftKey.value
  if (!key) return

  let draft = null
  try {
    draft = await window.electronAPI.draftLoad(key)
  } catch (_) {
    draft = null
  }
  if (!draft || typeof draft !== 'object') return

  const draftUpdatedAt = typeof draft.updatedAt === 'string' ? draft.updatedAt : null
  const baseUpdatedAt = typeof lastLoadedConfigUpdatedAt.value === 'string' ? lastLoadedConfigUpdatedAt.value : null

  const shouldApply =
    !form.value.id || // new template: always restore draft
    (!baseUpdatedAt || (draftUpdatedAt && draftUpdatedAt > baseUpdatedAt))

  if (!shouldApply) return

  const codex = draft.codex && typeof draft.codex === 'object' ? draft.codex : {}
  if (typeof codex.configToml === 'string') codexConfigTomlText.value = codex.configToml
  if (typeof codex.authJson === 'string') codexAuthJsonText.value = codex.authJson

  const layout = draft.layout && typeof draft.layout === 'object' ? draft.layout : {}
  if (layout.active === 'config' || layout.active === 'auth') codexActive.value = layout.active
  if (typeof layout.panelOpen === 'boolean') codexPanelOpen.value = layout.panelOpen
}

const flushAutosave = async () => {
  if (!isCodex.value) return
  if (!window?.electronAPI?.draftSave) return

  const key = codexDraftKey.value
  if (!key) return

  autosaveState.value = 'saving'
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    layout: {
      active: codexActive.value,
      panelOpen: codexPanelOpen.value
    },
    codex: {
      configToml: codexConfigTomlText.value || '',
      authJson: codexAuthJsonText.value || ''
    }
  }

  try {
    await window.electronAPI.draftSave(key, payload)
    autosaveState.value = 'saved'
  } catch (_) {
    autosaveState.value = 'error'
  }
}

const scheduleAutosave = () => {
  if (!isCodex.value) return
  if (!window?.electronAPI?.draftSave) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    flushAutosave()
  }, 2000)
}

watch(
  () => props.config,
  (newConfig) => {
    if (newConfig) {
      form.value = {
        id: newConfig?.id ?? null,
        type: typeof newConfig?.type === 'string' ? newConfig.type : '',
        name: typeof newConfig?.name === 'string' ? newConfig.name : '',
        envVars:
          (newConfig?.envVars && typeof newConfig.envVars === 'object' && !Array.isArray(newConfig.envVars))
            ? newConfig.envVars
            : {}
      }
      lastLoadedConfigUpdatedAt.value = typeof newConfig?.updatedAt === 'string' ? newConfig.updatedAt : null
      const env =
        (newConfig?.envVars && typeof newConfig.envVars === 'object' && !Array.isArray(newConfig.envVars))
          ? newConfig.envVars
          : {}
      configJsonText.value = JSON.stringify({ env }, null, 2)

      const settingsJson =
        typeof newConfig?.claudeSettingsJson === 'string'
          ? newConfig.claudeSettingsJson
          : getClaudeSettingsTemplate()
      claudeSettingsJsonText.value = settingsJson

      const opencodeConfigJson =
        typeof newConfig?.opencodeConfigJson === 'string' ? newConfig.opencodeConfigJson : ''
      opencodeConfigJsonText.value = opencodeConfigJson.trim()
        ? opencodeConfigJson
        : (form.value.type === 'opencode' ? getOpenCodeConfigTemplate() : '')

      codexConfigTomlText.value = typeof newConfig?.codexConfigToml === 'string' ? newConfig.codexConfigToml : ''
      codexAuthJsonText.value = typeof newConfig?.codexAuthJson === 'string' ? newConfig.codexAuthJson : ''
    } else {
      form.value = { id: null, type: '', name: '', envVars: {} }
      lastLoadedConfigUpdatedAt.value = null
      configJsonText.value = JSON.stringify({ env: {} }, null, 2)
      claudeSettingsJsonText.value = getClaudeSettingsTemplate()
      opencodeConfigJsonText.value = ''
      codexConfigTomlText.value = ''
      codexAuthJsonText.value = ''
    }
    parseError.value = ''
    envJsonError.value = ''
    claudeSettingsJsonError.value = ''
    codexConfigTomlError.value = ''
    codexAuthJsonError.value = ''
    jsonDirty.value = false
    claudeSettingsDirty.value = false
    opencodeConfigDirty.value = false
    autosaveState.value = 'idle'

    // If this is Codex, restore a newer local draft (2s autosave target).
    queueMicrotask(() => loadCodexDraftIfNewer())
  },
  { immediate: true }
)

watch(
  () => form.value.type,
  (newType, oldType) => {
    if (!newType) return
    // Only auto-fill when creating a new template and the JSON has not been edited.
    if (form.value.id) return
    if (newType === oldType) return

    if (newType === 'claude-code') {
      if (claudeSettingsDirty.value) return
      claudeSettingsJsonText.value = getClaudeSettingsTemplate()
      claudeSettingsDirty.value = false
      return
    }

    if (newType === 'opencode') {
      if (opencodeConfigDirty.value) return
      opencodeConfigJsonText.value = getOpenCodeConfigTemplate()
      opencodeConfigDirty.value = false
      return
    }

    if (newType === 'codex') return
    if (jsonDirty.value) return
    configJsonText.value = getTemplateJsonForType(newType)
    jsonDirty.value = false
  }
)

watch(isCodex, (nowCodex) => {
  if (nowCodex) queueMicrotask(() => loadCodexDraftIfNewer())
})

watch([codexConfigTomlText, codexAuthJsonText, codexActive], () => {
  if (!isCodex.value) return
  scheduleAutosave()
})

watch(codexPanelOpen, () => {
  if (!isCodex.value) return
  scheduleAutosave()
})

onBeforeUnmount(() => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  // best-effort flush
  flushAutosave()
})

const save = () => {
  parseError.value = ''
  envJsonError.value = ''
  claudeSettingsJsonError.value = ''
  codexConfigTomlError.value = ''
  codexAuthJsonError.value = ''

  if (!form.value.type) {
    parseError.value = t('configEditor.errors.selectType')
    return
  }

  if (!String(form.value.name || '').trim()) {
    parseError.value = t('configEditor.errors.enterName')
    return
  }

  const envVars = (() => {
    // For Codex: hide/remove config JSON editor, keep existing envVars as-is.
    if (form.value.type === 'codex' || form.value.type === 'claude-code' || form.value.type === 'opencode') {
      const existing =
        (form.value.envVars && typeof form.value.envVars === 'object' && !Array.isArray(form.value.envVars))
          ? form.value.envVars
          : {}
      const out = {}
      // Normalize to a plain object to avoid sending reactive proxies over IPC.
      for (const [k, v] of Object.entries(existing)) {
        const key = String(k).trim()
        if (!key) continue
        out[key] = v == null ? '' : String(v)
      }
      return out
    }

    let parsed = { env: {} }
    try {
      const raw = (configJsonText.value || '').trim()
      parsed = raw ? JSON.parse(raw) : { env: {} }
    } catch (e) {
      envJsonError.value = t('configEditor.errors.invalidJson', { message: e?.message || e })
      return null
    }

    const envCandidate =
      (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed.env ?? parsed.ENV)
        : null

    if (!envCandidate) {
      envJsonError.value = t('configEditor.errors.envRequired')
      return null
    }

    if (typeof envCandidate !== 'object' || Array.isArray(envCandidate)) {
      envJsonError.value = t('configEditor.errors.envMustBeObject')
      return null
    }

    const out = {}
    for (const [k, v] of Object.entries(envCandidate)) {
      const key = String(k).trim()
      if (!key) continue
      out[key] = v == null ? '' : String(v)
    }
    return out
  })()

  if (envVars == null) return

  let claudeSettingsJson = ''
  if (form.value.type === 'claude-code') {
    let raw = String(claudeSettingsJsonText.value || '').trim()
    if (!raw) raw = '{}'
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        claudeSettingsJsonError.value = t('configEditor.errors.claudeSettingsJsonMustBeObject')
        return
      }
    } catch (e) {
      claudeSettingsJsonError.value = t('configEditor.errors.claudeSettingsJsonInvalid', { message: e?.message || e })
      return
    }
    claudeSettingsJson = raw
  }

  if (form.value.type === 'codex') {
    const toml = String(codexConfigTomlText.value || '').trim()
    const auth = String(codexAuthJsonText.value || '').trim()

    if (!toml) {
      codexConfigTomlError.value = t('configEditor.errors.codexConfigTomlRequired')
      return
    }

    if (!auth) {
      codexAuthJsonError.value = t('configEditor.errors.codexAuthJsonRequired')
      return
    }

    try {
      JSON.parse(auth)
    } catch (e) {
      codexAuthJsonError.value = t('configEditor.errors.codexAuthJsonInvalid', { message: e?.message || e })
      return
    }
  }

  const opencodeConfigJson =
    form.value.type === 'opencode'
      ? (String(opencodeConfigJsonText.value || '').trim() || getOpenCodeConfigTemplate())
      : (typeof opencodeConfigJsonText.value === 'string' ? opencodeConfigJsonText.value : '')

  emit('save', {
    ...form.value,
    envVars,
    claudeSettingsJson,
    codexConfigToml: codexConfigTomlText.value || '',
    codexAuthJson: codexAuthJsonText.value || '',
    opencodeConfigJson
  })
}
</script>

<template>
  <div class="config-editor" :class="{ 'is-codex': isCodex, 'is-codex-expanded': codexSplit }">
    <div class="header">
        <h3>{{ config ? t('configEditor.titleEdit') : t('configEditor.titleNew') }}</h3>
    </div>
    
    <div class="content-body" :class="{ 'codex-split': codexSplit }">
      <div class="left-pane">
          <div class="form-group">
          <label>{{ t('configEditor.type') }}</label>
          <div class="select-wrapper">
              <select v-model="form.type" class="select">
                  <option value="" disabled>{{ t('configEditor.selectType') }}</option>
                  <option v-for="opt in TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <div class="select-arrow">
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
              </div>
          </div>
          </div>

          <div class="form-group">
          <label>{{ t('configEditor.name') }}</label>
          <input v-model="form.name" type="text" :placeholder="t('configEditor.placeholders.name')" />
          </div>

          <div v-if="!isCodex && !isClaudeCode && !isOpenCode" class="form-group">
            <label>{{ t('configEditor.configJson') }}</label>
            <textarea
                v-model="configJsonText"
                @input="jsonDirty = true"
                placeholder='{\n  "env": {\n    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",\n    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.7"\n  }\n}'
                rows="10"
                class="code-input"
            ></textarea>
            <div v-if="envJsonError" class="error">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                {{ envJsonError }}
            </div>
          </div>

          <div v-if="isOpenCode" class="form-group">
            <label>{{ t('configEditor.opencodeConfigJson') }}</label>
            <textarea
              v-model="opencodeConfigJsonText"
              @input="opencodeConfigDirty = true"
              placeholder='{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": {\n    "edit": "ask",\n    "bash": "ask",\n    "webfetch": "allow"\n  }\n}'
              rows="10"
              class="code-input"
            ></textarea>
          </div>

          <div v-if="isClaudeCode" class="form-group">
            <label>{{ t('configEditor.claudeSettingsJson') }}</label>
            <textarea
              v-model="claudeSettingsJsonText"
              @input="claudeSettingsDirty = true"
              placeholder='{\n  "env": {\n    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",\n    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.7"\n  }\n}'
              rows="10"
              class="code-input"
            ></textarea>
            <div v-if="claudeSettingsJsonError" class="error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              {{ claudeSettingsJsonError }}
            </div>
          </div>

          <div v-if="isCodex" class="form-group">
            <div class="label-row">
              <label>{{ t('configEditor.codexConfigToml') }}</label>
              <button
                type="button"
                class="codex-panel-btn"
                :class="{ active: codexPanelOpen && codexActive === 'config' }"
                :title="codexPanelOpen ? t('configEditor.panel.collapse') : t('configEditor.panel.expand')"
                @click="toggleCodexPanel('config')"
              >
                <span v-if="!codexPanelOpen" aria-hidden="true">⤢</span>
                <span v-else aria-hidden="true">⤡</span>
              </button>
            </div>
            <textarea
              v-model="codexConfigTomlText"
              rows="6"
              class="code-input"
              @focus="codexActive = 'config'"
            ></textarea>
            <div v-if="codexConfigTomlError" class="error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              {{ codexConfigTomlError }}
            </div>
          </div>

          <div v-if="isCodex" class="form-group">
            <div class="label-row">
              <label>{{ t('configEditor.codexAuthJson') }}</label>
              <button
                type="button"
                class="codex-panel-btn"
                :class="{ active: codexPanelOpen && codexActive === 'auth' }"
                :title="codexPanelOpen ? t('configEditor.panel.collapse') : t('configEditor.panel.expand')"
                @click="toggleCodexPanel('auth')"
              >
                <span v-if="!codexPanelOpen" aria-hidden="true">⤢</span>
                <span v-else aria-hidden="true">⤡</span>
              </button>
            </div>
            <textarea
              v-model="codexAuthJsonText"
              rows="6"
              class="code-input"
              @focus="codexActive = 'auth'"
            ></textarea>
            <div v-if="codexAuthJsonError" class="error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              {{ codexAuthJsonError }}
            </div>
          </div>

          <div v-if="isCodex" class="autosave-inline">{{ autosaveLabel }}</div>

          <div v-if="parseError" class="error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              {{ parseError }}
          </div>
      </div>

      <div v-if="codexSplit" class="right-pane">
        <div class="right-pane-header">
          <div class="right-tabs">
            <button
              type="button"
              class="tab"
              :class="{ active: codexActive === 'config' }"
              @click="codexActive = 'config'"
            >config.toml</button>
            <button
              type="button"
              class="tab"
              :class="{ active: codexActive === 'auth' }"
              @click="codexActive = 'auth'"
            >auth.json</button>
          </div>
          <button type="button" class="codex-panel-btn" :title="t('configEditor.panel.collapse')" @click="codexPanelOpen = false">
            <span aria-hidden="true">⤡</span>
          </button>
        </div>
        <textarea
          v-model="activeCodexText"
          rows="18"
          class="code-input codex-large"
        ></textarea>
      </div>
    </div>

    <div class="footer-actions">
      <button @click="emit('cancel')" class="btn-secondary">{{ t('configEditor.cancel') }}</button>
      <button @click="save" class="btn-primary">{{ t('configEditor.saveConfiguration') }}</button>
    </div>
  </div>
</template>

<style scoped>
.config-editor {
  background: var(--surface-color);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  min-width: 500px;
  overflow: hidden;
}

.config-editor.is-codex-expanded {
  min-width: 980px;
  width: min(1100px, 90vw);
}

.header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--surface-hover);
}

h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}

.content-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
}

.content-body.codex-split {
  padding: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.left-pane,
.right-pane {
  padding: 20px;
  overflow-y: auto;
}

.right-pane {
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.right-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.right-tabs {
  display: flex;
  gap: 8px;
}

.tab {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.tab:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.tab.active {
  border-color: var(--primary-color);
  color: var(--text-primary);
  background: rgba(59, 130, 246, 0.12);
}

.autosave-state {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.label-row label {
  margin-bottom: 0;
}

.codex-panel-btn {
  width: 32px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.85);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}

.codex-panel-btn:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.16);
  transform: translateY(-1px);
}

.codex-panel-btn.active {
  background: rgba(59, 130, 246, 0.18);
  border-color: rgba(59, 130, 246, 0.45);
  color: rgba(255, 255, 255, 0.95);
}

.codex-panel-btn:active {
  transform: translateY(0);
}

.autosave-inline {
  margin-top: -10px;
  margin-bottom: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.form-group {
  margin-bottom: 20px;
}

label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
}

input,
textarea,
.select {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}

input:focus,
textarea:focus,
.select:focus {
  border-color: var(--primary-color);
}

.select-wrapper {
    position: relative;
}

.select {
    appearance: none;
    cursor: pointer;
}

.select-arrow {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--text-secondary);
}

.code-input {
  resize: vertical;
  font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.5;
}

.codex-large {
  resize: none;
  flex: 1;
  min-height: 420px;
}

.error {
  margin-top: 8px;
  color: var(--danger-color);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(239, 68, 68, 0.1);
  padding: 8px;
  border-radius: var(--radius-sm);
}

.footer-actions {
    padding: 16px 20px;
    background: var(--surface-hover);
    border-top: 1px solid var(--border-color);
    display: flex;
    justify-content: flex-end;
    gap: 12px;
}

.btn-primary {
  background: var(--primary-color);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 8px 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--surface-hover);
  border-color: var(--text-secondary);
}
</style>

<script setup>
import { ref, watch, computed, onBeforeUnmount, onMounted, onUnmounted } from 'vue'
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
  envVars: {},
  importSource: '',
  useCCSwitch: false,
  useCCSwitchProxy: false,
  proxyEnabled: false,
  proxyImplementation: 'app',
  respectCCSwitchProxyConfig: true,
  proxyQueueMode: 'failover-queue',
  proxyAllowProviderIdsText: '',
  proxyDenyProviderIdsText: '',
  appFailoverEnabled: true,
  appBreakerEnabled: true,
  breakerConfig: {},
  retryConfig: {},
  ccSwitchProviderId: ''
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
const codexActive = ref('config')
const codexPanelOpen = ref(false)

const autosaveState = ref('idle')
let autosaveTimer = null
const lastLoadedConfigUpdatedAt = ref(null)

const isDropdownOpen = ref(false)
const dropdownRef = ref(null)

const TYPE_OPTIONS = computed(() => [
  { value: 'claude-code', label: t('configEditor.types.claudeCode') },
  { value: 'codex', label: t('configEditor.types.codex') },
  { value: 'opencode', label: t('configEditor.types.opencode') }
])

const selectedTypeLabel = computed(() => {
  const opt = TYPE_OPTIONS.value.find(o => o.value === form.value.type)
  return opt ? opt.label : t('configEditor.selectType')
})

const VALID_PROXY_IMPLEMENTATIONS = new Set(['off', 'app', 'ccswitch'])
const VALID_PROXY_QUEUE_MODES = new Set(['failover-queue', 'all-providers', 'custom'])

const normalizeIdList = (value) => {
  const out = []
  const seen = new Set()
  const chunks = String(value || '').split(/[,;\n]/g)
  for (const chunk of chunks) {
    const id = String(chunk || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const toggleDropdown = () => {
  isDropdownOpen.value = !isDropdownOpen.value
}

const selectType = (value) => {
  form.value.type = value
  isDropdownOpen.value = false
}

const closeDropdown = (e) => {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
    isDropdownOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', closeDropdown)
})

onUnmounted(() => {
  document.removeEventListener('click', closeDropdown)
})

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
    {},
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
            : {},
        importSource: typeof newConfig?.importSource === 'string' ? newConfig.importSource : '',
        useCCSwitch: Boolean(newConfig?.useCCSwitch),
        useCCSwitchProxy: Boolean(newConfig?.useCCSwitchProxy),
        proxyEnabled:
          newConfig?.proxyEnabled == null ? Boolean(newConfig?.useCCSwitchProxy) : Boolean(newConfig?.proxyEnabled),
        proxyImplementation: (() => {
          const raw = String(newConfig?.proxyImplementation || '').trim().toLowerCase()
          if (VALID_PROXY_IMPLEMENTATIONS.has(raw)) return raw
          return Boolean(newConfig?.useCCSwitchProxy) ? 'ccswitch' : 'app'
        })(),
        respectCCSwitchProxyConfig: newConfig?.respectCCSwitchProxyConfig === false ? false : true,
        proxyQueueMode: (() => {
          const raw = String(newConfig?.proxyQueueMode || '').trim().toLowerCase()
          return VALID_PROXY_QUEUE_MODES.has(raw) ? raw : 'failover-queue'
        })(),
        proxyAllowProviderIdsText:
          Array.isArray(newConfig?.proxyAllowProviderIds) ? newConfig.proxyAllowProviderIds.join(', ') : '',
        proxyDenyProviderIdsText:
          Array.isArray(newConfig?.proxyDenyProviderIds) ? newConfig.proxyDenyProviderIds.join(', ') : '',
        appFailoverEnabled:
          newConfig?.appFailoverEnabled == null ? true : Boolean(newConfig?.appFailoverEnabled),
        appBreakerEnabled:
          newConfig?.appBreakerEnabled == null ? true : Boolean(newConfig?.appBreakerEnabled),
        breakerConfig:
          newConfig?.breakerConfig && typeof newConfig.breakerConfig === 'object' && !Array.isArray(newConfig.breakerConfig)
            ? { ...newConfig.breakerConfig }
            : {},
        retryConfig:
          newConfig?.retryConfig && typeof newConfig.retryConfig === 'object' && !Array.isArray(newConfig.retryConfig)
            ? { ...newConfig.retryConfig }
            : {},
        ccSwitchProviderId: typeof newConfig?.ccSwitchProviderId === 'string' ? newConfig.ccSwitchProviderId : ''
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
      form.value = {
        id: null,
        type: '',
        name: '',
        envVars: {},
        importSource: '',
        useCCSwitch: false,
        useCCSwitchProxy: false,
        proxyEnabled: false,
        proxyImplementation: 'app',
        respectCCSwitchProxyConfig: true,
        proxyQueueMode: 'failover-queue',
        proxyAllowProviderIdsText: '',
        proxyDenyProviderIdsText: '',
        appFailoverEnabled: true,
        appBreakerEnabled: true,
        breakerConfig: {},
        retryConfig: {},
        ccSwitchProviderId: ''
      }
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
  () => form.value.proxyEnabled,
  (v) => {
    if (v) form.value.useCCSwitch = true
    form.value.useCCSwitchProxy = Boolean(v) && form.value.proxyImplementation === 'ccswitch'
  }
)

watch(
  () => form.value.proxyImplementation,
  (v) => {
    const normalized = VALID_PROXY_IMPLEMENTATIONS.has(String(v || '').trim().toLowerCase())
      ? String(v || '').trim().toLowerCase()
      : 'app'
    if (normalized !== v) form.value.proxyImplementation = normalized
    form.value.useCCSwitchProxy = form.value.proxyEnabled && normalized === 'ccswitch'
  }
)

watch(
  () => form.value.useCCSwitch,
  (v) => {
    if (!v) {
      form.value.proxyEnabled = false
      form.value.useCCSwitchProxy = false
    }
  }
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

  const proxyEnabled = Boolean(form.value.proxyEnabled)
  const proxyImplementation = VALID_PROXY_IMPLEMENTATIONS.has(String(form.value.proxyImplementation || '').trim().toLowerCase())
    ? String(form.value.proxyImplementation || '').trim().toLowerCase()
    : 'app'
  const useCCSwitchProxy = proxyEnabled && proxyImplementation === 'ccswitch'
  const useCCSwitch = Boolean(form.value.useCCSwitch) || proxyEnabled

  emit('save', {
    ...form.value,
    useCCSwitch,
    useCCSwitchProxy,
    proxyEnabled,
    proxyImplementation,
    respectCCSwitchProxyConfig: form.value.respectCCSwitchProxyConfig !== false,
    proxyQueueMode: VALID_PROXY_QUEUE_MODES.has(String(form.value.proxyQueueMode || '').trim().toLowerCase())
      ? String(form.value.proxyQueueMode || '').trim().toLowerCase()
      : 'failover-queue',
    proxyAllowProviderIds: normalizeIdList(form.value.proxyAllowProviderIdsText),
    proxyDenyProviderIds: normalizeIdList(form.value.proxyDenyProviderIdsText),
    appFailoverEnabled: Boolean(form.value.appFailoverEnabled),
    appBreakerEnabled: Boolean(form.value.appBreakerEnabled),
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
          <div class="custom-select" ref="dropdownRef">
            <div class="select-trigger" @click="toggleDropdown" :class="{ active: isDropdownOpen }">
              <span class="select-value" :class="{ placeholder: !form.type }">{{ selectedTypeLabel }}</span>
              <svg class="select-arrow" :class="{ open: isDropdownOpen }" width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <Transition name="dropdown">
              <div v-if="isDropdownOpen" class="dropdown-menu">
                <div 
                  class="dropdown-item" 
                  v-for="opt in TYPE_OPTIONS" 
                  :key="opt.value"
                  :class="{ selected: form.type === opt.value }"
                  @click="selectType(opt.value)"
                >
                  <span class="item-label">{{ opt.label }}</span>
                  <svg v-if="form.type === opt.value" class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </div>
            </Transition>
          </div>
          </div>

          <div class="form-group">
           <label>{{ t('configEditor.name') }}</label>
           <input v-model="form.name" type="text" :placeholder="t('configEditor.placeholders.name')" />
           </div>

          <div class="form-group">
            <label>{{ t('configEditor.ccSwitchTitle') }}</label>
            <div class="check-row">
              <label class="check-item">
                <input v-model="form.useCCSwitch" type="checkbox" />
                <span>{{ t('configSelector.useCCSwitch') }}</span>
              </label>
              <label class="check-item">
                <input v-model="form.proxyEnabled" type="checkbox" :disabled="!form.useCCSwitch" />
                <span>{{ t('configEditor.proxyEnabled') }}</span>
              </label>
            </div>

            <div class="inline-grid">
              <div class="inline-field">
                <label>{{ t('configEditor.proxyImplementation') }}</label>
                <select v-model="form.proxyImplementation" :disabled="!form.useCCSwitch || !form.proxyEnabled">
                  <option value="app">{{ t('configEditor.proxyImplementationApp') }}</option>
                  <option value="ccswitch">{{ t('configEditor.proxyImplementationCCSwitch') }}</option>
                  <option value="off">{{ t('configEditor.proxyImplementationOff') }}</option>
                </select>
              </div>
              <div class="inline-field">
                <label>{{ t('configEditor.proxyQueueMode') }}</label>
                <select v-model="form.proxyQueueMode" :disabled="!form.useCCSwitch || !form.proxyEnabled">
                  <option value="failover-queue">{{ t('configEditor.proxyQueueModeFailoverQueue') }}</option>
                  <option value="all-providers">{{ t('configEditor.proxyQueueModeAllProviders') }}</option>
                  <option value="custom">{{ t('configEditor.proxyQueueModeCustom') }}</option>
                </select>
              </div>
            </div>

            <label class="check-item">
              <input
                v-model="form.respectCCSwitchProxyConfig"
                type="checkbox"
                :disabled="!form.useCCSwitch || !form.proxyEnabled"
              />
              <span>{{ t('configEditor.respectCCSwitchProxyConfig') }}</span>
            </label>

            <div class="inline-grid">
              <div class="inline-field">
                <label>{{ t('configEditor.proxyAllowProviderIds') }}</label>
                <input
                  v-model="form.proxyAllowProviderIdsText"
                  type="text"
                  :placeholder="t('configEditor.providerIdListPlaceholder')"
                  :disabled="!form.useCCSwitch || !form.proxyEnabled"
                />
              </div>
              <div class="inline-field">
                <label>{{ t('configEditor.proxyDenyProviderIds') }}</label>
                <input
                  v-model="form.proxyDenyProviderIdsText"
                  type="text"
                  :placeholder="t('configEditor.providerIdListPlaceholder')"
                  :disabled="!form.useCCSwitch || !form.proxyEnabled"
                />
              </div>
            </div>

            <div class="check-row">
              <label class="check-item">
                <input v-model="form.appFailoverEnabled" type="checkbox" :disabled="!form.useCCSwitch || !form.proxyEnabled" />
                <span>{{ t('configEditor.appFailoverEnabled') }}</span>
              </label>
              <label class="check-item">
                <input v-model="form.appBreakerEnabled" type="checkbox" :disabled="!form.useCCSwitch || !form.proxyEnabled" />
                <span>{{ t('configEditor.appBreakerEnabled') }}</span>
              </label>
            </div>

            <div class="inline-field">
              <label>{{ t('configEditor.ccSwitchProviderId') }}</label>
              <input
                v-model="form.ccSwitchProviderId"
                type="text"
                :placeholder="t('configEditor.ccSwitchProviderIdPlaceholder')"
                :disabled="!form.useCCSwitch"
              />
            </div>
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
              placeholder='{}'
              rows="10"
              class="code-input"
            ></textarea>
            <div class="form-hint">{{ t('configEditor.opencodeLocalOverrideHint') }}</div>
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
  border-radius: var(--radius-md);
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

.form-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
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

.check-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}

.check-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 0;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.check-item input[type="checkbox"] {
  width: auto;
  margin: 0;
  padding: 0;
}

.inline-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
}

.inline-field {
  margin-bottom: 10px;
}

.inline-field label {
  margin-bottom: 6px;
}

.custom-select {
  position: relative;
  width: 100%;
  z-index: 100;
}

.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.select-trigger:hover {
  border-color: var(--primary-color);
  background: var(--surface-hover);
}

.select-trigger.active {
  border-color: var(--primary-color);
  background: var(--bg-color);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.select-value {
  color: var(--text-primary);
  font-size: 13px;
}

.select-value.placeholder {
  color: var(--text-secondary);
}

.select-arrow {
  color: var(--text-secondary);
  transition: transform 0.2s ease;
}

.select-arrow.open {
  transform: rotate(180deg);
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  z-index: 100;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  color: var(--text-secondary);
  font-size: 13px;
}

.dropdown-item:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.dropdown-item.selected {
  background: rgba(59, 130, 246, 0.15);
  color: var(--primary-color);
  font-weight: 500;
}

.item-label {
  flex: 1;
}

.check-icon {
  color: var(--primary-color);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

input,
textarea,
select,
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
select:focus,
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

.select option {
  background: var(--bg-color);
  color: var(--text-primary);
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.4;
}

.select option:disabled {
  color: var(--text-secondary);
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
  color: #f87171;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.footer-actions {
    padding: 16px 20px;
    background: transparent;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: flex-end;
    gap: 12px;
}

.btn-primary {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 4px rgba(37, 99, 235, 0.3);
}

.btn-primary:hover {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(37, 99, 235, 0.4);
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 10px 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-color: var(--border-accent);
}

@media (max-width: 780px) {
  .inline-grid {
    grid-template-columns: 1fr;
  }
}
</style>

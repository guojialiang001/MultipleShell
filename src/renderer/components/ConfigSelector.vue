<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfigEditor from './ConfigEditor.vue'
import {
  resolveCCSwitchProxyStatus,
  pickDefaultCCSwitchTemplate,
  computeFailoverPriorityByProviderId
} from '../utils/ccswitch-status.mjs'

const props = defineProps({
  mode: { type: String, default: 'create' }, // create | manage | edit
  configTemplates: { type: Array, required: true },
  currentTabConfig: { type: Object, default: null }
})

const emit = defineEmits(['create', 'update', 'saveTemplate', 'deleteTemplate', 'close', 'switchMode', 'importFromCCSwitch'])
const { t } = useI18n()

const selectedConfig = ref(null)
const customWorkingDir = ref('')
const showEditor = ref(false)
const editingConfig = ref(null)
const isSelectingFolder = ref(false)
const showDeleteConfirm = ref(false)
const showImportConfirm = ref(false)
const deleteCandidate = ref(null)
const activeType = ref('claude-code')

const normalizeType = (type) => (typeof type === 'string' ? type.trim().toLowerCase() : '')
const TYPE_ORDER = ['claude-code', 'codex', 'opencode']

const ONLY_CCSWITCH_CONFIGS_KEY = 'mps.selectTemplate.onlyCCSwitchConfigs'
const LEGACY_ONLY_CCSWITCH_CONFIGS_KEY = 'mps.manageTemplates.onlyCCSwitchConfigs'
const CCSWITCH_AUTODETECT_KEY = 'mps.selectTemplate.ccswitchAutoDetect'

const readBool = (key, fallback = false) => {
  try {
    const raw = String(localStorage.getItem(key) ?? '').trim().toLowerCase()
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
    return fallback
  } catch (_) {
    return fallback
  }
}

const writeBool = (key, value) => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch (_) {}
}

const onlyCCSwitchConfigs = ref(readBool(ONLY_CCSWITCH_CONFIGS_KEY, readBool(LEGACY_ONLY_CCSWITCH_CONFIGS_KEY, true)))
const autoDetectCCSwitchStatus = ref(readBool(CCSWITCH_AUTODETECT_KEY, true))

const ccSwitchDetectState = ref('idle') // idle | loading | ready | error
const ccSwitchProxyEnabled = ref(null) // boolean | null
const ccSwitchFailoverEnabled = ref(null) // boolean | null
const ccSwitchFailoverPriorityById = ref({}) // { [providerId]: number }
const ccSwitchProxyAddress = ref('') // string
const ccSwitchRequestLogPath = ref('') // string
const ccSwitchRecentRequests = ref([]) // Array<{ appType: string, path: string, raw: string }>
const ccSwitchDetectError = ref('')

const resolveProxyAppKeyForType = (type) => {
  const t = normalizeType(type)
  if (t === 'claude-code') return 'claude'
  if (t === 'codex') return 'codex'
  // OpenCode uses Codex proxy settings in CC Switch.
  if (t === 'opencode') return 'codex'
  return null
}

const resetCCSwitchStatus = () => {
  ccSwitchDetectState.value = 'idle'
  ccSwitchProxyEnabled.value = null
  ccSwitchFailoverEnabled.value = null
  ccSwitchFailoverPriorityById.value = {}
  ccSwitchProxyAddress.value = ''
  ccSwitchRequestLogPath.value = ''
  ccSwitchRecentRequests.value = []
  ccSwitchDetectError.value = ''
}

const normalizeProxyHost = (host) => {
  const raw = String(host || '').trim()
  if (!raw) return '127.0.0.1'
  const lower = raw.toLowerCase()
  if (lower === '0.0.0.0' || lower === '::' || lower === '[::]') return '127.0.0.1'
  return raw
}

const buildProxyOrigin = (host, port) => {
  const safeHost = normalizeProxyHost(host)
  const p = Number(port)
  const safePort = Number.isFinite(p) && p > 0 ? p : 15721
  const hostPart = safeHost.includes(':') && !safeHost.startsWith('[') ? `[${safeHost}]` : safeHost
  return `http://${hostPart}:${safePort}`
}

const resolveProviderAppKeyForType = (type) => {
  const t = normalizeType(type)
  if (t === 'claude-code') return 'claude'
  if (t === 'codex') return 'codex'
  if (t === 'opencode') return 'opencode'
  return null
}

const refreshCCSwitchStatus = async () => {
  if (props.mode !== 'create') return
  if (!autoDetectCCSwitchStatus.value) return
  if (ccSwitchDetectState.value === 'loading') return

  const api = window?.electronAPI
  if (!api?.ccSwitchListProviders) {
    ccSwitchDetectState.value = 'error'
    ccSwitchDetectError.value = 'Missing electronAPI.ccSwitchListProviders'
    return
  }

  ccSwitchDetectState.value = 'loading'
  ccSwitchDetectError.value = ''

  try {
    const snapshot = await api.ccSwitchListProviders()
    const proxyAppKey = resolveProxyAppKeyForType(activeType.value)
    const proxyCfg = proxyAppKey ? snapshot?.proxy?.[proxyAppKey] : null

    const { proxyEnabled, failoverEnabled } = resolveCCSwitchProxyStatus(proxyCfg)
    ccSwitchProxyEnabled.value = proxyEnabled
    ccSwitchFailoverEnabled.value = failoverEnabled
    ccSwitchProxyAddress.value = proxyCfg ? buildProxyOrigin(proxyCfg.listenAddress, proxyCfg.listenPort) : ''

    const providerAppKey = resolveProviderAppKeyForType(activeType.value)
    const providers = providerAppKey ? snapshot?.apps?.[providerAppKey]?.providers : null
    ccSwitchFailoverPriorityById.value = computeFailoverPriorityByProviderId(providers)

    ccSwitchDetectState.value = 'ready'
  } catch (err) {
    ccSwitchDetectState.value = 'error'
    ccSwitchProxyEnabled.value = null
    ccSwitchFailoverEnabled.value = null
    ccSwitchFailoverPriorityById.value = {}
    ccSwitchProxyAddress.value = ''
    ccSwitchDetectError.value = err?.message ? String(err.message) : String(err || 'Unknown error')
  }
}

const ccSwitchRequestsState = ref('idle') // idle | loading | ready | error
let ccSwitchRequestsTimer = null

const stopCCSwitchRequestsPolling = () => {
  if (!ccSwitchRequestsTimer) return
  clearInterval(ccSwitchRequestsTimer)
  ccSwitchRequestsTimer = null
}

const refreshCCSwitchRecentRequests = async () => {
  if (props.mode !== 'create') return
  if (!autoDetectCCSwitchStatus.value) return
  if (ccSwitchRequestsState.value === 'loading') return

  const api = window?.electronAPI
  if (!api?.ccSwitchTailRequestPaths) return

  ccSwitchRequestsState.value = 'loading'
  try {
    const result = await api.ccSwitchTailRequestPaths({ limit: 30 })
    ccSwitchRequestLogPath.value = typeof result?.logPath === 'string' ? result.logPath : ''
    ccSwitchRecentRequests.value = Array.isArray(result?.lines) ? result.lines : []
    ccSwitchRequestsState.value = 'ready'
  } catch (_) {
    ccSwitchRequestsState.value = 'error'
  }
}

const CCSWITCH_REQUESTS_POLL_MS = 2000
const startCCSwitchRequestsPolling = () => {
  stopCCSwitchRequestsPolling()
  ccSwitchRequestsTimer = setInterval(() => {
    refreshCCSwitchRecentRequests()
  }, CCSWITCH_REQUESTS_POLL_MS)
}

watch(
  [() => props.mode, autoDetectCCSwitchStatus],
  ([mode, autoDetect]) => {
    if (mode === 'create' && autoDetect) startCCSwitchRequestsPolling()
    else stopCCSwitchRequestsPolling()
  },
  { immediate: true }
)

const typeTabs = computed(() => [
  { value: 'claude-code', label: t('configEditor.types.claudeCode') },
  { value: 'codex', label: t('configEditor.types.codex') },
  { value: 'opencode', label: t('configEditor.types.opencode') }
])

const filteredTemplates = computed(() => {
  const current = normalizeType(activeType.value)
  const list = (props.configTemplates || []).filter((cfg) => normalizeType(cfg?.type) === current)

  // Only apply CC Switch visibility filters in create mode (select template).
  if (props.mode !== 'create') return list
  if (!onlyCCSwitchConfigs.value) return list

  return list.filter((cfg) => Boolean(cfg?.useCCSwitch) || Boolean(cfg?.useCCSwitchProxy))
})

const getVisibleTemplatesForType = (templates, type) => {
  const current = normalizeType(type)
  const list = (Array.isArray(templates) ? templates : []).filter((cfg) => normalizeType(cfg?.type) === current)

  if (props.mode !== 'create') return list
  if (!onlyCCSwitchConfigs.value) return list

  return list.filter((cfg) => Boolean(cfg?.useCCSwitch) || Boolean(cfg?.useCCSwitchProxy))
}

const canAutoPickCCSwitchTemplate = computed(() => {
  if (props.mode !== 'create') return false
  if (!onlyCCSwitchConfigs.value) return false
  return ccSwitchProxyEnabled.value === true && ccSwitchFailoverEnabled.value === true
})

const autoPickCandidate = computed(() => pickDefaultCCSwitchTemplate(filteredTemplates.value))

const isCCSwitchImportedConfig = (cfg) => {
  if (!cfg || typeof cfg !== 'object') return false
  if (cfg.importSource === 'ccswitch') return true
  const id = typeof cfg.id === 'string' ? cfg.id : ''
  const providerId = typeof cfg.ccSwitchProviderId === 'string' ? cfg.ccSwitchProviderId.trim() : ''
  return id.startsWith('ccswitch-') && Boolean(providerId)
}

const getCCSwitchPriorityTag = (cfg) => {
  if (!canAutoPickCCSwitchTemplate.value) return ''
  if (!cfg || typeof cfg !== 'object') return ''
  if (!cfg.useCCSwitch && !cfg.useCCSwitchProxy) return ''
  const id = typeof cfg.ccSwitchProviderId === 'string' ? cfg.ccSwitchProviderId.trim() : ''
  if (!id) return ''
  const p = ccSwitchFailoverPriorityById.value?.[id]
  if (!Number.isFinite(p) || p <= 0) return ''
  return `P${p}`
}

watch(
  () => props.mode,
  () => {
    showEditor.value = false
    editingConfig.value = null
    selectedConfig.value = null
    customWorkingDir.value = ''
    activeType.value = 'claude-code'
    showDeleteConfirm.value = false
    deleteCandidate.value = null
  }
)

watch(onlyCCSwitchConfigs, (v) => {
  writeBool(ONLY_CCSWITCH_CONFIGS_KEY, Boolean(v))

  if (props.mode !== 'create') return
  if (!v) return

  const cfg = selectedConfig.value
  if (!cfg) return
  const isCCSwitch = Boolean(cfg?.useCCSwitch) || Boolean(cfg?.useCCSwitchProxy)
  if (!isCCSwitch) selectedConfig.value = null
})

watch(autoDetectCCSwitchStatus, async (v) => {
  writeBool(CCSWITCH_AUTODETECT_KEY, Boolean(v))
  if (!v) {
    resetCCSwitchStatus()
    return
  }
  await refreshCCSwitchStatus()
})

watch(
  [() => props.configTemplates, () => props.mode, onlyCCSwitchConfigs],
  ([templates]) => {
    // Auto-switch the type tab when the current one has no visible templates.
    // This avoids forcing the user to click a "system/type" tab when "Only CC Switch configs" is enabled.
    if (props.mode !== 'create') return

    const currentVisible = getVisibleTemplatesForType(templates, activeType.value)
    if (currentVisible.length > 0) return

    const nextType = TYPE_ORDER.find((t) => getVisibleTemplatesForType(templates, t).length > 0) || null
    if (!nextType) return

    if (normalizeType(nextType) !== normalizeType(activeType.value)) {
      activeType.value = nextType
    }
  },
  { immediate: true, deep: true }
)

watch(activeType, () => {
  selectedConfig.value = null
  refreshCCSwitchStatus()
})

watch(
  [canAutoPickCCSwitchTemplate, autoPickCandidate],
  ([canAutoPick, candidate]) => {
    if (!canAutoPick) return
    if (!candidate) return
    if (selectedConfig.value) return
    selectedConfig.value = candidate
  },
  { immediate: true }
)

watch(
  () => props.currentTabConfig,
  (newConfig) => {
    if (newConfig && props.mode === 'edit') {
      editingConfig.value = { ...newConfig }
      showEditor.value = true
    }
  },
  { immediate: true }
)

const selectFolder = async () => {
  if (isSelectingFolder.value) return
  isSelectingFolder.value = true
  try {
    const result = await window.electronAPI.selectFolder()
    if (result) customWorkingDir.value = result
  } finally {
    isSelectingFolder.value = false
  }
}

const toPlain = (obj) => {
  try {
    return structuredClone(obj)
  } catch (_) {
    return JSON.parse(JSON.stringify(obj))
  }
}

const createTerminal = () => {
  const cfg = selectedConfig.value || autoPickCandidate.value
  if (!cfg) return
  emit('create', toPlain(cfg), customWorkingDir.value)
}

const saveConfig = async (config) => {
  if (props.mode === 'edit') {
    emit('update', config)
  } else if (props.mode === 'manage') {
    await emit('saveTemplate', config)
  } else {
    emit('create', toPlain(config), customWorkingDir.value)
  }
  showEditor.value = false
}

const addTemplate = () => {
  editingConfig.value = {
    id: null,
    type: activeType.value,
    name: '',
    envVars: {},
    useCCSwitch: false,
    useCCSwitchProxy: false,
    ccSwitchProviderId: ''
  }
  showEditor.value = true
}

const editTemplate = (template) => {
  editingConfig.value = { ...template }
  showEditor.value = true
}

const deleteTemplate = (template) => {
  deleteCandidate.value = template
  showDeleteConfirm.value = true
}

const cancelDeleteTemplate = () => {
  showDeleteConfirm.value = false
  deleteCandidate.value = null
}

const confirmDeleteTemplate = async () => {
  if (!deleteCandidate.value) return
  await emit('deleteTemplate', deleteCandidate.value.id)
  cancelDeleteTemplate()
}

const promptImportFromCCSwitch = () => {
  showImportConfirm.value = true
}

const cancelImportFromCCSwitch = () => {
  showImportConfirm.value = false
}

const confirmImportFromCCSwitch = async () => {
  await emit('importFromCCSwitch')
  cancelImportFromCCSwitch()
}

const close = () => emit('close')
const switchMode = (mode) => emit('switchMode', mode)

const headerTitle = computed(() => {
  if (props.mode === 'manage') return t('configSelector.titleManageTemplates')
  if (props.mode === 'edit') return t('configSelector.titleEditTabConfig')
  return t('configSelector.titleSelectTemplate')
})

const ccSwitchStatusText = (value) => {
  if (ccSwitchDetectState.value === 'loading') return t('configSelector.ccswitchDetecting')
  if (value === true) return t('configSelector.ccswitchEnabled')
  if (value === false) return t('configSelector.ccswitchDisabled')
  return t('configSelector.ccswitchUnknown')
}

const CCSWITCH_POLL_MS = 30_000
let ccSwitchPollTimer = null

const stopCCSwitchPolling = () => {
  if (!ccSwitchPollTimer) return
  clearInterval(ccSwitchPollTimer)
  ccSwitchPollTimer = null
}

const startCCSwitchPolling = () => {
  stopCCSwitchPolling()
  ccSwitchPollTimer = setInterval(() => {
    refreshCCSwitchStatus()
  }, CCSWITCH_POLL_MS)
}

watch(
  [() => props.mode, autoDetectCCSwitchStatus],
  ([mode, autoDetect]) => {
    if (mode === 'create' && autoDetect) startCCSwitchPolling()
    else stopCCSwitchPolling()
  },
  { immediate: true }
)

onMounted(() => {
  refreshCCSwitchStatus()
  refreshCCSwitchRecentRequests()
})

onBeforeUnmount(() => {
  stopCCSwitchPolling()
  stopCCSwitchRequestsPolling()
})
</script>

<template>
  <div v-if="!showEditor" class="config-selector">
    <div class="header">
      <h3>{{ headerTitle }}</h3>
      <div class="header-actions">
        <button v-if="mode === 'create'" class="btn-ghost" @click="switchMode('manage')">{{ t('configSelector.manage') }}</button>
        <button v-if="mode === 'manage'" class="btn-ghost" @click="promptImportFromCCSwitch">{{ t('configSelector.importFromCCSwitch') }}</button>
        <button v-if="mode === 'manage'" class="btn-ghost" @click="switchMode('create')">{{ t('configSelector.back') }}</button>
        <button class="btn-icon" @click="close" :title="t('configSelector.close')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>

    <div class="content-body">
      <div class="config-list-container">
        <div class="type-tabs">
          <button
            v-for="tab in typeTabs"
            :key="tab.value"
            class="type-tab"
            :class="{ active: activeType === tab.value }"
            type="button"
            @click="activeType = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>

        <div v-if="mode === 'create'" class="category-panel">
          <label class="section-label">{{ t('configSelector.ccswitchSectionTitle') }}</label>
          <div class="category-box">
            <div class="category-item">
              <label class="slide-toggle" @click.stop>
                <input v-model="onlyCCSwitchConfigs" type="checkbox" @click.stop />
                <span class="slide-toggle-slider" aria-hidden="true"></span>
                <span class="slide-toggle-text">{{ t('configSelector.onlyCCSwitchConfigs') }}</span>
              </label>
            </div>

            <div class="category-item">
              <label class="slide-toggle" @click.stop>
                <input v-model="autoDetectCCSwitchStatus" type="checkbox" @click.stop />
                <span class="slide-toggle-slider" aria-hidden="true"></span>
                <span class="slide-toggle-text">{{ t('configSelector.ccswitchAutoDetect') }}</span>
              </label>
              <button
                class="btn-ghost-small"
                type="button"
                :disabled="!autoDetectCCSwitchStatus"
                @click.stop="refreshCCSwitchStatus"
              >
                {{ t('configSelector.ccswitchRefresh') }}
              </button>
            </div>

            <div class="category-item status-item">
              <span class="status-label">{{ t('configSelector.ccswitchStatus') }}</span>
              <span class="status-values">
                <span class="status-pill" :class="{ on: ccSwitchProxyEnabled === true, off: ccSwitchProxyEnabled === false }">
                  {{ t('configSelector.ccswitchProxy') }}: {{ ccSwitchStatusText(ccSwitchProxyEnabled) }}
                </span>
                <span class="status-pill" :class="{ on: ccSwitchFailoverEnabled === true, off: ccSwitchFailoverEnabled === false }">
                  {{ t('configSelector.ccswitchFailover') }}: {{ ccSwitchStatusText(ccSwitchFailoverEnabled) }}
                </span>
              </span>
            </div>

            <div v-if="ccSwitchProxyAddress" class="category-item status-item">
              <span class="status-label">{{ t('configSelector.ccswitchProxyAddress') }}</span>
              <span class="status-values">
                <span class="status-pill status-pill--mono">{{ ccSwitchProxyAddress }}</span>
              </span>
            </div>

            <div v-if="ccSwitchRecentRequests && ccSwitchRecentRequests.length > 0" class="category-item status-item">
              <span class="status-label">{{ t('configSelector.ccswitchRequestPaths') }}</span>
              <span class="status-values status-values--stack">
                <span v-for="(r, idx) in ccSwitchRecentRequests" :key="`${r?.raw || ''}:${idx}`" class="status-pill status-pill--mono">
                  {{ r.appType }} {{ r.path }}
                </span>
              </span>
            </div>
            <div
              v-else-if="autoDetectCCSwitchStatus && ccSwitchRequestsState === 'ready'"
              class="category-item status-item"
            >
              <span class="status-label">{{ t('configSelector.ccswitchRequestPaths') }}</span>
              <span class="status-values">
                <span class="status-pill">{{ t('configSelector.ccswitchNoRequests') }}</span>
              </span>
            </div>

            <div v-if="ccSwitchDetectState === 'error' && ccSwitchDetectError" class="status-error">
              {{ ccSwitchDetectError }}
            </div>
          </div>
        </div>

        <label class="section-label">{{ t('configSelector.availableTemplates') }}</label>
        <div v-if="filteredTemplates.length > 0" class="config-list">
          <div
            v-for="config in filteredTemplates"
            :key="config.id || config.name"
            :class="['config-item', { active: selectedConfig === config }]"
            @click="mode === 'create' ? (selectedConfig = config) : null"
          >
            <div class="config-icon">
               <!-- Simple generic code icon or letter based on type -->
               {{ config.type ? config.type[0].toUpperCase() : 'T' }}
            </div>
            <div class="config-info">
                <span class="config-name">
                  {{ config.name }}
                  <span
                    v-if="isCCSwitchImportedConfig(config)"
                    class="ccswitch-imported-badge"
                    :title="t('configSelector.ccswitchImportedHint')"
                  >
                    {{ t('configSelector.ccswitchImportedTag') }}
                  </span>
                  <span v-if="getCCSwitchPriorityTag(config)" class="ccswitch-priority-tag">{{ getCCSwitchPriorityTag(config) }}</span>
                </span>
                <span class="config-type">{{ config.type || t('configSelector.custom') }}</span>
            </div>
            <div v-if="mode === 'manage'" class="config-actions">
              <button @click.stop="editTemplate(config)" class="btn-icon-small" :title="t('configSelector.edit')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>
              <button @click.stop="deleteTemplate(config)" class="btn-icon-small danger" :title="t('configSelector.delete')">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              </button>
            </div>
            <div v-if="mode === 'create' && selectedConfig === config" class="check-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
          </div>
        </div>
        <div v-else class="empty-hint">
          {{ t('configSelector.emptyList') }}
        </div>
      </div>

      <div v-if="mode === 'create'" class="folder-selector">
        <label class="section-label">{{ t('configSelector.workingDirectory') }}</label>
        <div class="folder-input-group">
          <div class="input-wrapper">
             <input v-model="customWorkingDir" type="text" :placeholder="t('configSelector.defaultCwd', { default: t('configSelector.userProfile') })" readonly />
          </div>
          <button @click="selectFolder" class="btn-secondary" :disabled="isSelectingFolder">
            {{ t('configSelector.browse') }}
          </button>
        </div>
      </div>
    </div>

    <div class="footer-actions">
      <button v-if="mode === 'manage'" @click="addTemplate" class="btn-primary full-width">{{ t('configSelector.createNewTemplate') }}</button>
      <button v-if="mode === 'edit'" @click="showEditor = true" class="btn-primary full-width">{{ t('configSelector.editCurrentTab') }}</button>
      <button v-if="mode === 'create'" @click="createTerminal" :disabled="!(selectedConfig || autoPickCandidate)" class="btn-primary full-width">{{ t('configSelector.createTerminal') }}</button>
    </div>

    <Transition name="fade">
      <div v-if="showDeleteConfirm" class="confirm-overlay" @click.self="cancelDeleteTemplate">
        <div class="confirm-modal" @click.stop>
          <div class="confirm-title">{{ t('configSelector.delete') }}</div>
          <div class="confirm-message">
            {{ t('configSelector.confirmDeleteTemplate', { name: deleteCandidate?.name || '' }) }}
          </div>
          <div class="confirm-actions">
            <button class="btn-secondary" type="button" @click="cancelDeleteTemplate">
              {{ t('common.cancel') }}
            </button>
            <button class="btn-danger" type="button" @click="confirmDeleteTemplate">
              {{ t('configSelector.delete') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="fade">
      <div v-if="showImportConfirm" class="confirm-overlay" @click.self="cancelImportFromCCSwitch">
        <div class="confirm-modal" @click.stop>
          <div class="confirm-title">{{ t('configSelector.importFromCCSwitch') }}</div>
          <div class="confirm-message">{{ t('configSelector.importFromCCSwitchConfirm') }}</div>
          <div class="confirm-actions">
            <button class="btn-secondary" type="button" @click="cancelImportFromCCSwitch">
              {{ t('common.cancel') }}
            </button>
            <button class="btn-danger" type="button" @click="confirmImportFromCCSwitch">
              {{ t('configSelector.importFromCCSwitch') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>

  <ConfigEditor v-else :config="editingConfig" @save="saveConfig" @cancel="showEditor = false" />
</template>

<style scoped>
.config-selector {
  position: relative;
  background: var(--surface-color);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.content-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.section-label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.category-panel {
  margin-bottom: 14px;
}

.category-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.category-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.btn-ghost-small {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--text-secondary);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  transition: all 0.2s;
}

.btn-ghost-small:hover:enabled {
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.04);
}

.btn-ghost-small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.status-item {
  align-items: flex-start;
}

.status-values--stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.status-values--stack .status-pill {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-pill--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 11px;
  letter-spacing: 0;
}

.ccswitch-priority-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(56, 189, 248, 0.18);
  border: 1px solid rgba(56, 189, 248, 0.28);
}

.ccswitch-imported-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(250, 204, 21, 0.14);
  border: 1px solid rgba(250, 204, 21, 0.26);
}

.status-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
  padding-top: 2px;
}

.status-values {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-pill {
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.03);
}

.status-pill.on {
  color: rgba(34, 197, 94, 0.95);
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.12);
}

.status-pill.off {
  color: rgba(239, 68, 68, 0.95);
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.12);
}

.status-error {
  font-size: 12px;
  color: rgba(239, 68, 68, 0.95);
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  padding-top: 10px;
}

.slide-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.slide-toggle input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.slide-toggle-slider {
  position: relative;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
  transition: background 0.2s, border-color 0.2s;
  flex-shrink: 0;
}

.slide-toggle-slider::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  transition: transform 0.2s, background 0.2s;
}

.slide-toggle input:checked + .slide-toggle-slider {
  background: rgba(59, 130, 246, 0.6);
  border-color: rgba(59, 130, 246, 0.8);
}

.slide-toggle input:checked + .slide-toggle-slider::before {
  transform: translateX(18px);
  background: rgba(255, 255, 255, 0.98);
}

.slide-toggle input:focus-visible + .slide-toggle-slider {
  outline: 2px solid rgba(59, 130, 246, 0.8);
  outline-offset: 2px;
}

.slide-toggle-text {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
}

.slide-toggle:hover .slide-toggle-text {
  color: var(--text-primary);
}

.type-tabs {
  display: flex;
  gap: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  margin-bottom: 14px;
}

.type-tab {
  flex: 1;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s;
}

.type-tab:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

.type-tab.active {
  color: var(--text-primary);
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(59, 130, 246, 0.45);
}

.config-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--surface-hover);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.config-item:hover {
  border-color: var(--surface-active);
  transform: translateY(-1px);
}

.config-item.active {
  background: rgba(59, 130, 246, 0.1);
  border-color: var(--primary-color);
}

.config-icon {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    background: var(--surface-active);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 14px;
}

.config-info {
    flex: 1;
    display: flex;
    flex-direction: column;
}


.config-name {
    font-weight: 500;
    color: var(--text-primary);
    font-size: 14px;
}

.config-type {
    font-size: 11px;
    color: var(--text-secondary);
}

.check-icon {
    color: var(--primary-color);
}

.config-actions {
  display: flex;
  gap: 8px;
}

.btn-icon, .btn-icon-small {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.btn-icon {
    width: 32px;
    height: 32px;
}

.btn-icon:hover {
    color: var(--text-primary);
    background: var(--surface-active);
}

.btn-icon-small {
    padding: 6px;
}

.btn-icon-small:hover {
    background: var(--surface-active);
    color: var(--text-primary);
}

.btn-icon-small.danger:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--danger-color);
}

.folder-selector {
  margin-bottom: 8px;
}

.folder-input-group {
  display: flex;
  gap: 8px;
}

.input-wrapper {
    flex: 1;
    position: relative;
}

input {
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

input:focus {
    border-color: var(--primary-color);
}

.footer-actions {
    padding: 16px 20px;
    background: var(--surface-hover);
    border-top: 1px solid var(--border-color);
}

.btn-primary {
  background: var(--primary-color);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  padding: 10px 20px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-primary:disabled {
  background: var(--surface-active);
  color: var(--text-secondary);
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--surface-active);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--surface-hover);
  border-color: var(--text-secondary);
}

.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-ghost {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
}
.btn-ghost:hover {
    color: var(--text-primary);
    background: var(--surface-active);
}

.full-width {
    width: 100%;
}

.confirm-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}

.confirm-modal {
  width: min(420px, 90%);
  background: var(--surface-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
}

.confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-message {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
  white-space: pre-line;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.btn-danger {
  background: rgba(239, 68, 68, 0.16);
  color: #fecaca;
  border: 1px solid rgba(239, 68, 68, 0.5);
  border-radius: var(--radius-md);
  padding: 10px 16px;
  font-size: 13px;
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.25);
}

.empty-hint {
  padding: 18px 10px 22px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.02);
}
</style>

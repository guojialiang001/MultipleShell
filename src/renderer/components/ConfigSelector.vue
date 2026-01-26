<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfigEditor from './ConfigEditor.vue'

const props = defineProps({
  mode: { type: String, default: 'create' }, // create | manage | edit
  configTemplates: { type: Array, required: true },
  currentTabConfig: { type: Object, default: null }
})

const emit = defineEmits(['create', 'update', 'saveTemplate', 'deleteTemplate', 'close', 'switchMode'])
const { t } = useI18n()

const selectedConfig = ref(null)
const customWorkingDir = ref('')
const showEditor = ref(false)
const editingConfig = ref(null)
const isSelectingFolder = ref(false)

watch(
  () => props.mode,
  () => {
    showEditor.value = false
    editingConfig.value = null
    selectedConfig.value = null
    customWorkingDir.value = ''
  }
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
  if (!selectedConfig.value) return
  emit('create', toPlain(selectedConfig.value), customWorkingDir.value)
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
  editingConfig.value = null
  showEditor.value = true
}

const editTemplate = (template) => {
  editingConfig.value = { ...template }
  showEditor.value = true
}

const deleteTemplate = async (template) => {
  if (!confirm(t('configSelector.confirmDeleteTemplate', { name: template.name }))) return
  await emit('deleteTemplate', template.id)
}

const close = () => emit('close')
const switchMode = (mode) => emit('switchMode', mode)

const headerTitle = computed(() => {
  if (props.mode === 'manage') return t('configSelector.titleManageTemplates')
  if (props.mode === 'edit') return t('configSelector.titleEditTabConfig')
  return t('configSelector.titleSelectTemplate')
})
</script>

<template>
  <div v-if="!showEditor" class="config-selector">
    <div class="header">
      <h3>{{ headerTitle }}</h3>
      <div class="header-actions">
        <button v-if="mode === 'create'" class="btn-ghost" @click="switchMode('manage')">{{ t('configSelector.manage') }}</button>
        <button v-if="mode === 'manage'" class="btn-ghost" @click="switchMode('create')">{{ t('configSelector.back') }}</button>
        <button class="btn-icon" @click="close" :title="t('configSelector.close')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>

    <div class="content-body">
      <div class="config-list-container">
        <label class="section-label">{{ t('configSelector.availableTemplates') }}</label>
        <div class="config-list">
          <div
            v-for="config in props.configTemplates"
            :key="config.id || config.name"
            :class="['config-item', { active: selectedConfig === config }]"
            @click="mode === 'create' ? (selectedConfig = config) : null"
          >
            <div class="config-icon">
               <!-- Simple generic code icon or letter based on type -->
               {{ config.type ? config.type[0].toUpperCase() : 'T' }}
            </div>
            <div class="config-info">
                <span class="config-name">{{ config.name }}</span>
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
      <button v-if="mode === 'create'" @click="createTerminal" :disabled="!selectedConfig" class="btn-primary full-width">{{ t('configSelector.createTerminal') }}</button>
    </div>
  </div>

  <ConfigEditor v-else :config="editingConfig" @save="saveConfig" @cancel="showEditor = false" />
</template>

<style scoped>
.config-selector {
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
    border-radius: 6px;
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
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
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
</style>

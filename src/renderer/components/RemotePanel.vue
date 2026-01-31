<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { validateHttpUrl } from '../utils/http-url'

const { t } = useI18n()

const REMOTE_BASE_URL_KEY = 'mps.remote.baseUrl'
const REMOTE_REMOTEAPP_ENABLED_KEY = 'mps.remote.remoteAppEnabled'
const REMOTE_REMOTEAPP_CLIENT_ID_KEY = 'mps.remote.remoteAppClientId'
const REMOTE_VNC_CLIENT_ID_KEY = 'mps.remote.vncClientId'
const REMOTE_CLIENT_ID_BASE64_KEY = 'mps.remote.clientIdBase64'
const REMOTE_RDP_CONFIGURED_KEY = 'mps.remote.rdpConfigured'

const REMOTE_APP_ALIAS = '||MultipleShell'

const readLocalStorage = (key, fallback = '') => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : String(value)
  } catch (_) {
    return fallback
  }
}

const parseBool = (value, fallback = false) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

const remoteBaseUrl = ref('')
const remoteAppEnabled = ref(false)
const remoteAppClientId = ref('')
const vncClientId = ref('')
const clientIdBase64 = ref(false)
const rdpConfigured = ref(false)
const portalCopyState = ref('idle') // idle | copied | error
const remoteAppCopyState = ref('idle') // idle | copied | error
const vncCopyState = ref('idle') // idle | copied | error
let portalCopyTimer = null
let remoteAppCopyTimer = null
let vncCopyTimer = null

const refresh = () => {
  remoteBaseUrl.value = readLocalStorage(REMOTE_BASE_URL_KEY, '')
  remoteAppEnabled.value = parseBool(readLocalStorage(REMOTE_REMOTEAPP_ENABLED_KEY, '0'), false)
  remoteAppClientId.value = readLocalStorage(REMOTE_REMOTEAPP_CLIENT_ID_KEY, '')
  vncClientId.value = readLocalStorage(REMOTE_VNC_CLIENT_ID_KEY, '')
  clientIdBase64.value = parseBool(readLocalStorage(REMOTE_CLIENT_ID_BASE64_KEY, '0'), false)
  rdpConfigured.value = parseBool(readLocalStorage(REMOTE_RDP_CONFIGURED_KEY, '0'), false)
}

onMounted(() => {
  refresh()
  window.addEventListener('mps:remote-settings', refresh)
})

onBeforeUnmount(() => {
  window.removeEventListener('mps:remote-settings', refresh)

  if (portalCopyTimer) {
    clearTimeout(portalCopyTimer)
    portalCopyTimer = null
  }
  if (remoteAppCopyTimer) {
    clearTimeout(remoteAppCopyTimer)
    remoteAppCopyTimer = null
  }
  if (vncCopyTimer) {
    clearTimeout(vncCopyTimer)
    vncCopyTimer = null
  }
})

const portalValidation = computed(() => validateHttpUrl(remoteBaseUrl.value))
const portalUrl = computed(() => (portalValidation.value.isValid ? portalValidation.value.raw : ''))
const baseForDirect = computed(() => portalUrl.value.replace(/\/+$/, ''))

const normalizeClientIdentifier = (value) => {
  let raw = String(value ?? '').trim()
  if (!raw) return ''

  const marker = '#/client/'
  const markerIndex = raw.indexOf(marker)
  if (markerIndex >= 0) raw = raw.slice(markerIndex + marker.length)

  raw = raw.replace(/^\/+/, '')
  raw = raw.replace(/^c\//i, '')

  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      raw = decodeURIComponent(raw)
    } catch (_) {}
  }

  return raw.trim()
}

const encodeUtf8ToBase64 = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  try {
    const bytes = new TextEncoder().encode(raw)
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return btoa(binary)
  } catch (_) {
    try {
      return btoa(unescape(encodeURIComponent(raw)))
    } catch (_) {}
  }

  return ''
}

const resolveClientIdForUrl = (value) => {
  const id = normalizeClientIdentifier(value)
  if (!id) return ''
  if (!clientIdBase64.value) return id
  return encodeUtf8ToBase64(id)
}

const encodeClientIdForUrl = (id) => {
  const raw = String(id ?? '').trim()
  if (!raw) return ''

  // Guacamole XML/file auth commonly expects the connection name to be Base64,
  // and Guacamole's own URLs typically keep Base64 characters like "=" intact.
  // Only percent-encode when we are not intentionally producing Base64.
  return clientIdBase64.value ? raw : encodeURIComponent(raw)
}

const remoteAppUrl = computed(() => {
  if (!remoteAppEnabled.value) return ''
  const id = encodeClientIdForUrl(resolveClientIdForUrl(remoteAppClientId.value))
  if (!id) return ''
  if (!baseForDirect.value) return ''
  return `${baseForDirect.value}/#/client/c/${id}`
})

const vncUrl = computed(() => {
  const id = encodeClientIdForUrl(resolveClientIdForUrl(vncClientId.value))
  if (!id) return ''
  if (!baseForDirect.value) return ''
  return `${baseForDirect.value}/#/client/c/${id}`
})

const getPortalValidationMessage = () => {
  const result = portalValidation.value
  if (result.isEmpty) return t('remote.notConfigured')
  if (result.isValid) return ''
  if (result.error === 'whitespace') return t('remote.urlHasSpacesHint')
  if (result.error === 'protocol') return t('remote.urlUnsupportedProtocolHint')
  return t('remote.urlInvalidHint')
}

const openExternal = async (url) => {
  const target = String(url || '').trim()
  if (!target) return

  if (window?.electronAPI?.openExternal) {
    try {
      await window.electronAPI.openExternal(target)
      return
    } catch (err) {
      console.error('[mps] openExternal failed', err)
    }
  }

  try {
    window.open(target, '_blank')
  } catch (_) {}
}

const portalHint = computed(() => getPortalValidationMessage() || t('remote.hint'))

const remoteAppHint = computed(() => {
  if (!remoteAppEnabled.value) return t('remote.remoteAppDisabledHint')
  const portalValidationMessage = getPortalValidationMessage()
  if (portalValidationMessage) return portalValidationMessage
  if (!normalizeClientIdentifier(remoteAppClientId.value)) return t('remote.missingClientIdHint')
  return `${t('remote.hint')} ${t('remote.remoteAppAliasLabel')}: ${REMOTE_APP_ALIAS}`
})

const vncHint = computed(() => {
  const portalValidationMessage = getPortalValidationMessage()
  if (portalValidationMessage) return portalValidationMessage
  if (!normalizeClientIdentifier(vncClientId.value)) return t('remote.missingClientIdHint')
  return t('remote.hint')
})

const canOpenPortal = computed(() => !!portalUrl.value)
const canOpenRemoteApp = computed(() => !!remoteAppUrl.value)
const canOpenVnc = computed(() => !!vncUrl.value)

const canCopyPortal = computed(() => !!portalUrl.value)
const canCopyRemoteApp = computed(() => !!remoteAppUrl.value)
const canCopyVnc = computed(() => !!vncUrl.value)

const copyToClipboard = async (text) => {
  const value = String(text || '').trim()
  if (!value) return false

  if (window?.electronAPI?.clipboardWriteText) {
    try {
      await window.electronAPI.clipboardWriteText(value)
      return true
    } catch (err) {
      console.error('[mps] clipboardWriteText failed', err)
    }
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (err) {
    console.error('[mps] navigator.clipboard.writeText failed', err)
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch (err) {
    console.error('[mps] execCommand copy failed', err)
  }
  return false
}

const armCopiedState = (type) => {
  if (type === 'portal') {
    if (portalCopyTimer) clearTimeout(portalCopyTimer)
    portalCopyTimer = setTimeout(() => {
      portalCopyState.value = 'idle'
      portalCopyTimer = null
    }, 1200)
    return
  }
  if (type === 'remoteApp') {
    if (remoteAppCopyTimer) clearTimeout(remoteAppCopyTimer)
    remoteAppCopyTimer = setTimeout(() => {
      remoteAppCopyState.value = 'idle'
      remoteAppCopyTimer = null
    }, 1200)
    return
  }
  if (type === 'vnc') {
    if (vncCopyTimer) clearTimeout(vncCopyTimer)
    vncCopyTimer = setTimeout(() => {
      vncCopyState.value = 'idle'
      vncCopyTimer = null
    }, 1200)
  }
}

const copyPortal = async () => {
  if (!canCopyPortal.value) return
  const ok = await copyToClipboard(portalUrl.value)
  portalCopyState.value = ok ? 'copied' : 'error'
  armCopiedState('portal')
}

const copyRemoteApp = async () => {
  if (!canCopyRemoteApp.value) return
  const ok = await copyToClipboard(remoteAppUrl.value)
  remoteAppCopyState.value = ok ? 'copied' : 'error'
  armCopiedState('remoteApp')
}

const copyVnc = async () => {
  if (!canCopyVnc.value) return
  const ok = await copyToClipboard(vncUrl.value)
  vncCopyState.value = ok ? 'copied' : 'error'
  armCopiedState('vnc')
}
</script>

<template>
  <div class="remote-panel">
    <div class="remote-header">
      <div class="remote-title">{{ t('menu.modeRemote') }}</div>
      <div class="remote-subtitle">{{ t('remote.title') }}</div>
    </div>
    <div class="remote-status-row">
      {{ t('remote.rdpConfigStatus') }}:
      <span class="remote-status-pill" :class="{ on: rdpConfigured }">
        {{ rdpConfigured ? t('remote.rdpConfigured') : t('remote.rdpNotConfigured') }}
      </span>
    </div>

    <div class="remote-grid">
      <div
        class="remote-card"
        role="button"
        :tabindex="canOpenPortal ? 0 : -1"
        :aria-disabled="!canOpenPortal"
        :class="{ 'remote-card--disabled': !canOpenPortal }"
        @click="canOpenPortal && openExternal(portalUrl)"
        @keydown.enter.prevent="canOpenPortal && openExternal(portalUrl)"
        @keydown.space.prevent="canOpenPortal && openExternal(portalUrl)"
      >
        <div class="remote-card-title-row">
          <div class="remote-card-title">{{ t('remote.openPortal') }}</div>
          <button
            class="remote-card-action"
            type="button"
            :disabled="!canCopyPortal"
            @click.stop="copyPortal"
            @keydown.enter.stop
            @keydown.space.stop
          >
            {{
              portalCopyState === 'copied'
                ? t('remote.copied')
                : portalCopyState === 'error'
                  ? t('remote.copyFailed')
                  : t('remote.copyLink')
            }}
          </button>
        </div>
        <div class="remote-card-hint">{{ portalHint }}</div>
      </div>

      <div
        class="remote-card"
        role="button"
        :tabindex="canOpenRemoteApp ? 0 : -1"
        :aria-disabled="!canOpenRemoteApp"
        :class="{ 'remote-card--disabled': !canOpenRemoteApp }"
        @click="canOpenRemoteApp && openExternal(remoteAppUrl)"
        @keydown.enter.prevent="canOpenRemoteApp && openExternal(remoteAppUrl)"
        @keydown.space.prevent="canOpenRemoteApp && openExternal(remoteAppUrl)"
      >
        <div class="remote-card-title-row">
          <div class="remote-card-title">{{ t('remote.openRemoteApp') }}</div>
          <button
            class="remote-card-action"
            type="button"
            :disabled="!canCopyRemoteApp"
            @click.stop="copyRemoteApp"
            @keydown.enter.stop
            @keydown.space.stop
          >
            {{
              remoteAppCopyState === 'copied'
                ? t('remote.copied')
                : remoteAppCopyState === 'error'
                  ? t('remote.copyFailed')
                  : t('remote.copyLink')
            }}
          </button>
        </div>
        <div class="remote-card-hint">{{ remoteAppHint }}</div>
      </div>

      <div
        class="remote-card"
        role="button"
        :tabindex="canOpenVnc ? 0 : -1"
        :aria-disabled="!canOpenVnc"
        :class="{ 'remote-card--disabled': !canOpenVnc }"
        @click="canOpenVnc && openExternal(vncUrl)"
        @keydown.enter.prevent="canOpenVnc && openExternal(vncUrl)"
        @keydown.space.prevent="canOpenVnc && openExternal(vncUrl)"
      >
        <div class="remote-card-title-row">
          <div class="remote-card-title">{{ t('remote.openVnc') }}</div>
          <button
            class="remote-card-action"
            type="button"
            :disabled="!canCopyVnc"
            @click.stop="copyVnc"
            @keydown.enter.stop
            @keydown.space.stop
          >
            {{
              vncCopyState === 'copied'
                ? t('remote.copied')
                : vncCopyState === 'error'
                  ? t('remote.copyFailed')
                  : t('remote.copyLink')
            }}
          </button>
        </div>
        <div class="remote-card-hint">{{ vncHint }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-panel {
  flex: 1;
  min-height: 0;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.remote-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.remote-title {
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.remote-subtitle {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 700;
}

.remote-status-row {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 700;
}

.remote-status-pill {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.82);
  font-size: 11px;
  font-weight: 800;
}

.remote-status-pill.on {
  border-color: rgba(34, 197, 94, 0.38);
  background: rgba(34, 197, 94, 0.12);
  color: rgba(134, 239, 172, 0.92);
}

.remote-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.remote-card {
  text-align: left;
  background: var(--surface-hover);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 14px 14px;
  color: var(--text-primary);
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.remote-card:hover:not(.remote-card--disabled) {
  transform: translateY(-1px);
  border-color: var(--surface-active);
  background: rgba(255, 255, 255, 0.06);
}

.remote-card--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.remote-card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.remote-card-title {
  font-size: 13px;
  font-weight: 900;
}

.remote-card-action {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.86);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.remote-card-action:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.18);
}

.remote-card-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.remote-card-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}
</style>

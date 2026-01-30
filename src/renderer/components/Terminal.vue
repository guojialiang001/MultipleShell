<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { clearTerminalPreview, setTerminalPreview } from '../utils/terminal-preview-store'

const props = defineProps(['sessionId', 'isActive'])
const terminalRef = ref(null)
let terminal = null
let fitAddon = null
let isSelecting = false
let selectionTimeout = null
let keyboardHandler = null
let pasteHandler = null
let dropHandler = null
let unsubscribeTerminalData = null
let unsubscribeTerminalRender = null
let lastPtyCols = 0
let lastPtyRows = 0

const MONITOR_THUMBNAIL_MODE_KEY = 'mps.monitor.thumbnailMode' // card | terminal
const PREVIEW_DEBUG_KEY = 'mps.debug.preview'

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

const isPreviewDebugEnabled = () => {
  const raw = readLocalStorage(PREVIEW_DEBUG_KEY, '').trim().toLowerCase()
  if (!raw) return process.env.NODE_ENV === 'development'
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

let monitorThumbnailMode = normalizeThumbnailMode(readLocalStorage(MONITOR_THUMBNAIL_MODE_KEY, 'card'))

let mouseDownSelecting = false
let didSelectSinceMouseDown = false
let lastSelectionPosition = null
let lastSelectionAt = 0
let selectionGuardUntil = 0
const SELECTION_GUARD_MS = 600
const MOUSE_UP_GUARD_MS = 800

const extendSelectionGuard = (ms = SELECTION_GUARD_MS) => {
  selectionGuardUntil = Math.max(selectionGuardUntil, Date.now() + ms)
}

const isSelectionGuardActive = () => {
  if (!terminal) return false
  return mouseDownSelecting || Date.now() < selectionGuardUntil || terminal.hasSelection()
}

const scheduleFlushAfterGuard = () => {
  if (selectionTimeout) {
    clearTimeout(selectionTimeout)
    selectionTimeout = null
  }
  const delayMs = Math.max(0, selectionGuardUntil - Date.now() + 20)
  selectionTimeout = setTimeout(() => {
    selectionTimeout = null
    scheduleFlush()
  }, delayMs)
}

let flushRafId = null
let pendingChunks = []
let pendingChars = 0
let writeInProgress = false
let pendingSoftClear = false
let inputLineBuffer = ''
let inputEscapeSequence = null
const FLUSH_CHARS_THRESHOLD = 64 * 1024
const MAX_PENDING_CHARS = 1024 * 1024
const WRITE_CHUNK_SIZE = 16 * 1024

// Monitor "terminal preview": capture a low-res snapshot of the xterm canvas.
// Snapshot generation is intentionally throttled to avoid CPU spikes when many sessions are running.
// A smaller "first snapshot" throttle makes the UI feel snappier when users switch to snapshot mode.
const PREVIEW_THROTTLE_MS = 300
const PREVIEW_THROTTLE_FIRST_MS = 60
const PREVIEW_THROTTLE_NO_CANVAS_MS = 500
const PREVIEW_NO_CANVAS_AUTOFIT_INTERVAL_MS = 1200
const PREVIEW_MAX_WIDTH = 320
const PREVIEW_MAX_HEIGHT = 180
let previewDirty = false
let previewLastAt = 0
let previewTimer = null
let previewCapturing = false
let previewCanvas = null
let previewCtx = null
let previewObjectUrl = null
let previewMissingCanvasSince = 0
let previewNoCanvasLastReportAt = 0
let previewFirstSuccessLogged = false
let previewScheduleLastLogAt = 0
let previewLastAutoFitAt = 0
let previewUsingTextFallback = false
let previewTextFallbackLogged = false

let resizeObserver = null
let resizeObserverRafId = null

const canvasToBlobWithTimeout = (canvas, type, quality, timeoutMs = 800) => {
  if (!canvas || typeof canvas.toBlob !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(null)
    }, Math.max(0, Number(timeoutMs) || 0))

    try {
      canvas.toBlob((blob) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(blob || null)
      }, type, quality)
    } catch (_) {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(null)
    }
  })
}

const cancelPendingFlush = () => {
  if (flushRafId != null) {
    cancelAnimationFrame(flushRafId)
    flushRafId = null
  }
}

const hardResetTerminal = () => {
  if (!terminal) return
  terminal.clearSelection()
  terminal.reset()
}

const isTerminalPreviewEnabled = () => monitorThumbnailMode === 'terminal'

const revokeObjectUrlSoon = (url) => {
  if (!url || typeof url !== 'string') return
  if (!url.startsWith('blob:')) return

  // Revoke after the next paint so any <img src="blob:..."> consumers have had a
  // chance to swap to the new URL. We never keep history; only the latest stays alive.
  const doRevoke = () => {
    try {
      URL.revokeObjectURL(url)
    } catch (_) {}
  }

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(doRevoke, 0))
    return
  }

  setTimeout(doRevoke, 0)
}

const clearPreviewResources = () => {
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
  }
  previewDirty = false
  previewCapturing = false
  previewLastAt = 0
  previewMissingCanvasSince = 0
  previewNoCanvasLastReportAt = 0
  previewFirstSuccessLogged = false
  previewScheduleLastLogAt = 0
  previewLastAutoFitAt = 0
  previewUsingTextFallback = false
  previewTextFallbackLogged = false

  const url = previewObjectUrl
  previewObjectUrl = null
  if (url) revokeObjectUrlSoon(url)
  clearTerminalPreview(props.sessionId)
}

const refreshMonitorThumbnailMode = () => {
  const next = normalizeThumbnailMode(readLocalStorage(MONITOR_THUMBNAIL_MODE_KEY, 'card'))
  if (next === monitorThumbnailMode) return
  monitorThumbnailMode = next
  previewUsingTextFallback = false
  previewTextFallbackLogged = false
  if (isPreviewDebugEnabled()) {
    console.log('[mps] preview: monitor thumbnail mode changed', { sessionId: props.sessionId, mode: monitorThumbnailMode })
  }
  if (!isTerminalPreviewEnabled()) {
    clearPreviewResources()
    return
  }

  previewDirty = true

  const fitAndCaptureSoon = () => {
    try {
      fitAddon?.fit()
    } catch (_) {}
    try {
      if (terminal?.rows) terminal.refresh(0, terminal.rows - 1)
    } catch (_) {}
    schedulePreviewCapture(true)
  }

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitAndCaptureSoon)
  else setTimeout(fitAndCaptureSoon, 0)
}

const getTerminalCanvasLayers = () => {
  const root = terminal?.element
  if (!root) return { root: null, all: [], usable: [] }
  const all = Array.from(root.querySelectorAll('canvas')).filter(Boolean)
  const usable = all.filter((c) => c && c.width > 0 && c.height > 0)
  return { root, all, usable }
}

const scheduleHandleResize = () => {
  if (!terminal || !fitAddon) return
  if (resizeObserverRafId != null) return

  const run = () => {
    resizeObserverRafId = null
    handleResize()
  }

  if (typeof requestAnimationFrame === 'function') {
    resizeObserverRafId = requestAnimationFrame(run)
    return
  }

  resizeObserverRafId = setTimeout(run, 0)
}

const maybeAutoFitForPreview = () => {
  if (!terminal || !fitAddon) return
  const now = Date.now()
  if (now - previewLastAutoFitAt < PREVIEW_NO_CANVAS_AUTOFIT_INTERVAL_MS) return
  previewLastAutoFitAt = now
  scheduleHandleResize()
}

const escapeXml = (value) => {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const sanitizePreviewText = (value) => {
  // Remove control chars that can break XML/SVG rendering.
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\t/g, '    ')
}

const buildTextPreviewDataUrl = () => {
  if (!terminal) return ''

  const width = PREVIEW_MAX_WIDTH
  const height = PREVIEW_MAX_HEIGHT
  const paddingX = 10
  const paddingY = 10
  const fontSize = 11
  const lineHeight = 14
  const maxLines = Math.max(1, Math.floor((height - paddingY * 2) / lineHeight))

  const lines = []
  try {
    const buffer = terminal.buffer?.active
    if (buffer && typeof buffer.getLine === 'function') {
      const total = Math.max(0, Number(buffer.length || 0))
      let end = total - 1
      for (; end >= 0; end--) {
        const line = buffer.getLine(end)
        const text = line && typeof line.translateToString === 'function' ? line.translateToString(true) : ''
        if (sanitizePreviewText(text).trim()) break
      }
      if (end < 0) end = total - 1

      const start = Math.max(0, end - (maxLines - 1))
      for (let i = start; i <= end; i++) {
        const line = buffer.getLine(i)
        const text = line && typeof line.translateToString === 'function' ? line.translateToString(true) : ''
        lines.push(text || '')
      }
    }
  } catch (_) {}

  const hasAnyText = lines.some((l) => sanitizePreviewText(l).trim().length > 0)
  if (lines.length === 0 || !hasAnyText) {
    lines.length = 0
    lines.push('(no output yet)')
  }

  const safe = lines.map((l) => {
    const cleaned = sanitizePreviewText(l)
    // Keep data URLs small and predictable.
    return cleaned.length > 240 ? cleaned.slice(0, 240) : cleaned
  })

  const texts = safe
    .map((line, idx) => {
      const y = paddingY + idx * lineHeight
      // Ensure empty lines still paint something so spacing is stable.
      const content = line ? escapeXml(line) : ' '
      return `<text x="${paddingX}" y="${y}" xml:space="preserve">${content}</text>`
    })
    .join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0a0a0a"/>
  <g font-family="JetBrains Mono, Consolas, 'Courier New', monospace" font-size="${fontSize}" fill="#e5e5e5" dominant-baseline="hanging">
    ${texts}
  </g>
</svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const captureTerminalPreview = async () => {
  if (!terminal) return
  if (!isTerminalPreviewEnabled()) return
  if (previewCapturing) return
  if (!previewDirty) return

  previewLastAt = Date.now()

  const { root, all, usable } = getTerminalCanvasLayers()
  if (usable.length === 0) {
    if (!previewMissingCanvasSince) previewMissingCanvasSince = Date.now()
    const now = Date.now()
    const elapsed = now - previewMissingCanvasSince

    const containerRect = (() => {
      try {
        return terminalRef.value?.getBoundingClientRect?.() || null
      } catch (_) {
        return null
      }
    })()

    // If we're not laid out yet (e.g. display:none), don't spin; a ResizeObserver will retrigger.
    if (containerRect && (containerRect.width <= 0 || containerRect.height <= 0)) {
      previewMissingCanvasSince = 0
      previewNoCanvasLastReportAt = 0
      previewDirty = false
      return
    }

    maybeAutoFitForPreview()

    // Fallback: if we can't access a usable xterm canvas (DOM renderer / 0-sized layers / remote GPU issues),
    // generate a lightweight SVG snapshot from the terminal buffer so Monitor thumbnails still work.
    const fallbackUrl = buildTextPreviewDataUrl()
    if (fallbackUrl) {
      previewMissingCanvasSince = 0
      previewNoCanvasLastReportAt = 0
      previewDirty = false
      previewUsingTextFallback = true

      const prevUrl = previewObjectUrl
      previewObjectUrl = fallbackUrl
      setTerminalPreview(props.sessionId, fallbackUrl)
      if (prevUrl) revokeObjectUrlSoon(prevUrl)

      if (isPreviewDebugEnabled() && !previewTextFallbackLogged) {
        previewTextFallbackLogged = true
        console.warn('[mps] preview: using text fallback (no usable canvas)', {
          sessionId: props.sessionId,
          mode: monitorThumbnailMode,
          canvasCount: all.length,
          elapsedMs: elapsed
        })
      }
      return
    }

    if (isPreviewDebugEnabled() && elapsed >= 250 && now - previewNoCanvasLastReportAt >= 2000) {
      previewNoCanvasLastReportAt = now
      const rect = (el) => {
        try {
          const r = el?.getBoundingClientRect?.()
          if (!r) return null
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        } catch (_) {
          return null
        }
      }
      const canvasInfo = all.slice(0, 6).map((c) => ({
        w: Number(c?.width || 0),
        h: Number(c?.height || 0),
        cssW: Number(c?.clientWidth || 0),
        cssH: Number(c?.clientHeight || 0),
        rect: rect(c)
      }))
      console.warn('[mps] preview: no usable xterm canvas yet', {
        sessionId: props.sessionId,
        mode: monitorThumbnailMode,
        elapsedMs: elapsed,
        documentVisible: document?.visibilityState,
        rootConnected: Boolean(root?.isConnected),
        terminalRef: rect(terminalRef.value),
        terminalElement: rect(root),
        canvasCount: all.length,
        canvases: canvasInfo
      })
    }
    return
  }
  previewMissingCanvasSince = 0
  previewNoCanvasLastReportAt = 0
  previewUsingTextFallback = false

  // Some environments fall back to DOM rendering (or only provide non-text canvas layers),
  // which results in a black snapshot. Prefer the text-buffer fallback in that case.
  const hasTextLayerCanvas = usable.some((c) => c?.classList?.contains?.('xterm-text-layer'))
  if (!hasTextLayerCanvas) {
    const fallbackUrl = buildTextPreviewDataUrl()
    if (fallbackUrl) {
      previewDirty = false
      previewUsingTextFallback = true

      const prevUrl = previewObjectUrl
      previewObjectUrl = fallbackUrl
      setTerminalPreview(props.sessionId, fallbackUrl)
      if (prevUrl) revokeObjectUrlSoon(prevUrl)
      return
    }
  }

  let srcWidth = 0
  let srcHeight = 0
  for (const c of usable) {
    srcWidth = Math.max(srcWidth, Number(c.width || 0))
    srcHeight = Math.max(srcHeight, Number(c.height || 0))
  }
  if (!srcWidth || !srcHeight) return

  const ratio = Math.min(PREVIEW_MAX_WIDTH / srcWidth, PREVIEW_MAX_HEIGHT / srcHeight, 1)
  const targetWidth = Math.max(1, Math.round(srcWidth * ratio))
  const targetHeight = Math.max(1, Math.round(srcHeight * ratio))

  if (!previewCanvas) {
    previewCanvas = document.createElement('canvas')
    previewCtx = previewCanvas.getContext('2d', { alpha: false })
  }
  if (!previewCtx) return

  previewCanvas.width = targetWidth
  previewCanvas.height = targetHeight
  previewCtx.imageSmoothingEnabled = true
  previewCtx.clearRect(0, 0, targetWidth, targetHeight)
  previewCtx.fillStyle = '#0a0a0a'
  previewCtx.fillRect(0, 0, targetWidth, targetHeight)
  // Composite all xterm layers in DOM order to mimic the final on-screen output.
  for (const layer of usable) {
    previewCtx.drawImage(layer, 0, 0, targetWidth, targetHeight)
  }

  previewDirty = false
  previewCapturing = true

  let nextUrl = ''
  try {
    // Use toBlob if possible, but guard against environments where toBlob can hang forever.
    const blob = await canvasToBlobWithTimeout(previewCanvas, 'image/webp', 0.45, 900)
    if (blob) {
      nextUrl = URL.createObjectURL(blob)
    } else {
      // Fall back to a png data URL (sync, but safe for our tiny canvas).
      const png = previewCanvas.toDataURL('image/png')
      if (png && png.startsWith('data:image/')) nextUrl = png
    }
  } catch (_) {
    previewDirty = true
  } finally {
    previewCapturing = false
  }

  if (!nextUrl) {
    // Keep dirty so the next output/resize can trigger another attempt.
    previewDirty = true
    return
  }

  const prevUrl = previewObjectUrl
  previewObjectUrl = nextUrl
  setTerminalPreview(props.sessionId, nextUrl)
  if (isPreviewDebugEnabled() && !previewFirstSuccessLogged) {
    previewFirstSuccessLogged = true
    const kind = nextUrl.startsWith('blob:') ? 'blob' : nextUrl.startsWith('data:') ? 'data' : 'other'
    console.log('[mps] preview: generated', {
      sessionId: props.sessionId,
      kind,
      src: { w: srcWidth, h: srcHeight },
      target: { w: targetWidth, h: targetHeight }
    })
  }
  if (prevUrl) revokeObjectUrlSoon(prevUrl)
}

const schedulePreviewCapture = (force = false) => {
  if (!terminal) return
  if (!isTerminalPreviewEnabled()) return
  if (force) previewDirty = true
  if (!previewDirty) return
  if (previewTimer) return

  const now = Date.now()
  const baseThrottle = previewObjectUrl ? PREVIEW_THROTTLE_MS : PREVIEW_THROTTLE_FIRST_MS
  const throttle = previewMissingCanvasSince ? Math.max(baseThrottle, PREVIEW_THROTTLE_NO_CANVAS_MS) : baseThrottle
  const delay = Math.max(0, throttle - (now - previewLastAt))
  if (isPreviewDebugEnabled() && (force || !previewObjectUrl)) {
    if (force || now - previewScheduleLastLogAt >= 1200) {
      previewScheduleLastLogAt = now
      console.log('[mps] preview: schedule', { sessionId: props.sessionId, force, delayMs: delay })
    }
  }
  previewTimer = setTimeout(async () => {
    previewTimer = null
    try {
      await captureTerminalPreview()
    } catch (err) {
      console.error('[mps] captureTerminalPreview failed', err)
    }
    if (previewDirty) schedulePreviewCapture()
  }, delay)
}

const takeWriteChunk = () => {
  if (pendingChunks.length === 0) return ''
  let chunk = ''
  while (pendingChunks.length > 0 && chunk.length < WRITE_CHUNK_SIZE) {
    const next = pendingChunks[0]
    const remain = WRITE_CHUNK_SIZE - chunk.length
    if (next.length <= remain) {
      chunk += next
      pendingChunks.shift()
    } else {
      chunk += next.slice(0, remain)
      pendingChunks[0] = next.slice(remain)
    }
  }
  pendingChars = Math.max(0, pendingChars - chunk.length)
  return chunk
}

const applyPendingSoftClear = () => {
  if (!terminal) return false
  if (!pendingSoftClear) return false
  if (writeInProgress) return false
  if (isSelectionGuardActive()) return false
  if (terminal.buffer?.active?.type !== 'normal') return false
  pendingSoftClear = false
  previewDirty = true
  terminal.clear()
  return true
}

const flushPendingWrites = () => {
  if (!terminal) return
  // Clear has higher priority than output flush (it must be applied even if output is empty).
  applyPendingSoftClear()
  if (pendingChunks.length === 0) return
  if (isSelectionGuardActive()) return

  // xterm.write is async and internally buffered; writing huge payloads can keep the
  // write queue busy long enough to interfere with selection finalization on mouseup.
  // Drain in smaller chunks and pause quickly when selection guard becomes active.
  if (writeInProgress) return
  const chunk = takeWriteChunk()
  if (!chunk) return
  writeInProgress = true
  terminal.write(chunk, () => {
    writeInProgress = false
    applyPendingSoftClear()
    schedulePreviewCapture()
    if (pendingChunks.length === 0) return
    if (isSelectionGuardActive()) return
    scheduleFlush()
  })
}

const scheduleFlush = () => {
  if (flushRafId != null) return
  flushRafId = requestAnimationFrame(() => {
    flushRafId = null
    flushPendingWrites()
  })
}

const forceFullClear = () => {
  if (!terminal) return
  // User explicitly asked to clear; do not preserve selection guard state.
  mouseDownSelecting = false
  selectionGuardUntil = 0
  if (selectionTimeout) {
    clearTimeout(selectionTimeout)
    selectionTimeout = null
  }
  terminal.clearSelection()

  cancelPendingFlush()
  pendingChunks = []
  pendingChars = 0

  // If a write is currently being processed by xterm, clear right after it finishes.
  pendingSoftClear = true
  applyPendingSoftClear()
  scheduleFlush()
}

const trackInputForClear = (data) => {
  // Best-effort tracking of typed command line to support "clear/cls" even when
  // the host doesn't emit full clear-scrollback sequences.
  for (const ch of data) {
    if (inputEscapeSequence != null) {
      inputEscapeSequence += ch
      // End escape sequence on a final byte (CSI final or other ESC sequence terminators).
      if (/[A-Za-z~]$/.test(inputEscapeSequence)) {
        inputEscapeSequence = null
      }
      continue
    }

    if (ch === '\x1b') {
      inputEscapeSequence = ch
      continue
    }

    if (ch === '\x0c') {
      forceFullClear()
      continue
    }

    if (ch === '\r' || ch === '\n') {
      const cmd = inputLineBuffer.trim().toLowerCase()
      inputLineBuffer = ''
      if (terminal.buffer?.active?.type === 'normal' && (cmd === 'clear' || cmd === 'cls' || cmd === 'clear-host')) {
        forceFullClear()
      }
      continue
    }

    if (ch === '\x7f') {
      inputLineBuffer = inputLineBuffer.slice(0, -1)
      continue
    }

    // Only track simple printable characters (good enough for 'clear'/'cls').
    if (ch >= ' ' && ch <= '~') {
      inputLineBuffer += ch
      // Avoid unbounded growth if something pastes huge text.
      if (inputLineBuffer.length > 256) inputLineBuffer = inputLineBuffer.slice(-256)
    }
  }
}

const enqueueTerminalWrite = (data) => {
  if (!terminal) return
  if (typeof data !== 'string' || data.length === 0) return

  pendingChunks.push(data)
  pendingChars += data.length
  previewDirty = true

  if (isSelectionGuardActive()) {
    while (pendingChars > MAX_PENDING_CHARS && pendingChunks.length > 0) {
      pendingChars -= pendingChunks[0].length
      pendingChunks.shift()
    }
    return
  }

  if (pendingChars >= FLUSH_CHARS_THRESHOLD) flushPendingWrites()
  else scheduleFlush()

  // Avoid runaway memory usage when output is extremely large.
  if (pendingChars > MAX_PENDING_CHARS) flushPendingWrites()
}

const dropPendingWrites = () => {
  cancelPendingFlush()
  pendingChunks = []
  pendingChars = 0
}

const hardClear = () => {
  if (!terminal) return
  dropPendingWrites()
  hardResetTerminal()
}

const sendCtrlC = () => {
  window.electronAPI.writeToTerminal(props.sessionId, '\x03')
}

const sendCtrlL = () => {
  window.electronAPI.writeToTerminal(props.sessionId, '\x0c')
}

const copySelectionToClipboard = () => {
  if (!terminal) return
  const selectedText = terminal.getSelection()
  if (!selectedText) return

  const write = window?.electronAPI?.clipboardWriteText
    ? window.electronAPI.clipboardWriteText(selectedText)
    : navigator.clipboard.writeText(selectedText)

  Promise.resolve(write)
    .catch(() => {
      // Fallback for environments where clipboard API is unavailable.
      try {
        const textArea = document.createElement('textarea')
        textArea.value = selectedText
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
      } catch (_) {}
    })
    .finally(() => terminal?.clearSelection())
}

onMounted(() => {
  // Ensure we honor the current Settings value even if it was changed before any Terminal instance mounted.
  refreshMonitorThumbnailMode()

  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'underline',
    cursorInactiveStyle: 'none',
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
    rendererType: 'canvas',
    scrollback: 1000,
    // 完全禁用所有可能导致输入的选项
    rightClickSelectsWord: false,
    fastScrollModifier: 'alt',
    allowTransparency: false,
    macOptionIsMeta: false,
    // 禁用所有可能的自动行为
    disableStdin: false, // 我们手动控制
    convertEol: false,
    theme: {
      background: '#0a0a0a',
      foreground: '#e5e5e5',
      cursor: '#93c5fd',
      selectionBackground: 'rgba(147, 197, 253, 0.3)',
      selectionInactiveBackground: 'rgba(147, 197, 253, 0.15)',
      black: '#161616',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e5e5e5',
      brightBlack: '#737373',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#ffffff'
    }
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)

  // Use a resize-aware fit so terminals mounted under v-show/display-none settle correctly.
  scheduleHandleResize()

  unsubscribeTerminalRender = terminal.onRender(() => {
    if (!isTerminalPreviewEnabled()) return
    previewDirty = true
    schedulePreviewCapture()
  })
  previewDirty = true
  schedulePreviewCapture()
  if (props.isActive) terminal.focus()

  terminal.attachCustomKeyEventHandler((e) => {
    if (!e || !e.ctrlKey || e.altKey || e.metaKey) return true

    const key = String(e.key || '').toLowerCase()

    // Ctrl+C: copy when selecting, otherwise send SIGINT to PowerShell.
    if (!e.shiftKey && key === 'c') {
      if (terminal.hasSelection()) copySelectionToClipboard()
      else sendCtrlC()
      return false
    }

    // Ctrl+Shift+C: always copy selection (do not send data).
    if (e.shiftKey && key === 'c') {
      copySelectionToClipboard()
      return false
    }

    // Ctrl+K: hard clear (drop pending output + reset buffer/scrollback).
    if (!e.shiftKey && key === 'k') {
      hardClear()
      return false
    }

    // Ctrl+L: soft clear (clear viewport + prompt redraw).
    if (!e.shiftKey && key === 'l') {
      forceFullClear()
      sendCtrlL()
      return false
    }

    return true
  })

  // 更强的键盘输入控制
  let keyboardBlocked = false
  let lastSelectionState = false

  // 最严格的输入过滤
  terminal.onData(data => {
    trackInputForClear(data)
    // 三重检查：阻止标志、实时选择状态、上次选择状态
    const currentSelection = terminal.hasSelection()
    if (keyboardBlocked || currentSelection || lastSelectionState) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🚫 Input completely blocked:', {
          data: data,
          charCode: data.charCodeAt(0),
          keyboardBlocked,
          currentSelection,
          lastSelectionState
        })
      }
      return // 完全不发送任何数据
    }
    if (process.env.NODE_ENV === 'development') {
      console.log('✅ Input allowed:', data)
    }
    window.electronAPI.writeToTerminal(props.sessionId, data)
  })

  // 更频繁的选择状态跟踪
  terminal.onSelectionChange(() => {
    const hasSelection = terminal.hasSelection()
    const selectionChanged = hasSelection !== lastSelectionState

    isSelecting = hasSelection
    keyboardBlocked = hasSelection
    lastSelectionState = hasSelection

    if (hasSelection) {
      extendSelectionGuard()
      const pos = terminal.getSelectionPosition()
      if (pos) {
        didSelectSinceMouseDown = true
        lastSelectionPosition = pos
        lastSelectionAt = Date.now()
      }
    } else {
      scheduleFlushAfterGuard()
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('🔄 Selection state changed:', {
        hasSelection,
        selectionChanged,
        keyboardBlocked
      })
    }

    // 如果有选择，延迟一段时间保持阻止状态
    if (hasSelection) {
      setTimeout(() => {
        if (!terminal.hasSelection()) {
          keyboardBlocked = false
          lastSelectionState = false
          if (process.env.NODE_ENV === 'development') {
            console.log('⏰ Delayed unblock - selection cleared')
          }
        }
      }, 100) // 100ms的缓冲时间
    }
  })

  // 处理右键菜单
  terminalRef.value.addEventListener('contextmenu', handleContextMenu)

  // 处理鼠标事件
  // Capture phase to ensure we see the event even if xterm stops propagation.
  terminalRef.value.addEventListener('mousedown', handleMouseDown, true)
  window.addEventListener('mouseup', handleMouseUp, true)

  // 更全面的键盘事件阻止（所有阶段）
  keyboardHandler = (e) => {
    if (e && e.key === 'Escape' && terminal.hasSelection()) {
      terminal.clearSelection()
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      return false
    }

    if (e && e.ctrlKey && !e.altKey && !e.metaKey) {
      const key = String(e.key || '').toLowerCase()
      if (!e.shiftKey && key === 'c') {
        if (terminal.hasSelection()) copySelectionToClipboard()
        else sendCtrlC()
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return false
      }
      if (e.shiftKey && key === 'c') {
        copySelectionToClipboard()
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return false
      }
      if (!e.shiftKey && key === 'k') {
        hardClear()
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return false
      }
      if (!e.shiftKey && key === 'l') {
        forceFullClear()
        sendCtrlL()
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return false
      }
    }
    const currentSelection = terminal.hasSelection()
    if (keyboardBlocked || currentSelection || lastSelectionState) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🚫 Keyboard event blocked:', {
          type: e.type,
          key: e.key,
          code: e.code,
          keyboardBlocked,
          currentSelection,
          lastSelectionState
        })
      }
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      return false
    }
  }

  // 在所有阶段拦截键盘事件
  terminalRef.value.addEventListener('keydown', keyboardHandler, true)
  terminalRef.value.addEventListener('keyup', keyboardHandler, true)
  terminalRef.value.addEventListener('keypress', keyboardHandler, true)
  terminalRef.value.addEventListener('input', keyboardHandler, true)
  terminalRef.value.addEventListener('beforeinput', keyboardHandler, true)

  // 阻止可能的粘贴和其他输入方式
  pasteHandler = (e) => {
    if (keyboardBlocked || terminal.hasSelection() || lastSelectionState) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🚫 Paste blocked due to selection')
      }
      e.preventDefault()
      return false
    }
  }
  terminalRef.value.addEventListener('paste', pasteHandler, true)

  // 阻止拖拽输入
  dropHandler = (e) => {
    if (keyboardBlocked || terminal.hasSelection() || lastSelectionState) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🚫 Drop blocked due to selection')
      }
      e.preventDefault()
      return false
    }
  }
  terminalRef.value.addEventListener('drop', dropHandler, true)

  unsubscribeTerminalData = window.electronAPI.onTerminalData(props.sessionId, enqueueTerminalWrite)

  window.addEventListener('mps:monitor-settings', refreshMonitorThumbnailMode)
  window.addEventListener('resize', handleResize)

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleHandleResize())
    try {
      resizeObserver.observe(terminalRef.value)
    } catch (_) {
      resizeObserver = null
    }
  }
})

const handleMouseDown = (e) => {
  // 清除之前的选择超时
  if (selectionTimeout) {
    clearTimeout(selectionTimeout)
    selectionTimeout = null
  }

  if (e && e.button === 0) {
    mouseDownSelecting = true
    didSelectSinceMouseDown = false
    lastSelectionPosition = null
    lastSelectionAt = 0
    extendSelectionGuard()
  }

  // 如果是连续快速点击，防止发送额外的命令
  if (e.detail > 2) {
    e.preventDefault()
    return false
  }

  // 记录鼠标按下时间，用于区分点击和拖拽
  e.target._mouseDownTime = Date.now()
}

const handleMouseUp = (e) => {
  if (mouseDownSelecting) mouseDownSelecting = false
  extendSelectionGuard(MOUSE_UP_GUARD_MS)
  scheduleFlushAfterGuard()

  // If xterm drops the selection right after mouseup (common under heavy output),
  // restore the last non-empty selection captured during this drag.
  setTimeout(() => {
    if (!terminal) return
    if (terminal.hasSelection()) return
    if (!didSelectSinceMouseDown || !lastSelectionPosition) return
    if (Date.now() - lastSelectionAt > 250) return

    const { start, end } = lastSelectionPosition
    const cols = terminal.cols
    const startIndex = start.y * cols + start.x
    const endIndex = end.y * cols + end.x
    const length = endIndex - startIndex
    if (length > 0) {
      terminal.select(start.x, start.y, length)
      extendSelectionGuard()
    }
  }, 50)

  // 立即检查选择状态
  setTimeout(() => {
    const hasSelection = terminal.hasSelection()
    isSelecting = hasSelection

    if (hasSelection) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🎯 Mouse up: selection detected, input will be blocked')
      }
      extendSelectionGuard()
    } else {
      if (process.env.NODE_ENV === 'development') {
        console.log('🎯 Mouse up: no selection, input allowed')
      }
      scheduleFlushAfterGuard()
    }
  }, 20) // 稍微延迟确保xterm完成选择处理
}

const handleContextMenu = (e) => {
  e.preventDefault()

  // 检查是否有选中的文本
  if (terminal.hasSelection()) {
    const selectedText = terminal.getSelection()
    if (selectedText) {
      // 复制选中的文本到剪贴板（优先走 Electron clipboard，避免 navigator.clipboard 的权限/延迟）
      copySelectionToClipboard()
    }
  } else {
    // 如果没有选中文本，可以显示粘贴选项
    const read = window?.electronAPI?.clipboardReadText
      ? window.electronAPI.clipboardReadText()
      : navigator.clipboard.readText()

    Promise.resolve(read)
      .then(text => {
        if (!text) return
        // Use xterm's paste pipeline so bracketed paste mode and cursor updates behave
        // like a real user paste (some TUIs get confused when we write raw bytes).
        terminal?.paste(text)
      })
      .catch(() => {})
  }
}

const handleResize = () => {
  if (!terminal || !fitAddon) return

  const rect = (() => {
    try {
      return terminalRef.value?.getBoundingClientRect?.() || null
    } catch (_) {
      return null
    }
  })()

  // When the terminal is hidden via v-show (display:none), the container is 0x0.
  // Resizing the backing PTY at that point can cause ConPTY/PowerShell to redraw
  // the prompt, resulting in duplicated prompt lines when users switch views.
  if (!rect || rect.width <= 0 || rect.height <= 0) return

  // Active terminal: resize both xterm and the backing PTY.
  if (props.isActive) {
    try {
      fitAddon.fit()
    } catch (_) {
      return
    }
    const { cols, rows } = terminal
    if (cols > 0 && rows > 0 && (cols !== lastPtyCols || rows !== lastPtyRows)) {
      lastPtyCols = cols
      lastPtyRows = rows
      window.electronAPI.resizeTerminal(props.sessionId, cols, rows)
    }
    previewDirty = true
    schedulePreviewCapture(true)
    return
  }

  // Preview terminals: keep xterm sized (for canvas capture), but do not resize the PTY.
  if (isTerminalPreviewEnabled()) {
    try {
      fitAddon.fit()
      if (terminal.rows) terminal.refresh(0, terminal.rows - 1)
    } catch (_) {}
    previewDirty = true
    schedulePreviewCapture(true)
  }
}

watch(() => props.isActive, (active) => {
  if (!terminal) return
  if (active) {
    terminal.focus()
    setTimeout(() => handleResize(), 100)
  } else {
    terminal.blur()
  }
})

onUnmounted(() => {
  if (selectionTimeout) {
    clearTimeout(selectionTimeout)
  }

  terminalRef.value?.removeEventListener('contextmenu', handleContextMenu)
  terminalRef.value?.removeEventListener('mousedown', handleMouseDown, true)
  window.removeEventListener('mouseup', handleMouseUp, true)

  // 清除所有键盘事件监听器
  if (keyboardHandler) {
    terminalRef.value?.removeEventListener('keydown', keyboardHandler, true)
    terminalRef.value?.removeEventListener('keyup', keyboardHandler, true)
    terminalRef.value?.removeEventListener('keypress', keyboardHandler, true)
    terminalRef.value?.removeEventListener('input', keyboardHandler, true)
    terminalRef.value?.removeEventListener('beforeinput', keyboardHandler, true)
    keyboardHandler = null
  }

  if (pasteHandler) {
    terminalRef.value?.removeEventListener('paste', pasteHandler, true)
    pasteHandler = null
  }

  if (dropHandler) {
    terminalRef.value?.removeEventListener('drop', dropHandler, true)
    dropHandler = null
  }

  if (typeof unsubscribeTerminalData === 'function') {
    unsubscribeTerminalData()
    unsubscribeTerminalData = null
  }
  if (unsubscribeTerminalRender) {
    try {
      unsubscribeTerminalRender.dispose()
    } catch (_) {}
    unsubscribeTerminalRender = null
  }

  window.removeEventListener('resize', handleResize)
  window.removeEventListener('mps:monitor-settings', refreshMonitorThumbnailMode)
  if (resizeObserver) {
    try {
      resizeObserver.disconnect()
    } catch (_) {}
    resizeObserver = null
  }
  if (resizeObserverRafId != null) {
    cancelAnimationFrame(resizeObserverRafId)
    clearTimeout(resizeObserverRafId)
    resizeObserverRafId = null
  }
  clearPreviewResources()
  dropPendingWrites()
  terminal?.dispose()
})
</script>

<template>
  <div class="terminal-wrapper">
    <div ref="terminalRef" class="terminal-container"></div>
  </div>
</template>

<style scoped>
.terminal-wrapper {
  width: 100%;
  height: 100%;
  padding: 8px;
  box-sizing: border-box;
  background: #0a0a0a;
}

.terminal-container {
  width: 100%;
  height: 100%;
  position: relative;
}

.terminal-container :deep(.xterm) {
  height: 100%;
}

.terminal-container :deep(.xterm-viewport) {
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--surface-active) transparent;
}

.terminal-container :deep(.xterm .xterm-cursor-blink) {
  animation-duration: 1.8s !important;
}

.terminal-container :deep(.xterm-helper-textarea) {
  opacity: 0 !important;
  caret-color: transparent !important;
}

.terminal-container :deep(.xterm-viewport::-webkit-scrollbar) {
  width: 10px;
  height: 10px;
}

.terminal-container :deep(.xterm-viewport::-webkit-scrollbar-track) {
  background: transparent;
}

.terminal-container :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: var(--surface-active);
  border-radius: var(--radius-sm);
  border: 2px solid var(--bg-color);
}

.terminal-container :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
  background: var(--text-secondary);
}
</style>

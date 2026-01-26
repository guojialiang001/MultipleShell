<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

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
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
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
      background: '#09090b',
      foreground: '#e4e4e7',
      cursor: '#3b82f6',
      selectionBackground: 'rgba(59, 130, 246, 0.3)',
      selectionInactiveBackground: 'rgba(59, 130, 246, 0.3)',
      black: '#000000',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e4e4e7',
      brightBlack: '#71717a',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff'
    }
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)
  fitAddon.fit()

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
      console.log('🚫 Input completely blocked:', {
        data: data,
        charCode: data.charCodeAt(0),
        keyboardBlocked,
        currentSelection,
        lastSelectionState
      })
      return // 完全不发送任何数据
    }
    console.log('✅ Input allowed:', data)
    window.electronAPI.writeToTerminal(props.sessionId, data)
  })

  // 更频繁的选择状态监控
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

    console.log('🔄 Selection state changed:', {
      hasSelection,
      selectionChanged,
      keyboardBlocked
    })

    // 如果有选择，延迟一段时间保持阻止状态
    if (hasSelection) {
      setTimeout(() => {
        if (!terminal.hasSelection()) {
          keyboardBlocked = false
          lastSelectionState = false
          console.log('⏰ Delayed unblock - selection cleared')
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
      console.log('🚫 Keyboard event blocked:', {
        type: e.type,
        key: e.key,
        code: e.code,
        keyboardBlocked,
        currentSelection,
        lastSelectionState
      })
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
      console.log('🚫 Paste blocked due to selection')
      e.preventDefault()
      return false
    }
  }
  terminalRef.value.addEventListener('paste', pasteHandler, true)

  // 阻止拖拽输入
  dropHandler = (e) => {
    if (keyboardBlocked || terminal.hasSelection() || lastSelectionState) {
      console.log('🚫 Drop blocked due to selection')
      e.preventDefault()
      return false
    }
  }
  terminalRef.value.addEventListener('drop', dropHandler, true)

  unsubscribeTerminalData = window.electronAPI.onTerminalData(props.sessionId, enqueueTerminalWrite)

  window.addEventListener('resize', handleResize)
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
      console.log('🎯 Mouse up: selection detected, input will be blocked')
      extendSelectionGuard()
    } else {
      console.log('🎯 Mouse up: no selection, input allowed')
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
  if (fitAddon && props.isActive) {
    fitAddon.fit()
    const { cols, rows } = terminal
    window.electronAPI.resizeTerminal(props.sessionId, cols, rows)
  }
}

watch(() => props.isActive, (active) => {
  if (active) {
    setTimeout(() => handleResize(), 100)
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

  window.removeEventListener('resize', handleResize)
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
  background: #09090b;
}

.terminal-container {
  width: 100%;
  height: 100%;
}
</style>

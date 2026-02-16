const { EventEmitter } = require('events')
const { RULES_BY_TYPE, ERROR_PATTERNS, ERROR_EXCLUDE_PATTERNS } = require('./shell-monitor-rules')

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const PROMPT_MARKER = '__MPS_PROMPT__'
const CWD_MARKER = '__MPS_CWD__'
const TOOL_MARKER = '__MPS_TOOL__'
const TOOL_RESULT_MARKER = '__MPS_TOOL_RESULT__'

const stripAnsi = (value) => String(value || '').replace(ANSI_RE, '')

class ShellMonitor extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.sessions = new Map() // sessionId -> internal state
    this.options = {
      idleMs: 30_000,
      stuckMs: 10 * 60_000,
      maxLastLines: 20,
      maxLineLength: 2048,
      maxRemainderChars: 4096,
      updateThrottleMs: 250,
      ...opts
    }
  }

  isInternalMarkerLine(line) {
    const value = String(line || '').trim()
    if (!value) return false
    const upper = value.toUpperCase()
    return (
      upper.startsWith(PROMPT_MARKER) ||
      upper.startsWith(CWD_MARKER) ||
      upper.startsWith(TOOL_MARKER) ||
      upper.startsWith(TOOL_RESULT_MARKER)
    )
  }

  truncateLine(line) {
    const max = Number(this.options.maxLineLength || 0)
    const value = String(line || '')
    if (!max || value.length <= max) return value
    if (max <= 3) return value.slice(0, max)
    return value.slice(0, max - 3) + '...'
  }

  isFinal(state) {
    // Once the underlying process exits we freeze the state (ignore further data/input).
    // "error" can be a sticky UI state while the process is still alive.
    return Boolean(state && (state.endTime != null || state.processExitCode != null))
  }

  registerSession(sessionId, configType, meta = {}) {
    if (!sessionId) return
    const now = Date.now()
    const existing = this.sessions.get(sessionId)
    if (existing) return

    this.sessions.set(sessionId, {
      sessionId,
      configType,
      status: 'starting',
      startTime: now,
      endTime: null,
      lastInputTime: null,
      lastOutputTime: null,
      lastActivityTime: now,
      outputLineCount: 0,
      errorCount: 0,
      completionDetected: false,
      promptDetected: false,
      processExitCode: null,
      lastLine: '',
      lastErrorLine: '',
      lastLines: [],
      remainder: '',
      _dirty: true,
      _notifyTimer: null,
      ...meta
    })

    this.queueNotify(sessionId, { immediate: true })
  }

  unregisterSession(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state._notifyTimer) {
      clearTimeout(state._notifyTimer)
      state._notifyTimer = null
    }
    this.sessions.delete(sessionId)
    this.emit('update', { sessionId, state: null })
  }

  onUserInput(sessionId, _data) {
    const state = this.sessions.get(sessionId)
    if (!state || this.isFinal(state)) return

    const now = Date.now()
    state.lastInputTime = now
    state.lastActivityTime = now

    // New round: reset sticky markers so "completed/error" doesn't stick forever.
    state.completionDetected = false
    state.promptDetected = false

    if (state.status !== 'starting') state.status = 'running'
    state._dirty = true
    this.queueNotify(sessionId)
  }

  extractCwdFromPromptLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return null

    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const raw = String(lines[idx] || '').trimEnd()
      if (!raw) continue
      if (this.isInternalMarkerLine(raw)) continue

      const cwdMarker = raw.match(/^__MPS_CWD__\s*(.+)\s*$/i)
      if (cwdMarker) {
        const value = String(cwdMarker[1] || '').trim()
        if (value) return value
      }

      const psPrompt = raw.match(/^(?:\[[^\]]+\]:\s*)?PS\s+([^>\r\n]+)>\s*$/i)
      if (!psPrompt) continue

      let value = String(psPrompt[1] || '').trim()
      if (!value) continue

      // Common provider-qualified form: Microsoft.PowerShell.Core\FileSystem::C:\...
      const qualifierIdx = value.lastIndexOf('::')
      if (qualifierIdx !== -1) {
        const candidate = value.slice(qualifierIdx + 2)
        if (/^[A-Za-z]:[\\/]/.test(candidate)) value = candidate
      }

      return value
    }

    return null
  }

  normalizeLines(state, data) {
    const stripped = stripAnsi(data)
    const normalized = stripped.replace(/\r\n/g, '\n')
    const hasCarriageReturn = normalized.includes('\r')
    const text = normalized.replace(/\r/g, '\n')
    const merged = (hasCarriageReturn ? '' : state.remainder) + text
    const parts = merged.split('\n')
    state.remainder = parts.pop() || ''
    const maxRemainder = Number(this.options.maxRemainderChars || 0)
    if (maxRemainder > 0 && state.remainder.length > maxRemainder) {
      state.remainder = state.remainder.slice(-maxRemainder)
    }
    return parts
      .map((line) => String(line))
      .filter((line) => line.length > 0)
  }

  pushLastLines(state, lines) {
    for (const line of lines) {
      let trimmed = String(line).trimEnd()
      if (!trimmed) continue
      if (this.isInternalMarkerLine(trimmed)) continue
      trimmed = this.truncateLine(trimmed)
      state.lastLines.push(trimmed)
      if (state.lastLines.length > this.options.maxLastLines) {
        state.lastLines.splice(0, state.lastLines.length - this.options.maxLastLines)
      }
      state.lastLine = trimmed
    }
  }

  matchAny(lines, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return false
    return lines.some((line) => patterns.some((re) => re.test(line)))
  }

  onData(sessionId, data) {
    const state = this.sessions.get(sessionId)
    if (!state || this.isFinal(state)) return

    const now = Date.now()
    state.lastOutputTime = now
    state.lastActivityTime = now

    // Any new output pulls idle/stuck/completed back to running.
    if (state.status === 'idle' || state.status === 'stuck' || state.status === 'completed') {
      state.status = 'running'
    } else if (state.status === 'starting') {
      state.status = 'running'
    }

    const lines = this.normalizeLines(state, data)
    const tail = String(state.remainder || '').trimEnd()
    const hasTail = tail.length > 0 && tail.length <= 512
    const matchLines = hasTail ? [...lines, tail] : lines
    if (matchLines.length === 0) return

    if (lines.length > 0) {
      let count = 0
      for (const line of lines) {
        const trimmed = String(line).trimEnd()
        if (!trimmed) continue
        if (this.isInternalMarkerLine(trimmed)) continue
        count += 1
      }
      state.outputLineCount += count
      this.pushLastLines(state, lines)
    }

    if (hasTail && tail !== state.lastLine) {
      const trimmedTail = String(tail).trimEnd()
      if (trimmedTail && !this.isInternalMarkerLine(trimmedTail)) {
        // Keep lastLine reasonably fresh even when the output chunk doesn't end with a newline
        // (e.g. PowerShell prompt line, or the prompt marker is emitted as a "line" via CR).
        state.lastLine = this.truncateLine(trimmedTail)
      }
    }

    const rules = RULES_BY_TYPE[state.configType] || {}
    const promptHit = this.matchAny(matchLines, rules.promptPatterns)
    const completionHit = this.matchAny(matchLines, rules.completionPatterns)

    const excluded = this.matchAny(matchLines, ERROR_EXCLUDE_PATTERNS)
    const toolErrorHit = this.matchAny(matchLines, rules.errorPatterns)
    const fallbackErrorHit = !excluded && this.matchAny(matchLines, ERROR_PATTERNS)

    if (toolErrorHit || fallbackErrorHit) {
      state.errorCount += 1
      state.lastErrorLine = state.lastLine
      if (state.errorCount >= 3) state.status = 'error'
    }

    if (completionHit) state.completionDetected = true

    if (promptHit) {
      state.promptDetected = true
      state.status = state.completionDetected ? 'completed' : 'idle'
    }

    if (promptHit) {
      const nextCwd = this.extractCwdFromPromptLines(matchLines)
      if (typeof nextCwd === 'string' && nextCwd.trim() && nextCwd !== state.cwd) {
        state.cwd = nextCwd
      }
    }

    state._dirty = true
    this.queueNotify(sessionId)
  }

  onExit(sessionId, exitCode) {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.processExitCode = exitCode
    state.endTime = Date.now()
    state.status = exitCode === 0 ? (state.completionDetected ? 'completed' : 'stopped') : 'error'

    state._dirty = true
    this.queueNotify(sessionId, { immediate: true })
  }

  tick() {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (this.isFinal(state)) continue
      if (state.status !== 'running' && state.status !== 'starting') continue

      const last = state.lastOutputTime || state.lastActivityTime || state.startTime
      const silentMs = now - last

      if (silentMs >= this.options.stuckMs) {
        state.status = 'stuck'
        state._dirty = true
        this.queueNotify(sessionId)
        continue
      }

      if (silentMs >= this.options.idleMs) {
        state.status = 'idle'
        state._dirty = true
        this.queueNotify(sessionId)
      }
    }
  }

  buildPublicState(state) {
    return {
      sessionId: state.sessionId,
      configType: state.configType,
      status: state.status,
      startTime: state.startTime,
      endTime: state.endTime,
      cwd: typeof state.cwd === 'string' ? state.cwd : '',
      lastActivityTime: state.lastActivityTime,
      outputLineCount: state.outputLineCount,
      errorCount: state.errorCount,
      processExitCode: state.processExitCode,
      lastLine: state.lastLine,
      lastErrorLine: state.lastErrorLine,
      lastLines: state.lastLines
    }
  }

  queueNotify(sessionId, { immediate = false } = {}) {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state._notifyTimer) return

    const delay = immediate ? 0 : this.options.updateThrottleMs
    state._notifyTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId)
      if (!s) return
      s._notifyTimer = null
      if (!s._dirty) return
      s._dirty = false
      this.emit('update', { sessionId, state: this.buildPublicState(s) })
    }, delay)
  }

  getAllStates() {
    return Array.from(this.sessions.values()).map((s) => this.buildPublicState(s))
  }
}

module.exports = new ShellMonitor()

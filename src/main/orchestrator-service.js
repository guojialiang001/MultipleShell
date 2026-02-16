const TOOL_MARKER = '__MPS_TOOL__'
const TOOL_RESULT_MARKER = '__MPS_TOOL_RESULT__'

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

const stripAnsi = (value) => String(value || '').replace(ANSI_RE, '')

const safeJsonParse = (text) => {
  try {
    return JSON.parse(String(text || ''))
  } catch (_) {
    return null
  }
}

const normalizeParamsObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  return {}
}

const tryDecodeBase64Payload = (raw) => {
  const text = String(raw || '').trim()
  if (!text) return ''
  const prefix = text.toLowerCase()
  if (prefix.startsWith('base64:')) return Buffer.from(text.slice('base64:'.length), 'base64').toString('utf8')
  if (prefix.startsWith('b64:')) return Buffer.from(text.slice('b64:'.length), 'base64').toString('utf8')
  return ''
}

const parseToolCallLine = (line) => {
  const trimmed = String(line || '').trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()
  if (!upper.startsWith(TOOL_MARKER)) return null

  const rest = trimmed.slice(TOOL_MARKER.length).trim()
  if (!rest) return null

  let payloadText = rest
  const decoded = tryDecodeBase64Payload(rest)
  if (decoded) payloadText = decoded

  const payload = safeJsonParse(payloadText)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const method = typeof payload.method === 'string' ? payload.method.trim() : ''
  if (!method) return null

  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  const params = normalizeParamsObject(payload.params)
  return { id, method, params }
}

function createOrchestratorService(options = {}) {
  const dispatch = typeof options.dispatch === 'function' ? options.dispatch : null
  const writeToSession = typeof options.writeToSession === 'function' ? options.writeToSession : null
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxBufferCharsRaw = Number(options.maxBufferChars)
  const maxBufferChars =
    Number.isFinite(maxBufferCharsRaw) && maxBufferCharsRaw > 4096 ? Math.floor(maxBufferCharsRaw) : 256 * 1024

  const buffers = new Map() // sessionId -> remainder (string)
  let seq = 1

  const makeId = () => `t${now().toString(36)}_${(seq++).toString(36)}`

  const sendToolResult = (sessionId, payload) => {
    if (!writeToSession) return
    const line = `${TOOL_RESULT_MARKER} ${JSON.stringify(payload)}`
    // NOTE: We inject tool results as an *input line* (ENTER) so interactive agent CLIs
    // can "receive" it as the next user message.
    writeToSession(sessionId, `${line}\r`)
  }

  const handleToolCall = async (sessionId, call) => {
    if (!dispatch) return
    const id = call?.id ? String(call.id).trim() : ''
    const toolId = id || makeId()

    try {
      if (onEvent) {
        try {
          onEvent({ type: 'tool_call', sessionId, id: toolId, method: call.method, params: call.params })
        } catch (_) {}
      }
      const result = await dispatch({
        sessionId,
        id: toolId,
        method: call.method,
        params: call.params
      })
      if (onEvent) {
        try {
          onEvent({ type: 'tool_result', sessionId, id: toolId, method: call.method, ok: true, result })
        } catch (_) {}
      }
      sendToolResult(sessionId, { id: toolId, ok: true, result: result == null ? null : result })
    } catch (err) {
      if (onEvent) {
        try {
          onEvent({
            type: 'tool_result',
            sessionId,
            id: toolId,
            method: call.method,
            ok: false,
            error: { message: err?.message || String(err), code: err?.code || 'ERROR' }
          })
        } catch (_) {}
      }
      sendToolResult(sessionId, {
        id: toolId,
        ok: false,
        error: {
          message: err?.message || String(err),
          code: err?.code || 'ERROR'
        }
      })
    }
  }

  const onTerminalData = async (sessionId, data) => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!sid) return
    if (typeof data !== 'string' || !data) return

    const prev = buffers.get(sid) || ''
    let text = prev + stripAnsi(data)
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (text.length > maxBufferChars) text = text.slice(-maxBufferChars)

    const lines = text.split('\n')
    const remainder = lines.pop() || ''
    buffers.set(sid, remainder)

    for (const line of lines) {
      const call = parseToolCallLine(line)
      if (!call) continue
      await handleToolCall(sid, call)
    }
  }

  const onTerminalExit = (sessionId) => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!sid) return
    buffers.delete(sid)
  }

  return {
    onTerminalData,
    onTerminalExit
  }
}

module.exports = {
  TOOL_MARKER,
  TOOL_RESULT_MARKER,
  createOrchestratorService
}

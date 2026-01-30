const previews = new Map()
const listeners = new Set()
const logged = new Set()

const isDebugEnabled = () => {
  try {
    const raw = String(localStorage.getItem('mps.debug.preview') || '').trim().toLowerCase()
    if (!raw) return process.env.NODE_ENV === 'development'
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
  } catch (_) {
    return process.env.NODE_ENV === 'development'
  }
}

export const getTerminalPreview = (sessionId) => {
  if (typeof sessionId !== 'string' || !sessionId) return ''
  return previews.get(sessionId) || ''
}

export const getAllTerminalPreviews = () => {
  const out = {}
  for (const [sessionId, url] of previews.entries()) {
    if (!sessionId || !url) continue
    out[sessionId] = url
  }
  return out
}

export const setTerminalPreview = (sessionId, url) => {
  if (typeof sessionId !== 'string' || !sessionId) return
  const value = typeof url === 'string' ? url : ''

  if (!value) previews.delete(sessionId)
  else previews.set(sessionId, value)

  if (isDebugEnabled()) {
    const key = `${sessionId}:${value ? 'set' : 'clear'}`
    if (!logged.has(key)) {
      logged.add(key)
      const kind = value.startsWith('blob:') ? 'blob' : value.startsWith('data:') ? 'data' : value ? 'other' : 'empty'
      // eslint-disable-next-line no-console
      console.log('[mps] preview store', { sessionId, kind, length: value.length })
    }
  }

  for (const listener of listeners) {
    try {
      listener({ sessionId, url: value })
    } catch (_) {}
  }
}

export const clearTerminalPreview = (sessionId) => {
  setTerminalPreview(sessionId, '')
}

export const onTerminalPreviewUpdate = (listener) => {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

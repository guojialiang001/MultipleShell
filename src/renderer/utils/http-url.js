export const validateHttpUrl = (input) => {
  const raw = String(input ?? '').trim()

  if (!raw) {
    return {
      raw: '',
      isEmpty: true,
      isValid: false,
      error: null,
      warning: null,
      protocol: null
    }
  }

  if (/\s/.test(raw)) {
    return {
      raw,
      isEmpty: false,
      isValid: false,
      error: 'whitespace',
      warning: null,
      protocol: null
    }
  }

  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    return {
      raw,
      isEmpty: false,
      isValid: false,
      error: 'invalid',
      warning: null,
      protocol: null
    }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      raw,
      isEmpty: false,
      isValid: false,
      error: 'protocol',
      warning: null,
      protocol: parsed.protocol
    }
  }

  return {
    raw,
    isEmpty: false,
    isValid: true,
    error: null,
    warning: parsed.protocol === 'http:' ? 'http' : null,
    protocol: parsed.protocol
  }
}


const RULES_BY_TYPE = {
  'claude-code': {
    promptPatterns: [
      /^PS [^>\r\n]+>\s*$/i,
      /^__MPS_PROMPT__\b.*$/i
    ],
    completionPatterns: [
      /\btask completed\b/i,
      /\bcompleted successfully\b/i,
      /\ball tests passed\b/i,
      /\bbuild succeeded\b/i
    ],
    errorPatterns: [
      /\bunhandled (?:exception|error)\b/i,
      /\btraceback \(most recent call last\)\b/i,
      /\bpanic:\b/i
    ]
  },
  codex: {
    promptPatterns: [
      /^PS [^>\r\n]+>\s*$/i,
      /^__MPS_PROMPT__\b.*$/i,
      /^codex>\s*$/i
    ],
    completionPatterns: [
      /\boperation completed\b/i,
      /\ball tests passed\b/i,
      /\bcompleted successfully\b/i
    ],
    errorPatterns: [
      /\bopenai\b.*\b(unauthorized|forbidden)\b/i
    ]
  },
  opencode: {
    promptPatterns: [
      /^PS [^>\r\n]+>\s*$/i,
      /^__MPS_PROMPT__\b.*$/i,
      /^opencode>\s*$/i
    ],
    completionPatterns: [
      /\bsuccessfully completed\b/i,
      /\ball operations done\b/i
    ],
    errorPatterns: [
      /\bpermission\b.*\bdenied\b/i
    ]
  }
}

// Generic fallback error detection (exclude "0 failed"/"no error" style success lines).
const ERROR_PATTERNS = [
  /\bfatal\b/i,
  /\bpanic\b/i,
  /\b(unhandled|uncaught)\b.*\b(exception|error)\b/i,
  /\bexception\b/i,
  /\berror\b/i,
  /\bpermission denied\b/i,
  /\btimeout\b/i,
  /\bexit code:\s*[1-9]\d*\b/i
]

const ERROR_EXCLUDE_PATTERNS = [
  /\b0 failed\b/i,
  /\bno errors?\b/i,
  /\berrors?:\s*0\b/i
]

module.exports = {
  RULES_BY_TYPE,
  ERROR_PATTERNS,
  ERROR_EXCLUDE_PATTERNS
}


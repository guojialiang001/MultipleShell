const assert = require('assert')

const monitor = require('../src/main/shell-monitor')

function run() {
  const original = { ...monitor.options }

  // Tight limits so the check can assert bounds deterministically.
  monitor.options.maxLastLines = 20
  monitor.options.maxLineLength = 128
  monitor.options.maxRemainderChars = 256
  monitor.options.updateThrottleMs = 0

  const base = `selfcheck-stress-${Date.now()}`
  const sessionIds = Array.from({ length: 12 }, (_, i) => `${base}-${i}`)

  try {
    for (const sid of sessionIds) monitor.registerSession(sid, 'codex')

    // Many lines (including very long lines) should not grow memory unbounded.
    for (const sid of sessionIds) {
      for (let i = 0; i < 200; i++) {
        const long = `line-${i}-` + 'x'.repeat(500)
        monitor.onData(sid, `${long}\r\n`)
      }

      const state = monitor.sessions.get(sid)
      assert.ok(state, 'state should exist')
      assert.ok(state.lastLines.length <= monitor.options.maxLastLines, 'lastLines should be capped')
      for (const line of state.lastLines) {
        assert.ok(String(line).length <= monitor.options.maxLineLength, 'stored lines should be truncated')
      }
      assert.ok(String(state.lastLine || '').length <= monitor.options.maxLineLength, 'lastLine should be truncated')
    }

    // Huge chunk without a newline should not keep growing remainder forever.
    const sid0 = sessionIds[0]
    const huge = 'y'.repeat(2048) // intentionally > maxRemainderChars
    monitor.onData(sid0, huge)
    const st0 = monitor.sessions.get(sid0)
    assert.ok(st0.remainder.length <= monitor.options.maxRemainderChars, 'remainder should be capped')

    // Prompt marker lines should not pollute lastLine / outputLineCount.
    const before = st0.outputLineCount
    monitor.onData(sid0, '__MPS_PROMPT__\rPS C:\\Users\\me>')
    const after = st0.outputLineCount
    assert.strictEqual(after, before, 'prompt marker should not increment outputLineCount')
    assert.ok(!String(st0.lastLine).includes('__MPS_PROMPT__'), 'lastLine should not contain prompt marker')
  } finally {
    for (const sid of sessionIds) {
      try { monitor.unregisterSession(sid) } catch (_) {}
    }
    monitor.options.idleMs = original.idleMs
    monitor.options.stuckMs = original.stuckMs
    monitor.options.maxLastLines = original.maxLastLines
    monitor.options.maxLineLength = original.maxLineLength
    monitor.options.maxRemainderChars = original.maxRemainderChars
    monitor.options.updateThrottleMs = original.updateThrottleMs
  }

  return true
}

if (require.main === module) {
  run()
  // eslint-disable-next-line no-console
  console.log('[monitor-stresscheck] OK')
}

module.exports = { run }


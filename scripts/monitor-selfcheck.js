const assert = require('assert')

const monitor = require('../src/main/shell-monitor')

function run() {
  const originalIdleMs = monitor.options.idleMs
  const originalStuckMs = monitor.options.stuckMs

  // Keep the selfcheck fast and deterministic.
  monitor.options.idleMs = 10
  monitor.options.stuckMs = 20

  const sid = `selfcheck-${Date.now()}`

  monitor.registerSession(sid, 'codex')
  let state = monitor.sessions.get(sid)
  assert.ok(state, 'session should exist after register')
  assert.strictEqual(state.status, 'starting')

  monitor.onData(sid, '\u001b[31mhello\u001b[0m\r\n')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'running')
  assert.strictEqual(state.outputLineCount, 1)
  assert.strictEqual(state.lastLine, 'hello')

  // Prompt may arrive without a newline.
  monitor.onData(sid, 'PS C:\\Users\\me>')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'idle')
  assert.strictEqual(state.lastLine, 'PS C:\\Users\\me>')

  monitor.onUserInput(sid, 'dir\r')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'running')

  monitor.onData(sid, 'error\r\n')
  monitor.onData(sid, 'error\r\n')
  monitor.onData(sid, 'error\r\n')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'error')

  // Output-driven errors are sticky but should reset on new user input (process still alive).
  monitor.onUserInput(sid, 'echo ok\r')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'running')

  // Process exit freezes the state.
  monitor.onExit(sid, 1)
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'error')
  assert.ok(state.endTime != null)
  monitor.onUserInput(sid, 'echo should-not-reset\r')
  state = monitor.sessions.get(sid)
  assert.strictEqual(state.status, 'error')

  monitor.unregisterSession(sid)
  assert.ok(!monitor.sessions.has(sid), 'session should be removed after unregister')

  // Tick-based idle/stuck detection.
  const sid2 = `${sid}-tick`
  monitor.registerSession(sid2, 'codex')
  monitor.onData(sid2, 'hello\r\n')
  state = monitor.sessions.get(sid2)
  assert.strictEqual(state.status, 'running')

  state.lastOutputTime = Date.now() - 15
  state.lastActivityTime = state.lastOutputTime
  monitor.tick()
  state = monitor.sessions.get(sid2)
  assert.strictEqual(state.status, 'idle')

  monitor.onUserInput(sid2, 'dir\r')
  state = monitor.sessions.get(sid2)
  assert.strictEqual(state.status, 'running')

  state.lastOutputTime = Date.now() - 25
  state.lastActivityTime = state.lastOutputTime
  monitor.tick()
  state = monitor.sessions.get(sid2)
  assert.strictEqual(state.status, 'stuck')

  monitor.unregisterSession(sid2)

  monitor.options.idleMs = originalIdleMs
  monitor.options.stuckMs = originalStuckMs

  return true
}

if (require.main === module) {
  run()
  // eslint-disable-next-line no-console
  console.log('[monitor-selfcheck] OK')
}

module.exports = { run }

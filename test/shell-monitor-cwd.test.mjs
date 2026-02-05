import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const shellMonitor = require('../src/main/shell-monitor.js')

const getState = (sessionId) => shellMonitor.getAllStates().find((s) => s.sessionId === sessionId) || null

test('shell-monitor extracts cwd from PowerShell prompt', () => {
  const sid = `sid-${Date.now()}-${Math.random()}`
  shellMonitor.registerSession(sid, 'claude-code', { cwd: 'C:\\Users\\Alice' })

  shellMonitor.onData(sid, '__MPS_PROMPT__\r\x1b[2KPS D:\\work> ')

  const state = getState(sid)
  assert.ok(state)
  assert.equal(state.cwd, 'D:\\work')

  shellMonitor.unregisterSession(sid)
})

test('shell-monitor strips provider qualifiers when extracting cwd', () => {
  const sid = `sid-${Date.now()}-${Math.random()}`
  shellMonitor.registerSession(sid, 'claude-code', { cwd: 'C:\\Users\\Alice' })

  shellMonitor.onData(sid, 'PS Microsoft.PowerShell.Core\\FileSystem::C:\\repo> ')

  const state = getState(sid)
  assert.ok(state)
  assert.equal(state.cwd, 'C:\\repo')

  shellMonitor.unregisterSession(sid)
})


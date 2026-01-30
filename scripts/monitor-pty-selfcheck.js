const assert = require('assert')

const monitor = require('../src/main/shell-monitor')
const ptyManager = require('../src/main/pty-manager')

function run() {
  const sid1 = `selfcheck-pty-kill-${Date.now()}`

  let killed = false
  let lastUpdate = null
  const onUpdate = (payload) => {
    lastUpdate = payload
  }

  monitor.on('update', onUpdate)
  try {
    monitor.registerSession(sid1, 'codex')
    ptyManager.sessions.set(sid1, { kill: () => { killed = true } })

    ptyManager.killSession(sid1)
    assert.ok(killed, 'kill() should be called for sessions in ptyManager.sessions')
    assert.ok(!ptyManager.sessions.has(sid1), 'ptyManager.sessions should delete the session')
    assert.ok(!monitor.sessions.has(sid1), 'shellMonitor should unregister the session')
    assert.deepStrictEqual(lastUpdate, { sessionId: sid1, state: null }, 'shellMonitor should emit state=null')

    // If the PTY session already exited (ptyManager.sessions no longer has it), closing the tab should
    // still remove the monitor card/state.
    const sid2 = `${sid1}-already-exited`
    lastUpdate = null
    monitor.registerSession(sid2, 'codex')
    assert.ok(!ptyManager.sessions.has(sid2), 'sid2 should not exist in ptyManager.sessions')
    ptyManager.killSession(sid2)
    assert.ok(!monitor.sessions.has(sid2), 'sid2 should be removed from shellMonitor')
    assert.deepStrictEqual(lastUpdate, { sessionId: sid2, state: null }, 'sid2 should emit state=null')
  } finally {
    monitor.removeListener('update', onUpdate)
    // Best-effort cleanup in case assertions fail mid-way.
    try { monitor.unregisterSession(sid1) } catch (_) {}
  }

  return true
}

if (require.main === module) {
  run()
  // eslint-disable-next-line no-console
  console.log('[monitor-pty-selfcheck] OK')
}

module.exports = { run }


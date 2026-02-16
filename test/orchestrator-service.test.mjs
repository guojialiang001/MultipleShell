import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const orchestrator = require('../src/main/orchestrator-service.js')

const TOOL_RESULT_MARKER = orchestrator.TOOL_RESULT_MARKER
const createOrchestratorService = orchestrator.createOrchestratorService

const parseResultLine = (raw) => {
  const text = String(raw || '').replace(/\r$/, '').trim()
  assert.ok(text.startsWith(TOOL_RESULT_MARKER))
  const json = text.slice(TOOL_RESULT_MARKER.length).trim()
  return JSON.parse(json)
}

test('orchestrator parses __MPS_TOOL__ and injects __MPS_TOOL_RESULT__', async () => {
  const writes = []
  const orch = createOrchestratorService({
    writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    dispatch: async ({ method, params }) => {
      assert.equal(method, 'echo')
      assert.deepEqual(params, { a: 1 })
      return { ok: true }
    }
  })

  await orch.onTerminalData('s1', '__MPS_TOOL__ {"id":"t1","method":"echo","params":{"a":1}}\n')

  assert.equal(writes.length, 1)
  assert.equal(writes[0].sessionId, 's1')
  assert.ok(String(writes[0].data).endsWith('\r'))

  const payload = parseResultLine(writes[0].data)
  assert.equal(payload.id, 't1')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.result, { ok: true })
})

test('orchestrator handles chunk boundaries', async () => {
  const writes = []
  const orch = createOrchestratorService({
    writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    dispatch: async () => ({ ok: 1 })
  })

  await orch.onTerminalData('s2', '__MPS_TOOL__ {"id":"t2","method":"echo","params":{}}')
  await orch.onTerminalData('s2', '\r\n')

  assert.equal(writes.length, 1)
  const payload = parseResultLine(writes[0].data)
  assert.equal(payload.id, 't2')
  assert.equal(payload.ok, true)
})

test('orchestrator ignores invalid json payloads', async () => {
  const writes = []
  const orch = createOrchestratorService({
    writeToSession: (_sessionId, _data) => writes.push(1),
    dispatch: async () => ({ ok: 1 })
  })

  await orch.onTerminalData('s3', '__MPS_TOOL__ not-json\n')
  assert.equal(writes.length, 0)
})

test('orchestrator generates id when missing', async () => {
  const writes = []
  const orch = createOrchestratorService({
    writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    dispatch: async () => ({ ok: 1 })
  })

  await orch.onTerminalData('s4', '__MPS_TOOL__ {"method":"echo","params":{}}\n')
  assert.equal(writes.length, 1)
  const payload = parseResultLine(writes[0].data)
  assert.ok(typeof payload.id === 'string' && payload.id.length > 0)
})

test('orchestrator supports base64 payloads', async () => {
  const writes = []
  const orch = createOrchestratorService({
    writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    dispatch: async ({ method, params }) => ({ method, params })
  })

  const raw = JSON.stringify({ id: 't5', method: 'echo', params: { b: 2 } })
  const b64 = Buffer.from(raw, 'utf8').toString('base64')
  await orch.onTerminalData('s5', `__MPS_TOOL__ base64:${b64}\n`)

  assert.equal(writes.length, 1)
  const payload = parseResultLine(writes[0].data)
  assert.equal(payload.id, 't5')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.result, { method: 'echo', params: { b: 2 } })
})


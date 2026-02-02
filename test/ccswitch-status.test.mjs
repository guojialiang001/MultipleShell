import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveCCSwitchProxyStatus } from '../src/renderer/utils/ccswitch-status.mjs'
import { pickDefaultCCSwitchTemplate } from '../src/renderer/utils/ccswitch-status.mjs'
import { computeFailoverPriorityByProviderId } from '../src/renderer/utils/ccswitch-status.mjs'

test('resolveCCSwitchProxyStatus prefers app-level enabled over proxyEnabled', () => {
  const status = resolveCCSwitchProxyStatus({
    proxyEnabled: true,
    enabled: false,
    autoFailoverEnabled: true
  })

  assert.deepEqual(status, { proxyEnabled: false, failoverEnabled: false })
})

test('resolveCCSwitchProxyStatus returns nulls for non-objects', () => {
  assert.deepEqual(resolveCCSwitchProxyStatus(null), { proxyEnabled: null, failoverEnabled: null })
  assert.deepEqual(resolveCCSwitchProxyStatus([]), { proxyEnabled: null, failoverEnabled: null })
})

test('pickDefaultCCSwitchTemplate prefers useCCSwitchProxy', () => {
  const a = { id: 'a', useCCSwitch: true, useCCSwitchProxy: false }
  const b = { id: 'b', useCCSwitch: true, useCCSwitchProxy: true }
  assert.equal(pickDefaultCCSwitchTemplate([a, b])?.id, 'b')
})

test('pickDefaultCCSwitchTemplate falls back to useCCSwitch then first', () => {
  const a = { id: 'a', useCCSwitch: false, useCCSwitchProxy: false }
  const b = { id: 'b', useCCSwitch: true, useCCSwitchProxy: false }
  assert.equal(pickDefaultCCSwitchTemplate([a, b])?.id, 'b')
  assert.equal(pickDefaultCCSwitchTemplate([a])?.id, 'a')
  assert.equal(pickDefaultCCSwitchTemplate([]), null)
})

test('computeFailoverPriorityByProviderId assigns P1/P2 as fallbacks after current', () => {
  const providers = [
    { id: 'b', inFailoverQueue: true, sortIndex: null },
    { id: 'a', inFailoverQueue: true, sortIndex: null },
    { id: 'p1', inFailoverQueue: true, sortIndex: 1 },
    { id: 'p2', inFailoverQueue: true, sortIndex: 2 },
    { id: 'x', inFailoverQueue: false, sortIndex: 0 }
  ]

  assert.deepEqual(computeFailoverPriorityByProviderId(providers), { p1: 1, p2: 2, a: 3, b: 4 })
})

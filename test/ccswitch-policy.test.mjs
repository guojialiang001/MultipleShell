import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  buildQueueFromCCSwitchProviders,
  mergeEffectiveProxyPolicy
} = require('../src/main/ccswitch-policy.js')

test('buildQueueFromCCSwitchProviders respects requested/current/failover ordering', () => {
  const providers = [
    { id: 'p1', inFailoverQueue: true, sortIndex: 20, isCurrent: false },
    { id: 'p2', inFailoverQueue: true, sortIndex: 10, isCurrent: true },
    { id: 'p3', inFailoverQueue: false, sortIndex: 1, isCurrent: false }
  ]

  const queue = buildQueueFromCCSwitchProviders(
    providers,
    'p3',
    'p2',
    'failover-queue'
  )

  assert.equal(queue.primaryProviderId, 'p3')
  assert.deepEqual(queue.orderedProviderIds, ['p3', 'p2', 'p1'])
})

test('buildQueueFromCCSwitchProviders custom mode applies allow/deny and reselects primary', () => {
  const providers = [
    { id: 'a', inFailoverQueue: true, sortIndex: 2 },
    { id: 'b', inFailoverQueue: true, sortIndex: 1 },
    { id: 'c', inFailoverQueue: false, sortIndex: 3 }
  ]

  const queue = buildQueueFromCCSwitchProviders(
    providers,
    'c',
    '',
    'custom',
    ['a', 'b'],
    ['b']
  )

  assert.equal(queue.primaryProviderId, 'a')
  assert.deepEqual(queue.orderedProviderIds, ['a'])
})

test('mergeEffectiveProxyPolicy chooses ccswitch-proxy when CC proxy is available', () => {
  const snapshot = {
    proxy: {
      codex: {
        proxyEnabled: true,
        enabled: true,
        autoFailoverEnabled: true,
        listenAddress: '127.0.0.1',
        listenPort: 15721
      }
    },
    apps: {
      codex: {
        currentId: 'p1',
        providers: [{ id: 'p1', inFailoverQueue: true, sortIndex: 1, isCurrent: true }]
      }
    }
  }

  const policy = mergeEffectiveProxyPolicy({
    template: {
      type: 'codex',
      useCCSwitch: true,
      proxyEnabled: true,
      proxyImplementation: 'ccswitch'
    },
    snapshot,
    appKey: 'codex',
    appProxyOrigin: 'http://127.0.0.1:18080'
  })

  assert.equal(policy.routeMode, 'ccswitch-proxy')
  assert.equal(policy.circuitBreakerMode, 'ccswitch')
  assert.equal(policy.ccProxy.openAIBase, 'http://127.0.0.1:15721/v1')
})

test('mergeEffectiveProxyPolicy respects CC enabled gate and falls back to direct', () => {
  const snapshot = {
    proxy: {
      codex: {
        proxyEnabled: true,
        enabled: false,
        autoFailoverEnabled: true,
        listenAddress: '127.0.0.1',
        listenPort: 15721
      }
    },
    apps: {
      codex: {
        currentId: 'p1',
        providers: [{ id: 'p1', inFailoverQueue: true, sortIndex: 1, isCurrent: true }]
      }
    }
  }

  const policy = mergeEffectiveProxyPolicy({
    template: {
      type: 'codex',
      useCCSwitch: true,
      proxyEnabled: true,
      proxyImplementation: 'app',
      respectCCSwitchProxyConfig: true
    },
    snapshot,
    appKey: 'codex',
    appProxyOrigin: 'http://127.0.0.1:18080'
  })

  assert.equal(policy.routeMode, 'direct')
})

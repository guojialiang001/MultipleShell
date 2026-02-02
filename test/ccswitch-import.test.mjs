import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ccSwitch = require('../src/main/ccswitch.js')

test('ccswitch.importProviders overwrite-import deletes previous imported templates', async () => {
  const calls = { deleted: [], saved: [] }

  const store = [
    // New marker-based imports
    { id: 'imported-1', importSource: 'ccswitch', name: 'old1' },
    // Back-compat: stable prefix + provider id
    { id: 'ccswitch-codex-b', ccSwitchProviderId: 'b', name: 'old2' },
    // Should not be treated as imported (prefix alone is not enough)
    { id: 'ccswitch-user-made', ccSwitchProviderId: '', name: 'keep-prefix' },
    { id: 'user-x', name: 'keep' }
  ]

  const configManager = {
    loadConfigs: () => store.slice(),
    deleteConfig: (id) => calls.deleted.push(id),
    saveConfig: (cfg) => calls.saved.push(cfg)
  }

  const snapshot = {
    apps: {
      claude: { providers: [{ id: 'newA', name: 'A', settingsConfig: {} }] },
      codex: { providers: [{ id: 'newB', name: 'B', settingsConfig: { config: '', auth: {} } }] },
      opencode: { providers: [] }
    }
  }

  await ccSwitch.importProviders(configManager, { snapshot })

  assert.deepEqual(calls.deleted.sort(), ['imported-1', 'ccswitch-codex-b'].sort())
  assert.equal(calls.saved.length, 2)
  assert.ok(calls.saved.every((c) => String(c.id).startsWith('ccswitch-')))
})

test('ccswitch.importProviders defaults imported templates to proxy when proxy+failover enabled', async () => {
  const calls = { deleted: [], saved: [] }

  const configManager = {
    loadConfigs: () => [],
    deleteConfig: (id) => calls.deleted.push(id),
    saveConfig: (cfg) => calls.saved.push(cfg)
  }

  const snapshot = {
    proxy: {
      claude: { proxyEnabled: true, enabled: true, autoFailoverEnabled: true },
      codex: { proxyEnabled: true, enabled: true, autoFailoverEnabled: true }
    },
    apps: {
      claude: { providers: [{ id: 'c1', name: 'C1', settingsConfig: {} }] },
      codex: { providers: [{ id: 'x1', name: 'X1', settingsConfig: { config: '', auth: {} } }] },
      opencode: { providers: [{ id: 'o1', name: 'O1', settingsConfig: {} }] }
    }
  }

  await ccSwitch.importProviders(configManager, { snapshot })

  const byType = new Map(calls.saved.map((c) => [c.type, c]))
  assert.equal(byType.get('claude-code')?.useCCSwitchProxy, true)
  assert.equal(byType.get('codex')?.useCCSwitchProxy, true)
  assert.equal(byType.get('opencode')?.useCCSwitchProxy, true) // OpenCode uses Codex proxy settings
})

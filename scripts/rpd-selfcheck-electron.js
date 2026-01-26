const { app, safeStorage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.MPS_SUPPRESS_DIALOGS = '1'

function ok(message) {
  console.log(`[OK] ${message}`)
}

function fail(message) {
  console.error(`[FAIL] ${message}`)
  process.exitCode = 1
}

function assert(condition, message) {
  if (!condition) fail(message)
}

async function main() {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-rpd-selfcheck-'))
  app.setPath('userData', tmpUserData)

  await app.whenReady()

  const configManager = require('../src/main/config-manager')

  const initial = configManager.reloadConfigs()
  assert(Array.isArray(initial) && initial.length > 0, 'expected non-empty configs on first load')
  ok(`first load returned ${initial.length} configs`)

  const storePath = configManager.getStorePath()

  if (!safeStorage.isEncryptionAvailable()) {
    ok('safeStorage encryption unavailable; skipped encrypted-store checks')
  } else {
    assert(fs.existsSync(storePath), `expected encrypted store file to exist: ${storePath}`)

    const payload = fs.readFileSync(storePath, 'utf8').trim()
    assert(payload.length > 0, 'expected encrypted store file to be non-empty')

    let parsedPlaintext = null
    try {
      parsedPlaintext = JSON.parse(payload)
    } catch (_) {
      // expected
    }
    assert(!parsedPlaintext, 'store file looks like plaintext JSON (should be encrypted base64)')
    ok('store file is not plaintext JSON')

    const decrypted = safeStorage.decryptString(Buffer.from(payload, 'base64'))
    const parsed = JSON.parse(decrypted)
    assert(parsed && Array.isArray(parsed.configs), 'decrypted store JSON schema mismatch')
    ok('store file decrypts and parses')

    fs.writeFileSync(storePath, 'abc', 'utf8')
    configManager.reloadConfigs()

    const backups = fs
      .readdirSync(tmpUserData)
      .filter(n => n.startsWith('configs.v1.enc.corrupt.') && n.endsWith('.bak'))
    assert(backups.length > 0, 'expected a .corrupt.<ts>.bak backup after corruption')
    ok('corruption recovery creates backup file')
  }

  const uniqueName = `Dup-${Date.now()}`
  const before = configManager.loadConfigs()
  const beforeIds = new Set(before.map(c => c.id))

  const afterAdd1 = configManager.saveConfig({
    id: null,
    name: uniqueName,
    workingDirectory: '',
    envVars: {}
  })
  const added1 = afterAdd1.find(c => !beforeIds.has(c.id))
  assert(added1, 'expected first added config to appear')

  const afterAdd1Ids = new Set(afterAdd1.map(c => c.id))
  const afterAdd2 = configManager.saveConfig({
    id: null,
    name: uniqueName,
    workingDirectory: '',
    envVars: {}
  })
  const added2 = afterAdd2.find(c => !afterAdd1Ids.has(c.id))
  assert(added2, 'expected second added config to appear')
  assert(added1.id !== added2.id, 'expected duplicate-name configs to have different ids')
  ok('duplicate-name configs have distinct ids')

  const afterDelete = configManager.deleteConfig(added1.id)
  assert(!afterDelete.some(c => c.id === added1.id), 'expected delete by id to remove only the target config')
  assert(afterDelete.some(c => c.id === added2.id), 'expected other config with same name to remain after delete')
  ok('delete by id does not collide on name')

  const updatedName = `${uniqueName}-Updated`
  const afterUpdate = configManager.saveConfig({ ...added2, name: updatedName })
  assert(afterUpdate.some(c => c.id === added2.id && c.name === updatedName), 'expected upsert by id to update the config')
  ok('upsert updates by id')

  if (process.exitCode) {
    console.error('Self-check failed.')
  } else {
    console.log('Self-check passed.')
  }

  app.exit(process.exitCode || 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})

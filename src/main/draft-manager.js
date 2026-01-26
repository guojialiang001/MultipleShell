const fs = require('fs')
const path = require('path')
const { app, safeStorage } = require('electron')

class DraftManager {
  constructor() {
    this._storeCache = null
  }

  getEncryptedStorePath() {
    return path.join(app.getPath('userData'), 'drafts.v1.enc')
  }

  getPlainStorePath() {
    return path.join(app.getPath('userData'), 'drafts.v1.json')
  }

  isEncryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (_) {
      return false
    }
  }

  loadStore() {
    if (this._storeCache) return this._storeCache

    const now = new Date().toISOString()
    const seeded = { version: 1, updatedAt: now, drafts: {} }

    const encPath = this.getEncryptedStorePath()
    const plainPath = this.getPlainStorePath()

    const encryptionOk = this.isEncryptionAvailable()

    const loadPlain = () => {
      if (!fs.existsSync(plainPath)) return seeded
      const raw = fs.readFileSync(plainPath, 'utf8')
      const parsed = JSON.parse(raw)
      return this.normalizeStore(parsed)
    }

    const loadEncrypted = () => {
      if (!fs.existsSync(encPath)) return seeded
      const payloadB64 = fs.readFileSync(encPath, 'utf8')
      const encrypted = Buffer.from(payloadB64, 'base64')
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted)
      return this.normalizeStore(parsed)
    }

    try {
      const store = encryptionOk ? loadEncrypted() : loadPlain()
      this._storeCache = store
      return store
    } catch (err) {
      // Corrupt store; back it up and recreate.
      try {
        const badPath = encryptionOk ? encPath : plainPath
        if (fs.existsSync(badPath)) {
          const backup = `${badPath}.corrupt.${Date.now()}.bak`
          fs.renameSync(badPath, backup)
        }
      } catch (_) {
        // ignore
      }
      this._storeCache = seeded
      return seeded
    }
  }

  normalizeStore(store) {
    const now = new Date().toISOString()
    const drafts =
      (store?.drafts && typeof store.drafts === 'object' && !Array.isArray(store.drafts))
        ? store.drafts
        : {}

    return {
      version: 1,
      updatedAt: typeof store?.updatedAt === 'string' ? store.updatedAt : now,
      drafts
    }
  }

  writeStore(store) {
    const normalized = this.normalizeStore(store)
    this._storeCache = normalized

    const encryptionOk = this.isEncryptionAvailable()
    const encPath = this.getEncryptedStorePath()
    const plainPath = this.getPlainStorePath()

    const json = JSON.stringify(normalized)

    if (encryptionOk) {
      const encrypted = safeStorage.encryptString(json)
      const payloadB64 = encrypted.toString('base64')
      fs.mkdirSync(path.dirname(encPath), { recursive: true })
      const tmp = `${encPath}.tmp`
      fs.writeFileSync(tmp, payloadB64, 'utf8')
      fs.renameSync(tmp, encPath)
      return
    }

    fs.mkdirSync(path.dirname(plainPath), { recursive: true })
    const tmp = `${plainPath}.tmp`
    fs.writeFileSync(tmp, json, 'utf8')
    fs.renameSync(tmp, plainPath)
  }

  loadDraft(key) {
    if (!key || typeof key !== 'string') return null
    const store = this.loadStore()
    return store.drafts[key] ?? null
  }

  saveDraft(key, value) {
    if (!key || typeof key !== 'string') return false
    const store = this.loadStore()
    store.drafts[key] = value
    store.updatedAt = new Date().toISOString()
    this.writeStore(store)
    return true
  }

  deleteDraft(key) {
    if (!key || typeof key !== 'string') return false
    const store = this.loadStore()
    delete store.drafts[key]
    store.updatedAt = new Date().toISOString()
    this.writeStore(store)
    return true
  }
}

module.exports = new DraftManager()


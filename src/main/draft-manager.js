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


  isEncryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (_) {
      return false
    }
  }

  loadStore() {
    if (this._storeCache) return this._storeCache

    if (!this.isEncryptionAvailable()) {
      throw new Error('加密存储不可用，无法加载草稿')
    }

    const now = new Date().toISOString()
    const seeded = { version: 1, updatedAt: now, drafts: {} }
    const encPath = this.getEncryptedStorePath()

    const loadEncrypted = () => {
      if (!fs.existsSync(encPath)) return seeded
      const payloadB64 = fs.readFileSync(encPath, 'utf8')
      const encrypted = Buffer.from(payloadB64, 'base64')
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted)
      return this.normalizeStore(parsed)
    }

    try {
      const store = loadEncrypted()
      this._storeCache = store
      return store
    } catch (err) {
      try {
        if (fs.existsSync(encPath)) {
          const backup = `${encPath}.corrupt.${Date.now()}.bak`
          fs.renameSync(encPath, backup)
        }
      } catch (_) {}
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

    if (!this.isEncryptionAvailable()) {
      throw new Error('加密存储不可用，无法保存草稿')
    }

    const json = JSON.stringify(normalized)
    const encrypted = safeStorage.encryptString(json)
    const payloadB64 = encrypted.toString('base64')
    const encPath = this.getEncryptedStorePath()
    fs.mkdirSync(path.dirname(encPath), { recursive: true })
    const tmp = `${encPath}.tmp`
    fs.writeFileSync(tmp, payloadB64, 'utf8')
    fs.renameSync(tmp, encPath)
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


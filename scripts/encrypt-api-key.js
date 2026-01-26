const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ALGORITHM = 'aes-256-gcm'
const KEY = crypto.scryptSync(process.env.ENCRYPTION_PASSWORD || 'default-app-secret-key', 'salt', 32)

function encryptApiKey(apiKey) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)

  let encrypted = cipher.update(apiKey, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  }
}

const apiKey = process.argv[2]
if (!apiKey) {
  console.error('Usage: node encrypt-api-key.js <api-key>')
  process.exit(1)
}

const result = encryptApiKey(apiKey)
const outputPath = path.join(__dirname, '../resources/voice-api.enc')

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(result))

console.log('API key encrypted successfully to:', outputPath)

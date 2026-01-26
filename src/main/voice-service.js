const { ipcMain } = require('electron')
const builtInConfig = require('./built-in-config-manager')
const https = require('https')

class VoiceService {
  constructor() {
    this.setupIpcHandlers()
  }

  setupIpcHandlers() {
    ipcMain.handle('voice:getApiKey', () => {
      return builtInConfig.getVoiceApiKey()
    })

    ipcMain.handle('voice:setApiKey', (_, key) => {
      if (typeof key !== 'string') {
        throw new Error('Invalid API key')
      }
      builtInConfig.setVoiceApiKey(key)
      return { success: true }
    })

    ipcMain.handle('voice:transcribe', async (_, { audioData, format = 'webm' }) => {
      if (!audioData) {
        throw new Error('Invalid audioData')
      }
      if (format && !/^[a-z0-9]+$/.test(format)) {
        throw new Error('Invalid format')
      }

      const apiKey = builtInConfig.getVoiceApiKey()
      if (!apiKey) {
        throw new Error('API密钥未配置')
      }

      const buffer = Buffer.isBuffer(audioData)
        ? audioData
        : Array.isArray(audioData)
        ? Buffer.from(audioData)
        : Buffer.from(audioData)
      const boundary = '----' + Math.random().toString(36).substring(2)

      const parts = [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nFunAudioLLM/SenseVoiceSmall\r\n--${boundary}--\r\n`)
      ]
      const body = Buffer.concat(parts)

      return new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.siliconflow.cn',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
          }
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data)
              res.statusCode === 200 ? resolve(parsed) : reject(new Error(parsed.message || data))
            } catch {
              reject(new Error(data))
            }
          })
        })
        req.on('error', reject)
        req.write(body)
        req.end()
      })
    })
  }
}

module.exports = new VoiceService()

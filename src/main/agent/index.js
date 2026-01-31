const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const DEFAULT_CONNECT_TIMEOUT_MS = 1500
const DEFAULT_TOKEN_WAIT_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const stableHash = (value) => crypto.createHash('sha1').update(String(value || '')).digest('hex')

const getTokenPath = () => {
  // NOTE: Use appData (Roaming) instead of userData so Host/Client can share the same token
  // even if Client later moves to an isolated userData directory.
  let appData = ''
  try {
    appData = app.getPath('appData')
  } catch (_) {
    appData = ''
  }
  if (!appData) appData = String(process.env.APPDATA || '').trim()
  if (!appData) appData = os.homedir()

  const root = path.join(appData, 'MultipleShell')
  return path.join(root, 'agent-token')
}

const ensureDir = (dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
  } catch (_) {}
}

const readFileSafe = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (_) {
    return ''
  }
}

const writeFileSafe = (filePath, content) => {
  try {
    ensureDir(path.dirname(filePath))
    fs.writeFileSync(filePath, content, 'utf8')
    return true
  } catch (_) {
    return false
  }
}

const waitForToken = async (tokenPath, timeoutMs) => {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0)
  while (Date.now() < deadline) {
    const raw = readFileSafe(tokenPath).trim()
    if (raw) return raw
    await sleep(60)
  }
  return readFileSafe(tokenPath).trim()
}

const resolvePipeName = () => {
  const override = String(process.env.MPS_AGENT_PIPE || '').trim()
  if (override) return override

  // Keep the pipe name stable and user-specific (per Windows user) but deterministic.
  // IMPORTANT: do NOT depend on `app.getPath('userData')` because Client instances may
  // move userData to an isolated directory (Phase 4) and still need to reach the Host.
  const username = String(process.env.USERNAME || os.userInfo().username || '').trim()
  const domain = String(process.env.USERDOMAIN || '').trim()
  const userProfile = String(process.env.USERPROFILE || '').trim()
  const appData = String(process.env.APPDATA || '').trim()
  const hint = `${appData}|${userProfile}|${domain}\\${username}|MultipleShell`
  const suffix = stableHash(hint).slice(0, 12)
  return `\\\\.\\pipe\\mps-agent-${suffix}`
}

const sendJsonLine = (socket, payload) => {
  try {
    socket.write(`${JSON.stringify(payload)}\n`)
  } catch (_) {}
}

class LineJsonSocket {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.onMessage = null

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this._onData(chunk))
  }

  _onData(chunk) {
    this.buffer += String(chunk || '')
    while (true) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) break
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const trimmed = line.trim()
      if (!trimmed) continue

      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch (_) {
        continue
      }
      if (this.onMessage) this.onMessage(msg)
    }
  }

  send(payload) {
    sendJsonLine(this.socket, payload)
  }

  destroy() {
    try {
      this.socket.destroy()
    } catch (_) {}
  }
}

class AgentHost {
  constructor({ pipeName, tokenPath }) {
    this.role = 'host'
    this.pipeName = pipeName
    this.tokenPath = tokenPath
    this.token = ''
    this.server = null
    this.clients = new Set()
    this.requestHandler = null
  }

  async start() {
    this.token = crypto.randomBytes(32).toString('hex')
    writeFileSafe(this.tokenPath, this.token)

    const server = net.createServer((socket) => this._onConnection(socket))
    this.server = server

    await new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(this.pipeName, () => resolve())
    })
  }

  _onConnection(socket) {
    const conn = new LineJsonSocket(socket)
    let authed = false
    let handshakeTimer = null

    const cleanup = () => {
      if (handshakeTimer) clearTimeout(handshakeTimer)
      handshakeTimer = null
      this.clients.delete(conn)
      conn.destroy()
    }

    handshakeTimer = setTimeout(() => {
      if (!authed) cleanup()
    }, 5000)

    conn.onMessage = async (msg) => {
      if (!authed) {
        if (msg && msg.type === 'hello' && typeof msg.token === 'string' && msg.token === this.token) {
          authed = true
          this.clients.add(conn)
          conn.send({ type: 'hello', ok: true })
        } else {
          cleanup()
        }
        return
      }

      if (!msg || typeof msg !== 'object') return
      const id = msg.id
      const method = typeof msg.method === 'string' ? msg.method : ''
      const params = msg.params

      // Notification (no id)
      if (!id) {
        // Currently we don't accept client->host notifications.
        return
      }

      if (!method) {
        conn.send({ id, error: { message: 'Invalid method', code: 'INVALID_METHOD' } })
        return
      }

      try {
        if (!this.requestHandler) throw new Error('No request handler')
        const result = await this.requestHandler(method, params)
        conn.send({ id, result })
      } catch (err) {
        conn.send({
          id,
          error: {
            message: err?.message || String(err),
            code: err?.code || 'ERROR'
          }
        })
      }
    }

    socket.on('close', () => cleanup())
    socket.on('error', () => cleanup())
  }

  setRequestHandler(handler) {
    this.requestHandler = handler
  }

  broadcast(method, params) {
    if (!method) return
    const payload = { method, params }
    for (const conn of Array.from(this.clients)) {
      try {
        conn.send(payload)
      } catch (_) {}
    }
  }

  close() {
    for (const conn of Array.from(this.clients)) {
      try {
        conn.destroy()
      } catch (_) {}
    }
    this.clients.clear()
    try {
      this.server?.close?.()
    } catch (_) {}
    this.server = null
  }
}

class AgentClient {
  constructor({ pipeName, tokenPath }) {
    this.role = 'client'
    this.pipeName = pipeName
    this.tokenPath = tokenPath
    this.socket = null
    this.conn = null
    this.pending = new Map()
    this.nextId = 1
    this.notificationHandler = null
  }

  async connect() {
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection(this.pipeName)
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          s.destroy()
        } catch (_) {}
        reject(new Error('Agent connect timeout'))
      }, DEFAULT_CONNECT_TIMEOUT_MS)

      s.once('connect', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err)
      })
    })

    this.socket = socket
    const conn = new LineJsonSocket(socket)
    this.conn = conn

    const token = await waitForToken(this.tokenPath, DEFAULT_TOKEN_WAIT_MS)
    if (!token) {
      throw new Error(`Agent token not found: ${this.tokenPath}`)
    }

    const helloAck = await new Promise((resolve, reject) => {
      let timer = null
      timer = setTimeout(() => reject(new Error('Agent hello timeout')), 1500)

      conn.onMessage = (msg) => {
        if (msg && msg.type === 'hello' && msg.ok) {
          if (timer) clearTimeout(timer)
          timer = null
          resolve(true)
          return
        }
        this._handleMessage(msg)
      }

      conn.send({ type: 'hello', token })
    })

    if (!helloAck) throw new Error('Agent hello failed')

    socket.on('close', () => this._cleanup(new Error('Agent disconnected')))
    socket.on('error', (err) => this._cleanup(err))
  }

  _cleanup(err) {
    for (const [, entry] of Array.from(this.pending.entries())) {
      try {
        entry.reject(err)
      } catch (_) {}
    }
    this.pending.clear()
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.id != null) {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) {
        const err = new Error(msg.error?.message || 'Agent error')
        err.code = msg.error?.code
        entry.reject(err)
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    const method = typeof msg.method === 'string' ? msg.method : ''
    if (!method) return
    if (this.notificationHandler) this.notificationHandler(method, msg.params)
  }

  onNotification(handler) {
    this.notificationHandler = handler
  }

  call(method, params) {
    if (!this.conn) return Promise.reject(new Error('Agent not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.conn.send({ id, method, params })
    })
  }

  close() {
    try {
      this.socket?.destroy?.()
    } catch (_) {}
    this.socket = null
    this.conn = null
    this._cleanup(new Error('Agent closed'))
  }
}

const tryConnectClient = async ({ pipeName, tokenPath }) => {
  const client = new AgentClient({ pipeName, tokenPath })
  await client.connect()
  return client
}

const tryStartHost = async ({ pipeName, tokenPath }) => {
  const host = new AgentHost({ pipeName, tokenPath })
  await host.start()
  return host
}

const initAgent = async () => {
  const pipeName = resolvePipeName()
  const tokenPath = getTokenPath()

  try {
    return await tryConnectClient({ pipeName, tokenPath })
  } catch (_) {
    // ignore and try host election below
  }

  try {
    return await tryStartHost({ pipeName, tokenPath })
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      return await tryConnectClient({ pipeName, tokenPath })
    }
    throw err
  }
}

module.exports = {
  initAgent
}

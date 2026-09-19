import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

type Role = 'host' | 'viewer'
export type RegisteredDevice = { hostId: string; id: string; hash: string }
export type Pair = { id: string; hostHash: string; viewerHash: string; maxDevices?: number }
export const digest = (token: string) => createHash('sha256').update(token).digest('hex')

export function createRelay(pairs: Pair[], options: {
  maxSessions?: number; maxPayload?: number; maxBuffered?: number;
  heartbeatMs?: number; waitMs?: number;
  devices?: RegisteredDevice[]; saveDevices?: (devices: RegisteredDevice[]) => void;
} = {}) {
  const credentials = new Map<string, { pair: string; role: Role; deviceId?: string }>()
  const ids = new Set<string>()
  for (const pair of pairs) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pair.id) || ids.has(pair.id)) throw Error('Invalid or duplicate pair ID')
    ids.add(pair.id)
    for (const role of ['host', 'viewer'] as const) {
      const hash = pair[`${role}Hash`]
      if (!/^[a-f0-9]{64}$/.test(hash) || credentials.has(hash)) throw Error('Invalid or duplicate credential hash')
      credentials.set(hash, { pair: pair.id, role })
    }
  }
  let devices = (options.devices ?? []).filter(device => ids.has(device.hostId))
  const limits = new Map(pairs.map(pair => [pair.id, pair.maxDevices ?? 5]))
  for (const limit of limits.values()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('Invalid device allowance')
  }
  for (const device of devices) {
    if (!ids.has(device.hostId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(device.id)
        || !/^[a-f0-9]{64}$/.test(device.hash) || credentials.has(device.hash)
        || devices.filter(d => d.hostId === device.hostId && d.id === device.id).length !== 1) throw Error('Invalid device registry')
    credentials.set(device.hash, { pair: device.hostId, role: 'viewer', deviceId: device.id })
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const reply = (status: number, body: unknown = {}) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200).end('ok'); return }
    const route = req.url?.match(/^\/v1\/devices(?:\/([a-zA-Z0-9_-]{1,64}))?$/)
    if (!route) { reply(404); return }
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
    const identity = token && credentials.get(digest(token))
    if (!identity || identity.role !== 'host' || req.headers.origin) { reply(401); return }
    const hostId = identity.pair
    if (req.method === 'GET' && !route[1]) {
      reply(200, { maxDevices: limits.get(hostId), devices: devices.filter(d => d.hostId === hostId).map(d => ({ id: d.id })) }); return
    }
    try {
      if (req.method === 'POST' && !route[1]) {
        let data = ''
        for await (const chunk of req) {
          data += chunk.toString()
          if (Buffer.byteLength(data) > 4096) { reply(413); return }
        }
        let value: { id?: string; hash?: string }
        try { value = JSON.parse(data) } catch { reply(400); return }
        if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)
            || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) { reply(400); return }
        const existing = devices.find(d => d.hostId === hostId && d.id === value.id)
        if (existing) { reply(existing.hash === value.hash ? 200 : 409); return }
        if (credentials.has(value.hash)) { reply(409); return }
        if (devices.filter(d => d.hostId === hostId).length >= limits.get(hostId)!) {
          reply(409, { error: 'Device allowance reached. Revoke a device before pairing another.' }); return
        }
        const next = [...devices, { hostId, id: value.id, hash: value.hash }]
        options.saveDevices?.(next)
        devices = next
        credentials.set(value.hash, { pair: hostId, role: 'viewer', deviceId: value.id })
        reply(201); return
      }
      if (req.method === 'DELETE' && route[1]) {
        const device = devices.find(d => d.hostId === hostId && d.id === route[1])
        if (device) {
          const next = devices.filter(d => d !== device)
          options.saveDevices?.(next)
          devices = next
          credentials.delete(device.hash)
          for (const [key, session] of sessions) {
            if (key.startsWith(`${hostId}:`) && session.deviceId === device.id) dispose(key, session)
          }
        }
        reply(200); return
      }
      reply(405)
    } catch { if (!res.headersSent) reply(500) }
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 1024 * 1024, perMessageDeflate: false })
  type Session = { host?: WebSocket; viewer?: WebSocket; timer: NodeJS.Timeout; deviceId?: string }
  const sessions = new Map<string, Session>()
  const alive = new Set<WebSocket>()
  const hosts = new Map<string, WebSocket>()
  let closing = false
  const dispose = (key: string, session: Session) => {
    if (sessions.get(key) !== session) return
    sessions.delete(key)
    clearTimeout(session.timer)
    for (const ws of [session.host, session.viewer]) {
      if (ws) { alive.delete(ws); ws.terminate() }
    }
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.delete(ws)) ws.terminate()
      else ws.ping()
    }
  }, options.heartbeatMs ?? 30_000)
  heartbeat.unref()
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    // Native clients use headers. Never accept credentials in URLs or browser origins.
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
    const identity = token && credentials.get(digest(token))
    if (!identity || req.headers.origin) { reject('401 Unauthorized'); return }
    if (closing) { reject('503 Service Unavailable'); return }
    if (req.url === '/v1/host') {
      if (identity.role !== 'host') { reject('403 Forbidden'); return }
      if (hosts.has(identity.pair)) { reject('409 Conflict'); return }
      wss.handleUpgrade(req, socket, head, ws => {
        hosts.set(identity.pair, ws)
        alive.add(ws)
        ws.on('pong', () => alive.add(ws))
        const cleanup = () => {
          alive.delete(ws)
          if (hosts.get(identity.pair) !== ws) return
          hosts.delete(identity.pair)
          for (const [key, session] of sessions) {
            if (key.startsWith(`${identity.pair}:`)) dispose(key, session)
          }
        }
        ws.on('close', cleanup)
        ws.on('error', cleanup)
        ws.on('message', () => ws.terminate())
        ws.send('{"type":"registered"}')
        for (const [key, session] of sessions) {
          if (key.startsWith(`${identity.pair}:`) && session.viewer && !session.host) {
            ws.send(JSON.stringify({ type: 'session', id: key.split(':')[1] }))
          }
        }
      })
      return
    }
    const match = req.url?.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]{1,64})$/)
    if (!match) { reject('404 Not Found'); return }
    const key = `${identity.pair}:${match[1]}`
    const current = sessions.get(key)
    if (closing) { reject('503 Service Unavailable'); return }
    if (current?.[identity.role]) { reject('409 Conflict'); return }
    const pairSessions = [...sessions.keys()].filter(k => k.startsWith(`${identity.pair}:`)).length
    if (!current && (sessions.size >= (options.maxSessions ?? 100) || pairSessions >= (limits.get(identity.pair)! + 2) * 2)) {
      reject('429 Too Many Requests'); return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let session = current
      if (!session) {
        session = { timer: setTimeout(() => dispose(key, session!), options.waitMs ?? 10_000) }
        session.timer.unref()
        sessions.set(key, session)
      }
      const connected = session
      connected[identity.role] = ws
      if (identity.role === 'viewer') connected.deviceId = identity.deviceId
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      ws.on('error', () => dispose(key, connected))
      ws.on('close', () => dispose(key, connected))
      ws.on('message', (data, isBinary) => {
        const other = identity.role === 'host' ? connected.viewer : connected.host
        const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength
        // Preserve message boundaries and order. Close stalled sessions rather than drop VNC bytes.
        if (!other || other.readyState !== WebSocket.OPEN || other.bufferedAmount + bytes > (options.maxBuffered ?? 2 * 1024 * 1024)) {
          dispose(key, connected); return
        }
        other.send(data, { binary: isBinary }, error => { if (error) dispose(key, connected) })
      })
      if (identity.role === 'viewer' && !connected.host) {
        const host = hosts.get(identity.pair)
        if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ type: 'session', id: match[1] }))
      }
      // Control message occurs only before the data phase; both clients must await it.
      if (connected.host && connected.viewer) {
        clearTimeout(connected.timer)
        connected.host.send('{"type":"ready"}')
        connected.viewer.send('{"type":"ready"}')
      }
    })
  })
  return {
    server,
    revokePair(id: string) {
      const next = devices.filter(device => device.hostId !== id)
      options.saveDevices?.(next)
      devices = next
      for (const [hash, identity] of credentials) if (identity.pair === id) credentials.delete(hash)
      hosts.get(id)?.terminate()
      hosts.delete(id)
      for (const [key, session] of sessions) if (key.startsWith(`${id}:`)) dispose(key, session)
    },
    get sessionCount() { return sessions.size },
    async close() {
      closing = true
      clearInterval(heartbeat)
      for (const host of hosts.values()) host.terminate()
      hosts.clear()
      for (const [key, session] of sessions) dispose(key, session)
      await new Promise<void>(resolve => wss.close(() => resolve()))
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

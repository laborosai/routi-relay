import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

import type { AppleBilling, Subscription } from './subscriptions.js'

// Stable, opaque purchase identifier; it is not an authentication credential.
export const purchaseToken = (macId: string) => {
  const hex = digest(`routi-subscription:${macId}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

type Role = 'host' | 'viewer'
export type RegisteredDevice = { hostId: string; id: string; hash: string }
export type Pair = { id: string; hostHash: string; viewerHash: string; maxDevices?: number }
export type Trial = Pair & { expiresAt: number | null }
const trialDuration = 3 * 24 * 60 * 60 * 1000
export const digest = (token: string) => createHash('sha256').update(token).digest('hex')

export function createRelay(pairs: Pair[], options: {
  maxSessions?: number; maxPayload?: number; maxBuffered?: number;
  heartbeatMs?: number; waitMs?: number;
  billing?: AppleBilling; subscriptions?: Subscription[]; saveSubscriptions?: (subscriptions: Subscription[]) => void;
  trials?: Trial[]; saveTrials?: (trials: Trial[]) => void; maxTrials?: number;
  trustProxy?: boolean;
  devices?: RegisteredDevice[]; saveDevices?: (devices: RegisteredDevice[]) => void;
} = {}) {
  let subscriptions = options.subscriptions ?? []
  if (options.billing && !options.saveSubscriptions) throw Error('Subscription storage required')
  const refreshing = new Map<string, Promise<void>>()
  const refreshSubscription = (record: Subscription) => {
    const existing = refreshing.get(record.originalTransactionId)
    if (existing) return existing
    const work = (async () => {
      const expiresAt = await options.billing!.expiration(record.originalTransactionId, purchaseToken(record.macId))
      const next = [...subscriptions.filter(s => s.originalTransactionId !== record.originalTransactionId), { ...record, expiresAt }]
      options.saveSubscriptions!(next)
      subscriptions = next
    })().finally(() => refreshing.delete(record.originalTransactionId))
    refreshing.set(record.originalTransactionId, work)
    return work
  }
  let trials = options.trials ?? []
  if (trials.some(trial => trial.expiresAt !== null && (!Number.isSafeInteger(trial.expiresAt) || trial.expiresAt <= 0))) throw Error('Invalid trial deadline')
  pairs = [...pairs, ...trials]
  const access = (id: string) => {
    const trial = trials.find(trial => trial.id === id)
    const paidUntil = Math.max(0, ...subscriptions.filter(s => s.macId === id).map(s => s.expiresAt))
    const paid = paidUntil > Date.now()
    const expiresAt = paid ? Math.max(paidUntil, trial?.expiresAt ?? 0) : trial?.expiresAt ?? null
    return { trial: !!trial && !paid, expiresAt, expired: !paid && trial?.expiresAt != null && trial.expiresAt <= Date.now(),
      ...(options.billing ? { billing: { productId: options.billing.productId, appAccountToken: purchaseToken(id), subscribed: paid } } : {}) }
  }
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
  const limits = new Map(pairs.map(pair => [pair.id, pair.maxDevices ?? null]))
  for (const limit of limits.values()) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw Error('Invalid device allowance')
  }
  for (const device of devices) {
    if (!ids.has(device.hostId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(device.id)
        || !/^[a-f0-9]{64}$/.test(device.hash) || credentials.has(device.hash)
        || devices.filter(d => d.hostId === device.hostId && d.id === device.id).length !== 1) throw Error('Invalid device registry')
    credentials.set(device.hash, { pair: device.hostId, role: 'viewer', deviceId: device.id })
  }
  let billingRequests = 0
  const enrollments = new Map<string, { count: number; resetAt: number }>()
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const reply = (status: number, body: unknown = {}) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200).end('ok'); return }
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
    const identity = token ? credentials.get(digest(token)) : undefined
    if (req.url === '/v1/access' && req.method === 'GET') {
      if (!identity || req.headers.origin) { reply(401); return }
      reply(200, access(identity.pair)); return
    }
    if (req.method === 'POST' && ['/v1/subscription', '/v1/apple-notifications'].includes(req.url ?? '')) {
      if (!options.billing) { reply(503); return }
      if (req.headers.origin) { reply(401); return }
      const claim = req.url === '/v1/subscription'
      if (claim && (!identity || identity.role !== 'viewer' || !identity.deviceId)) { reply(401); return }
      if (billingRequests >= 8) { reply(429); return }
      billingRequests++
      let data = ''
      try {
        for await (const chunk of req) {
          data += chunk.toString()
          if (Buffer.byteLength(data) > 32768) { reply(413); return }
        }
        let payload: { signedPayload?: string }
        try { payload = JSON.parse(data) } catch { reply(400); return }
        if (!payload || typeof payload.signedPayload !== 'string') { reply(400); return }
        let originalTransactionId: string | undefined
        try {
          if (claim) {
            const purchase = await options.billing.transaction(payload.signedPayload)
            if (purchase.appAccountToken !== purchaseToken(identity!.pair)) {
              reply(409, { error: 'This subscription covers another Mac. Restore it on that Mac.' }); return
            }
            originalTransactionId = purchase.originalTransactionId
          } else originalTransactionId = await options.billing.notification(payload.signedPayload)
        } catch { reply(400, { error: 'Apple purchase could not be verified.' }); return }
        if (!originalTransactionId) { reply(200); return }
        const existing = subscriptions.find(s => s.originalTransactionId === originalTransactionId)
        if (claim && existing && existing.macId !== identity!.pair) { reply(409); return }
        const record = existing ?? (claim ? { originalTransactionId, macId: identity!.pair, expiresAt: 0 } : undefined)
        if (record) await refreshSubscription(record)
        reply(200, claim ? access(identity!.pair) : {}); return
      } catch { if (!res.headersSent) reply(503, { error: 'Could not confirm Connect access. Please try again.' }); return }
      finally { billingRequests-- }
    }
    if (req.url === '/v1/trial' && req.method === 'POST') {
      if (!token || req.headers.origin) { reply(401); return }
      if (!options.saveTrials) { reply(503); return }
      let data = ''
      try {
        for await (const chunk of req) {
          data += chunk.toString()
          if (Buffer.byteLength(data) > 1024) { reply(413); return }
        }
        let value: { viewerTokenHash?: string }
        try { value = JSON.parse(data) } catch { reply(400); return }
        if (!value || typeof value.viewerTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.viewerTokenHash)) { reply(400); return }
        // Re-check after reading: concurrent retries must not create a second trial.
        const hash = digest(token)
        const existing = credentials.get(hash)
        if (existing) {
          const trial = trials.find(trial => trial.id === existing.pair)
          if (existing.role !== 'host' || !trial || trial.viewerHash !== value.viewerTokenHash) { reply(409); return }
          reply(200, access(trial.id)); return
        }
        if (value.viewerTokenHash === hash || credentials.has(value.viewerTokenHash)) { reply(409); return }
        if (trials.length >= (options.maxTrials ?? 100)) { reply(503); return }
        // Only trust the header when a private reverse proxy overwrites it.
        const address = options.trustProxy ? req.headers['x-routi-client-ip'] : req.socket.remoteAddress
        if (typeof address !== 'string' || !isIP(address)) { reply(400); return }
        const now = Date.now()
        for (const [ip, window] of enrollments) if (window.resetAt <= now) enrollments.delete(ip)
        const window = enrollments.get(address) ?? { count: 0, resetAt: now + 3600_000 }
        if (window.count >= 3) {
          res.setHeader('Retry-After', Math.ceil((window.resetAt - now) / 1000))
          reply(429, { error: 'Too many new Macs registered from this network. Please try again later.' }); return
        }
        const trial: Trial = { id: randomUUID(), hostHash: hash, viewerHash: value.viewerTokenHash, expiresAt: null }
        const next = [...trials, trial]
        options.saveTrials(next)
        trials = next
        enrollments.set(address, { count: window.count + 1, resetAt: window.resetAt })
        credentials.set(hash, { pair: trial.id, role: 'host' })
        credentials.set(trial.viewerHash, { pair: trial.id, role: 'viewer' })
        limits.set(trial.id, null)
        reply(201, access(trial.id)); return
      } catch { if (!res.headersSent) reply(500); return }
    }
    const route = req.url?.match(/^\/v1\/devices(?:\/([a-zA-Z0-9_-]{1,64}))?$/)
    if (!route) { reply(404); return }
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
        if (limits.get(hostId) != null && devices.filter(d => d.hostId === hostId).length >= limits.get(hostId)!) {
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
  const pairingHosts = new Set<string>()
  let closing = false
  const dispose = (key: string, session: Session) => {
    if (sessions.get(key) !== session) return
    sessions.delete(key)
    clearTimeout(session.timer)
    for (const ws of [session.host, session.viewer]) {
      if (ws) { alive.delete(ws); ws.terminate() }
    }
  }
  // Notifications normally update access immediately; reconcile missed deliveries too.
  const reconcile = async () => {
    for (const record of subscriptions) {
      if (closing) return
      try { await refreshSubscription(record) } catch { console.error('Apple subscription refresh failed') }
    }
  }
  const billingTimer = options.billing ? setInterval(() => { void reconcile() }, 5 * 60_000) : undefined
  billingTimer?.unref()
  if (options.billing) void reconcile()
  const heartbeat = setInterval(() => {
    for (const [key, session] of sessions) if (access(key.split(':')[0]!).expired && session.deviceId) dispose(key, session)
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
    const identity = token ? credentials.get(digest(token)) : undefined
    if (!identity || req.headers.origin) { reject('401 Unauthorized'); return }
    if (closing) { reject('503 Service Unavailable'); return }
    if (req.url === '/v1/host') {
      if (identity.role !== 'host') { reject('403 Forbidden'); return }
      if (hosts.has(identity.pair)) { reject('409 Conflict'); return }
      wss.handleUpgrade(req, socket, head, ws => {
        hosts.set(identity.pair, ws)
        if (req.headers['x-routi-pairing-isolation'] === '1') pairingHosts.add(identity.pair)
        alive.add(ws)
        ws.on('pong', () => alive.add(ws))
        const cleanup = () => {
          alive.delete(ws)
          if (hosts.get(identity.pair) !== ws) return
          hosts.delete(identity.pair)
          pairingHosts.delete(identity.pair)
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
            ws.send(JSON.stringify({ type: 'session', id: key.split(':')[1], pairing: !session.deviceId && trials.some(t => t.id === identity.pair) }))
          }
        }
      })
      return
    }
    const match = req.url?.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]{1,64})$/)
    if (!match) { reject('404 Not Found'); return }
    const key = `${identity.pair}:${match[1]}`
    const current = sessions.get(key)
    // Expired Macs keep their control connection and can pair a replacement device.
    // The bootstrap credential reaches Core's pairing-only TLS handler, never chat/VNC.
    if (access(identity.pair).expired && (identity.role === 'viewer'
        ? !!identity.deviceId || !pairingHosts.has(identity.pair) : !current?.viewer || !!current.deviceId)) {
      reject('402 Payment Required'); return
    }
    if (closing) { reject('503 Service Unavailable'); return }
    if (current?.[identity.role]) { reject('409 Conflict'); return }
    if (!current && sessions.size >= (options.maxSessions ?? 100)) {
      reject('429 Too Many Requests'); return
    }
    // The first remote device connection starts the trial, never merely opening the Mac app.
    const trial = trials.find(trial => trial.id === identity.pair)
    if (trial && trial.expiresAt === null && identity.role === 'viewer') {
      if (!hosts.has(identity.pair)) { reject('503 Service Unavailable'); return }
      const next = trials.map(item => item === trial ? { ...item, expiresAt: Date.now() + trialDuration } : item)
      try {
        if (!options.saveTrials) throw Error('Trial storage unavailable')
        options.saveTrials(next)
      } catch { reject('503 Service Unavailable'); return }
      trials = next
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
        if (access(identity.pair).expired && connected.deviceId) { dispose(key, connected); return }
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
        if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ type: 'session', id: match[1], pairing: !identity.deviceId && trials.some(t => t.id === identity.pair) }))
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
      clearInterval(billingTimer)
      for (const host of hosts.values()) host.terminate()
      hosts.clear()
      for (const [key, session] of sessions) dispose(key, session)
      await new Promise<void>(resolve => wss.close(() => resolve()))
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

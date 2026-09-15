import { randomUUID } from 'node:crypto'
import { createServer, connect, type TLSSocket } from 'node:tls'
import { Duplex } from 'node:stream'
import { WebSocket, createWebSocketStream } from 'ws'
import type { Device } from './pairing.js'

function endpoint(base: string, path: string) {
  const url = new URL(base)
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Use a wss:// relay origin (ws:// permitted only for loopback testing)')
  }
  url.pathname = path
  return url
}

function socket(base: string, token: string, path: string) {
  return new WebSocket(endpoint(base, path), { headers: { Authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000 })
}

/** The ready message is consumed before TLS; everything afterward is an encrypted byte stream. */
function transport(base: string, token: string, id: string, signal?: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const ws = socket(base, token, `/v1/sessions/${id}`)
    let ready = false
    const fail = (error: Error) => { reject(error); ws.terminate() }
    const abort = () => fail(Error('Connection stopped'))
    const timeout = setTimeout(() => fail(Error('Relay connection timed out')), 10_000)
    ws.on('error', error => { if (!ready) fail(error) })
    ws.on('close', () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (!ready) reject(Error('Relay disconnected before pairing'))
    })
    ws.once('message', (data, binary) => {
      if (binary || data.toString() !== '{"type":"ready"}') { fail(Error('Invalid relay response')); return }
      ready = true
      clearTimeout(timeout)
      // Attach immediately so a TLS record arriving in this same read cannot be lost.
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 })
      // TLS can emit a large write containing many records. Bound each WebSocket
      // message independently; TLS itself is a byte stream and permits splitting.
      const tunnel = new Duplex({
        read() { stream.resume() },
        write(data: Buffer, _encoding, done) {
          let offset = 0
          function send(error?: Error | null) {
            if (error || offset >= data.length) { done(error); return }
            const chunk = data.subarray(offset, offset + 64 * 1024)
            offset += chunk.length
            stream.write(chunk, send)
          }
          send()
        },
        final(done) { stream.end(done) },
        destroy(error, done) { stream.destroy(); done(error) },
      })
      stream.on('data', (data: Buffer) => { if (!tunnel.push(data)) stream.pause() })
      stream.on('end', () => tunnel.push(null))
      stream.on('error', error => tunnel.destroy(error))
      ws.on('close', () => tunnel.destroy())
      resolve(tunnel)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function connectViewer(base: string, device: Device, signal?: AbortSignal): Promise<TLSSocket> {
  const raw = await transport(base, device.token, randomUUID(), signal)
  const stream = connect({ socket: raw, key: device.key, cert: device.cert, ca: device.peerCert,
    servername: 'routi-host', minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true })
  stream.on('error', () => raw.destroy())
  raw.on('error', () => stream.destroy())
  raw.on('close', () => stream.destroy())
  stream.on('close', () => raw.destroy())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stream.destroy(Error('Device authentication timed out')), 10_000)
    stream.once('error', reject)
    stream.once('close', () => { clearTimeout(timer); reject(Error('Device disconnected')) })
    stream.once('secureConnect', () => { clearTimeout(timer); resolve(stream) })
  })
}

/** One outbound control connection per paired viewer; sessions are opened on demand. */
export function startHost(base: string, device: Device, options: {
  onConnection: (stream: TLSSocket) => void;
  onError?: (error: Error) => void;
  reconnectMs?: number;
}) {
  // Validate before scheduling any reconnects.
  endpoint(base, '/v1/host')
  let attempt = new AbortController()
  const pending = new Set<string>()
  const streams = new Set<Duplex>()
  let control: WebSocket
  let retry: NodeJS.Timeout | undefined
  let failures = 0
  let stopped = false
  let resolveReady: () => void
  let rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Callers may use the ready promise or simply leave the connector running.
  void ready.catch(() => {})
  const tls = createServer({ key: device.key, cert: device.cert, ca: device.peerCert,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', handshakeTimeout: 10_000 }, stream => {
    stream.on('error', error => options.onError?.(error))
    options.onConnection(stream)
  })
  tls.on('tlsClientError', (error, stream) => { stream.destroy(); options.onError?.(error) })
  const disposeStreams = () => { for (const stream of streams) stream.destroy(); streams.clear() }
  async function accept(id: string, signal: AbortSignal) {
    if (pending.has(id) || pending.size >= 4 || stopped) return
    pending.add(id)
    try {
      const raw = await transport(base, device.token, id, signal)
      if (stopped || signal.aborted) { raw.destroy(); return }
      streams.add(raw)
      raw.on('error', error => options.onError?.(error))
      raw.once('close', () => { streams.delete(raw); pending.delete(id) })
      // Node's TLS server accepts a Duplex transport without opening a listening port.
      tls.emit('connection', raw)
    } catch (error) { pending.delete(id); if (!stopped) options.onError?.(error as Error) }
  }
  function open() {
    if (stopped) return
    attempt = new AbortController()
    const active = attempt
    let rejected = false
    control = socket(base, device.token, '/v1/host')
    control.on('unexpected-response', (_request, response) => {
      response.resume()
      rejected = response.statusCode === 401 || response.statusCode === 403
      if (rejected) rejectReady(Error('Host credential rejected; pair this device again'))
      control.terminate()
    })
    control.on('error', error => options.onError?.(error))
    control.on('message', (data, binary) => {
      try {
        if (binary || data.toString().length > 1024) throw Error('Invalid host control message')
        const message = JSON.parse(data.toString())
        if (message.type === 'registered') { failures = 0; resolveReady(); return }
        if (message.type !== 'session' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.id)) throw Error('Invalid session request')
        void accept(message.id, active.signal)
      } catch { control.terminate() }
    })
    control.on('close', () => {
      active.abort()
      disposeStreams()
      if (!stopped && !rejected) {
        const delay = options.reconnectMs ?? Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) + Math.floor(Math.random() * 500)
        retry = setTimeout(open, delay)
      }
    })
  }
  open()
  return {
    ready,
    stop() {
      if (stopped) return
      stopped = true
      rejectReady(Error('Host stopped'))
      clearTimeout(retry)
      attempt.abort()
      control.terminate()
      disposeStreams()
      tls.close()
    },
  }
}

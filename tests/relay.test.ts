import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { createRelay, digest } from '../src/relay.js'

async function fixture(t: TestContext, options: Parameters<typeof createRelay>[1] = {}) {
  const credentials = Array.from({ length: 2 }, () => ({ host: randomBytes(32).toString('base64url'), viewer: randomBytes(32).toString('base64url') }))
  const relay = createRelay(credentials.map((p, i) => ({ id: `pair${i}`, hostHash: digest(p.host), viewerHash: digest(p.viewer) })), options)
  relay.server.listen(0, '127.0.0.1')
  await once(relay.server, 'listening')
  t.after(() => relay.close())
  const base = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  function connect(role: 'host' | 'viewer', pair = 0, session = 'chat') {
    const ws = new WebSocket(`${base}/v1/sessions/${session}`, { headers: { Authorization: `Bearer ${credentials[pair][role]}` } })
    ws.on('error', () => {})
    t.after(() => ws.terminate())
    return ws
  }
  async function joined(pair = 0, session = 'chat') {
    const host = connect('host', pair, session)
    const hostReady = once(host, 'message')
    await once(host, 'open')
    const viewer = connect('viewer', pair, session)
    const viewerReady = once(viewer, 'message')
    for (const [data] of await Promise.all([hostReady, viewerReady])) assert.equal(data.toString(), '{"type":"ready"}')
    return { host, viewer }
  }
  return { relay, base, connect, joined }
}

test('relays ordered text and binary messages in both directions', { timeout: 3000 }, async t => {
  const { joined } = await fixture(t)
  const { host, viewer } = await joined()
  let next = once(viewer, 'message')
  host.send('{"message":"hello"}')
  let [data, binary] = await next
  assert.equal(data.toString(), '{"message":"hello"}')
  assert.equal(binary, false)
  next = once(host, 'message')
  viewer.send(Buffer.from([0, 255, 8]))
  ;[data, binary] = await next
  assert.deepEqual(data, Buffer.from([0, 255, 8]))
  assert.equal(binary, true)
  const received: number[] = []
  const done = new Promise<void>(resolve => viewer.on('message', d => {
    received.push(Number(d.toString()))
    if (received.length === 100) resolve()
  }))
  for (let i = 0; i < 100; i++) host.send(String(i))
  await done
  assert.deepEqual(received, Array.from({ length: 100 }, (_, i) => i))
})

test('rejects absent or invalid credentials and browser-origin upgrades', { timeout: 3000 }, async t => {
  const { base } = await fixture(t)
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Origin: 'https://example.com' }]) {
    const ws = new WebSocket(`${base}/v1/sessions/chat`, { headers })
    ws.on('error', () => {})
    const status = await new Promise<number>(resolve => ws.on('unexpected-response', (_req, res) => {
      res.resume(); resolve(res.statusCode!); ws.terminate()
    }))
    assert.equal(status, 401)
  }
})

test('same session name is isolated across pairs', { timeout: 3000 }, async t => {
  const { joined } = await fixture(t)
  const a = await joined(0)
  const b = await joined(1)
  const first = once(a.viewer, 'message')
  const second = once(b.viewer, 'message')
  a.host.send('A'); b.host.send('B')
  assert.equal((await first)[0].toString(), 'A')
  assert.equal((await second)[0].toString(), 'B')
})

test('force-disconnect releases the session and permits reconnection', { timeout: 3000 }, async t => {
  const { relay, joined } = await fixture(t)
  const { host, viewer } = await joined()
  const closed = once(host, 'close')
  viewer.terminate()
  await closed
  assert.equal(relay.sessionCount, 0)
  await joined()
  assert.equal(relay.sessionCount, 1)
})

test('unpaired sessions expire without affecting other sessions', { timeout: 3000 }, async t => {
  const { relay, connect, joined } = await fixture(t, { waitMs: 80 })
  const active = await joined(1)
  const waiting = connect('host', 0)
  await once(waiting, 'close')
  assert.equal(relay.sessionCount, 1)
  const next = once(active.viewer, 'message')
  active.host.send('still alive')
  assert.equal((await next)[0].toString(), 'still alive')
})

test('buffer budget closes only the offending session', { timeout: 3000 }, async t => {
  const { relay, joined } = await fixture(t, { maxBuffered: 128 })
  const bad = await joined(0)
  const good = await joined(1)
  const closed = once(bad.viewer, 'close')
  bad.host.send(Buffer.alloc(256))
  await closed
  assert.equal(relay.sessionCount, 1)
  const next = once(good.viewer, 'message')
  good.host.send('ok')
  assert.equal((await next)[0].toString(), 'ok')
})

test('rejects duplicate host and caps total sessions', { timeout: 3000 }, async t => {
  const { connect, joined } = await fixture(t, { maxSessions: 1 })
  await joined()
  for (const [pair, session, expected] of [[0, 'chat', 409], [1, 'other', 429]] as const) {
    const ws = connect('host', pair, session)
    const status = await new Promise<number>(resolve => ws.on('unexpected-response', (_req, res) => {
      res.resume(); resolve(res.statusCode!); ws.terminate()
    }))
    assert.equal(status, expected)
  }
})

test('oversized messages terminate their session', { timeout: 3000 }, async t => {
  const { relay, joined } = await fixture(t, { maxPayload: 64 })
  const { host, viewer } = await joined()
  const closed = once(viewer, 'close')
  host.send(Buffer.alloc(65))
  await closed
  assert.equal(relay.sessionCount, 0)
})

test('heartbeat removes a peer that stops answering', { timeout: 3000 }, async t => {
  const { relay, joined } = await fixture(t, { heartbeatMs: 30 })
  const { host, viewer } = await joined()
  // Simulate a network black hole at the client receive side.
  viewer.pause()
  await once(host, 'close')
  viewer.resume()
  assert.equal(relay.sessionCount, 0)
})

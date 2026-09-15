import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test, type TestContext } from 'node:test'
import { createPairing } from '../src/pairing.js'
import { createRelay } from '../src/relay.js'
import { connectViewer, startHost } from '../src/connection.js'

async function setup(t: TestContext) {
  const pairing = await createPairing()
  const relay = createRelay([pairing.relay])
  relay.server.listen(0, '127.0.0.1')
  await once(relay.server, 'listening')
  t.after(() => relay.close())
  const url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  return { pairing, relay, url }
}

test('outbound host joins viewer on demand and exchanges data over mutual TLS', { timeout: 5000 }, async t => {
  const { pairing, url } = await setup(t)
  let authenticated = false
  const host = startHost(url, pairing.host, { onConnection: stream => {
    authenticated = stream.authorized
    stream.pipe(stream)
  } })
  t.after(() => host.stop())
  await host.ready
  const viewer = await connectViewer(url, pairing.viewer)
  t.after(() => viewer.destroy())
  assert.equal(viewer.authorized, true)
  assert.equal(viewer.getProtocol(), 'TLSv1.3')
  const response = once(viewer, 'data')
  viewer.write('private chat message')
  assert.equal((await response)[0].toString(), 'private chat message')
  assert.equal(authenticated, true)
})

test('a stolen relay token alone cannot impersonate the paired viewer', { timeout: 5000 }, async t => {
  const { pairing, url } = await setup(t)
  const attacker = await createPairing()
  let accepted = false
  const host = startHost(url, pairing.host, { onConnection: () => { accepted = true } })
  t.after(() => host.stop())
  await host.ready
  // Server authentication can complete before TLS 1.3 client-certificate rejection arrives.
  const rejected = (async () => {
    const viewer = await connectViewer(url, { ...attacker.viewer, token: pairing.viewer.token, peerCert: pairing.host.cert })
    t.after(() => viewer.destroy())
    await once(viewer, 'close')
  })()
  await rejected.catch(() => {})
  assert.equal(accepted, false)
})

test('viewer rejects a host with an unpaired certificate', { timeout: 5000 }, async t => {
  const { pairing, url } = await setup(t)
  const other = await createPairing()
  const host = startHost(url, { ...other.host, token: pairing.host.token, peerCert: pairing.viewer.cert }, { onConnection: stream => stream.destroy() })
  t.after(() => host.stop())
  await host.ready
  await assert.rejects(connectViewer(url, pairing.viewer))
})

test('revoking a pair closes active encrypted sessions and rejects new connections', { timeout: 5000 }, async t => {
  const { pairing, relay, url } = await setup(t)
  const host = startHost(url, pairing.host, { onConnection: stream => stream.pipe(stream) })
  t.after(() => host.stop())
  await host.ready
  const viewer = await connectViewer(url, pairing.viewer)
  const closed = once(viewer, 'close')
  relay.revokePair(pairing.relay.id)
  await closed
  assert.equal(relay.sessionCount, 0)
  await assert.rejects(connectViewer(url, pairing.viewer))
})

test('host stop closes connections and aborted viewers do not wait for timeout', { timeout: 5000 }, async t => {
  const { pairing, url } = await setup(t)
  const host = startHost(url, pairing.host, { onConnection: stream => stream.pipe(stream) })
  t.after(() => host.stop())
  await host.ready
  const viewer = await connectViewer(url, pairing.viewer)
  const closed = once(viewer, 'close')
  host.stop()
  await closed
  await assert.rejects(connectViewer(url, pairing.viewer, AbortSignal.abort()))
})

test('unencrypted non-loopback relay addresses are rejected', async () => {
  const pair = await createPairing()
  assert.throws(() => startHost('ws://connect.routibot.com', pair.host, { onConnection() {} }), /wss/)
})

test('host reconnects after relay restart and accepts a fresh session', { timeout: 5000 }, async t => {
  const { pairing, relay, url } = await setup(t)
  const host = startHost(url, pairing.host, { reconnectMs: 20, onConnection: stream => stream.pipe(stream) })
  t.after(() => host.stop())
  await host.ready
  const first = await connectViewer(url, pairing.viewer)
  const disconnected = once(first, 'close')
  const port = Number(new URL(url).port)
  await relay.close()
  await disconnected
  const replacement = createRelay([pairing.relay])
  replacement.server.listen(port, '127.0.0.1')
  await once(replacement.server, 'listening')
  t.after(() => replacement.close())
  // A waiting viewer is announced when the host control connection returns.
  const viewer = await connectViewer(url, pairing.viewer)
  t.after(() => viewer.destroy())
  const response = once(viewer, 'data')
  viewer.write('new command')
  assert.equal((await response)[0].toString(), 'new command')
})

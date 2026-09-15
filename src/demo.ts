import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { connectViewer, startHost } from './connection.js'
import { createPairing } from './pairing.js'
import { createRelay } from './relay.js'

const pairing = await createPairing()
const relay = createRelay([pairing.relay])
relay.server.listen(0, '127.0.0.1')
await once(relay.server, 'listening')
const url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
const host = startHost(url, pairing.host, { onConnection: stream => stream.pipe(stream) })
try {
  await host.ready
  console.log('Mac connector registered through an outbound connection.')
  const viewer = await connectViewer(url, pairing.viewer)
  try {
    const response = once(viewer, 'data')
    viewer.write('Synthetic Routi message')
    assert.equal((await response)[0].toString(), 'Synthetic Routi message')
    console.log('Paired viewer exchanged a test message over TLS 1.3.')
    const closed = once(viewer, 'close')
    relay.revokePair(pairing.relay.id)
    await closed
    console.log('Revocation disconnected the viewer. No files or real bot data were used.')
  } finally { viewer.destroy() }
} finally { host.stop(); await relay.close() }

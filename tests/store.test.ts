import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { RelayStore } from '../src/store.js'
import { createRelay, digest } from '../src/relay.js'

const empty = () => ({ pairs: [], trials: [], devices: [], subscriptions: [] })

test('SQLite imports once, rolls back invalid writes, and preserves records across restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-db-'))
  const path = join(directory, 'relay.db')
  let store: RelayStore
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }) })
  const mac = { id: 'mac', hostHash: digest('mac'), viewerHash: digest('invite'), expiresAt: 1000 }
  const device = { hostId: 'mac', id: 'phone', hash: digest('phone') }
  const records = { ...empty(), trials: [mac], devices: [device],
    subscriptions: [{ originalTransactionId: 'purchase', macId: 'mac', expiresAt: 2000 }] }
  // Failed import must not leave a partial database or mark it initialized.
  assert.throws(() => new RelayStore(path, () => ({ ...records, devices: [device, device] })))
  store = new RelayStore(path, () => records)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.throws(() => store.saveDevices([device, { ...device, id: 'duplicate-token' }]))
  assert.equal(store.load().devices.length, 1)
  assert.throws(() => store.saveSubscriptions([{ originalTransactionId: 'invalid', macId: 'unknown', expiresAt: 5 }]))
  assert.equal(store.load().subscriptions[0]!.originalTransactionId, 'purchase')
  store.saveTrials([{ ...mac, expiresAt: 3000 }])
  assert.equal(store.load().devices[0]!.id, 'phone')
  assert.throws(() => store.saveTrials([])) // Cannot orphan existing devices/subscriptions.
  assert.equal(store.load().trials[0]!.expiresAt, 3000)
  store.saveDevices([])
  store.close()
  store = new RelayStore(path, () => { throw Error('Must never import old files again') })
  assert.equal(store.load().devices.length, 0)
  assert.equal(store.load().trials[0]!.expiresAt, 3000)
  assert.equal(store.load().subscriptions[0]!.expiresAt, 2000)
})

test('relay enrollment, trial start, purchase, and device revocation persist in SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-db-'))
  const path = join(directory, 'relay.db')
  const mac = 'm'.repeat(43), invite = 'i'.repeat(43), phone = 'p'.repeat(43)
  let store = new RelayStore(path, empty)
  let relay: ReturnType<typeof createRelay>
  let base: string
  let accountToken = ''
  const paidUntil = Date.now() + 7 * 86400_000
  const start = async () => {
    const { pairs, ...records } = store.load()
    relay = createRelay(pairs, { ...records, maxTrials: 10,
      saveTrials: next => store.saveTrials(next), saveDevices: next => store.saveDevices(next),
      saveSubscriptions: next => store.saveSubscriptions(next),
      billing: { productId: 'test.monthly',
        transaction: async () => ({ originalTransactionId: 'test-purchase', appAccountToken: accountToken }),
        notification: async () => undefined, expiration: async () => paidUntil },
    })
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
    base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  }
  t.after(async () => { await relay?.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const api = (path: string, token: string, method = 'GET', body?: unknown) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
  })
  await start()
  assert.equal((await api('/v1/trial', mac, 'POST', { viewerTokenHash: digest(invite) })).status, 201)
  assert.equal((await api('/v1/devices', mac, 'POST', { id: 'phone', hash: digest(phone) })).status, 201)
  const access = await (await api('/v1/access', phone)).json() as { billing: { appAccountToken: string } }
  accountToken = access.billing.appAccountToken
  const ws = (token: string, route: string) => new WebSocket(base.replace('http:', 'ws:') + route,
    { headers: { Authorization: `Bearer ${token}` } })
  const control = ws(mac, '/v1/host'); await once(control, 'message')
  const waiting = once(control, 'message')
  const viewer = ws(phone, '/v1/sessions/test'); viewer.on('error', () => {})
  await waiting
  const deadline = store.load().trials[0]!.expiresAt!
  assert.ok(deadline > Date.now())
  assert.equal((await api('/v1/subscription', phone, 'POST', { signedPayload: 'test' })).status, 200)
  assert.equal((await api('/v1/devices/phone', mac, 'DELETE')).status, 200)
  await relay!.close(); store.close()
  store = new RelayStore(path, () => { throw Error('Unexpected reimport') })
  await start()
  assert.equal((await api('/v1/access', phone)).status, 401)
  assert.equal((await api('/v1/trial', mac, 'POST', { viewerTokenHash: digest(invite) })).status, 200)
  assert.equal(store.load().trials[0]!.expiresAt, deadline)
  assert.equal(store.load().subscriptions[0]!.expiresAt, paidUntil)
})

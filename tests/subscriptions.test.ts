import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createRelay, digest, purchaseToken } from '../src/relay.js'
import type { AppleBilling, Subscription } from '../src/subscriptions.js'

// The Apple boundary is stubbed; the relay, authentication and access enforcement are real.
test('purchase and restore cover only the paired Mac; renewal and refund update access', async t => {
  const secret = () => randomBytes(32).toString('base64url')
  const mac = secret(), invite = secret(), phone = secret(), ipad = secret(), other = secret()
  let expiration = Date.now() + 86400_000
  let saved: Subscription[] = []
  let failStorage = false, failApple = false
  const billing: AppleBilling = {
    productId: 'connect.monthly',
    async transaction(jws) {
      if (jws !== 'apple-signed') throw Error('Bad signature')
      return { originalTransactionId: 'purchase-1', appAccountToken: purchaseToken('mac') }
    },
    async notification(jws) {
      if (jws !== 'apple-notification') throw Error('Bad signature')
      return 'purchase-1'
    },
    async expiration() { if (failApple) throw Error('Apple unavailable'); return expiration },
  }
  const options = {
    trials: [{ id: 'mac', hostHash: digest(mac), viewerHash: digest(invite), expiresAt: Date.now() - 1 },
      { id: 'other', hostHash: digest(secret()), viewerHash: digest(secret()), expiresAt: Date.now() - 1 }],
    devices: [{ hostId: 'mac', id: 'phone', hash: digest(phone) }, { hostId: 'mac', id: 'ipad', hash: digest(ipad) },
      { hostId: 'other', id: 'other-phone', hash: digest(other) }],
    billing, heartbeatMs: 20,
    saveSubscriptions(next: Subscription[]) { if (failStorage) throw Error('disk full'); saved = structuredClone(next) },
  }
  let relay = createRelay([], options)
  t.after(() => relay.close())
  const listen = async () => {
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
    return `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  }
  let base = await listen()
  const api = (token: string, path = '/v1/access', signedPayload?: string) => fetch(base + path, {
    method: signedPayload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` },
    body: signedPayload ? JSON.stringify({ signedPayload }) : undefined,
  })
  const claim = (token = phone, jws = 'apple-signed') => api(token, '/v1/subscription', jws)
  const access = async (token = phone) => (await api(token)).json() as Promise<{ expired: boolean; billing: { subscribed: boolean } }>
  assert.equal((await access()).expired, true)
  assert.equal((await claim(mac)).status, 401)
  assert.equal((await claim(invite)).status, 401)
  assert.equal((await claim(secret())).status, 401)
  assert.equal((await claim(phone, 'forged')).status, 400)
  assert.equal((await claim(other)).status, 409)
  assert.equal((await access(other)).expired, true)
  failStorage = true
  assert.equal((await claim()).status, 503)
  assert.equal((await access()).expired, true)
  failStorage = false
  failApple = true
  assert.equal((await claim()).status, 503)
  failApple = false
  assert.equal((await claim()).status, 200)
  assert.equal((await access()).expired, false)
  assert.equal((await claim(ipad)).status, 200)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.macId, 'mac')
  await relay.close()
  relay = createRelay([], { ...options, subscriptions: saved })
  base = await listen()
  assert.equal((await access()).billing.subscribed, true)
  const control = new WebSocket(base.replace('http:', 'ws:') + '/v1/host', { headers: { Authorization: `Bearer ${mac}` } })
  await once(control, 'message')
  expiration += 86400_000
  assert.equal((await api('', '/v1/apple-notifications', 'apple-notification')).status, 200)
  assert.equal(saved[0]!.expiresAt, expiration)
  assert.equal((await api('', '/v1/apple-notifications', 'forged')).status, 400)
  // Refunding cuts access even if the phone replays an older, valid signed purchase.
  const a = new WebSocket(base.replace('http:', 'ws:') + '/v1/sessions/chat', { headers: { Authorization: `Bearer ${mac}` } })
  const readyA = once(a, 'message')
  const b = new WebSocket(base.replace('http:', 'ws:') + '/v1/sessions/chat', { headers: { Authorization: `Bearer ${phone}` } })
  await Promise.all([readyA, once(b, 'message')])
  const closed = once(b, 'close')
  expiration = 0
  assert.equal((await api('', '/v1/apple-notifications', 'apple-notification')).status, 200)
  await closed
  assert.equal((await claim()).status, 200)
  assert.equal((await access()).expired, true)
  assert.equal((await access()).billing.subscribed, false)
  assert.equal(control.readyState, WebSocket.OPEN)
  const blocked = new WebSocket(base.replace('http:', 'ws:') + '/v1/sessions/expired', { headers: { Authorization: `Bearer ${phone}` } })
  assert.match(String((await once(blocked, 'error'))[0]), /402/)
})

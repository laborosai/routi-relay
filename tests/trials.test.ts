import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createRelay, digest, type Trial } from '../src/relay.js'

const token = () => randomBytes(32).toString('base64url')

test('trial starts with the first phone connection, persists, and closes only expired sessions', { timeout: 10_000 }, async t => {
  const mac = token(), phone = token(), pilotMac = token(), pilotPhone = token()
  const pilot = { id: 'pilot', hostHash: digest(pilotMac), viewerHash: digest(pilotPhone) }
  let saved: Trial[] = []
  let relay = createRelay([pilot], { saveDevices: () => {}, saveTrials: next => { saved = structuredClone(next) }, heartbeatMs: 20 })
  t.after(() => relay.close())
  async function listen() {
    relay.server.listen(0, '127.0.0.1')
    await once(relay.server, 'listening')
    return `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  }
  let base = await listen()
  const api = (credential: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential}` }, body: body ? JSON.stringify(body) : undefined,
  })
  const enroll = () => api(mac, '/v1/trial', { viewerTokenHash: digest(phone) })
  const socket = (credential: string, path: string) => new WebSocket(`${base.replace('http:', 'ws:')}${path}`, { headers: { Authorization: `Bearer ${credential}` } })
  const control = async (credential: string) => { const ws = socket(credential, '/v1/host'); await once(ws, 'message'); return ws }
  const join = async (host: string, viewer: string, id: string) => {
    const a = socket(host, `/v1/sessions/${id}`), ar = once(a, 'message')
    const b = socket(viewer, `/v1/sessions/${id}`), br = once(b, 'message')
    await Promise.all([ar, br]); return { a, b }
  }
  assert.equal((await enroll()).status, 201)
  assert.equal((await enroll()).status, 200)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.expiresAt, null)
  await control(mac)
  assert.equal(saved[0]!.expiresAt, null)
  const trial = await join(mac, phone, 'chat')
  const deadline = saved[0]!.expiresAt!
  assert.ok(Math.abs(deadline - Date.now() - 3 * 86400_000) < 1000)
  const bytes = once(trial.b, 'message')
  trial.a.send('encrypted payload')
  assert.equal((await bytes)[0].toString(), 'encrypted payload')
  assert.equal((await enroll()).status, 200)
  assert.equal(saved[0]!.expiresAt, deadline)
  const registeredPhone = token()
  await relay.close()
  relay = createRelay([pilot], { trials: saved, devices: [{ hostId: saved[0]!.id, id: 'phone', hash: digest(registeredPhone) }], saveTrials: next => { saved = structuredClone(next) }, heartbeatMs: 20 })
  base = await listen()
  await control(mac)
  const resumed = await join(mac, registeredPhone, 'desktop')
  const unaffected = await join(pilotMac, pilotPhone, 'chat')
  const closed = once(resumed.b, 'close')
  t.mock.method(Date, 'now', () => deadline + 1)
  await closed
  assert.deepEqual(await (await api(mac, '/v1/access')).json(), { trial: true, expiresAt: deadline, expired: true })
  assert.equal((await enroll()).status, 200)
  assert.equal(saved[0]!.expiresAt, deadline)
  const rejected = socket(registeredPhone, '/v1/sessions/again')
  assert.match(String((await once(rejected, 'error'))[0]), /402/)
  const received = once(unaffected.b, 'message')
  unaffected.a.send('pilot remains connected')
  assert.equal((await received)[0].toString(), 'pilot remains connected')
  assert.equal((await api(phone, '/v1/trial', { viewerTokenHash: digest(token()) })).status, 409)
})

test('enrollment is bounded, authenticated, and cannot succeed without durable storage', async t => {
  let fail = true
  const relay = createRelay([], { maxTrials: 1, saveTrials: () => { if (fail) throw Error('disk full') } })
  t.after(() => relay.close())
  relay.server.listen(0, '127.0.0.1')
  await once(relay.server, 'listening')
  const base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  const mac = token(), viewerTokenHash = digest(token())
  const enroll = (credential = mac, body: unknown = { viewerTokenHash }, origin?: string) => fetch(`${base}/v1/trial`, {
    method: 'POST', headers: { Authorization: `Bearer ${credential}`, ...(origin && { Origin: origin }) }, body: JSON.stringify(body),
  })
  assert.equal((await enroll('invalid')).status, 401)
  assert.equal((await enroll(mac, {}, 'https://example.com')).status, 401)
  assert.equal((await enroll(mac, null)).status, 400)
  assert.equal((await enroll(mac, { viewerTokenHash: digest(mac) })).status, 409)
  assert.equal((await enroll()).status, 500)
  fail = false
  assert.deepEqual((await Promise.all([enroll(), enroll()])).map(r => r.status).sort(), [200, 201])
  assert.equal((await enroll(token())).status, 409)
  assert.equal((await enroll(token(), { viewerTokenHash: digest(token()) })).status, 503)
  assert.equal((await enroll(mac, { viewerTokenHash: digest(token()) })).status, 409)
})

test('a phone cannot start a trial unless its deadline is saved', async t => {
  const mac = token(), phone = token()
  const trial: Trial = { id: 'mac', hostHash: digest(mac), viewerHash: digest(phone), expiresAt: null }
  const relay = createRelay([], { trials: [trial], saveTrials: () => { throw Error('disk full') } })
  t.after(() => relay.close())
  relay.server.listen(0, '127.0.0.1')
  await once(relay.server, 'listening')
  const base = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  const control = new WebSocket(`${base}/v1/host`, { headers: { Authorization: `Bearer ${mac}` } })
  await once(control, 'message')
  const viewer = new WebSocket(`${base}/v1/sessions/phone`, { headers: { Authorization: `Bearer ${phone}` } })
  assert.match(String((await once(viewer, 'error'))[0]), /503/)
  const response = await fetch(base.replace('ws:', 'http:') + '/v1/access', { headers: { Authorization: `Bearer ${mac}` } })
  assert.deepEqual(await response.json(), { trial: true, expiresAt: null, expired: false })
  assert.equal(relay.sessionCount, 0)
})

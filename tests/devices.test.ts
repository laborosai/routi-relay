import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createRelay, digest, type RegisteredDevice } from '../src/relay.js'

const token = () => randomBytes(32).toString('base64url')

test('device credentials persist, respect allowances, and revoke independently across hosts', { timeout: 10_000 }, async t => {
  const host = token(), otherHost = token(), bootstrap = token(), phone = token(), tablet = token()
  const pairs = [
    { id: 'mac', hostHash: digest(host), viewerHash: digest(bootstrap), maxDevices: 2 },
    { id: 'other', hostHash: digest(otherHost), viewerHash: digest(token()) },
  ]
  let saved: RegisteredDevice[] = []
  let relay = createRelay(pairs, { saveDevices: next => { saved = structuredClone(next) } })
  const listen = async () => {
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
    return `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  }
  let base = await listen()
  t.after(() => relay.close())
  const request = (method: string, credential = host, path = '', body?: unknown) => fetch(`${base}/v1/devices${path}`, {
    method, headers: { Authorization: `Bearer ${credential}` }, body: body ? JSON.stringify(body) : undefined,
  })
  assert.equal((await request('POST', bootstrap, '', { id: 'bad', hash: digest(token()) })).status, 401)
  assert.equal((await request('POST', host, '', { id: 'phone', hash: digest(phone) })).status, 201)
  assert.equal((await request('POST', host, '', { id: 'tablet', hash: digest(tablet) })).status, 201)
  assert.equal((await request('POST', host, '', { id: 'phone', hash: digest(phone) })).status, 200)
  assert.equal((await request('POST', host, '', { id: 'third', hash: digest(token()) })).status, 409)
  assert.equal((await request('POST', otherHost, '', { id: 'stolen', hash: digest(phone) })).status, 409)
  await relay.close()
  relay = createRelay(pairs, { devices: saved, saveDevices: next => { saved = structuredClone(next) } })
  base = await listen()
  assert.deepEqual(await (await request('GET')).json(), { maxDevices: 2, devices: [{ id: 'phone' }, { id: 'tablet' }] })
  await request('DELETE', otherHost, '/phone')
  assert.equal(saved.length, 2)
  async function join(credential: string, id: string) {
    const url = `${base.replace('http:', 'ws:')}/v1/sessions/${id}`
    const a = new WebSocket(url, { headers: { Authorization: `Bearer ${host}` } })
    const aReady = once(a, 'message')
    const b = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}` } })
    const bReady = once(b, 'message')
    await Promise.all([aReady, bReady])
    return { a, b }
  }
  const first = await join(phone, 'first'), second = await join(tablet, 'second')
  const closed = once(first.b, 'close')
  await request('DELETE', host, '/phone')
  await closed
  const received = once(second.b, 'message')
  second.a.send('tablet still connected')
  assert.equal((await received)[0].toString(), 'tablet still connected')
  const rejected = new WebSocket(`${base.replace('http:', 'ws:')}/v1/sessions/reconnect`, { headers: { Authorization: `Bearer ${phone}` } })
  rejected.on('error', () => {})
  const status = await new Promise<number>(resolve => rejected.on('unexpected-response', (_req, res) => {
    resolve(res.statusCode!); res.resume(); rejected.terminate()
  }))
  assert.equal(status, 401)
  assert.equal((await request('POST', host, '', { id: 'third', hash: digest(token()) })).status, 201)
})

test('failed persistence does not grant a device access', async t => {
  const host = token()
  const relay = createRelay([{ id: 'mac', hostHash: digest(host), viewerHash: digest(token()) }], {
    saveDevices: () => { throw Error('disk unavailable') },
  })
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
  t.after(() => relay.close())
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/devices`
  const headers = { Authorization: `Bearer ${host}` }
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ id: 'phone', hash: digest(token()) }) })).status, 500)
  assert.deepEqual(await (await fetch(url, { headers })).json(), { maxDevices: null, devices: [] })
})

test('the default plan does not impose a five-device allowance', async t => {
  const host = token()
  const relay = createRelay([{ id: 'mac', hostHash: digest(host), viewerHash: digest(token()) }], { saveDevices: () => {} })
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening')
  t.after(() => relay.close())
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/devices`
  const headers = { Authorization: `Bearer ${host}` }
  for (let index = 0; index < 6; index++) {
    assert.equal((await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ id: `device-${index}`, hash: digest(token()) }) })).status, 201)
  }
})

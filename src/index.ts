import { readFileSync } from 'node:fs'
import { createRelay } from './relay.js'
import { RelayStore } from './store.js'
import { appleBilling } from './subscriptions.js'

function readRecords<T>(path?: string): T[] {
  if (!path) return []
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return [] }
}

const maxTrials = Number(process.env.RELAY_MAX_TRIALS ?? 0)
if (!Number.isInteger(maxTrials) || maxTrials < 0) throw Error('Invalid RELAY_MAX_TRIALS')
const billingConfig = process.env.RELAY_APPLE_CONFIG
const billing = billingConfig ? appleBilling(JSON.parse(readFileSync(billingConfig, 'utf8'))) : undefined
const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT')
const store = new RelayStore(process.env.RELAY_DB_FILE ?? 'relay.db', () => ({
  // Import pilot files once. Later restarts use only SQLite.
  pairs: process.env.RELAY_PAIRS_FILE ? JSON.parse(readFileSync(process.env.RELAY_PAIRS_FILE, 'utf8')) : [],
  trials: readRecords(process.env.RELAY_TRIALS_FILE),
  devices: readRecords(process.env.RELAY_DEVICES_FILE),
  subscriptions: readRecords(process.env.RELAY_SUBSCRIPTIONS_FILE),
}))
const { pairs, ...records } = store.load()
const relay = createRelay(pairs, {
  ...records, billing, maxTrials,
  trustProxy: process.env.RELAY_TRUST_PROXY === '1',
  saveSubscriptions: next => store.saveSubscriptions(next),
  saveTrials: next => store.saveTrials(next),
  saveDevices: next => store.saveDevices(next),
})
const host = process.env.HOST ?? '127.0.0.1'
relay.server.listen(port, host, () => console.log(`Routi relay listening on ${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void relay.close().then(() => store.close()) })
}

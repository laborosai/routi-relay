import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createRelay, type Pair, type Trial, type RegisteredDevice } from './relay.js'

import { appleBilling, type Subscription } from './subscriptions.js'

function readRecords<T>(path?: string): T[] {
  if (!path) return []
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return [] }
}

function saveRecords(path: string, records: unknown[]): void {
  writeFileSync(`${path}.next`, JSON.stringify(records), { mode: 0o600 })
  renameSync(`${path}.next`, path)
}

const path = process.env.RELAY_PAIRS_FILE
if (!path) throw Error('Set RELAY_PAIRS_FILE to your relay pair configuration')
const pairs: Pair[] = JSON.parse(readFileSync(path, 'utf8'))
const devicePath = process.env.RELAY_DEVICES_FILE
const devices = readRecords<RegisteredDevice>(devicePath)
const trialPath = process.env.RELAY_TRIALS_FILE
if (trialPath && !devicePath) throw Error('Set RELAY_DEVICES_FILE to persist trial device credentials')
const trials = readRecords<Trial>(trialPath)
const maxTrials = Number(process.env.RELAY_MAX_TRIALS ?? 100)
if (!Number.isInteger(maxTrials) || maxTrials < 0) throw Error('Invalid RELAY_MAX_TRIALS')
const billingConfig = process.env.RELAY_APPLE_CONFIG
const billing = billingConfig ? appleBilling(JSON.parse(readFileSync(billingConfig, 'utf8'))) : undefined
const subscriptionPath = process.env.RELAY_SUBSCRIPTIONS_FILE
if (billing && !subscriptionPath) throw Error('Set RELAY_SUBSCRIPTIONS_FILE for Apple billing')
const subscriptions = readRecords<Subscription>(subscriptionPath)
const relay = createRelay(pairs, {
  trustProxy: process.env.RELAY_TRUST_PROXY === '1',
  billing, subscriptions,
  saveSubscriptions: subscriptionPath ? next => saveRecords(subscriptionPath, next) : undefined,
  devices, trials, maxTrials,
  saveTrials: trialPath ? next => saveRecords(trialPath, next) : undefined,
  saveDevices: next => {
    if (!devicePath) throw Error('Set RELAY_DEVICES_FILE to enable device enrollment')
    saveRecords(devicePath, next)
  },
})
const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT')
const host = process.env.HOST ?? '127.0.0.1'
relay.server.listen(port, host, () => console.log(`Routi relay listening on ${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void relay.close() })
}

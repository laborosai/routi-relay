import { readFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createRelay, type Pair, type Trial, type RegisteredDevice } from './relay.js'

const path = process.env.RELAY_PAIRS_FILE
if (!path) throw Error('Set RELAY_PAIRS_FILE to your relay pair configuration')
const pairs: Pair[] = JSON.parse(await readFile(path, 'utf8'))
const devicePath = process.env.RELAY_DEVICES_FILE
let devices: RegisteredDevice[] = []
if (devicePath) {
  try { devices = JSON.parse(readFileSync(devicePath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
const trialPath = process.env.RELAY_TRIALS_FILE
if (trialPath && !devicePath) throw Error('Set RELAY_DEVICES_FILE to persist trial device credentials')
let trials: Trial[] = []
if (trialPath) {
  try { trials = JSON.parse(readFileSync(trialPath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
const maxTrials = Number(process.env.RELAY_MAX_TRIALS ?? 100)
if (!Number.isInteger(maxTrials) || maxTrials < 0) throw Error('Invalid RELAY_MAX_TRIALS')
const relay = createRelay(pairs, {
  devices, trials, maxTrials,
  saveTrials: trialPath ? next => {
    writeFileSync(`${trialPath}.next`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${trialPath}.next`, trialPath)
  } : undefined,
  saveDevices: next => {
    if (!devicePath) throw Error('Set RELAY_DEVICES_FILE to enable device enrollment')
    writeFileSync(`${devicePath}.next`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${devicePath}.next`, devicePath)
  },
})
const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT')
const host = process.env.HOST ?? '127.0.0.1'
relay.server.listen(port, host, () => console.log(`Routi relay listening on ${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void relay.close() })
}

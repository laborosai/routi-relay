import { readFile } from 'node:fs/promises'
import { createRelay, type Pair } from './relay.js'

const path = process.env.RELAY_PAIRS_FILE
if (!path) throw Error('Set RELAY_PAIRS_FILE to your relay pair configuration')
const pairs: Pair[] = JSON.parse(await readFile(path, 'utf8'))
const relay = createRelay(pairs)
const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT')
relay.server.listen(port, '127.0.0.1', () => console.log(`Routi relay listening on 127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void relay.close() })
}

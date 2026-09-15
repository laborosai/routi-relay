import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPairing } from './pairing.js'

const directory = process.argv[2] ?? 'pair.local'
// Exclusive directory creation avoids partially overwriting an existing pairing.
await mkdir(directory, { mode: 0o700 })
const pairing = await createPairing()
for (const name of ['host', 'viewer', 'relay'] as const) {
  await writeFile(join(directory, `${name}.json`), JSON.stringify(name === 'relay' ? [pairing.relay] : pairing[name], null, 2), { mode: 0o600, flag: 'wx' })
}
console.log(`Created local pairing in ${directory}. Only relay.json belongs on the relay server.`)

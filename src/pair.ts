import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { digest } from './relay.js'

const hostToken = randomBytes(32).toString('base64url')
const viewerToken = randomBytes(32).toString('base64url')
const id = randomUUID()
// Exclusive creation prevents overwriting existing access credentials.
await writeFile('pair.local.json', JSON.stringify({ id, hostToken, viewerToken }, null, 2), { mode: 0o600, flag: 'wx' })
await writeFile('relay.local.json', JSON.stringify([{ id, hostHash: digest(hostToken), viewerHash: digest(viewerToken) }], null, 2), { mode: 0o600, flag: 'wx' })
console.log('Created pair.local.json (client secrets) and relay.local.json (server hashes). Keep client secrets private.')

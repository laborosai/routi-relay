import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { digest } from './relay.js'

export type Device = { token: string; key: string; cert: string; peerCert: string }

/** Local test provisioning. Keys never go to the relay; production pairing belongs in the apps. */
export async function createPairing() {
  const directory = await mkdtemp(join(tmpdir(), 'routi-pair-'))
  try {
    const devices = await Promise.all((['host', 'viewer'] as const).map(async role => {
      const keyPath = join(directory, `${role}.key`)
      const certPath = join(directory, `${role}.crt`)
      await promisify(execFile)('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-nodes', '-sha256', '-days', '30', '-subj', `/CN=routi-${role}`,
        '-addext', `subjectAltName=DNS:routi-${role}`,
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', `extendedKeyUsage=${role === 'host' ? 'serverAuth' : 'clientAuth'}`,
        '-keyout', keyPath, '-out', certPath,
      ])
      return { token: randomBytes(32).toString('base64url'), key: await readFile(keyPath, 'utf8'), cert: await readFile(certPath, 'utf8') }
    }))
    const [host, viewer] = devices
    return {
      relay: { id: randomUUID(), hostHash: digest(host.token), viewerHash: digest(viewer.token) },
      host: { ...host, peerCert: viewer.cert } satisfies Device,
      viewer: { ...viewer, peerCert: host.cert } satisfies Device,
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

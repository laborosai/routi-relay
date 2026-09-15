import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connectViewer, startHost } from './connection.js'
import type { Device } from './pairing.js'

const [url, directory] = process.argv.slice(2)
if (!url || !directory) throw Error('Usage: pnpm test:remote wss://connect.routibot.com pair.local')
const hostDevice: Device = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'))
const viewerDevice: Device = JSON.parse(await readFile(join(directory, 'viewer.json'), 'utf8'))
const host = startHost(url, hostDevice, { onConnection: stream => stream.pipe(stream) })
const timeout = new AbortController()
const timer = setTimeout(() => { timeout.abort(); host.stop() }, 30_000)
try {
  await host.ready
  const viewer = await connectViewer(url, viewerDevice, timeout.signal)
  try {
    const payload = Buffer.alloc(1024 * 1024, 0x52)
    const result = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      viewer.on('data', (data: Buffer) => {
        chunks.push(data); size += data.length
        if (size >= payload.length) resolve(Buffer.concat(chunks))
      })
      viewer.once('error', reject)
      viewer.once('close', () => reject(Error('Connection closed before test completed')))
    })
    const start = performance.now()
    viewer.write(payload)
    assert.deepEqual(await result, payload)
    console.log(`PASS: 1 MiB encrypted round trip in ${Math.round(performance.now() - start)} ms; TLS ${viewer.getProtocol()}.`)
    console.log('Both clients ran locally through the remote relay. This is a connectivity check, not a capacity benchmark.')
  } finally { viewer.destroy() }
} finally { clearTimeout(timer); timeout.abort(); host.stop() }

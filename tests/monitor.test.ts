import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/monitor.sh', import.meta.url))

test('monitor sends a heartbeat only when the relay and disk checks pass', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-'))
  let status = 200, body = 'ok'
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url!)
    res.writeHead(req.url === '/health' ? status : 200).end(body)
  })
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  writeFileSync(join(directory, 'df'), '#!/bin/sh\necho "disk 100 10 90 ${TEST_DISK_USED}% /data"\n', { mode: 0o755 })
  const env = { HOME: directory, PATH: `${directory}${delimiter}${process.env.PATH}`,
    RELAY_HEALTH_URL: `${url}/health`, RELAY_HEARTBEAT_URL: `${url}/ping` }

  for (const scenario of [
    { name: 'healthy', status: 200, body: 'ok', disk: '20', healthy: true },
    { name: 'HTTP failure', status: 503, body: 'down', disk: '20', healthy: false },
    { name: 'wrong response', status: 200, body: 'wrong service', disk: '20', healthy: false },
    { name: 'disk pressure', status: 200, body: 'ok', disk: '90', healthy: false },
  ]) {
    await t.test(scenario.name, async () => {
      requests.length = 0
      status = scenario.status; body = scenario.body
      const check = run('bash', [script], { env: { ...env, TEST_DISK_USED: scenario.disk } })
      if (scenario.healthy) await check
      else await assert.rejects(check, { code: scenario.status === 503 ? 22 : 1 })
      assert.equal(requests.includes('/ping'), scenario.healthy)
    })
  }
})

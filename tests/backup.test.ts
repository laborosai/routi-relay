import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/backup.sh', import.meta.url))

test('backup restores committed WAL data without including pending writes or changing the live database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-backup-'))
  const env = { PATH: process.env.PATH, HOME: directory,
    RESTIC_REPOSITORY: join(directory, 'repo'), RESTIC_PASSWORD: 'test-only',
    RELAY_DATABASE: join(directory, 'relay.db') }
  const source = new DatabaseSync(env.RELAY_DATABASE)
  t.after(() => { source.close(); rmSync(directory, { recursive: true, force: true }) })
  const run = (command: string, ...args: string[]) => execFileSync(command, args, { env, encoding: 'utf8' })

  run('restic', 'init')
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE devices (id TEXT PRIMARY KEY);
    INSERT INTO devices VALUES ('paired-phone');
    BEGIN;
    INSERT INTO devices VALUES ('uncommitted-phone');`)
  assert.ok(existsSync(`${env.RELAY_DATABASE}-wal`))
  run('bash', script)
  run('restic', 'restore', 'latest', '--target', join(directory, 'restore'))
  const restored = new DatabaseSync(join(directory, 'restore/relay.db'), { readOnly: true })
  try {
    assert.deepEqual(restored.prepare('SELECT id FROM devices').all().map(row => row.id), ['paired-phone'])
  } finally { restored.close() }
  assert.equal(source.prepare('SELECT count(*) AS count FROM devices').get()!.count, 2)
  source.exec('ROLLBACK')

  env.RELAY_DATABASE = join(directory, 'missing.db')
  assert.throws(() => run('bash', script), /Relay database not found/)
  assert.equal(existsSync(env.RELAY_DATABASE), false)
})

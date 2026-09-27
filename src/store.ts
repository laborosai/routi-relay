import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Pair, RegisteredDevice, Trial } from './relay.js'
import type { Subscription } from './subscriptions.js'

type Records = { pairs: Pair[]; trials: Trial[]; devices: RegisteredDevice[]; subscriptions: Subscription[] }

/** One local database for one relay process. Live sockets remain in memory. */
export class RelayStore {
  private readonly db: DatabaseSync

  constructor(path: string, initial: () => Records) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'a', 0o600))
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS macs (
          id TEXT PRIMARY KEY NOT NULL,
          hostHash TEXT NOT NULL UNIQUE,
          viewerHash TEXT NOT NULL UNIQUE,
          maxDevices INTEGER,
          trial INTEGER NOT NULL CHECK (trial IN (0, 1)),
          expiresAt INTEGER CHECK (expiresAt IS NULL OR expiresAt > 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS devices (
          hostId TEXT NOT NULL REFERENCES macs(id) DEFERRABLE INITIALLY DEFERRED,
          id TEXT NOT NULL,
          hash TEXT NOT NULL UNIQUE,
          PRIMARY KEY (hostId, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS subscriptions (
          originalTransactionId TEXT PRIMARY KEY NOT NULL,
          macId TEXT NOT NULL REFERENCES macs(id) DEFERRABLE INITIALLY DEFERRED,
          expiresAt INTEGER NOT NULL CHECK (expiresAt >= 0)
        ) STRICT;
      `)
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version
      if (version === 0) {
        const records = initial()
        this.transaction(() => {
          this.insertMacs(records.pairs, false)
          this.insertMacs(records.trials, true)
          this.insertDevices(records.devices)
          this.insertSubscriptions(records.subscriptions)
          this.db.exec('PRAGMA user_version = 1')
        })
      } else if (version !== 1) throw Error('Unsupported relay database version')
    } catch (error) { this.db.close(); throw error }
  }

  load(): Records {
    const macs = this.db.prepare('SELECT * FROM macs').all()
    const pair = (row: typeof macs[number]): Pair => ({
      id: row.id as string, hostHash: row.hostHash as string, viewerHash: row.viewerHash as string,
      ...(row.maxDevices != null ? { maxDevices: row.maxDevices as number } : {}),
    })
    return {
      pairs: macs.filter(row => row.trial === 0).map(pair),
      trials: macs.filter(row => row.trial === 1).map(row => ({ ...pair(row), expiresAt: row.expiresAt as number | null })),
      devices: this.db.prepare('SELECT * FROM devices').all() as RegisteredDevice[],
      subscriptions: this.db.prepare('SELECT * FROM subscriptions').all() as Subscription[],
    }
  }

  saveTrials(records: Trial[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM macs WHERE trial = 1'); this.insertMacs(records, true) })
  }

  saveDevices(records: RegisteredDevice[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM devices'); this.insertDevices(records) })
  }

  saveSubscriptions(records: Subscription[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM subscriptions'); this.insertSubscriptions(records) })
  }

  private insertMacs(records: (Pair | Trial)[], trial: boolean): void {
    const insert = this.db.prepare('INSERT INTO macs VALUES (?, ?, ?, ?, ?, ?)')
    for (const record of records) insert.run(record.id, record.hostHash, record.viewerHash,
      record.maxDevices ?? null, Number(trial), 'expiresAt' in record ? record.expiresAt : null)
  }

  private insertDevices(records: RegisteredDevice[]): void {
    const insert = this.db.prepare('INSERT INTO devices VALUES (?, ?, ?)')
    for (const record of records) insert.run(record.hostId, record.id, record.hash)
  }

  private insertSubscriptions(records: Subscription[]): void {
    const insert = this.db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?)')
    for (const record of records) insert.run(record.originalTransactionId, record.macId, record.expiresAt)
  }

  private transaction(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { write(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  close(): void { this.db.close() }
}

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RegisteredDevice, Trial } from './relay.js'
import type { Subscription } from './subscriptions.js'

type Records = { trials: Trial[]; devices: RegisteredDevice[]; subscriptions: Subscription[] }

/** One local database for one relay process. Live sockets remain in memory. */
export class RelayStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
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
    } catch (error) { this.db.close(); throw error }
  }

  load(): Records {
    return {
      trials: this.db.prepare('SELECT * FROM macs').all() as Trial[],
      devices: this.db.prepare('SELECT * FROM devices').all() as RegisteredDevice[],
      subscriptions: this.db.prepare('SELECT * FROM subscriptions').all() as Subscription[],
    }
  }

  saveTrials(records: Trial[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM macs'); this.insertMacs(records) })
  }

  saveDevices(records: RegisteredDevice[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM devices'); this.insertDevices(records) })
  }

  saveSubscriptions(records: Subscription[]): void {
    this.transaction(() => { this.db.exec('DELETE FROM subscriptions'); this.insertSubscriptions(records) })
  }

  private insertMacs(records: Trial[]): void {
    const insert = this.db.prepare('INSERT INTO macs VALUES (?, ?, ?, ?)')
    for (const record of records) insert.run(record.id, record.hostHash, record.viewerHash,
      record.expiresAt)
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

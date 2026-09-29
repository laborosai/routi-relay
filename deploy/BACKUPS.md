# Database backups

The host runs a daily SQLite online backup, encrypts it with restic, and verifies
a restored copy. Retention: 7 daily and 4 weekly snapshots. A failure can lose
up to about a day of registrations or billing changes between successful backups.
Restic hashes data chunks and uploads only those not already stored; unchanged
database contents are reused across snapshots, with small new snapshot metadata.

Install `sqlite3` and `restic` on the Ubuntu host. Create a private S3 bucket and a
dedicated restic repository. Hetzner Object Storage and other S3-compatible providers
work. Do not add a bucket lifecycle rule that deletes restic objects independently.

Create `/etc/routi-backup.env` (root-owned, mode 600):

```dotenv
RELAY_DATABASE=/var/lib/docker/volumes/routi-connect_relay-data/_data/relay.db
RESTIC_REPOSITORY=s3:https://<s3-endpoint>/<bucket>/relay
AWS_ACCESS_KEY_ID=<access-key>
AWS_SECRET_ACCESS_KEY=<secret-key>
RESTIC_PASSWORD_FILE=/etc/routi-backup.password
```

Confirm the volume path with `docker volume inspect routi-connect_relay-data`.
Store a strong encryption password in the root-owned password file (mode 600).
Keep a recovery copy of the password and S3 credentials outside this server.

From the repository root:

```sh
sudo install -D -m 755 scripts/backup.sh /usr/local/lib/routi-relay/backup.sh
sudo install -m 644 deploy/systemd/routi-backup.* /etc/systemd/system/
sudo bash -c 'set -a; source /etc/routi-backup.env; restic init'
sudo systemctl daemon-reload
sudo systemctl start routi-backup.service
sudo systemctl enable --now routi-backup.timer
```

Inspect runs with `journalctl -u routi-backup.service`. Tests use a local restic
repository, including a database with live WAL transactions: `pnpm test`
(requires `restic` and `sqlite3` on PATH; CI installs both).
Set `BACKUP_HEARTBEAT_URL` in the environment file to a Healthchecks.io ping URL
(period one day, grace one hour) to alert when a backup fails or stops running.

## Restore

Load the same environment and run `restic snapshots`, then
`restic restore <snapshot-id> --target /tmp/routi-restore`. Check the restored file
with `sqlite3 /tmp/routi-restore/relay.db 'PRAGMA integrity_check;'` (must say `ok`).

Stop the backup timer and relay before replacing the volume's database. Preserve
the old database and its `-wal`/`-shm` files together elsewhere, install the restored
`relay.db` with the original ownership, then restart the relay and timer. Test a
paired phone's chat and desktop connection. Restoring an older snapshot also
restores its older trial, subscription and revocation state; reconcile changes
made since that snapshot before reopening public access.

The database backup does not include deployment secrets or Caddy certificates.

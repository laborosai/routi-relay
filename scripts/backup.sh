#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${RELAY_DATABASE:?Set RELAY_DATABASE to the existing relay.db path}"
[[ -f "$RELAY_DATABASE" ]] || { echo 'Relay database not found' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# SQLite includes committed WAL transactions while the relay keeps running.
sqlite3 -readonly "$RELAY_DATABASE" ".timeout 10000" ".backup '$work/relay.db'"
[[ $(sqlite3 "$work/relay.db" 'PRAGMA integrity_check;') == ok ]]

# A dedicated repository keeps retention independent from other services.
restic backup --host routi-relay --tag relay-db --stdin --stdin-filename relay.db < "$work/relay.db"
restic restore latest --host routi-relay --tag relay-db --target "$work/restored"
cmp "$work/relay.db" "$work/restored/relay.db"
restic forget --host routi-relay --tag relay-db --keep-hourly 24 --keep-daily 7 --keep-weekly 4 --prune
if [[ -n ${BACKUP_HEARTBEAT_URL:-} ]]; then
    curl --fail --silent --show-error --max-time 15 --retry 2 --output /dev/null "$BACKUP_HEARTBEAT_URL"
fi

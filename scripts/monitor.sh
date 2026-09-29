#!/usr/bin/env bash
set -euo pipefail

: "${RELAY_HEALTH_URL:?Set RELAY_HEALTH_URL to the public HTTPS /health endpoint}"
: "${RELAY_HEARTBEAT_URL:?Set RELAY_HEARTBEAT_URL to the monitoring ping URL}"

response=$(curl --fail --silent --show-error --max-time 15 "$RELAY_HEALTH_URL")
[[ "$response" == ok ]] || { echo 'Unexpected relay health response' >&2; exit 1; }
used=$(df -P "${RELAY_DATA_DIRECTORY:-/var/lib/docker}" | awk 'END {gsub(/%/, "", $5); print $5}')
[[ "$used" =~ ^[0-9]+$ ]] || { echo 'Cannot read disk usage' >&2; exit 1; }
(( used < 90 )) || { echo "Relay data disk is ${used}% full" >&2; exit 1; }

# Missing heartbeats also detect a stopped timer or an unreachable/dead host.
curl --fail --silent --show-error --max-time 15 --retry 2 --output /dev/null "$RELAY_HEARTBEAT_URL"

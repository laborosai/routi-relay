# Relay monitoring

Create a Healthchecks.io check with a one-minute period, two-minute grace and your
alert destination. The host sends a heartbeat only after the public `/health`
endpoint returns `ok` and the data disk is below 90% usage. Missing heartbeats
alert on outages, a stopped monitor, or disk pressure. No user data is sent.

Create `/etc/routi-monitor.env` (root-owned, mode 600):

```dotenv
RELAY_HEALTH_URL=https://<relay-domain>/health
RELAY_HEARTBEAT_URL=https://hc-ping.com/<check-id>
RELAY_DATA_DIRECTORY=/var/lib/docker
```

From the repository root on the Ubuntu host:

```sh
sudo install -D -m 755 scripts/monitor.sh /usr/local/lib/routi-relay/monitor.sh
sudo install -m 644 deploy/systemd/routi-monitor.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start routi-monitor.service
sudo systemctl enable --now routi-monitor.timer
```

Inspect failures with `journalctl -u routi-monitor.service`. Test alert delivery
by stopping the timer for more than three minutes, then restarting it and checking
the recovery notification. Monitor backups with their own daily heartbeat.

This checks availability, not end-to-end chat or VNC. Inspect resource use with
`docker stats --no-stream` and the VPS provider's CPU, network and transfer graphs.
Tests: `python3 tests/monitor.py` (local HTTP only; no monitoring account needed).

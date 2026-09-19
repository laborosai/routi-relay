# Private hosted pilot

Use a small Ubuntu 24.04 VPS (x86-64 or ARM64) with Docker Engine and the Compose plugin. Device routes accept provisioned bearer credentials from Wi-Fi or cellular. This is not public customer onboarding.

1. Point `connect.routibot.com` directly to the VPS with a DNS A record (and AAAA only if IPv6 works). Keep proxy/CDN mode off so the diagnostic IP allowlist sees the real clients.
2. Restrict SSH in the provider firewall to your administrative IP. Allow TCP 80 and 443 for HTTPS and certificate issuance. Do not expose 8787. Use the provider firewall rather than relying solely on UFW with Docker-published ports.
3. Generate a pair on your Mac with `pnpm pair pilot.local`. Upload only `pilot.local/relay.json`, never host.json or viewer.json. Install it on the server at `/opt/routi-connect/config/relay.json`, mode 0644 inside a root-owned mode 0700 config directory. The hashes must be readable by the non-root container process.
4. Copy the source (or a Git archive) into `/opt/routi-connect/app`. Avoid copying generated pairing directories, node_modules or .git.
5. On the server, create `deploy/.env` from the values below and start Compose.

```dotenv
RELAY_DOMAIN=connect.routibot.com
RELAY_PAIRS_FILE=/opt/routi-connect/config/relay.json
TEST_CLIENT_IPS="YOUR_PUBLIC_IPV4/32 YOUR_PUBLIC_IPV6/128"
```

Replace the IP placeholders with the actual public addresses of the test clients. Omit IPv6 if unused. Caddy applies this list to diagnostic routes. `/v1/host`, `/v1/sessions/*`, and `/v1/devices` accept any source IP but require valid provisioned credentials at the relay. Device management requires the host credential. Certificate issuance is managed by Caddy. Certificates persist in Docker volumes; access logs are not enabled.

```sh
cd /opt/routi-connect/app/deploy
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

From the Mac, run:

```sh
pnpm test:remote wss://connect.routibot.com pilot.local
```

This connects both simulated peers from the Mac through the hosted relay and checks a 1 MiB encrypted round trip. It is not an iPhone app test or a throughput benchmark. The test times out after 30 seconds and closes its connections. Test again after restarting the relay; verify invalid credentials are rejected on device routes and non-allowlisted addresses cannot read diagnostics.

The service runs as a non-root user with a read-only filesystem, 256 MiB memory limit, no capabilities, bounded logs and no exposed backend port. These contain pilot resource usage but are not account billing quotas. The paired TLS connector chunks large writes into bounded WebSocket messages and preserves byte ordering.

To stop: `docker compose down` (keep volumes for certificates). To revoke: remove the pair from relay.json and recreate the relay container. The Routi Core integration supports phone pairing and immediate chat revocation; certificate renewal and public enrollment remain separate work.

Device registrations persist in the `relay-data` volume (`RELAY_DEVICES_FILE`),
separately from the read-only host provisioning file. Each record stores a host ID,
device ID, and credential hash. Back up this volume alongside the provisioning
configuration; device private keys never belong on the relay.

Set `maxDevices` on each entry in `relay.json` to its allowed device count (default
five, supported range 1–50), then recreate the relay. The API rejects registrations
above that allowance. This is an operator-set pilot entitlement, not subscription
billing. Removing a device closes its sessions without disconnecting other devices.
The original viewer token remains a bootstrap credential for the QR claim exchange.
Session concurrency remains bounded independently of the device allowance.

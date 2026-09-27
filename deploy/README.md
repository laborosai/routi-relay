# Private hosted pilot

Use a small Ubuntu 24.04 VPS (x86-64 or ARM64) with Docker Engine and the Compose plugin. Device routes accept provisioned bearer credentials from Wi-Fi or cellular. This is not public customer onboarding.

1. Point `connect.routibot.com` directly to the VPS with a DNS A record (and AAAA only if IPv6 works). Keep proxy/CDN mode off so the diagnostic IP allowlist sees the real clients.
2. Restrict SSH in the provider firewall to your administrative IP. Allow TCP 80 and 443 for HTTPS and certificate issuance. Do not expose 8787. Use the provider firewall rather than relying solely on UFW with Docker-published ports.
3. Copy the source (or a Git archive) into `/opt/routi-connect/app`. Avoid copying generated pairing directories, node_modules or .git.
4. On the server, create `deploy/.env` from the values below and start Compose.

```dotenv
RELAY_DOMAIN=connect.routibot.com
RELAY_MAX_TRIALS=10
TEST_CLIENT_IPS="YOUR_PUBLIC_IPV4/32 YOUR_PUBLIC_IPV6/128"
```

Replace the IP placeholders with the actual public addresses of the test clients. Omit IPv6 if unused. Caddy applies this list to diagnostic routes. `/v1/host`, `/v1/sessions/*`, and `/v1/devices` accept any source IP but require valid provisioned credentials at the relay. Device management requires the host credential. Certificate issuance is managed by Caddy. Certificates persist in Docker volumes; access logs are not enabled.

```sh
cd /opt/routi-connect/app/deploy
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

In Routi on the Mac, connect to this relay and pair an iPhone or iPad with its QR
code. Test remote chat and desktop viewing, then restart the relay and reconnect.

The service runs as a non-root user with a read-only filesystem, 256 MiB memory limit, no capabilities, bounded logs and no exposed backend port. These contain pilot resource usage but are not account billing quotas. The paired TLS connector chunks large writes into bounded WebSocket messages and preserves byte ordering.

To stop: `docker compose down` (keep volumes for certificates and the relay database). Revoke phones from Routi’s Mac settings. The Routi Core integration supports phone pairing and immediate chat revocation; certificate renewal and public enrollment remain separate work.

Macs, device registrations, trial deadlines, and subscriptions persist in SQLite
at `/app/data/relay.db` in `relay-data`. New installations start empty; Macs register
through `/v1/trial`. See [storage and backup instructions](../docs/ENGINEERING.md#storage).

New trials are disabled until `RELAY_MAX_TRIALS` is set above zero. Device counts
are unlimited by default.

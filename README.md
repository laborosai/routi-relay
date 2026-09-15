# Routi Relay

Local transport prototype for reaching a Routi Mac from a paired phone. Node/TypeScript forwards WebSocket messages; browsers and agents continue running on the Mac.

This project is separate from the Routi app. It currently tests transport with synthetic data: no app integration, public registration, billing, or notifications. Do not expose this prototype publicly or send personal data through it yet. TLS and end-to-end device authentication/encryption are still required for the hosted service.

## Run locally

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test
pnpm build
pnpm pair
RELAY_PAIRS_FILE=relay.local.json pnpm start
```

The relay listens on `127.0.0.1:8787`. `GET /health` returns `ok`.

`pair.local.json` contains separate host and viewer credentials. `relay.local.json` contains their SHA-256 hashes. Both files are created with owner-only permissions and ignored by Git. Do not upload the client secrets to a relay host. To revoke a prototype pair, remove its server entry and restart the relay; this closes existing sessions too.

## Transport

Both peers open an outbound WebSocket to `/v1/sessions/<session-id>`, with their own credential in `Authorization: Bearer <token>`. The pair is derived from the credential, not a user-supplied account ID. Each session permits one host and one viewer. Both wait for `{"type":"ready"}` before sending application data. After that, text/binary messages retain their boundaries and order.

The initial host connector will need to establish a session when the phone requests it. This prototype coordinates session IDs in the test; it does not yet implement a persistent host control connection. Chat and each desktop viewer will use separate sessions. No arbitrary destination URLs or TCP forwarding are accepted.

Defaults: 100 sessions globally, 4 per pair, 1 MiB per message, 2 MiB outgoing WebSocket buffer per peer, 10 seconds to join, and 30-second heartbeat checks. Stalled sessions close instead of dropping VNC bytes. These are test limits, not subscription allowances. A force quit closes the peer connection and releases the session; heartbeat handles silent network loss. Closing a viewer must never stop its bot.

## Implementation sequence

1. Transport foundation (here): isolation, credentials, bounded forwarding, disconnect tests.
2. Routi integration: persistent outbound Mac connection, device pairing/revocation, end-to-end authenticated encryption, and chat/desktop routing. Bundle viewer assets locally or route their HTTP requests explicitly.
3. Hosted pilot: HTTPS, authentication attempt limits, per-account bandwidth quotas, load/slow-client tests, deployment and monitoring. Test on a small VPS near the users; size from measurements before considering dedicated hardware.
4. Push notifications using the paired device registry, followed by subscription/trial enforcement.

A VPS is enough to begin testing; no dedicated machine is required. The first deployment will be one instance, so restarting it disconnects viewers. Clients must reconnect without automatically replaying commands. Measure concurrent streams, outgoing bytes, CPU, and peak memory before committing to capacity or pricing.

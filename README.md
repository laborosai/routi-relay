# Routi Connect relay

A local prototype for connecting a paired viewer to a Routi Mac through an outbound connection. The relay forwards data; agents and browsers stay on the Mac. Intended hosted address: `connect.routibot.com`. Clients also accept a custom relay origin for self-hosting.

The connector now uses mutual TLS 1.3 inside the WebSocket tunnel. Each device trusts only its paired peer's certificate. The relay receives credential hashes and encrypted traffic, not device private keys. It can see connection timing and traffic volume. Public deployment still needs HTTPS, abuse controls, bandwidth quotas, and app integration.

## Try it locally

Requires Node 22+, pnpm 10, and OpenSSL 3 for generating local test certificates.

```sh
pnpm install
pnpm test
pnpm demo
```

The demo creates temporary credentials, starts a loopback relay and a simulated Mac connector, exchanges a synthetic message from a simulated viewer, then revokes the pair. It cleans up after itself. No Routi bots or accounts are accessed.

To run the standalone relay:

```sh
pnpm pair
pnpm build
RELAY_PAIRS_FILE=pair.local/relay.json pnpm start
```

It listens on `127.0.0.1:8787`; `GET /health` returns `ok`. The pair command refuses to overwrite an existing directory. It writes owner-only files:

- `host.json`: host credential, private key, certificate, trusted viewer certificate.
- `viewer.json`: viewer credential, private key, certificate, trusted host certificate.
- `relay.json`: pair ID and credential hashes. This is the only file that belongs on the relay server.

Local certificates expire after 30 days. This provisioning command creates both identities on one machine for development. It is not the final device enrollment flow: the Apple apps must generate/store their own keys, exchange identities with explicit user approval, and support renewal and revocation. Never upload the host/viewer files to a relay. Generated `pair.local/` is ignored by Git.

## Connection flow

1. `startHost()` opens an outbound `/v1/host` control WebSocket and waits for viewers.
2. `connectViewer()` opens `/v1/sessions/<random-id>`. Authentication derives the pair from its bearer credential.
3. The relay announces the session to that pair's host. The host opens a second outbound connection for it.
4. Both receive `{"type":"ready"}`, then perform mutual TLS authentication through the relay. The connector exposes a decrypted byte stream only at the endpoints.

The host requires the paired viewer certificate before delivering the stream to the application. The viewer verifies the host certificate and `routi-host` TLS identity. Standard Node/OpenSSL TLS handles encryption, integrity and session keys. There is no custom cryptographic protocol. Outer `wss://` is required except on literal loopback addresses for local tests. The host retries network disconnects with bounded exponential delay; rejected credentials stop retries. Application commands are never automatically replayed.

`revokePair(id)` invalidates credentials and closes active sessions in memory. Persistent revocation currently requires removing the pair from the server configuration and restarting. The Mac must also revoke the trusted viewer identity during app integration so a compromised relay cannot restore access by itself.

Limits: 100 sessions globally, 4 per pair, 1 MiB per WebSocket message, 2 MiB outgoing WebSocket buffer per peer, 10 seconds to join, and 30-second heartbeat checks. Over-budget sessions close instead of dropping bytes. Client TLS handshakes also time out. These are prototype limits, not subscription allowances or a measured capacity claim.

## Next milestones

1. Apple app enrollment: local key generation, QR pairing/approval, Keychain storage, durable device revocation.
2. Adapt Routi chat and desktop viewing to the encrypted stream. Route requests only after device authentication. Desktop assets need a local bundle or explicit HTTP routing.
3. Private hosted pilot: HTTPS, authentication rate limits, per-account traffic quotas, deployment and monitoring. Load-test normal and slow clients on a small VPS near users.
4. Push notifications using the device registry, then subscription/trial enforcement.

No iPhone/Mac app integration, public enrollment, billing or notifications are included yet. The tests exercise the real relay and TLS with simulated Node clients. A relay restart disconnects active viewers; closing a viewer must not stop the bot.

## License

Copyright 2026 Laboros AI, Inc. Licensed under the [Apache License, Version 2.0](LICENSE).

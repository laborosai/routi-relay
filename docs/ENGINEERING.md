# Engineering

## Local provisioning

To run the standalone relay:

```sh
pnpm pair
pnpm build
RELAY_DB_FILE=relay.db RELAY_PAIRS_FILE=pair.local/relay.json pnpm start
```

It listens on `127.0.0.1:8787`; `GET /health` returns `ok`. The pair command refuses to overwrite an existing directory. It writes owner-only files:

- `host.json`: host credential, private key, certificate, trusted viewer certificate.
- `viewer.json`: viewer credential, private key, certificate, trusted host certificate.
- `relay.json`: pair ID and credential hashes. This is the only file that belongs on the relay server.

Certificates expire after one year. This command creates development identities. In the app, the Mac generates per-phone credentials and delivers them through pinned TLS after QR approval; the phone stores them in Keychain. Never upload host/viewer files to the relay. Generated `pair.local/` is ignored by Git.

## Storage

Requires Node 22.13+ for built-in SQLite. `RELAY_DB_FILE` defaults to `relay.db`;
Docker uses `/app/data/relay.db` in the persistent `relay-data` volume. The tables
hold Macs/trial deadlines, paired-device hashes, and subscriptions. Live sockets
stay in memory; chat and desktop traffic are never stored here. Run one relay
process per database.

An empty database imports `RELAY_PAIRS_FILE`, `RELAY_TRIALS_FILE`,
`RELAY_DEVICES_FILE`, and `RELAY_SUBSCRIPTIONS_FILE` once, in one transaction.
Existing deployments must retain those paths on their first SQLite startup.
Subsequent starts ignore the JSON files; keep them for rollback until verified.
Rollbacks after new pairings or purchases require exporting the updated records.
Stop the relay before copying its database/volume for backup, or use SQLite's online
backup tool. Do not copy only the main database file while WAL writes are active.

## Connection flow

1. `startHost()` opens an outbound `/v1/host` control WebSocket and waits for viewers.
2. `connectViewer()` opens `/v1/sessions/<random-id>`. Authentication derives the pair from its bearer credential.
3. The relay announces the session to that pair's host. The host opens a second outbound connection for it.
4. Both receive `{"type":"ready"}`, then perform mutual TLS authentication through the relay. The connector exposes a decrypted byte stream only at the endpoints.

The host requires the paired viewer certificate before delivering the stream to the application. The viewer verifies the host certificate and `routi-host` TLS identity. Standard Node/OpenSSL TLS handles encryption, integrity and session keys. There is no custom cryptographic protocol. Outer `wss://` is required except on literal loopback addresses for local tests. The host retries network disconnects with bounded exponential delay; rejected credentials stop retries. Application commands are never automatically replayed.

`revokePair(id)` invalidates credentials and closes active sessions in memory. Persistent whole-Mac revocation requires removing its device, subscription and Mac rows from SQLite while the relay is stopped. The Mac must also revoke the trusted viewer identity during app integration so a compromised relay cannot restore access by itself.

Limits: 100 sessions globally, 1 MiB per WebSocket message, 2 MiB outgoing WebSocket buffer per peer, 10 seconds to join, and 30-second heartbeat checks. Over-budget sessions close instead of dropping bytes. Client TLS handshakes also time out. These are prototype limits, not subscription allowances or a measured capacity claim.

## Three-day Connect trials

Set `RELAY_MAX_TRIALS` to the total number of enrollments to allow (default zero).
Caddy restricts `/v1/trial` to `TEST_CLIENT_IPS`.

The Mac creates its keys locally and registers credential hashes. The first viewer
connection starts a 72-hour deadline, shared by all paired devices. Restarting or
re-pairing does not extend it. Expiration blocks chat and desktop streams; the control connection and pairing
remain available so a replacement device can restore purchases. Bots keep running. `/v1/access` returns access status to an
authenticated device. Existing manually provisioned pairs remain unrestricted.

Trial enrollment is a bounded pilot, not proof of a unique person. Someone
creating new credentials can request another enrollment. Keep enrollment restricted
until public abuse controls and bandwidth limits are in place. Certificates still
need automatic renewal before expiry.

New enrollment is limited to three Macs per IP per hour; existing enrollment retries
do not count. This counter resets on relay restart; the persistent total enrollment
cap remains. With Caddy as the single edge proxy, `RELAY_TRUST_PROXY=1` uses its
`X-Forwarded-For` header. Keep the relay port private when enabling this option.

## Apple subscriptions

Use Apple StoreKit and the App Store Server API directly. A one-Mac subscription
is bound to the authenticated pairing, not to a name or email. Restore preserves
that assignment. Additional Mac plans and transfers are not implemented yet.

Create the monthly `com.routibot.connect.monthly` subscription in App Store Connect
and configure Notifications V2 at `https://<relay>/v1/apple-notifications`.
Keep the In-App Purchase API key and configuration outside the repository:

```json
{
  "bundleId": "your.app.bundle",
  "appAppleId": 123456789,
  "productId": "com.routibot.connect.monthly",
  "sandbox": true,
  "issuerId": "your-issuer-id",
  "keyId": "your-key-id",
  "keyFile": "/run/apple/key.p8",
  "rootFiles": ["/run/apple/AppleRootCA-G3.cer"]
}
```

Download the root certificate from [Apple PKI](https://www.apple.com/certificateauthority/).
Set `RELAY_APPLE_CONFIG` to this file. Docker deployments can add
`deploy/compose.billing.yml`, with
`RELAY_APPLE_DIRECTORY` containing `config.json`, the key, and root certificates.
Use a separate sandbox deployment for TestFlight; production must set `sandbox`
to false. Never accept sandbox or Xcode-signed purchases on the paid production relay.

Signed purchases and notifications are checked with Apple's server library.
The API supplies current subscription status, including billing grace periods;
replaying an old purchase cannot undo a refund. Notifications and five-minute
reconciliation update access. Cancellation retains access until the paid period
ends. App Store outages retain the last verified deadline, without extending it.

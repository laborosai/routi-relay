# Routi Connect relay

Connect a paired phone or tablet to Routi Core on your Mac. Agents and browsers
stay on the Mac; the relay forwards end-to-end encrypted traffic without access
to message contents or device private keys. It can see connection timing and
traffic volume. You can also host your own relay.

## Try it locally

Requires Node 22+, pnpm 10, and OpenSSL 3.

```sh
pnpm install
pnpm test
pnpm demo
```

The demo exchanges a synthetic message between simulated devices through a local
relay, then cleans up. It does not access your bots or accounts.

## Documentation

- [Engineering](docs/ENGINEERING.md): provisioning, connection flow, trials, and Apple subscriptions.
- [Deployment](deploy/README.md): running a private hosted pilot.

## License

Copyright 2026 Laboros AI, Inc. Licensed under the [Apache License, Version 2.0](LICENSE).

# Shellbell Cloudflare relay

<picture><source media="(prefers-color-scheme: dark)" srcset="../../brand/svg/mark-on-dark.svg"><img src="../../brand/svg/mark-on-light.svg" alt="" width="18" height="18"></picture> [Self hosting](../../docs/self-hosting.md#deploy-to-your-cloudflare-account) · [Adapter contracts](../../docs/relay-adapters.md)

This package hosts the shared relay core in Cloudflare Workers. A fingerprint
selects one SQLite backed Durable Object per computer. Its adapters own hibernating
WebSockets, storage and alarms; the core owns authentication, routing, revocation
and notification policy. Terminal content and SDP/ICE signaling remain ciphertext.

Use `wrangler.jsonc` for your own account. `wrangler.hosted.jsonc` binds the project's
hosted domain and is not a self hosting template. Follow the account, secrets,
device setup and upgrade instructions in the [deployment guide](../../docs/self-hosting.md).

From the repository root:

```sh
pnpm -F @shellbell/relay test
pnpm -F @shellbell/relay typecheck
pnpm -F @shellbell/relay exec wrangler deploy --config wrangler.jsonc --dry-run
```

A dry run bundles and checks code; it does not deploy or qualify device delivery.
`GET /` identifies the relay and its version. `/healthz` is HTTP liveness. The Worker
has no standalone `/readyz`; that endpoint belongs to the Node runtime.

For a host without Cloudflare, use the [standalone relay](../relay-node/README.md).
The two adapters share a [release version](../../docs/versioning.md), protocol and
repository contracts; their database and task lifetime rules remain different.

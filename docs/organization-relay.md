# Organization relay operations

An organization can own the relay hostname, hosting account, stored metadata and
notification configuration. Terminal content stays encrypted between paired devices.
Self hosting moves relay operations to your organization; it does not remove trust
in device software, administrators or Apple and Google for background push.

Start with the [self hosting guide](self-hosting.md). Use the supplied Cloudflare
or standalone Node runtime, or qualify a new adapter using [relay contracts](relay-adapters.md).

## Deployment decisions

| Decision | What to choose and record |
| --- | --- |
| Hostname | An organization owned WSS origin reachable by computers and phones |
| Runtime | Cloudflare per computer objects, or one Node process with private durable SQLite |
| Administration | Owners of deployment credentials, secrets, backups, incidents and upgrades |
| Ingress | TLS, WebSocket upgrades, connection limits and abuse protection on every hostname |
| Storage | Access, retention, encrypted backups, restore testing and an upgrade/rollback procedure |
| Device software | Supported builds, platforms, pairing and revocation procedures |
| Notifications | Matching app identity and FCM/APNs credentials, or terminal access without push |
| Network policy | Reachability of the relay, native push providers and the configured STUN service |

The relay authenticates Shellbell device identities. It does not provide organization
SSO, administrator accounts, centralized device enrollment, user quotas or read only
terminal roles. Pairing is approved at the computer and grants control over sessions
that its OS user exposes. Those missing controls need a product/security design;
placing a browser login challenge in front of `/ws` will break native clients.

Current owner WebRTC builds use Cloudflare STUN and no TURN. STUN sees address
discovery requests, not terminal content. A custom STUN configuration currently
requires a native adapter change and rebuilt clients; it is not a relay setting.
Restrictive networks may keep terminal traffic on the encrypted WebSocket path.

## Rollout

1. Deploy an isolated test relay with your own hostname and storage. Check liveness,
   readiness where available, TLS and WebSocket upgrades from the intended networks.
2. Install compatible test builds. Set the computer's relay in the Mac settings or
   `shellbell config set relay wss://relay.example.com`, then restart that service.
3. Pair a test phone using the resulting QR. Existing phone records also expose a
   relay setting. Both endpoints must agree; an empty replacement relay may require
   pairing again because there is no automatic state migration.
4. Verify session discovery, input/output, reconnect, revocation and notification
   behavior. Use disposable terminal fixtures, not employees' real sessions.
5. Record the version matrix and artifact hashes, validate backups and rollback,
   then expand deliberately. See [versions and releases](versioning.md).

Use the same computer identity and state directory when changing deployment settings.
Do not delete `.shellbell` identities to resolve a connection problem. When retiring
a device or relay enrollment, complete unpairing and retire its notification state;
already accepted provider pushes cannot be recalled.

## Operations

Monitor active sockets, failed upgrades/authentication, frame/byte rates, fallback
traffic, queue rejection, storage health, deadline lag and push outcomes. Use aggregate
metrics and sanitized diagnostics. Do not add terminal text, pairing secrets, native
tokens or encrypted signaling contents to access logs or dashboards.

Review [capacity planning](architecture/relay-capacity.md) before sizing. Direct WebRTC
reduces terminal traffic when it commits successfully, but both device WebSockets
remain and the relay still handles coordination, metadata and push. Measure direct
traffic share and fallback bursts on your networks.

For Node, stop the sole owner and verify exit before offline backup. Restore to a
fresh private directory; never run two restored copies as active owners or copy a
live SQLite main file. For Cloudflare, preserve Worker/object identities and migration
history. A code rollback does not undo storage migrations or device protocol floors.

## Data and security

[PRIVACY.md](../PRIVACY.md) owns the inventory. The relay sees device relationships,
names, connection timing, tokens and notification routing metadata; private notification
context is ciphertext. Set access and backup retention according to your organization.
The relay is not a terminal archive and cannot serve terminals from an offline computer.

Self hosting can reduce exposure to a third party relay operator. It is not evidence
of an independent security audit, regulatory certification or protection from a
compromised paired phone or computer account. Assess those requirements separately.

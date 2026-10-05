# Relay portability

The shared core, Cloudflare adapter and standalone Node adapter are implemented.
Local conformance, storage/recovery, ownership, queue and backup/restore tests pass.
The non-root container has local correctness evidence on native arm64 and emulated
amd64. This does not qualify production storage, public ingress, device delivery
or VPS sizing. See [self-hosting](../self-hosting.md) and the
[Node runtime guide](../../apps/relay-node/README.md).

## Implemented boundaries

The Node composition root (`apps/relay-node/src/server.ts`) owns HTTP admission,
computer coordinators and resource teardown. `runtime-lifecycle.ts` owns readiness,
storage recovery, tracked task lifetimes and provider cancellation across shutdown.
Its private `connection.ts` binds accepted WebSocket events, frame limits, heartbeat
replies and inbound credit lifetimes. Closing a socket does not refund credit held
by unfinished work. Core transition settlement explicitly drains retired generations
before recalculating deadlines; deadline scheduling itself does not process presence
or pairing cleanup.

Core notification policy validates legacy budget usage and attempt timestamps through
`legacyBudgetUsage`. Shared notification codecs own identical phase names, job field
bindings and JSON decoding. Each SQL adapter retains its scoped reads, cleanup,
reservation writes, complete synchronous transaction and explicit legacy-data handling.
Validation must finish before expiry cleanup; corrupt expired usage is not silently
erased.

`packages/protocol` remains the wire and crypto authority. `packages/relay-core`
owns authentication, pairing, revocation, routing, frame/rate admission and
notification policy. Its production export is only `.`; test support is
repository-only. Core source imports neither runtime built-ins nor SQL drivers,
Workers ambient types or application modules. The boundary guard resolves local
core/protocol imports and approved browser packages, and restricts both runtime
composition roots. It is an architectural guard, not a dependency supply-chain
audit or sandbox.

| Contract | Cloudflare adapter | Node adapter |
| --- | --- | --- |
| Computer ownership | Existing fingerprint-selected `ComputerDO` | One in-process coordinator per fingerprint; one exclusively owned local volume |
| Transport | Hibernating sockets, validated legacy/version-1 attachments, platform ping/pong | Standard WebSockets, fresh connection IDs, heartbeat, write-callback accounting |
| Atomic repositories | Object-scoped SQLite, `transactionSync`, existing schema and rows | Computer-scoped SQLite, synchronous transactions, independent schema version 5 |
| Scheduling | Earliest Durable Object alarm; full awaited event lifetime | Persisted deadlines, startup enumeration, one timer with a coalesced tracked delivery task |
| Provider | Shared bounded FCM/APNs request/auth adapters; Worker fetch with platform-managed connection reuse | The same adapters; runtime-owned APNs HTTP/2 sessions; optional `startRelay(config, { provider })` override |
| Operational events | Sanitized event categories to platform diagnostics | Sanitized diagnostics; readiness requires storage and local maintenance health, with degraded-only recovery retries |

Public ports describe capabilities: `RelayTransport`, `IdentityStore`,
`NotificationStore`, `NotificationService`, `WakeupScheduler` and
`RuntimeServices`. Repositories own complete atomic domain operations rather
than independent CRUD statements or a generic SQL executor. Provider I/O stays
outside transactions and per-computer transition ownership. A claim is reserved
atomically, rechecked after scheduling, dispatched, then completed only if
registration generation, claim and expiry still match. This bounds duplicate
attempts after lost results; it cannot recall provider-accepted pushes or promise
exactly-once delivery. See [recovery findings](relay-storage.md).

Cloudflare's Worker export, class/binding/namespace identities, migration tag,
runtime date, domain and persisted schemas are unchanged by extraction.
Reconstruction tests retain legacy rows and authenticated sockets, including
leases, routing and revocation. Preserve these identities and inspect deployment
configuration before any upgrade; no destructive migration or automatic transfer
to Node is supplied.

Node uses **22.23.1** and its experimental native `node:sqlite` API, with a pinned
official multi-architecture container image. Upgrade Node, image or SQLite API
deliberately and repeat source, restart, backup/restore and target-host checks.
Its additive v1-to-v2 migration retains existing rows and adds durable deadlines;
unknown schema versions are refused. Backups restore to a new private directory,
never over live data. Stop and verify the old owner has exited before backup or
upgrade. The [operator procedure](../self-hosting.md#stop-backup-restore-start)
covers readiness, rollback and same-volume archive limitations.

## Queues and lifecycle

Concurrent FCM sends share an OAuth refresh for the same credential snapshot.
Each notification still has its own send. Both providers share bounded response
reading with a five-second deadline across request and body consumption; HTTP
status, JSON parsing and retry guidance remain provider-specific.

The Node runtime owns one APNs HTTP/2 transport per immutable provider
configuration. Sandbox and production use separate verified connections, with
at most one live session per environment. Each session admits at most 100
requests, or the peer's lower advertised stream limit. Excess requests enter
the existing bounded retry policy without an internal waiting queue. Sessions
retire after five idle minutes. Cancellation or a failed stream closes that
stream without closing healthy siblings. Connection failure or GOAWAY retires
the session and fails its requests; the transport does not replay ambiguous
sends. Restart to reload credentials and replace the transport.

Shutdown fences durable notification completion before closing owned APNs
sessions, and a closed transport rejects later sends. Workers manages outbound
connection reuse; its adapter has no equivalent session pool. Durable Object
hibernation can reset in-memory authentication caches. Authenticated Worker APNs
delivery still needs separate qualification.

The shared core admits at most 128 simultaneous saved connections per computer,
including unauthenticated sockets; excess admissions close with 1013 before a
challenge is issued. Per-computer limits do not replace edge flood protection.
Single-session lookup returns a detached record without copying the full list.
Cloudflare write failures retire the application session and notify the core before
a delayed platform close callback.

Outbound application budgets are 2 MiB per connection and 64 MiB per Node
process or Cloudflare object instance. Inbound budgets are separate, count frame
bytes plus 256 bytes, and cap pending handlers at 256 per Node connection / 128
per Workers connection. Slow readers close 1013 without replaying old input or
screens on reconnect. Platform/kernel buffers and total RSS are outside these
reservations. Workers ends outbound accounting at platform `send`; Node retains
credits through write callbacks. Neither has a durable terminal queue.

Node shutdown stops admissions/timers, drains to its deadline, fences late
provider results, settles local scheduling and closes SQLite before releasing
ownership. An already-started external operation can outlive an embedding's
shutdown. Cloudflare deliberately awaits the complete alarm/event lifetime:
a held provider can keep its alarm pending. Node can run security/retention
maintenance while delivery is held. Do not detach Cloudflare work to imitate
Node without a platform lifetime design.

## Conformance and unsupported combinations

Both actual runtimes replay the same
[versioned transcripts and protocol vectors](../../packages/relay-core/test-support/README.md),
including byte-preserving noncanonical CBOR forwarding and expected closes. Shared
repository recovery contracts also run against both real SQLite implementations.
Local checks do not qualify production hibernation timing, WAN latency, push display
or physical-device input/output.

TypeScript hosts can reuse the core by implementing its ports. Other languages
can replay language-neutral fixtures but must independently satisfy atomic storage,
ownership and recovery contracts. No second-language implementation is supplied.
Wire compatibility alone is not storage certification.

Unsupported: multiple Node writers, replicas sharing SQLite, network filesystems,
Redis/Postgres adapters, automatic live-data transfer, relay-hosted WebRTC/TURN,
offline terminal replay and transcript storage. Endpoint direct transport is
separate and described in [its guide](direct-transport.md).

TLS/WSS, proxy upgrades, abuse controls, secrets, monitoring and durable-volume
restore qualification belong to the operator. FCM/APNs remain dependencies for
background push. Endpoint changes require explicit configuration and pairing
transition. Use [capacity planning](relay-capacity.md) for isolated workloads and
target-host measurements, not guaranteed user counts.

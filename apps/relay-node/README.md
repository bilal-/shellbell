# Standalone relay

Operator procedures: [self-hosting](../../docs/self-hosting.md),
[local measured workloads](../../docs/architecture/relay-capacity.md), and
[storage and recovery](../../docs/architecture/relay-storage.md).

This private workspace package runs the portable relay core with Node WebSockets,
transactional SQLite, and durable scheduling. It is a single-process server. Local
container, backup and synthetic workload checks are described below; public ingress,
production storage, capacity and device delivery still need operator qualification.

Build and run from the repository root:

```sh
pnpm -F @shellbell/relay-node build
node apps/relay-node/dist/cli.js serve --data-dir /absolute/private/directory --port 8787
```

The directory is mandatory (or set `SHELLBELL_RELAY_DATA_DIR`), and the listener
defaults to `127.0.0.1`. `--host` explicitly enables another interface. TLS and
public ingress protection belong to the operator; the listener speaks HTTP/WS.
Configure direct FCM/APNs using private files and environment settings below. Startup errors
are sanitized; neither HTTP responses nor CLI errors echo paths or credentials.

Direct push uses `SHELLBELL_FCM_SERVICE_ACCOUNT_FILE` (private service-account
JSON) and/or `SHELLBELL_APNS_PRIVATE_KEY_FILE` (private .p8), plus
`SHELLBELL_APNS_TEAM_ID`, `SHELLBELL_APNS_KEY_ID`, `SHELLBELL_APNS_TOPIC`.
Mount files read-only and readable only by the runtime owner; restart to reload.
These are server credentials, never mobile client config. Missing or malformed
provider settings leave terminal connections available and emit sanitized
configuration diagnostics. Concurrent FCM sends share one OAuth refresh for
the same credential snapshot, then send their notifications separately.
See [app-identity requirements, setup and rotation](../../docs/self-hosting.md#notifications-are-a-separate-dependency).

The runtime owns verified APNs HTTP/2 sessions, with at most one live session
for sandbox and one for production. Each session admits at most 100 requests,
or the peer's lower advertised stream limit. Excess requests fail into the
existing bounded retry policy; there is no internal waiting queue. Requests
and response bodies have a five-second deadline, and sessions retire after
five idle minutes. Cancelling or failing one stream leaves healthy siblings
open. Connection failure or GOAWAY retires the session and fails its requests
without replaying ambiguous sends. Restarting closes the old transport and
loads a new immutable credential configuration. Workers' outbound connection
reuse is platform-managed; Node's session ownership does not qualify Worker
APNs delivery. These transport checks do not prove notification display.

`GET /` identifies the relay, `/healthz` is liveness, and `/readyz` is readiness.
The listener opens only after exclusive ownership and local recovery succeed.
Provider delivery can remain in flight after readiness; its claim and recovery
deadline are already durable. `GET /ws/<computer fingerprint>` upgrades to an
uncompressed WebSocket. Text `ping` receives `pong`, matching the phone client.

Runtime repository or local maintenance failure changes `/readyz` to 503 and
rejects new WebSocket upgrades with 503; `/healthz` remains independent liveness.
Recovery retries only while degraded, starting at one second and doubling to at
most 30 seconds. A successful durable computer/deadline scan, transactional
notification recovery and affected computers' local maintenance must finish
without a newer failure before readiness returns. Healthy storage is not polled.
Provider failures, rejected client frames and ordinary overload do not themselves
make storage unavailable. Corrupt required rows need operator repair; retries
never reset budgets or discard evidence. Failed timer maintenance retains or
restores its deadline and retries no faster than once a second; a newer schedule
or cancellation wins. Shutdown cancels recovery timers and drains started work
before releasing storage ownership.

Embedding API: `startRelay(config, { provider? })` returns `{ url, close }`.
`config` requires `dataDir`; optional values are `host`, `port`, `fcmServiceAccountFile`, `apnsPrivateKeyFile`,
`apnsTeamId`, `apnsKeyId`, `apnsTopic`,
`connectionQueueBytes`, `globalQueueBytes`, and `shutdownMs`. The provider is a
separate `NotificationProvider` dependency, not serialized configuration.
The bundle exports `startRelay` from `dist/server.js`.

Application send reservations default to **2 MiB per connection / 64 MiB per
process**, including writes awaiting the `ws` callback. Runtime `bufferedAmount`
is checked separately, without double-counting the same pending bytes. An
overloaded recipient closes with 1013; its ciphertext is never replayed to a
replacement connection. The shared core caps simultaneous saved connections at **128 per computer**,
including unauthenticated sockets. Excess admissions close with 1013 before a
challenge; existing connections retain their slots. This is separate from edge
flood protection. Fragment lengths are checked before buffers are combined.

Inbound work has an independent byte budget using the
same limits, a 256-byte credit per handler, and at most 256 pending handlers per
connection. These limits bound application work, not total process RSS, kernel
socket buffers, connection count, or a public-service capacity guarantee.

`SIGINT`/`SIGTERM` stop admissions and timers, close sockets, and drain tracked
work for at most `shutdownMs` (default 5000). Remaining sockets are terminated
and provider results are fenced; local completion/scheduling settles before
SQLite closes and ownership releases. Durable jobs are retained for recovery.
The runtime fences notification completion before closing its owned APNs
sessions; the closed transport rejects later sends.
An embedded provider's underlying external operation may outlive `close()`;
its late result is ignored and its rejection is handled. The CLI exits after
storage closes. It cannot guarantee exactly-once delivery across process loss.

Deadlines have a one-second scheduling floor and preserve useful imminent
timers. Security/retention maintenance completes independently of external
delivery. The runtime owns each coalesced delivery task once for shutdown and
eviction, so a held provider cannot stall later authentication deadlines.
Startup enumerates durable computers/jobs as well as deadline rows, so
a crash before the scheduling write cannot strand admitted work. Coordinators
are evicted only without sessions or active work; deadline timers can recreate
them. No input, screen, or terminal transcript is persisted.

Run on **Node 22.23.1**, using the native synchronous `node:sqlite` API. That
release emits an `ExperimentalWarning` for SQLite; it is expected and is not
globally suppressed. The API was checked against the
[versioned official documentation](https://nodejs.org/download/release/v22.23.1/docs/api/sqlite.html).

`openRelayDatabase(absoluteCanonicalDataDir, { attentive })` requires a synchronous
`attentive(computerFp, phoneFp, now): boolean` callback supplied by the live session
runtime. Tests and offline tools without sessions can explicitly return `false`.
An optional `randomId` callback defaults to `crypto.randomUUID`. Methods take time
explicitly. Close repositories/database with `await database.close()` before
reusing the directory.

Use exactly one process and one local durable filesystem volume. The ownership
database holds `BEGIN EXCLUSIVE` for the entire application database lifetime.
Another process fails before opening or migrating application data. Kernel/SQLite
locks release on abrupt process death; **do not delete the ownership file**. Its
inode remains the lock target across restarts. This is not a distributed lease:
replicas, shared/network filesystems, and automatic hosted-data migration are
unsupported. SQLite's locking and fsync guarantees depend on the local OS and
filesystem; the tests establish the behavior on the test host, not every volume.

The directory is private (`0700`); database files are private (`0600`). Existing
insecure entries, symbolic components, hard-linked files, and unsupported schema
versions are rejected. Every ancestor must be owned by the effective user or
trusted root, as well as pass the directory-mode checks. Supply a canonical path (on macOS, `/tmp` and `/var` may
be symlinks; use their resolved paths). Trusted same-user software must not rename
or replace files while the database is open. This is not a same-user sandbox.

Application SQLite uses WAL, `synchronous=FULL`, foreign keys, disabled extension
loading and parameterized queries. Short synchronous transactions own repository
invariants; provider/network work does not run inside them. Identity cardinality,
notification job/ring limits and claim batches bound normal transaction work.
The standalone `user_version=5` schema is independent of Cloudflare migrations.
Version 1 upgrades additively with `computer_deadlines`; existing rows remain.

## Offline backup and restore

Stop the owning process and wait for its exit before backup. For a foreground
process send `SIGTERM` to its known PID; for containers use the explicit commands
in the self-hosting guide. Do not remove `ownership.sqlite` to bypass the lock.

```sh
node apps/relay-node/dist/cli.js backup --source /srv/shellbell/data --destination /srv/shellbell/archives/backup-01.sqlite
node apps/relay-node/dist/cli.js restore --source /srv/shellbell/archives/backup-01.sqlite --destination /srv/shellbell/restored-01
node apps/relay-node/dist/cli.js serve --data-dir /srv/shellbell/restored-01 --host 127.0.0.1 --port 8787
curl --fail http://127.0.0.1:8787/readyz
```

Provision canonical private archive/restore parent directories first (owner is
the relay user, mode `0700`; ancestors satisfy the same ownership rules). Backup
requires an existing source database and exclusive ownership. The SQLite backup API
copies a consistent database, including committed WAL content; a main-file copy is
not a backup procedure. Output is a newly reserved `0600` file, integrity/foreign-key
checked and fsynced with its parent. Existing destinations are never overwritten.
Source database/ownership filenames and their reserved SQLite sidecar names are rejected.
Version 1 sources stay version 1; only a fresh restored copy migrates to version 5.
Registrations, queued jobs, attempt budgets, pairings and deadlines survive.

Restore accepts an offline archive, creates a new `0700` directory exclusively,
checks SQLite integrity/schema and identity rows/deadlines, then releases its owner.
The new directory must not already exist, even empty. Logical notification corruption
may still be caught during startup recovery; require `/readyz`, review sanitized
diagnostics, then perform synthetic pairing/revocation checks before routing traffic.
A started restored relay may resume pending notifications; never run both copies as
active deployments. Keep the previous directory and archive for inspection/rollback.
Failures leave incomplete output for inspection; retry with a different new name.
There is no automatic repair, deletion, overwrite, live migration or budget reset.
Backups contain private metadata and encrypted notification context: protect and
retain them according to your policy, outside source control and image build context.

## Container and synthetic qualification

Build from the repository root with `docker build -f apps/relay-node/Dockerfile -t
shellbell-relay:local .`. The image pins the official Node 22.23.1 multi-architecture
index, runs as UID/GID `1000:1000`, and seeds `/var/lib/shellbell` with mode `0700`.
Use a fresh named volume so Docker copies that ownership. Root-owned or differently
owned bind mounts fail closed; the image never chowns a supplied live volume.
The root filesystem may be read-only; supply private writable data and an explicit
temporary mount. See the complete commands in the self-hosting guide.

The recorded Docker Desktop qualification used an arm64 Linux engine: arm64 native,
amd64 **emulated**. Both architectures paired synthetic identities, restarted the
same volume, authenticated the pairing, revoked it, restarted again and rejected it.
Both rejected a second owner with a read-only root, dropped capabilities, and tmpfs.
These checks do not qualify a different host filesystem or a VPS performance class.

```sh
docker build --platform linux/arm64 -f apps/relay-node/Dockerfile -t shellbell-relay-qualification:arm64 .
docker build --platform linux/amd64 -f apps/relay-node/Dockerfile -t shellbell-relay-qualification:amd64 .
SHELLBELL_CONTAINER_TEST=1 pnpm -F @shellbell/relay-node exec vitest run test/container.test.ts
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs
```

The container tests create and remove only their uniquely named disposable containers
and volumes. The benchmark owns a fresh local child server and temporary directory;
it accepts only literal loopback bind addresses, uses generated synthetic identities,
and forbids provider calls. Flags: `--computers`, `--viewers` per computer, `--duration`
seconds, `--warmup` seconds, aggregate `--bytes-per-second` synthetic ciphertext target,
`--fps` per viewer, `--repeat`, `--host` (`127.0.0.1` or `::1`), and `--scenario`
(`quiet`, `incremental`, `burst`, `small-frame`, `slow-client`, `reconnect`). Frame
payloads cap at 64 KiB; small-frame deliberately uses 32 bytes. Gentle warmup is
distinct from measured load. The default is two 2-second smoke runs, not capacity
certification. JSON scopes server and generator resource metrics separately and
counts actual received envelope bytes. See the capacity guide for limitations.

Run `pnpm -F @shellbell/relay-node test`, `typecheck` or `build` from the repository
root. Tests use disposable temporary directories and real SQLite, including
subprocess ownership/crash recovery. Never point test fixtures at installed relay
or Shellbell data.

# Relay reference

The relay authenticates connections and coordinates one computer identity and its
paired phones. It forwards encrypted terminal traffic and schedules bounded push
work; it does not host shells or store terminal transcripts. The `/healthz`
endpoint proves HTTP reachability, not end-to-end session or push health.

## Reading this reference

Policy lives in the implemented [shared core and adapters](relay-portability.md).
This reference describes shared behavior and identifies Cloudflare lifecycle
details. The [Node runtime guide](../../apps/relay-node/README.md) covers the
standalone process. Read [operation and capacity](relay-capacity.md) for workload measurement procedures and limits, and [conformance fixtures](../../packages/relay-core/test-support/README.md)
for the versioned language-neutral contract.

## Topology and lifecycle

[`index.ts`](../../apps/relay/src/index.ts) exposes `GET /` (name/version),
`GET /healthz` (static `ok`), and `GET /ws/:computerFp` (WebSocket upgrade).
The fingerprint selects one `ComputerDO` through `idFromName`. This makes one
computer's agent, paired clients, revocations and notification policy share one
coordination boundary. Standalone Node instead maps that fingerprint to one
in-process coordinator and computer-scoped SQLite repositories. It requires one
process with exclusive ownership of a private local durable volume; its HTTP
listener also has `/readyz` for completed storage/recovery initialization.

[`computer-do.ts`](../../apps/relay/src/computer-do.ts) accepts the socket,
sends a random challenge, and authenticates it into one of three roles:

| Role | Admission | Authority |
|---|---|---|
| Agent | Signature for the computer identity matching the URL | Publish pairing metadata, notify, route to paired phones |
| Phone | Signature matching a stored pairing public key | Route to that computer, manage own push/lease, revoke itself |
| Pairing | Signed identity plus current QR gate and live agent | One pairing request per admitted socket |

An unpaired phone may submit only a bounded signed revocation proof before authentication.
The relay checks the signature and the current pair ID stored by the service; this grants
no terminal-routing authority. A stale proof for an earlier QR pairing cannot remove
a newer relay pairing. The relay returns a storage/absence/stale receipt, not an
end-to-end guarantee that the service deleted its local key.

Signatures bind nonce, role, identity and connection ID. A new agent/phone
connection supersedes its predecessor. Terminal envelope senders must match the
authenticated socket; frames are routed as original bytes, never decrypted.
Absent recipients do not get an offline replay queue.

The relay uses hibernatable WebSockets and serialized socket attachments.
SQLite/attachments preserve relevant durable/socket state; in-memory per-socket
token buckets do not survive object reconstruction. See Cloudflare's
[hibernation lifecycle](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
The permanent [local Workers regression](../../apps/relay/test/hibernation.test.ts)
evicts a synthetic `ComputerDO` and checks that its new instance retains
authenticated agent/phone attachments, the phone attention lease, and
bidirectional ciphertext routing over the original sockets. This is local
reconstruction evidence, not a measurement of production eviction timing,
idle billing, WAF enforcement, provider delivery, or device behavior.

Alarms handle unauthenticated/pairing deadlines, pairing expiry, orphan cleanup,
90-day inactive-computer cleanup and bounded notification work. The earliest deadline wins;
security/retention cleanup runs before notification work, and empty queues add no polling alarm.
Phone revocation while the agent is away records a tombstone; the next agent
sync applies it before its pairing list can reintroduce the deleted phone.
The backlog is bounded; [storage and revocation](relay-storage.md#revocation-precedence-and-limits)
explains overflow and signed acknowledgement behavior.

## Data inventory

[`schema.ts`](../../apps/relay/src/schema.ts) defines the stored tables:

| Table | Stored information |
|---|---|
| `computer` | Fingerprint, public key, name, first/last-seen timestamps |
| `pairings` | Phone fingerprint/public key/name, push token/platform/opt-in, timestamps, optional pair-key-derived ID |
| `pending_unpairs` | Pending revocation tombstones and optional bounded phone-signed proof, bounded retention and service acknowledgement |
| `pairing_window` | Temporary gate hash, expiry and admission count |
| `ring_limits` | Opaque session identifiers and last-ring timestamps |
| `push_limits` | Legacy per-phone window start/count, conservatively reserved until expiry |
| `push_attempts` | Bounded per-phone provider-attempt timestamps for the rolling budget |

Socket attachments also contain role, identity/connection identifiers, challenge
and timing/lease state. Terminal contents and decryption keys are absent.
Metadata still reveals relationships, activity timing and notification events;
“encrypted terminal” must not be expanded into “the relay knows nothing.”

Both adapters store the same metadata categories; Node adds a computer-scoped
durable deadline table and a separate local ownership database. It does not
persist live socket sessions across process restart. Offline backups contain
this metadata and pending notification ciphertext, so protect and expire archives
separately from live retention. See [privacy](../../PRIVACY.md).

The notification journal keeps one registration generation per paired phone and
short-lived jobs with random job/claim IDs, recipient/generation, encrypted context,
phase, timestamps and counters. At most 20 rows per phone and 200 per computer
survive; all expire within one hour of admission. Terminal outcomes and
cancellation delete jobs sooner. No terminal plaintext, token, computer name,
rendered payload or raw provider response is copied into a job. The separate
registration record holds delivery configuration. Existing legacy receipt rows
can be retired during recovery; new direct-provider jobs do not create an Expo
receipt-polling workflow. See [PRIVACY.md](../../PRIVACY.md).

## Limits and notification semantics

Application limits in [`limits.ts`](../../packages/relay-core/src/limits.ts) and
[`envelope.ts`](../../packages/protocol/src/envelope.ts):

| Boundary | Limit |
|---|---|
| Unauthenticated binary frame | 4 KiB |
| Control / pairing-role frame | 16 KiB |
| Phone E2E frame | 64 KiB |
| Agent E2E frame | 1 MiB |
| Core-handled application message rate | 60/s, burst 200, per socket |
| Saved connections per computer, including unauthenticated | 128 |
| Pairings per computer | 10 |
| Pairing socket admissions | 5 per open window |
| Ring rate | 1 per session per 60 seconds |
| Push budget | 20 attempts per phone per computer in a rolling hour |
| Outbound application reservation | 2 MiB per authenticated connection; 64 MiB aggregate per Node process / Cloudflare object instance |
| Inbound application reservation | Separate same byte ceilings, frame bytes + 256 overhead; 256 pending handlers per Node connection / 128 per Workers connection |

Slow readers close `1013`. Queue credits describe application-owned reservations,
not opaque platform/kernel buffers or total RSS. Workers exposes no drain
callback or useful buffered-byte meter: its outbound reservation ends when the
platform accepts `send`. Node holds it through the write callback. See the
[runtime contracts](relay-portability.md#queues-and-lifecycle) for lifecycle tradeoffs.

**Frame admission:** control and encrypted messages handled by the core are
charged to the socket's rate bucket. Arbitrary text is rejected (`4400` malformed or `4413`
oversized), with bounded UTF-8 byte measurement; the platform's automatic `ping`
→ `pong` stays outside this handler. Binary messages must fit the absolute role
cap before decode, then the exact decoded control cap before dispatch. There is
no prefix heuristic, so ciphertext containing a control-like byte pattern is not
misclassified. Exhausted buckets close `4429`. These application limits are separate from endpoint authentication and
independent security qualification.

Literal heartbeat `ping` is adapter-handled: Cloudflare uses platform auto-response,
while Node replies before core admission. Node still reserves frame/queue credit,
but this path bypasses the core rate bucket and needs
[bounded heartbeat admission](extensibility.md#relay-heartbeat-admission).

For a ring, policy excludes opted-out or tokenless phones and recipients holding
a live foreground attention lease. It reserves ring/push budgets before provider
I/O. Generic payload fields contain opaque routing identifiers and event metadata;
private notification context is separately encrypted for each recipient.

The [notification service](../../packages/relay-core/src/notifications/service.ts)
claims at most ten sends per pump through atomic repository operations. A claim
lease prevents overlapping handlers from dispatching the same attempt. Attempts
consume their reserved budget even across recovery; cancellation does not refund
it. Retry eligibility is bounded by attempt count, a short send window and the
job's original one-hour expiry. A late result cannot overwrite a newer
registration generation or revive a cancelled job.

The [direct provider](../../packages/relay-core/src/notifications/provider.ts)
uses FCM HTTP v1 or APNs. Shared response handling bounds time and response bytes,
refuses redirects and returns typed outcomes without logging tokens or payloads.
Node supplies a bounded APNs HTTP/2 transport; the Worker supplies its HTTP
adapter. Provider acceptance completes the job and does not prove physical
notification display. Invalid-token cleanup must match the still-current
registration and token. Re-registering rotates its generation even for an
identical token. Opt-out, unpairing and positive attention leases cancel pending
work. An in-flight request may already have reached the provider when cancelled.

Each computer/session uses a stable 47-byte ASCII grouping key: `sb1_` plus
base64url SHA-256 of the JSON tuple
`["shellbell-push-session-v1", computerFp, sessionId]`. It contains no token,
terminal content or phone name. The FCM/APNs adapters map that key to their
platform grouping and collapse fields; distinct jobs keep their own budgets and
claims. Grouping requests are not exactly-once delivery or latest-event ordering.
FCM can retain at most four different pending collapse keys for one registration;
see [FCM semantics](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types).

Physical replacement, grouping, sound and tap routing remain device qualification
work. See [private notifications](../private-notifications.md) and the
[release checklist](../before-first-release.md).


## Deployment and operating boundaries

Verify actual routes and preview/alias exposure in your own account after deployment.
A routing check on one deployment does not qualify another deployment's WAF coverage.

- `wrangler.jsonc` is the self-hosting configuration; `wrangler.hosted.jsonc`
  adds the project's hosted domain. Changes to shared bindings/migrations/vars
  must stay aligned. Use your own account configuration when deploying.
- `/healthz` proves only that the Worker responds. It does not exercise SQLite,
  authenticated routing, the Mac's backend, encryption, or push delivery.
- Per-IP upgrade protection is external dashboard/WAF configuration, not an
  application limiter in `index.ts`. Verify coverage for **every** reachable
  hostname; do not assume a zone rule covers a `workers.dev` address.
- Public identity self-registration is not an account/admission system. Quota
  abuse remains an accepted v1 risk requiring operational verification.
- Cloudflare's platform limits remain an outer bound, not a replacement for
  Shellbell's smaller application limits. Current received WebSocket limit is
  32 MiB; see [platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
- Cloudflare recommends routes/custom domains for production; see
  [routing guidance](https://developers.cloudflare.com/workers/configuration/routing/).

Review hibernation recovery, alarm cleanup, provider outages and actual WAF
coverage before describing the service as production-hardened. Green local
tests are not a live-deployment/security certification.

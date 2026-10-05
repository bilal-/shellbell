# Relay storage, revocation and recovery

Both supplied runtimes implement atomic identity and notification repositories.
Cloudflare scopes storage to a computer's Durable Object; Node scopes rows by
computer fingerprint inside one exclusively owned local SQLite volume. Schema and
SQL mechanics remain adapter-specific. [Runtime ports](relay-portability.md) define
shared policy, while [self hosting](../self-hosting.md) owns deployment commands.

## Atomic durable operations

Pairing admission/synchronization, revocation cascades, notification registration,
budget reservation, claim acquisition and completion are complete domain operations.
They cannot be split into independent CRUD calls without losing concurrency and
recovery guarantees. Provider I/O stays outside transactions.

Claims spend the hourly attempt budget atomically. Completion must still match the
claim, registration generation and expiry; stale provider results cannot revive
cancelled jobs. Registration changes, opt-out, attention leases and revocation
cancel eligible pending work. Cancellation does not refund spent attempts or recall
a request already accepted by a provider.

A provider can accept a push before the process loses its completion result.
Recovery waits out the claim lease and bounded backoff, retains spent attempts and
stops at the send/expiry limits. Duplicate or missed presentation remains possible;
this is not exactly-once delivery. Missing provider outcomes become retryable
`invalid-response` results rather than silently completing work.

## Validation and corrupt state

Required durable timestamps, counters and legacy budget fields must be nonnegative
safe integers before policy arithmetic or expiry cleanup. Validation occurs inside
the atomic operation so a corrupt neighboring row cannot spend a final budget slot
or partially commit recovery. Dynamically typed SQLite values need explicit decoding;
STRICT tables alone do not establish every policy invariant.

Invalid required rows fail closed and remain for operator recovery. They are not
silently reset, deleted or quarantined. Notification enumeration for the affected
computer can fail even when neighboring jobs are valid. Legacy optional context
can have a generic-message fallback on Cloudflare; it cannot change ownership,
generation, budgets or expiry.

Node storage failures degrade readiness and reject new upgrades while liveness
remains available. Degraded-only recovery retries with bounded backoff from one
to thirty seconds. Durable enumeration, deadlines and affected transactional
maintenance must succeed before readiness is restored; a newer failure or shutdown
fences older recovery. Provider rejection, malformed clients and ordinary overload
do not by themselves degrade storage readiness.

Cloudflare storage/event failures remain visible through sanitized application
categories and platform diagnostics. Do not suppress logging globally to hide
expected SQLite/Workerd output or interpret a provider-failure category alone as
proof of an external provider outage.

## Revocation precedence and limits

Synchronization snapshots pending tombstones before importing the authenticated
agent's pairing list, excludes those identities and removes their notification
state atomically. The official agent applies revocations before publishing its
list. Unsigned legacy tombstones are acknowledged by synchronization.

Secure-v2 signed tombstones bind the phone signature to the pair-key-derived ID.
They are persisted before online forwarding and retained until the service
acknowledges that exact pair ID after local deletion. A phone stages the proof in
its durable outbox before deleting its pairing secret. See
[the v2 revocation contract](direct-transport-wire-v2.md#pair-scoped-revocation-proof).

Pending revocations are bounded to **ten** per computer. An additional legacy
revocation still removes relay pairing/registration/job state but cannot retain
another unsigned tombstone at capacity. Signed capacity exhaustion returns
`unavailable` so the phone retains its proof for retry.

The official agent drains ordinary backlog on reconnect. A custom or faulty
authenticated agent can skip synchronization, authorize more phones over successive
connections and later re-import a stale legacy identity whose overflow tombstone
was not retained. This is a bounded compatibility limit, not unlimited revocation
durability. Requiring synchronization before further admission or changing capacity
needs an explicit protocol/policy migration. The relay already trusts an authenticated
agent to publish pairing authority.

## Runtime lifetime and ownership

Cloudflare awaits the full alarm/event lifetime. A held provider can keep an alarm
pending. Node tracks coalesced provider delivery separately so local security and
retention maintenance can continue; shutdown fences late completion before closing
storage and releasing ownership. A different runtime must define those lifetimes
rather than copying detachment patterns without a durability design.

Node startup enumerates durable work as well as deadlines, so a crash between
admission and deadline persistence does not strand jobs. Unknown schema versions
are refused. Backups use SQLite's consistent backup API under exclusive ownership,
include committed WAL data and restore into a new private directory. Cloudflare
backups are not Node import files, and no automatic migration is supplied.

## Operator recovery and conformance

Preserve diagnostics and quiesce the writer. Inspect a copy, then restore verified
known-good data or perform explicitly reviewed repair. Never reset budgets/claims,
delete the live database or remove the ownership file to silence an error. Stop
and verify the old process has exited before backup, restore, upgrade or rollback.
Keep the old deployment stopped when a restored copy becomes active.

Shared [repository recovery contracts](../../packages/relay-core/test-support/README.md)
run against both real SQLite implementations. They exercise concurrent final-slot
admission, corrupt required fields, claim/generation fencing, revocation cascade,
restart recovery and accepted-provider/lost-commit ambiguity. These synthetic checks
do not certify power loss, fsync or locking on an operator's target volume.

Use [offline backup and restore](../self-hosting.md#stop-backup-restore-start),
[Node operations](../../apps/relay-node/README.md) and
[the release checklist](../before-first-release.md) for target-host qualification.

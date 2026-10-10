# Privacy

This notice describes how the unmodified Shellbell apps and reference relay
implementations handle data. Terminal content is encrypted between your paired
devices. Connection, pairing and notification metadata is needed to operate the
service.

The project relay and an independently operated relay are different services.
For questions about the project relay, contact [Bilal](https://bilal.sh).
If you choose another relay, its operator controls that deployment, its logs,
backups and handling of the metadata it receives. This notice does not establish
or guarantee another operator's practices. Read their privacy information before
connecting; the app cannot verify their server configuration or retention policy.

## End-to-end encryption

Terminal data sent between your phone and your computer: screen contents, history, typed input, session
titles, commands: is end-to-end encrypted with a per-connection key the relay never has. The
relay forwards opaque bytes between the two devices; it cannot decrypt or inspect them. See the [security boundaries](docs/architecture/design.md#threat-boundary) and
[direct transport protocol](docs/architecture/direct-transport-wire-v2.md) for the
design and its limits. Independent protocol review remains open. Encryption does
not protect a compromised device or prevent an authorized device from reading
and controlling its paired computer's terminals.

Private notification context is implemented in the current source. What an installed
client can display depends on its native build, enrollment and push configuration.
Do not infer device qualification from relay deployment; see
[architecture and rollout](docs/private-notifications.md).

Normal mobile connections also encrypt SDP/ICE negotiation inside the paired relay session. The two devices learn candidate network addresses and native certificate fingerprints needed for WebRTC. The relay sees encrypted frame lengths, timing and ordinary authenticated connection metadata. A committed direct route carries terminal ciphertext between the devices; the relay remains available for coordination, push and recovery. The native adapters use local candidates and Cloudflare STUN (`stun.cloudflare.com:3478`) to discover public network addresses. That STUN service sees the requesting device’s source network address and port; it receives no terminal content, pairing keys or encrypted signaling. No TURN server is configured. Durable v2 floors are stored with each device's pairing record. Owner diagnostics retain frame-size counters, not terminal text or negotiation contents.

## What the relay stores

The reference relay application stores the following categories. Hosting, proxy
and backup records are described separately below; modified deployments can
behave differently:

- Your computer's name, fingerprint, public key and first/last-seen timestamps.
- Paired phones' fingerprints, public keys, names and pairing/last-seen timestamps;
  newer clients also store a one-way identifier derived from the random pairing key.
- Native FCM/APNs tokens, provider, platform, APNs environment, registration generation,
  opt-in settings and supported notification features.
- Short-lived `push_accepted` deduplication records for accepted private notifications:
  an opaque event-derived ID, recipient phone fingerprint (`phoneFp`) and expiry.
- Temporary pairing gate hashes, expiry/admission counters, and active connection/session leases.
- Pending phone-signed revocation proofs and timestamps until the computer
  acknowledges deletion, including when it was online but did not acknowledge.
- Rate-limit counters, including opaque session identifiers, last-ring timestamps
  and bounded per-phone push-attempt timestamps, to stop abuse. Legacy fixed-window
  counters remain reservations until their old window expires.

Node stores these categories partitioned by computer, plus durable deadlines and
a separate SQLite ownership file. It does not persist socket attachments;
Cloudflare retains validated attachments for hibernation. Offline backups contain
pairing/identity metadata, tokens, deadlines, budgets and pending notification
ciphertext. Protect archives and define retention separately: live unpairing or
90-day cleanup does not erase backups, and restore can restore older pairings.

Terminal payloads are end-to-end encrypted, but authentication, pairing control,
connection/lease state and push metadata are visible to the relay. Notification
requests can include an event kind, opaque session identifier, exit code and duration.

The relay receives and forwards encrypted terminal envelopes, but never receives
their plaintext or the keys needed to decrypt them. It does not persist a terminal
transcript or archive ciphertext for later delivery. Session titles, commands,
output and typed input remain sealed between your phone and computer.

Notification reliability also retains short-lived jobs: random job/claim IDs, phone fingerprint
and registration generation, bounded counters, and admission/expiry/due timestamps. Before provider
acceptance, each job retains routing/event metadata and, for private delivery, an
opaque encrypted notification box. Acceptance deletes the job; there are no
provider tickets or receipt polls. At most 20 jobs per phone and 200 per computer persist, for at most one
hour from admission. Terminal outcomes, renewed registration, opt-out, foreground attention and
unpairing delete jobs sooner. A registration generation remains only while the phone is paired.
The journal never copies push tokens, computer names, rendered push payloads, terminal content,
raw provider responses or exception messages.

After provider acceptance deletes a private notification's job and encrypted box,
its separate `push_accepted` record prevents the same event from being resent. It
expires at the original job's expiry, at most one hour after admission, and expiry
cleanup deletes it. Renewed registration, opt-out and unpairing delete it sooner.
This bounded record of provider acceptance contains no notification content and
does not establish that a notification appeared on the device. It is not retained
as a permanent delivery history.

## Local Mac power observation

The Mac controller reads the power source, its own IOKit sleep assertions, the
system sleep override and other processes’ idle/display assertion types and levels.
Only aggregate status booleans and freshness timestamps are retained in memory;
assertion names and process IDs from this read-only query are not retained or sent
to the relay. Shellbell does not inspect shell history or command text to detect
power changes. The administrator helper separately inspects console ownership and
recognized sleep-manager process names for conservative closed-lid eligibility;
this evidence is local and is not a command or activity history.

## What your phone stores

Native network type and connectivity state are observed locally for handoff,
reconnection and offline messages. Shellbell does not request Wi-Fi names or MAC
addresses, persist a network history, or add a third-party reachability probe.

The phone stores pairing/identity secrets, paired-computer records, preferences and a local
session-title cache for legacy notification enrichment. Unpairing removes the title cache.
For a v2 pairing, the phone also stores a small signed revocation proof until its relay
accepts the proof or confirms the old pairing is no longer current; it contains no
terminal content or `K_pair`.
Terminal screens/history/input are held in memory while in use, not archived as a persistent
transcript or command-history database.
The computer also keeps bounded per-pair input/create/focus acknowledgement metadata
in memory across relay reconnects (up to 256 completed and 256 unfinished requests).
This ledger contains request IDs and outcomes, not terminal input text; it is retired
on pairing replacement, unpairing or service stop and is never sent to the relay in
plaintext.

Keyboard attachment and screen-reader state are used locally for terminal layout
and accessibility; they are not reported to the relay. Terminal search and
selection stay on the device. Explicit copy actions write selected text or
formatted HTML to the operating system clipboard.

Private delivery also stores derived notification-only keys, enrollment ownership, bounded
replay counters and the hide-details preference. iOS uses a narrow shared Keychain group
with AfterFirstUnlockThisDeviceOnly access for derived keys; pairing/identity keys retain
WhenUnlockedThisDeviceOnly access. Android wraps derived keys using Android Keystore in
credential-protected, backup-excluded storage. Native replay metadata contains no repository,
branch or title cache.

Decrypted context exists briefly in native memory and in OS-displayed notifications. OS
notification history, lock-screen display, notification-access services and user-configured
forwarding are outside Shellbell's encrypted transport boundary. Hide notification details
affects future alerts, not existing notifications or system history. Legacy title enrichment
remains local; it does not send those titles back to the relay/provider.

## Local terminal adapters

Owner-enabled terminal plugins execute as trusted local code with the computer
service user's privileges. They can access plaintext terminals and local
secrets, just as a built-in adapter can. Shellbell's asynchronous bounds do not
sandbox plugins. Their module paths stay in local configuration; the phone
receives adapter IDs, labels, capabilities and session data through the encrypted
connection. Plugins must keep their own logging and network access consistent
with the owner's expectations. See the
[adapter contract](docs/architecture/terminal-adapters.md#owner-enabled-local-plugins).

## Logs

The Cloudflare adapter logs direct push provider, APNs environment and controlled
delivery result codes. These diagnostics omit device tokens, notification content,
pairing and session identifiers, and raw provider responses.

The relay reports sanitized storage/provider/overload/invalid-session categories;
Node collapses them to generic runtime failure. It does not log exception
messages, terminal contents, identity/session fingerprints, tokens, secrets or
byte counts. Platform, proxy and host logs remain the operator's responsibility.
A provider-failure category may also reflect local persistence failure; see
[storage and recovery](docs/architecture/relay-storage.md).

The hosted Cloudflare adapter enables Workers Logs. Platform logging can include
request method, status and duration independently of Shellbell's sanitized
application logs. Retention depends on the operator's plan and configuration;
Cloudflare currently documents three days on Workers Free and seven on Workers
Paid. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
Exports, proxy logs and backups can have different retention and must be reviewed
by the operator. Node hosting does not use Workers Logs.

## What a push notification carries

Delivery is `computer service → relay → FCM (Android) or APNs (iOS) → phone`.
The phone separately registers its native token with its paired relay. Expo
libraries run on-device; Expo Push Service is not in the delivery path.

A current generic push notification carries:

- The generic title `Shellbell`.
- A generic body chosen by event kind (a command finishing, a session going quiet, or an agent
  waiting on you), including exit code and command duration when supplied: never the session
  title, the command, or its output.
- A small data payload used only for routing: your computer's fingerprint, an opaque session id,
  and the event kind.

Apple and Google process the push payload to deliver the notification. Generic
push payloads contain no session titles, commands or output.

Pushes also carry a stable identifier derived from the computer fingerprint and opaque session
id already present in the routing payload. It is used for per-session collapse/replacement and
iOS grouping across events and retries, and adds no terminal title, command, or output. An
expiration is fixed at one hour after admission. This reduces stacking without guaranteeing
exactly-once display or delivery order. A direct provider response reports acceptance or rejection, not what
appeared on a device.

### Private delivery additions

Qualified iOS clients receive a generic mutable alert plus an encrypted recipient-specific
box; Android uses a data-only message with one native receiver. The phone authenticates and
decrypts context before displaying it. The relay and the selected provider (Google FCM for Android or Apple APNs for iOS)
see the native token, generic text, routing identities,
generation/event identifiers, nonce and ciphertext: not plaintext repository/branch/session
labels or notification keys. No raw command, question or output preview is included.

Unlike streaming ciphertext, a private notification box is retained temporarily in its
recipient's pending journal job. Provider acceptance clears it; the existing one-hour
journal bound is unchanged. Rich provider expiration is capped at two minutes from admission,
and the phone independently checks authenticated issuance/expiry. No permanent notification
context archive is kept. Background execution and exactly-once display are not guaranteed.

## Deletion

Local unpair first disables reconnect, then revokes native notification state, deletes the
pair secret and removes the computer record. Failure leaves a disconnected **Finish unpairing**
action. Remote removal is best-effort while offline; remove the phone on the computer too
when necessary. Already accepted provider pushes and OS notification history cannot be recalled.


- Successful relay-side revocation removes the live pairing, push registration,
  eligible queued notifications and leases. Offline or failed revocation is not
  proof of deletion; complete **Finish unpairing** and remove the phone on the
  computer when needed.
- After a computer has not connected for 90 days, the reference relay's scheduled
  cleanup removes its application records. This does not delete provider records,
  hosting/proxy logs, backups or data copied outside the application.
- Changing the relay address does not migrate or delete records at the old relay.
  Contact that operator if you need deletion of records they retain.
- Stopping or uninstalling the computer service preserves local identity, pairing
  and configuration files. It is not a credential wipe or remote revocation.
- Backups have the operator's retention policy. Restoring an old backup can restore
  older pairing records; operators must reconcile revocations during recovery.

## Self-hosting

An independently hosted relay receives the same metadata described here, under
that operator's control. Both clients must use its endpoint; see
[self-hosting](docs/self-hosting.md). This does not remove all third-party
services: background notifications use FCM/APNs, and the current native
adapters use Cloudflare STUN for address discovery. STUN receives source
addresses and discovery packets, not terminal content. Changing the relay URL
does not change STUN configuration.

Only use a custom relay when you understand who runs it and how it handles the
metadata listed above. A relay operator can observe connection addresses,
identifiers, names, timing and notification routing, and can delay or refuse
service. Terminal content remains encrypted between paired endpoints; choosing a
relay does not give its operator the endpoint decryption keys. Encryption does
not hide all metadata or make an operator trustworthy. Public source code does
not prove that a particular server runs that code unchanged.

With direct transport, terminal ciphertext travels between the endpoints while
relay WebSockets remain connected for signaling and control. Current mobile
clients wait for a verified direct route; temporary encrypted
relay terminal fallback requires an explicit user choice. Broader device/network qualification
and independent protocol review remain open in the
[release checklist](docs/before-first-release.md).

## Contact

Questions about privacy, or a request to delete what the hosted relay holds for your computer:
contact [Bilal through his website](https://bilal.sh).

To report a security vulnerability, use the same contact and follow
[`SECURITY.md`](SECURITY.md).

Contact verification is a [public-launch checklist item](docs/before-first-release.md);
Pro-bono help is discretionary; no response time is promised.

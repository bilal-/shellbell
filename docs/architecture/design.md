# Design decisions and security boundaries

Shellbell mirrors and controls existing terminal sessions. Processes, shells and
working directories stay on the computer; the phone presents output and sends
input to the selected session. This page records the current design. Detailed
message schemas belong to [the protocol reference](../protocol.md), and qualification
belongs to [the release checklist](../before-first-release.md).

## Component authority

| Authority | Owner | Boundary |
| --- | --- | --- |
| Wire formats, crypto and limits | `packages/protocol` | Shared by endpoints and relays; no application imports |
| Terminal and host identity | `apps/agent` | Runs as the OS user who owns the terminal backends |
| Relay security and delivery policy | `packages/relay-core` | Routes ciphertext through explicit runtime ports |
| Runtime I/O and durable transactions | Cloudflare / Node relay adapters | Preserve domain operations atomically; no terminal decryption |
| Mobile identity and presentation | `apps/mobile` | SecureStore pairing state, local WebView output and native push receivers |
| Desktop lifecycle and power | `apps/macos` and the agent's native bridge | User-controlled service ownership; privileged power helper is a separate boundary |

See [the overview](README.md) for flows and [extensibility](extensibility.md) for
current constraints. A backend adapter does not need to change relay routing.
A new runtime must implement ownership, queue, transaction and recovery contracts.

## Existing sessions over outbound connections

The service discovers iTerm2, tmux and Herdr sessions on macOS. Linux currently
starts only tmux. Other terminal apps work through tmux when the shell actually
runs inside it; arbitrary desktop tabs are not automatically exposed.

Both devices connect outward to a relay. No incoming computer port or shared LAN
is required for the relay path. The relay is scoped by computer fingerprint, using
one Durable Object per computer on Cloudflare or one coordinator per computer in
the single-process Node runtime. It authenticates public identities and enforces
pairing and resource limits; it is not a shell host or terminal archive.

Normal mobile connections negotiate a secure-v2 WebRTC path using encrypted relay
signaling and move terminal records to a verified direct data channel. Coordination
sockets remain open. Direct failure pauses terminal access while fresh encrypted
relay coordination and bounded direct retries recover the connection. Temporary
relay terminal traffic requires an explicit user choice.
[Direct transport](direct-transport.md) and [its wire profile](direct-transport-wire-v2.md)
define identity binding, key confirmation and route commit.

## Pairing and cryptographic domains

Endpoints have persistent Ed25519 and X25519 identity material. A temporary QR
contains the public computer identity, relay URL, gate token and a separate pairing
secret. The relay receives a gate hash, not that secret. The phone verifies the
computer fingerprint and the owner approves the phone identity. Pairing grants
control of sessions exposed by that OS user, not just permission to receive alerts.

Legacy terminal transport uses pairing-derived, per-connection keys with fresh
endpoint nonces, authenticated sequence numbers and XChaCha20-Poly1305. Secure v2
adds a fresh Noise handshake for each relay session and direct candidate, explicit
key confirmation and a durable per-pair version floor. Native DTLS certificate
verification binds the direct transport to authenticated signaling. ICE or a
fingerprint copied from SDP alone is insufficient.

Notification keys are separately derived per pairing and enrollment generation.
Native receivers receive that derived key, not identity or pairing private keys.
AES-256-GCM boxes bind recipient, computer, generation, session and event; freshness,
replay, revocation and privacy settings are checked before presentation. See
[private notifications](../private-notifications.md) for the exact contract.

No feature may reuse keys, nonces, counters or domain separators across these
protocols. Upgraded pairs cannot silently downgrade to v1. Independent secure-v2
security review and signed-device qualification remain release gates.

## Terminal correctness and bounded resources

The service converts backend screens to styled rows and cell widths. The phone
renders this model rather than attaching a new shell or interpreting the backend's
raw output stream. Remote terminal dimensions remain unchanged. Capture epochs,
subscription ownership and request IDs prevent late results from replacing newer
views. Bounded history retains explicit gaps and retention boundaries.

Screen delivery coalesces current state; it does not queue an unlimited transcript.
[Bounded stream records](../stream-history-records.md) and shared limits define
chunking, deadlines, cache ceilings and recovery. The xterm.js WebView uses bundled
assets and a local bridge; it opens no terminal network connection. See
[mobile presentation](mobile-terminal.md) and [renderer maintenance](../mobile-terminal-renderer.md).

Input, focus and session creation use a bounded per-pair outcome ledger. Duplicate
request IDs can join work or retrieve an acknowledgement across reconnects; a
restart or cache eviction can leave the result uncertain. Neither transport nor
UI automatically replays uncertain input. Backend acceptance is not command success.
Raw multiline input is not a guaranteed safe bracketed-paste operation.

The relay bounds frames, authentication, connections, handler work, send queues,
pairing and notification jobs. Terminal data is forwarded without durable replay.
Push claims and budgets are atomic, completion is fenced by generation and expiry,
and external provider work stays outside database transactions. Provider acceptance
can be followed by a lost local commit, so notification delivery is bounded retry,
not exactly once. [Relay storage](relay-storage.md) defines recovery behavior.

## Host ownership and local control

Identity, pairing and configuration state belongs to one OS user and selected
host. Private Unix sockets expose local diagnostics and runtime-bound mutations.
The Swift-to-Node bridge and Node-to-service local-control API have their own
versions; they are separate from the encrypted phone protocol.

Desktop service ownership is supervised by a private controller pipe. Quit or
owner loss removes Shellbell access without ending terminal jobs. Headless service
ownership belongs to launchd or systemd-user and survives the UI independently.
Conversion is explicit, durably recorded and reobserved after interruption.
Registration, startup preference, running process, local readiness, relay health
and backend readiness are distinct facts.

Ordinary keep-awake assertions belong to the desktop app. Closed-lid access uses
a separate root helper with authenticated XPC, fixed operations, expiring leases
and durable recovery. It never handles terminal content or pairing secrets.
Headless installation does not acquire power controls. See
[native lifecycle](native-controller.md) and [power qualification](../macos-power-helper-qualification.md).

## Threat boundary

| Threat | Intended defense or limit |
| --- | --- |
| Network interception | WSS admission plus endpoint-authenticated content encryption |
| Relay reading terminal content | Pairing/terminal keys remain on the endpoints; relay routes ciphertext |
| Malicious relay substitution or replay | Pairing identity checks, authenticated counters and fresh session context; secure v2 adds signed pair-scoped revocation and downgrade prevention |
| Relay withholding data or revocation | Availability cannot be guaranteed; v1 revocation relies on relay authority, and signed v2 proofs still need delivery |
| Resource abuse | Bounded core admission and queues plus operator-owned ingress protection |
| Compromised paired endpoint or OS account | Outside the confidentiality boundary; that endpoint can read and control its sessions |
| Push provider or OS notification history | Private context is encrypted in transit; presentation and already-delivered alerts have platform limits |
| Unsafe upgrades or corrupt state | Preserve credentials, refuse ambiguous ownership, validate durable fields and recover through verified backups |

Encryption does not hide IP addresses, fingerprints, pairing relationships, timing,
frame sizes, computer names or push routing metadata from the relay. Self hosting
changes who operates that metadata store; it does not establish an independent
security audit or organizational access-control policy. [PRIVACY.md](../../PRIVACY.md)
owns the complete data inventory; [SECURITY.md](../../SECURITY.md) owns reporting.

## Release and operational decisions

Computer, relay and mobile have separate release lines. Android and iOS share a
mobile semantic version, while native build numbers and protocol versions have
separate rules. [Versioning](../versioning.md) defines changelogs and compatibility.

Operators own TLS, credentials, access, storage, monitoring, backups and target-host
qualification. The Node reference runtime uses one process and a private local
SQLite volume; multiwriter replicas and automatic Cloudflare migration are not
supplied. [Self hosting](../self-hosting.md) and [adapter contracts](../relay-adapters.md)
explain deployment and extension requirements. Capacity examples are arithmetic,
not measured user guarantees.

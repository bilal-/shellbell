# Direct terminal transport and recovery

Normal mobile connections enable secure-v2 WebRTC negotiation. Terminal input and
subscriptions require a committed direct route; direct loss pauses them while
recovery and bounded retries continue. Users can explicitly allow relay terminal
traffic temporarily, until direct succeeds or the connection is replaced. Relay
signaling and notification enrollment remain available independently of terminal
policy. Upgraded pairings keep their secure-v2 floor.
[Device/network qualification and independent security review](../before-first-release.md)
remain launch requirements.

## Relay bootstrap and direct cutover

Both endpoints connect outward to the configured relay. An authenticated paired
connection bootstraps secure v2, confirms fresh Noise keys and persists the pairing's
minimum protocol version. Relay coordination becomes usable first; the mobile
terminal waits for a committed direct route unless the user allows temporary relay
terminal fallback.

The phone offers a WebRTC data channel through encrypted v2 relay signaling.
Bounded SDP and ICE messages bind the session, attempt and proposed generation.
Each native adapter compares the live remote DTLS certificate with the fingerprint
received through that authenticated exchange. The candidate then performs a fresh
Noise handshake and mutual key confirmation over the data channel.

A four-phase prepare/prepared/commit/committed exchange moves the terminal route
at an acknowledged boundary. Cryptographic readiness alone does not admit input.
Only the committed route carries terminal screens, history, input and terminal
acknowledgements. Both relay WebSockets remain open for coordination, pairing,
revocation and push. See [the exact wire profile](direct-transport-wire-v2.md).

The mobile native adapter resolves missing ICE media coordinates from the
accepted authenticated answer before calling WebRTC. A media ID and line index
must identify the same section; missing or ambiguous sections fail the attempt.
This keeps nullable integer fields out of the iOS release bridge and avoids
assuming that the data channel is always media section zero. DTLS certificate
verification and the encrypted cutover remain separate required checks.


## Failure and periodic retries

If a direct attempt fails before cutover, relay coordination remains usable,
but normal mobile terminal access stays paused unless the user allows temporary
relay fallback. If a committed direct route fails, recovery establishes a fresh
v2 relay session with a new session ID. A terminal snapshot is requested only
when a committed direct route or the explicit temporary fallback permits it. An ambiguous commit closes routes
rather than accepting input on two paths. Uncertain input is never replayed.

The phone retries native negotiation with jittered exponential backoff, starting
around five seconds and capped at sixty seconds. Attempts wait for outstanding
input acknowledgements. After thirty-two attempts the phone refreshes the relay
connection to bound attempt tracking. Native attempts have a fifteen-second
deadline, and stale callbacks are fenced by attempt ownership.

Closing the endpoint stops retries. Explicitly disabling direct mode stops native
attempts until a new endpoint opens; it does not lower a stored v2 floor. A working
encrypted relay gives the endpoints a signaling path to try again. It cannot make
an incompatible network support a direct route.

A committed direct route can survive relay interruption. If direct then fails,
relay recovery still requires relay reachability. There is no promise of indefinite
relay-free availability or offline terminal replay.

## Native adapters and network dependencies

### Phone network recovery

The mobile app observes native network state. A Wi-Fi/cellular path change retires
the old transport and reconnects through the relay immediately, using fresh
session keys before retrying WebRTC. Pairing survives the change. The focused
terminal keeps its last display and draft; input stays disabled until the new
route is ready. Unacknowledged input remains delivery-unknown and is never replayed.
Relay rate-limit cooldowns and permanent pairing errors still apply.

With no network interface, the app pauses connection attempts and displays
**No internet connection**. It resumes on restoration. A relay outage displays
reconnection status; only authenticated relay presence establishes that the
computer is offline. An unvalidated LAN can still reach a private relay, so an
Internet-validation failure alone does not disable local connections.

Native events trigger fresh readings, with bounded follow-up checks when the
first reading still describes the lost network. Deferred disconnect events do
not directly override a current reading. Foregrounding also refreshes the reading; while offline or
unknown, foreground-only rechecks reconcile missed callbacks. No third-party
reachability probe is added. Android reports system-validated Internet access;
iOS reports network connectivity, which does not prove Internet access. See the
[native network API](https://docs.expo.dev/versions/latest/sdk/network/).

This is reconnect-and-resynchronize behavior. A handoff may pause terminal input
while the new route authenticates; it does not migrate an in-flight request to
another connection. Device/network qualification remains separate from source
tests.

### WebRTC engines

| Endpoint | Pinned engine | Boundary |
| --- | --- | --- |
| Node service | `node-datachannel@0.33.4` | Lazy native adapter; reads the live remote certificate fingerprint |
| Android / iOS | `react-native-webrtc@124.0.8` | Native data channel; certificate stats are checked before activation |

The shared protocol endpoint depends on `NativeDirectPeer` / `NativeDirectFactory`,
not either application's engine implementation. The interface remains specifically
WebRTC: offer/answer, SDP, ICE and DTLS. Replacing the engine is possible; adopting
another direct protocol needs a new authenticated signaling profile.

Current adapters use local candidates and Cloudflare STUN for public address
discovery. STUN receives discovery packets and addresses, not terminal data.
No TURN service is configured. Restricted NAT/firewall combinations can therefore
leave terminal access paused; encrypted relay terminal fallback requires an explicit
user choice. Changing the relay URL does not change STUN; a custom STUN policy
currently requires adapter configuration and rebuilt clients.

The owner flag `EXPO_PUBLIC_SHELLBELL_DIRECT=1` exposes transport diagnostics and
fault-injection drills. Normal connections attempt direct transport without this
flag. The native data-channel setup does not use the Expo WebRTC config plugin or
media APIs. Android generation removes WebRTC media capture permissions/services
while retaining the camera permission used for QR scanning. Signed artifacts still
need manifest review and iOS device qualification.

## Qualification boundaries

The S22 exercised Wi-Fi loss with mobile data disabled, visible offline messaging,
blocked offline input and restored terminal input/output over a fresh direct
route. The owner diagnostics route `shellbell://dev/transport?run=offline` uses
a newly created iTerm2 fixture and closes it after success. The `run=handoff`
scenario additionally waits for cellular, then Wi-Fi, and accepts authenticated
encrypted relay fallback if a cellular direct attempt cannot connect. It reports
the actual cellular route; preparing this scenario is not cellular qualification.

Physical S22/Mac same-network tests exercised direct screen/input, relay
interruption, forced direct loss, explicit encrypted fallback and retry recovery.
The owner separately reports Fold 7 Wi-Fi/cellular recovery and TestFlight iPad
direct use over Wi-Fi and 5G, including handoff. These observations do not
establish a measured public-network success rate or the wider device matrix.
See the [release checklist](../before-first-release.md) for exact artifact scope.

Published Linux 0.3.0 archives passed native WebRTC loopback checks in isolated
containers; target-host phone connections still need qualification. Source tests
cover forged signaling, certificate mismatch, replay, route commit, revocation
and failure fencing. Neither those tests nor simulator builds establish an
independent cryptographic audit or physical iPhone qualification.

Before public activation, qualify physical iOS, cellular/CGNAT/restrictive networks,
network handover, background/sleep, multiple viewers and prolonged fallback. Verify
native package notices in final artifacts and the app's Open-source credits;
`node-datachannel` is MPL-2.0 and the mobile package includes native WebRTC notices.
Shared Noise vectors retain their attribution in
[third-party notices](../../THIRD_PARTY_NOTICES.md).

## Reproducible isolated checks

The service's [`webrtc-feasibility.mjs`](../../apps/agent/scripts/webrtc-feasibility.mjs)
and mobile development-only `/dev/webrtc-feasibility` screen exercise the native
primitive with disposable signaling. They do not qualify the integrated route by
themselves. Endpoint, signaling, route and framing tests in
[`packages/protocol/test`](../../packages/protocol/test) exercise the shared state
machine without touching installed identities or real terminals.

Use disposable terminal/pairing fixtures for end-to-end drills. Record exact builds,
OS/network conditions, active route and relay terminal-byte measurements. Distinguish
signaling/control bytes from terminal bytes. [Capacity planning](relay-capacity.md)
explains why lower terminal traffic does not reduce the number of relay sockets.

# Local control v2 reference

This private user-only Unix socket API connects the native bridge and CLI to an
already-running service. It is separate from the encrypted phone/relay protocol.
Source schemas live in `apps/agent/src/control-v2-protocol.ts`; framing, server and
typed client are exported through `apps/agent/src/control.ts`.

Connection performs hello negotiation only. It does not initialize state, read
keys/configuration, start the agent or manage services. The controller selects an
existing endpoint. Settings, host ownership and service registration belong to
[the native lifecycle](architecture/native-controller.md); distribution gates
belong to [the release checklist](before-first-release.md).

## Transport and negotiation

Frames are strict UTF-8 JSON followed by LF. A line may contain at most 65,536
bytes before LF, including an optional CR. Invalid UTF-8, oversized lines,
incomplete final lines and invalid envelopes terminate the connection. Each
socket may buffer at most 262,144 output bytes including frame delimiters. There
is no additional request/output/retry queue. Node's `write()` returning false
means accepted buffering, not failed delivery. The server admits at most 16
connections and requires the first valid request within five seconds.

The client has a five-second connection deadline and a separate five-second
deadline for each request, including hello. It sends hello first:

```json
{"v":2,"id":1,"cmd":"hello"}
```

```json
{"v":2,"id":1,"ok":true,"data":{"version":2,"runtime":{"pid":123,"agentVersion":"0.0.1","computerFp":"aaaaaaaaaaaaaaaaaaaaaaaaaa","stateDir":"/Users/example/.shellbell","serviceInstance":null},"capabilities":["status","devices","pairing","revoke"]}}
```

The runtime tuple is exactly `pid`, `agentVersion`, `computerFp`, `stateDir`,
`serviceInstance`. The service instance is a UUID or null. The client validates
the exact ordered capability tuple shown above. Capabilities describe local
status, device listing, pairing consent and revocation; they do not promise
terminal readiness, relay connectivity, native UI or service management.

IDs are positive JavaScript safe integers, strictly increase within the
connection and never wrap. There is one pending request. Concurrent calls fail
with `busy`; they are not queued. No automatic reconnect, downgrade or replay
occurs. A recognizable legacy hello response produces `upgrade-required`.

## Requests and results

Every response has the matching request ID. Success is
`{"v":2,"id":2,"ok":true,"data":...}`. Failure is
`{"v":2,"id":2,"ok":false,"error":{"code":"runtime-mismatch"}}`.
Both envelopes and command-specific data are strictly validated; unknown fields
are rejected. No response carries raw exception text.

| Command | Arguments | Success data |
|---|---|---|
| `hello` | None | Negotiated version, runtime tuple and capabilities above |
| `status` | None | `LocalStatus`: process, ordered backends, terminalReady, relayOnline, sessions, phones, connected |
| `status.config` | None; neither `args` nor `expect` is permitted | Strict `{revision:string}`; exactly 64 lowercase hexadecimal characters |
| `devices` | None | Array of `{phoneFp,name,lastSeenAt}` |
| `devices.revoke` | `{phoneFp}` | `{removed:boolean}` |
| `pairing.open` | None | `{flowId,qrText,expiresAt}` |
| `pairing.close` | `{flowId}` | `{}` |
| `pairing.confirm` | `{flowId,challengeId,phoneFp,accept}` | `{}` |

`LocalStatus.controlVersion` remains **1**: it versions that existing data
model, while `v:2`/hello `version:2` negotiate this transport. Backend status is
ordered `iterm2`, `tmux`, `herdr`; terminalReady follows actual backend readiness.
Fingerprints are protocol fingerprints. Flow/challenge IDs are 22-character
base64url strings. Phone names are 1-64 characters. `expiresAt` is an epoch
millisecond deadline. A pairing challenge lasts at most 60 seconds and never
outlives the pairing window.

`status.config` is read-only. Its revision is the SHA-256 digest of the agent's
normalized, privately owned startup configuration snapshot, including the effective
CLI relay override. It does not reread configuration from disk: saving settings
does not change the applied revision until an agent starts with those settings.
Later changes to the caller's original configuration object cannot change either
the running agent's configuration or its revision. The digest serializes keys in
this order: `v`, `relayUrl`, `computerName`, `accent`, `notifyMinCommandMs`,
`idleQuietMs`, `idleMinActiveMs`, after applying schema defaults.

```json
{"v":2,"id":2,"cmd":"status.config"}
{"v":2,"id":2,"ok":true,"data":{"revision":"79417a9c7d2f1d7bf34ef0b4a3fd2aa346d1ab3dfde822eca0ffcfa7e144e638"}}
```

This additive query does not change `LocalStatus`, the existing strict `status`
result, the hello response, its four capabilities, or the runtime ownership tuple.

Every mutation includes `expect`, an exact copy of the runtime observed in hello:

```json
{"v":2,"id":2,"cmd":"pairing.open","expect":{"pid":123,"agentVersion":"0.0.1","computerFp":"aaaaaaaaaaaaaaaaaaaaaaaaaa","stateDir":"/Users/example/.shellbell","serviceInstance":null}}
```

The server compares the submitted tuple, its retained hello observation and its
current runtime before mutation. The typed client retains a private observation
separate from the exposed `runtime` object: changing a UI's public object cannot
retarget a mutation. A mismatch is a typed rejection, not a service transition.

## Pairing ownership and event ordering

There is one pairing owner across native and legacy callers. Native consent
requires the owning socket, exact flow, current challenge and phone fingerprint.
A native owner takes precedence over a foreground `--yes`. A status connection
never acquires pairing ownership. Disconnecting a native owner closes its flow
and resolves pending consent false; closing an observer does not affect another
client's window or stop the agent/service.

```json
{"v":2,"id":2,"ok":true,"data":{"flowId":"ffffffffffffffffffffff","qrText":"<private QR payload>","expiresAt":1800000000000}}
{"v":2,"event":"pairing.request","flowId":"ffffffffffffffffffffff","challengeId":"cccccccccccccccccccccc","phoneFp":"bbbbbbbbbbbbbbbbbbbbbbbbbb","name":"Phone"}
```

The successful open response precedes the first request event, potentially in
the same socket read. The client installs ownership while processing that
response, before resolving `openPairing()`. Applications need not wait an extra
turn to receive the consent event.

```json
{"v":2,"id":3,"cmd":"pairing.confirm","expect":{"pid":123,"agentVersion":"0.0.1","computerFp":"aaaaaaaaaaaaaaaaaaaaaaaaaa","stateDir":"/Users/example/.shellbell","serviceInstance":null},"args":{"flowId":"ffffffffffffffffffffff","challengeId":"cccccccccccccccccccccc","phoneFp":"bbbbbbbbbbbbbbbbbbbbbbbbbb","accept":true}}
{"v":2,"event":"pairing.closed","flowId":"ffffffffffffffffffffff"}
{"v":2,"id":3,"ok":true,"data":{}}
```

A closed event may precede the close/confirm response. Confirmation acknowledges
submission of the decision, not persisted pairing; refresh devices/status to
observe completion. A valid closed event for an unowned flow is inert: it does
not change ownership or invoke the callback. In particular, synchronous failure
during open can close its prospective flow before returning `operation-failed`.
Malformed events still terminate the connection. An unowned request event is a
protocol error, since its successful open must have come first.

## Typed client and failures

`connectControlV2(path, options?)` returns `Promise<ControlV2Client>` after hello.
Options accept an optional socket `connector` and synchronous callbacks
`onPairingRequest`, `onPairingClosed`, `onDisconnect`. Pairing callbacks receive
validated, owned events. `onDisconnect` receives at most one content-free
`ControlV2ClientError`, including `closed` for an intentional `close()`.

The public client has readonly `runtime`, `status()`,
`configurationRevision(): Promise<string | null>`, `devices()`,
`revoke(phoneFp)`, `openPairing()`, `closePairing(flowId)`,
`confirm(flowId,challengeId,phoneFp,accept)` and synchronous idempotent `close()`.
Close/confirm return `Promise<void>`. Closing does not send a service-stop command.

| Client error code | Meaning |
|---|---|
| `unavailable` | Connect/transport failed, or transport was known to refuse before a write attempt |
| `upgrade-required` | Server answered hello with the legacy protocol; upgrade before using v2 |
| `protocol-error` | Invalid input, framing, event, envelope, ID or typed response data |
| `timeout` | Connection or read request deadline elapsed |
| `delivery-unknown` | A mutation write was attempted without a valid matching result |
| `busy` | Another request occupies the one pending slot |
| `closed` | Explicit close, or a method called after terminal disconnect |
| `server-error` | Matching typed rejection; inspect `serverCode` |

For `configurationRevision()` only, a validated matching server rejection with
client error code `server-error` and `serverCode: "bad-request"` resolves to `null`:
an older v2 service may not recognize `status.config`, so its applied revision is
unknown. The connection remains usable for a subsequent explicit request. All
other failures propagate, including malformed rejection envelopes, invalid digest
results, transport failures, timeouts, and other server codes. There is no automatic
retry, reconnect, legacy fallback, or mutation replay.

Server codes are `bad-request`, `unsupported-version`, `handshake-required`,
`runtime-mismatch`, `pairing-busy`, `stale-flow`, `stale-challenge`,
`response-too-large`, `operation-failed`.

Once a mutation write is attempted, socket loss, timeout, a thrown write,
malformed reply, wrong ID, or invalid result means **delivery-unknown**. It does
not prove failure or success. `onDisconnect` can separately report the underlying
protocol/transport cause. A valid matching typed server rejection remains
`server-error`. Known refusal before any write attempt is `unavailable`/`closed`.

Never automatically retry a mutation. Explicitly reconnect and inspect hello,
devices/status, then let the operator choose a fresh action. An uncertain pairing
flow needs fresh ownership and consent. Errors contain no paths, QR payloads,
names or raw exceptions. Successful private status and QR results intentionally
contain UI data and must not be logged.

## Compatibility and qualification

Native-bundle services require native pairing consent. Their legacy `pair-open`,
`pair-close` and `confirm` commands report that pairing is managed by the Shellbell
app, even when no native pairing window is open. They never offer a terminal QR
window whose confirmation cannot be accepted. Other legacy commands remain available.

On standalone CLI services, legacy clients retain `status`, `devices`, `unpair`, `pair-open`,
`pair-close` and `confirm` behavior on a new server, within shared resource bounds.
Legacy disconnection is not a native ownership-close operation; use its explicit
`pair-close` when required. A connection cannot switch protocol modes. New clients
do not silently issue old mutation commands against old servers.

Tests use bounded synthetic peers and isolated temporary sockets, plus actual
ControlServer/Agent/PairingManager with generated identities and FakeBackend.
They start only ControlServer, never Agent.start or any real provider. This is
source/fixture evidence, not native service registration, installation, signing,
live terminal, phone delivery or platform qualification.

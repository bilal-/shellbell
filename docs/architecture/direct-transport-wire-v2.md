# Direct transport v2 wire profile

Status: **integrated; normal mobile connections negotiate secure v2 and direct WebRTC**.
Both terminal dispatchers use the shared v2 endpoint; the relay forwards opaque
frames. Mobile terminal input and subscriptions wait for a committed direct route,
with encrypted relay terminal fallback available only through an explicit temporary
choice. The adapters use local ICE candidates plus Cloudflare STUN address
discovery; no TURN server is configured. Same-network S22/Mac input, screen updates,
relay interruption and recovery passed; wider network/device qualification and
independent security review remain open. See [the connection guide](../how-shellbell-connects.md).

## Trust and carriers

- Pairing records, not relay account rows, supply `K_pair`, the trusted peer X25519 static key,
  and the computer/phone fingerprints. A device must not accept a key or fingerprint from an
  offer, relay control message, ICE candidate, or QR-less reconnect as new authority.
- A v1 paired encrypted connection is only a **bootstrap carrier** for the first v2 relay
  handshake. Both endpoints must explicitly advertise v2 capability. Once upgraded, relay
  terminal frames use their own versioned outer envelope carrying opaque v2 frame bytes, with no
  v1 `Envelope.seq` JavaScript number. The shared core used by both relays now validates and
  forwards this carrier, and owner test endpoints now use it. The direct data channel carries the
  same encoded v2 frame bytes.
- After a successful v2 session, both peers durably record minimum protocol version 2 for that
  exact pairing. A later v1 connection may carry a v2-intent bootstrap, but must not accept v1
  terminal data or a legacy `conn.hello` lacking v2 intent. An old client then requires an
  explicit re-pair, never an automatic downgrade. A replayed hello cannot displace an active
  direct session. Per-pair floor storage and legacy-link rejection now exist on both
  endpoints, and authenticated endpoint bootstrap now persists the floor before route admission;
  signed revocation and authenticated endpoint dispatch are implemented; public qualification remains gated.
- Direct SDP, ICE candidates, and route-control messages travel *inside the active v2 encrypted
  relay session*. The relay forwards them but cannot alter them successfully. No unauthenticated
  signaling or terminal bytes are admitted to the direct path.

## Authenticated session context

Each new v1-carried relay bootstrap chooses a fresh random, nonzero 16-byte session ID for that
paired phone; a session ID is **never reused** after reconnection or fallback. Each relay
handshake or direct-route attempt has its own random, nonzero 16-byte attempt ID. The 8-byte
**little-endian** route generation starts at 1 for that bootstrap, increases for direct attempts
within that session, and is limited to
`2^64 - 2`. These IDs and generations are agreed in authenticated signaling before the Noise
handshake. Neither a relay connection ID nor the service's local `PhoneLink` counter is a wire
generation. The coordinator must reject stale/reused IDs and generations; the schema alone cannot
prove freshness.

The Noise prologue is CBOR of this fixed-order array:

```text
[
  "shellbell-session-v2", 2, "phone", "computer",
  computerFp, phoneFp, sessionId, attemptId, generation,
  "relay" | "direct", phoneDtlsSha256OrNull, computerDtlsSha256OrNull
]
```

Fingerprints are the existing 26-character pairing IDs, not network addresses. For a direct
attempt, the two DTLS values are exactly 32-byte SHA-256 certificate fingerprints obtained from
end-to-end authenticated SDP. On the established data channel, each side must compare its
*actual native DTLS remote certificate* to the peer value before route activation. Relay-route
contexts require both DTLS values to be null. CBOR array positions, byte lengths, role order, and
the domain string are part of the protocol; do not serialize a JavaScript object as the prologue.

## Noise and confirmation

The phone is the Noise initiator, the service the responder. Use
`Noise_KKpsk2_25519_ChaChaPoly_SHA256` with the static X25519 keys saved at pairing and
`HKDF-SHA256(K_pair, salt = UTF8("shellbell-noise-v2-psk"),
info = UTF8(computerFp + "|" + phoneFp), length = 32)` as its *dedicated* PSK. Handshake messages
have no application payload and are 48 bytes each. Both peers finish the two-message handshake
and derive the same handshake hash; no terminal command or screen is accepted yet.

Each direction then sends one encrypted `confirm` frame at sequence 0. Its plaintext is CBOR
`["shellbell-v2-key-confirm", handshakeHash, senderRole]`. A peer may accept terminal `data`
frames only after it has **sent and verified** a confirmation. Confirmation has its own frame type
and is never passed to the terminal message decoder. A mismatched hash, role, context, tag, or
frame type closes that candidate session. A direct candidate additionally requires comparison of
the native DTLS transport's actual remote certificate before `ready` can become true. `ready` is
**cryptographic readiness**, not permission to execute terminal input; the route coordinator must
separately commit the generation. Both relay and direct routes perform a fresh handshake and
confirmation; ICE/DTLS alone never marks a route ready.

## Pair-scoped revocation proof

The isolated `pair-revocation-v2.ts` helper derives
`pairId = SHA-256(UTF8("shellbell-pair-revocation-id-v2\\0") || K_pair)` and has the phone
sign a fixed-order CBOR array
`["shellbell-pair-revocation-v2", computerFp, phoneFp, pairId]` with its paired
Ed25519 identity. The proof carries version 2, both fingerprints, the 32-byte pair ID,
and a 64-byte signature. The service must verify it against its **locally stored** pair
key and phone public key; a proof from an old QR pairing cannot revoke a new one even
if the phone fingerprint is unchanged. Protocol control messages carry the proof;
the service verifies it before deleting a v2-marked pair. The shared relay core
forwards it online and stores it with a pending tombstone in both SQLite adapters
when the service is offline. A later authenticated service connection receives it.
The relay stores before forwarding even when the service is online, since WebSocket
send success is not delivery proof. `pairings-sync` acknowledges only unsigned
legacy tombstones. A signed tombstone remains until the service persists the local
deletion and sends `revocation-ack` for its exact `pairId`; an older ack cannot
clear a newer proof. If that ack is lost, a later service reconnect repeats it.
The service still refuses *unsigned* relay deletion notices, while local owner
unpair remains effective. The phone stages the signed proof in a durable local
outbox before deleting `K_pair`. It submits the saved proof over a restricted
pre-auth control path on launch, foreground, active-app retry and immediate
unpair. The relay verifies the phone signature and checks `pairId` against the
current service-published pairing before storing and acknowledging it; it rejects
an old proof after a new QR pairing. A matching pending proof is idempotently
acknowledged. `stored`, `absent` and `stale` receipts clear the local outbox entry;
`unavailable` (a legacy relay pairing row without a pair ID or full signed
tombstone capacity) retains it for
retry. Receipts are relay-state observations, not end-to-end proof of service
key deletion.
Service key deletion still requires its own local verification and acknowledgement.
Malicious or unreachable relays can deny delivery, so device qualification and
honest messaging remain release requirements.

## Bounded encrypted negotiation

The `session-v2-signaling.ts` schemas define messages consumed by the shared `V2PairEndpoint`.
The paired-v1 `session.v2.bootstrap` inner carrier now accepts only 1-1,024 opaque bytes.
An isolated `V2PairedCarrier` binds both v2-intent `conn.hello` messages to the paired
fingerprints and Kpair, then accepts only sequential, bounded, encrypted bootstrap frames
under Kconn. A validly encrypted v1 terminal message is fatal even before v2 confirmation.
The shared endpoint owns secure-session admission, durable floor callbacks, encrypted direct signaling, verified native certificate callbacks and route lifetime. Applications own terminal dispatch and native ICE. Neither app imports the other.

Direct negotiation then travels only as plaintext *inside* the active encrypted v2 relay frame.
`direct.offer` is phone-originated and carries a fresh offer ID, proposed higher generation,
data-channel SDP (max 24,000 printable ASCII/CRLF characters), and the phone's 32-byte DTLS
fingerprint. `direct.answer` is service-originated and adds the service's fresh attempt ID, SDP,
and DTLS fingerprint. `direct.candidate` carries an offer ID, index 0-31, at most 1,024 printable
ASCII `candidate:` characters, and a bounded media-section identifier/index (only index 0 for
the single data-channel media section). `direct.end` gives
the final candidate count (0-32); `direct.abort` stops the attempt with a bounded reason. Every
message repeats session ID, offer ID, and generation; encoded messages are capped at 30,000 bytes
before CBOR parsing. The receive helper requires a trusted sender role, current session ID,
committed generation, and (for post-offer messages) pending offer ID/generation. SDP preflight
allows one SCTP data-channel media section, requires all SHA-256 fingerprints to equal the
advertised value, and rejects embedded ICE candidates so the separate cap cannot be bypassed.
The adapter must produce trickle-only SDP and convert native empty-candidate end events to
`direct.end`. The coordinator must still verify attempt freshness, native SDP acceptance,
candidate index uniqueness/count, and a bounded attempt deadline. The schema limits
one message; it does not enforce the cumulative candidate or concurrent-attempt budget by itself.
Relay implementations never decode these SDP/ICE messages.

## Transport frame

The versioned frame has exactly these fields (no extras):

| Field | Encoding | Purpose |
| --- | --- | --- |
| `v` | integer `2` | Distinguishes the new application protocol. |
| `type` | `confirm` or `data` | Separates key confirmation from application traffic. |
| `sessionId` | 16 bytes | Pair-specific coordinator session. |
| `generation` | 8 little-endian bytes | Agreed route epoch. |
| `seq` | 8 little-endian bytes | Noise directional nonce; **not** a JavaScript number. |
| `ciphertext` | 16-60,016 bytes | ChaCha20-Poly1305 output including its 16-byte tag. |

The associated data is fixed-order CBOR
`["shellbell-v2-frame", sessionId, attemptId, generation, route, senderRole, type, seq]`.
The Noise handshake already commits to the full context, including both DTLS fingerprints.
Transport sequence 0 is confirmation; application data starts at 1. Sender never reuses or
rewinds a sequence under a key. The underlying Noise primitive can authenticate a higher nonce
after a gap, so a failed local queue write cannot cause nonce reuse. The **Shellbell session**
does not apply that later message: after successful authentication it detects any gap, erases the
decrypted bytes, closes the session, and requires a new handshake/snapshot. It also rejects an
older/replayed sequence. Failed authentication does not advance the receive counter.
The encrypted application payload is at most 60,000 bytes so an encoded frame fits beneath the
phone-to-relay 64 KiB limit; larger screen/history content must be chunked. Decode rejects bytes
over 61,000 **before** CBOR parsing. Actual relay carrier framing must retain this bound.

## Route transition and failure

The first v2 route is relay. A direct candidate begins only after the relayed terminal is usable.
Offer, answer, and each bounded ICE candidate are encrypted under that active v2 relay session.
Before the direct Noise handshake, both peers agree on one higher route generation and the final
context binding both resulting DTLS certificates. New direct handshake and mutual confirmation
then happen over the data channel. The paired-phone coordinator cuts over at an acknowledged
boundary. At no point may terminal input execute on
both paths. After committed direct cutover, the relay carries coordination/push but no screen,
history, input, or terminal acknowledgements. Direct failure begins a fresh relayed v2 bootstrap
with a **new session ID and generation 1** rather than reusing the old session's generation;
the phone requests a snapshot and must not silently retry input with an unknown outcome. A lost
confirmation or pre-commit data frame leaves the candidate uncommitted; the coordinator times it
out and keeps the prior route. Both transports use reliable ordered delivery, but terminal input
still requires an application acknowledgement and an unknown-result state on timeout.

Both endpoint dispatchers implement durable upgrade, bounded attempt deadlines
and candidate tracking, signed revocation, per-pair request outcomes, native
adapters and fault fencing. These implementation checks do not qualify an
independent security assessment, physical iOS or the wider network matrix. See
[direct transport](direct-transport.md) and
[the release checklist](../before-first-release.md) before public activation.

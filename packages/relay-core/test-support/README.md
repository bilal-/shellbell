# Relay conformance fixtures, version 1

This is repository test support, not a production package export. TypeScript
adapters can reuse the runner; other languages can replay the JSON transcripts
and implement the [wire protocol](../../../docs/protocol.md). Passing transcripts
is compatibility evidence, not complete security, storage or deployment certification.

## Artifacts and validation

- `fixtures/transcripts-v1.json` and its draft-07 schema: eleven synthetic
  WebSocket transcripts covering malformed/oversized admission, role-bound auth,
  unpaired admission, exact bidirectional forwarding, phone authority, revocation,
  expired/wrong gates, single-use pairing requests and replacement ownership.
- `fixtures/session-v1.json` and its draft-07 schema: versionless legacy
  unauth/agent/phone/pairing attachments and a signed challenge. Both runtimes
  normalize attachments to version 1 and reject a corrupted signature. These
  are Cloudflare attachment examples, not persistent Node socket records.
- Protocol-owned [streaming/auth vectors](../../protocol/test/vectors.json) and
  [notification vectors](../../protocol/test/notification-vectors.json) correspond
  to `streaming-v1` and `notification-v1`. Both runtime suites call the protocol's
  `runVectorChecks` and `runNotificationVectorChecks` without copying or changing
  the vectors. There is no alternate crypto implementation in this directory.

Run `pnpm check:relay-conformance` from the root. It validates both JSON fixtures,
then runs the same transcripts and vector checks through actual Workers and Node
connectors. `pnpm test` additionally exercises shared identity, notification and
recovery contracts over both real SQLite implementations, plus Cloudflare
reconstruction and Node ownership/restart/overload/backup. Container tests are
separately opt-in; see the [runtime guide](../../../apps/relay-node/README.md).

## Replay rules

Start each scenario in an empty isolated computer partition. Devices `host` and
`phone` use the protocol streaming vectors' seeds/fingerprints, names
`synthetic-transcript-host` / `synthetic-transcript-phone`, and creation time
`2026-01-01T00:00:00Z`. These public synthetic keys must never be real identities.
Each `connect` creates a fresh socket using the host fingerprint in
`/ws/:computerFp`. Keep one ordered binary receive queue per socket.

`setup: bare` creates no connection. `agent` authenticates the host and consumes
`auth-ok`, `unpaired`, then `phones`. `paired` also performs the normal
gate/request/add/response/close pairing exchange: gate `07` repeated 16 times,
300,000 ms lifetime, box nonce of 24 zero bytes and ciphertext `010203`. It
connects/authenticates the phone and consumes the agent's `phone-connected`.
The named sockets available afterward are `agent` and, for `paired`, `phone`.

| Operation | Required behavior |
| --- | --- |
| `authenticate` | Consume the live challenge. Sign protocol `authMessage(connId, signRole ?? role, fp, nonce)` with the device seed. Send role, fingerprint, public key, signature, name and appVersion `test`, plus optional decoded `gateHex`. Compare rejections exactly; successful auth compares type because challenge fields are fresh. |
| `gate-open` | Send host `pairing-open` with SHA-256 of decoded `gateHex` and expiry equal to current epoch milliseconds plus `lifetimeMs`. |
| `send-ctrl` / `expect-ctrl` | Send/decode protocol control envelopes (`v:1`, `t:ctrl`, `seq:0`, device fingerprint). `$host`/`$phone` strings expand to fingerprints; a sole `{"$hex":"..."}` object expands to bytes. Compare exactly unless `match:subset` specifies only named fields. |
| `send-raw` | Send decoded `hex`, or `zeroBytes` zero bytes, without envelope encoding. |
| `send-frame` / `expect-frame` | Send or compare literal `wireHex` bytes. Decode and verify sender, recipient, sequence, nonce and ciphertext fields. `noncanonical:true` marks the overlong top-level CBOR map length; preserve those original bytes. |
| `expect-close` | Await the close and compare numeric code exactly. |

Hex uses lowercase byte pairs; legacy base64url is unpadded. No fixed sleeps are
permitted: forwarded frames provide same-socket ordering barriers for gate
changes. Each receive/close, setup and cleanup must finish within `stepTimeoutMs`
(2,000 ms), a test bound rather than a production latency objective. Close all
opened sockets after each scenario. Lifecycle controls may remain queued after
replacement/revocation; do not consume a different socket's queue by mistake.

`scripts/gen-transcript-bytes.ts` prints regenerated explicit frame examples using
the protocol encoder. From the root, run
`pnpm -F @shellbell/relay-node exec tsx ../../packages/relay-core/scripts/gen-transcript-bytes.ts`
and format the reviewed JSON with Biome. Preserve field expectations and literal
bytes together. A fixture-version change requires a compatibility decision; the
fixtures do not authorize wire, crypto, replay or persistence changes.

## Additional contracts

Exact clock boundaries, corrupt-state rejection, durable attempt reservations,
generation fencing and held-provider completion behavior live in
`identity-store-contract.ts`, `notification-store-contract.ts`, `recovery-cases.ts`
and their runtime suites. They are executable TypeScript contracts. Other
languages must independently satisfy the documented atomic/lifecycle contracts
and fault cases; JSON transcripts alone do not qualify another storage driver.
Hibernation, Node shutdown and exclusive ownership checks remain necessary. No
fixture contacts Expo, a device, an installed service or a production relay.

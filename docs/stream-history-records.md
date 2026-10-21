# Bounded stream history records

## Negotiated raw continuation

The optional subscribe `extensions` field requests a per-view contract. The
computer recognizes the atomic set `continuation-v1`, `source-status-v1`,
`checkpoint-v1`, `applied-v1`; a partial set enables none of them. Unknown names
add no capabilities. `stream.accepted` precedes extended records. No acceptance
means legacy records, and an older computer drops the optional subscribe fields.
The mobile app currently uses that legacy path; phone checkpoint and recovery
implementation remains a prerequisite to requesting the extension set.

An accepted raw stream uses `vt-seed` instead of `vt-state`. Its flat metadata
contains geometry, generation, an opaque seed capture ID, cursor/alternate-screen
provenance, a disposition and a reason:

| Disposition | Payload and phone responsibility |
| --- | --- |
| `initial` | Bounded source history and live screen for an empty phone buffer |
| `discontinuity` | Live screen only; retain phone scrollback and insert a divider explaining that rows may be missing or repeated |
| `replace` | Full bounded Herdr idle history; label that earlier phone rows were replaced |

`retained: true` on subscribe requests a reconnect discontinuity. It has no effect
without complete extension acceptance. Repeated reconnects must never append
the same seed history. The seed capture ID scopes application reports only;
native source-history capture proof remains a separate requirement for paging.
There is no continuous-cutover disposition without source range and row proof.

For a discontinuity, write `VT_CONTINUATION_PREAMBLE` as UTF-8 bytes and await
xterm's write callback before resizing. It cancels an unfinished parser token,
leaves alternate screen, resets modes and clears live cells while retaining
normal scrollback. After resizing, establish tab stops, insert the divider and
apply the screen-only seed. Resizing before the clear can scroll old live cells
into retained history. A write callback proves parsing into xterm, not painting
on the device display. Checkpoint restore must reproduce parser state as well as
visible cells; serializing at an arbitrary byte offset cannot establish that.

Ordinary `stream.ack` acknowledges bounded native-log receipt and releases
transfer credits promptly. `stream.applied` separately names the subscription,
capture, generation and offset after the seed. It may advance only after xterm
and the in-memory checkpoint have committed those bytes. Application reports
cannot authorize a continuous source join by themselves.

`stream.status` carries no terminal content. Its capture, generation and offset
identify the last completely admitted transfer; `quiescent` additionally certifies a
caught-up source probe. Pending work reports `catching-up`, and failed or timed-out
probes report `paused`. A single coalescing slot keeps status independent of the
four data credits. All these records still use the encrypted direct route.

## Snapshot history

Bounded streams carry every terminal view over the secure-v2 direct route; there
is no negotiation or legacy path. They transport reassembled CBOR logical records
between the service and phone, and the agent and mobile endpoints share the sender,
receiver and record helpers. These are
logical records inside transfers, not new outer envelope types. The
[generated protocol reference](protocol.md) and
[shared stream schemas](../packages/protocol/src/stream-wire.ts) own their respective
wire limits.

All objects have strict shapes. Every counter is a safe nonnegative integer and
`requestId` uses the existing 22-character stream ID schema. Common fields are:

```ts
{ kind: "history", generation: number, requestId: string, before: number }
```

A page adds:

```ts
{
  status: "page",
  from: number,
  to: number,
  oldestAvailable: number,
  nextBefore: number,
  lines: Line[]
}
```

Pages contain 1-200 physical rows, including empty rows. `to === before`,
`from + lines.length === to`, `nextBefore === from`, and `oldestAvailable <= from`.
Range addition must stay within the safe integer range. A page never guesses a
boundary from an empty native response.

A boundary adds only:

```ts
{ status: "boundary", reason: "end" | "truncated", oldestAvailable: number }
```

`end` requires `before === oldestAvailable`; `truncated` requires
`before < oldestAvailable`. Temporary unavailability is neither boundary.

## Losslessness and limits

The entire encoded record, including metadata, must fit in 65,536 bytes. A row has
at most 2,048 runs and 4,096 cumulative cells, calculated as
`sum(run.n ?? codePoints(run.t))`. Each run retains the existing 4,096 UTF-16 code
unit text limit and declared width `n` from 0 through 4,096. Text must contain
Unicode scalar values; isolated UTF-16 surrogates are rejected. Color values are
palette indices or exact RGB triples, with each component from 0 through 255.

Every admitted text string, declared width, color, style and optional wrap flag
is preserved, including explicit `false`. There is no style fallback, wrapping,
padding, cropping, normalization or automatic row skipping. The history geometry
limit is independent of the viewport's 512-column limit. Its cost is explicit
refusal of unusually wide historical rows; raising it requires layout/device
qualification.

## Pure helpers

`prepareStreamHistory(source)` accepts a complete boundary or a candidate page
without `nextBefore`. It returns one of:

- `{ ok: true, record, bytes }`: an independently owned record and CBOR bytes.
- `{ ok: false, code: "history-line-too-large", before }`: the requested newest
  row cannot be represented. The original cursor is returned unchanged.
- `{ ok: false, code: "invalid-transfer" }`: malformed shape, ID, counter, range,
  scalar text or run value. Individual run text/width violations are malformed;
  row run-count, cumulative-cell and encoded-byte excess are oversized.

The candidate contains at most 200 rows and ends exactly at `before`. Packing
walks newest to oldest, selecting the largest fitting contiguous suffix. An
oversized older row stops extension, so the returned `nextBefore` reaches that
row on the next explicit request. Malformed admitted data fails the request.
Rows older than an extension-stopping boundary are not examined. Container,
run-count and text-length limits precede nested processing. Each bounded run is
encoded and accumulated before whole-row encoding; bounded row sizes are summed
before encoding complete candidates. Every potentially fitting candidate is
measured because shrinking CBOR counter headers can make a larger suffix fit
after a smaller one overflowed. Only the current candidate and best bytes are
retained, costing at most 200 bounded complete-record encodes per request.

`StreamHistoryRecordSchema` validates complete records, including the full byte
limit, and copies accepted lines, runs and RGB tuples. `decodeStreamHistory(meta,
bytes)` first applies the existing bounded CBOR byte/depth/scalar checks and then
the record schema. Transfer `kind`, `generation`, `requestId` and `before` must
agree exactly. Errors are content-free `ProtocolError("malformed")` values.

## Endpoint obligations

Backends establish retention boundaries and capture epochs. A native read window
or busy backend returns unavailable rather than a false `end`/`truncated` response.
For a native fetch-window limit, `stream.error` keeps code `history-unavailable`
and adds optional `historyReason: "fetch-window"`. Updated phones keep loaded
rows and live output, explain the terminal's read limit, and stop older-page
retries for that capture. This does not claim that the terminal deleted its
history. Old phones ignore the optional field; old hosts still produce the
generic retryable error. A fresh subscription can acquire a new capture.
Herdr's certified screen count comes from the same bracketed native facts as
its capture token, rather than the event cache's possibly older history count.

Capture tokens originate from the actual capture. Subscription and pending-request
ownership fence resets, reconnects and session replacement; a later viewport
capture alone must not invalidate a legitimate in-flight history page. Native
changes that invalidate coordinates still revoke it: Herdr's observer revokes
captures on a changed viewport, while iTerm2 can retain stable native history
coordinates across ordinary output.

The first acknowledged snapshot fixes the subscription's history origin. If
that snapshot has no usable capture (for example, while a full-screen program
is running), older-history requests return `history-reset`. The phone offers
Refresh history, which opens a fresh subscription and capture; later viewport
updates cannot rebind the original origin. Requests before the first snapshot is
acknowledged, and temporary busy or flow-control failures, remain retryable.

Completed snapshots and diffs are acknowledged immediately, releasing the next
live frame without the 500 ms batching delay. Partial transfers and history
retain bounded acknowledgement batching and deadlines.

Reconnect discards an empty history cache, but retains loaded rows and explicit
gaps as detached reading content. Refresh replaces that content even when the
new capture ends at an empty boundary. A temporarily unavailable refresh keeps
the old rows visible and offers Retry history against the new capture. When
live output advances beyond the captured origin, Refresh history becomes
available to acquire the omitted newer rows.

An explicit UI skip of an impossible row moves to `before - 1` and records an
indexed gap. No pure helper skips automatically or fetches another page. The mobile
history window is bounded to 5,000 normalized rows and 4 MiB with bounded gap
metadata; layout uses source anchors rather than treating xterm scrollback as the
history authority.

Integration tests cover bounded delivery and recovery without real terminals.
Physical memory, virtualization, selection and anchor behavior still require
[device QA](../apps/mobile/QA.md#terminal-rendering-and-history). See
[computer streaming](architecture/computer-agent.md#screen-history-and-input-correctness)
and [mobile presentation](architecture/mobile-terminal.md).

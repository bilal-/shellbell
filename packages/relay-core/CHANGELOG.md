# @shellbell/relay-core

## 0.1.0

### Minor Changes

- 787ff5f: Keep unauthenticated sockets to 32 per computer, replacing the oldest when another arrives, so a flood against a known computer fingerprint can no longer hold every connection slot; signed-in connections keep theirs. Reconnecting during a sustained flood still depends on edge rate limits. The Node relay also refuses new upgrades with 503 while 1024 unauthenticated sockets are open across all computers (`--max-pending-connections`).

### Patch Changes

- d44c29a: Deliver the computer's pairing answer to the pairing socket that sent the request. A phone that retried after losing its first sign-in reply could previously have the answer sent to the idle earlier socket and wait until pairing timed out.
- 4f68d15: Check a revocation proof attached to a signed-in phone's unpair request the same way as a proof-only submission. A proof from an earlier pairing, or one that does not verify, now gets a `stale` receipt and leaves the current pairing in place instead of deleting it and storing a tombstone the computer refuses to apply.

## 0.0.4

### Patch Changes

- Updated dependencies [5202bd4]
  - @shellbell/protocol@0.2.0

## 0.0.3

### Patch Changes

- Updated dependencies [3a94500]
- Updated dependencies [874b3ae]
- Updated dependencies [279b85f]
  - @shellbell/protocol@0.1.0

## 0.0.2

### Patch Changes

- 93cba0f: Read the mobile native version and both relay runtime version responses from
  their component package metadata. Keep the Cloudflare relay, Node relay and
  shared relay core on one release version.
- Updated dependencies [9084eb1]
- Updated dependencies [9084eb1]
  - @shellbell/protocol@0.0.2

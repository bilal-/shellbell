---
"@shellbell/relay-core": patch
---

Check a revocation proof attached to a signed-in phone's unpair request the same way as a proof-only submission. A proof from an earlier pairing, or one that does not verify, now gets a `stale` receipt and leaves the current pairing in place instead of deleting it and storing a tombstone the computer refuses to apply.

---
"@shellbell/relay-core": patch
---

A burst of sign-in frames on one connection costs the relay one signature check
instead of one per frame, so an unauthenticated client cannot tie up its CPU.

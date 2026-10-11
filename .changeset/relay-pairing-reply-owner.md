---
"@shellbell/relay-core": patch
---

Deliver the computer's pairing answer to the pairing socket that sent the request. A phone that retried after losing its first sign-in reply could previously have the answer sent to the idle earlier socket and wait until pairing timed out.

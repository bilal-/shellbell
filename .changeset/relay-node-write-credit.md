---
"@shellbell/relay-node": patch
---

A Node relay keeps counting the bytes still queued on a socket it closed, until they are
written or the socket is gone, so reconnecting clients that never read cannot hold memory
past the relay's queue limit.

---
"shellbell": patch
---

Log why a direct connection attempt failed: "v2 transport failed" now includes a
reason code and the phase the attempt reached, never addresses or candidates.
The warning for a phone that has not finished its handshake now states the 15
second deadline the computer actually waits, instead of 10 seconds.

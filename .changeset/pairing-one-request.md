---
"@shellbell/relay-core": patch
---

The relay refuses a phone's second pairing request while its first is still
waiting for the computer's answer, so that answer cannot reach the wrong socket.

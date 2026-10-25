---
"shellbell": patch
---

Show when a pairing code expires. `shellbell pair` prints "Valid until 10:29" above the
code, the QR carries its closing time so a new phone app refuses a stale code before
connecting, and a code replaced by a newer one says so instead of "pairing window closed".

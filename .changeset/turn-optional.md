---
"shellbell": minor
---

TURN is now optional on each computer. It stays on by default; turning it off
(Mac app Settings → General → **Allow TURN fallback**, or
`shellbell config set turn off`) keeps terminal data off TURN servers. The
computer then requests no TURN servers and accepts a connection only when it can
show the route is direct, rechecking while it stays open; it refuses TURN routes
from either side, including ones the phone offers. Phones on networks that block
direct connections, and some routes through strict NATs, cannot reach a computer
with TURN off.

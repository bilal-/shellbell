---
"shellbell": minor
---

TURN is now optional on each computer. It stays on by default; turning it off
(Mac app Settings → General → **Allow TURN fallback**, or
`shellbell config set turn off`) keeps every byte of terminal traffic off TURN
servers. The computer then requests no TURN servers and refuses any connection
routed through one, including a TURN route the phone offers. Phones on networks
that block direct connections cannot reach a computer with TURN off.

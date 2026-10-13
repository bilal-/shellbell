---
"shellbell": minor
"@shellbell/protocol": minor
"@shellbell/relay-core": minor
"@shellbell/relay": minor
"@shellbell/relay-node": minor
---

TURN is now optional on each computer. It stays on by default; turning it off
(Mac app Settings → General → **Allow TURN fallback**, or
`shellbell config set turn off`) keeps terminal data off TURN servers:

- The computer tells the relay when it signs in, and the relay gives none of
  that computer's phones TURN servers, clearing any a phone already holds before
  announcing the computer. The relay confirms this in `auth-ok`; with an older
  relay the computer logs a warning.
- The computer requests no TURN servers and accepts a connection only when it
  can show the route is direct, rechecking while it stays open.

Phones on networks that block direct connections, and some routes through
strict NATs, cannot reach a computer with TURN off. Older clients and relays
ignore the new fields.

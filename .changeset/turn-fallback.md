---
"shellbell": minor
"@shellbell/protocol": minor
"@shellbell/relay-core": minor
"@shellbell/relay": minor
"@shellbell/relay-node": minor
---

Add a TURN fallback for networks that block direct WebRTC connections. A relay
configured with TURN gives signed-in computers and phones short-lived TURN servers
when they sign in and on request (`ice-refresh` / `ice-servers`), and each new
WebRTC attempt uses them alongside STUN. The TURN server only forwards the
encrypted data channel; terminal data stays end-to-end encrypted and never goes
through the relay. The Cloudflare relay issues 24-hour Cloudflare TURN credentials
when the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets are set; without them, and
on the Node relay, devices keep using STUN only. Older clients ignore the new
sign-in fields.

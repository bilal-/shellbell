---
"@shellbell/relay-core": patch
---

Keep unauthenticated sockets to 32 per computer, replacing the oldest when another arrives, so a flood against a known computer fingerprint no longer stops that computer or its phones from reconnecting. The Node relay also refuses new upgrades with 503 while 1024 unauthenticated sockets are open across all computers (`--max-pending-connections`).

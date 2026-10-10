---
"@shellbell/relay": patch
---

Refuse new connections to a computer with 503 while 64 of its sockets are not signed in, counting sockets that are still waiting for the peer to answer the close handshake, so peers that ignore close frames cannot pile up sockets on one computer.

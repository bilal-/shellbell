---
"shellbell": patch
---

The macOS service gives up on an iTerm2 connection that stops answering, during
the API cookie request or the WebSocket handshake, and retries instead of
waiting forever.

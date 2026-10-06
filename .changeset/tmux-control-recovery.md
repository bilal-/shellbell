---
"shellbell": patch
---

Reconnect a stalled tmux control client after a request times out, preventing late
replies from being assigned to another pane. Existing tmux sessions keep running.

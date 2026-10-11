---
"shellbell": patch
---

Keep a tmux session connected when its screen shows a line starting with `%exit`,
`%output` or another control-mode word. That text is now treated as part of the
captured screen instead of ending the tmux connection.

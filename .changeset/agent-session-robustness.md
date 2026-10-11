---
"shellbell": patch
---

Keep a tmux session connected when its screen shows a line starting with `%exit`,
`%output` or another control-mode word. That text is now treated as part of the
captured screen instead of ending the tmux connection. The computer also forgets
screen state for session IDs a phone asked to view but that were never captured,
so repeated requests for missing sessions no longer grow its memory. A closed
terminal session no longer reappears on phones when a slower, older session list
finishes after the newer one. Phones removed while the computer was offline no
longer keep their private notification slots, which could stop a newly paired
phone from turning on private notifications; leftover slots are cleared at start.

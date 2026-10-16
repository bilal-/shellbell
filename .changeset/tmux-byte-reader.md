---
"shellbell": patch
---

Read tmux's control connection as bytes, so a character split across tmux messages is kept
intact and pane output can be passed on exactly. tmux's newer `%extended-output` lines are
recognised as output too.

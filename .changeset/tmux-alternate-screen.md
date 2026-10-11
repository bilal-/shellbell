---
"shellbell": patch
---

Tell phones when a tmux pane is showing a full-screen program such as vim, less or top, so the phone can switch to sending each key straight to the terminal. The flag is read while the pane is being captured and is left out for iTerm2 and Herdr sessions, which do not report it.

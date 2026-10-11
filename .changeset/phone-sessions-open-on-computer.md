---
"shellbell": patch
---

Behaviour change: a session created from a phone now always opens in a terminal
window on your computer. A new iTerm2 tab opens as before. A tmux or Herdr
session opens in iTerm2, or in Ghostty when iTerm2 is not available, instead of
running detached where only the phone could see it. If no terminal app on the
computer can show it, the computer refuses with a message the phone shows, and
nothing is started. If the window fails to open, the new session is closed
again. Splitting a tmux session, or adding a window to it, from the phone needs
a terminal window on the computer that already shows that session; Herdr splits
and terminal plugin sessions can no longer be created from the phone.

---
"shellbell": minor
---

tmux and Herdr sessions opened from the phone can now appear in Apple's Terminal, so a Mac with
tmux or Herdr no longer also needs iTerm2 or Ghostty. Terminal opens a private one-time script
that deletes itself; opening it needs no Automation permission. iTerm2 and Ghostty are still
used first when they are installed. A Mac with none of iTerm2, tmux or Herdr now says why:
Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to
use a terminal from a phone. The Mac app, `shellbell doctor` and the phone use the same words,
and a closed iTerm2 that isn't installed is listed as not installed rather than closed.

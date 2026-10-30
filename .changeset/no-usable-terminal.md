---
"shellbell": patch
---

A Mac with none of iTerm2, tmux or Herdr now says why Shellbell needs one: Apple's Terminal only
lets other apps see plain text and type whole lines, which isn't enough to use a terminal from a
phone. The Mac app, `shellbell doctor` and the phone use the same words, and the missing
terminals are no longer called optional beside that message. A closed iTerm2 that isn't
installed is listed as not installed rather than closed, while anything iTerm2 itself reports,
such as its Python API being off, still shows wherever it is installed.

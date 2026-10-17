---
"shellbell": minor
---

Explain each terminal's setup in plain words and ask macOS about iTerm2 only when you ask.
The service reports why iTerm2, tmux or Herdr is not connected (iTerm2 closed, Python API
off, waiting for you to connect, blocked by macOS or iTerm2, a dialog left unanswered, no tmux
session, Herdr not running, or Herdr working with limits). `shellbell connect iterm2` starts
the one step that makes macOS ask, `shellbell doctor` shows the same reasons and fixes, and
phones are told when a terminal needs a step on the computer. Installs that already paired a
phone keep connecting to iTerm2 as before.

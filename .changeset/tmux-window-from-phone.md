---
"shellbell": patch
---

A tmux window opened from the phone in iTerm2 or Ghostty stays open with the Mac app. The
app's service misread tmux's answers, decided the window never appeared, and closed the new
session. The same misreading stopped a Codex conversation in tmux from linking to its pane.

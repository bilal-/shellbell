---
"shellbell": patch
---

Codex sessions open in Chat on the phone again with Codex 0.166 and later, which run every session
in one shared background process. Shellbell now matches each Codex window to its session by the
name Codex shows in the window's title, and keeps the terminal whenever that match isn't certain,
such as before Codex has named a new session. Codex 0.166's history is now checked as supported.

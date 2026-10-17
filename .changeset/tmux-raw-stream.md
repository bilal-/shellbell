---
"shellbell": minor
---

tmux sessions can now be streamed to the phone as the terminal's own output, so the phone's
terminal handles scrolling, history and full-screen programs itself instead of rebuilding
them from snapshots. Only phones that ask for it receive the new stream; it uses one extra
tmux connection while a session is open on the phone and never creates tmux sessions. Other
phones, iTerm2 and Herdr keep using snapshots.

---
"shellbell": patch
---

A tmux session opened from the phone is kept only once its desktop window has actually attached.
Starting Ghostty or iTerm2 is not enough: on a locked Mac the app can start without attaching,
which left the session running with no window. Such a session is now closed, and the phone
says to unlock the computer and try again.

---
"shellbell": patch
---

A tmux session opened from the phone is kept only once its desktop window has actually attached.
Starting Ghostty or iTerm2 is not enough: the app can start without its window attaching,
which left the session running with no window. Such a session is now closed, and the phone
says to unlock the computer and try again. Ghostty now opens in the foreground, because
Ghostty started in the background never opened its window.

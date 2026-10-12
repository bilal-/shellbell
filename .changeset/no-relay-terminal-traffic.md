---
"shellbell": minor
"@shellbell/protocol": minor
---

Behaviour change: the relay no longer carries terminal data. Terminal screens,
history, typing, the computer's hello and its session list only travel over the
direct WebRTC connection; the relay carries sign-in, pairing, connection setup
and notifications. With no direct connection the terminal stays paused while the
devices keep retrying, and the phone's "Use relay temporarily" choice is gone.
Both the computer and the phone refuse terminal data on the relay route, so an
older phone build can no longer stream through the relay either.

Private notifications are enrolled over the direct connection too, so a phone
that cannot connect directly receives generic notifications until it does.

---
"shellbell": patch
---

Ask macOS for less, and say why first. Shellbell asks to control iTerm2 only once iTerm2's
Python API is on, and no longer reads Git in Desktop, Documents, Downloads, iCloud Drive or
external volumes, which made macOS ask for those folders just to name a session's project.
`shellbell service install` on macOS now explains in plain words each question macOS may ask
next, and the install guide lists every prompt with what happens if you say no.

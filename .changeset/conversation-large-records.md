---
"shellbell": patch
---

Keep older conversation messages reachable past a very large transcript entry.
A tool result or message over 128 KB used to show as unreadable and cut the link
to everything before it, so the phone couldn't load earlier messages. The
computer now reads such an entry down to the parts it shows, marks its text as
too large to show, and keeps paging through it.

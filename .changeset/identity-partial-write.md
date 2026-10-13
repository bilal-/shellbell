---
"shellbell": patch
---

On filesystems without hard links, a failed write while creating the computer's
identity (a full disk, an I/O error) no longer leaves a partial identity file
that blocks every later start.

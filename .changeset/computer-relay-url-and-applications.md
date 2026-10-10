---
"shellbell": patch
---

Refuse relay URLs with a path, trailing slash, query or credentials when they are set with `shellbell config set relay` or the foreground override, instead of saving them and failing later when pairing opens. The Mac app now starts when installed in `/Applications`, whose standard root:admin group-writable permissions were previously refused by the launch check.

---
"shellbell": patch
---

Give repeated Herdr read errors a two-second retry window starting at the first
failure. Once a failed read settles past that window, a bounded bottom-screen
probe selects snapshot fallback or a visible stalled error instead of waiting
for twenty failed reads. Individual native requests retain their own timeouts.

---
"shellbell": patch
---

Fix headless service start and restart for legacy macOS installations without a
service-instance UUID. Supervised startup keeps ownership checks while avoiding
the lock already held by the supervising command.

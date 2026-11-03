---
"shellbell": patch
---

The Mac app keeps the Mac awake again after an agent newer than Shellbell has tested starts. In
0.15.0, once that happened, the app could no longer read the service's status, so keep-awake and
closed-lid quietly stopped while their switches still showed on, and the Mac could sleep
overnight. `shellbell connect` and `shellbell config set conversations` failed the same way.

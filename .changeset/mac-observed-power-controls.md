---
"shellbell": minor
---

Rework Mac keep-awake settings with positive controls, independent idle/display/lid
status and read-only macOS power details. Verify owned idle assertions and fresh
global sleep state before reporting protection. Existing preferences are retained;
battery idle protection stays opt-in and closed-lid access still requires AC.

When the helper detects its active sleep override turned off, closed-lid access
now pauses until explicit retry or a changed master/lid choice instead of silently
reacquiring it. Failed turn-off shows known activity and the failed change together.
Qualify administrator setup, sleep/wake and physical lid behavior on the exact
signed artifact before distribution.

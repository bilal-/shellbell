---
"@shellbell/mobile": patch
---

Stop terminal history scrolling from triggering redundant screen repaints. Restore the latest reading position when the terminal renderer reloads while continuing to render new output normally.

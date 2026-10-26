---
"shellbell": patch
---

Let the phone load earlier messages in long Codex sessions. The oldest row the phone got was
the cut-off line at the start of the computer's read window, shown as "Earlier content is not
loaded", and no older page could start from it, so paging stopped at once with "Earlier
messages aren't available right now". That line is now hidden like it is for Claude Code, and
paging continues from the first full message.

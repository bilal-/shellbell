---
"shellbell": patch
---

Hide the session bookkeeping records that current Claude Code versions write into
transcripts, so agent conversations no longer show "Unsupported record" entries,
and show tools Claude runs itself, such as web search, as ordinary tool steps.
Keep the conversation view when a large record such as an image fills the newest
part of a transcript, instead of falling back to the terminal.

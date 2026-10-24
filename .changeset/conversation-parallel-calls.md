---
"shellbell": patch
---

Stop the conversation view resetting while Claude runs tools in parallel. Each
parallel call briefly made the newest transcript entry look like a rewind, so the
phone cleared the conversation and lost its place. The computer now recognises
those entries as part of the same reply.

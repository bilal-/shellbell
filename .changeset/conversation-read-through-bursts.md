---
"shellbell": patch
---

Stop the conversation view clearing during large tool output. When an agent
wrote more than about 256 KB at once, the computer skipped ahead to the newest
part of the transcript and the phone had to start over, losing its scroll
position. The computer now reads through bursts of up to 4 MB without a pause,
so the conversation stays continuous.

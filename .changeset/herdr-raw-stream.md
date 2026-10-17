---
"shellbell": minor
---

Herdr sessions can be streamed to the phone the same way as tmux. Herdr has no output stream
with its history, so the computer redraws the pane from Herdr's reads: up to 1,000 lines of
history, then the rows that change. An agent's transcript (Claude Code, Codex) is read again
each time the agent finishes, so the phone's history holds the whole conversation, and lines a
shell prints no longer go missing in the middle.

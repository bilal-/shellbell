---
"shellbell": minor
---

Show Codex sessions as a conversation in tmux, iTerm2 and Herdr panes that Herdr doesn't report.
Run `shellbell integration install codex` once: it adds a small SessionStart hook that records
which terminal pane started which Codex session, and Shellbell matches it to the pane showing
that session. Codex asks you to review the new hook the next time it starts. Remove it with
`shellbell integration uninstall codex`; other Codex hooks and settings are left as they are.

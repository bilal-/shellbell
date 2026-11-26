---
"shellbell": patch
---

Chat now finds Claude Code sessions that use another config folder through `CLAUDE_CONFIG_DIR`, such as `~/.claude-work`. Before, Chat for those sessions stayed empty and invited a first message. Chat also shows the lines Claude Code prints between turns: how long a turn took, the recap after time away, "Conversation compacted", usage-limit notices, scheduled tasks and slash commands. For Codex, Chat now ends each turn with how long it took, like Codex's own screen, in place of separate "Working" and "Complete" lines.

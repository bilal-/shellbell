---
"shellbell": minor
"@shellbell/protocol": minor
---

Chat on the phone opens right, stays right and never loses a message.

- Each agent session now says whether its chat can be shown before you open it: found, not
  started yet, or not available and why. A new agent's first message can be sent from Chat.
- A message sent from Chat is checked on the computer just before it is typed: if the agent
  changed, quit, is waiting for an answer or its screen can't be checked, nothing is typed and
  the phone says why.
- An open chat does no work while nothing changes: no identity checks, folder scans or frames
  while idle, where it used to make several a second. A new message is sent as soon as it is
  written, and a chat on screen takes turns with terminal output instead of waiting behind it.
- A Herdr pane opening or closing no longer resets every open chat; the chat reopens as soon as
  Herdr settles, with its first page straight after.
- Messages Claude has queued while busy are reported beside the conversation.
- New Claude bookkeeping records and agent versions newer than tested no longer show warnings
  in Chat; `shellbell doctor` mentions newer agent versions instead.
- A new session from the phone opens as a tab in a window or workspace already showing on the
  computer, in Herdr, tmux and iTerm2, and falls back to a new window when none shows. Herdr
  splits work from the phone. The computer tells the phone where each one opened, so its
  notice no longer guesses, and iTerm2 hosting tmux or Herdr opens a new window if its front
  window closes as the tab opens.

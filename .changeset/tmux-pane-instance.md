---
"shellbell": patch
---

Tell the phone which tmux server each pane belongs to. A restarted tmux server numbers its panes
from the start again, so a phone that had a pane open could otherwise reopen another pane under
the same name.

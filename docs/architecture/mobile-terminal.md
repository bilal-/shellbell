# Mobile terminal presentation

The mobile stream owner decrypts and admits bounded screen/history data.
`ScreenView` projects it into source-keyed rows. Terminal mode imports those rows
into an offline, unmodified xterm.js buffer; Reading mode builds native paragraphs
for wrapped prose. Neither view resizes the remote terminal.

## Ownership

xterm owns terminal scrolling, keyboard and IME input, selection, search and HTML
serialization. A touch gesture bridge calls xterm's public scrolling API because
xterm 6 does not wire phone swipes into its viewport. Shellbell owns encrypted delivery, backend identity, bounded
history acquisition, source-row keys and native UI. The cell-to-ANSI adapter is
necessary because the current backend contract supplies snapshots rather than a
replayable PTY stream.

The native-to-WebView bridge allows one pending frame and coalesces later updates.
Ordinary updates repaint only the live grid. Appended history uses xterm scrolling
when its source relationships are known; prepend, replacement, soft-wrap changes
and geometry changes rebuild the bounded buffer in one write. They do not reset
the terminal between frames.

Document IDs isolate callbacks across reloads. Literal input requires the optional
`terminalInput` backend capability; host-native paste requires `terminalPaste`.
The protocol owns both requests, and the existing pairing ledger deduplicates
them across transport changes. Explicit composer retries after unconfirmed
delivery reuse the request ID for unchanged text. The ledger is bounded and is
lost on service restart; input is never automatically replayed. All terminal
content remains end-to-end encrypted.

## Raw terminal streams

The phone subscribes with `mode: "vt"`. A computer whose backend reports
`vtStream` (tmux and Herdr) answers with `vt-state` and `vt` transfers; anything else
sends snapshots, which the phone still shows. `MobileScreenStream` keeps a
bounded append-only `VtLog` (starting point plus up to 4 MiB of bytes) and asks
for a fresh starting point after an offset gap or when the log is full, never
applying bytes out of order. `TerminalVtBridge` replays that log into the
WebView one acknowledged message at a time (at most 256 KiB each), so a reload,
a remount after Reading view or a new generation starts from the starting point.
In raw mode xterm owns the screen, cursor, modes, scrolling and history; the
row-key, older-history and mouse paths are off. xterm's answers to terminal
queries and its focus and mouse reports are dropped: only keys xterm reports
through `onKey`, native input and pastes reach the shell. With host paste the
plain text goes to the computer, which brackets it. The WebView reports the
alternate screen, the cursor row and the visible rows, for Live keys, secret
input and a waiting agent's choices. The alternate screen counts only for
sessions whose computer reports it, since Herdr's redrawn stream never
switches to it. Reading
view asks for snapshots while it is on, and an `unsupported` close switches the
view to snapshots until it is reopened.

The renderer also contains a continuation path for the atomic extension set, which
`MobileScreenStream` does not yet request. Its native `VtReplayLog` retains canonical
normal-buffer history plus an exact seed and byte tail within a shared 4 MiB
budget (history up to 2.5 MiB and 10,000 rows). At a discontinuity the renderer
captures bounded history, inserts a visible gap/overlap divider, and commits all
history parts in native memory before applying the new seed. Reload replays that
history, seed and tail instead of guessing partial parser state. Document, source,
epoch and operation identity fence stale replies; parser acknowledgement advances
application separately from native receipt. The connection owner must dispose an
old log before allocating its replacement and bind it to the same session.

The checkpoint bridge is covered by headless xterm and generated-document browser
tests. Negotiation, connection lifecycle ownership, recovery states and provenance
checks remain required before enabling it. Phone restore timing and memory use
still need device qualification.

## Live viewport

Following keeps the lowest occupied live source row or cursor visible. This
includes bottom status rows even when the cursor is above them. Empty trailing
rows do not pull a normal shell prompt off-screen. Scrolling or panning away
preserves the source anchor; the round Jump to live button in the pane's
bottom-right corner restores follow. Reaching the top of the scrollback requests
the next older page; there is no Load older bar. A "Loading older…" row floats
over the top while a page loads, and only a failed or limited history takes an
inline row with its action (Retry history, Skip line or Refresh history).
Gap and status text says what happened in plain words, for example "Some lines
scrolled past unseen" or "Older lines stopped loading because the terminal kept
changing", rather than naming internal history states.

xterm keeps the computer's columns and live-grid dimensions. An outer pan
accommodates a grid larger than the phone. Fit measures available columns and
scales the font without changing the host session. The protocol has no semantic
footer marker, so the renderer does not extract or duplicate tool-specific bars.
Native input accessories and system insets remain outside the terminal pane.

## Selection and accessibility

Terminal selection uses xterm's public buffer and selection API. It starts from
Select text in the session menu or a still 450 ms long press on the terminal,
which selects the pressed line. While it is on, the header becomes a contextual
bar with Done, Select all and Copy; Copy is never shown disabled, and a completed
copy ends selection. Touch handles adjust that range; search (also in the session
menu) and Select all can select off-screen loaded history.
Explicit copy requests export plain text or SerializeAddon HTML, bounded to
4 MiB each. Changed source cells, eviction or column changes invalidate the range;
unrelated output preserves it. Copy is rejected during a paint in progress.

Reading mode's Select text menu action opens a frozen native sheet for the visible
paragraph span. It is bounded to 128 source rows and 32 KiB of UTF-8, with labelled
truncation. New output does not mutate the sheet. Clipboard access always requires
a user action; selection never uploads terminal content to another service.

xterm's screen-reader mode follows native accessibility state. Physical keyboard
attachment hides the input bar and returns input focus to xterm. Drafts survive
attachment and network changes, and clear only after host acknowledgement.

The phone keyboard only types into native fields; it never focuses xterm. The
**command bar** is the default: a draft stays local until Send, and Tab with a
draft sends the draft and Tab for shell completion. With nothing drafted, Send is
an Enter button that sends Return; a long press on it fills the field from draft
history. Above it, a keys row sends at once and stays in short panes; its right
edge fades while more keys lie beyond it. A shell session's row starts ^C, Tab,
arrows, Esc, Enter; a session whose `agent` is reported (Claude Code, Codex)
starts Esc, arrows, Enter, Shift-Tab, 1, 2, 3, ^C, and its bar reads "Message
Codex…" with Return starting a new line; Send submits the whole message once,
as one `input.paste` with submit where the backend has `terminalPaste`. Esc and
^C are tinted amber. While a session
is `blocked`, the keys row gives way to a waiting strip: one line of the question
and large replies, one per choice when the screen near the cursor shows a single
unambiguous numbered menu with one highlighted row (`src/input/agentPrompt.ts`),
which types its digit, otherwise Yes, No, Enter and Esc. A reply restores the keys
until the state changes again. The close button also restores the keys without
sending input, including while offline and in compact panes. Dismissal lasts
until the session state changes, so updated screen text does not take the keys
away again. **Live keys**, a keyboard button in the field,
swaps the command bar for a field whose keystrokes go to the terminal in short
batches, for vim, less and other full-screen programs. It turns on when the
session reports `alternateScreen` (tmux reads `#{alternate_on}` while capturing;
iTerm2 and Herdr do not report it) and off when that ends; a manual choice holds
until the next change. Agent sessions show the button only while
`alternateScreen` is true. **Secret** input is a hidden line for password
prompts, offered when the cursor row ends with a password prompt and never saved
to draft history. In a shell session waiting for a reply, reply chips send y and
n as single keys; agent sessions show no reply chips, since their keys row and
waiting strip already cover them. Older hosts and
Reading view keep the command bar and keys without Live keys. No local echo is
invented while the host is catching up.

## Extension boundary

Screenshots cannot reveal arbitrary terminal modes. General mouse gestures,
extended keyboard protocols, terminal bells, OSC 8 links and inline images need
authoritative backend metadata or a negotiated raw PTY stream. The current Herdr
Mouse mode offers guarded atomic clicks. Future integrations must preserve
source-grid validation, bounded input and the encrypted transport boundary.

Dependency pins, input contracts, security boundaries and verification commands
live in the [renderer guide](../mobile-terminal-renderer.md). Physical-device
qualification belongs to [mobile QA](../../apps/mobile/QA.md) and the
[release checklist](../before-first-release.md).

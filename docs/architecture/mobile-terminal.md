# Mobile terminal presentation

The mobile stream owner decrypts and admits bounded screen/history data.
`ScreenView` projects it into source-keyed rows. Terminal mode imports those rows
into an offline, unmodified xterm.js buffer; Reading mode builds native paragraphs
for wrapped prose. Neither view resizes the remote terminal.

The focused session menu offers creation for that session's terminal engine and
prefers its currently reported desktop host. The computer screen's **New session**
picker retains all advertised engines and hosts. A Herdr session opened in Ghostty
therefore offers **New Herdr session in Ghostty** in its own menu. This opens a new
desktop window; adding a tab inside an existing Herdr workspace still requires
per-workspace desktop attachment evidence that Herdr 0.9.5 does not expose.

The computer's **+** picker lists each engine once, then shows its advertised
desktop launch destinations. Picking an engine or host does not create a session;
**Create window** sends the request. The configuration step offers **Fit phone**,
**Custom** columns and rows, and **Computer default**. Fit phone uses the
keyboard-closed reading area. Custom values must fit the protocol bounds;
Computer default omits the size preference. A disappearing launch destination
requires another explicit choice rather than silently switching hosts.

New independent terminal windows carry an optional preferred initial cell grid.
The phone measures its terminal area at the chosen font size before fitting the
remote screen. It keeps that measurement only in memory and ignores shorter
keyboard layouts. It also records the app window height with each measurement.
Outside Android keyboard shrinkage, a measurement from a different app window height is not reused;
a smaller split-screen window gets its own measurement or uses an estimate.
Before a matching measurement exists, it estimates the usable
window area after safe-area, navigation and input space. Requests are bounded to
40–240 columns and 24–100 rows; peers must keep these wire bounds unless a future
extension negotiates different limits. Only the cell grid travels to the computer, in the
encrypted creation request; phone pixel dimensions stay local. The host may adjust
the preferred size. Existing tabs, splits and sessions receive no resize request,
and older computers keep their existing initial-size behavior.

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

The focused phone view requests `mode: "vt"` with the complete atomic
`continuation-v1`, `source-status-v1`, `checkpoint-v1`, and `applied-v1` extension
set. A compatible computer accepts the set before sending `vt-seed` and `vt`
transfers. Older computers keep sending `vt-state` and `vt`; unsupported raw
sources use snapshots. Partial extension acceptance does not enable continuation.
Reading view explicitly uses snapshots. An `unsupported` raw close keeps that
focused view on snapshots across retries and mode changes until it is reopened.

`RetainedTerminal` owns one focused computer/session's native memory. Its
`VtReplayLog` retains canonical normal-buffer history, the exact seed, and the
received byte tail within a shared 4 MiB budget (history up to 2.5 MiB and 10,000
rows). The old allocation is disposed before its replacement is created. At an
unverified discontinuity, the renderer captures bounded history, inserts a visible
gap/overlap divider, and commits all history parts in native memory before applying
the new screen-only seed. The scope must match the same focused computer/session;
a new view cannot capture another view's buffer. A Herdr idle seed explicitly
replaces history, and the phone labels that replacement.

Reload replays history, seed, and tail instead of guessing partial parser state.
The bridge sends one acknowledged message at a time, at most 256 KiB. Document,
source, epoch, and operation identities fence stale replies. A reconnect preserves
a complete checkpoint. If a replacement seed arrives while the current document
is still materializing or restoring that checkpoint, or its renderer has failed,
the phone cancels the incoming seed and retains its only native copy. Recovery
waits for materialization before opening another subscription, with bounded
backoff; a failed renderer requires Reload. A completed restore wakes recovery
immediately without spending a source retry attempt while it was rendering.
Two explicit renderer rejections while restoring the same checkpoint request a
labeled full starting point rather than repeating an unusable restore. Renderer health follows the focused
view across subscription and route changes, while applied reports remain fenced
to the subscription that installed their source. Missing checkpoints require a full
seed and show a replacement notice. Switching to snapshots or an older computer's
raw format also labels the loss of retained raw rows. Closing the view, changing
session/computer, ending the session, or losing pairing/access releases native
terminal memory. Nothing is persisted to disk.

`stream.ack` acknowledges bounded native receipt promptly. Separate
`stream.applied` reports coalesce parser/checkpoint progress over 50 ms; a refused
transport admission leaves the report pending. Replaying a document never regresses
that reported floor, but current rendering progress starts over. This keeps a
reloaded terminal from claiming Live before its saved tail has been parsed.

The phone presents Live, Catching up, Paused with a reason, or Ended. Ordinary
receive/render progress stays in the fixed-height session header once terminal
content is available, so each received batch cannot resize the terminal by adding
a catch-up row. An empty view still shows initial loading, and paused output keeps
its reason and recovery controls. Over existing Terminal content, recovery notices
float above the top rows instead of changing the WebView's height. Reading view
keeps those notices inline. Ten seconds
without delivered output or a matching quiescent source status pauses the view;
twenty seconds requests a new source. Outstanding renderer work has its own
progress clock. Foreground stalled subscriptions retry at 250 ms, 1, 2, 5, 10,
20, then 30 seconds, retaining the 30-second cap while recovery is needed. Session
announcements cannot bypass backoff. Route interruptions and foreground resumes
revalidate the source; background views do not run recovery timers. Malformed
transfers require explicit Retry or a changed computer version. Oversized screens
also retry after changed terminal geometry. Renderer failure offers Reload; a
parser timeout detaches that document so a source retry cannot race it.

Older raw streams retain the bounded legacy `VtLog` and existing offset/overflow
refresh behavior. Raw mode uses xterm's normal scrolling/search buffer. The optional
`native-history-v1` extension requires the complete continuation set. An initial or
explicitly refreshed seed can identify a native history prefix; the phone verifies
its complete ordered physical text and geometry in xterm before requesting older
rows. Capture IDs and matching row counts alone never authorize a join. A divider
has no native paging anchor. Snapshots retain their anchored paging path.

Reaching the top requests one bounded page for that capture, generation and exact
oldest boundary. The phone stages the page in memory and rebuilds another xterm
from the older prefix, retained prefix, exact seed and byte tail. The visible
terminal remains available for input, selection and search until the new terminal
has caught up and passes its row proofs. Incoming output is buffered for that
rebuild, so the visible output can lag until the swap. Presentation preserves the reading offset
and unchanged selection, then commits application progress. Receipt acknowledgements
do not wait for that rebuild. Both old and staged native prefix allocations count
against the same 4 MiB budget, with 256 KiB reserved for arriving output; loading
stops before exceeding 10,000 history rows. Restore writes are bounded and report
parser progress to the foreground watchdog without claiming applied output.
An unrenderable page leaves the existing visible terminal in place and resumes its
unread byte tail. If live output erases or evicts the prefix during the rebuild,
the staged page is discarded and the existing visible terminal consumes its unread
tail. This keeps selection and reading positions attached to the surviving rows;
older paging stops until an explicit refresh.
Loaded rows remain searchable. Temporary history congestion offers a retry.
Capture expiry, a source reset, fetch limits or
memory pressure stop older loading and expose **Refresh history**, which explicitly
replaces the phone's history. A document reload abandons an unshown page and requires
a refresh before acquiring more older rows. No history is written to disk.

xterm's terminal-query answers, focus reports, and mouse
reports are dropped: only reported keys, native input, and explicit pastes reach
the shell. Host-native paste is bracketed by the computer.

Cursor and alternate-screen provenance gate inferred waiting choices and Live
keys. Herdr's guessed cursor and unknown alternate screen cannot enable them.
Secret-prompt masking remains conservative for both raw and snapshot views,
including visible rows when a cursor is unknown. A prior secret-input hint stays
available until a fresh screen is observed within the same computer/session.
Renderer status belongs only to its current source and cannot enable shortcuts
during checkpoint restoration.

Headless xterm, stream, connection-owner, and generated-document browser tests
cover these boundaries. Phone restore timing, peak memory, keyboard behavior, and
network recovery still require qualification on the exact device build.

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

Smaller host grids are horizontally centered and top-aligned, with a subtle
non-layout frame. The occupied bottom row affects following, never layout. The
surface reserves xterm's scrollbar gutter; source-cell coordinates continue to
come from the actual screen bounds. Empty gutters accept scrolling without
sending terminal clicks.

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
^C are tinted amber. While the session is `blocked`, the keys row gives way to
the waiting strip. A source-backed cursor and a single unambiguous highlighted menu permit choice
buttons (`src/input/agentPrompt.ts`). They send the displayed single-letter or Esc
reply hint when present, otherwise the choice number. Enter is used as a choice's
reply only when that choice is highlighted. Mode-switch hints such as Shift+Tab
do not change a choice's reply. Only an explicit y/n prompt on the current cursor
row permits Yes and No, sending one letter for y/n or the full word for yes/no.
Unknown or ambiguous prompts instead offer Up, Down,
Shift + Left and Esc. Enter is always visible beside the scrolling actions, along
with the close button; no inferred action adds Enter automatically. Navigation
keeps the strip open. An accepted reply, Enter or Esc restores the full keys until
the session state changes again: menu shortcuts may act immediately, so no extra
confirmation is implied. The close button restores the keys without sending input,
including while offline and in compact panes. Dismissal lasts until the session
state changes, so updated screen text does not take the keys away again.
**Live keys**, a keyboard button in the field,
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

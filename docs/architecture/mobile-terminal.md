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

## Live viewport

Following keeps the lowest occupied live source row or cursor visible. This
includes bottom status rows even when the cursor is above them. Empty trailing
rows do not pull a normal shell prompt off-screen. Scrolling or panning away
preserves the source anchor; Jump to live restores follow.

xterm keeps the computer's columns and live-grid dimensions. An outer pan
accommodates a grid larger than the phone. Fit measures available columns and
scales the font without changing the host session. The protocol has no semantic
footer marker, so the renderer does not extract or duplicate tool-specific bars.
Native input accessories and system insets remain outside the terminal pane.

## Selection and accessibility

Terminal selection uses xterm's public buffer and selection API. Touch handles
adjust that range; search and Select all can select off-screen loaded history.
Explicit copy requests export plain text or SerializeAddon HTML, bounded to
4 MiB each. Changed source cells, eviction or column changes invalidate the range;
unrelated output preserves it. Copy is rejected during a paint in progress.

Reading mode's Select text action opens a frozen native sheet for the visible
paragraph span. It is bounded to 128 source rows and 32 KiB of UTF-8, with labelled
truncation. New output does not mutate the sheet. Clipboard access always requires
a user action; selection never uploads terminal content to another service.

xterm's screen-reader mode follows native accessibility state. Physical keyboard
attachment hides phone key accessories and returns input focus to xterm. Older
hosts and Reading view keep the composer when xterm input is unavailable. Drafts
survive attachment and network changes, and clear only after host acknowledgement.

The input bar uses the same **Type directly** and **Draft command** choices in
both modes. Direct typing sends each keystroke; a draft remains local until
Send. Opening a draft blurs xterm and focuses the native field. Returning to
direct typing removes the draft field before focusing xterm, preserving unsent
text. No local echo is invented while the host is catching up.

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

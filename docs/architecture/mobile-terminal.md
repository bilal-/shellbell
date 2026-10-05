# Mobile terminal presentation and text selection

The mobile stream owner decrypts and admits bounded screen/history data. `ScreenView`
projects it into source-keyed rows. Terminal mode renders those rows using the
offline, unmodified xterm.js dependency; Reading mode projects soft-wrapped rows
into bounded native paragraphs. Neither view resizes the remote terminal to fit
the phone. Source anchors survive history prepend, layout changes and mode switches.
Dependency pins, generated offline assets and upstream attribution remain in
`apps/mobile/package.json`, `src/terminal/` and `THIRD_PARTY_NOTICES.md`.

## Live viewport

Terminal mode follows the lowest occupied live source row or the cursor,
whichever is lower. This keeps a terminal application's bottom status rows in
view even when its cursor is above them or hidden. Blank trailing rows do not
pull an ordinary shell prompt off-screen; painted background cells and text
decorations still count as occupied rows.

When the occupied source grid fits entirely, empty space above the grid aligns
its last row with the bottom of the terminal pane. Keyboard changes, rotation,
font size and Fit width use measured cell geometry and the pane's available
height. The native input bar and system insets remain outside that pane.

Scrolling away from Live preserves a source anchor. Status updates do not
interrupt that reading position; **Jump to live** returns to the current screen. The
renderer presents the laptop's rows once, with their original columns. The
protocol has no semantic footer marker, so it does not extract or duplicate a
tool-specific status bar over history. A source grid taller than the phone can
still require scrolling or a smaller font to see its upper rows.

## Select text

The explicit action opens a native selectable-text sheet with a frozen snapshot.
Terminal mode reports the first and last intersecting source rows, excluding the
extra renderer overscan row. The native bridge validates the source keys. Reading
mode uses visible paragraph keys and resolves their current source span when the
user opens the sheet. A partially visible paragraph is included as a whole,
subject to the caps; terminal rows include their full width, not just horizontally
visible columns. The sheet describes this scope.

- Maximum 128 source rows and 32 KiB of UTF-8 text; truncation is labelled.
- Row text is assembled with bounded lookahead so emoji split across styled runs
  remain intact. Spaces, source-row newlines and visible gap labels are preserved;
  terminal control characters are replaced with their display-safe equivalents.
- Opening/closing does not read or write the clipboard, fetch history, send input,
  or change the source anchor. New output does not mutate the open snapshot.
- Native selection provides selection handles and Copy. **Copy snapshot** writes
  the complete bounded snapshot only after an explicit press, with failure feedback.
- The modal owns its safe-area measurement and uses flexible layout, not device
  heights. A session change remounts the view to discard prior selection state.

No protocol, relay persistence, encryption, streaming budget or backend-input path
changes are involved. Selection never uploads terminal content to a new service.

## Verification and remaining limits

Unit/component coverage includes visible-range restriction, frozen snapshots,
explicit clipboard writes and failures, caps, Unicode, gap/control handling,
mode switches, unchanged-visible-set resizing, paragraph growth and session changes.
`scripts/qualify-terminal.mjs` checks source bounds against actual browser geometry,
alongside the existing anchoring, redraw and offline-resource checks.

Native handles, rotation and clipboard behavior require physical-device evidence;
see the [current qualification](../before-first-release.md).
The [release checklist](../before-first-release.md) remains the release authority.

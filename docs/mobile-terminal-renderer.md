# Mobile terminal renderer

Shellbell uses unmodified [xterm.js](https://github.com/xtermjs/xterm.js) for the
terminal buffer, keyboard and IME input, scrolling, selection, search and styled
copy. The document, font and addons ship offline in the app. Credits and full
licences are available from Settings → Open-source credits.

The computer currently supplies bounded cell snapshots and history pages, rather
than a replayable PTY byte stream. A small cell-to-ANSI adapter imports those rows
into xterm's buffer. It preserves the computer's columns, Unicode cells, styles
and known soft-wrap relationships. It does not run a second terminal emulator.

## Components

- `src/net` decrypts and admits screen/history data using the protocol's budgets.
- `ScreenView` projects source-keyed rows for Terminal and native Reading modes.
- `terminal/adapter.ts` encodes display-safe cells and styles into ANSI.
- `terminal/buffer.ts` imports history, appends ordinary scrolling output and
  repaints only the live grid on ordinary updates. Structural changes replay the
  bounded buffer in one write; they never call a full terminal reset.
- `terminal/bridge.ts` allows one pending frame and coalesces newer snapshots.
- `terminal/runtime.ts` hosts xterm and its addons inside the offline WebView.
- `terminal/selection.ts` adds touch handles through xterm's public selection API.
- `XtermView` owns document-scoped commands, input admission, clipboard actions,
  native search controls and renderer recovery.
- `InputBar` adds phone keys and optional command composition. Physical keyboard
  attachment hides the key guide and accessories. Older hosts and Reading view
  retain the composer when xterm input is unavailable.

## Pinned addons

| Package | Version | Use |
| --- | --- | --- |
| `@xterm/xterm` | 6.0.0 | Buffer, terminal rendering, keyboard and IME |
| `@xterm/addon-fit` | 0.11.0 | Measure available columns for font scaling |
| `@xterm/addon-search` | 0.16.0 | Search loaded history, match case and whole words |
| `@xterm/addon-serialize` | 0.14.0 | HTML copy of the current selection |
| `@xterm/addon-unicode-graphemes` | 0.4.0 | Unicode grapheme cell handling |
| `@xterm/addon-webgl` | 0.19.0 | Optional GPU renderer with DOM fallback |
| `@xterm/addon-web-links` | 0.12.0 | Explicit HTTP(S) link activation |

Fit scales the font; it does not resize the computer's session or reflow its
columns. Reading mode remains available for wrapped prose. WebGL initialization
failure, context loss or geometry beyond the GPU's limits switches to xterm's
DOM renderer in the same document.

## Keyboard and paste

Live typing uses xterm's textarea, composition handling and `onData` output.
Hardware Shift+Arrow and Ctrl/Alt combinations follow xterm's terminal keyboard
encoding. Phone buttons supplement keys the software keyboard does not expose.
The optional composer keeps drafts locally and submits only on an explicit Send.
It sends through the native encrypted connection and clears a draft only after
host acknowledgement. Pending or rejected delivery retains the draft; pending
submission blocks repeated taps. There is no native text-diff “raw mode”.

The optional backend capability `terminalInput` enables `input.terminal`: literal
UTF-8 terminal input without newline splitting or implicit Enter. Older hosts
keep the command composer and named-key requests. `terminalPaste` enables
`input.paste`, including an explicit submit flag. These messages use the existing
encrypted transport and pairing-scoped duplicate-request ledger.

Herdr's `pane.send_input` checks the application's live bracketed-paste mode and
encodes paste plus optional Enter together. tmux uses a uniquely named temporary
paste buffer and `paste-buffer -p`, with one awaited control command per reply.
It submits Enter only after paste succeeds and then cleans up its buffer. It
never touches the system clipboard. tmux paste rejects NUL before sending
anything; literal terminal input can still carry NUL.

iTerm2's send-text API supports literal input but does not expose the running
application's paste mode through this integration. Its paste uses xterm's normal
newline normalization. Multiline paste can execute separate lines in applications
without bracketed paste. Review commands before sending them.

Both native admission and transport bound the complete encoded message, including
UTF-8 and metadata. Oversized paste sends no partial text or trailing Enter.
Paused connections reject input. Unconfirmed delivery keeps the draft and warns
that it may already have run. An explicit retry of the unchanged draft reuses its
request ID; it is never automatically replayed. Deduplication is limited to the
host's bounded pairing ledger in the current service process, so check terminal
output before retrying, especially after a host restart. Clipboard reads occur
only on Paste or the browser's clipboard gesture.

Android attachment detection uses physical alphabetic input devices; iOS uses
`GCKeyboard` connection events. Software-keyboard height is not used as a proxy.
An initial asynchronous query cannot overwrite a newer attachment event.

## History, search and selection

xterm holds all admitted rows in its real buffer, up to the existing native
history budget and the renderer's 10,000-row ceiling. Search covers **loaded
history**, including off-screen rows. More history arrives only through the
existing bounded history requests. Match decorations update through SearchAddon;
screen updates do not advance the selected match.

Select enables touch selection: tap a row and adjust its handles. The handles
have 44px touch targets kept inside the visible viewport. Dragging retains the
source endpoint even when the handle is clamped to an edge or crosses the other
endpoint. Physical mouse selection uses xterm's own selection behavior. Select
all covers the loaded buffer. Copy uses xterm's selected text; Styled copy uses
SerializeAddon HTML. Each payload is capped at 4 MiB. Clipboard writes require a
matching user-initiated request in the current WebView document. A paint in
progress rejects copy rather than copying uncertain coordinates.

Unrelated output preserves a selection only while its source keys, cells and text
remain unchanged. Changed or evicted content clears it. A column-count change
also invalidates the selection. Reading mode retains its separate frozen native
selection sheet, with its 128-row/32-KiB bounds.

Following keeps the lowest occupied live row or cursor visible, including a
terminal application's footer. Empty trailing rows do not hide an ordinary
prompt. Scrolling or panning away preserves the source anchor; Jump to live
returns to it. An outer pan accommodates a host grid larger than the phone while
xterm owns scrollback. The app does not duplicate or extract a tool's status bar.

## Security and host limits

The WebView CSP denies network connections and permits only the bundled script
hash. Native navigation remains blocked. WebLinks requires a trusted activation;
native code rechecks HTTP(S) URLs, rejecting credentials, control characters and
oversized values before opening the system browser. Mouse mode suppresses links.
Remote terminal output cannot write the clipboard through OSC 52.

Cell snapshots do not carry every terminal control sequence. Application cursor
and keypad modes, extended keyboard protocols, focus reporting, terminal bells,
OSC 8 metadata and inline images are not reconstructed from screen appearance.
Herdr's explicit Mouse mode provides validated atomic clicks; it does not claim
general xterm drag/wheel mouse reporting. Supporting those features requires
authoritative backend state or a negotiated raw PTY path, rather than enabling
addons against missing data.

## Verification and upgrades

```sh
pnpm install --frozen-lockfile
pnpm -F @shellbell/mobile terminal:build
pnpm -F @shellbell/mobile terminal:check
pnpm -F @shellbell/mobile typecheck
pnpm -F @shellbell/mobile test
pnpm -F @shellbell/mobile exec playwright install chromium webkit
pnpm -F @shellbell/mobile test:terminal-browser
pnpm -F @shellbell/mobile doctor
```

Browser tests run the exact generated document in isolated Chromium and WebKit
profiles, with both GPU and forced DOM rendering. They cover retained history,
search, selection, styled copy, exact keys, paused input, paste limits and footer
geometry. The disposable tmux PTY test verifies actual bytes and paste-mode
changes without touching the owner's sessions.

For an upgrade, inspect upstream release notes, peer versions, grapheme behavior
and retained licences; regenerate the document and run these checks. Roll back
package pins, lockfile and generated document together. Serialize 0.14.0's npm
archive omits its licence file; the build includes the exact licence from its
recorded upstream source commit under `assets/licenses`.

Native compilation and browser tests do not qualify physical keyboards, IME,
touch handles or clipboard menus on a phone. Use disposable fixtures for device
checks in [mobile QA](../apps/mobile/QA.md), and record exact artifacts in the
[release checklist](before-first-release.md).

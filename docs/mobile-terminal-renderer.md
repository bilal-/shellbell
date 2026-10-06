# Mobile terminal renderer: xterm.js

Shellbell uses [xterm.js](https://github.com/xtermjs/xterm.js), copyright the
xterm.js authors, SourceLair and Christopher Jeffrey, under the MIT license.
We appreciate the upstream maintainers' work. No upstream source is modified.
The app's Settings → Open-source credits includes the original package license
texts generated directly from the installed packages, plus its bundled font
license. See `apps/mobile/THIRD_PARTY_NOTICES.md`.

## Architecture

The renderer presents the existing decrypted screen/history model. It opens no
remote connection and requires no raw-PTY protocol. Network transport remains
owned by `src/net`; the native-to-WebView row-patch bridge is local to the phone.

- `src/terminal/adapter.ts`: bounded visible rows → ANSI painting. Terminal
  output strings are data, never executable controls. Preserve source columns,
  styles, continuity and cursor position without requesting a remote resize.
- `src/screen/display-text.ts`: dependency-free display normalization shared
  with native Reading mode. iTerm NUL blank cells become spaces, not missing
  word separators. Keep browser-only `Intl.Segmenter` out of native imports.
- `bridge.ts`: one outstanding native→WebView update, latest-state coalescing,
  changed-row patches and full replay when the document reloads.
- `runtime.ts`: local xterm.js renderer, measured font cells, source-key anchored
  scrolling and visible-row virtualization. Shellbell remains the history owner;
  xterm's own scrollback is disabled. Gaps remain explicit source rows.
- `XtermView.tsx`: offline WebView, reload/error handling, controlled message
  bridge. Native InputBar alone sends intentional terminal input. No xterm
  `onData`, clipboard escape handler, remote content or arbitrary navigation.
- `ScreenView.tsx`: common output/history status actions and mode selection.
  Reading mode is a distinct prose view, not a fallback terminal renderer.

Terminal assets are bundled locally; CSP blocks network connections and only
permits the exact bundled script hash. Font measurements come from xterm's
rendered geometry, not a fixed approximation of character width. DOM/canvas geometry
and the experimental Unicode grapheme addon are explicit upgrade-test boundaries.

## Addons and mobile layout

| Package | Pinned version | Use |
| --- | --- | --- |
| `@xterm/xterm` | 6.0.0 | Offline terminal grid |
| `@xterm/addon-unicode-graphemes` | 0.4.0 | Unicode grapheme cell handling |
| `@xterm/addon-webgl` | 0.19.0 | GPU rendering when available |
| `@xterm/addon-web-links` | 0.12.0 | User-activated HTTP(S) links |

WebGL is optional. Initialization failure, context loss or a source terminal too
large for the GPU restores xterm's DOM renderer in the same document. The buffer,
selection and source viewport survive the switch. Limits include the device's
pixel ratio; source-row virtualization alone does not bound canvas width.

WebLinks posts a document-scoped message after a trusted click. Native code checks
the URL again and opens it through the system browser. Non-web schemes, embedded
credentials, control characters and oversized URLs are rejected. The terminal
WebView keeps its navigation and network restrictions.

Shellbell owns history and the remote terminal's columns. FitAddon's normal resize
would change that geometry; the existing **Fit width** control adjusts the font
instead. SearchAddon would see only the virtualized viewport, so it cannot provide
complete history search without integration with the history model.

`NavigationViewport` owns the bottom system inset for every route. It reserves
navigation-bar space while the keyboard is closed; the keyboard controller and
route keyboard-avoiding view own that space while the keyboard is open. InputBar
does not add a second bottom inset. Native modals retain their own safe-area
providers.

Clipboard and raw input are checked against the complete encoded terminal-message
limit before any related keystroke is sent. A rejected paste sends neither its
text nor its trailing Enter. An oversized raw replacement keeps the previous
text and sends no deletion keys. The check counts UTF-8 bytes and message
metadata, so multibyte text cannot bypass it.

Live follows the cursor or the lowest occupied live row, including status rows
below the cursor. Short occupied source grids receive space above them so their
bottom row meets the pane bottom. Normal prompts above blank source rows retain
their top position. See [viewport behavior](architecture/mobile-terminal.md#live-viewport)
for history and geometry boundaries.

## Upgrade procedure

1. Read upstream release notes. Update exact versions of `@xterm/xterm` and
   `@xterm/headless` together; check addon compatibility before changing it.
   Keep `react-native-webview` on the version compatible with the Expo SDK.
2. Run `pnpm -F @shellbell/mobile terminal:build`. This bundles installed code,
   CSS, font and original notices into `src/terminal/gen/document.ts` using the
   pinned build tool. Do not edit the generated document or `node_modules`.
3. Run mobile tests/typecheck, lint, and `terminal:check`. CI checks generated
   assets match dependencies and source. Inspect the dependency/lockfile and
   generated-output diff; retain copyright and permission notices.
4. Qualify the generated HTML in an actual browser, then build/install a local
   APK and exercise keyboard, rotation, touch scroll, history loading, reconnect,
   Reading mode, Unicode, wrapping, selection and renderer reload. Automated
   buffer tests alone do not qualify a release or an upstream upgrade.
5. Roll back by restoring the dependency pins, lockfile, adapter and generated
   bundle from the previous tested commit together. Install the previous signed
   APK in place to retain pairings. Do not uninstall to perform a normal rollback.

## Local fixture checks

`node apps/mobile/scripts/serve-terminal-fixture.mjs` serves the exact generated
HTML on loopback port 8767. It has no service connection. A browser test harness
provides the native message boundary and injects synthetic frames; no real
terminal input or customer data is needed. Device tests must use disposable
input fixtures rather than typing into the owner's active terminal.

`scripts/qualify-terminal.mjs` exports `qualifyTerminal(page, url?, renderer?)` for a
Playwright Page supplied by a browser test runner. It exercises 1,000 source
rows, prepend/rotation/font anchoring, 120 changed-row updates, copy selection,
stale gesture prevention and absence of network asset requests. It uses a local
ClipboardEvent/DataTransfer, never the OS clipboard. This browser qualification
is separate from Vitest/CI; run it explicitly after regenerating assets, and
restart the fixture server so it serves the new document.

The app's `/dev/render-spike` route is an offline device fixture using real
ScreenView and InputBar with synthetic data and an invalid computer fingerprint.
Its keys cannot resolve a service connection. Developer Settings links to it;
an internal preview can open it with `shellbell://dev/render-spike`. It does not
pair, subscribe, send terminal input, or load customer history. Its Fit control
uses the real app preference; restore that preference after QA.

`scripts/qualify-terminal-status.mjs` exports `qualifyTerminalStatusBars(page,
url?, renderer?)`. Run it in fresh browser contexts for both `webgl` and `dom`.
It checks bottom status rows below the cursor, available-height changes,
rotation, same-order updates, history anchoring, font/Fit changes, short-grid
alignment, painted blank status strips and ordinary prompts. It uses the same
generated document and requests no network resources. The device fixture
`shellbell://dev/render-spike?fixture=status` presents a synthetic LLM screen with
its cursor above the footer; redraw, scroll, keyboard and Fit controls exercise
the real native layout without connecting to a computer.

## Qualification boundaries

Snapshot painting must not call a full xterm reset on every frame. Upstream ED(2)
with `scrollOnEraseInDisplay=false` clears cells and old wrap flags in the same
write as replacement text. A separate reset (including RIS) exposed blank DOM
frames on device/browser checks. The browser qualification deliberately delays
the write queue and samples animation frames to guard this regression. Since
ED(2) does not clear xterm's selection model, explicitly discard selections whose
source rows leave the visible slice; the eviction test guards copying unrelated
replacement text at stale selection coordinates.

The Unicode addon is upstream-experimental and intentionally pinned. Host cell
widths can differ from its Unicode policy; fixtures cover CJK, combining marks,
joined emoji and declared flag widths, not every possible terminal font/locale.
Visible copy selections survive unrelated updates only while their source rows
and selected text remain unchanged. Selection extending outside the rendered
viewport is deliberately not retained; visible painting is not an unrestricted
xterm scrollback buffer. Touch selection/native copy menus still need separate
platform QA. Physical-device and signed-artifact qualification belongs to
[the release checklist](before-first-release.md) and
[mobile QA](../apps/mobile/QA.md). Upstream pinning and browser fixtures do not
establish full xterm.js feature coverage or native touch/accessibility support.

Run the qualification with `renderer` set to `webgl` and to `dom` in separate
browser contexts. The latter forces unavailable-WebGL behavior. The DOM run also
checks for blank frames during a delayed write. `qualifyTerminalAddons(page, url?)`
checks trusted web-link activation, rejection of synthetic clicks, a real GPU
context loss, retained copy selection and continued DOM updates.
`qualifyTerminalGpuLimit(page, url?)` exercises a 4,096-column source and checks
that it falls back before creating an oversized GPU canvas. These helpers consume a Playwright Page;
they do not start a browser themselves.

On a device, open the **Offline terminal QA** route (`shellbell://dev/render-spike`).
Its renderer label confirms which path the actual WebView chose. The CJK fixture
contains a website link; its input bar cannot resolve a real computer connection.
Check the S22's three-button navigation, the input bar with the keyboard closed,
show/hide cycles with a local draft, rotation, selection and Reading mode. Also
check Settings, pairing and computer-list footers. Gesture navigation and iOS home
indicators require their own device checks; mocked inset tests cover both source
paths.

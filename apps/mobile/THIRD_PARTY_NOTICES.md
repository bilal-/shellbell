# Terminal rendering credits

Shellbell's terminal grid is powered by **xterm.js** and its contributors:
https://github.com/xtermjs/xterm.js

Installed unchanged from upstream npm packages:

- `@xterm/xterm` 6.0.0 — MIT.
- `@xterm/addon-unicode-graphemes` 0.4.0 — MIT; experimental upstream addon.
- `@xterm/addon-webgl` 0.19.0 — MIT; optional GPU renderer with DOM fallback.
- `@xterm/addon-web-links` 0.12.0 — MIT; web links opened by the native app.
- `@xterm/addon-fit` 0.11.0 — MIT; available-column measurement.
- `@xterm/addon-search` 0.16.0 — MIT; search of loaded history.
- `@xterm/addon-serialize` 0.14.0 — MIT; styled selection copy. Its npm archive omits LICENSE; the exact upstream text is preserved in `assets/licenses/xterm-addon-serialize-0.14.0.LICENSE` and embedded in credits.
- `@xterm/headless` 6.0.0 — MIT; test-only dependency.

The original copyright and permission notices are preserved in each dependency.
`scripts/build-terminal.mjs` embeds the full original LICENSE texts of the
shipped xterm packages into the app's **Open-source credits** screen. It also
preserves upstream legal comments in the generated JavaScript. No upstream
source has been forked or edited.

JetBrains Mono Nerd Font notices are retained in `assets/fonts/LICENSE.md` and
included alongside the terminal credits in the app.

Upgrade, verification and rollback instructions:
[`docs/mobile-terminal-renderer.md`](../../docs/mobile-terminal-renderer.md).

## Direct data-channel transport

`react-native-webrtc` 124.0.8 is MIT-licensed. It includes native WebRTC
components with their own upstream notices. Shellbell uses it for negotiated direct terminal transport, with an encrypted
relay control path and explicit temporary relay fallback. Verify the exact
Android and iOS artifacts retain applicable native notices and expose them
from the app's Open-source credits screen.

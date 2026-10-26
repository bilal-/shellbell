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

## Everything else the app ships

The app's **Open-source credits** screen lists every other library it ships, with each one's
full licence text: the JavaScript packages in the Android and iOS bundles, native-only modules,
and the Android libraries and iOS pods the builds include, such as WebRTC (through
`react-native-webrtc`), Hermes and React Native's own native libraries. It is generated from
what the app actually ships, never from a hand-kept list:

- `pnpm -F @shellbell/mobile credits:build` reads the JavaScript packages from a real
  `expo export` of both platforms and writes `src/credits/gen/credits.json`;
- `pnpm -F @shellbell/mobile credits:native` records the native libraries, with licences from
  their Maven POMs and the pod list, in `credits/native.json`. Run it, with the generated
  `android/` and `ios/` projects present, whenever native dependencies change;
- `pnpm -F @shellbell/mobile credits:check` runs in CI and fails if the credits are stale, if
  a shipped package declares no licence or one outside the allowed list in
  `scripts/build-credits.mjs` (a new licence needs a review before it is added there), or if
  a package that brings native code has changed version since `credits/native.json` was
  recorded. CI can't read the native builds themselves, so that version check is what makes
  a native upgrade re-record: run `credits:native` with the generated projects. A pod whose
  version changed also stops `credits:native` until its licence is checked again.

Licences without a file in their package use the standard text in `credits/licenses/`.
Notices for components with combined or proprietary terms are in `credits/notices/`.

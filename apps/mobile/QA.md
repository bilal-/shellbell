# Mobile device QA

Run on the intended Android and iOS artifacts before internal distribution or a
public release. Use disposable terminal/pairing fixtures. Source fixtures, simulator
compilation and direct receiver invocation do not prove provider delivery.
[The release checklist](../../docs/before-first-release.md) owns current qualification
status; record exact source/artifact, signing/build number, OS/WebView, network and
observations in the relevant release record. Keep private device evidence out of Git.

## iOS 27

Shellbell opts into Expo SDK 57's scene lifecycle through
`expo-build-properties`. Native generation must retain the
`EXExpoAppSceneDelegate` scene manifest and factory-provider AppDelegate; an
Xcode 27 build without scene adoption cannot launch on iOS 27. Keep the scene
configuration single-window.

- [ ] Cold-launch the signed candidate on iOS 27 and the oldest supported iOS
  version. Open pairing and a populated terminal without a blank screen or crash.
- [ ] Background, lock, unlock and foreground the app on iOS 27. Confirm one
  connection lifecycle, correct direct-route recovery and no replayed input.
- [ ] Open a deep link and tap a notification from both a cold and running app.
  Route to the intended session once, preserving private notification behavior.
  Repeat after unpairing the computer or ending the session; do not open a stale
  terminal. Pairing, settings and render-spike links must still open normally.
- [ ] Recheck APNs enrollment, foreground/background delivery and hide-details
  on the signed candidate; simulator screenshots do not establish delivery.

### iPhone Duo

Build with the iOS 27.1 SDK for Duo's adaptive layout. Expo modules compile from
source to match the selected Xcode's Swift compiler. The `expo-system-ui` plugin
applies the black native root background outside the React tree.
The root navigation provider uses the dark theme so adaptive display margins
and native navigation controls match the app.
Test both displays and supported orientations, preserving
the selected computer/session, history position and unsent draft. Repeat display
transitions with software and hardware keyboards, Reading mode, selection and
accessibility enabled. Verify the active scene's keyboard insets, terminal grid
and touch targets update correctly, and that controls remain visible.

## Pairing, sessions and input

- [ ] Verify the indicator says Direct only after route commit; Wi-Fi and cellular do not determine that label.
- [ ] Interrupt WebRTC: retain the last screen, pause input and screen subscriptions, show retry progress, and verify no terminal streaming through the relay.
- [ ] Choose Use relay temporarily: show Relay fallback, resume terminal traffic, recover direct automatically, then verify the next direct loss pauses again.
- [ ] Tap and horizontally scroll quick keys while the keyboard is open: preserve focus and keyboard visibility, and send each key once on the first tap.

- [ ] Fresh install → Computers empty state → Pair → camera permission → scan →
  confirmation identifies the computer → matching phone approval on the computer.
- [ ] Cancelling confirmation sends nothing and re-arms the scanner.
- [ ] All exposed iTerm2/tmux/Herdr sessions have correct labels and state; blocked
  agent state is distinct from running.
- [ ] Live output follows; scrolling stops follow; Jump to live returns. Session
  removal shows an ended state and removes its input controls.
- [ ] xterm typing, IME composition, repeated backspace, Escape, Tab, Ctrl+C, arrows and Unicode
  reach an isolated test session. Test multiline behavior per backend.
- [ ] Creation/focus actions appear only for advertised supported capabilities.
- [ ] Open Session actions on Android and iOS. With all capabilities available,
  bring-to-front, new-session, both split directions and Cancel remain reachable
  in portrait and landscape. Offline actions are disabled; repeated taps send
  one request and failed requests show feedback.
- [ ] A recoverable connection error's Retry reconnects the existing computer;
  only Re-pair opens pairing. Deny camera access permanently, open system Settings
  from Pair and enable it; returning to the app refreshes the scanner.
- [ ] Settings uses the same gear on Computers and the session list. Return,
  arrows and Backspace render as monochrome controls. Check larger text sizes,
  VoiceOver/TalkBack labels and touch targets. Last rows clear the floating add
  button; lists and action sheets clear side insets on adaptive displays.
- [ ] Back to computers works from the session list, including after pairing or
  a deep link. The terminal header keeps both Reading mode and Session actions
  reachable after changing sessions.
- [ ] Replace a visible toast with another message; the replacement remains
  visible for its full reading interval.
- [ ] Interrupt a socket while input is pending: uncertainty is visible and no
  input is automatically resent. Reconnect receives a fresh session bootstrap.
- [ ] Unpair from either endpoint, finish interrupted cleanup and pair again.
  No delayed enrollment or connection callback revives retired state.
- [ ] Change one computer's Relay URL; only its connection changes, local keys are
  preserved, and a fresh relay follows the explicit unpair/re-pair procedure.

## Terminal rendering and history

- [ ] Attach and detach USB/Bluetooth/Magic keyboards. Hide the whole key accessory bar and open guide while attached; retain unsent drafts. Software-keyboard dismissal alone must not indicate attachment.
- [ ] Use physical Shift+Arrow, Ctrl/Alt keys, CJK composition, emoji, selection and browser clipboard gestures in disposable sessions.
- [ ] Search loaded off-screen history with case and whole-word options. Streaming must not advance the match. Copy plain and styled selections only after explicit requests.
- [ ] Enable Select, tap a row and drag both handles. Unrelated output preserves the range; changed/evicted rows clear it. Verify touch scrolling after turning Select off.
- [ ] Paste multiline text with and without bracketed-paste mode in tmux/Herdr. Paste alone must not add Enter; composer Send submits once. Oversized paste sends neither partial text nor Enter.
- [ ] Verify ordinary prompts remain visible with blank trailing rows, footer rows remain visible above the keyboard and panning away is not interrupted by streaming.

- [ ] Tap Shift then Left in a disposable Codex selection prompt. Verify Shift +
  Tab, Ctrl/Alt combinations, ordinary arrows after one-use clearing, rejected
  input retaining the selected modifier, and keyboard focus on Android/iOS.
- [ ] With matching Herdr CLI/server 0.9.3 or newer, turn on Mouse and tap a
  disposable mouse-aware terminal app. Verify the intended cell at normal font
  size, Fit width, horizontal scroll and with history above the live grid.
- [ ] Mouse mode must send nothing for history/gap rows, drags, stale frames or
  paused connections. Confirm an existing controller is not taken over; rejected
  and uncertain clicks are not replayed. Reading mode and reconnects turn Mouse
  off. Verify right/middle clicks and modifier flags with a physical pointer.
- [ ] On an old host or a non-mouse backend, Mouse stays absent and ordinary
  terminal keys remain usable. Mouse mode must suppress web-link activation.

- [ ] The Computers screen opens Settings from the top-right gear. Settings shows
      the installed version and native build number, a small Shellbell mark, source
      and credits links, and the owner's website.
- [ ] **Scale terminal to fit** explains automatic font scaling without wrapping.
      Font buttons show **Auto**, look disabled and report disabled accessibility
      state. Turning scaling off restores the selected size. Pinch follows the same
      policy in Terminal mode; Reading mode still wraps text.
- [ ] With no open session, **+** lists installed/startable backends. Start iTerm2,
      tmux's first session and Herdr's first workspace using disposable fixtures.
      Missing software or disabled local APIs produce useful failure guidance.
- [ ] A creation reply lost during a network change does not trigger automatic
      retries. Check the session list before creating another terminal.

Run `terminal:check`, mobile tests and the real-browser fixture harness from
[renderer maintenance](../../docs/mobile-terminal-renderer.md). Keep delayed-write
blank-frame and selected-row eviction regressions passing. Use
`shellbell://dev/render-spike` for isolated layout/input fixtures.

- [ ] CJK, combining marks, emoji, colors and declared cell widths remain aligned.
- [ ] Wide-grid horizontal pan, Fit width, font size and portrait/landscape IME
  behave correctly without resizing the computer terminal.
- [ ] In `shellbell://dev/render-spike?fixture=status`, bottom status rows stay
  above the input bar through keyboard show/hide, system navigation insets,
  rotation, font/Fit changes and redraw. Browsing earlier rows keeps its position;
  **Jump to live** returns to the footer. No status rows are duplicated over history.
- [ ] History prepend, Terminal/Reading switches, font/rotation changes and new
  output preserve the source anchor. End/truncated/busy history stay distinct.
- [ ] Interrupted transfers show recovery controls. Retry output does not acquire
  history or replay input; explicit stale-history refresh is bounded.
- [ ] Background/resume and renderer reload recover without duplicate subscriptions.
- [ ] Exercise 5,000-line history and sustained redraw; measure memory/frame behavior
  on the intended device rather than inferring it from unit tests.

## Select text and accessibility

Use **Select text** in Terminal or Reading. Underlying WebView long-press is not the
supported mobile copy path. Desktop mouse selection does not qualify native copy.

- [ ] Freeze the visible source snapshot, select a substring, copy and paste into
  a safe local field. Closing preserves the reading position.
- [ ] Opening/closing causes no clipboard writes; Copy snapshot writes only after
  explicit action. New output does not mutate the open snapshot.
- [ ] Row/byte truncation is labelled; changing sessions cannot show prior text.
- [ ] Rotate or fold with the sheet open; controls clear system insets at larger
  text sizes and while the keyboard is open.
- [ ] Exercise VoiceOver/TalkBack focus, selection and error feedback on hardware.

## Direct FCM/APNs notifications

Before an Android release build, run the generated app's
`./gradlew :app:lintVitalRelease`. Keep Firebase Messaging exposed as an `api`
dependency by the native receiver module; do not suppress consuming-app service
inheritance errors. See [private notifications](../../docs/private-notifications.md).

- [ ] Native key storage precedes encrypted enrollment acknowledgement; old peers
  receive generic alerts. Test missing/corrupt keys and expired enrollment.
- [ ] Test direct FCM and signed development/production APNs on exact artifacts.
  Check foreground suppression, background, process absence, locked after first
  unlock, before first unlock and denied permission.
- [ ] Two same-repository sessions and two computers remain distinguishable.
  Same-session replacement preserves the other alert and computer summary.
- [ ] Duplicate/reversed arrivals, clock skew, freshness, offline recovery and
  token/generation rotation do not expose private context or revive stale alerts.
- [ ] Collapsed/expanded labels identify the session. Count visible alerts and
  sounds separately; provider acceptance is not a display receipt.
- [ ] Hide notification details works without JavaScript. Storage failure shows
  the actual/unknown native setting, not assumed success; existing history is not
  claimed to be recalled.
- [ ] Tap waits for a fresh session list: existing targets open correctly, removed
  sessions stay on the computer list, unpaired targets never auto-open.
- [ ] Opening a session dismisses exactly its native/legacy alerts. Unpair removes
  native state before deleting pairing records; failed cleanup stays disconnected
  with Finish unpairing available.

Inspect the signed iOS host/extension bundle IDs, app group, Keychain group,
entitlements and matching versions. Simulator or Android receiver instrumentation
is separate evidence from actual provider delivery. Do not clear live relay quotas
to manufacture a passing test.

## Direct transport and lifecycle

- [ ] In an enabled test build, verify authenticated relay bootstrap, direct route
  commit and screen/input, measuring terminal bytes separately from signaling.
- [ ] Interrupt relay while direct works; interrupt direct; verify fresh encrypted
  fallback, bounded periodic retries and a snapshot without input replay.
- [ ] Test cellular, restrictive NAT/firewall, network handover, sleep/background,
  prolonged failure and explicit direct disable on every advertised platform.
- [ ] Confirm native DTLS mismatch and stale attempts cannot activate a route.
- [ ] Check data-only manifest permissions and WebRTC/xterm.js notices in the
  artifact and Open-source credits.
- [ ] Restore test preferences, clear synthetic drafts and record remaining gaps.

Passing one device/network does not qualify another. [Direct transport](../../docs/architecture/direct-transport.md)
and [local builds/uploads](../../docs/local-mobile-releases.md) define the remaining
security and distribution boundaries.

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

- [ ] Open computers and sessions with system animations both enabled and disabled.
  Rows must remain aligned, and tapping a session must open that session. On a
  disposable Android tablet with the offline `listingCapture` APK installed, run
  `bash apps/mobile/.listing-kit/check-list-navigation.sh emulator-5556` from the
  repository root, substituting its explicit serial. This clears demo app state
  and checks animation scales 0 and 1, restoring the prior scales afterward.

- [ ] Open and close the software keyboard in Terminal and Reading modes. Hide
  the paused-connection banner, history notices and selection hint while typing;
  restore them afterward without losing the draft, viewport or session. Active
  search remains usable with the keyboard, and output failures remain visible.
- [ ] At rest on a phone, only the header sits above the terminal: project name,
  status line ("Codex · idle") and connection dot. No connection strip, Load older
  bar or Search/Select/Copy toolbar appears while the connection is healthy.
- [ ] Leave Terminal view open through idle status updates, raw output bursts and
  a brief source pause, with the keyboard both open and closed. Live/Catching up
  header changes must not move the grid. A pause notice and Retry output must
  remain readable and tappable over the top rows without resizing the terminal.
  Repeat in Reading view and with Terminal mouse enabled as comparison modes.
- [ ] Verify the header dot is emerald and wordless only after the direct route
  commits; Wi-Fi and cellular do not determine it. Relay and connecting states
  show amber with a word, offline grey, and a connection needing attention rose.
  Tapping the title shows the same label and detail as the paused banner.
- [ ] Interrupt WebRTC: retain the last screen, pause input and screen subscriptions, show retry progress, and verify no terminal streaming through the relay.
- [ ] Keep WebRTC unavailable: the paused banner and the header's connection details offer no relay choice, and the terminal resumes on its own once direct recovers.
- [ ] Tap and horizontally scroll quick keys while the keyboard is open: preserve focus and keyboard visibility, and send each key once on the first tap.

- [ ] Fresh install → Computers empty state → Pair → camera permission → scan →
  confirmation identifies the computer → matching phone approval on the computer.
- [ ] Cancelling confirmation sends nothing and re-arms the scanner.
- [ ] App Lock: after the first pairing, a cold launch shows the lock and the
  system prompt (Face ID permission on first iOS use). Cancel leaves the lock
  without re-prompting; Unlock with Face ID, Touch ID, fingerprint and passcode or
  PIN fallback all open the last screen. Background past each delay locks again;
  shorter absences do not. The app switcher shows the cover, not a terminal, on
  both platforms. A notification tap or deep link while locked lands on its
  session only after unlock. Turning App Lock off shows the warning and then the
  system prompt; a phone without a passcode never locks. After unlocking or
  skipping the lock, navigation and terminal controls must respond immediately.
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
  only Re-pair opens pairing, after confirming and unpairing that computer here so
  its QR code can be scanned again. Deny camera access permanently, open system Settings
  from Pair and enable it; returning to the app refreshes the scanner.
- [ ] Settings uses the same gear on Computers and the session list. Return,
  arrows and Backspace render as monochrome controls. Check larger text sizes,
  VoiceOver/TalkBack labels and touch targets. Last rows clear the floating add
  button; lists and action sheets clear side insets on adaptive displays.
- [ ] Back to computers works from the session list, including after pairing or
  a deep link. The session menu keeps Reading view, Terminal mouse, Search,
  Select text and New session reachable after changing sessions, and before the
  session list has loaded. Each removed bar's control is at most two taps away.
- [ ] Replace a visible toast with another message; the replacement remains
  visible for its full reading interval.
- [ ] Interrupt a socket while input is pending: uncertainty is visible and no
  input is automatically resent. Reconnect receives a fresh session bootstrap.
- [ ] Unpair from either endpoint, finish interrupted cleanup and pair again.
  No delayed enrollment or connection callback revives retired state.
- [ ] Change one computer's Relay URL; only its connection changes, local keys are
  preserved, and a fresh relay follows the explicit unpair/re-pair procedure.

## Terminal rendering and history

- [ ] On a disposable Herdr terminal, load styled history after clearing most of
  the visible screen. Older rows must keep their order with the cursor at the
  top, middle and bottom. At Herdr's native read limit, show the read-limit
  explanation without a Retry loop; keep loaded rows and live output usable.
- [ ] On Fold 7, exercise cover and unfolded displays with Samsung Keyboard and
  Gboard. Use the command bar, then switch **Live** and **Secret** on and off
  repeatedly: input goes to the visible field, unsent drafts survive, and no mode
  switch sends a command. In Live keys, type quickly, hold Backspace on an empty
  field and press Return: the terminal receives each key once, in order, with no
  autocorrect. Start and quit vim in tmux: Live keys turns on and off by itself.
  Repeat on iPhone and iPad before claiming iOS keyboard qualification.
- [ ] In disposable Claude Code and Codex sessions, check the bar reads "Message
  Claude…"/"Message Codex…", the keys row starts Esc, arrows, Enter, ⇧Tab, 1, 2,
  3, ^C and its right edge fades until scrolled to the end, ⇧Tab switches the
  agent's mode, and the Live keys button is hidden. Type a two-line message with
  Return between the lines: Send submits it once. With an empty field, Enter
  confirms the agent's prompt; a long press fills the last sent message. Trigger a
  permission prompt: the waiting strip shows the agent's question and one chip per
  numbered choice. Verify displayed reply hints such as y or Esc send that key;
  otherwise a choice sends its number. Navigation keeps the strip open; an accepted
  choice restores terminal keys without appending Enter or implying an extra confirmation. For an explicit
  current [y/N] prompt, Yes/No send one letter without Enter; a (yes/no) prompt
  sends the full word without Enter. For unknown or ambiguous prompts, show Up, Down, Shift + Left, Enter and Esc without guessing
  Yes/No. Confirm Enter and close remain reachable in narrow and compact layouts.

- [ ] With disposable iTerm2, tmux and Herdr sessions (Herdr attached through
  Ghostty and iTerm2), page in Terminal and Reading modes, then reconnect with
  empty and populated caches. Refresh empty, ended, truncated and temporarily
  unavailable histories. A busy read must offer retry; blank viewport tails must
  not force an endless detached/refresh loop. Herdr's 1,000-row native fetch
  window remains a real limit.
- [ ] Compare Live keys typing on same-Wi-Fi and remote networks. Rapidly paste then
  press Return; verify ordering and one execution. Include interrupted delivery,
  CJK composition and backend disconnection; cancelled input is never replayed.


- [ ] Attach and detach USB/Bluetooth/Magic keyboards. Hide the whole key accessory bar and open guide while attached; retain unsent drafts. Software-keyboard dismissal alone must not indicate attachment.
- [ ] Use physical Shift+Arrow, Ctrl/Alt keys, CJK composition, emoji, selection and browser clipboard gestures in disposable sessions.
- [ ] Search loaded off-screen history with case and whole-word options. Streaming must not advance the match. Copy plain and styled selections only after explicit requests.
- [ ] Enable Select, tap a row and drag both handles. Unrelated output preserves the range; changed/evicted rows clear it. Verify touch scrolling after turning Select off.
- [ ] Paste multiline text with and without bracketed-paste mode in tmux/Herdr. Paste alone must not add Enter; composer Send submits once. Oversized paste sends neither partial text nor Enter.
- [ ] Verify ordinary prompts remain visible with blank trailing rows, footer rows remain visible above the keyboard and panning away is not interrupted by streaming.

- [ ] Tap Shift then Left in a disposable Codex selection prompt. Close the waiting
  strip with the keyboard open; no reply is sent, and selecting a modifier keeps
  arrows ahead of letter shortcuts. Verify Shift +
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
- [ ] A smaller host grid is visibly framed, centered horizontally and top-aligned.
  Filling or clearing its final row must not move it. Open/close the keyboard and
  rotate the phone; check the last column beside the scrollbar, mouse cell
  targeting, selection/copy and scrolling from the empty gutters. Large grids
  must still pan and Jump to live; frame styling must not change Fit phone's
  requested creation dimensions.
- [ ] **Scale terminal to fit** explains automatic font scaling without wrapping.
      Font buttons show **Auto**, look disabled and report disabled accessibility
      state. Turning scaling off restores the selected size. Pinch follows the same
      policy in Terminal mode; Reading mode still wraps text.
- [ ] In Terminal mode, pinch larger and smaller repeatedly, then swipe history
  in both directions. Check the terminal grid and any empty space below it, with
  the keyboard open and closed. Repeat on the Fold's cover and unfolded displays;
  swipes still work without reconnecting or reopening the session.
- [ ] With no open session, **+** lists installed/startable backends. Start iTerm2,
      tmux's first session and Herdr's first workspace using disposable fixtures.
      Missing software or disabled local APIs produce useful failure guidance.
- [ ] The **+** picker shows each engine once, including Herdr when advertised.
  Picking an engine reveals its desktop apps. Verify Fit phone, valid and invalid
  Custom dimensions, and Computer default; only Create window sends a request.
  Check keyboard-open editing, rotation, missing launch targets, and returning to
  the engine list. Use disposable windows to compare requested and actual grids.
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
  the round **Jump to live** button, bottom-right above the input area, returns to
  the footer. No status rows are duplicated over history.
- [ ] Swipe to the top of the scrollback in Terminal and Reading modes: older
  history loads with a brief "Loading older…" row and no resting Load older bar.
- [ ] History prepend, Terminal/Reading switches, font/rotation changes and new
  output preserve the source anchor. End/truncated/busy history stay distinct.
- [ ] A stalled or invalid transfer resubscribes by itself up to four times while
  showing the normal loading line; only then do recovery controls appear. A transport
  pause that resumes on the same handshake resubscribes at once. Retry output does not
  acquire history or replay input; explicit stale-history refresh is bounded.
- [ ] Background/resume and renderer reload recover without duplicate subscriptions.
- [ ] Exercise 5,000-line history and sustained redraw; measure memory/frame behavior
  on the intended device rather than inferring it from unit tests.

## Select text and accessibility

Use **Select text** from the session menu in Terminal or Reading, or hold a still
finger on the terminal. The system's own WebView text menu is not the supported
mobile copy path. Desktop mouse selection does not qualify native copy.

- [ ] In Terminal mode the header becomes Done / Select all / Copy while
  selecting. Copy is enabled even before a selection and explains an empty copy;
  a completed copy says Copied and ends selection; Android Back ends selection
  without leaving the session. A moving finger scrolls instead of selecting.

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

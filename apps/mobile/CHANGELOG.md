# @shellbell/mobile

## 1.1.0

### Pending launch candidate changes

- Ask for agreement to the Terms of Use before starting connections. Remember custom relay trust choices by address, and keep Terms and Privacy available in Settings.

- Update the private protocol dependency to 0.2.0; wire compatibility remains negotiated separately.

- Preserve loaded history and reading positions through stream recovery, and stop
  legacy history requests at the oldest retained row.
- Clarify direct typing and draft focus, retaining pending input per connection.
- Show owner-enabled terminal adapters and available desktop launch choices.
- Avoid redundant terminal repaints while scrolling and preserve the reading
  position when the renderer reloads.
- Notify reachable computers before closing an unpaired connection, including
  legacy pairings, while retaining durable revocation and local cleanup.
- Align Expo SDK packages and native build tools with recommended patch versions.

- Keep vertical history swipes working across the full terminal viewport after
  zooming in or out, including empty space below a smaller grid.

- Explain native terminal history read limits without an ineffective Retry
  action; keep already loaded history and live output available.
- Keep computer and session rows aligned and tappable when Android animations are disabled.

- Hide connection, history and selection toolbars while the software keyboard is
  open, keeping more terminal output visible without losing the draft or session.
- Adopt Expo's scene lifecycle for iOS 27 and compile Expo modules from source
  with the selected Xcode toolchain. Keep the app single-window.
- Keep native window and navigation backgrounds dark during adaptive display
  changes. Signed-candidate lifecycle, deep-link and notification qualification
  remains in the mobile QA checklist.
- Keep terminal notification links behind pairing and current-session checks
  during both cold launch and warm URL delivery.
- Use consistent settings controls and native monochrome keyboard icons. Improve
  touch targets, accessible labels and list spacing around system controls.
- Keep a visible route back to Computers and pass the selected session explicitly
  to native header actions.
- Keep all session actions reachable on Android, prevent duplicate requests and
  explain failed actions. Retry reconnects without starting a new pairing.
- Recover camera access through system Settings after permission denial, and give
  replacement toast messages their full reading interval.

### Minor Changes

- 6975e9e: Add one-use Shift, Ctrl and Alt controls to the terminal key bar, including Shift + arrows, Shift + Tab and modified letter buttons. Keep ordinary typing and keyboard focus in the native composer.
- 874b3ae: Add optional encrypted terminal mouse clicks for Herdr with a matching CLI/server
  version 0.9.3 or newer. Mobile Mouse mode accepts acknowledged live-cell taps,
  leaves history scrolling local, and disables input during connection pauses.
  The host checks the current pane grid, refuses takeover, releases control after
  each click and never replays a failed request.
- 279b85f: Move terminal interaction and loaded history into xterm.js. Add history search,
  touch selection, styled copy, exact encrypted terminal input and host-native
  paste. Remove native raw-input text diffing and hide phone keyboard accessories
  when a physical keyboard is attached. Older hosts retain command composition.

### Patch Changes

- 3a94500: Reject oversized clipboard and raw input before sending any associated Enter or deletion keys. Check the complete encoded message, including multibyte text, and show a local size error.
- Updated dependencies [3a94500]
- Updated dependencies [874b3ae]
- Updated dependencies [279b85f]
  - @shellbell/protocol@0.1.0

## 1.0.0

### Major Changes

- c5d0005: Prepare the shared Android and iOS launch release train as 1.0.0. Beta candidates
  use the same numeric marketing version with fresh platform build numbers and
  TestFlight or Play testing channels. Stable promotion requires qualification of
  the launch contract; the version bump does not publish or upload an app.

### Patch Changes

- 93cba0f: Read the mobile native version and both relay runtime version responses from
  their component package metadata. Keep the Cloudflare relay, Node relay and
  shared relay core on one release version.
- 9084eb1: Enable direct WebRTC negotiation in normal mobile connections. Pause terminal input and streaming until a direct route commits, including after direct loss; relay terminal traffic requires an explicit temporary choice. Keep relay signaling and notification enrollment available while the terminal is paused. Show the committed route and connection/retry progress in the app.
  
  Preserve keyboard visibility when tapping or scrolling terminal quick keys so the first tap reaches the key.
- 892bdf7: Keep bottom status rows from terminal applications visible in Live mode even
  when their cursor is higher on the screen. Preserve history reading positions
  and align short occupied grids above the input bar through viewport changes.
- Deliver internal mobile candidates through CI after the source passes checks.
  Reserve native counters from store history, verify artifact versions and store
  assignment, retain build diagnostics, and tag the exact source after both uploads.
- 1d43043: Reconnect paired terminal sessions when the phone switches between Wi-Fi and
  cellular. Pause attempts without a network, show offline state separately from
  computer and relay outages, and preserve unsent drafts without automatic replay.
- 9084eb1: Enable R8 code shrinking, optimization and obfuscation, plus unused-resource shrinking, in Android release builds. Preserve these settings across native regeneration and use the optimizing Android defaults.
  
  Run iOS prebuild and CocoaPods outside Fastlane's Ruby bundle while retaining
  native release configuration.
  
  Include the notification extension bundle name required by App Store validation.
  
  Check the accepted TestFlight build's encryption compliance and internal testing
  state before group assignment, with instructions to resolve blockers on that build.
  Allow an explicit encryption-documentation classification for local internal
  uploads; leaving it unset requires resolving the declaration in App Store Connect.
- 9084eb1: Move Settings to a header gear, add light branding and native version/build information,
  and remove the donation link. Explain automatic terminal scaling and disable manual
  font controls while it is active. Show supported terminal apps in a session picker
  with connection guidance, avoiding Android's native alert button limit.
  
  Advertise installed terminal backends separately from connected ones. A phone can
  launch iTerm2, start tmux's first session, or start Herdr's headless server and first
  workspace. Keep startup requests bounded and preserve existing target validation.
- 1d466c2: Keep screens above system navigation when the keyboard is closed. Add optional
  WebGL rendering with DOM fallback and native web-link opening. Provide explicit
  local build-and-upload commands for internal Play and TestFlight distribution.
- Updated dependencies [9084eb1]
- Updated dependencies [9084eb1]
  - @shellbell/protocol@0.0.2

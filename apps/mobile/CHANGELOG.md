# @shellbell/mobile

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

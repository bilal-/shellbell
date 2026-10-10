# shellbell

## 0.3.0

### Minor Changes

- 5202bd4: Add owner-enabled local terminal adapters and an encrypted capability catalog.
  On macOS, offer new tmux or Herdr sessions in Ghostty or iTerm2, including cold
  startup. Preserve built-in creation for older phones, fence retired adapter
  results and keep healthy session discovery available during adapter failures.

### Patch Changes

- Keep Herdr history aligned when native reads trim rows or the terminal is busy,
  and report native history limits without implying that unavailable rows can be
  retried. Recover bounded terminal streams without losing acknowledgement state.
  Serialize input-triggered captures without treating read-only activity as typing,
  and reject legacy pairing requests that cannot produce a usable pairing code.
- 64200eb: Start all Mac power controls off on every fresh launch and keep choices local to the current app session. Explicitly enabling closed-lid access verifies helper readiness and recovers an orphaned maintenance hold without taking over another active lease or removal. Quit continues to restore normal sleep.

## 0.2.0

### Minor Changes

- a876f9d: Rework Mac keep-awake settings with positive controls, independent idle/display/lid
  status and read-only macOS power details. Verify owned idle assertions and fresh
  global sleep state before reporting protection. Existing preferences are retained;
  battery idle protection stays opt-in and closed-lid access still requires AC.

  When the helper detects its active sleep override turned off, closed-lid access
  now pauses until explicit retry or a changed master/lid choice instead of silently
  reacquiring it. Failed turn-off shows known activity and the failed change together.
  Qualify administrator setup, sleep/wake and physical lid behavior on the exact
  signed artifact before distribution.
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

- 35c9f7d: Refresh backend capability advertisements when their values change, even when
  the connected backend names stay the same. Preserve notification features and
  installed terminal launcher options in every refreshed hello.
- 2b2657a: Include the upstream licenses for bundled cryptography and CBOR libraries in Linux archives.
- 891d7fb: Build Linux archives with the target CPU's glibc WebRTC addon and verify its pinned native binary, rather than selecting the build computer's platform. Require glibc 2.30 before staging an installation, and add an isolated native direct-channel qualification check.
- 5cac373: Ship Shellbell's license and the complete licenses for bundled libraries in the npm package, and verify them after packing and installing it.
- ce52796: Reconnect a stalled tmux control client after a request times out, preventing late
  replies from being assigned to another pane. Existing tmux sessions keep running.

## 0.1.1

### Patch Changes

- a6881f3: Fix headless service start and restart for legacy macOS installations without a
  service-instance UUID. Supervised startup keeps ownership checks while avoiding
  the lock already held by the supervising command.

## 0.1.0

### Minor Changes

- a465b4b: Initial public release: pair a phone by QR, mirror iTerm2, tmux and Herdr sessions end-to-end
  encrypted, reply from the phone, and get a push when a command finishes, a program goes quiet, or
  a coding agent is blocked.

### Patch Changes

- 26920df: Check source versions and queued release plans against owner-approved major
  ceilings before version preparation. Major upgrades require discussion and
  explicit owner approval; the mobile 1.0 launch milestone is already approved.
- 3adb3cb: Require an explicit Mac candidate build number and verify it against the bundle
  inventory. Derive the native marketing version from the bundled computer package
  so version preparation does not leave the Mac app on a stale template version.
  Use the computer release tag for Linux archive and checksum downloads.
- 9084eb1: Move Settings to a header gear, add light branding and native version/build information,
  and remove the donation link. Explain automatic terminal scaling and disable manual
  font controls while it is active. Show supported terminal apps in a session picker
  with connection guidance, avoiding Android's native alert button limit.
  
  Advertise installed terminal backends separately from connected ones. A phone can
  launch iTerm2, start tmux's first session, or start Herdr's headless server and first
  workspace. Keep startup requests bounded and preserve existing target validation.

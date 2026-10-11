# shellbell

## 0.4.0

### Minor Changes

- 6be5a9a: Sign each side's pairing encryption key with its identity, so someone who saw a pairing QR and controls the relay path cannot substitute a key while the owner approves the genuine phone. New QR codes advertise this, and the computer refuses phones that do not sign their key. Approval prompts show the phone's full fingerprint in groups of four and strip control and bidirectional characters from the phone name.
- 6ca8263: Behaviour change: a session created from a phone now always opens in a terminal
  window on your computer. A new iTerm2 tab opens as before. A tmux or Herdr
  session opens in iTerm2, or in Ghostty when iTerm2 is not available, instead of
  running detached where only the phone could see it. If no terminal app on the
  computer can show it, the computer refuses with a message the phone shows, and
  nothing is started. If the window fails to open, the new session is closed
  again. Splitting a tmux session, or adding a window to it, from the phone needs
  a terminal window on the computer that already shows that session; Herdr splits
  and terminal plugin sessions can no longer be created from the phone.

### Patch Changes

- c52ec9a: Keep a tmux session connected when its screen shows a line starting with `%exit`,
  `%output` or another control-mode word. That text is now treated as part of the
  captured screen instead of ending the tmux connection. The computer also forgets
  screen state for session IDs a phone asked to view but that were never captured,
  so repeated requests for missing sessions no longer grow its memory. A closed
  terminal session no longer reappears on phones when a slower, older session list
  finishes after the newer one. Phones removed while the computer was offline no
  longer keep their private notification slots, which could stop a newly paired
  phone from turning on private notifications; leftover slots are cleared at start.
  Stopping tmux support while it is still checking for tmux no longer leaves a
  control client attached to your tmux sessions afterwards.
- 47f74f4: Refuse relay URLs with a path, trailing slash, query or credentials when they are set with `shellbell config set relay` or the foreground override, instead of saving them and failing later when pairing opens. The Mac app now starts when installed in `/Applications`, whose standard root:admin group-writable permissions were previously refused by the launch check.
- 81a5160: Open a session started from the phone in an iTerm2 window the size of the one
  you are working in, instead of iTerm2's small 80 × 25 profile default. The window
  still opens in the background without taking focus, and uses the profile's size
  when iTerm2 has no windows open.
- 711eda7: Count a joined emoji with a skin tone or emoji variation selector, such as 👩🏽‍💻 or ❤️‍🔥, as two terminal cells like the phone's terminal does. The computer previously reported three or four cells for these in terminal snapshots.
- c6fb74d: Name sessions the way Herdr's sidebar does. Each session now reports its project (the Git repository, folder, renamed tmux window or Herdr workspace) and, when Claude Code or Codex is running, the agent and the task from its terminal title. Herdr sessions also report their workspace name. Older phones keep showing the existing title.
- 4d85da7: Ask for agreement to the Terms of Use before the Mac controller connects to its service. Remember custom relay trust choices by address and keep Terms and Privacy links in Settings. Declining terms on first launch quits the controller without changing a separately running service.
- 8f48144: Tell phones when a tmux pane is showing a full-screen program such as vim, less or top, so the phone can switch to sending each key straight to the terminal. The flag is read while the pane is being captured and is left out for iTerm2 and Herdr sessions, which do not report it.
- 0c07086: Close a tmux session the computer just started for a phone when it cannot then
  attach to it, instead of leaving it running where no window or phone shows it.
- 20d3b1d: Ignore tmux pane listings that a crafted directory or command name has split or forged. Such a name could previously add a session whose identifier ran an extra tmux command when it was opened from a phone.
- 4a12a6a: Log why a direct connection attempt failed: "v2 transport failed" now includes a
  reason code and the phase the attempt reached, never addresses or candidates.
  The warning for a phone that has not finished its handshake now states the 15
  second deadline the computer actually waits, instead of 10 seconds.

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

# shellbell

## 0.10.0

### Minor Changes

- bdb6e78: Add a shared macOS/Linux CLI installer that includes its runtime and preserves
  existing identities, pairings and running services. Managed Apple silicon CLI
  installations can manually install verified updates with `shellbell update`.
  Clarify that tools launched in terminal sessions can trigger macOS permission
  prompts attributed to their parent app.

## 0.9.0

### Minor Changes

- d414416: Add manual computer update checks. The Mac app offers Check for Updates in General
  settings, with release notes and the official compatible installer. The CLI adds
  `shellbell update --check` and confirmed verified Linux archive installation,
  preserving previous runtimes and pairings. Other installation methods receive
  appropriate update instructions. Checks, downloads and service activation remain
  explicit user actions; there are no background checks or automatic downloads.

## 0.8.0

### Minor Changes

- a36fb83: Keep more terminal history available on compatible phones, with bounded checkpoints
  across renderer reloads and reconnects, older native history pages, and explicit
  messages when continuity cannot be proven. Herdr history counts now come from the
  verified capture, and transient read failures recover within a bounded retry window.
  Existing phones retain their current stream format.

  Add optional Claude Code and Codex conversation reading for identity-verified Herdr
  sessions. **Show agent conversations** defaults off and can be changed live from the
  Mac app or CLI. Consented conversation pages travel only over the paired direct
  connection; history remains bounded and unsupported sources stay in Terminal.

  Let compatible phones group new sessions by terminal engine, choose an available
  desktop host, and request a starting window size in terminal cells. New sessions
  still require an attached desktop window. The terminal app may adjust requested
  dimensions; existing windows are not resized.

  Schedule background transcript work behind ready terminal traffic and reuse
  unchanged conversation projections to reduce repeated parsing and serialization.

### Patch Changes

- 8aa7b56: Report Herdr history counts from the same verified native capture used to page
  older rows, so a stale session cache cannot make available history appear empty.
- 3e7d005: Give repeated Herdr read errors a two-second retry window starting at the first
  failure. Once a failed read settles past that window, a bounded bottom-screen
  probe selects snapshot fallback or a visible stalled error instead of waiting
  for twenty failed reads. Individual native requests retain their own timeouts.

## 0.7.0

### Minor Changes

- 15a95b2: Herdr sessions can be streamed to the phone the same way as tmux. Herdr has no output stream
  with its history, so the computer redraws the pane from Herdr's reads: up to 1,000 lines of
  history, then the rows that change. An agent's transcript (Claude Code, Codex) is read again
  each time the agent finishes, so the phone's history holds the whole conversation, and lines a
  shell prints no longer go missing in the middle.
- cb8bdfe: The Mac app has a new Terminals section. Each terminal (iTerm2, tmux, Herdr) shows whether it's
  ready, what to do if it isn't, and one button where one helps: Connect iTerm2 (the only step that
  makes macOS ask), Open iTerm2, or Open Automation Settings after macOS blocked it. Terminals that
  aren't installed sit under "Other supported terminals". The menu bar shows "iTerm2 needs
  attention…" only when you have something to do, and the first-run card is now "Set up Shellbell"
  and points to Terminals.
- ba113ff: Explain each terminal's setup in plain words and ask macOS about iTerm2 only when you ask.
  The service reports why iTerm2, tmux or Herdr is not connected (iTerm2 closed, Python API
  off, waiting for you to connect, blocked by macOS or iTerm2, a dialog left unanswered, no tmux
  session, Herdr not running, or Herdr working with limits). `shellbell connect iterm2` starts
  the one step that makes macOS ask, `shellbell doctor` shows the same reasons and fixes, and
  phones are told when a terminal needs a step on the computer. Installs that already paired a
  phone keep connecting to iTerm2 as before.
- 8a5a125: tmux sessions can now be streamed to the phone as the terminal's own output, so the phone's
  terminal handles scrolling, history and full-screen programs itself instead of rebuilding
  them from snapshots. Only phones that ask for it receive the new stream; it uses one extra
  tmux connection while a session is open on the phone and never creates tmux sessions. Other
  phones and iTerm2 keep using snapshots.

### Patch Changes

- c475ad1: Ask macOS for less, and say why first. Shellbell asks to control iTerm2 only once iTerm2's
  Python API is on, and no longer reads Git in Desktop, Documents, Downloads, iCloud Drive or
  external volumes, which made macOS ask for those folders just to name a session's project.
  `shellbell service install` on macOS now explains in plain words each question macOS may ask
  next, and the install guide lists every prompt with what happens if you say no.
- 09f5310: When Herdr is running but new Herdr sessions cannot open, tell the phone why in one sentence:
  Herdr is older than 0.9.3, the `herdr` program cannot be found, or the program and the running
  Herdr are different versions. Older phones ignore it.
- 4866a6a: Open Herdr sessions from the phone with the same program as the running Herdr server, found
  from the server process on macOS and Linux, so Herdr installed by any package manager or in a
  custom folder works and the program always matches the server's version.
- cf3507d: Tell phones which macOS apps, such as Ghostty or iTerm2, are showing Herdr, by finding Herdr's
  client processes and their app. Older phones ignore the new session field.
- 97581aa: The service finds Herdr and tmux installed in `~/.local/bin` or `~/.cargo/bin`,
  which its fixed PATH leaves out, so the phone offers new Herdr sessions again.
- 1f570fd: The Mac app's setup screen now says what macOS may ask next (control iTerm2, find devices
  on the local network) and why, before you enable remote access. The app also gives macOS
  its own one-line reasons for those questions.
- Fixes from the pre-release audit. The Mac app stays usable after it refuses a settings save,
  keeps closed-lid protection, and says what to correct; it also keeps showing the right status
  after `shellbell service install` or an upgrade while it is open, and "Restore Previous CLI
  Setup" works after moving the service to the app. tmux discovery no longer hangs when tmux exits
  during startup, a Herdr reconnect no longer piles up background app checks, and
  `shellbell doctor` no longer reports a broken Herdr as ready. The DMG read-me says to remove
  closed-lid setup before deleting the app.
- 20e849d: Read tmux's control connection as bytes, so a character split across tmux messages is kept
  intact and pane output can be passed on exactly. tmux's newer `%extended-output` lines are
  recognised as output too.
- dc7b909: Tell phones which macOS apps, such as Ghostty or iTerm2, are showing each tmux session, so a
  new session opened from a tmux session on the phone appears in the same app.
- 3ee9862: A tmux session opened from the phone is kept only once its desktop window has actually attached.
  Starting Ghostty or iTerm2 is not enough: the app can start without its window attaching,
  which left the session running with no window. Such a session is now closed, and the phone
  says to unlock the computer and try again. Ghostty now opens in the foreground, because
  Ghostty started in the background never opened its window.

## 0.6.0

### Minor Changes

- fd747b5: TURN is now optional on each computer. It stays on by default; turning it off
  (Mac app Settings → General → **Allow TURN fallback**, or
  `shellbell config set turn off`) keeps terminal data off TURN servers:

  - The computer tells the relay when it signs in, and the relay gives none of
    that computer's phones TURN servers, clearing any a phone already holds before
    announcing the computer. The relay confirms this in `auth-ok`; with an older
    relay the computer logs a warning.
  - The computer requests no TURN servers and accepts a connection only when it
    can show the route is direct, rechecking while it stays open.

  Phones on networks that block direct connections, and some routes through
  strict NATs, cannot reach a computer with TURN off. Older clients and relays
  ignore the new fields.

### Patch Changes

- 21ba6e6: On filesystems without hard links, a failed write while creating the computer's
  identity (a full disk, an I/O error) no longer leaves a partial identity file
  that blocks every later start.
- 13e1fe1: The macOS service gives up on an iTerm2 connection that stops answering, during
  the API cookie request or the WebSocket handshake, and retries instead of
  waiting forever.
- bdccbe4: A pairing invitation closes once its five requests are used, instead of
  reporting pairing as busy until it expires, and an approval in progress is no
  longer discarded when the relay connection drops.
- 8bc617a: The Mac app saves settings when an unchanged relay URL or custom accent
  would not pass today's validation, such as a LAN `ws://` relay.

## 0.5.0

### Minor Changes

- 94ed8a4: Behaviour change: the relay no longer carries terminal data. Terminal screens,
  history, typing, the computer's hello and its session list only travel over the
  direct WebRTC connection; the relay carries sign-in, pairing, connection setup
  and notifications. With no direct connection the terminal stays paused while the
  devices keep retrying, and the phone's "Use relay temporarily" choice is gone.
  Both the computer and the phone refuse terminal data on the relay route, and the
  computer no longer answers the older v1 protocol at all, so a phone app from
  before secure v2 must be updated before it can connect.

  Private notifications are enrolled over the direct connection too, so a phone
  that cannot connect directly receives generic notifications until it does.
- ca05da9: Add a TURN fallback for networks that block direct WebRTC connections. A relay
  configured with TURN gives signed-in computers and phones short-lived TURN servers
  when they sign in and on request (`ice-refresh` / `ice-servers`), and each new
  WebRTC attempt uses them alongside STUN. The TURN server only forwards the
  encrypted data channel; terminal data stays end-to-end encrypted and never goes
  through the relay. The Cloudflare relay issues 24-hour Cloudflare TURN credentials
  when the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets are set; without them, and
  on the Node relay, devices keep using STUN only. Older clients ignore the new
  sign-in fields.

### Patch Changes

- Fix reliability problems found in a whole-repository review:

  - The relay answers every sign-in: one waiting for TURN credentials could be left
    signed in without a reply, and an unanswered TURN provider held up later
    sign-ins; it now waits at most five seconds.
  - The Cloudflare and Node relays decode stored notification jobs the same way, so
    a corrupt saved job fails closed on both.
  - A pairing QR code allows five requests even across a computer reconnect, and a
    confirmation already waiting still completes.
  - A failed pairing save no longer erases a phone's notification enrollment.
  - Two first starts at once keep one computer identity instead of overwriting it.
  - A relay URL too long for a pairing code is refused when it is saved.
  - A tmux screen showing a line that looks like tmux's end-of-reply marker no
    longer cuts a capture short or disconnects tmux.
  - Concurrent iTerm2 reconnects share one connection, so a closing socket no longer
    fails requests on the healthy one.
  - During an interrupted conversion, Mac Settings reads and saves the service's
    actual state directory.

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

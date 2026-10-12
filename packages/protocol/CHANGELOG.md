# @shellbell/protocol

## 0.3.0

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

## 0.2.0

### Minor Changes

- 5202bd4: Add owner-enabled local terminal adapters and an encrypted capability catalog.
  On macOS, offer new tmux or Herdr sessions in Ghostty or iTerm2, including cold
  startup. Preserve built-in creation for older phones, fence retired adapter
  results and keep healthy session discovery available during adapter failures.

## 0.1.0

### Minor Changes

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

## 0.0.2

### Patch Changes

- 9084eb1: Enable direct WebRTC negotiation in normal mobile connections. Pause terminal input and streaming until a direct route commits, including after direct loss; relay terminal traffic requires an explicit temporary choice. Keep relay signaling and notification enrollment available while the terminal is paused. Show the committed route and connection/retry progress in the app.
  
  Preserve keyboard visibility when tapping or scrolling terminal quick keys so the first tap reaches the key.
- 9084eb1: Move Settings to a header gear, add light branding and native version/build information,
  and remove the donation link. Explain automatic terminal scaling and disable manual
  font controls while it is active. Show supported terminal apps in a session picker
  with connection guidance, avoiding Android's native alert button limit.
  
  Advertise installed terminal backends separately from connected ones. A phone can
  launch iTerm2, start tmux's first session, or start Herdr's headless server and first
  workspace. Keep startup requests bounded and preserve existing target validation.

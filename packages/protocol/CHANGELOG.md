# @shellbell/protocol

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

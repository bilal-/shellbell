# @shellbell/protocol

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

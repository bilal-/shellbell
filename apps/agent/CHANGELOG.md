# shellbell

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

# macOS power-helper qualification

The helper and managed removal/recovery are implemented, but signed physical
operation is not release-qualified. See [native power ownership](architecture/native-controller.md#power-ownership)
and [the release checklist](before-first-release.md).

Every fresh app launch starts power controls off. Current-session choices are not persisted; Start at Login does not restore protection. Explicitly enabling closed-lid access verifies helper readiness and recovers an orphaned hold before acquiring. Source tests cover this flow through the real controller/client/session/lease engine, including quit restoration and refusal to take over active leases or removals. Signed/device qualification remains separate.

The source UI uses positive keep-awake controls and separate idle/display/lid
status. Read-only macOS details stay available when Shellbell is off. Idle assertion
IDs are verified against IOKit; closed-lid activity also requires fresh global
readback. A failed turn-off remains visible as still active with a failed change.
An observed interruption of the helper’s active override pauses lid reacquisition
until explicit retry. Regression tests connect the real controller, session and
lease engine to fake OS adapters; read-only native probes and isolated light/dark
SwiftUI previews are local evidence, not signed helper or physical qualification.

## Separation of responsibilities

Normal idle-system/display prevention uses process-scoped public assertions in
the desktop app. Closed-lid mode additionally needs the signed root-only
`ShellbellPowerHelper`, registered as `sh.bilal.shellbell.power` through
SMAppService. It never launches the terminal agent, reads pairing keys or handles
terminal content. Each user's terminal service and identity remain per-user. The battery option permits
ordinary idle assertions while the lid is open; closed-lid leases remain AC-only.
The UI reports battery pause, unknown power, and battery idle prevention separately.
An idle assertion does not prevent explicit Sleep, lid-close sleep, or a
low-battery sleep event; see [Apple’s idle-sleep assertion contract](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep).

The root helper validates its own publisher and accepts only the matching
publisher's `sh.bilal.shellbell.host` peer. XPC's code-signing requirement
is set before connection activation in both directions. The owner UID comes
from the connection, not JSON. Requests are limited to status/acquire/renew/
release/recover, with bounded payloads and monotonically increasing request IDs.

The helper owns an independent one-second watchdog plus power-source and
console-user notifications. It re-reads host eligibility before mutations.
Leases expire after 15 monotonic seconds without renewal. Startup attempts
durable-journal recovery before serving clients, and failed restoration keeps
the watchdog alive for retries. launchd supervision is intended to recover after
abnormal process death; it is not a promise of crash-atomic cleanup.

Known sleep-manager process detection is conservative: a recognized app blocks
closed-lid acquisition even when its session is inactive. BSD-truncated helper
names are recognized. This is not exhaustive detection of renamed or unknown
tools; existing global overrides are checked independently before acquisition.
Failed process inspection also blocks acquisition. Same-value writes by another
application cannot reliably be attributed. UI messages use generic sleep-manager
language. Do not run two closed-lid managers together.

## Local checks that do not change sleep settings

- Run `swift test --package-path apps/macos`.
- Run `pnpm -F shellbell exec vitest run test/native-power-probe.test.ts`.
- Run `pnpm lint` and `git diff --check`.
- Validate `apps/macos/Resources/sh.bilal.shellbell.power.plist` using
  `plutil -lint`.

The native helper's non-root invocation must exit unsuccessfully before touching
the journal/power controls. Unit tests use fake power adapters. Compiling the
test probe does not establish signed IPC security.

## Signed IPC gate: explicit authorization required

Only run after the release owner authorizes certificate use and an approved signed helper is
installed. The harness does not install/register a daemon. It creates temporary
probe binaries and signs those, not the installed app. Run as the logged-in user,
never root. It sends **status only**, not acquire/renew/release/recover.

```sh
SHELLBELL_SIGNED_POWER_TEST=1 \
SHELLBELL_POWER_SIGN_ID='Developer ID Application: publisher (...)' \
SHELLBELL_FOREIGN_SIGN_ID='Developer ID Application: Another Publisher (...)' \
SHELLBELL_TEAM_ID='YOUR_TEAM_ID' \
node apps/macos/scripts/check-signed-power.mjs
```

Replace placeholders with actual keychain identities and the ten-character
publisher Team ID. A genuinely different publisher is required; the harness does
not silently waive that check. It checks a matching caller before and after
wrong-bundle, foreign-publisher, ad-hoc and unsigned rejection probes. Timeouts
are failures, not evidence of rejection. Retained temporary artifacts are printed
for inspection; no certificates, private keys or passwords are copied.

On arm64, unsigned Mach-O execution may be blocked before IPC. The harness skips
that IPC attempt and exits **incomplete**, even if the other probes pass. Record
separate unsigned-execution qualification; do not claim kernel launch refusal
proves the helper rejected an XPC message. Real Intel/minimum-OS testing remains
a separate release gate.

## Remaining signed and physical gates

- Actual SMAppService registration, cancelled approval, revoked approval and
  unregister behavior with the bundled signed/notarized app.
- Matching/foreign/unsigned peer evidence, replay and oversized-message
  rejection; connection death and reused PID cannot transfer lease ownership.
- AC disconnect/reconnect, unknown source, console switch/logout and lease
  expiry while the desktop UI is hidden or dead.
- Forced helper death/restart and reboot with prepared/applied/recovery journals.
- Restore before app Quit, helper removal and update; handle the race between
  verified idle status and daemon unregistration without a new acquisition.
- Failure to restore leaves actionable recovery status and durable evidence,
  rather than a clean-success message.
- Both Shellbell command failures and external changes: manual override on/off,
  other apps’ idle/display requests, unknown/stale readings, and no takeover of an
  unowned global override. Confirm interruption pauses lid access, explicit retry
  recovers, and idle/display status remains independent. Use disposable qualified
  tests; do not run arbitrary power mutations on a user’s working Mac.
- Settings clarity with master off, battery paused/opted in, pending approval,
  revoked approval, failed release, helper restart and interrupted maintenance.
  Verify long error text, VoiceOver, light/dark mode and expanded power details.
- Display sleep, manual Sleep and lid-close behavior on supported Apple Silicon
  and Intel hardware/OS versions; no safety claims from unit tests alone.

These require specific authorization. Source tests do not substitute for signed
Settings/lifecycle and physical qualification. Managed removal/recovery is
implemented; real signed installation and visual checks remain open. Packaging verifies the
helper explicitly; real signed installation/update/removal still requires the
gates above. Also test pending OS unregistration plus app/helper crash, durable
maintenance across reboot, and explicit recovery after reinstall. Maintenance
must never clear another application's override or resume closed-lid intent.
Record results against the exact signed artifact in the release qualification record.

References: [Apple console-user semantics](https://developer.apple.com/documentation/systemconfiguration/scdynamicstorecopyconsoleuser%28_%3A_%3A_%3A%29),
[SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice).

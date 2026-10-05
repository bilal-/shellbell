# macOS power-helper qualification

The helper and managed removal/recovery are implemented, but signed physical
operation is not release-qualified. See [native power ownership](architecture/native-controller.md#power-ownership)
and [the release checklist](before-first-release.md).

## Separation of responsibilities

Normal idle-system/display prevention uses process-scoped public assertions in
the desktop app. Closed-lid mode additionally needs the signed root-only
`ShellbellPowerHelper`, registered as `sh.bilal.shellbell.power` through
SMAppService. It never launches the terminal agent, reads pairing keys or handles
terminal content. Each user's terminal service and identity remain per-user.

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

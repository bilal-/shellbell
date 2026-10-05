# Native macOS controller and lifecycle

The Swift menu-bar app controls the TypeScript terminal service through a private
Node bridge. It owns desktop service consent and lifetime, pairing UI, settings,
explicit recovery and optional power controls. The engine and paired-phone protocol
remain shared with headless installations. See [build and operation commands](../../apps/macos/README.md)
and [release qualification](../before-first-release.md).

## Desktop and headless ownership

A desktop service is a supervised child with a private inherited owner pipe.
First use requires consent; later app launches can start the consented service.
Closing Settings leaves it running. Quit closes owned pairing, stops the exact
owned service and verifies exit before the UI closes. Failed cleanup keeps the UI
available for retry. Controller death or owner-pipe loss stops Shellbell access,
not the terminal processes it was mirroring.

A headless installation belongs to the current user's OS manager: launchd on
macOS or systemd-user on Linux. Opening or quitting the app neither adopts nor
stops it. Ordinary CLI startup refuses desktop-owned state or an unfinished
ownership conversion before initializing backends or credentials.

Desktop login startup uses `SMAppService.mainApp`. Headless startup is controlled
through its manager. Registration, desired startup preference, observed enablement,
running process, verified local readiness, relay connectivity and backend health
are separate observations. Stop retains future startup policy; disable changes
that policy without implicitly stopping now.

Explicit conversion records intent, stops/disarms the source, verifies absence,
then starts and certifies the destination. The transition ID binds admission of
the destination runtime. Interrupted effects are reobserved and require explicit
recovery rather than blind replay. Keys, pairings and configuration are preserved.
A bundle-backed headless runtime still requires the app at its installed path.

## Local protocols and configuration

Swift-to-Node communication uses the strict native bridge protocol. Node-to-running
service communication uses [local control v2](../local-control-v2.md). These are
separate from the encrypted phone/relay wire protocol.

The bridge enforces hello-first negotiation, increasing IDs, one pending request,
bounded input/output, deadlines and command-specific result validation. Mutations
carry observed runtime/revision expectations. Unknown delivery is not automatically
retried. Pairing consent belongs to its exact socket, flow and challenge; losing
that owner declines consent rather than transferring it to an observer.

Settings edits use validated, coordinated publication. The service's applied
configuration is its startup snapshot; `status.config` reports its normalized
revision. A validated older-service unsupported response yields an unknown applied
revision, not assumed agreement or permission to replay a mutation.

## Durable metadata and recovery

Private revisioned records hold service mode, consent, startup preference,
controller selection and recoverable transitions. `service-owner.json` and
`controller.json` use bounded private-record storage, detached snapshots and atomic
publication. Inspection does not create or repair state. Directories are `0700`,
files `0600`; unsafe existing ownership and permissions are refused.

Lock order is **host/user ownership → native record, when present → platform
manager/definition**. Never nest a public lifecycle mutation inside a guard it
must itself acquire, or hold the endpoint guard while launching a child that needs
it. Late transaction callbacks cannot publish after the transaction ends. This
coordinates cooperating same-user processes; it is not adversarial filesystem CAS.

Legacy manager migration/recovery remains in the coordinator for older CLI and
native definitions. A persisted legacy-restore transition includes separate
`restartPrevious` consent before restoring or loading a job. Backup running state
alone cannot establish that consent. Read-only inspection does not continue a
transition; explicit Continue rechecks ownership and refuses missing intent.
Old manual/persistent job metadata is a compatibility/recovery boundary, not the
current desktop lifetime model.

## Power ownership

The desktop app owns ordinary IOKit idle-system/display assertions. Its controller
evaluates saved preferences against external power, fresh verified desktop-service
ownership and laptop capabilities. A one-second driver runs independently of menu
visibility; status and closed-lid renewals run on five-second intervals. Headless
ownership, stale status and unknown power sources cannot acquire protection.

Optional closed-lid access uses a separate root `ShellbellPowerHelper` through
bounded authenticated XPC. Both sides require the expected bundle identifier and
externally validated Developer ID Team ID. The helper derives user identity from
XPC and binds leases to the connection. It accepts fixed operations and never
reads terminal content, service credentials or pairing keys.

The lease engine durably records intent before changing the fixed sleep override,
verifies readback and AC/console eligibility, and expires after fifteen monotonic
seconds without renewal. Its independent watchdog and host notifications recover
owned changes on expiry, connection loss or ineligibility. Startup recovers journals
without resuming old leases; unsafe journals or unknown external state fail closed.

Managed removal first restores normal lid sleep and releases app controls, then
persists a maintenance hold that prevents new leases through OS unregistration,
client loss or helper restart. Explicit recovery clears it only after proving the
override is off. Quit waits for serialized power/service cleanup and cannot report
clean success after either fails. See [power-helper qualification](../macos-power-helper-qualification.md).

## Packaging trust

| Artifact | Tooling checks | Separate qualification |
| --- | --- | --- |
| Development app / DMG | Clean committed export, pinned Node archive, inventory, imports, architecture, notices and isolated version/help smoke | Publisher identity, Gatekeeper and actual lifecycle |
| Signed candidate | External expected Team ID, fixed code requirements, inside-out copy-only signing, exact entitlements and detached hashes | Real certificate/runtime qualification |
| Signed / notarized DMG | Image publisher before mount, unchanged embedded candidate, final-byte report and explicit notarized-stage checks | Clean-machine download, quarantine, offline ticket and lifecycle |

Private Node lives at `Contents/Helpers/node`; JavaScript and its license remain
under Resources. The power helper and LaunchDaemon are separately inventoried and
signed. Candidate verification must not infer trust from the candidate's own
manifest. Node's proposed entitlement policy is `allow-jit` only; runtime failure
is not authority to broaden it silently.

Development builds and fake-manager tests do not establish Login Items approval,
logout/reboot, relocation, Intel/minimum-OS behavior or privileged-helper operation.
Follow [signing](../macos-release-signing.md), [the live release checklist](../before-first-release.md)
and the app's managed removal procedure before replacing a configured bundle.

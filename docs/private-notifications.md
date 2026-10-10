# Private notifications

The relay sends directly through FCM HTTP v1 on Android or APNs on iOS. The phone
registers a native token; Expo libraries supply on-device APIs, not a push gateway.
Private notification context is encrypted for the recipient and presented by native
receivers. Shared provider-envelope fixtures are consumed by Swift/Kotlin tests.

Visible S22 and signed TestFlight iPad APNs delivery have owner confirmation.
Fold 7 delivery, rich/generic fallback, tap routing and the wider device matrix
remain open in
[the qualification checklist](before-first-release.md). This guide describes the
current contract; [mobile QA](../apps/mobile/QA.md#direct-fcmapns-notifications) defines
the device procedure.

## What changes

An alert identifies its terminal, not merely how many sessions exist. The primary label
uses custom name → repository and branch → terminal title → stable session label.
Computer and session identity remain visible; Android puts the session label at the
start of the collapsed body because some OEMs truncate secondary headers. Two terminals
in the same repository have independent identities, replacement tags and dismissal.

Reasons describe evidence: command finished (with exit status/duration when known),
terminal returned to a prompt, session went quiet, agent finished, or agent waiting.
Quiet is not claimed to be a question. The default quiet threshold is 30 seconds;
explicit user configuration is preserved. Repeated blocked state is debounced.
Raw commands, questions and terminal output are not notification previews.
Path/URL-bearing display labels are omitted rather than guessing safe fragments; absolute
Unix/Windows/UNC/home-relative paths, remote-host paths and origin URLs fall back to stable
session identity. Ordinary labels and slash-separated Git branches remain supported.

Repository context is obtained only for proven local directories. Git probes are read-only,
bounded and cached, with session/cwd rechecks after asynchronous work. An SSH/container
guest is not guessed from the host repository. Unknown context falls back to session
identity. No network Git operation or shell input is used for discovery.

## Native push tokens

Android registers native FCM tokens. iOS uses the signed provisioning profile’s
APNs environment when available. App Store distribution removes that profile,
so an absent environment is treated as production only when the native release
API classifies the app as an App Store build, including TestFlight. Simulator,
unknown and failed classifications remain unregistered. The same rule applies
to initial registration and token rotation. See [Apple’s provisioning profile
reference](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

## Enrollment and delivery

1. The phone authenticates its connection and reads the agent's encrypted application
   `hello` capability. Old agents remain generic.
2. Native crypto, storage and receiver readiness must all succeed. The phone creates a
   fresh random generation, derives its notification-only key and awaits durable native
   storage before sending encrypted `notification.enroll`.
3. The agent durably commits enrollment. Only its matching `notification.enrolled`
   acknowledgment permits the phone to register `notify-context-v1` with a capable relay.
4. The agent reserves per-recipient usage/sequence before encrypting current context.
   The relay selects only that phone's box and routes it through the existing bounded
   notification journal and provider budget. It has neither plaintext nor decryption keys.
5. Native code authenticates, validates freshness and replay state, commits its high-water
   mark and rechecks generation, revocation and privacy immediately before presentation.
   JavaScript does not enrich or dismiss a native-owned incoming rich payload.

Enrollment times out after ten seconds without an acknowledgment and retries with a
fresh generation on the next authenticated connection. Reconnect/unpair retires old
attempts. Native mutations are serialized so delayed installs cannot overtake revocation.
Backgrounding closes the connection without downgrading the already-enrolled push token.

## Cryptographic and storage boundaries

HKDF-SHA256 derives a 32-byte notification key from the pairing key, domain
`shellbell-notification-v1`, and computer/phone/generation tuple. AES-256-GCM uses a
random 96-bit nonce and 128-bit tag. Associated data binds the domain, computer, phone,
generation, session and event. The native module receives only the derived key, never
the pairing key or identity private key. Terminal transport encryption is unchanged.

- Current and previous generations only; previous-key grace is five minutes.
- At most 2²⁰ encrypted messages per generation, reserved durably before encryption.
- Two-minute freshness, 60-second clock-skew allowance, canonical positive u64 sequences,
  and at most 500 unexpired replay entries per computer.
- Plaintext ≤1,536 bytes; ciphertext ≤1,552 bytes; provider JSON ≤3,500 bytes.
  Existing control ingress remains 16 KiB; excess fan-out uses generic fallback.

iOS notification keys use a narrowly shared Keychain access group with
AfterFirstUnlockThisDeviceOnly and no synchronization. Pairing/identity SecureStore keys
remain WhenUnlockedThisDeviceOnly. App-group metadata is backup-excluded, atomically
written and locked across host/extension processes. Android wraps derived keys with an
Android Keystore AES key in credential-protected, backup-excluded storage. Before first
unlock, missing/corrupt keys, failed durable writes or revoked enrollment fail closed.

Native metadata contains identity/generation ownership, replay counters and the privacy
preference: not repository labels, output or commands. Private labels exist transiently
while decrypting and in OS-displayed notifications. The legacy on-device title cache
remains for old peers; do not describe the phone as retaining no session metadata.
See [Privacy](../PRIVACY.md) for relay/provider visibility and retention.

## Presentation and cleanup limits

Android rich pushes are data-only and have one native receiver. Session tags are SHA-256
of a versioned JSON tuple, with separate computer groups and silent summaries. An existing
session alert is replaced; opening a session removes only its alerts and an empty summary.
Foreground native presentation is suppressed. Permission/OEM/provider behavior can still
prevent delivery; Android background execution is not guaranteed.
After posting an authenticated replacement, Android removes exact-match legacy routing
alerts too (Expo's ID 0 differs from the native ID). Unknown metadata is left alone.

iOS sends a generic mutable alert to a Notification Service Extension. The extension's
completion gate runs once even if decryption races the OS timeout. It removes only older
authenticated delivered alerts for the same computer/session. iOS does not provide an
atomic replace/suppress guarantee: a timeout or stale arrival may leave a generic alert.
Local fixtures and simulator compilation are not proof of signed locked-device delivery.
The first rich iOS alert also removes old-format delivered alerts only when their routing
metadata identifies the same computer/session; unsequenced rich hints are not treated as proof.

Settings → Hide notification details is stored natively and affects future alerts, even
without JavaScript running. It also disables legacy JS title enrichment. Existing delivered
alerts and OS history are not recalled. Provider metadata still includes opaque routing
identifiers; current generic pushes use `Shellbell` as their title; the relay separately knows
the paired computer name. Older installed apps may retain historical alerts.
An error can happen after an atomic rename committed the setting. On failure, Settings
reloads native truth; if that also fails it displays **Unknown**, never an asserted hidden state.

Opening an alert first opens its paired computer and waits for a fresh session list from
the current handshake. Missing sessions stay on the computer list. Pairing is rechecked
while waiting, so unpaired/removing targets do not auto-open a stale terminal.

Unpair writes a durable `removing` marker, stops reconnects, removes native notification
state/alerts, deletes the pair secret, then removes the computer record and title cache.
Failure leaves **Finish unpairing**, never automatic reconnect. This app has no separate
factory-reset UI; any future reset must use the same ordered cleanup, not raw record deletion.
Pairing commits and removal are serialized per computer, and cleanup is bound to the pairing
ID it owns. Existing computers must finish Unpair before re-pairing; a new scan cannot clear
a pending revocation marker or let an old cleanup delete a replacement pairing.

## Qualification and rollout

[Mobile QA](../apps/mobile/QA.md#direct-fcmapns-notifications) separates local fixtures from actual provider delivery.
Shared public OpenSSL fixtures are routed byte-for-byte through the authenticated relay
harness and decrypted/presented by Swift and Kotlin without a JS title cache. On-device
Android instrumentation uses a separate disposable QA package, preserving owner pairings.

Before public release: qualify direct FCM/APNs delivery with synthetic paired sessions,
two computers, same-repository terminals, stopped/background/locked app, duplicate/reversed
delivery, offline recovery, denied permissions, hide-details, tap routing and unpair.
Count visible alerts and sounds; record timestamps, build, OS and screenshots. Android
direct receiver invocation is not FCM transport proof. iOS requires the `.notifications`
extension bundle ID, matching app group and narrow Keychain group provisioned on the same
Apple team; inspect actual archive entitlements and host/extension versions before upload.
Do not mint credentials or change account entitlements implicitly.

Authorized rollout order: additive relay first, agent next, qualified native clients last.
Deployment, installation, signing and submission are separate actions. Never merge npm
Version Packages PR #9 as part of notification rollout.

Rollback uses generic capability registration (`features: []`), which invalidates pending
rich jobs for that registration; stop enrolling new generations and remove native keys
through the cleanup API. A binary rollback alone may leave an old relay registration until
the app reconnects: confirm registration downgrade rather than assuming installation did it.
Already accepted provider pushes and OS history cannot be recalled.

## Troubleshooting and resume

- Generic only: receivers are enabled, but rich delivery still requires agent/relay
  capability, successful native storage and authenticated enrollment. Check the
  enrollment acknowledgment and notification permission; an old client or missing
  capability intentionally falls back to generic delivery.
- Late/missing alert: check two-minute freshness and clock skew, foreground lease suppression,
  provider outcomes and OS restrictions; provider acceptance is not a display receipt.
- Stuck Finish unpairing: unlock and retry cleanup. Do not remove files or pairing records
  manually; that can orphan key ownership or replay counters.
- Agent notification state missing/corrupt: initialized-state guard intentionally stays generic.
  Recovery needs coordinated fresh enrollment/replay state, not deleting a counter file.
- Reproduce with public fixtures and synthetic sessions, never typing into an owner's shell.

For implementation and device checks, use [the architecture overview](architecture/README.md)
and [mobile QA](../apps/mobile/QA.md#direct-fcmapns-notifications).

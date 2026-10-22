# Before first release

This is the live release checklist. Source tests, local artifacts, device checks
and production qualification are separate. Publishing, release tags, deployment,
notarization and store submission require explicit owner authorization; release
automation remains disabled unless its dedicated repository flag is enabled.

## Qualification status

| Area | Established | Still required |
| --- | --- | --- |
| iOS owner testing | TestFlight 1.0.0 (4) delivered; owner confirmed iPad direct Wi-Fi/5G handoff on build 3 and visible notification delivery on build 4 | Notification-content and routing matrix, background/sleep and broader device/network checks |
| Direct notifications | FCM/APNs adapters and native-token enrollment implemented; owner confirmed visible S22 and signed TestFlight iPad delivery | Full Android matrix, Fold 7 delivery, iOS rich/generic fallback and notification-extension behavior |
| Android owner builds | Local standalone builds tested on S22 and Fold 7; optimized 1.1.0 (12) accepted and assigned to Google Play internal testing through an explicit local upload | Qualify the exact store-delivered artifact and wider device/accessibility checks |
| Direct transport | Secure-v2 bootstrap, verified WebRTC cutover, encrypted fallback and bounded periodic retries implemented; S22/Mac same-network drills passed; owner reports Fold 7 and iPad direct use on 5G with repeated Wi-Fi/cellular recovery | Broader cellular/cross-network and handover matrix, background/sleep and independent security review |
| Terminal startup | Installed-backend discovery, bounded startup and empty-workspace creation pass source tests; isolated real tmux cold startup returns one readable session; source tests require every phone-created session to open in a desktop window, refuse without one and close a session whose window failed | Physical phone-driven cold iTerm2/Herdr startup, new Ghostty/iTerm2 host choices including the automatic iTerm2-then-Ghostty choice and refusal on a computer without either, local plugin lifecycle and phone-preferred initial grids in new independent windows (including keyboard/orientation changes), target-platform/version matrix |
| Phone creation picker | Engines grouped once with explicit host and size selection; source regressions and Android emulator layout checks pass; S22 opened an isolated tmux session in Ghostty with custom dimensions | Exact host sizing and broader device matrix remain open: Ghostty adjusted a requested 62 × 32 grid to 65 × 34 in the local check; qualify iTerm2/Herdr creation, keyboard/orientation changes and store-delivered artifacts |
| Herdr streaming | Bounded rendered-screen observation and constant-revision/handover/stale-read regressions pass source tests; signed Mac build 5 installed and owner confirmed live streaming on Fold 7; earlier iPad build 4 streamed | Qualify the updated host with the current iPad build and broader terminal workloads, including font resizing, desktop scrollback, busy-output snapshot fallback and unreadable-source recovery |
| Relay runtimes | Hosted Cloudflare relay reports 0.3.0; HTTP health and version checks pass. Core, Workers and one-process Node pass local conformance; container checks cover native arm64 and emulated amd64 | Target volume, TLS/proxy, backup/restore, upgrades, devices and intended load |
| macOS distribution | Computer 0.8.0 arm64 build 30 published; exact source CI, Developer ID signing, notarization, stapling, Gatekeeper, bundle integrity, native WebRTC loopback, artifact audit and anonymous download hashes passed. Official owner-Mac upgrade preserved identity, pairings and configuration; Start at Login restored | Clean-machine installation, offline Gatekeeper and revised helper lifecycle remain open; no Intel installer |
| macOS power controls | Signed build 16 starts with power controls off; managed removal of build 15’s helper, upgrade, retained pairings, restored user choices and build 16 helper readiness were verified. Physical closed-lid operation was owner-confirmed on build 15. Source tests cover session-only choices, independent assertion/lid state, external interruption and real controller/session/engine retry | Broader administrator lifecycle, external power changes, sleep/wake, battery transitions and hardware/OS matrix remain open |
| macOS headless distribution | Computer 0.8.0 published to npm and as a release tarball; the public registry download matches the release checksum. Global prefix install, help and version passed on Apple silicon | Real headless launchd login/logout/reboot, Intel execution and device pairing/transport on the exact package |
| Linux distribution | Published 0.8.0 archives pass Ubuntu 22.04/24.04 install/upgrade/removal regressions, native WebRTC, real tmux and two-user isolation on native ARM64 and emulated x64 containers. Artifact audit, anonymous download hashes and public one-line installation/version checks passed; earlier 0.7.0 checks also reached relay and tmux readiness | Native x64 service boot, target filesystems/shared-home behavior, phone pairing/transport/push and current-artifact systemd logout/reboot; earlier ARM64 VM service checks remain separate |
| Public distribution | Public source and computer 0.8.0 Mac, npm CLI, release tarball and Linux downloads are available. Mobile 1.1.0 Android 17 / iOS 14 are delivered with verified internal store assignments | Device qualification and public mobile store publication remain separate |

Current mobile source enables secure-v2 WebRTC negotiation in normal connections.
Terminal subscriptions and input pause until the direct route commits, including
when a direct connection is lost. The relay never carries terminal data; relay
coordination and direct retries remain active. The owner confirmed direct use and repeated Wi-Fi/cellular recovery on
Fold 7 and on iPad with TestFlight 1.0.0 (3). Background/sleep, production APNs
and broader store-delivered device and cross-network checks remain open.
See [direct transport](architecture/direct-transport.md).
Store exact artifact hashes, signing identity, build numbers, tool versions and
observations in the relevant release record. Keep account-specific details and
unredacted device evidence private. This page records current qualification scope,
not a deployment diary or permanent test transcript.

Current release records: [computer 0.8.0, Mac build 30, CLI and Linux](https://github.com/bilal-/shellbell/releases/tag/shellbell%400.8.0), [relay 0.3.0](https://github.com/bilal-/shellbell/releases/tag/relay-v0.3.0) and [mobile 1.1.0, Android 17 / iOS 14](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.9.1). Store acceptance and artifact verification do not replace physical checks on the exact builds.

## App agreements

- [ ] Qualify first launch Agree / Decline, saved agreements, terms and privacy links, and custom relay confirmation on signed iOS, Android and Mac builds. Source checks do not establish device qualification.
- [ ] When changing terms materially, publish a new version under `legal/terms/`, update `TERMS.md` and both apps' version and URL constants, and verify that the previous agreement prompts again. Keep published versions unchanged.

## Documentation and public repository

- [ ] Run final public-source and artifact-metadata audits; retain licenses, trademark policy and third-party credits.
- [ ] Review the prospective public Git history for private contact details and historical private provenance; current-file cleanup does not remove earlier commits.
- [ ] Confirm that the maintainer's private security-reporting contact is monitored; do not announce an unverified mailbox or GitHub reporting feature.
- [x] Make the repository public only after explicit owner authorization.
- [x] Bring `shellbell.dev` online; confirm a public HTTPS response.
- [x] Align the website's repository, download, store and contact links with the public release and owner preferences.
- [ ] Review initial component versions and apply Changesets on the release branch; follow [versioning and changelogs](versioning.md).
- [ ] Align public store version records with the intended signed candidates; review the [prepared listings and screenshots](../apps/mobile/listing-review.html), complete privacy/data-safety declarations and distribution-country encryption requirements.
- [ ] Prepare release notes with qualified artifact results. Download instructions must name actual published artifacts.
- [ ] Have a new tester follow setup and pairing instructions; record confusing steps and correct the guides.

## Mobile and direct transport

- [ ] Qualify Conversation delivery and phone clearing with the default-off owner
  setting: verify live opt-out, clear acknowledgement before re-enabling, route
  loss/revocation cleanup, and terminal input latency under load. Complete anchored
  older-file paging qualification; check hardware-keyboard focus, inverted-list scroll retention
  and cap notices on devices. Local source tests do not satisfy these gates.

- [x] Connect the phone's bounded native terminal checkpoint, negotiated applied
  progress, source provenance, and four-state recovery before requesting the
  complete continuation extension set. Source checks cover compatibility and
  ownership; exact device-build qualification remains below.
- [ ] Qualify native older terminal paging on owner devices: top gestures, retained
  search/selection while pages rebuild, explicit refresh after capture expiry, and
  10,000-row/4 MiB limits. Source regressions cover discarding an evicted hidden
  rebuild and resuming unread output in the surviving visible terminal. Local
  headless and Chromium/WebKit checks do not qualify
  device keyboard, memory pressure, scrolling or application lifecycle behavior.
- [ ] Qualify continuation on owner devices: retain scrollback across resize,
  label unproven joins and Herdr replacements, reconstruct partial UTF-8/escape
  parser state on WebView reload, keep memory within the checkpoint cap, and
  measure bridge transfer and restore time, and verify scrolled-up reading, search
  reset and foreground-only renderer timeouts. Source tests do not satisfy this gate.

- [x] Prepare the shared Android/iOS version line with Changesets; use fresh platform build numbers and testing channels for beta candidates. Mobile 1.1.0 is available in internal testing; earlier device observations remain evidence for their exact builds.

- [x] Replace Expo push delivery with direct FCM/APNs adapters and native token registration.
- [x] Observe background S22 push and obtain owner confirmation of visible presentation.
- [x] Install the native-token owner build on S22 and Fold 7.
- [x] Enable Android release R8 optimization/obfuscation and unused-resource shrinking across native regeneration.
- [ ] Qualify pairing, terminal, WebRTC and notification delivery on the optimized store-delivered Android artifact; retain its exact mapping and symbol files.
- [x] Implement secure-v2 relay bootstrap, authenticated direct cutover, encrypted fallback and periodic retries.
- [x] Qualify same-network S22/Mac direct screen/input and recovery drills.
- [x] Implement network-aware mobile recovery and offline messages; observe S22
  Wi-Fi loss/restoration, blocked offline input and fresh direct recovery with a
  disposable terminal fixture.
- [ ] Qualify rich/generic fallback, two-session replacement and tap routing, token rotation, unpairing, denied permissions and hide-details on approved devices.
- [ ] Qualify cellular, restrictive networks, network changes, suspended/background apps and prolonged direct failure, where the terminal stays paused and recovers once direct returns.
- [x] Register Apple app/extension identities and the shared notification group; verify App Store profiles and export a signed TestFlight candidate.
- [x] Correct the iOS native ICE locator conversion and verify TestFlight 1.0.0 (3) direct connection on the owner’s iPad over Wi-Fi and 5G, including handoff. Notification delivery remains a separate check.
- [x] Verify local delivery, processing and internal-group assignment for Android 1.1.0 (12) and iOS TestFlight 1.1.0 (9); preserve their exact crash diagnostics. Candidate: [current release records](https://github.com/bilal-/shellbell/releases).
- [x] Confirm visible production APNs delivery on the owner's iPad with TestFlight 1.0.0 (4); rich content, tap routing, rotation and development builds remain separate checks.
- [ ] Qualify signed development/production iOS builds with physical APNs delivery, including the notification extension.
- [ ] Qualify the iOS native direct adapter and its network/device matrix before public activation.
- [ ] Complete an independent secure-v2/transport security review before public release.
- [ ] Qualify direct-only terminal pause and visible connection progress on store-delivered builds, including Wi-Fi/cellular handoff.
- [ ] Qualify the TURN fallback on a network that blocks direct connections (UDP blocked, then TCP/TLS 443 only) with store-delivered builds, and record the selected candidate type.
- [ ] Audit WebRTC native notices in Android/iOS artifacts and expose required texts in Open-source credits. Verify data-only permissions and App Store usage-string requirements.
- [ ] Qualify iOS 27 and iPhone Duo on a fresh signed candidate: scene-based
  launch, both displays, keyboard/layout changes, background recovery, deep
  links and notification taps. The current internal candidates include the scene setting; simulator/layout checks do not establish physical Duo behavior.
- [ ] Run the [mobile QA checklist](../apps/mobile/QA.md), including terminal history, selection, accessibility, Unicode, input uncertainty and lifecycle.
- [ ] Qualify the pending terminal-status layout fix on the exact Android and iOS
  candidates: ordinary receive/render progress must not insert a row above an
  existing terminal, and pause recovery must remain usable without resizing it.
  Cover S22, Fold 7 and iPad with the keyboard open and closed. Source regressions
  and local Android recordings do not qualify the store-delivered artifacts.

- [ ] Qualify history recovery and input changes on Fold 7 (cover and unfolded),
  iPhone and current iPad builds: empty-cache reconnect, busy/empty refresh, Herdr
  blank viewport tails, command bar, Live keys (including automatic switching for
  tmux full-screen programs) and Secret input focus, paste/Return ordering and
  same-Wi-Fi versus remote typing. S22 local-test checks cover paging an 8,192-line
  isolated tmux fixture back to its first line, searching the loaded history,
  returning live with the keyboard open, retaining an older searchable line across
  reconnect, and sending one exact command afterward. The Fold/iOS, other-backend,
  busy-output and cross-network matrix remains pending; Herdr retains its 1,000-row
  native read limit.
- [ ] Qualify the xterm-owned buffer, keyboard/IME, touch selection, search, styled
  copy and footer behavior on updated Android/iOS artifacts. Native compilation
  and browser checks cover source behavior; physical keyboard attachment, CJK,
  touch handles, VoiceOver/TalkBack and clipboard menus remain device checks.
  Bilal confirmed improved flick scrolling on the S22 local test build; this
  does not complete the remaining input, accessibility or device matrix.

- [ ] Qualify one-use mobile Shift/Ctrl/Alt input on Android and iOS, including
  Shift + Left in Codex after dismissing the waiting replies, dismissal in compact
  and offline layouts, combined modifiers, rejected input, keyboard retention
  and accessibility. S22 local-test checks cover menu shortcuts, explicit y/n and
  yes/no replies, pinned Enter/Close, keyboard-open dismissal, and Shift + Left
  both in the waiting strip and restored keys. Accepted bytes were checked against
  a synthetic backend over the direct route. The offline iOS simulator flow also
  covers dismissal and Shift + Left. Store-delivered builds, physical iOS,
  compact/offline device cases, combined modifiers and accessibility remain pending.

- [ ] Qualify terminal Mouse mode on Android/iOS with a matching Herdr CLI/server:
  live-cell taps, fit-width and horizontal scroll, stale grid rejection, existing
  controller refusal, keyboard retention, disconnects and reconnects. Source and
  disposable native-PTY checks do not qualify the device experience.

## Computer releases

- [ ] Qualify desktop/headless conversion, consent, Quit, owner loss, login/reboot and recovery on signed Mac artifacts.
- [x] Align Linux downloads with `shellbell@X.Y.Z` and require explicit Mac candidate build numbers in packaging and verification.
- [x] Qualify the Linux archive/checksum download path against actual published release assets: the 0.7.0 one-line install from the public release passed on clean Ubuntu 24.04 ARM64 and emulated x64 containers.
- [x] Reserve increasing Mac build numbers in the private release ledger and qualify them in signed distribution artifacts.
- [ ] Qualify Developer ID signing, notarization, Gatekeeper and privileged-helper installation/removal.
- [ ] Qualify the revised keep-awake settings and power observer on the exact signed Mac artifact, including manual override interruption/retry, failed turn-off, battery opt-in, stale readings and actual lid behavior. Follow [power-helper qualification](macos-power-helper-qualification.md).
- [x] Verify source-built Linux archives, native WebRTC and tmux on Ubuntu 22.04/24.04 in native ARM64 and emulated x64 containers; verify systemd-user logout/login and reboot in ARM64 VMs.
- [ ] Qualify native x64 service boot, intended Linux filesystems and phone pairing/transport/push before publishing Linux artifacts.
- [ ] Review final signed/packaged artifacts for private paths, credentials, attribution and runtime provenance.

## Relay operations

- [x] Extract shared policy while preserving atomic budgets/claims, revocation, ownership and bounded queues in both adapters.
- [x] Complete relay extraction and subsequent source review/refactor passes with local conformance checks.
- [ ] Bound the Node literal-text heartbeat reply rate; see [heartbeat admission](architecture/extensibility.md#relay-heartbeat-admission).
- [ ] Qualify the target volume, process ownership, restart recovery, TLS/proxy and abuse controls.
- [ ] Exercise upgrade, offline backup, restore and rollback on the operator's exact deployment with disposable pairing state.
- [ ] Qualify pairing, encrypted terminal input/output and push against the chosen runtime.
- [ ] Measure realistic load and direct-fallback bursts before publishing hosting recommendations; [capacity arithmetic](architecture/relay-capacity.md) is not measured user capacity.

The [self-hosting guide](self-hosting.md) requires no access to the maintainer's
hosting or store accounts. Organizations should also use
[the operations guide](organization-relay.md). Remaining backend extension work
is tracked in [extensibility](architecture/extensibility.md).

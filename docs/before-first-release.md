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
| Android owner builds | Local standalone builds tested on S22 and Fold 7; optimized 1.0.0 (6) accepted and assigned to Google Play internal testing by CI | Qualify this store-delivered artifact and wider device/accessibility checks |
| Direct transport | Secure-v2 bootstrap, verified WebRTC cutover, encrypted fallback and bounded periodic retries implemented; S22/Mac same-network drills passed; owner reports Fold 7 and iPad direct use on 5G with repeated Wi-Fi/cellular recovery | Broader cellular/cross-network and handover matrix, background/sleep and independent security review |
| Terminal startup | Installed-backend discovery, bounded startup and empty-workspace creation pass source tests; isolated real tmux cold startup returns one readable session | Physical phone-driven cold iTerm2/Herdr startup and target-platform/version matrix |
| Herdr streaming | Bounded rendered-screen observation and constant-revision/handover/stale-read regressions pass source tests; owner reports streaming on iPad build 4 | Install updated host and qualify its new observer on physical devices |
| Relay runtimes | Core, Workers and one-process Node pass local conformance; container checks cover native arm64 and emulated amd64 | Target volume, TLS/proxy, backup/restore, upgrades, devices and intended load |
| macOS distribution | ARM64 Developer ID app and DMG signed; bundled runtime, native WebRTC addon and helper signature checks passed; Apple accepted notarization, DMG ticket stapled and local Gatekeeper checks passed | Physical clean install/upgrade, offline Gatekeeper and helper lifecycle qualification; Intel compatibility remains unqualified |
| Linux distribution | Headless tmux path and archive tooling with disposable install/upgrade checks | Target distributions, real systemd-user/logout/boot, multi-user/shared-home and device checks |
| Public distribution | Internal CI delivered Android 1.0.0 (6) and iOS 1.0.0 (3), verified both store assignments and created the beta tag; exact crash diagnostics retained | Device qualification, public store submissions and explicitly authorized published packages/downloads |

Current mobile source enables secure-v2 WebRTC negotiation in normal connections.
Terminal subscriptions and input pause until the direct route commits, including
when a direct connection is lost. Temporary encrypted relay terminal fallback
requires explicit user choice; relay coordination and direct retries remain
active. The owner confirmed direct use and repeated Wi-Fi/cellular recovery on
Fold 7 and on iPad with TestFlight 1.0.0 (3). Background/sleep, production APNs
and broader store-delivered device and cross-network checks remain open.
See [direct transport](architecture/direct-transport.md).
Store exact artifact hashes, signing identity, build numbers, tool versions and
observations in the relevant release record. Keep account-specific details and
unredacted device evidence private. This page records current qualification scope,
not a deployment diary or permanent test transcript.

## Documentation and public repository

- [ ] Run final public-source and artifact-metadata audits; retain licenses, trademark policy and third-party credits.
- [ ] Review the prospective public Git history for private contact details and historical private provenance; current-file cleanup does not remove earlier commits.
- [ ] Confirm that the maintainer's private security-reporting contact is monitored; do not announce an unverified mailbox or GitHub reporting feature.
- [ ] Make the repository public only after explicit owner authorization.
- [x] Bring `shellbell.dev` online; confirm a public HTTPS response.
- [ ] Align the website's repository, download, store and contact links with the public release and owner preferences.
- [ ] Review initial component versions and apply Changesets on the release branch; follow [versioning and changelogs](versioning.md).
- [ ] Align public store version records with the intended signed candidates; complete listings, screenshots, privacy/data-safety declarations and distribution-country encryption requirements.
- [ ] Prepare release notes with qualified artifact results. Download instructions must name actual published artifacts.
- [ ] Have a new tester follow setup and pairing instructions; record confusing steps and correct the guides.

## Mobile and direct transport

- [ ] Prepare the shared Android/iOS 1.0.0 launch train from the reviewed Changesets plan; use fresh platform build numbers and testing channels for beta candidates. Existing 0.1.0 evidence below remains evidence for those earlier artifacts.

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
- [ ] Qualify cellular, restrictive networks, network changes, suspended/background apps and prolonged direct failure with usable encrypted relay fallback.
- [x] Register Apple app/extension identities and the shared notification group; verify App Store profiles and export a signed TestFlight candidate.
- [x] Correct the iOS native ICE locator conversion and verify TestFlight 1.0.0 (3) direct connection on the owner’s iPad over Wi-Fi and 5G, including handoff. Notification delivery remains a separate check.
- [x] Verify CI delivery, processing and internal-group assignment for Android 1.0.0 (6) and iOS TestFlight 1.0.0 (3); preserve their exact crash diagnostics. Candidate: [current release records](https://github.com/bilal-/shellbell/releases).
- [x] Confirm visible production APNs delivery on the owner's iPad with TestFlight 1.0.0 (4); rich content, tap routing, rotation and development builds remain separate checks.
- [ ] Qualify signed development/production iOS builds with physical APNs delivery, including the notification extension.
- [ ] Qualify the iOS native direct adapter and its network/device matrix before public activation.
- [ ] Complete an independent secure-v2/transport security review before public release.
- [ ] Qualify direct-only terminal pause, visible connection progress and explicit temporary relay fallback on store-delivered builds, including Wi-Fi/cellular handoff.
- [ ] Audit WebRTC native notices in Android/iOS artifacts and expose required texts in Open-source credits. Verify data-only permissions and App Store usage-string requirements.
- [ ] Run the [mobile QA checklist](../apps/mobile/QA.md), including terminal history, selection, accessibility, Unicode, input uncertainty and lifecycle.

- [x] Preserve bottom status rows in the live mobile viewport; check synthetic
  screens in both browser renderers and on S22 through keyboard show/hide,
  history browsing, redraw, Fit width and rotation. Real terminal tools, Fold 7
  and physical iOS remain part of the mobile QA matrix above.

## Computer releases

- [ ] Qualify desktop/headless conversion, consent, Quit, owner loss, login/reboot and recovery on signed Mac artifacts.
- [x] Align Linux downloads with `shellbell@X.Y.Z` and require explicit Mac candidate build numbers in packaging and verification.
- [ ] Qualify the Linux archive/checksum download path against actual published release assets.
- [ ] Reserve increasing Mac build numbers in the private release ledger and qualify them in signed distribution artifacts.
- [ ] Qualify Developer ID signing, notarization, Gatekeeper and privileged-helper installation/removal.
- [ ] Qualify Linux archives and tmux on target distributions, including systemd-user and logout/boot policy.
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

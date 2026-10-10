# Shellbell changelog

Computer, mobile and relay have independent release lines. Package changelogs
come from Changesets; this overview records shipped channels and their limits.
See [versioning and release rules](docs/versioning.md).

## Unreleased

### Build tools

- Update build-time SVG rendering to Sharp 0.35.5 and pin older toolchain
  dependencies to its fix for [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

## 2026-10-09 previews

### Mobile 1.1.0 — Android build 10 / iOS build 7

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.3.1)

- Restore vertical history swipes across the full viewport after zooming.
- Keep history positions through stream recovery and explain native history limits
  without offering ineffective retries. Stop requests at the retained boundary.
- Clarify direct typing and draft focus, improve control consistency and hide
  terminal toolbars while the software keyboard is open.
- Add iOS 27 scene support and refresh store screenshots and metadata.

Source CI and all 72 Chromium/WebKit terminal browser checks passed. CI verified
both internal store assignments, and exact crash diagnostics are retained
privately. Physical checks on the new store builds remain open, including the
Fold 7 zoom/swipe regression, keyboard behavior, notifications and network recovery.
Installation requires an internal-testing invitation.

### Computer 0.3.0 — Mac build 16, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.3.0-beta.16)

- Keep Herdr history aligned across trimmed and busy reads, and recover bounded
  terminal streams without losing acknowledgement state.
- Serialize input-triggered captures without counting read-only work as typing.
- Add owner-enabled terminal adapters and desktop launch choices, while retaining
  built-in session creation for older phones.
- Reject legacy pairing requests that cannot produce a usable pairing code.

The Apple silicon DMG is Developer ID signed, notarized and stapled. Exact
artifact integrity, privacy, Gatekeeper and anonymous download checks passed.
The macOS CLI archive passed isolated install/version/help/uninstall checks.
Linux ARM64 and x64 archives passed 20 isolated qualification runs across Ubuntu
22.04 and 24.04; x64 used emulation. Physical devices, broader Mac lifecycle and
native x64 boot remain separate qualification work. No Intel Mac app is included.

### Relay 0.0.4

[Release and deployment record](https://github.com/bilal-/shellbell/releases/tag/relay-v0.0.4)

- Deploy the current shared relay core and Cloudflare adapter with encrypted
  routing, pairing/revocation policy, atomic notification budgets and bounded
  queues. Keep direct FCM/APNs delivery and current protocol contracts.
- Preserve the hosted Durable Object namespace, migration history, configured
  variables and push credentials. Post-deployment health/version checks passed.
- Publish the matching standalone Node adapter as source. Container-registry
  publication and operator volume, TLS/proxy and backup/restore qualification
  remain separate.

## 2026-10-07 preview

### Mobile 1.1.0 — Android build 9 / iOS build 6

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.2.1)

- Use xterm.js for live input, loaded history, search, touch selection and
  styled copy. Support host-native paste and one-use Shift/Ctrl/Alt controls;
  hide the phone key bar when a physical keyboard is attached.
- Add optional Herdr mouse clicks with a compatible host and Herdr CLI/server
  0.9.3 or newer. Show terminal adapter names and available desktop launch choices.
- Preserve history positions, selected text and pending composed input through
  updates. Reject oversized input before sending partial text or Enter keys.
- Prevent scrolling from causing redundant terminal repaints. Send unpairing
  to the relay before closing the connection, including legacy pairings.

Mobile review finished clean after three rounds and two regression-tested fixes.
Source CI and both internal store assignments passed; exact crash diagnostics
are retained privately. Physical checks of these new builds remain open,
including keyboard attachment, touch selection, accessibility, notifications
and Wi-Fi/cellular recovery. Installation still requires a testing invitation.

### Computer 0.2.0 — Mac build 15

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.2.0-beta.15)

- Start every app launch with power controls off. Settings choices last for the
  current app session; Start at Login does not restore keep-awake protection.
- Recover interrupted closed-lid helper setup during an explicit enable action,
  after verifying sleep restoration and ownership. Report administrator approval,
  idle, display and closed-lid state separately, with actionable recovery errors.
- Recover desktop service ownership after an unexpected child exit and report
  another service using the endpoint accurately. Package the loader for explicitly
  enabled local terminal plugins.
- Retain native build-tool compatibility fixes used for signed app packaging.

The Apple silicon DMG is Developer ID signed, notarized and stapled. The owner
upgraded to this exact build with identities and pairings preserved and confirmed
closed-lid operation. Source CI, bundle integrity, metadata and anonymous download
checks passed. Broader battery/sleep-wake, administrator lifecycle, clean-machine,
offline Gatekeeper and minimum-OS checks remain open. Intel is not included.
Closed-lid protection requires a power adapter; battery keep-awake is for an open
lid. See the [live checklist](docs/before-first-release.md).

## 2026-10-05 previews

### Computer 0.1.1 — macOS headless service

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.1-beta.11)

- Fix legacy macOS headless service start/restart without a service-instance UUID
  while preserving desktop ownership checks and foreground startup serialization.
- Correct the packaged README's Linux operator-guide link.
- Publish the npm-format CLI archive, source manifest and checksums. Exact-archive
  isolated installation, CLI version/help, license/metadata audits and source CI
  passed. Apple silicon with Node 22.23.1 is verified; real headless OS-service
  login/logout/reboot, Intel and Linux qualification remain separate.
- Preserve existing identities, pairings and wire compatibility. The public Mac
  app remains computer 0.1.0 build 5; this release includes no new app installer.

### Computer 0.1.0 — Mac build 5

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.0-beta.5)

- Publish a signed, notarized Apple silicon Mac installer and a macOS headless CLI
  tarball from reviewed public source, with source metadata and SHA-256 checksums.
- Mirror iTerm2, tmux and Herdr sessions; offer installed backend startup from an
  empty workspace. Include the Herdr live-stream observer correction.
- Negotiate authenticated WebRTC, retain encrypted relay coordination and
  bounded retries, and avoid automatically replaying uncertain input.
- Keep desktop-owned and headless service lifecycles separate. Reserve native Mac
  build numbers and derive marketing versions from the bundled service.
- Signature, notarization, Gatekeeper, bundle integrity, metadata and disposable
  CLI installation checks passed. Physical install/lifecycle and the full
  device/network matrix remain separate. Intel installers and qualified Linux
  archives are not included; Linux's tmux source workflow remains available.

### Mobile 1.0.0 — Android build 8 / iOS build 5

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.0.0-beta.1.1)

- Deliver both native apps through request-triggered CI, verify Google Play and
  TestFlight internal assignment, then automatically tag the tested source and
  attach a public release manifest. Resume partial tagging failures safely.
- Use direct WebRTC in normal connections. Show the committed route, pause the
  terminal during recovery, retry on Wi-Fi/cellular changes and offer explicit
  temporary encrypted relay fallback. Include the iOS ICE locator correction.
- Use native FCM/APNs tokens and encrypted private notification context. Retain
  the notification extension and verified internal-store upload configuration.
- Keep the keyboard open while using quick keys, preserve bottom terminal rows,
  account for system navigation, and retain unsent drafts while disconnected.
- Add a Settings gear, subtle branding and installed version details. Explain
  automatic scaling and disabled font controls; retain wrapped Reading mode,
  optional WebGL with DOM fallback, native link opening and per-computer relay
  settings. Remove donation links.
- Enable Android R8 optimization, obfuscation and unused-resource shrinking.
  Preserve exact mappings, JavaScript maps and native symbols privately.
- Earlier iPad builds were confirmed for direct Wi-Fi/5G handoff, Herdr streaming
  and visible notifications. Qualification of these exact new artifacts remains
  separate from store acceptance. Installation requires a testing invitation.

The repository is public. Ordinary source pushes run CI; internal mobile delivery
requires an explicit release request. Major upgrades require owner discussion
and approval. These previews represent no stable release, npm publication or
public store promotion. See the [release checklist](docs/before-first-release.md)
for remaining qualification.

# Shellbell changelog

Computer, mobile and relay have independent release lines. Package changelogs
come from Changesets; this overview records shipped channels and their limits.
See [versioning and release rules](docs/versioning.md).

## Unreleased

### Relay

- Run authentication, pairing, revocation, notification policy and bounded queues
  through Cloudflare adapters or one Node process with private SQLite storage.
- Replace Expo push delivery with direct FCM and APNs providers.
- Preserve ciphertext routing, atomic notification budgets and claims through
  connection, admission, storage and Node lifecycle refactors.
- Document Cloudflare and Docker deployment, TLS, backup/restore, organization
  operations and other runtime adapters. These source changes have no new
  separately published relay release in this preview.

## 2026-10-07 preview

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

# Shellbell changelog

Computer, mobile and relay have independent release lines. Package changelogs
come from Changesets; this overview records shipped channels and their limits.
See [versioning and release rules](docs/versioning.md).

## Unreleased

### Computer

- Keep explicit helper maintenance recovery available whenever no closed-lid
  lease is verified, including on battery or during ordinary keep-awake;
  checking availability does not change sleep.

- Report verified idle and closed-lid power controls separately, wait for
  restoration on disable, and handle rapid enable/disable changes without
  claiming a released lease is active. Recognize normal unset macOS sleep
  overrides, distinguish pending approval from failure, and use generic
  sleep-manager conflict messages.

- Allow first-time closed-lid helper setup and Start at Login when macOS has not
  registered the service before. Validate the signed app before registration,
  distinguish pending administrator approval from failure, and show setup errors
  without incorrectly blaming the app's signature.

### Release tooling

- Apply narrow native build-tool dependency fixes while retaining the CommonJS
  interface used by Xcode project generation. Document remaining upstream
  build-tool advisories in [Contributing](CONTRIBUTING.md).

### Relay

- Run authentication, pairing, revocation, notification policy and bounded queues
  through Cloudflare adapters or one Node process with private SQLite storage.
- Replace Expo push delivery with direct FCM and APNs providers.
- Preserve ciphertext routing, atomic notification budgets and claims through
  connection, admission, storage and Node lifecycle refactors.
- Document Cloudflare and Docker deployment, TLS, backup/restore, organization
  operations and other runtime adapters. These source changes have no new
  separately published relay release in this preview.

## 2026-10-05 previews

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

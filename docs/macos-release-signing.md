# Signing and distributing Shellbell for macOS

Development app/DMG packaging and signed-candidate tooling are implemented. An
ARM64 Developer ID candidate has passed runtime and native-addon checks, Apple
notarization, DMG stapling and Gatekeeper assessment on the release Mac.
Clean-machine installation, upgrade, offline Gatekeeper and helper lifecycle
qualification remain open in [the release checklist](before-first-release.md).
A certificate alone does not establish a release-ready pipeline. Follow this guide
using your own authorized publisher account; no maintainer account access is assumed.

## Publisher prerequisites

- [ ] An active publisher Apple Developer Program membership and access to its team.
- [ ] A **Developer ID Application** signing identity, including its matching
  private key, on the release Mac. An iOS distribution certificate is not a
  substitute. Confirm the team's legal name and Team ID in Apple's account;
  account; configure the verified Team ID privately in the release environment.
- [ ] Xcode command-line tooling supporting `codesign`, `notarytool` and `stapler`.
- [ ] Authorized notarization credentials stored securely in a Keychain profile
  or equivalent protected release environment. Keep private keys, exported `.p12`
  files, API keys and passwords out of Git, command logs and chat.
- [ ] Clean test Macs covering the advertised architectures and minimum OS.

A Developer ID Installer certificate is needed if we later distribute a flat
PKG; it is not required merely to distribute the app in a DMG. Follow
[Apple's certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
Do not create duplicate identities or revoke existing certificates casually.

## Tooling and qualification gates

Candidate tooling validates inputs and reports candidate evidence; it does not
perform notarization, install the app or publish it.

- [x] Implement copy-only, inside-out candidate signing with explicit certificate
  fingerprint and externally expected Team ID; keep development verification strict.
- [x] Define the versioned signed payload manifest with exact exclusions. Write
  it before outer signing; retain final all-file hashes in a detached report.
- [x] Implement Developer ID/team/code-ID requirements, exact entitlement checks
  and isolated runtime smoke before reporting candidate success. Test doubles
  demonstrate policy/order, not actual signed-runtime qualification.
- [x] Complete independent final candidate-tooling review and verify its timeout correction.
- [ ] Qualify Node's minimal entitlement policy and the native app on real signed
  arm64/x64 builds. Do not preserve upstream Node's broad entitlements or add
  exceptions just to pass a failing smoke check.
- [x] Implement signed DMG packaging and explicit post-notarization verification
  with accurate manual-copy/removal text. Development `native:verify`/`native:dmg`
  still reject signed candidates. Real publisher and platform qualification remain separate.
- [x] Execute authorized notarization, staple the DMG and verify its ticket and
  Gatekeeper assessment on the release Mac.
- [ ] Complete clean-machine installation/upgrade, offline Gatekeeper and physical
  helper lifecycle QA.

The private runtime is `Contents/Helpers/node`; its LICENSE stays under Resources.
The approved keep-awake feature also adds
`Contents/Library/HelperTools/ShellbellPowerHelper` and its bundled LaunchDaemon
plist. Candidate signing explicitly signs/verifies this helper under identifier
`sh.bilal.shellbell.power`, with the app's validated Team ID and empty
entitlements (no Node JIT entitlement). Signed inventory format is now
`shellbell-signed-candidate-v3`; the helper remains in the hashed payload.
Do not reuse older candidate records or omit helper verification.

The native WebRTC addon is admitted at the exact path for the candidate's
architecture. Both its wrapper and platform package must match the pinned
`node-datachannel` dependency. The signer signs the addon before the containing
app, using `sh.bilal.shellbell.host.runtime.node-datachannel`, the same publisher
Team ID and empty entitlements. Verification rejects extra native code, an
unexpected architecture, a different publisher or addon entitlements. The static import check retains the exact upstream loader and package checks;
after verifying the addon signature, it checks the signed binary against the
admitted candidate payload digest. Development bundles still require the pinned
upstream binary digest. Verification also
loads the signed addon in an isolated runtime and checks cleanup. This smoke
check does not establish a working connection between real devices.

This source change is not signed runtime qualification. Before release, execute
the [power-helper qualification checklist](macos-power-helper-qualification.md),
including authenticated IPC, SMAppService approval/removal, interrupted
maintenance, physical power/lid transitions, and moved-app/update cases.
Use the [managed removal procedure](../apps/macos/README.md#keep-awake-helper-source-implementation-not-release-qualified)
before replacing a configured app. Ordinary manual copying is not a transactional
helper updater.
App/service identifiers and existing user identities remain unchanged.
The [packaging trust model](architecture/native-controller.md#packaging-trust)
defines the trust boundaries. [Commands and limits](../apps/macos/README.md#signed-candidates-and-release-qualification)
document future authorized use; there is no automatic certificate discovery,
notary submission, installation or publication.

## Authorized release sequence

Notarize and staple the outermost DMG, leaving the enclosed app byte-for-byte
unchanged. This follows [Apple packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
and preserves the strict candidate inventory.

1. Build from a clean identified commit into new staging; retain provenance.
2. Use `native:sign-candidate` with the independently confirmed publisher Developer
   ID Application certificate fingerprint and Team ID. Qualify its isolated
   runtime smoke on the target architecture. Do not broaden entitlements merely
   to make it pass; do not use `--deep` signing.
3. Build a separate signed image with the reviewed builder:

   ```sh
   pnpm native:build-signed-dmg --app /absolute/candidate/Shellbell.app --output /absolute/unused-release-directory --identity-sha1 EXPLICIT_CERTIFICATE_SHA1 --team-id EXPECTED_TEAM_ID
   ```

   It verifies source, copy and the app actually mounted from the generated image.
   It writes `signed-dmg-report.json` only after successful detach/source checks.
   This is still a candidate, not a notarized public installer.
4. Submit that DMG using an already-authorized protected Keychain profile.
   These are operator instructions, not commands agents may run without authority:

   ```sh
   xcrun notarytool submit /absolute/release/Shellbell.dmg --keychain-profile SHELLBELL_NOTARY_PROFILE --wait --output-format json
   xcrun notarytool log SUBMISSION_ID --keychain-profile SHELLBELL_NOTARY_PROFILE /absolute/unused-notary-log.json
   ```

   Retain the submission ID and inspect the log even after an Accepted result.
   Stop on Invalid/error; do not treat successful upload as accepted notarization.
   Never put passwords/private keys in command arguments, Git, logs or chat.
5. After Accepted, staple the outer DMG, not the app, and verify the final bytes:

   ```sh
   xcrun stapler staple /absolute/release/Shellbell.dmg
   pnpm native:verify-signed-dmg --image /absolute/release/Shellbell.dmg --team-id EXPECTED_TEAM_ID --stage notarized --report /absolute/unused-notarized-report.json
   ```

   Stapling changes image bytes: the candidate-stage hash is not the final download
   hash. Use the new detached report's SHA-256. Do not re-sign, rebuild or edit
   after this step without repeating the affected signing/notary/verification work.
6. Perform the clean-machine tests below before requesting publication approval.
   A notarized-stage report records local checks and still says
   `releaseReady: false`; it is not lifecycle/offline distribution qualification.

No tool discovers accounts, submits notarization, removes quarantine, installs,
starts a service or publishes automatically. Per-command tooling deadlines are
60 seconds maximum; slow verification fails closed. Manual notarytool waiting is
not subject to that wrapper. Failed detach leaves an owned mount path/scratch
for manual inspection; do not delete scratch or force-detach a busy volume.
See [Apple's workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

## Before offering a public download

- [ ] Download the final artifact through a browser on a clean Mac; test ordinary
  Gatekeeper behavior and offline ticket validation without removing quarantine.
- [ ] Verify first launch and background-service approval identify the intended
  publisher. In desktop mode, verify closing Settings leaves remote access running,
  while Quit Shellbell stops the app-owned service and releases its power leases.
  Separately qualify explicitly selected headless mode: quitting the controller
  must leave that independent per-user service running. Preserve host identity and
  pairings through the supported mode handoff.
- [ ] Exercise service start/stop, logout/reboot, upgrade, relocation and uninstall.
  Confirm existing host identity and phone pairing survive supported upgrades.
- [ ] Repeat on real Intel and Apple Silicon hardware where advertised, including
  the minimum supported macOS. An emulated CLI smoke test is not this qualification.
- [ ] Record results in the release checklist and get explicit publication approval.

Signing does not guarantee zero prompts: normal first-open and background-service
consent still need testing. Never instruct users to disable Gatekeeper as the
installation solution. No npm publication or release PR merge follows from signing.

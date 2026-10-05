# Mobile internal delivery

An explicit release request starts Shellbell's Android and iOS internal delivery
workflow. It requires a passing `ci` run for the exact revision on `main`, then
builds, signs, uploads and verifies both store assignments. Android goes to Google
Play internal testing; iOS goes to an existing TestFlight internal group. Ordinary
pushes run source CI without starting mobile builds. Public store publication
remains a separate release decision.

The workflow is [mobile-internal.yml](../.github/workflows/mobile-internal.yml).
It is disabled unless the repository variable `SHELLBELL_ENABLE_MOBILE_RELEASE`
is exactly `true`. Forks, pull requests, other branches and failed source CI cannot
release. Start it with `workflow_dispatch` from `main` only when a release is
requested; successful source CI alone does not start it.

## Set up your accounts

Complete the [native signing and internal-testing setup](local-mobile-releases.md)
first. Google Play needs an existing application and an initial bundle upload;
its service account needs Play Console permissions. Apple needs an existing
application, internal tester group, Apple Distribution identity and App Store
profiles for both the host and notification extension. The upload API key and
APNs provider key have different purposes.

Create a GitHub environment named `mobile-internal` with a deployment branch
rule allowing only `main`. Keep signing and upload secrets in that environment.
The workflow uses disposable GitHub-hosted runners and refuses to materialize
credentials on persistent self-hosted runners.

| Environment secret | Value |
| --- | --- |
| `SHELLBELL_ANDROID_KEYSTORE_BASE64` | Base64-encoded Android upload keystore |
| `SHELLBELL_ANDROID_SIGNING_JSON` | JSON with `key_alias`, `store_password` and `key_password` |
| `SHELLBELL_PLAY_CREDENTIALS_JSON` | Google Play uploader service-account JSON |
| `SHELLBELL_GOOGLE_SERVICES_JSON` | Firebase client JSON registering `sh.bilal.shellbell` |
| `SHELLBELL_IOS_CERTIFICATE_BASE64` | Base64-encoded Apple Distribution P12, including its private key |
| `SHELLBELL_IOS_CERTIFICATE_PASSWORD` | Password for that P12 |
| `SHELLBELL_IOS_PROFILE_BASE64` | Base64-encoded host App Store provisioning profile |
| `SHELLBELL_IOS_NOTIFICATION_PROFILE_BASE64` | Base64-encoded notification-extension App Store profile |
| `SHELLBELL_ASC_API_KEY_JSON` | Fastlane API-key JSON: `key_id`, `issuer_id`, PEM `key`, `in_house: false` |

| Environment variable | Value |
| --- | --- |
| `SHELLBELL_APPLE_TEAM_ID` | Your actual Apple signing team |
| `SHELLBELL_IOS_PROFILE` | Exact host provisioning profile name |
| `SHELLBELL_IOS_NOTIFICATION_PROFILE` | Exact notification-extension profile name |
| `SHELLBELL_ASC_APP_ID` | Numeric App Store Connect app ID |
| `SHELLBELL_TESTFLIGHT_GROUP` | Exact existing internal tester group name |
| `SHELLBELL_IOS_USES_NON_EXEMPT_ENCRYPTION` | Reviewed encryption classification for the intended distribution |

Use your own account identifiers and encryption classification. Keep original
credentials, their scope, profile expiry dates and recovery instructions in a
restricted backup; GitHub cannot export secret values later. Set secrets through
protected stdin or GitHub settings, without putting private values in command
arguments, workflow YAML or build logs.

After configuring the environment, enable the repository's mobile release flag.
The npm and relay workflows have separate flags and remain independent.

## Source, build numbers and tags

Android and iOS share the numeric marketing version in
`apps/mobile/package.json`. Each platform has its own increasing native build
counter. CI checks the owner-approved major ceilings before building.

Each request selects the exact source revision, even when its mobile code matches
the previous candidate. The workflow logs changes since the last delivered mobile
beta tag. If newer mobile or release-tooling changes have reached `main`, it skips
the superseded revision so the next request can use the newer passing source.

Source CI runs portable checks on Linux and reserves macOS for agent, Swift and
Mac package checks. Superseded source CI runs are cancelled. Store deliveries are
serialized and continue to completion once started.

The workflow serializes internal deliveries. Android chooses a number above
all bundles, APKs and track releases returned by Google Play; iOS chooses one
above all app builds returned by Apple, including processing and expired builds.
Do not run another uploader concurrently. Local release builds still require an
explicitly coordinated `SHELLBELL_BUILD_NUMBER`.

Each lane checks the artifact's marketing/build versions and verifies its
assignment to the intended internal track or group. Only after both succeed
does CI create an immutable prerelease tag:

```text
mobile-v1.0.0-beta.<workflow-run-number>.<attempt>
```

The tag points to the exact source revision that passed CI. Release notes record
both platform build numbers and artifact hashes. The run number identifies the
candidate; native build numbers come from store history. Stable
`mobile-vX.Y.Z` tags remain a separate decision after qualification.

## Failures and diagnostics

The Android job clears unused preinstalled toolchains from its disposable runner
and checks for at least 24 GiB free before installing dependencies. Native builds
for all four Android architectures need more working space than the final AAB.
An insufficient-space check fails before signing inputs are prepared.

Apple processing can take time. The iOS lane waits for a valid, test-ready build
and verifies group assignment. Android verifies the internal track after
committing its upload.

If one platform fails, the other platform's accepted upload remains in its
store. There is no cross-store rollback. Rerun after fixing the cause; lanes
query fresh store history, and accepted build numbers are never reused. A
failure before store acceptance can retry the next unused store number. Each
attempt has its own artifact hashes, receipts and candidate suffix.

CI retains Android AABs, R8 mappings and JavaScript source maps, plus iOS IPAs,
dSYMs, available source maps and verified store receipts, for 30 days. Preserve
the exact diagnostics and receipts in the private release record before that
retention expires. Signing inputs live in temporary private files; the iOS job
uses a temporary keychain, verifies profiles and removes its credentials and
installed profiles on completion.

Store acceptance does not qualify physical push delivery, WebRTC handover,
terminal behavior or accessibility. Record checks against the delivered build
in the [release checklist](before-first-release.md). For local builds and
deliberate manual uploads, use [local mobile releases](local-mobile-releases.md).

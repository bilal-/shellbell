# Versions and releases

Shellbell has three release lines: computer, mobile and relay. Each can ship
without forcing the others to update. Compatibility comes from negotiated wire
profiles and tested combinations, not equal application version numbers.

## Version owners

| Release line | Version source | Included artifacts | Release tag |
| --- | --- | --- | --- |
| Computer | `apps/agent/package.json` | npm headless CLI, macOS app, Linux archives | `shellbell@X.Y.Z` |
| Mobile | `apps/mobile/package.json` | Android and iOS apps, including the iOS notification extension | `mobile-vX.Y.Z` |
| Relay | `packages/relay-core/package.json` | Shared core, Cloudflare Worker and standalone Node relay | `relay-vX.Y.Z` |

The Mac controller and headless service share one computer version because they
ship the same service. A native Mac UI or packaging change belongs in a computer
Changeset even if the headless CLI is unaffected. Linux archives use that same
version. A separate controller version would add coordination without describing
a separately supported product.

Android and iOS share a mobile marketing version. They have separate build
counters and may ship on different dates. An Android-only hotfix advances the
mobile version; the release notes say that iOS remains on its previous version
until an iOS artifact ships. Do not create an unrelated version line for each OS.

Changesets keeps the relay core and both adapters at the same version. Operators
can choose an adapter without changing the release contract. The protocol
library has its own internal package version in `packages/protocol/package.json`;
it is private and has no public SDK release. Its package version is not a wire
protocol version.

## Meaning of a version

Use numeric `MAJOR.MINOR.PATCH` versions:

| Change | Before 1.0 | From 1.0 onward |
| --- | --- | --- |
| Compatible correction, security fix or packaging fix | Patch | Patch |
| Compatible feature | Minor | Minor |
| Incompatible supported behavior or contract | Minor, with migration notes | Major after owner approval, with migration notes |

The supported contract includes CLI commands and flags, configuration, terminal
backend behavior, service lifecycle, documented relay interfaces, and pairing and
upgrade behavior. Internal refactors do not become breaking releases merely
because implementation details changed. A security fix that must break a
supported contract uses the incompatible-change rule and explains the reason.

The accepted mobile launch train is `1.1.0` on both Android and iOS. Keep this
marketing version through pre-launch feature work and fixes; distinguish
TestFlight and Play testing candidates with fresh platform build numbers.
Changing the pre-launch marketing version requires an explicit owner decision.
The channel identifies beta candidates; the number does not claim that
[launch checks](before-first-release.md) passed. Qualify the mobile launch
contract before promoting a candidate to stable.

Using a mobile 1.x version is a product decision, not an Apple minimum version
requirement. Apple's required marketing format is three numeric components; the
existing `0.1.0` TestFlight candidate was accepted. Apple directs beta distribution
through [TestFlight, not the public App Store](https://developer.apple.com/app-store/review/guidelines/#beta-testing).

Computer and relay releases remain independent. They can use `0.x` while their
contracts are still being established and reach 1.0 on their own schedule. A
mobile 1.0 release does not require equal computer, relay or wire versions.

This is Shellbell's explicit policy for the initial-development phase of
[SemVer](https://semver.org/spec/v2.0.0.html). Before 1.0, minor updates may require
an upgrade or re-pairing; patch updates preserve the documented contract. Release
notes must identify exceptions and required actions before distribution.

## Major upgrade approval

Expect a long-lived 1.x series. Compatible features, corrections and internal
refactors stay within it. A substantial rewrite or redesign is the expected point
to discuss a future 2.x release; a rewrite that preserves the supported contract
can still stay on 1.x.

Every new major requires discussion and explicit owner approval before adding a
major Changeset, changing source versions or raising an approved major ceiling.
Discuss the reason, supported behavior that would change, upgrade and pairing
impact, and recovery plan. A feature count, dependency update or automated release
plan cannot authorize a major upgrade. If a change would break a supported
contract, preserve compatibility or bring the proposed major to the owner; do
not ship the break as a patch or minor to avoid this decision.

[release-policy.json](../release-policy.json) records the approved major ceilings.
Mobile's first major is approved for launch; mobile 2.x requires a new decision.
Computer, relay and protocol-library 1.0 milestones also require owner approval.
Editing this record requires that approval and is separate from authorization to
publish or deploy.

`pnpm check:versions` checks both source versions and the computed Changesets
release plan against this record, including dependency-driven bumps.
`pnpm version:packages` runs the guard before modifying versions and again after
preparation. CI uses the same check. The record documents an owner decision;
agents must not raise its values to make a rejected plan pass.

## Channels and candidates

A version describes a release's behavior. A channel describes who receives it:
local development, Play internal testing, TestFlight, public preview or stable.
Use three numeric components for native marketing versions. Do not put
`-beta`, `-rc` or a Git SHA into those versions. The local Android
`-local-test` suffix is a development variant, never a store artifact.

Computer previews use `computer-vX.Y.Z-beta.<reserved-mac-build>` and remain separate from stable `shellbell@X.Y.Z` tags and npm publication. Validate them with `pnpm check:versions --computer-candidate-tag computer-vX.Y.Z-beta.N`. A preview may carry only the qualified architectures; its release notes must name those limits.

A candidate is not a stable release. While a mobile release is in testing, fixes
can produce another candidate with the same marketing version and a fresh build
number, including during public TestFlight or Play testing. Identify the channel,
build and source commit in each candidate's notes; explain any compatibility
change before testers upgrade. Once promoted to stable, a behavior change needs
a new version under the bump rules above. For computer and relay releases, an
already published version is immutable. Never replace a tag or overwrite an
artifact already distributed.

For the current mobile launch train, candidates use `1.1.0` with increasing
Android and iOS build numbers. A qualified candidate can become the first stable
`1.1.0` release. After that release, the next compatible correction is `1.1.1`,
the next compatible feature is `1.2.0`, and a later owner-approved incompatible
contract uses a new major. Do not consume a patch or minor version merely to
distinguish beta candidates for the same launch. Preserve the version and build
identity of artifacts already distributed.

Promote the tested store build to a wider track or audience when possible.
Promotion does not rebuild the application or allocate another build number.
A newly produced binary always gets a new candidate number, even from the same
source commit. Retrying an upload of the exact same bytes keeps its number; an
already accepted upload is not uploaded again.

A source tag identifies one immutable component release commit. It does not
assert that every platform artifact is available or qualified. For mobile,
create `mobile-vX.Y.Z` from the commit selected for stable promotion. Earlier
candidate commits and hashes remain in their release records; do not move the
stable tag between beta builds. Release notes list the platforms and channels
that actually shipped. Mobile platform availability must not be inferred from
the existence of `mobile-vX.Y.Z`.

## Build numbers and source identity

| Identifier | Source or purpose | Rule |
| --- | --- | --- |
| Mobile version | Android `versionName`, Apple `CFBundleShortVersionString` | Mobile package version; static `app.json` must agree |
| Android candidate number | `versionCode` | Positive integer, at most 2,100,000,000; increase across versions and all tracks |
| iOS candidate number | Host and extension `CFBundleVersion` | Same positive integer in both; increase across marketing versions |
| Mac candidate number | `CFBundleVersion` | Explicit positive integer; increase across computer versions |
| Computer version | Bundled CLI and Mac marketing version | Computer package version |
| Source commit and artifact SHA-256 | Exact code and exact bytes | Record both for each artifact; a branch name is insufficient |
| Relay deployment identity | Provider deployment ID or container image digest | Record with relay version and source commit; this is not SemVer |

Shellbell's native build tools cap candidate numbers at 2,100,000,000 for a common
integer format. That is Google Play's limit, not a claimed Apple limit. Apple
allows numeric build strings; Shellbell chooses a single increasing integer.
See [Android versioning](https://developer.android.com/studio/publish/versioning),
[Apple build numbers](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)
and [Apple marketing versions](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring).

Keep three counters: Android, iOS and Mac. Do not derive them from Git commit
counts, marketing versions, CI run numbers or the current date. For the same Mac
candidate, arm64 and x64 share the number and source commit; their artifact hashes
differ. A rebuild of either architecture requires a new candidate.

For local releases, keep a private ledger outside Git and back it up with the
release credentials. Check every store track and the ledger before choosing
a number above all reserved or uploaded candidates. Record the source commit,
marketing version, number, channel, artifact hash and signing identity.
Serialize reservations across laptops; a synced backup folder is not a lock.
Burn abandoned local reservations and retain the exact symbols and source maps.

The [internal mobile workflow](mobile-ci-releases.md) serializes CI deliveries
and queries provider history immediately before each platform build. Android
includes all bundles, APKs and tracks; iOS includes all builds, including expired
and processing candidates. Accepted store numbers are never reused. A failure
before acceptance can retry the next unused provider number; artifact hashes
and workflow attempts distinguish those builds.

Once CI delivery is enabled, use it for routine internal uploads. Coordinate
manual builds and uploads while CI is idle; neither the repository lock nor a
store read can serialize an independent uploader. Local lanes still require
`SHELLBELL_BUILD_NUMBER`. CI receipts record the exact source, marketing version,
native number, artifact hash and verified store assignment. Preserve them with
the matching crash diagnostics. Stable release qualification remains separate.

Mac packaging requires `--build-number`. It derives the marketing version from
the bundled computer package, writes both values into the plist, and records the
number in the development inventory. Verification checks the plist against that
inventory before running the runtime. The source plist contains development
defaults; it is not the version authority. Earlier development inventories lack
this field and require a fresh candidate for verification with the current tools.
See [Mac packaging](../apps/macos/README.md#build-from-committed-source).

Local mobile deliveries use `mobile-vX.Y.Z-beta.local.ANDROID.IOS`, with the
two native build numbers from verified store receipts. CI candidates keep their
workflow run and attempt counters. Both forms point to the exact artifact source
commit and include hashes in `mobile-release.json`. A local delivery must pass
source CI and confirm both internal store assignments before its tag is published.

## Compatibility and rollback

Keep these identities separate from application SemVer:

- The relay outer envelope and the paired application session have explicit wire
  versions. Normal mobile connections negotiate secure v2 and native WebRTC over
  the encrypted relay. After a v2 upgrade, both endpoints retain a minimum v2
  floor; disabling direct transport cannot undo that floor.
- Local control negotiates its own protocol and data model versions.
- Node relay SQLite schemas and Cloudflare migration tags have their own
  versions. A relay release number is not a database schema version.
- Push capabilities and enrollment generations determine which notification
  payloads a device can receive.

Every release declares its supported computer/mobile/relay combinations, wire
profiles, OS and runtime minimums, migrations and re-pairing requirements. Include
the tested previous publicly distributed client combination before claiming
backward compatibility. Store users and self-hosted operators update at different
times. Do not silently require equal app versions or promise an untested N-1
support window.

During public preview, support the combinations named in the release notes.
Before the first stable mobile release, qualify a compatibility window with prior
distributed clients. A deprecation needs a documented upgrade path and replacement support
before removal. Required upgrades must come from unsupported negotiated
contracts or security requirements, not a marketing-version comparison.

For compatible changes that need relay support, deploy the accepting relay
first, then computer software, then mobile. A client-only fix needs no relay
deployment. Self-hosted operators receive minimum relay requirements and upgrade
instructions before clients activate a feature their relay cannot carry.

For incompatible changes, stage acceptance of both profiles where possible,
upgrade endpoints, and remove old support only after the announced transition.
The release notes define the upgrade order and failure state. Authentication,
encryption, revocation and persisted pairing floors must never be weakened to
make an old release reconnect.

Document a rollback plan before rollout. Restoring old code cannot undo a pairing
floor or destructive migration. A store recovery release uses a fresh, higher
build number; it cannot reinstall an older Android versionCode. Back up relay
storage before migrations and qualify restoration separately. Mac updates remain
manual installation until a signed updater and its rollback behavior are
implemented and qualified.

## Changesets and changelogs

Every change to released behavior includes a Changeset naming the affected
release lines and bump. Include the computer package for bundled Mac changes,
mobile for either OS, and the relay group for adapter or core changes. A protocol
library change also names consumers whose behavior changes. Documentation alone
does not need a bump unless it corrects a published contract or release tooling.

The mobile `1.1.0` launch train is already prepared. Record pre-launch features
and fixes in that train's notes instead of queuing another mobile version bump.
After the first stable release, subsequent release trains resume the normal
Changesets bump rules. If another component needs version preparation meanwhile,
review the entire plan, including dependency bumps, and keep mobile at `1.1.0`.
Passing the major-version guard alone does not establish that a pre-launch minor
or patch bump is appropriate.

From the root:

```sh
pnpm exec changeset
pnpm exec changeset status
pnpm check:versions
pnpm check:release-tooling
```

Pending Changesets describe future versions. Running `pnpm version:packages`
prepares **all pending entries**, including private packages; it does not publish
them. Review that entire plan before consuming it. Independent shipping does not
mean this command selects one component. Prepared private packages remain
unshipped until their artifacts are distributed.

Changesets generates package changelogs during version preparation. The root
[CHANGELOG](../CHANGELOG.md) is a human edited overview of public releases by
release line. Internal candidates stay in the private ledger and the
[qualification record](before-first-release.md#qualification-status); their
pending public summary can remain in `Unreleased`. Each public release entry
includes version, date, channel, available platforms, user or
operator changes, upgrade steps, compatibility and known qualification limits.
Use the [release note template](release-notes-template.md). Move only shipped
items out of `Unreleased`; a version PR or tag alone is insufficient.

Private workspace packages are versioned but neither published to npm nor tagged
by Changesets. The computer CLI is the public npm package. See
[Changesets configuration](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md).
Library changes that do not alter consumer behavior need no invented consumer
feature note.

## Release preparation

1. Review the Changesets plan and the supported platform and compatibility matrix.
   Discuss any proposed major and obtain explicit owner approval before changing
   its Changeset, source version or approval record.
2. In a reviewable branch, run `pnpm version:packages`, then
   `pnpm install --lockfile-only`. Inspect package, lockfile and generated
   changelog diffs. Update the root overview and run the version and release
   tooling checks.
3. Run CI and the [release checklist](before-first-release.md). Build from the
   reviewed commit using reserved native candidate numbers.
4. Verify signatures, licenses, artifact privacy, matching native identities,
   installation, pairing, push, direct transport and recovery on the intended
   platforms. Record hashes and qualification results in the ledger.
5. Obtain explicit release authorization. Validate the selected tag against that
   checkout before creating it:

   ```sh
   pnpm check:versions --computer-tag 'shellbell@X.Y.Z'
   pnpm check:versions --mobile-tag mobile-vX.Y.Z
   pnpm check:versions --relay-tag relay-vX.Y.Z
   ```

   Substitute the component's prepared version. Publish or deploy only the
   approved artifacts. Linux downloads use the URL-encoded computer tag
   `shellbell%40X.Y.Z`; public archive and checksum retrieval still needs
   qualification against actual release assets.
6. Record what actually shipped and update its changelog entry. Platform build
   numbers and deployment identifiers remain attached to that release.

Release jobs stay disabled until their dedicated repository flags are enabled
deliberately. The npm job can publish the computer package; the relay tag job can
deploy the project's hosted Worker. Flags or matching tags are not authorization
to deploy someone else's infrastructure. Mobile upload lanes are explicit
internal operations; the repository has no automatic public store release.

Publishing source, publishing npm, deploying a relay and submitting mobile apps
are separate decisions. None is implied by this version policy.

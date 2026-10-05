# Native macOS controller

Shellbell is a Swift menu-bar controller for the existing TypeScript service.
Desktop mode owns service lifetime; explicitly selected headless mode belongs to
the OS user manager. Source builds produce a local development app and DMG. The separately signed
and notarized Apple silicon preview is available through
[shellbell.dev](https://shellbell.dev/download/#computer); check its exact source,
build number and qualification limits in the release notes.

## Build from committed source

### Keep-awake helper (source implementation; not release-qualified)

The app includes `Contents/Library/HelperTools/ShellbellPowerHelper` and
`Contents/Library/LaunchDaemons/sh.bilal.shellbell.power.plist`.
Bundle verification checks the helper architecture and exact daemon arguments,
label, root identity, and Mach service. Signed candidates additionally require
the same validated Developer ID publisher for the app and helper; the helper
does not receive Node's JIT entitlement. Signed inventory v2 hashes its bytes.

General Settings offers ordinary AC-only keep-awake, display sleep, and optional
closed-lid access. Ordinary assertions require no root installation. Closed-lid
access requires explicit administrator setup and a qualified signed build.
Neither headless installation nor background status polling registers the helper.

Disabling **Allow system sleep when lid closed** starts the consent/setup flow.
Pending setup offers an inline action; pending macOS approval opens Login Items
& Extensions. The checkbox records your request, while the status describes
verified idle and closed-lid protection separately. Turning the option back on
shows restoration in progress until the helper verifies its override is off.
The inactive helper remains installed. Other sleep-management apps and macOS
may still prevent sleep after Shellbell releases its own controls.
Advanced contains helper removal and recovery for interrupted maintenance.

Before replacing, relocating, or removing an app with closed-lid setup:

1. Use **Remove Helper…** in Advanced Settings. It appears only when the helper
   is registered (including pending approval). Shellbell saves normal
   lid sleep, releases its active power controls, obtains a verified durable
   maintenance hold, unregisters the helper, and checks macOS registration state.
2. Wait for successful completion, then Quit Shellbell and replace/remove the app.
   Do not drag away a running app or disable the helper before cleanup.
3. To use closed-lid access after installing the new app, set up its helper and
   use **Recover Interrupted Setup…** after all update/removal operations finish.
   This explicitly clears the maintenance hold after readback. Closed-lid access
   remains off until enabled again.

If removal fails, keep the app installed and retry or explicitly recover.
The durable hold survives crashes and disconnects; it cannot authorize clearing
another application's sleep override. Manual file deletion or administrator
actions outside Shellbell cannot provide transactional cleanup guarantees.
Ordinary Quit still stops desktop remote access and releases owned power controls.

Tests are adapter-level, not proof of signed IPC, Gatekeeper, UI appearance, or
physical lid behavior. See the [qualification checklist](../../docs/macos-power-helper-qualification.md)
and [current qualification](../../docs/before-first-release.md#qualification-status).

New artifacts place native Node at `Contents/Helpers/node`, with its LICENSE at
`Contents/Resources/runtime/LICENSE`. There is no fallback to the older
Resources executable path. This layout change preserves bundle/service identifiers
and per-user identities; it is not an in-place update of a running app. Stop and
disable an older development service, quit its controller, then replace the app
manually as described below. Exact development inventory verification remains in
force; candidate tooling below is separate from real publisher qualification.

Requires macOS, Swift 6/Xcode command-line tools, Node 22+, the repository's pinned
pnpm and an already populated pnpm store. Run the normal repository install first.
The build refuses uncommitted tracked or untracked source. It exports a commit into
a new temporary SOURCE directory, installs offline with lifecycle scripts disabled,
builds the agent and Swift executable there, and performs offline production
`pnpm deploy --legacy` there. The active checkout and its node_modules are never the
deployment source. Failed staging and partial outputs remain available for diagnosis;
delete only the exact temporary roots printed by the command when no longer needed.

Use the official archive listed in [runtime-manifest.json](runtime-manifest.json).
Its version, architecture and SHA-256 derive from the
[current qualification](../../docs/before-first-release.md#qualification-status).
The build verifies the raw archive before inspecting or extracting it, then copies
it into staging and verifies it again. Only `bin/node` and `LICENSE` are extracted;
npm/corepack links and the rest of the upstream distribution are never extracted.
No globally installed Node files or workspace node_modules are copied into the app. Bundle copies preserve admitted file permissions even with a restrictive
release-shell umask. Deployment-only pnpm metadata is removed before inventory
creation, and admission rejects bundles that still contain it. This keeps local
package-store paths out of the distributed payload.

To acquire an archive explicitly, use a new owned temporary directory and the
manifest's official HTTPS URL. For example, the arm64 download is bounded by:

```sh
curl --proto '=https' --proto-redir '=https' --location --fail \
  --max-time 60 --max-filesize 100000000 \
  --output /absolute/new-download/node-v22.23.1-darwin-arm64.tar.xz \
  https://nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-arm64.tar.xz
pnpm native:test
pnpm native:build --arch arm64 --output /absolute/new-output \
  --runtime-archive /absolute/new-download/node-v22.23.1-darwin-arm64.tar.xz \
  --build-number RESERVED_MAC_BUILD_NUMBER
pnpm native:verify /absolute/new-output/Shellbell.app
pnpm native:dmg /absolute/new-output/Shellbell.app /absolute/new-Shellbell.dmg
```

The output directory and DMG must not already exist. Use `--arch x64` with its
matching archive for a separate Intel build. Cross-compilation alone does not
qualify Intel execution or macOS 13 support. Swift's `--show-bin-path` determines
the product path; no toolchain-specific `.build` directory is assumed.

Reserve a positive integer Mac build number before building. The two architectures
of one candidate share that number and source commit; a rebuild needs a fresh
number. Packaging derives the marketing version from the bundled computer
package, writes both native version fields and binds the number to the inventory.
The checked-in plist is a development template. Older development inventories
without a build number need a fresh candidate for verification with these tools.
See [versioning](../../docs/versioning.md) for counter and release ledger rules.

Every standalone verification and DMG admission performs an isolated, five-second
private Node `--version` check after static integrity admission. The host must
already be able to execute the artifact's architecture. An incapable host fails
with `runtime-version-unavailable`; it never installs Rosetta or returns a
static-only success. Intel artifacts therefore need an already-capable/native
verification host. CI tests these refusal paths with fixtures; its Swift build
alone does not qualify cross-architecture runtime behavior.

The bundle contains `Contents/MacOS/Shellbell`, immutable Info/LaunchAgent plists,
the existing service icon and 18-point template images, a private Node runtime,
all generated agent JavaScript (including shared chunks), deployed production
dependencies and actual bundled/runtime dependency license notices. A hashed
inventory records source commit, runtime archive digest, file modes and contents.
This inventory detects accidental alteration; it is not a signature or independent
proof of publisher identity. Verification checks layout, architecture, versions,
plist contracts, import closure, containment and licenses before any packaged code
executes. The build then runs only isolated Node/agent `--help` and `--version`
checks, asserting that no state was created. It does not execute the Swift UI or
service modes, register a job, install/mount the DMG or access terminals/devices.

The static linker uses the checkout's pinned TypeScript parser and Node's ESM/CJS
resolvers with explicit parent modules. It follows the actual selected export
conditions and internal/transitive imports without evaluating packaged dependencies.
Computed module specifiers and unresolved loading aliases fail closed. Resolver-only
`createRequire(...).resolve` metadata inspection is admitted; callable loader aliases
are not. Entirely absent optional peers are allowed only when both peerDependencies
and peerDependenciesMeta declare them optional and require is inside a try block
with an empty catch fallback. Installed optional packages with broken entry or
internal/transitive imports still fail. Relative generated chunks stay inside `dist`.

The protobuf 2.14.1 npm package omits license files. Its exact upstream Apache
license and Google BSD notice are vendored under `Resources/DependencyLicenses`,
bound to version, upstream commit, source URLs and SHA-256. Other notices are copied
from the actual installed runtime and bundled dependencies. A changed/missing
version-bound supplement fails the build; packaging never fetches fallback licenses.

## Installation and operation

Copying a development app into Applications and opening it is an explicit local
installation decision. Unsigned artifacts are not qualified public installers;
building/verifying does not install the app, register helpers or start services.

Desktop first use requires consent. The app owns its service through a private
supervision pipe. Closing Settings leaves access running; Quit stops the exact
owned service, releases owned power controls and waits for verified cleanup.
Controller death also ends desktop remote access. Terminal jobs stay on the host.

Start at Login is a separate main-app preference. A headless installation belongs
to launchd and remains independent of the UI. Advanced offers explicit conversion
to headless mode; General offers conversion back to desktop. Conversion preserves
identity, pairing and configuration and retains interrupted recovery state.
A bundle-backed headless runtime still needs the app at its installed path.

Settings are saved separately from the running service's startup snapshot. Apply
or restart requires current ownership/revision evidence. Migration from an existing
CLI definition requires explicit handoff. Unknown outcomes need inspection rather
than replay, and recovery does not infer consent to restart from an old running state.

Before replacement or relocation, remove any configured closed-lid helper through
the managed procedure above, stop/disarm the intended service/startup owner, Quit,
then replace the bundle and inspect ownership before starting again. Never move a
running installation and assume registrations follow it. Uninstall preserves keys
and pairings unless separately retired; deleting the GUI is not a headless service
stop operation.

Real Login Items, Quit, logout/reboot, conversion, recovery and relocation require
[platform qualification](../../docs/before-first-release.md#computer-releases).
[Native architecture](../../docs/architecture/native-controller.md) owns the lifecycle
contract; [CLI operations](../../docs/install-agent.md) cover standalone headless use.

## Signed candidates and release qualification

Development `native:verify` and `native:dmg` still require the exact development
inventory. They deliberately reject signed candidates; never bypass inventory
verification to make a candidate pass.

Separate opt-in tooling implements publisher-bound candidate verification and
inside-out signing of a **copy**. Tests cover policy, sequencing and failures;
actual publisher signing and hardened-runtime behavior remain unqualified.
Source checks do not establish real certificate or notarization qualification.

After independent tooling review and separately authorized certificate setup:

```sh
pnpm native:sign-candidate --app /absolute/development/Shellbell.app --output /absolute/unused-candidate-directory --identity-sha1 EXPLICIT_CERTIFICATE_SHA1 --team-id EXPECTED_TEAM_ID
pnpm native:verify-signed-candidate --app /absolute/unused-candidate-directory/Shellbell.app --team-id EXPECTED_TEAM_ID
```

The identity must be the selected Developer ID Application certificate's 40-hex
fingerprint, not a name, ad-hoc dash or private key. Supply Team ID independently;
do not trust a candidate manifest's value or assume the historical repository
value is current. These commands never select an identity automatically.

Only sign development artifacts built from source you trust. Development
inventory checks establish byte consistency, not publisher authenticity, and
development admission executes the input runtime's version probe before signing.
Do not use the signer to inspect or bless an untrusted downloaded app.

The signer verifies the development input, checks its native-code allowlist,
copies into an unused directory and verifies the copy. It signs Node with only
the candidate `allow-jit` entitlement, writes provenance/payload hashes, then
signs the app with empty entitlements. It does not preserve upstream Node's broad
entitlements or use `--deep` signing.

The verifier requires Apple-anchored Developer ID Application signatures,
expected team/fixed code IDs, hardened-runtime flags, timestamps, exact
entitlements and static payload integrity before running packaged code. It then
runs only isolated Node version/numeric-loop smoke checks, not a service or UI.
The loop does not qualify every JIT tier, addon or platform behavior. If the narrow
policy fails on a real runtime, stop rather than silently adding permissions.

The detached `candidate-report.json` includes final all-file hashes with
`notarized: false`, `releaseReady: false`. No embedded resource is rewritten
after outer signing. Failures leave new output for diagnosis without a success
report; input is not overwritten. Every retry requires an unused output path.
The recorded source commit is publisher-provided provenance, not proof of an
independently reproduced build. Hash checks also do not sandbox a compromised
same-user process that can modify local files concurrently.

### Signed disk images

Separate opt-in tooling now creates a signed image from an admitted signed
candidate, without modifying that input app. Final source review is tracked in
the [current qualification](../../docs/before-first-release.md#qualification-status).
Only after review and authorized certificate setup:

```sh
pnpm native:build-signed-dmg --app /absolute/candidate/Shellbell.app --output /absolute/unused-release-directory --identity-sha1 EXPLICIT_CERTIFICATE_SHA1 --team-id EXPECTED_TEAM_ID
pnpm native:verify-signed-dmg --image /absolute/release/Shellbell.dmg --team-id EXPECTED_TEAM_ID --stage candidate --report /absolute/unused-candidate-verification.json
```

The image uses Developer ID Application signing with fixed identifier
`sh.bilal.shellbell.host.disk-image`, distinct from the app. It verifies the
image publisher before mounting, checks UDZO/HFS+ layout and the app actually
inside, then detaches before recording hashes. Read-only mounts use fresh owned
paths; no Finder/app launch, install or service operation occurs. Physical image
size is capped at 1 GiB and uncompressed size at 2 GiB; commands have bounded
output and at most 60 seconds. A failed detach preserves scratch and reports its
mount point instead of recursively deleting or force-detaching it.

The operator later notarizes and staples the outer image, leaving app bytes
unchanged. Then run the same verifier with `--stage notarized` and a fresh report
path. It additionally requires a valid stapled ticket, enabled Gatekeeper and
notarized-source assessments of both image and embedded app. These read-only
checks may contact Apple. No stage downgrade or automatic submission occurs.
Use the post-staple report hash for distribution; the earlier candidate hash no
longer identifies final bytes. Every report still has `releaseReady: false`.

Actual publisher signing/notarization, downloaded quarantine/Gatekeeper behavior and
clean-machine runtime/lifecycle qualification remain open. Do not distribute
candidates as qualified installers.
The [publisher checklist](../../docs/macos-release-signing.md) records owner steps;
the [current qualification](../../docs/before-first-release.md#qualification-status)
records exact source/test/review evidence.

Actual Login Items, desktop Quit, headless independence, logout/reboot, relocation,
Intel/minimum-OS and physical-device behavior remain release gates. The
[release checklist](../../docs/before-first-release.md) is authoritative.

The owner direct-transport candidate currently admits the exact `node-datachannel@0.33.4` loader and Darwin arm64 native binary in static bundle verification. Modified loaders, local replacement binaries and other target architectures fail closed. Darwin x64 native-binary admission and transitive native notices remain qualification work before distributing a direct-capable x64 app. The platform package receives the pinned upstream MPL text in the bundle license inventory.

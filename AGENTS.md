# Shellbell contributor guidance

## Owner-approved local testing policy

For local test builds, the owner authorizes narrowly scoped, exact-version pnpm
release-age exceptions without asking again (2026-09-29). Keep the default age
policy for other packages; do not disable it globally or add wildcard exceptions.
Review the dependency diff and run frozen-install/SDK checks. This permission
does not authorize production signing bypasses, publication or store uploads.

Shellbell mirrors terminal sessions to a phone and sends useful notifications.
Terminal content and private notification context are end-to-end encrypted; the
relay routes ciphertext. Preserve that boundary.

## Development and architecture

Use Node 22.23.1 and pnpm 11.12.0. From the root run `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build`. Workspace responsibilities:

- `packages/protocol` (`@shellbell/protocol`): wire schemas, crypto and terminal model. Apps depend on it, not each other.
- `apps/agent` (`shellbell`): terminal backends, host identity, pairing and encrypted streaming.
- `packages/relay-core` (`@shellbell/relay-core`): runtime-independent relay and push policy through explicit ports.
- `apps/relay` (`@shellbell/relay`): Cloudflare storage, WebSocket and alarm adapters.
- `apps/relay-node` (`@shellbell/relay-node`): single-process Node adapters with a private local SQLite volume.
- `apps/mobile` (`@shellbell/mobile`): Expo libraries, native FCM/APNs receivers and xterm.js; native development builds, not Expo Go.
- `apps/macos`: native menu-bar controller and optional power helper. Linux packaging is in `apps/linux`.

Run one test with `pnpm -F shellbell exec vitest run test/example.test.ts`.
Agent dev arguments do not use a `--` separator: `pnpm -F shellbell run dev --version`.
Use condition-based asynchronous waits, not fixed sleeps. A connected backend may
not yet have completed its initial session snapshot.

Read [architecture](docs/architecture/README.md) and the [protocol](docs/protocol.md).
Normal mobile connections negotiate secure-v2 WebRTC over the encrypted relay.
Terminal traffic pauses until direct cutover; temporary encrypted relay terminal
fallback requires a user choice. Periodic retries remain active. Do not describe
owner device checks as general cross-network qualification.

Preserve atomic budgets/claims, revocation, per-computer ownership and bounded
queues across adapters. Other-language implementations need protocol conformance,
not TypeScript imports. Container, backup and production qualification are
separate from local runtime conformance. See [relay portability](docs/architecture/relay-portability.md),
[adapter contracts](docs/relay-adapters.md) and [Node operations](apps/relay-node/README.md).
Never turn capacity arithmetic into measured hosting guarantees.

## Safety and release

[Before first release](docs/before-first-release.md) is the live release checklist.
Authorized [internal mobile CI](docs/mobile-ci-releases.md) uses its own repository
flag and a `main`-only credential environment. Its beta tags follow verified store
assignment; public store promotion and stable tags require separate authorization.
Source tests are not store, hardware, notarization or production qualification.
No npm publication, release tags, deployment or store submission without explicit
authorization. Release automation is disabled unless its dedicated repository
flag is enabled. Local builds and explicit Fastlane internal uploads are separate.

Follow `docs/versioning.md`: the Mac controller, headless CLI and Linux archives
share the computer version; mobile and relay have independent release lines.
Native candidates need reserved platform build numbers. Run `pnpm check:versions`
and `pnpm check:release-tooling` for release metadata/tooling changes. Changesets
prepares all pending versions, which are not evidence that artifacts shipped.

Major version upgrades require prior discussion and explicit owner approval.
Do not add a major Changeset, change a major version or raise a ceiling in
`release-policy.json` without that approval. Mobile 1.0 is the approved launch
milestone. Future majors, including 2.x, need a new decision; expect compatible
features and refactors to continue within 1.x. Preserve compatibility or discuss
an incompatible change instead of disguising it as a patch or minor. This rule
also covers automated and dependency-driven release plans.

Preserve `.shellbell` identities, keys and pairings. Do not restart the installed
service, change power settings, unregister helpers or type into real terminals
merely to run tests. `SHELLBELL_LIVE=1` and `SHELLBELL_TMUX_E2E=1` affect real
sessions and remain opt-in. Keep headless and desktop-owned lifecycles distinct.

Never commit signing credentials, service-account keys, account-specific private
configuration, personal machine paths or historical private provenance. Firebase
client configuration is not a service-account secret, but must match the app ID.
Run the public-source audit before committing; artifact metadata needs its own
review. Retain `LICENSE`, `TRADEMARK.md`, third-party notices and xterm.js credits.

Computer, relay and mobile have separate release lines. Android and iOS share
the mobile version; native build counters and protocol compatibility are separate.
Follow [versioning and changelogs](docs/versioning.md). Do not consume Changesets,
enable publishing flags or invent releases merely to update documentation.

## Documentation

Start at [docs/README.md](docs/README.md). Keep `docs/` as current architecture,
contracts, setup, operations and qualification guides. Do not add dated audits,
Superpowers plans/logs, development diaries, duplicate status reports or benchmark
result dumps. Update the owning guide and live release checklist when behavior
changes. Release changelogs and private artifact evidence serve separate purposes.

`PRIVACY.md` owns the data inventory; [design](docs/architecture/design.md) owns
current design/security decisions; [extensibility](docs/architecture/extensibility.md)
owns known extension constraints. Keep `CLAUDE.md` a pointer here rather than
copying these instructions. Do not fabricate links to deleted historical plans.

Shellbell is a solo project maintained by Bilal. Use only his first name in public
repository content and link to `bilal.sh` for contact; do not publish his email
address or invent a team, support SLA or unverified `shellbell.dev` mailbox.
Pro-bono help is discretionary, not a service
commitment. Use one full logo in the root README and only occasional small icons
elsewhere. Link `shellbell.dev` as coming soon until launched.

Docs must not assume access to the maintainer's hosting or app-store accounts.
Run `pnpm check:docs` and `pnpm check:versions` when changing guides or metadata.

## Additional checks

Install with `pnpm install --frozen-lockfile`. CI's complete steps are in
`.github/workflows/ci.yml`; the native and generated checks can also run directly:

```sh
swift test --package-path apps/macos
swift build --package-path apps/macos --configuration release
pnpm -F @shellbell/mobile check:vectors
pnpm -F @shellbell/mobile terminal:check
pnpm -F @shellbell/mobile brand:check
pnpm -F @shellbell/mobile doctor
pnpm -F @shellbell/protocol gen:protocol-doc
git diff --exit-code docs/protocol.md
pnpm -F shellbell check:bundle
bash apps/agent/scripts/pack-smoke.sh
node scripts/check-public-source.mjs
pnpm check:relay-boundaries
pnpm check:relay-conformance
pnpm check:docs
pnpm check:versions
```

Regenerate and commit protocol docs when schemas change; do not hand-edit generated
docs. Keep native notification vectors synchronized with the protocol package.
Shared JSON/schema/vector fixtures in `packages/relay-core/test-support` are
repository-only. Expected SQLite/Workerd diagnostics do not justify suppressing
logging globally. Build both images in `apps/relay-node/README.md` before
`pnpm check:relay-containers`; local arm64 evidence is native, amd64 emulated.
Target volumes, TLS/proxy, upgrade/restore and devices remain operator work.

Current storage, recovery and lifetime rulings live in
[relay portability](docs/architecture/relay-portability.md) and
[relay storage](docs/architecture/relay-storage.md).

[Local mobile releases](docs/local-mobile-releases.md) owns local-build/Fastlane
prerequisites; the generated iOS signing test requires prebuild. Source gates do
not qualify signed artifacts, store processing or actual device delivery.

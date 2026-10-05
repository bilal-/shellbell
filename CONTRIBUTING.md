# Contributing to Shellbell

Start with the [README](README.md), [documentation index](docs/README.md) and
[current release checklist](docs/before-first-release.md). Report suspected
vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue.

Shellbell is a solo project maintained by [Bilal](https://bilal.sh).
Contributions are welcome; substantial changes should explain their intended
behavior and compatibility. Reviews depend on the maintainer's availability.

## Local setup

Use Node 22.23.1 and the repository-pinned pnpm 11.12.0. macOS is needed for Swift/Xcode
work and iTerm2 integration. Android builds need Java and the Android SDK; iOS
builds need Xcode and CocoaPods. Ruby/Bundler prerequisites for Fastlane are in
[local mobile releases](docs/local-mobile-releases.md).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Biome owns TypeScript formatting. Use `pnpm lint:fix` deliberately and inspect its
diff; do not reformat unrelated changes. Never hand-edit bundled `dist` output.

## Workspace map and focused checks

| Path | Package / tool | Responsibility |
| --- | --- | --- |
| `packages/protocol` | `@shellbell/protocol` | Wire schemas, crypto and shared terminal model |
| `apps/agent` | `shellbell` | Computer service, terminal backends, pairing and streaming |
| `packages/relay-core` | `@shellbell/relay-core` | Runtime-independent relay and push policy |
| `apps/relay-node` | `@shellbell/relay-node` | Node sockets, SQLite, scheduling and HTTP adapters |
| `apps/relay` | `@shellbell/relay` | Cloudflare sockets, SQLite and alarm adapters |
| `apps/mobile` | `@shellbell/mobile` | Expo/React Native client and native notifications |
| `apps/macos` | Swift package | Desktop controller and privileged power helper |
| `apps/linux` | Packaging scripts | Per-user headless archive distribution |

```sh
pnpm -F shellbell exec vitest run test/herdr-backend.test.ts
pnpm -F @shellbell/relay test
pnpm -F @shellbell/mobile test
pnpm -F @shellbell/protocol test
swift test --package-path apps/macos
swift build --package-path apps/macos --configuration release
```

The agent's package name is `shellbell`, not `@shellbell/agent`.
For development CLI commands there is no extra `--` separator:

```sh
pnpm -F shellbell run dev --version
```

## Local relay and mobile development

`pnpm -F @shellbell/relay dev` starts Wrangler's development runtime, not a
production standalone server. Use a disposable agent state directory and an
explicit `--relay ws://127.0.0.1:8787` override for local experiments.
Persisting an insecure URL with `config set` requires `--insecure`; never use
plain WebSockets on the public internet or overwrite your normal pairing state.

The phone cannot reach your computer through the phone's own loopback address.
For device testing, deliberately choose a reachable development endpoint.

Mobile requires a native development build, not Expo Go. Once that build is installed:

```sh
pnpm -F @shellbell/mobile start
```

See [local mobile releases](docs/local-mobile-releases.md) for native generation,
signing, internal uploads and safe retirement of older app enrollments.

## Additional verification gates

The main lint/types/tests loop is not all of CI. Depending on the change, also run:

```sh
pnpm -F @shellbell/mobile check:vectors
pnpm -F @shellbell/mobile terminal:check
pnpm -F @shellbell/mobile brand:check
pnpm -F @shellbell/mobile doctor
pnpm -F @shellbell/protocol gen:protocol-doc
git diff --exit-code docs/protocol.md
pnpm -F shellbell check:bundle
bash apps/agent/scripts/pack-smoke.sh
node scripts/check-public-source.mjs
```

When schemas change, regenerate and commit `docs/protocol.md`; the diff gate above
should be clean afterward. Keep generated crypto vectors, terminal assets and
upstream license notices synchronized. See [.github/workflows/ci.yml](.github/workflows/ci.yml)
for CI's actual steps and [terminal upgrades](docs/mobile-terminal-renderer.md).

Release-tooling tests are separate from workspace Vitest. Run the documented Ruby
and Node checks when changing Fastlane/configuration; after iOS prebuild, run
`bundle exec ruby apps/mobile/fastlane/test/native_signing_test.rb`.
Linux archive/container qualification is documented in [apps/linux](apps/linux/README.md).

## Tests that affect real systems

Normal tests must not type into real terminals or mutate installed services.
`SHELLBELL_LIVE=1` and `SHELLBELL_TMUX_E2E=1` explicitly enable hardware tests;
run them only with an authorized disposable session. Device installation, service
restart, privileged-helper setup and power changes are separate actions.

Use condition-based asynchronous waits. A backend connection can resolve before
its initial session snapshot is available. Wait for the state actually asserted,
not a fixed sleep or an earlier readiness flag.

## Architecture changes

Implement terminal backends behind `TerminalBackend` and register them with the
backend registry. Keep wire changes in the protocol package and consider backward
compatibility, bounded payloads, input replay and encrypted notification handling.

The relay core is runtime-independent. [Adapter contracts](docs/relay-adapters.md)
and [portability](docs/architecture/relay-portability.md) describe the supplied
Cloudflare and Node implementations. Changes to storage, scheduling or connection
ownership need conformance and recovery checks; do not weaken atomic budgets,
revocation or retention to fit another provider. See
[extensibility](docs/architecture/extensibility.md) before adding a backend or platform.

## Pull requests and release boundaries

Keep changes scoped, include regression coverage, and update the owning guide.
State which tests ran and which hardware/provider checks did not.
Do not include terminal transcripts, real fingerprints, QR secrets, signing keys,
service-account files, account IDs or personal machine paths in examples.

Do not deploy, publish npm packages, tag releases or upload to stores as an ordinary
test step. Release jobs are opt-in; builds and uploads are separate operations.
Source checks are not signing/notarization or store-delivery qualification.

Shellbell uses the [MIT License](LICENSE). Retain existing notices, document new
dependency licenses, and follow [TRADEMARK.md](TRADEMARK.md) for derivative branding.
See [third-party notices](THIRD_PARTY_NOTICES.md).

## Documentation and release metadata

Use the [documentation index](docs/README.md) for current guides. Explain behavior
and qualification limits from source and verified evidence. Update the owning
architecture or operations guide instead of retaining dated plans or logs. Use
minimal branding and link [shellbell.dev](https://shellbell.dev) as coming soon until
it launches. Retain upstream attribution and license text.

```sh
pnpm check:docs
pnpm check:versions
pnpm check:relay-boundaries
pnpm check:relay-conformance
node scripts/check-public-source.mjs
```

The [versioning policy](docs/versioning.md) defines separate computer, relay and
mobile release lines, native build numbers, compatibility and changelogs. Add a
Changeset for released behavior; documentation alone normally needs no version
bump. Release preparation is a reviewable change, separate from authorization to
publish, deploy or submit artifacts.

For new relay stacks, implement the [runtime ports](docs/relay-adapters.md) and
pass the shared [conformance fixtures](packages/relay-core/test-support/README.md).
Do not duplicate protocol or security policy in a platform adapter.

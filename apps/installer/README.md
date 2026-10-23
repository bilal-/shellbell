# Shared CLI installer

Computer 0.10.0 includes the shared installer for Apple silicon macOS and Linux
ARM64/x64. The macOS npm package remains supported alongside it.

Install as your normal user:

```sh
curl -fsSL https://shellbell.dev/install.sh | sh
```

The website redirects to one immutable `install-cli.sh` asset from the selected
stable computer release. It does not use GitHub's multi-component `releases/latest`.
Users can download the script and inspect it before running it. `--help` is local
and does not download or install anything.

## Installation contract

- Apple silicon macOS uses the release's signed, notarized DMG. The bootstrap
  checks its pinned SHA-256, app identifier/version, code signature and Gatekeeper
  acceptance before executing its bundled Node runtime. It preserves the complete
  signed bundle, including confined relative dependency links. The menu-bar app
  and power helper are never launched or registered.
- Linux ARM64/x64 uses the existing [archive bootstrap](../linux/README.md),
  including its glibc floor, bounded extraction and inventory verification.
- Node, npm, Homebrew and build tools are not installation prerequisites. Linux
  still needs the system utilities listed by its bootstrap.
- The launcher is `~/.local/bin/shellbell`. Installation does not edit shell
  startup files; add that directory to `PATH` if necessary. An existing unmanaged
  launcher is never overwritten. Check `command -v shellbell` if npm is also
  installed and appears earlier on `PATH`.
- macOS installs into `~/.local/share/shellbell/installs/darwin-arm64/VERSION`.
  Each directory contains `Shellbell.app`, the bootstrap/installation engine and
  an installation receipt. Linux keeps its existing `linux-ARCH/VERSION` layout.
  A per-user lock serializes installation and an atomic pointer selects the CLI.
  Old versions remain available to pinned services; the installer does not prune
  them or reclaim stale locks.
- Installation does not create or change identities, pairings, service definitions,
  login settings or power settings. Follow [computer setup](../../docs/install-agent.md)
  to explicitly start or install a service. Desktop-owned state still requires the
  Mac app's explicit ownership conversion before a headless service can use it.

`shellbell update` downloads only after confirmation (or `--yes`) on managed CLI
installations. It verifies the published release and artifact, checks platform
requirements, then uses the installed bootstrap to add a newer version. Running
services keep their pinned runtime until the user explicitly switches them.
`shellbell update --check` only reads public release metadata. npm and ordinary
Mac app installations keep their existing update instructions.

## Prepare and qualify a release

After producing and qualifying the matching computer artifacts, generate the
installer from their `computer-release.json`:

```sh
node apps/installer/release-installer.mjs \
  --manifest /absolute/computer-release.json \
  --output /absolute/new-installer-directory
```

The command emits `install-cli.sh`, its checksum file, and a separate
`cli-installer.json` record binding the installer to the computer source/version.
Keep `computer-release.json` unchanged: existing v1 updaters reject extra fields. Upload those files with the other
computer artifacts after the normal release gates. Keep the existing Linux
`install.sh` asset for older download links. The public website sync verifies the
new installer's exact asset URL and GitHub digest before enabling `/install.sh`.

Computer 0.10.0 contains the managed Mac CLI update code; the previously published
0.9.0 CLI does not. Qualify install/help/version and
update recognition using the exact new signed bundle, not just a source test.
Check a newer candidate's explicit update, retained old runtime, unchanged
identity/pairing fixtures, concurrent install refusal, foreign launcher refusal,
checksum failure and failed-signature paths. Use isolated homes and explicit
artifact paths, never the maintainer's installed service or personal folders.

The existing signed 0.9.0 DMG can exercise the installation mechanism in a private
fixture, but cannot qualify the new CLI update behavior. Native macOS execution,
Linux container qualification, actual service lifecycle and hardware/pairing
qualification remain separate evidence.

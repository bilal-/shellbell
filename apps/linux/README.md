# Linux archive distribution

This is implemented development tooling, not a published release. Actual archive
qualification is tracked in the [current qualification](../../docs/before-first-release.md#qualification-status).
Do not merge the npm release PR or publish assets as part of testing this tooling.

## Qualification scope

Source-built 0.1.1 archives pass install, upgrade, removal, native WebRTC, real
tmux and two-user isolation checks on Ubuntu 22.04 and 24.04. ARM64 containers
execute natively on the test host; x64 containers use Docker Desktop emulation.

Real systemd user managers also pass service start/restart, enable/disable,
SSH logout/login, guest reboot and uninstall checks on both Ubuntu versions in
ARM64 QEMU VMs inside Docker. Tests confirm that enabling a service does not
start it, disabling it does not stop it, and credentials survive lifecycle
changes. With linger disabled, the user manager stops after logout; the enabled
service resumes at the next login, including after a real guest kernel reboot.

These checks use disposable state with no host home or terminal mounted. Native
x64 service boot, physical phone pairing/transport/push, other filesystems and
the published download path remain release gates. Emulation results establish
compatibility rather than hardware performance.

## Operator workflow

The archive bundles Node; system Node/npm are not required. Initial targets are
glibc Linux x64/arm64 (Ubuntu 22.04 and 24.04 qualification), glibc 2.30+, kernel
4.18+, GNU tar/coreutils, and an executable user-owned HOME filesystem. Alpine
musl is not supported. Install tmux 3.2+ separately to expose terminal sessions.
The installer does not use sudo, install tmux, edit shell profiles, enable linger,
create an identity, pair a phone or start a service.

Until release assets are published, use an independently built local archive:

```sh
sh apps/linux/install.sh --archive /absolute/shellbell-VERSION-linux-arm64.tar.gz --sha256 EXPECTED_SHA256
```

The downloader's `--version X.Y.Z` mode uses the computer release tag
`shellbell@X.Y.Z` (URL-encoded as `shellbell%40X.Y.Z`) and its archive/checksum
assets. Qualifying that download path against actual published assets remains a
[release gate](../../docs/before-first-release.md#computer-releases). Use the local
archive command above until public assets and tags are available. Versions have
three numeric components; preview status belongs to the release channel.
Same-publisher checksums detect corruption/mismatch, not publisher compromise.

The managed launcher is `~/.local/bin/shellbell`. Add that directory to PATH
yourself, or invoke it by its absolute path. New hosts initialize explicitly:

```sh
~/.local/bin/shellbell host init --new
~/.local/bin/shellbell start
```

Use `shellbell pair` for the pairing QR. Linux exposes tmux sessions owned by this
OS user, not arbitrary existing SSH shells or GPU jobs. Another OS user installs
and initializes separately; they get a separate host identity and control socket.

Optional persistence needs an available systemd **user** manager:

```sh
shellbell service install
shellbell service start
shellbell service enable
shellbell doctor
```

Enablement alone does not prove logout/boot persistence. Linger is a separate
administrator decision. No user manager is required for foreground operation.

## Updates and removal

Run the installer again with an explicit version. Installations are immutable at
`~/.local/share/shellbell/installs/linux-ARCH/VERSION`; a per-architecture `current`
pointer selects the launcher version. Existing services remain pinned to their
old canonical runtime, which is retained. Deliberately stop, reinstall the service
definition, then start it to adopt an update. Nothing silently restarts a session.

Before selection, the candidate runs `--version` and `--help` under a disposable
private HOME/state/runtime environment, with a five-second deadline per command
and bounded output. Import failures, mismatched versions and hangs leave the old
pointer unchanged. The bootstrap anchors staging to canonical HOME before any
download. Removal inspects standard/configured systemd user-unit paths and asks
the installed systemd build for its effective search paths when available.

Uninstall the service definition and stop running agents before removing binaries.
Select the actual installed version and architecture, then invoke:

```sh
base="$HOME/.local/share/shellbell/installs/linux-arm64/VERSION"
"$base/runtime/bin/node" "$base/install.mjs" --uninstall
```

Removal refuses modified/untracked entries, active processes and service references.
It removes only inventoried installations and the managed launcher, preserving
identity, pairing and other state. It does not revoke devices. Interrupted staging
directories and stale install locks are retained for inspection, never guessed
safe to delete. Bootstrap prints its staging path on success or failure; remove
only that exact directory after inspection if you no longer need it.

## Build and qualification

Download the exact official runtime archive named in `runtime-manifest.json`;
the builder verifies its pinned SHA256 before extraction. Use a clean committed
worktree and an output directory that does not yet exist:

```sh
node apps/linux/scripts/build-archive.mjs --arch arm64 --runtime-archive /absolute/node-v22.23.1-linux-arm64.tar.xz --output /absolute/new-output
node apps/linux/scripts/build-archive.mjs --arch x64 --runtime-archive /absolute/node-v22.23.1-linux-x64.tar.xz --output /absolute/other-new-output
```

Outputs are an archive and `.sha256` file, with a source-commit inventory, Node
license, dependency notices and agent production dependencies. The builder uses
the existing npm tarball internally; npm metadata remains macOS-only. This does
not qualify Linux npm installation. No build step publishes anything.

The Linux-specific tests require real GNU tar and `/proc`; they supplement the
normal workspace tests. Copy the archive as `archive.tar.gz`, this directory's
`install.sh`, `test/`, and `test/Dockerfile` into a fresh Docker context. Build for
the archive's platform, choosing a recorded Ubuntu base digest:

```sh
docker build --platform linux/arm64 --build-arg BASE_IMAGE=ubuntu:24.04 -t shellbell-linux-test /absolute/context
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 128 --tmpfs /work:exec,uid=1000,gid=1000,mode=700 --tmpfs /tmp:mode=1777 shellbell-linux-test
```

The 2 GiB test limit includes RAM-backed installation and upgrade fixtures on
tmpfs; it is not an application memory requirement. Run regression files
serially within that bound.

`exec` on the private disposable tmpfs is intentional: Docker tmpfs is otherwise
noexec, preventing the bundled runtime from running. No host directories are
mounted. The image installs OS test prerequisites, but no system Node/npm; its
harness runtime is taken from the tested archive and is not on PATH. Repeat on
Ubuntu 22/24 and both CPU platforms; label emulation. Real reboot/logout, hardware
and phone qualification remain separate release gates.

Run the rejection/removal regression suite in the same image by appending:

```sh
/opt/payload/runtime/bin/node --test --test-concurrency=1 /opt/test/bootstrap.test.mjs /opt/test/removal.test.mjs /opt/test/qualification.test.mjs
```

The qualification regressions inject an old-version launcher, an unrelated
service-command error, and an unintended unit left after refusal. Each must make
the actual harness fail. The default harness checks the running versions and
probes service admission on the real payload before its synthetic upgrade. It
requires the expected unresolved-manager diagnostic, a missing per-user bus, and
no installed or enabled unit; a generic crash does not qualify as a refusal.

Run the native WebRTC check in a separate fresh container with the same isolation
flags and this command:

```sh
/opt/payload/runtime/bin/node /opt/test/native-webrtc.mjs
```

It loads the packaged platform addon and establishes a real ICE/DTLS/SCTP data
channel between two peers bound to loopback. Synthetic binary traffic makes a
round trip, and both peer certificate fingerprints are checked. No relay, STUN
server or phone is contacted. This catches native packaging failures that
`--version`, `--help` and terminal discovery cannot detect.

Run the real-tmux locale regression in a separate fresh container using the same
isolation flags and this command:

```sh
/opt/payload/runtime/bin/node /opt/test/tmux-locale.mjs
```

It installs the archive, explicitly initializes a disposable host identity, forces
the C locale, and waits for real pane output to produce an idle ring with the
canonical session ID. This checks local notification detection, not relay/provider
delivery. No host home or terminal is mounted. The harness attempts to stop its own
agent and tmux server on success or failure; container removal is the final
isolation boundary. See the
[current qualification](../../docs/before-first-release.md#qualification-status).

For the two-user installed-launcher/tmux test, use the same isolation with
`--user 0 --cap-add SETUID --cap-add SETGID --cap-add CHOWN`, `/work` tmpfs
`exec,mode=755`, and `/tmp` tmpfs `mode=1777`, then run
`/opt/payload/runtime/bin/node /opt/test/multiuser.mjs`. Only the coordinator is
root; installation and product processes run as UIDs1000/1001. Do not add DAC
override or mount real user homes. The writable disposable `/tmp` is also needed
by Docker Desktop's x64 emulation; read-only `/tmp` caused an emulator assertion
during process inspection, not a successful uninstall test.

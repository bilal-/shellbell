# Install and operate the computer service

The service mirrors terminals owned by your OS user. It must remain running and
the computer must be awake and able to reach the relay. Source builds and
[computer preview downloads](https://shellbell.dev/download/#computer) are
available. The Apple silicon Mac preview is signed and notarized; the headless
tarball is macOS-only. Public npm installation and qualified Linux archives are
not available yet.
See [release qualification](before-first-release.md).

Use [the macOS app guide](../apps/macos/README.md) for desktop-owned operation and
[the Linux archive guide](../apps/linux/README.md) for headless Linux. The commands
below describe the macOS CLI/headless service unless stated otherwise. A Windows
host service is not shipped.

## Requirements

- macOS, with Node 22.23.1 and pnpm 11.12.0 for a source build.
- At least one backend: iTerm2 with its Python API enabled, local tmux 3.2+ sessions,
  or a compatible running Herdr server.
- A reachable relay and compatible native phone app. Installation alone does not
  install the phone app or configure push credentials.
- A logged-in OS user for the per-user macOS service. It is not a boot-time root daemon.

The npm package currently declares `darwin`. Linux archives bundle their own Node
runtime; forcing npm installation on Linux does not qualify that path.

## Build and try from source

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm -F shellbell build
pnpm -F shellbell check:bundle
node apps/agent/dist/cli.js
```

Keep that terminal open. An interactive first start with no pairings can show a
QR; scan it in the phone app and approve the phone on the computer. Ctrl-C stops
the foreground service, not the terminal sessions it exposes. Development use is
`pnpm -F shellbell proto:gen` followed by `pnpm -F shellbell run dev`.

Persistent installation requires an installed, built package in a durable location.
It rejects source-checkout/TypeScript entrypoints, temporary directories and package
manager caches. Do not use `run dev service install` or assume an arbitrary public
`npx shellbell` is this project's verified release.

## Install a macOS headless service

Stop your foreground instance first. For the
[macOS headless 0.1.1 preview](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.1-beta.11),
download `shellbell-0.1.1.tgz`, `computer-release.json` and `SHA256SUMS.txt` into the
same directory, then verify both files:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The archive uses your installed Node 22+ runtime. Installation was verified with
Node 22.23.1 on Apple silicon; Intel and real OS-service login/logout/reboot remain
separate qualification checks. Public npm-registry installation is not available.

Alternatively, build and pack from the repository root:

```sh
pnpm --dir apps/agent pack
```

Install the downloaded archive or the exact tarball path printed by that command with
`npm install --global /path/to/shellbell-VERSION.tgz`, using a user-writable npm
prefix on your PATH. Then:

```sh
shellbell --version
shellbell service install
shellbell service status
shellbell pair
shellbell status
shellbell devices
```

Do not run the agent or installer as root. With the same account/state directory,
existing pairings survive; `pair` is needed only for another client. The macOS
installer writes `~/Library/LaunchAgents/sh.bilal.shellbell.plist`, bootstraps the
GUI-user job and verifies its local runtime. Install/start/restart require the
expected fingerprint, canonical state directory, service instance and certified
manager PID within a bounded ten-second readiness window.

Relay connectivity and terminal readiness remain separate. An empty session list
can simply mean no supported pane is open. Local readiness does not prove phone
input/output or push delivery.

```sh
shellbell service status
shellbell --json service status
shellbell service stop
shellbell service start
shellbell service restart
shellbell service enable
shellbell service disable
```

Status is read-only and exits `0` only for verified local readiness; absent,
stopped, foreign, unresponsive or legacy-unverified services exit `2`. Stop unloads
for the current login while retaining future startup preference. Enable/disable
change future startup without implicitly starting/stopping now. Uninstall removes
the definition after successful stop and preserves local data.

Headless commands refuse desktop ownership or unfinished conversion. Use the Mac
app's explicit conversion workflow instead of editing ownership records. A
bundle-backed headless service still requires its installed app/runtime path.
See [native ownership](architecture/native-controller.md).

## Configure terminal access

- **iTerm2:** Settings → General → Magic → Enable Python API, then approve access
  when requested. Shell integration is additionally needed for reliable prompt
  and exit-code events.
- **tmux:** run your shell inside a local tmux session in your preferred terminal.
  Installing tmux alone does not expose ordinary terminal tabs.
- **Herdr:** run its local server as the same user. Use `HERDR_SOCKET_PATH` when
  needed for an explicit socket.

Service installation saves a filtered PATH and absolute `HERDR_SOCKET_PATH` /
`XDG_CONFIG_HOME` settings where supplied. It does not copy arbitrary environment
variables or `HERDR_SESSION`. Later shell changes do not update that definition;
reinstall deliberately if its runtime/environment must change.

An SSH session inside a supported local pane can be continued from the phone.
That does not discover the remote host's other sessions or install a service there.
See [backend contracts](architecture/computer-agent.md#terminal-backends).

## Status, configuration and relay selection

```sh
shellbell status
shellbell --json status
shellbell devices
shellbell logs
shellbell logs -f
shellbell doctor
shellbell --json doctor
shellbell doctor --require-backend tmux
```

Doctor inspects without creating keys, starting a service, requesting iTerm2
consent or opening terminals. It distinguishes identity, manager, control, relay
and backend health. Missing optional backends are warnings; repeat `--require-backend`
to make selected missing backends errors. A bounded relay `/healthz` probe proves
HTTP reachability only. Diagnostics must not include terminal text or key files.

```sh
shellbell config set name "My Mac"
shellbell config set accent amber
shellbell config set relay wss://relay.example.com
shellbell config set notifyMinCommandMs 10000
shellbell config set idleQuietMs 30000
shellbell config set idleMinActiveMs 1500
```

These commands validate and save settings. The threshold examples match current
defaults; existing explicit values are preserved. The running service does not
hot-reload configuration. Restart a foreground instance explicitly, use
`shellbell service restart` for headless operation, or the Mac app's **Restart…**
for desktop-owned operation. The phone's per-computer **Relay URL** must agree.
New pairing QR codes carry the saved address; an empty replacement relay may need
new pairing. See [relay connection steps](self-hosting.md#connect-your-devices).

`SHELLBELL_DIR` selects state before first installation. Later manager commands
use the installed definition's directory; a conflicting explicit override is
refused. Moving state is not an implicit upgrade operation. Live endpoint guards,
sockets, PID files and unknown staging entries must not be deleted to bypass
ownership errors.

## Upgrade, revoke and uninstall

Rebuild, pack and install the new tarball, then rerun `shellbell service install`
so canonical Node/CLI paths and its filtered environment are updated. Verify
version, status and diagnostics. Keep old runtimes until the new service is verified.
A failed macOS replacement attempts to restore the exact prior definition and
loaded state; failed rollback reports separate recovery information. Do not reset
identity or pairings to repair a runtime problem.

While the intended service is running, identify and revoke a phone deliberately:

```sh
shellbell devices
shellbell unpair <unique-phone-fingerprint-prefix-or-name>
```

Prefer a unique fingerprint; display names can be ambiguous. Then, if retiring the
service/package:

```sh
shellbell service uninstall
npm uninstall --global shellbell
```

This retains identity, pairings, configuration and logs. It is not a credential
wipe or remote revocation. Revoke clients first when retiring a computer; changing
its identity changes the fingerprint and requires pairing again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Access ends when the foreground terminal closes | Install a headless service or use desktop-owned operation |
| Installed but not locally ready | Canonical runtime paths, logs, login/background approval and ownership |
| Relay online, no sessions | Enable a supported backend and open an actual exposed pane |
| Awake works, closed lid fails | Computer sleep; service supervision does not prevent it |
| Different ring behavior by backend | Prompt integration, quiet heuristic or semantic agent state |
| Screen works but no push | Permission, foreground lease, opt-in/token, provider credentials and limits |
| Final output appears stopped | Use bounded Retry output; collect sanitized diagnostics if it recurs |
| Relay address changed but access fails | Both endpoints, destination pairing metadata, TLS and reachability |

Optional power controls require their own [signed/helper qualification](macos-power-helper-qualification.md).
Do not change system sleep policy merely to test the service.

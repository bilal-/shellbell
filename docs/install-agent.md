# Install and operate the computer service

The service mirrors terminals owned by your OS user. It must remain running and
the computer must be awake and able to reach the relay. Source builds and
[computer downloads](https://shellbell.dev/download/#computer) are available. The
Apple silicon Mac app is signed and notarized. Computer releases also provide the
macOS headless package, published to npm as `shellbell`, and Linux ARM64/x64
archives with a one-line installer.
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
manager caches, so install globally rather than through `npx`. Do not use
`run dev service install`.

## Install a macOS headless service

Stop your foreground instance first. Install the published package with a
user-writable npm prefix on your PATH:

```sh
npm install --global shellbell@0.8.0
```

To install from a release download instead, put the
[computer release](https://github.com/bilal-/shellbell/releases/tag/shellbell%400.8.0)'s
`shellbell-0.8.0.tgz`, `computer-release.json` and `SHA256SUMS.txt` in one
directory, check them, and install the tarball:

```sh
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
npm install --global ./shellbell-0.8.0.tgz
```

The checksum list also contains the other platform files; `--ignore-missing`
skips those you did not download. Confirm that both `shellbell-0.8.0.tgz` and
`computer-release.json` report `OK`. A source checkout can pack its own tarball
with `pnpm --dir apps/agent pack`.

The package uses your installed Node 22+ runtime. Installation was verified with
Node 22.23.1 on Apple silicon; Intel and real OS-service login/logout/reboot remain
separate qualification checks. Then:

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

- **iTerm2:** Settings → General → Magic → Enable Python API. Then click
  **Connect iTerm2** in Shellbell → Settings → Terminals, or run
  `shellbell connect iterm2`. macOS asks to let Shellbell control iTerm2 and
  iTerm2 may ask to allow Shellbell; allow both. Shellbell never makes macOS ask
  on its own in the background, except when you run it in a terminal with
  `shellbell start`. If you said no, the Terminals settings and `shellbell doctor`
  show where to change it. Shell integration is additionally needed for
  reliable prompt and exit-code events.
- **tmux:** run your shell inside a local tmux session in your preferred terminal.
  Installing tmux alone does not expose ordinary terminal tabs.
- **Herdr:** run its local server as the same user. Use `HERDR_SOCKET_PATH` when
  needed for an explicit socket.

Service installation saves a filtered PATH and absolute `HERDR_SOCKET_PATH` /
`XDG_CONFIG_HOME` settings where supplied. It does not copy arbitrary environment
variables or `HERDR_SESSION`. Later shell changes do not update that definition;
reinstall deliberately if its runtime/environment must change. To open Herdr
sessions from the phone, the service first tries the program of your running
`herdr server`, wherever it was installed, and uses it when its version matches.
That needs Herdr's default socket; with a custom socket or session the running
server cannot be identified. Otherwise, and for tmux, it searches that PATH and
then `~/.local/bin` and `~/.cargo/bin`, where per-user installers place them.

An SSH session inside a supported local pane can be continued from the phone.
That does not discover the remote host's other sessions or install a service there.
See [backend contracts](architecture/computer-agent.md#terminal-backends).

## What macOS may ask you

Shellbell only reads your terminals and types where you tell it to from your
phone. macOS asks before some of those steps. Here is each question, why it
appears and what happens if you say no. You can change any answer later in
System Settings → Privacy & Security.

| macOS asks | Why | If you say no |
| --- | --- | --- |
| **"Shellbell" wants to control "iTerm2"** | So your phone can show your iTerm2 tabs and type into them. Asked only after you click **Connect iTerm2** (or run `shellbell connect iterm2`), with iTerm2's Python API on. The headless service may appear as `node` or `osascript`. Shellbell never controls other apps. | iTerm2 tabs don't appear on your phone. tmux and Herdr still work. |
| **iTerm2: allow Shellbell to connect?** | iTerm2 itself confirms that Shellbell may use its API. | Same as above. |
| **Find devices on your local network** | So your phone can connect straight to this Mac on the same Wi-Fi. | Your phone may not connect while it is on the same Wi-Fi. Shellbell's relay never carries terminal data, so the terminal waits until a direct connection works. |
| **Login Item or Background Items Added** | You chose to start Shellbell at login, or to run it as a background service. The headless service appears as `node`, the runtime Shellbell is built on. | Shellbell runs only while you keep it open. |
| **Administrator approval** | Only if you turn on **Keep awake with lid closed**, which changes a system power setting. | The Mac sleeps as usual when you close the lid. |

Shellbell does not ask for your Desktop, Documents or Downloads folders. For
sessions there it skips the Git lookup that names a session's project, and uses
the folder name instead. The first time you open the app or the downloaded
service, macOS also confirms that you want to open something downloaded from the
internet. Linux shows none of these prompts.

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
shellbell config set turn off
```

These commands validate and save settings. The threshold examples match current
defaults; existing explicit values are preserved. `turn` is `on` by default;
`off` keeps all terminal data off TURN servers, so restrictive networks cannot
reach this computer. See [turning TURN off](how-shellbell-connects.md#turning-turn-off).
These settings require a service restart. Restart a foreground instance explicitly, use
`shellbell service restart` for headless operation, or the Mac app's **Restart…**
for desktop-owned operation. The phone's per-computer **Relay URL** must agree.
New pairing QR codes carry the saved address; an empty replacement relay may need
new pairing. See [relay connection steps](self-hosting.md#connect-your-devices).

The separate **Show agent conversations** preference defaults off. Save it with
`shellbell config set conversations on` or `off`, or in the Mac app's settings.
Supporting services apply this consent live, without changing other running
settings. The CLI reports whether live application was confirmed; saved consent
alone is not evidence that it changed in a running service. A compatible phone can then show a proven conversation for its focused session.
Unbound or unsupported sources stay in Terminal; see the [reader and consent boundaries](architecture/computer-agent.md).

`SHELLBELL_DIR` selects state before first installation. Later manager commands
use the installed definition's directory; a conflicting explicit override is
refused. Moving state is not an implicit upgrade operation. Live endpoint guards,
sockets, PID files and unknown staging entries must not be deleted to bypass
ownership errors.

## Upgrade, revoke and uninstall

The headless service does not update itself, and npm installation does not enable
automatic updates. For a macOS headless installation, choose the published
computer version, stop remote access, install that package, and refresh its service
definition. For the current published version:

```sh
shellbell service stop
npm install --global shellbell@0.8.0
shellbell service install
shellbell --version
shellbell service status
shellbell doctor
```

On macOS, `service install` loads the updated service. For a source build, rebuild,
pack and install its tarball instead of the npm registry command. Reinstalling the
service updates its canonical Node/CLI paths and filtered environment. Keep old
runtimes until the new service is verified. These commands are for headless
ownership; update the [Mac app](../apps/macos/README.md#install-the-published-mac-app)
through its own lifecycle. Linux has separate [archive update steps](../apps/linux/README.md#updates-and-removal).

Preserve `.shellbell`, including its identity, keys and pairings. Do not run
`host init --new` as an upgrade step.
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
| Final output appears stopped | The phone has already retried a few times; use Retry output and collect sanitized diagnostics if it recurs |
| Relay address changed but access fails | Both endpoints, destination pairing metadata, TLS and reachability |

Optional power controls require their own [signed/helper qualification](macos-power-helper-qualification.md).
Do not change system sleep policy merely to test the service.

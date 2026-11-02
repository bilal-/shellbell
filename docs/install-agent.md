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

## Shared CLI installer

The [shared installer](../apps/installer/README.md) supports a bundled runtime on
Apple silicon macOS and Linux ARM64/x64, starting with computer 0.10.0. It installs
a CLI for the current user and leaves service startup, identities and pairings
unchanged. Node, npm and build tools are not required for this installation:

```sh
curl -fsSL https://shellbell.dev/install.sh | sh
```

You can download the script and inspect it before running it. The website selects
an immutable, verified computer-release installer. The launcher is
`~/.local/bin/shellbell`; add `~/.local/bin` to PATH, or invoke the full path.
If npm is also installed, check `command -v shellbell` to see which launcher wins.

Then run `~/.local/bin/shellbell install`, on a Mac or Linux computer. It runs
Shellbell in the background, starting again whenever you log in, and shows a QR code:
scan it in the phone app and approve the phone on the computer. A new Linux computer
gets its identity at the same time. To keep Shellbell in one terminal window instead,
for containers and testing, use `shellbell run`. See the macOS steps below or the
[Linux operator workflow](../apps/linux/README.md#operator-workflow).

## Build and try from source

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm -F shellbell build
pnpm -F shellbell check:bundle
node apps/agent/dist/cli.js run
```

Keep that terminal open. An interactive first start with no pairings can show a
QR; scan it in the phone app and approve the phone on the computer. Ctrl-C stops
the foreground service, not the terminal sessions it exposes. Development use is
`pnpm -F shellbell proto:gen` followed by `pnpm -F shellbell run dev`.

Running in the background requires an installed, built package in a durable location.
`shellbell install` rejects source-checkout/TypeScript entrypoints, temporary directories
and package manager caches, so install globally rather than through `npx`. Do not use
`pnpm -F shellbell run dev install`.

## Run Shellbell in the background on a Mac without the app

Stop any copy running in a terminal window first. If you used the shared installer
above, continue with the commands below. Alternatively, install the published
package into a user-writable npm prefix on your PATH. Replace `X.Y.Z` with the
latest `shellbell@X.Y.Z` [computer release](https://github.com/bilal-/shellbell/releases):

```sh
npm install --global shellbell@X.Y.Z
```

To install from a release download instead, put that release's
`shellbell-X.Y.Z.tgz` and `shellbell-X.Y.Z.tgz.sha256` in one
directory, check them, and install the tarball:

```sh
shasum -a 256 -c shellbell-X.Y.Z.tgz.sha256
npm install --global ./shellbell-X.Y.Z.tgz
```

Confirm `shellbell-X.Y.Z.tgz` reports `OK` before installation.
A source checkout can pack its own tarball
with `pnpm --dir apps/agent pack`.

The package uses your installed Node 22+ runtime. Installation was verified with
Node 22.23.1 on Apple silicon; Intel and real OS-service login/logout/reboot remain
separate qualification checks. Then:

```sh
shellbell --version
shellbell install
shellbell status
shellbell pair
shellbell phones
```

`install` shows the pairing QR itself when no phone is paired yet; `pair` adds
another phone. Do not run Shellbell or its installer as root. With the same
account/state directory, existing pairings survive. `install` writes
`~/Library/LaunchAgents/sh.bilal.shellbell.plist`, starts it for the logged-in user and
checks that it answers. Install, start and restart require the expected fingerprint,
canonical state directory, service instance and certified manager PID within a
bounded ten-second readiness window. Running `install` again changes nothing while
the same version runs from the same files; after an update it restarts Shellbell
on the new version.

Shellbell starts when you log in, not when the Mac boots. After a restart, log in
once, for example through Screen Sharing, so your phone can reach it. macOS doesn't
allow automatic login while FileVault is on.

Relay connectivity and terminal readiness remain separate. An empty session list
can simply mean no supported pane is open. Local readiness does not prove phone
input/output or push delivery.

```sh
shellbell status
shellbell --json status
shellbell stop
shellbell start
shellbell restart
shellbell uninstall
```

Status is read-only and exits `0` only when a Shellbell answers; otherwise it says
what to run and exits `2`. Stop stops Shellbell for this login: it starts again the
next time you log in, or with `shellbell start`. Uninstall stops Shellbell, removes
its background definition so it no longer starts at login, and keeps identity,
pairings and settings. `start` on a computer where Shellbell isn't installed offers
to install it, as highly recommended; declined, or without a terminal to answer,
it runs in that window.

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
  `shellbell run`. If you said no, the Terminals settings and `shellbell doctor`
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

Terminal mirroring does not need access to Desktop, Documents, Downloads or cloud
storage. For
sessions there it skips the Git lookup that names a session's project, and uses
the folder name instead. The first time you open the app or the downloaded
service, macOS also confirms that you want to open something downloaded from the
internet. Linux shows none of these prompts.

Commands and developer tools running in a session can cause their own file,
automation or device permission requests. macOS may attribute those requests to
the app responsible for launching the process, so a prompt can name Shellbell
even when another tool made the request. Deny unexpected access and check the
command that triggered it. Shellbell does not need blanket folder access for
terminal mirroring. See [Apple’s file access explanation](https://developer.apple.com/videos/play/wwdc2019/701/).

## Status, configuration and relay selection

```sh
shellbell status
shellbell --json status
shellbell phones
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
These settings require a restart. Restart a copy in a terminal window explicitly, use
`shellbell restart` for the background Shellbell, or the Mac app's **Restart…**
when the app runs Shellbell. The phone's per-computer **Relay URL** must agree.
New pairing QR codes carry the saved address; an empty replacement relay may need
new pairing. See [relay connection steps](self-hosting.md#connect-your-devices).

The separate **Full agent history on your phone** preference is on unless you turn it
off with `shellbell config set conversations off`, or in the Mac app's Advanced settings.
Supporting services apply this consent live, without changing other running
settings. The CLI reports whether live application was confirmed; saved consent
alone is not evidence that it changed in a running service. A compatible phone can then show a proven conversation for its focused session.
Unbound or unsupported sources stay in Terminal; see the [reader and consent boundaries](architecture/computer-agent.md).

### Coding agents

Claude Code and Antigravity sessions show their full history on the phone with no setup.
Codex and Gemini CLI need a small helper so Shellbell can tell which window each session
runs in. Shellbell offers to add it, as highly recommended, the first time it starts: the Mac app
before it enables remote access, and the CLI at the first `shellbell install`, `start` or
`run` in a terminal. It never asks without a terminal to answer.

```sh
shellbell agents                 # agents found on this computer and their status
shellbell agents setup [name]    # add the helpers (all agents that need one, or just one)
shellbell agents remove <name>   # take a helper out again
```

`shellbell doctor`, and the Mac app's Advanced diagnostics, warn about agents that still
need setup.

The Mac app and its service look for agents in their default folders (`~/.claude`,
`~/.codex`, `~/.gemini`). `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CLI_HOME` set in
a shell apply only to `shellbell` commands run from that shell, so set agents with moved
folders up from the same shell the service runs in.

Codex asks you to trust the new helper the next time it starts. Gemini runs it only in
folders you trust. Shellbell never turns on hooks you turned off, and never rewrites a
Gemini `settings.json` that has comments; it says how to finish instead. Other agents Shellbell recognises open as a terminal until their
history can be read. `shellbell integration install codex`, from 0.12.0, still works.

`SHELLBELL_DIR` selects state before first installation. Later commands use the
installed definition's directory; a conflicting explicit override is refused. Moving state is not an implicit upgrade operation. Live endpoint guards,
sockets, PID files and unknown staging entries must not be deleted to bypass
ownership errors.

## Upgrade, revoke and uninstall

Computer 0.9.0 adds manual update checks: run `shellbell update --check`
for the latest stable computer version, or `shellbell update VERSION --check` for a
specific version. `--json` gives machine-readable verified release metadata. A
check contacts GitHub only when requested; it does not download an app/archive,
create an identity or change a running service. Existing 0.8.0 installations need
one ordinary manual upgrade before this command is available.

`shellbell update` offers a confirmed archive installation on supported Linux
installs and managed Apple silicon CLI installations from computer 0.10.0.
For npm, source and Mac app installations it explains the appropriate
installation method; it does not overwrite files owned by another installer.
The Mac app adds **Settings → General → Check for Updates**, with release notes
and an explicit official-installer download link. There are no scheduled checks,
background downloads or automatic service restarts.

The headless service does not update itself, and npm installation does not enable
automatic updates.

For a managed Mac CLI installation, run `shellbell update` and confirm the
download. It checks the official DMG checksum, signature and Gatekeeper
acceptance, preserves the signed bundle and retains the old runtime. The background
Shellbell keeps running the previous version until you run `shellbell install`, which
restarts it on the new version and checks that it answers; your phone reconnects in a
few seconds. Then check `shellbell status` and `shellbell doctor`. Do not remove the
old runtime until the new one is verified.

For an npm installation on a Mac, choose the published computer version, install that
package, then switch the background Shellbell to it. Replace `X.Y.Z` with that version:

```sh
npm install --global shellbell@X.Y.Z
shellbell install
shellbell --version
shellbell status
shellbell doctor
```

`install` restarts the background Shellbell on the new version. For a source build,
rebuild, pack and install its tarball instead of the npm registry command. Installing
again updates the definition's canonical Node/CLI paths and filtered environment. Keep old
runtimes until the new service is verified. These commands are for headless
ownership; update the [Mac app](../apps/macos/README.md#install-the-published-mac-app)
through its own lifecycle. Linux has separate [archive update steps](../apps/linux/README.md#updates-and-removal).

Preserve `.shellbell`, including its identity, keys and pairings. Never recreate it
as an upgrade step.
A failed macOS replacement attempts to restore the exact prior definition and
loaded state; failed rollback reports separate recovery information. Do not reset
identity or pairings to repair a runtime problem.

While the intended service is running, identify and revoke a phone deliberately:

```sh
shellbell phones
shellbell unpair <unique-phone-fingerprint-prefix-or-name>
```

Prefer a unique fingerprint; display names can be ambiguous. Then, if retiring the
service/package:

```sh
shellbell uninstall
npm uninstall --global shellbell
```

This retains identity, pairings, configuration and logs. It is not a credential
wipe or remote revocation. Revoke clients first when retiring a computer; changing
its identity changes the fingerprint and requires pairing again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Access ends when the terminal window closes | Run `shellbell install`, or use the Mac app |
| Installed but not locally ready | Canonical runtime paths, logs, login/background approval and ownership |
| Relay online, no sessions | Enable a supported backend and open an actual exposed pane |
| Awake works, closed lid fails | Computer sleep; service supervision does not prevent it |
| Different ring behavior by backend | Prompt integration, quiet heuristic or semantic agent state |
| Screen works but no push | Permission, foreground lease, opt-in/token, provider credentials and limits |
| Final output appears stopped | The phone has already retried a few times; use Retry output and collect sanitized diagnostics if it recurs |
| Relay address changed but access fails | Both endpoints, destination pairing metadata, TLS and reachability |

Optional power controls require their own [signed/helper qualification](macos-power-helper-qualification.md).
Do not change system sleep policy merely to test the service.

# Shellbell plugins

Shellbell owns the plugin registry and installation. Providers keep their plugin
packages in their own public GitHub repositories. Sous is the first provider;
its package lives in `integrations/shellbell/` in `bilal-/sous`.

Current source includes a keyboard-driven headless browser:

```sh
shellbell plugins
```

Use arrow keys to browse, Enter to review a plugin, then **Install** or
**Uninstall**. The browser shows what the plugin adds, the required application
and its GitHub source. It requires a terminal; noninteractive use prints a plain
list. The following commands provide the same operations for scripts:

```sh
shellbell plugins list
shellbell plugins info sous
shellbell plugins install sous
shellbell plugins uninstall sous
shellbell --json plugins list
```

Install Sous separately first. Installing its Shellbell plugin fetches the
manifest and icon, locates the installed executable and saves the integration.
It does not install Sous, run `sous setup`, change Sous's data, or start a server.
Opening Sous from **Apps** on a paired Android phone starts it on demand through
[the local web host](apps.md). Uninstall removes its managed page registration; the
application and data remain. The small content-addressed icon cache can be reused
on reinstall. Removing a registration also closes its live streams and owned
server through the normal Pages watcher.

## Registry and provider ownership

Shellbell's registry is
[`registry.json`](../apps/agent/src/plugins/registry.json). Each entry names the
plugin ID, display metadata, required executable, GitHub repository, package
directory and a complete reviewed commit SHA. Providers own the manifest and
assets at that revision. Shellbell fetches only those named files using GitHub's
public repository-contents API. There is no clone, package install script,
GitHub login, background registry update or repository-wide code execution.
Normal plugin listing is offline; reviewing or installing a remote package makes
an explicit GitHub request. See the [GitHub contents API](https://docs.github.com/en/rest/repos/contents).

An updated provider package reaches users when Shellbell's registry advances to
a reviewed revision and they explicitly reinstall the plugin. Existing installed
registrations keep working offline. Uninstall does not require GitHub access.
This is the initial curated registry, not automatic discovery of arbitrary GitHub
repositories or an independently deployed marketplace.

A registry entry becomes installable after its pinned provider commit is public.
An unpublished or removed revision is reported as unavailable; no partial
registration is installed. Qualification of a particular registry revision is
tracked in the [release checklist](before-first-release.md).

## Updating a plugin

Plugin packages do **not** update automatically. The catalog is bundled with
Shellbell; installing a newer Shellbell version does not rewrite existing plugin
registrations. The current browser has Install and Uninstall actions, with no
Update action or update-available indicator. Use the CLI reinstall command below.

### For users

1. Install a Shellbell version containing the newly reviewed registry pin.
2. Review that pinned package and explicitly reinstall it. For example:

   ```sh
   shellbell plugins info sous
   shellbell plugins install sous
   ```

3. Reopen the app on the phone after the command completes. Registration changes
   can close its existing streams and retire its owned server; a Shellbell service
   restart is not required.

Running `install` again adopts the version pinned by your installed Shellbell,
not the latest commit on the provider's default branch. You do not need to
uninstall first for an ordinary managed registration. Reinstall refuses to
overwrite customized configuration; see [state and troubleshooting](#state-and-troubleshooting)
before replacing your changes. The provider's application and data remain installed.

The underlying application has its own update process. For example, update Sous
separately using its normal installer/updater. Its UI and feature changes can be
delivered by the application without changing the plugin manifest or registry
pin. A replacement executable at the registered path is used when the local
server next starts; an already running server does not automatically restart when
its binary is updated. If the executable moves, reinstall the integration to save
its new path. If an
integration needs new application capabilities, install a compatible application
version separately as well.

### For plugin authors

Publish the changed manifest/assets in your provider repository, update the
integration version to describe that package change, and
[submit a registry PR](#submit-to-the-registry) pointing to its complete new commit
SHA. Include what changed and your verification results. The reviewed pin reaches
users in a Shellbell version that includes it; users then explicitly reinstall.
Publishing a provider commit alone does not update existing installations.

Application-only changes that keep the integration contract compatible do not
require a new registry PR. A changed plugin manifest, startup arguments or icon
does require the package/pin update path above.

## Create a plugin

A plugin makes an already-installed application's web UI available under **Apps**
on a paired Android phone. You supply the local HTTP UI and its executable;
Shellbell supplies discovery, process lifetime, sign-in and encrypted transport.
No mobile screen, relay extension or Shellbell-specific frontend SDK is needed.
An ordinary localhost development preview can also open from a terminal link
[without a plugin](apps.md#open-a-preview-without-a-plugin).

1. Add a package directory to your application's public GitHub repository, for
   example `integrations/shellbell/`.
2. Add `shellbell-plugin.json` using the manifest below. Set `requires.command`
   to the installed executable's name and `page.args` to its literal server
   arguments. `page.name` is the name people see on the phone.
3. Implement the startup contract below. Keep the server in the foreground so
   Shellbell can own and stop it.
4. Test the package locally against a matching registry entry, then publish the
   provider commit and submit that entry to Shellbell for review.

The [Sous repository](https://github.com/bilal-/sous) owns a complete provider
example in `integrations/shellbell/`. A source checkout may contain changes that
are not yet published or installable from a released registry.

### Manifest

Plugin packages contain `shellbell-plugin.json` and optional PNG assets:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "version": "1.0.0",
  "name": "Example",
  "description": "A local board",
  "homepage": "https://example.org",
  "platforms": ["darwin", "linux"],
  "requires": {
    "command": "example",
    "help": "Install Example first."
  },
  "page": {
    "name": "Example board",
    "args": ["serve", "--json", "--port", "0"]
  }
}
```

The manifest is at most 16 KiB. IDs and required commands must match the registry.
The required command is a basename resolved from absolute PATH entries or the
owner's `~/.local/bin`; the saved page launch command uses the resolved absolute
path. Arguments are literal argv, never a shell script. A provider must support
[the Pages startup/sign-in contract](apps.md#server-lifetime-and-sign-in).
The plugin version describes this integration, separately from the application's
own version.

### Server startup

The command must start a foreground HTTP server on numeric loopback and print
its ready URL within 15 seconds, as a complete newline-terminated record:

```json
{"url":"http://127.0.0.1:43210/"}
```

Port `0` is useful when the application supports selecting a free port; print the
actual bound port, not `0`. Shellbell accepts a plain URL or JSON containing it.
Serve relative links and assets from that origin. A query-bearing entry URL can
establish a per-phone cookie and redirect to a query-free landing page; Shellbell
keeps that entry secret on the computer. Do not put a credential in the manifest.

The server must handle TERM and keep its children in its process group. Shellbell
shares it between viewers and stops it after the last viewer has been gone for
five minutes. The [full startup and sign-in contract](apps.md#server-lifetime-and-sign-in)
owns readiness framing, cookie handling, restart bounds and shutdown behavior.

### Optional icon

Optional `icon` has a single filename and the PNG's SHA-256:

```json
{
  "icon": {
    "file": "icon.png",
    "sha256": "<64 lowercase hexadecimal characters>"
  }
}
```

Only simple filenames are accepted, with no directory traversal. The PNG must
match the hash and Pages' 64 KiB / square / 1024-pixel bounds. Downloads are
bounded and timed out, and redirects are refused. Providers do not supply
arbitrary download URLs or executable installation hooks.

The first plugin type contributes a local web page. The existing advanced
[terminal-adapter loader](architecture/terminal-adapters.md#owner-enabled-local-plugins)
is a separate source extension point; this registry does not claim to package all
adapter types yet. The Mac UI and phone-side plugin installation are not part of
the current headless browser.

### Test a new provider locally

The current registry is curated. `--from-directory` changes where a known plugin's
package is read; it does not register a new ID. For a new provider, first add its
entry to `apps/agent/src/plugins/registry.json` in a Shellbell source checkout.
Use this shape, replacing the repository, package directory and revision with
your own values; the revision must be the full 40-character provider commit SHA:

```json
{
  "id": "example",
  "name": "Example",
  "description": "A local board",
  "command": "example",
  "repository": "your-account/example",
  "revision": "0000000000000000000000000000000000000000",
  "directory": "integrations/shellbell"
}
```

The all-zero SHA above is a placeholder, not a published revision. The registry's
ID and command must match the manifest. Install the application executable
separately and put its directory on PATH. Then build Shellbell from the repository
root with the pinned toolchain from [contributor guidance](../AGENTS.md):

```sh
pnpm install --frozen-lockfile
pnpm -F shellbell build
```

Use a disposable home for CLI package checks. In these commands, replace the
provider directory and executable directory with absolute paths on your machine:

```sh
pluginTestRoot="$(mktemp -d)"

env HOME="$pluginTestRoot" PATH="/absolute/path/to/app-bin:$PATH" \
  node apps/agent/dist/cli.js --json plugins info example \
  --from-directory /absolute/path/to/provider/integrations/shellbell
env HOME="$pluginTestRoot" PATH="/absolute/path/to/app-bin:$PATH" \
  node apps/agent/dist/cli.js plugins install example \
  --from-directory /absolute/path/to/provider/integrations/shellbell
env HOME="$pluginTestRoot" node apps/agent/dist/cli.js --json pages
```

`info` validates the package and reports the resolved executable; install writes
only the disposable home's managed registration and icon. `pages` inspects that
registration without starting the application. None of these commands starts or
restarts a service. Success means `info` reports `source.localPreview: true` and
the expected absolute executable, install succeeds, and `pages` includes your ID
without a skipped reason. Keep this installation for the phone check below.

### Verify the running app on Android

Package validation does not launch the server or prove its web UI works. Use a
dedicated test computer account or VM and a disposable Android emulator/test
installation. The normal foreground agent can discover terminals, so the test
environment must not contain personal terminal sessions or real tasks. Configure
your application with fixture data there. A temporary HOME isolates Shellbell's
files; it does not override application-specific data paths or absolute paths in
your application's configuration.

On a macOS test account, continue in the Shellbell repository with the same
`pluginTestRoot` and installed preview from above:

```sh
# Fetch and verify the pinned native transport for this computer.
node apps/agent/native/webrtc/fetch.mjs

pluginNode="$(command -v node)"
pluginNodeBin="$(dirname "$pluginNode")"
pluginCli="$PWD/apps/agent/dist/cli.js"

env -i HOME="$pluginTestRoot" \
  SHELLBELL_DIR="$pluginTestRoot/.shellbell" \
  PATH="/absolute/path/to/app-bin:$pluginNodeBin:/usr/bin:/bin" \
  "$pluginNode" "$pluginCli" run
```

Replace the executable directory as before. Supply only your provider's explicit
test configuration if it needs additional environment variables. `run` stays in
this terminal; it does not install a background service. Do not substitute
`start`, `install` or `pair` to reach an existing service. Linux test hosts also
need their isolated host state initialized; follow the
[Linux setup guide](../apps/linux/README.md).

Use an Android native test build with this feature, not Expo Go. The
[standalone local APK recipe](local-mobile-releases.md#standalone-local-android-test-apk-adb-only)
explains building one. Use a disposable device/emulator, or a separately identified
test app; keep your normal app and pairing data. Scan the foreground instance's
QR and approve the matching fingerprint in that terminal. Open that test computer
on the phone and select your integration under **Apps**.

Verify these outcomes before claiming a working integration:

| Check | Expected result |
| --- | --- |
| First open | Correct app name/icon; server reports its ready URL within 15 seconds; usable content appears |
| Internal navigation | Relative links and equivalent loopback links stay inside the preview |
| One fixture action | The expected change persists on the computer; a reload does not repeat the action |
| Live updates, if supported | A change on the computer appears without manually reopening the app |
| Disconnect and reconnect | The page becomes inactive while disconnected, recovers afterward, and live updates resume |
| App Lock and reopening | The locked view cannot accept input; unlocking/reopening restores a usable app |
| Last viewer closes | The owned server exits after the five-minute idle period; reopening starts it again |

Use only fixture actions when testing interruption and retries, and verify your
application's handling of uncertain action delivery. Shellbell does not make an
arbitrary provider action idempotent. Record the phone model/Android version,
provider commit, Shellbell source/build, checks passed and checks not run in the PR.
If you have no Android device/build available, say so; report package validation
separately rather than presenting it as phone verification.

### Clean up the test

Press Ctrl+C in the foreground Shellbell terminal. After it exits, remove the
managed preview from the same disposable home:

```sh
env HOME="$pluginTestRoot" node apps/agent/dist/cli.js plugins uninstall example
```

Then remove only the disposable test directory and test app/device data you
created. Keep normal Shellbell identities, pairings and provider data untouched.

### Submit to the registry

Keep the plugin package in your application's public GitHub repository. Then
[open a pull request to bilal-/shellbell](https://github.com/bilal-/shellbell/compare)
adding its entry to
[`apps/agent/src/plugins/registry.json`](../apps/agent/src/plugins/registry.json).
The plugin's source stays in the provider repository; the Shellbell PR adds its
reviewed catalog entry.

Include these details in the PR:

- The provider's GitHub repository and package directory.
- Its complete 40-character commit SHA, obtained with `git rev-parse HEAD`.
- The required application's installation instructions and server startup command.
- Supported platforms and the phone flows you tested.

The pinned commit must contain the manifest and every named
asset in the declared directory. It must already be publicly fetchable before
that registry revision can be installed remotely.

Shellbell reviews and pins the package. Publishing your provider repository alone
does not add it to the catalog. Future package updates need a reviewed registry
pin update; users explicitly reinstall to adopt them. The integration still
requires a separately installed compatible application binary.
The entry appears in the plugin browser when users install a Shellbell version
containing that registry change.

## State and troubleshooting

Plugins generate owner-private Pages registrations with a `shellbellPlugin`
management record under `~/.config/shellbell/apps`. All writes use the same
ownership, directory and macOS ACL trust checks as Pages. The manager never
replaces or removes an unrelated custom registration. Reinstall also preserves
customized managed configuration by refusing to overwrite it; remove the plugin
explicitly before choosing a fresh generated configuration.

If the application is missing, install it first and retry. If it moved, reinstall
the integration to save its new path. Use `shellbell pages` or `shellbell doctor`
for unsafe-directory and page startup diagnostics. No service restart is needed
for registration changes. A full Pages catalog must have a slot freed before
another plugin can be installed.

For an explicit local provider preview before publication:

```sh
shellbell plugins info sous --from-directory /absolute/path/to/provider-package
shellbell plugins install sous --from-directory /absolute/path/to/provider-package
shellbell plugins --from-directory /absolute/path/to/provider-package
```

The directory must contain the manifest and assets, pass local file trust checks,
and match the selected registry ID/command. Local previews are marked in plugin
state and output; they are not represented as downloads from the pinned GitHub
revision. Never run these commands with a real home just to test. Use a disposable
home, executable fixture and service, preserving real identities and pairings.

Tests cover offline listing, explicit review/install/remove, missing prerequisites,
pinned URLs, malformed/oversized packages, invalid icons, custom registrations,
permission refusal, cancellation and terminal mode restoration. Native Android,
real tool actions and transport/device checks remain separate qualification.

Reinstall repairs a missing managed icon without rewriting an unchanged registration;
unsafe or damaged existing files are refused. Review and install share a bounded
session cache of immutable pinned packages; local previews are reread. Customization
checks happen before remote fetch. GitHub request limits, access errors and temporary
server errors are reported separately from unpublished pins. The interactive browser
restores terminal presentation on normal quit, termination and partial setup failure.
Sous's provider package requires page API 1; update the separately installed Sous
binary when its startup guidance reports unsupported arguments. A compatible provider
commit must be published and pinned before the integration is released.

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
Opening the page from a paired Android phone starts Sous on demand through
[Pages](apps.md). Uninstall removes its managed page registration; the
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

## Provider package contract

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

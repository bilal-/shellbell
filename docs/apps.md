# Pages: local web integrations

Shellbell Pages opens a computer's loopback HTTP tools on its paired Android
phone (Android 9 or newer for the native transport). Sous is the first integration: its existing web board runs unchanged.
The source supports registered pages and confirmed localhost links from terminal
output. iOS continues to open links in the browser; its native Pages transport is
not enabled. This guide describes source behavior, not a shipped-build or device
qualification claim.

Pages uses the existing encrypted direct connection. Page bodies, form data,
WebSocket traffic, names and icons never travel through the Shellbell relay.
Losing the direct route closes page streams; Shellbell keeps trying to reconnect.
A page has the authority of the local program serving it, including any actions
that program exposes. Pair only phones you trust to use those controls.

## Register a page

Create `~/.config/shellbell/apps/<id>.json` on the computer. Shellbell deliberately
uses this fixed home-relative path rather than `XDG_CONFIG_HOME`, because desktop
and headless services may have different environment variables. The filename ID
is 1–32 lowercase letters, digits or hyphens. The agent watches for changes and
also rescans periodically. Removing a registration closes its active streams and
stops its owned process.

A tool can register an on-demand server:

```json
{
  "shellbell": 1,
  "name": "sous",
  "description": "What's waiting on you, across your projects",
  "start": ["/absolute/path/to/sous", "serve", "--json", "--port", "0"],
  "icon": "/absolute/path/to/sous.png"
}
```

A future Sous version with Shellbell registration support writes this file and
its icon during `sous setup`. Until then, create it yourself using the actual
absolute executable path. Running setup does not start a server. Sous setup
updates files it marks as managed, preserves owner customisations and leaves
unmanaged registrations alone.

For an already running tool, use a URL instead:

```json
{
  "shellbell": 1,
  "name": "Metrics",
  "description": "Local development dashboard",
  "url": "http://127.0.0.1:3000/dashboard"
}
```

`start` and `url` are mutually exclusive. `start` is an array of literal arguments,
with an absolute executable as the first element; Shellbell never invokes a
shell. Optional `cwd` is an absolute working directory for `start`. The default
working directory is the owner's home. Unknown JSON fields are ignored. Names
are limited to 40 characters, descriptions to 120, and files to 16 KiB. Control
characters are rejected. The catalog has at most 16 entries, sorted by name.

URLs must be plain HTTP on `localhost`, a `.localhost` name, `127.0.0.1` or `::1`.
Remote addresses, credentials in URLs, HTTPS and DNS-based routing are refused.
The host connects to numeric loopback addresses while preserving the intended
HTTP Host and origin behavior. A fixed URL's path and query are owner-configured
page addresses. A `start` program's query-bearing entry URL is instead treated as
a sign-in secret, as described below.

## Permissions and diagnostics

Registration is a trusted local execution boundary. The registration file,
working directory and their parent directories through the home must belong to
the current user and must not be writable by other users or groups. Ancestors
above the home may belong to root if they are not group/other writable. Symlinked
registration files are refused. A symlinked `.config` directory is resolved and
its physical parent chain is checked. On macOS, foreign write ACLs are refused
as well. A registration may be mode `0644`; its content is local configuration,
not a secret store.

Shellbell creates its own `~/.config/shellbell` and `apps` directories with mode
`0700`. It never changes the permissions of an existing `~/.config`. For example,
if that directory is group writable, diagnostics explain the problem and show
`chmod g-w ~/.config`. Review the reported path and fix the owning directory;
do not make a whole tree writable to get a page working.

```sh
shellbell pages
shellbell --json pages
shellbell doctor
```

These commands inspect registrations without launching programs or changing
permissions. Pages and doctor show skipped reasons and suggested fixes. A missing
executable is hidden from the phone catalog, so uninstalling a program removes
its page automatically. Invalid configuration remains visible with its reason.
The phone shows names, descriptions and fixed-URL addresses; it never receives
program arguments or sign-in entry URLs.

## Server lifetime and sign-in

Opening a registered page starts one server shared by all viewing phones.
The child receives `HOME`, `SHELLBELL_PAGE=<id>` and `NO_COLOR=1`, with umask `022`.
It runs in its own process group. Shellbell drains stdout and stderr for the
whole lifetime, retaining only the last 4 KiB of each in memory for bounded
startup diagnostics. Diagnostics redact HTTP addresses and are limited to 120
characters on the phone.

Within 15 seconds the program must print a loopback HTTP URL on stdout or stderr.
A JSON line such as `{"url":"http://127.0.0.1:12345/?t=secret"}` works. Shellbell
uses the first valid URL, so programs must not print an unrelated loopback URL
before their actual address. The server stops five minutes after the last viewer
leaves, or when the agent stops. Shellbell sends TERM to the group, then KILL if
it remains after three seconds. Repeated startup failures are limited to an
initial attempt and three restarts in five minutes.

For a query-bearing entry URL from `start`, the computer signs each phone in
separately. It follows only same-page redirects, stores cookies in memory and
sends a query-free landing path to the phone. Sign-in must either redirect to a
query-free successful page or return HTTP 200 with a cookie. The token is never
sent to the phone or included in Shellbell logs. Cookies are scoped to that
phone and that server instance, so stopping one page cannot sign another page
out even if both use the same loopback host.

On HTTP 401 or 403, Shellbell refreshes entry sign-in once per phone/server
instance. Only a bodyless GET can be replayed. POST and other actions retain the
original response and are never automatically repeated. When an instance stops,
its cookies and sign-in state are discarded. Fixed `url` registrations do not
use this automatic sign-in flow.

## Phone presentation and icons

The computer screen lists Pages. Opening a card creates a dedicated page view
with the registered name and icon. The computer/address line stays outside web
content. A registered page cannot rename its header through its HTML title.
Local terminal links still require the ordinary confirmation; a confirmed link
matching a registered fixed URL opens that registration.

An optional icon is an absolute path to a square PNG, at most 64 KiB and at most
1024 pixels per side. It must pass the same file and parent trust checks as the
registration. An invalid icon leaves the page usable with a deterministic letter
tile and an explanation. Icon changes are detected without restarting the
server. Only the SHA-256 hash is advertised in `hello.pages`; the phone requests
bytes separately in chunks of at most 16 KiB and verifies the complete hash.
Icons share the existing 128 KiB per-phone web connection window and are cached
only in memory, with at most 16 current images per computer.

The Android WebView talks to a native loopback door on the phone. Requests and
responses cross the direct encrypted route to the computer's HTTP proxy; the
original tool is never exposed on a public network port. App Lock, leaving the
page or losing its route closes the active door and streams. Websites may still
use ordinary external resources or links; the tool's own data practices apply.
The phone may retain ordinary WebView state under the operating system's rules.

## Verification limits

Automated tests cover registration trust, schema/size bounds, multiple viewers,
secret isolation, expiry without action replay, child-process cleanup, shared
flow credit and icon integrity. Native build and emulator checks are separate
from physical phone qualification. Before release, exercise Sous at a narrow
phone width, multiple phones, App Lock, route loss/recovery, SSE/WebSocket updates,
removing or replacing registrations and the five-minute idle shutdown on the
exact Android and computer artifacts. See the [live release checklist](before-first-release.md).

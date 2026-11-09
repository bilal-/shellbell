# Apps and local web previews

Shellbell opens a computer's loopback HTTP tools on its paired Android
phone (Android 9 or newer for the native transport). Sous is the first integration: its web board supplies the page and owns its actions.
The source supports registered pages and confirmed localhost links from terminal
output. iOS continues to open links in the browser; its native Pages transport is
not enabled. This guide describes source behavior, not a shipped-build or device
qualification claim.

Pages uses the existing encrypted direct connection. Page bodies, form data,
WebSocket traffic, names and icons never travel through the Shellbell relay.
Losing the direct route closes page streams; Shellbell keeps trying to reconnect.
A page has the authority of the local program serving it, including any actions
that program exposes. Pair only phones you trust to use those controls.

## Compatibility and independent updates

The phone and computer negotiate Apps support through the `web-v1` capability.
A newer Android phone can still use an older supported secure-v2 computer
service for terminals and chat; Apps stays hidden, and opening a localhost
preview asks for a computer update. An older supported phone can still use a
newer service for its existing features; it ignores the additional app catalog
and does not gain an Apps screen. Apps requires compatible phone and computer
versions. Its transport uses the existing encrypted direct route and does not
require an Apps-specific relay deployment.

Once both ends support Apps, a plugin that follows the existing registration,
startup and web transport contracts needs no provider-specific service or phone
code. The computer watches registration changes without a service restart.
Compatible changes to a registered application's web UI can therefore work
without a Shellbell update.

The plugin catalog is bundled with Shellbell rather than fetched remotely. A
new catalog entry or reviewed package pin reaches users in a Shellbell version
that includes it. Installation and package updates remain explicit; see
[plugin updates](plugins.md#updating-a-plugin). Owner-created registrations do
not require a catalog entry.

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
  "start": ["/absolute/path/to/sous", "serve", "--json", "--port", "0", "--page-api", "1"],
  "icon": "/absolute/path/to/sous.png"
}
```

For Sous, install the application first, then use `shellbell plugins` to select
and install its integration. Shellbell's registry points to the plugin package
in Sous's GitHub repository. The package supplies the manifest and icon;
Shellbell resolves the installed executable and manages this registration.
`sous setup` does not register it implicitly. See [plugins](plugins.md).

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
working directory is the owner's home. Optional `startHelp` supplies up to 120 characters of startup guidance; plugin packages use it for prerequisite updates. Unknown JSON fields are ignored. Names
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

Opening a registered page starts one server shared by viewing phones. The child
receives `HOME`, `SHELLBELL_PAGE=<id>` and `NO_COLOR=1`, with umask `022`, in its own
process group. Output is drained for its lifetime with bounded 4 KiB records on
stdout and stderr. Startup diagnostics redact HTTP addresses and are limited to
120 characters on the phone. Oversized diagnostic records are discarded whole.

Within 15 seconds the program must print a complete loopback HTTP URL, terminated
by a newline or deliberate EOF. JSON lines and pretty JSON with a complete quoted
URL on one line work. Quoted URLs require a closing quote. A parseable partial port
is not readiness. Shellbell uses the first valid URL; do not print unrelated
loopback addresses before the actual server address.

The server stops five minutes after its last viewer leaves, or when the agent
stops. Shellbell sends TERM, then KILL if the group remains after three seconds,
with a bounded wait to confirm exit. Replacement waits for the old group to retire
and is refused if ownership cannot be confirmed as ended. Startup failures are
limited to the initial attempt and three restarts in five minutes. Managed plugins
can supply `startHelp` to explain prerequisite updates when startup fails.

For a query-bearing entry URL from `start`, the computer signs each phone in
separately. It follows only same-page redirects, stores cookies in memory and sends
a query-free landing path to the phone. Sign-in must either redirect to a query-free
successful page or return HTTP 200 with a cookie. The entry URL stays on the computer.
Cookies are scoped by phone and server instance. On HTTP 401 or 403, Shellbell
refreshes sign-in once per phone/instance. Only a bodyless GET may be replayed;
POST and other actions retain their original response. Fixed `url` registrations
use an owner-configured address and do not use automatic entry sign-in.

## Phone presentation and icons

Each computer screen has **Agents** and **Terminals** tabs, plus **Apps** when that
computer advertises at least one supported registered app. App cards appear only
inside Apps. The last selected tab is remembered separately for each computer.
An app-only computer opens in Apps when there is no saved choice; a saved Apps
choice falls back to Agents or Terminals while no apps are available. An app
advertised as unavailable stays in the list with its reason and suggested fix;
it cannot be opened until that problem is resolved.

The Apps tab lists registered tools vertically. Opening a card creates a
dedicated view with the registered name and icon, with no address subtitle taking
space above the app. A registered app cannot rename its header through its HTML title.
The underlying registration and `shellbell pages` diagnostic command keep their names.
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
original tool is never exposed on a public network port. App Lock or leaving the
page closes its door and streams. A transient route loss cancels streams while
retaining the visit behind a cover until reconnection, as described below. Websites may still
use ordinary external resources or links; the tool's own data practices apply.
The phone may retain ordinary WebView state under the operating system's rules.

## Open a preview without a plugin

Run a development server on the paired computer, then tap its local HTTP link in
terminal output or an agent conversation, for example `http://localhost:3000/`.
After the confirmation, Android opens it inside Shellbell. The server does not
need a plugin or an Apps registration; it stays owned by whatever started it.

Relative links navigate inside the same preview. Absolute links to an equivalent
loopback name and port stay in that view too, when they identify the same server.
A link to another local server asks for confirmation before opening its own view.
Ordinary public links open in the external browser.

This preview path supports HTTP on `localhost`, `.localhost`, `127.0.0.1` and
`[::1]` on the computer. HTTPS loopback addresses are not supported yet, and the
computer-side proxy does not fetch private LAN or intranet hosts. Ordinary
previews retain an address/computer subtitle because their HTML can choose its
own title; registered Apps use their installed name and icon instead.

## Verification limits

Automated tests cover registration trust, schema/size bounds, multiple viewers,
secret isolation, expiry without action replay, child-process cleanup, shared
flow credit and icon integrity. Native build and emulator checks are separate
from physical phone qualification. Before release, exercise Sous at a narrow
phone width, multiple phones, App Lock, route loss/recovery, SSE/WebSocket updates,
removing or replacing registrations and the five-minute idle shutdown on the
exact Android and computer artifacts. See the [live release checklist](before-first-release.md).

## Recovery and request lifetime

A phone-only lock or quiet refusal preserves the route's stream sequence and credit.
Already transmitted bytes stay charged until acknowledged; unsent work is cancelled.
A response remains counted against the 24-stream budget while its final bytes wait
for credit, with a draining timeout. An early response cancels an unfinished upload;
HTTP keep-alive parsing resumes without retaining the old sending half.

A transient disconnect or quiet period cancels active door requests while retaining
the visit's loopback origin, cookies and local storage. The renderer is covered and
cannot accept input. Each new route re-announces its view before sending requests;
recovery reloads the same origin, preserving provider operation IDs. App Lock or
leaving the page still ends and clears the visit. Native HTTP EOF means WebView
cancellation; upgraded WebSocket connections preserve write-half-close semantics.
Providers own application retries and must distinguish definite refusal from unknown
delivery. An upstream 503 can pass through unchanged; Shellbell does not promise
that every HTTP 503 means a request was never forwarded.

Sous's package selects `serve --page-api 1`. Update Sous separately if the binary
does not support it. Its first cache uses an explicit **Load board** action; page
open and event reconnect do not start provider queries. Builds are bounded, single
flight, owned by the Sous server and never enter the automatic action retry queue.

Permission checks reuse unchanged identity/ctime metadata and cached ACL results,
invalidating them on watcher events or metadata changes. Requests check that
metadata before reusing a catalog, and periodic scans still detect missed events.
A scan does not rewrite an unchanged directory mode. Process replacement waits for
confirmed bounded group retirement; shutdown retains the agent's existing budget.
The native cipher self-check covers offsets, empty/maximal frames, nonce changes and
bad tags. Native plaintext is copied out only after authentication and exact-length
validation; startup logs the selected cipher. JVM checks do not qualify API 28 devices.

# Extensibility and architectural work

Shellbell separates terminal adapters, session routing, encrypted transport and
relay runtime policy. Current source supports owner-enabled local ESM terminal
adapters and an additive capability catalog. That is a trusted local extension
point, with explicit limits; it is not an extension sandbox or marketplace.

## Supported integrations

macOS constructs iTerm2, tmux and Herdr adapters; Linux constructs tmux. Both can
load configured local plugins. On macOS, the phone can request a new tmux or
Herdr session in Ghostty or iTerm2, even without an open window. Ordinary Ghostty
and other terminal-app tabs outside tmux remain inaccessible through this path.
See [terminal adapters and desktop windows](terminal-adapters.md).

## Extension boundaries

| Change | Existing seam | Additional work required |
| --- | --- | --- |
| Terminal session engine | Local `TerminalAdapterPlugin`, bounded catalog and prefixed routing | Native implementation, static capabilities, ownership/history/events and platform qualification |
| Desktop window app | `TerminalWindowLauncher`, hosted-launch registry | Safe local command construction, cold startup, permissions and GUI tests; not loadable through plugin v1 |
| Shell inside a session | Cell capture and input without choosing the shell | Shell integration, attention semantics, Unicode and input qualification |
| Relay runtime | Runtime-independent core with repository, transport and scheduler ports | Atomic operations, ownership, queue accounting, recovery and deployment qualification |
| Database | Atomic domain repository operations | Serializable budgets/claims, revocation precedence and fencing; not a generic CRUD substitution |
| WebRTC engine | `NativeDirectPeer` / `NativeDirectFactory` | Live certificate verification, native packaging, permissions, notices and devices |
| Different direct protocol | Authenticated endpoint and route coordinator | New signaling/identity binding and wire profile; the current seam is SDP/ICE/DTLS WebRTC |
| Host OS | Shared agent with platform state/lifecycle adapters | Identity, private IPC, manager policy, native packaging and platform qualification |
| Notification provider | `NotificationProvider` with classified outcomes | Destination schemas, client enrollment, native receiver, privacy and retries |
| Desktop as remote client | Shared protocol package | New role/UI, identity storage, pairing and terminal presentation; not implemented |

## Strong boundaries to preserve

Applications depend on `packages/protocol`, rather than another application's
implementation. The relay routes ciphertext and does not need a terminal name
or native API. Its core has no Node, Workers, SQL-driver or application imports.
Runtime adapters implement complete atomic domain operations. Keep provider I/O
outside transactions and preserve generation fencing. The
[boundary guard](../../scripts/check-relay-boundaries.mjs) and shared
[conformance fixtures](../../packages/relay-core/test-support/README.md) protect
these relay boundaries.

The secure-v2 endpoint owns identity binding, Noise confirmation and route commit.
Native adapters own WebRTC operations. Changing an engine must preserve live
certificate checks; SDP alone does not establish trust. xterm.js is the mobile
presentation boundary, not another transport.

Desktop ownership, launchd headless ownership and systemd-user ownership have
different consent and recovery semantics. A common inspection model must not
turn them into interchangeable supervisors or silently adopt another owner.

## Backend catalog and compatibility

`BackendNameSchema` accepts bounded namespace IDs; `BuiltinBackendNameSchema`
owns the three built-in names and their legacy ordering. Extra registered names
are discovered, routed and reported in sorted order. The phone consumes labels
and capabilities from `hello.backendCatalog`, rather than adding a terminal
name for every plugin. Swift and TypeScript share native status fixtures that
allow bounded, sorted additional adapters.

The catalog has 32 entries and hosted launches have 64 engine/host pairs. Legacy
hello lists retain built-ins and their four-entry bound. Old phones keep built-in
creation; new phones also support catalog-driven creation and host choices.
Unknown names still require an explicit validated catalog before creation. The
relay receives no new plaintext terminal metadata.

These additions preserve existing fields. `SessionInfo` still contains
Mac-origin presentation fields (`windowNumber`, `tabId`, `paneIndex`,
`isFocusedOnMac`); a plugin must project its native model onto them. Do not rename
wire fields without a compatibility plan.

## Failure isolation and shutdown

Registry listing gives each adapter a deadline, returns healthy results and
fences replies if membership changes. Replacement and shutdown retire event
subscriptions before cleanup. Every close is bounded independently; a failing
adapter does not keep other memberships registered.

The local plugin facade validates responses and events, bounds pending native
calls, retires timed-out generations and waits for unfinished native work before
reconnect. Startup abort closes late factory results. These are asynchronous
bounds: trusted in-process JavaScript can still block the event loop, access
local secrets or perform a mutation before its acknowledgement is lost. A hung
native promise can require restarting the service. See the
[plugin contract](terminal-adapters.md#owner-enabled-local-plugins).

## Remaining adapter constraints

Plugin v1 capabilities are static after construction. Built-in capabilities may
change with native health; hello refreshes advertise those changes and the phone
removes unavailable actions. A plugin needing new capability semantics requires
a deliberate contract change, rather than silently mutating its facade.

Host/guest duplicate suppression uses neutral relationship hooks. Legacy
terminal-specific helpers remain on built-in adapters for their own callers;
plugin v1 does not expose them. The aggregate router implements terminal
operations without impersonating a named backend.

The phone still infers Herdr cursor quality from its session prefix. New adapters
with inferred cursors need a shared presentation trait before that distinction
can be fully catalog-driven. Private notification-facts hooks are also outside
plugin v1; generic attention events remain available. These are explicit
constraints, rather than full native feature parity for every future adapter.

New desktop-window hosts require a service-side `TerminalWindowLauncher`; plugin
v1 loads session adapters and their own startup operations. Extending hosted
launches to third-party hosts needs an explicit safe host contract and GUI tests.

## Verification

Source suites cover catalog bounds, extra-adapter discovery/routing, stale
callbacks and replies, hung listing, rejecting cleanup, plugin startup abort,
malformed output and phone launch choices. Shared fixtures cover the native
status and saved-configuration twins. Real app permissions, exclusive native
controllers, desktop GUI launches and device operation remain qualification work.
Use disposable sessions and keep live terminal tests opt-in.

## Relay heartbeat admission

**Priority: bound the Node heartbeat path before public hosting.**

The Node [connection adapter](../../apps/relay-node/src/connection.ts) replies to
literal text `ping` before calling core message admission. It reserves/refunds
queue credit but does not charge the core's 60/s, burst-200 application bucket.
A disposable socket probe received 300 immediate replies without a core rate check.
This establishes the bypass, not a measured production denial-of-service result.

Cloudflare handles its configured text heartbeat through platform auto-response;
Node processes it in application code. Queue ceilings and authentication deadlines
are not a rate limit for cheap repeated replies. Add bounded per-connection heartbeat
admission without breaking ordinary foreground keepalive, and test floods,
unauthenticated sockets, shutdown and application-message accounting. Keep edge
upgrade/flood protection separate.

## Release contract consistency

The [version policy](../versioning.md) and [Linux downloader](../../apps/linux/install.sh)
use `shellbell@X.Y.Z` for computer releases. Mac packaging requires a reserved
candidate build number and derives its marketing version from the bundled service.
Version checks validate component tags; packaging tests cover native metadata and
candidate-number drift.

Public archive/checksum retrieval and signed Mac distribution remain qualification
gates. Source checks do not establish that release assets are published or usable.

## Herdr marketplace integration

Shellbell's Herdr backend currently integrates terminal sessions; it does not
ship a Herdr plugin manifest. A plugin can provide installation/status guidance
and phone pairing while reusing the installed Shellbell service and protocol.
It needs no second relay, notification provider or cryptography implementation.

Herdr's [marketplace index](https://herdr.dev/docs/marketplace/) discovers public
GitHub repositories carrying the `herdr-plugin` topic and a valid
`herdr-plugin.toml` on their default branch, either at the root or in a
subdirectory. A manifest under `plugins/herdr/` would support installation with
`herdr plugin install owner/repo/plugins/herdr`. Repository publication and adding
the discovery topic belong to the explicit public-launch work.

Follow the [plugin contract](https://herdr.dev/docs/plugins/) for action argument
arrays, runtime context and separate plugin configuration/state directories. A
Shellbell launcher should require a compatible installed CLI. It must preserve
Mac app versus headless service ownership, check that the intended service is
running and avoid creating a second daemon. A startup hook is a one-shot command,
not a replacement for the service supervisor.

Use a private popup pane for pairing, so a QR code or pairing secret does not enter
an action's retained stdout log or ordinary mirrored terminal. Keep doctor/status
actions free of secrets. Do not depend on an unpublished npm package or download
unverified executables during installation.

Initially advertise macOS only: the current Linux agent construction supports
tmux, while the Herdr service path still needs Linux implementation and device
qualification. Set the plugin's minimum Herdr and Shellbell versions from tested
contracts. Test installation, pairing, reload/uninstall, a stopped service and
both Mac-owned and headless lifecycles before publishing a manifest. A marketplace
listing does not itself qualify security or store/device behavior.

# Extensibility and architectural work

Shellbell has useful extension boundaries, especially the relay core and shared
protocol. Adding a terminal backend is possible, but it currently requires
coordinated edits across the service, wire schemas, mobile UI and native controller.
There is no loadable plugin system. This page describes current constraints and
recommended changes, not completed refactors.

## Supported integrations

The macOS service constructs iTerm2, tmux and Herdr adapters. Linux starts only
tmux. Ghostty, Warp, Terminal.app, Alacritty, Kitty and WezTerm can host tmux
sessions; they do not have separate native Shellbell adapters. An ordinary tab
outside tmux is not discovered through the tmux backend. See
[backend semantics](computer-agent.md#terminal-backends).

## Extension boundaries

| Change | Existing seam | Additional work required |
| --- | --- | --- |
| Terminal backend | `TerminalBackend`, registry routing and prefixed session IDs | Catalog, construction, native status, capabilities, presentation and conformance |
| Shell inside a session | Backend captures cells and sends input without choosing the shell | Shell integration and attention semantics differ; qualify input and Unicode |
| Relay runtime | Runtime-independent core with transport, repository and scheduler ports | Atomic operations, ownership, queue accounting, recovery and target deployment |
| Database | Domain repository operations | Serializable budgets/claims, revocation precedence, detached reads and fencing; not a CRUD substitution |
| WebRTC engine | Shared `NativeDirectPeer` / `NativeDirectFactory` boundary | Live certificate verification, native packaging, permissions, notices and devices |
| Different direct protocol | Authenticated endpoint and route coordinator | New signaling/identity binding and wire profile; the current seam is specifically SDP/ICE/DTLS WebRTC |
| Host OS | Shared agent with platform-specific state and lifecycle adapters | Host identity, private IPC, manager policy, native dependency packaging and platform qualification |
| Notification provider | `NotificationProvider` with classified outcomes | New destination schemas, client enrollment, native receiver, privacy and retry semantics |
| Desktop as a remote client | Protocol package can be shared | A new client role/UI, identity storage, pairing flow and terminal presentation; not implemented |

## Strong boundaries to preserve

Applications depend on `packages/protocol` rather than another application's
implementation. A static scan of local TypeScript imports across the agent, mobile,
relay, relay-node, protocol and relay-core found no cross-application imports or
relative-import cycles. This scan excludes generated, native and third-party code;
it does not prove the absence of all runtime coupling.

The relay never needs a terminal-backend name to route ciphertext. Its core has
no Node, Workers, SQL-driver or application imports. Runtime adapters implement
complete atomic domain operations rather than a generic SQL executor. The
[boundary guard](../../scripts/check-relay-boundaries.mjs) and shared
[conformance fixtures](../../packages/relay-core/test-support/README.md) protect
that separation. Keep provider I/O outside transactions and preserve generation
fencing when changing runtimes.

The shared secure-v2 endpoint owns identity binding, Noise confirmation, route
commit and failure handling. Native adapters own WebRTC operations. Swapping an
engine must preserve those security checks; it must not infer trust from SDP alone.
The local xterm.js bridge is a presentation boundary, not another transport.

Host lifecycle policy is deliberately platform-specific. Desktop ownership,
launchd headless service ownership and systemd-user ownership are different.
A common inspection model can describe them, but a universal manager must not
silently erase consent, startup or recovery semantics.

## Backend catalog and native contract

**Priority: address before adding another backend.**

[`BackendNameSchema`](../../packages/protocol/src/inner.ts) lists three names.
[`BACKEND_ORDER`](../../apps/agent/src/backends/registry.ts) repeats them with
`satisfies readonly BackendName[]`. That checks each entry but does not require
every enum member to appear. A future accepted name can route through the registry
while remaining absent from discovery and status if the order is not updated.
A synthetic fourth-backend probe reproduced this omission.

Construction in [`cli.ts`](../../apps/agent/src/cli.ts), doctor diagnostics, mobile
labels and native status parsing also contain backend-specific choices. The Swift
[`LocalStatus`](../../apps/macos/Sources/ShellbellCore/Protocol.swift) validator
requires exactly the three current names in order. Adding a fourth status row
without changing that contract rejects the whole snapshot. Strict validation is
valuable; making it permissive is not the remedy.

Introduce one exhaustive backend descriptor catalog for shared names and traits,
plus a host-side factory catalog for platform availability and construction.
Generate or cross-check the Swift status fixtures and mobile labels from that
contract. Keep protocol parsing bounded and make catalog changes deliberate
compatibility changes. Relay policy should remain untouched.

## Installed backends and startup

Connected adapters and installed launchers are separate registry entries. A launcher
advertises availability without opening a terminal. The phone's session picker
offers a startup action only for a supported backend advertised by the computer;
unknown future backend names can be displayed but cannot become strict creation
commands. See [computer startup behavior](computer-agent.md#starting-a-terminal-from-the-phone).

The current launchers cover iTerm2 on macOS, compatible tmux, and Herdr's headless
server on macOS. They use fixed arguments and installed software. New backend
integrations still require protocol and mobile support; this is not an arbitrary
program launcher or a plugin loading interface.

## Failure isolation and shutdown

**Priority: harden before allowing third-party adapters.**

[`BackendRegistry.listSessions()`](../../apps/agent/src/backends/registry.ts)
catches rejection but awaits all backend lists without a registry-owned deadline
or cancellation contract. A never-settling backend therefore prevents healthy
session results from being returned. Current adapters have bounded native requests;
this is a missing interface guarantee, not evidence of a live installed-backend hang.
A held-promise fake reproduced the shared stall.

`close()` clears history bookkeeping, then awaits all backend closes before
removing subscriptions and membership. One rejecting close skips that cleanup.
A failing fake reproduced a registered backend and live event subscription after
shutdown rejection. Agent process-exit deadlines do not make this registry contract
safe for reuse or replacement.

Detach membership and subscriptions synchronously, then settle the captured
adapters with bounded cleanup and sanitized failure reporting. Define deadlines,
AbortSignal support and stale-result fencing for list/capture/history operations.
Add shared adapter tests for a hung list, rejected close, late callback,
disconnection and recovery. Do not claim cancellation if a native operation cannot
actually be stopped; retire its generation instead.

## Capability changes

[`broadcastHelloIfBackendProfilesChanged()`](../../apps/agent/src/agent.ts) compares
connected names and advertised capability values, with stable ordering. A
capability change sends a complete hello while an equivalent profile does not.
Initial and refreshed messages share one builder, preserving notification
features, installed terminal launchers and host metadata. Encrypted integration
tests cover capability-only changes and backend disconnection.

Herdr's optional mouse capability depends on a matching native CLI/server.
The mobile view clears Mouse mode when that capability becomes unavailable.
Dynamic adapter replacement still needs retirement of old asynchronous work;
advertisement does not establish lifecycle safety by itself.

## Backend details in shared models

**Priority: refactor as the next backend requires it.**

[`TerminalBackend`](../../apps/agent/src/backends/types.ts) includes `tmuxWindowIds`,
`tmuxWindowIdOf`, `hostJob` and a synthesized-history counter hook. The registry
contains concrete iTerm2/tmux/Herdr duplicate-host rules and implements the backend
interface using an iTerm2 name even though it aggregates backends.

The wire `SessionInfo` also requires Mac-origin fields such as `windowNumber`,
`tabId`, `paneIndex` and `isFocusedOnMac`. Mobile infers Herdr cursor quality from
the session-ID prefix in [`backends.ts`](../../apps/mobile/src/util/backends.ts).
These choices make a new backend provide synthetic presentation fields and update
name-based policy.

Separate aggregate terminal operations from a named adapter. Represent host/guest
relationships and cursor quality as bounded traits, then project a neutral internal
session model onto the existing wire shape. Preserve existing wire fields until a
versioned migration is justified. Avoid adding a speculative plugin framework or
renaming protocol fields merely for style.

## Forward compatibility is bounded

Unknown backend names can pass the phone's
[loose parser](../../packages/protocol/src/loose.ts) as bounded strings and receive
a fallback label. Generic viewing/input can use opaque session IDs. The phone's
strict `asBackendName` check deliberately suppresses creation for unknown backends.
Do not describe this as complete plugin compatibility.

Both strict and loose hello schemas allow at most **four** backend descriptors.
A fifth descriptor fails parsing, even when every name is individually acceptable.
A synthetic five-descriptor probe confirmed that bound. New message types, native
status rows and creation actions also need an explicit compatibility plan.

Add a compatibility matrix for old/new agent, phone and native controller builds.
Keep bounds, reject ambiguous input and use advertised capabilities for new behavior.
An enum extension alone is insufficient.

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

## Implementation order and verification

1. Harden registry retirement and bounded failure isolation.
2. Make backend catalogs exhaustive and native/mobile fixtures consistent.
3. Define capability change semantics and test same-name replacement.
4. Extract neutral session traits when adding a backend with different geometry
   or host relationships; keep the existing wire projection compatible.
5. Add a shared backend conformance suite, then qualify an additional adapter on
   its actual platform. Use opaque IDs, fake providers and disposable state in
   source tests; live terminals remain opt-in.

The findings above were checked against source and disposable fake-backend,
capability and schema probes. Existing registry, backend, protocol, mobile and
native-contract suites cover many current behaviors; they do not establish that
these extension gaps are fixed. Source review also does not replace independent
cryptographic review or target-host/device qualification.

For a relay runtime, follow [adapter qualification](../relay-adapters.md#adapter-qualification)
instead of the backend sequence. For broader product roles, design pairing scope,
consent and revocation before reusing endpoint code. The Mac app currently controls
its local service; remote-computer client mode remains an idea.


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

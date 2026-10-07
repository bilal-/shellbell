# Terminal adapters and desktop windows

Shellbell shares sessions that its computer service can read and control. A
session engine and the app displaying it are separate choices. tmux owns panes;
Ghostty can display those panes. Herdr owns workspaces and terminals; iTerm2 or
Ghostty can display a Herdr terminal. Ghostty itself does not run inside iTerm2.

## Built-in launch choices

On macOS, current source offers engine-only sessions, native iTerm2 sessions,
and these desktop-window targets when their prerequisites are installed:

| Desktop app | Session engine | Result |
| --- | --- | --- |
| Ghostty | tmux | A new independent tmux session attached in a Ghostty window |
| iTerm2 | tmux | A new independent tmux session attached in an iTerm2 window |
| Ghostty | Herdr | A new Herdr workspace's first terminal attached in Ghostty |
| iTerm2 | Herdr | A new Herdr workspace's first terminal attached in iTerm2 |

No existing session or open terminal window is required. tmux needs version 3.2
or newer. iTerm2 needs its Python API enabled and approved locally. Herdr terminal
attachment requires matching CLI/server versions, currently gated at 0.9.3 or
newer. Linux currently offers tmux without a desktop-window launcher.

Herdr attachment displays the chosen terminal, rather than its full dashboard.
Herdr's direct attach client occupies its exclusive terminal controller; native
mouse requests from the phone can be busy while that desktop attachment owns it.
Shellbell does not take over another controller automatically.

Ordinary standalone Ghostty tabs remain outside discovery. Ghostty's current
automation does not supply the full screen, history and input contract required
by this integration. Starting a shell inside tmux makes that session accessible;
installing tmux alone does not expose existing ordinary tabs.

The service creates a new session through the engine API and starts a fixed
local attach command. It never types a launch command into an existing shell.
Ghostty uses a separate background application instance with an initial command;
subsequent windows retain the user's normal command configuration. iTerm2 uses
session-only profile overrides. Neither launch changes the user's config file.
See [Ghostty's command options](https://ghostty.org/docs/config/reference#initial-command)
and [iTerm2's window API](https://iterm2.com/python-api/window.html).

These flows have source tests. Desktop GUI launch, permissions and phone-driven
operation still need qualification on the exact installed builds. See the
[release checklist](../before-first-release.md).

## Discovery and routing

The service advertises enabled adapters in encrypted `hello.backendCatalog`:
their bounded ID, label, capabilities, connection health and cold-start
availability. `hello.sessionLaunchTargets` advertises engine/desktop-app pairs.
The phone chooses only advertised targets. The relay routes these encrypted
messages without knowing which terminal API implements them.

IDs match `[a-z][a-z0-9-]{0,31}`. The catalog has at most 32 entries, including
the three built-ins. Launch targets have at most 64 distinct engine/host pairs.
Session IDs use `adapter:native-id`; the registry strips the adapter prefix at
the native boundary. Adapters must reject unknown native IDs and cross-session
targets. Capability flags control which actions the phone offers.

The service lists sessions from every registered adapter. Optional
`hostedProcess`, `representedWindows` and `nativeWindowIdOf` hooks describe
host/guest duplicates without putting terminal-specific decisions in the
registry. Missing relationship data leaves a session visible.

Legacy `hello.backends` and `hello.launchableBackends` contain only built-ins,
retaining their four-entry wire bound. New phones prefer the additive catalog;
older phones retain built-in creation and may show unfamiliar sessions using
their existing loose parser. Old phones do not get the new host picker. Native
local status keeps the first three built-in rows in order and appends sorted,
unique plugin rows. TypeScript and Swift validate the same fixtures.

## Owner-enabled local plugins

The computer service can load local ESM terminal adapters. This is a trusted-code
extension point: a plugin runs with the service user's privileges and can see
plaintext terminals and local secrets. It is not a sandbox or an automatic
extension marketplace. Install only code that the computer owner trusts.

Stop Shellbell through its owning controller or headless service manager before
editing `config.json`. Preserve all existing fields and add `terminalPlugins`,
an array of canonical absolute paths to `.mjs` entry points. For example, use
`/home/example/.config/shellbell/adapters/example.mjs` on a matching Linux host.
Entry files must be regular, owner-owned, `0600`, not symlinks, and at most
256 KiB. Keep their parent directories and imported dependencies private too;
the loader validates the entry file, not its whole dependency tree. Restart
through the same owner. Pairing keys and identity do not need replacement.

A module's default export follows
[`TerminalAdapterPlugin`](../../apps/agent/src/backends/plugin.ts):

```js
import { createBackend } from "./implementation.mjs";

export default {
  apiVersion: 1,
  id: "example",
  label: "Example Terminal",
  platforms: ["darwin", "linux"],
  hostCommands: ["example-terminal"],
  create({ log, signal }) {
    return createBackend({ log, signal });
  },
};
```

`implementation.mjs` is the adapter author's implementation, not a Shellbell
package. There is no separately published plugin SDK. The returned backend's
`name` must equal the manifest ID. Built-in IDs are reserved; duplicate plugin
IDs are refused. `hostCommands` optionally identifies executable basenames for
host/guest duplicate suppression. It never authorizes executing those names.

The backend implements the documented `TerminalPluginBackend` interface:

| Contract | Responsibility |
| --- | --- |
| `capabilities`, `isConnected` | Static v1 capabilities and current native transport health |
| `connect`, `close`, `on` | Native connection lifecycle, cleanup and removable event subscription |
| `listSessions` | At most 500 unique native session IDs and complete `SessionInfo` fields |
| `getScreen`, `getHistory` | Bounded styled cells, cursor and scrollback; every viewport row is present |
| `sendText`, `createSession`, `focus` | Session ownership checks and native operations; throw for unsupported actions |
| Optional `sendInput`, `paste`, `clickMouse` | Required when the corresponding capability is advertised |
| Optional `getHistoryPage` | Capture-bound history; return unsupported when a stable capture cannot be provided |
| Optional `setWatched`, `setReported` | Viewer demand and synthesized-history numbering |
| Optional `launch`, `canLaunch` | Explicit cold startup; ordinary discovery must not open an app |

Cold session startup requires `createSession: true`; a read-only adapter's launch
hook is not offered or invoked through the session picker.

Native IDs must fit in the 128-character prefixed wire ID and contain no ASCII
control characters. Events carry native IDs, never prefixed IDs. Screen rows,
columns, lines and history pages are validated against protocol bounds. An
opaque `historyCapture` stays in process; the adapter owns its validity and must
honor the history request's abort signal and acknowledged capture. Legacy
terminal-specific relationship hooks and private notification-facts hooks are
not part of plugin v1. Generic attention events can still trigger notifications.

The facade limits each plugin to four pending native calls with five-second
asynchronous deadlines. Timed-out work retains its permit until it actually
settles. Its replies are retired and reconnect waits for pending native calls;
a permanently stuck call needs a service restart. Discovery retries every ten
seconds. Registry listing has its own deadline and discards replaced-member
results. Shutdown detaches subscriptions and membership before bounded cleanup.

These bounds cannot interrupt synchronous JavaScript or undo a native mutation
that already started. Plugin hooks must return promptly, support cancellation
where their native API permits it, sanitize diagnostics and release resources on
`close` or startup abort. A missing acknowledgement can mean a session exists;
check discovery before retrying. Plugins must not expose arbitrary remote command
execution beyond the paired terminal-control contract.

New native desktop-window hosts currently use `TerminalWindowLauncher` and the
host registry in the service. Local plugin v1 adds session adapters, including
their own cold-start operation; it does not install new generic desktop-window
hosts. Adding a host requires its own safe launch implementation and tests.

## Verification

Use fake providers first: protocol catalog bounds, registry routing/retirement,
malformed adapter responses, timeout isolation, startup cancellation, phone
creation choices and shared native status fixtures. Keep real terminal tests
opt-in and use disposable sessions. Qualify actual app versions, signing,
permissions, history and device interaction separately before advertising a
new integration as released.

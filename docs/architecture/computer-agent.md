# Computer service and terminal backends

The TypeScript service runs as the OS user who owns the terminal sessions. It
handles discovery, capture, input, pairing and encryption. The phone continues
those sessions; the relay never runs a shell. See [installation](../install-agent.md)
for commands and [extensibility](extensibility.md) for remaining interface gaps.

## Process and module ownership

| Module | Responsibility |
| --- | --- |
| `cli.ts`, `config.ts`, `identity.ts` | Startup, validated configuration and persistent identity |
| `host-*`, `service-ownership*` | Host/user state admission and desktop/headless ownership |
| `control-*` | Private Unix socket, bounded local framing, runtime-bound mutations and consent |
| `agent.ts` | Session bootstrap, request dispatch, acknowledgements and pairing-scoped outcome ledgers |
| `backends/registry.ts` | Prefixed IDs, backend routing and known host/guest duplicate suppression |
| `backends/{iterm2,tmux,herdr}` | Native terminal integrations |
| `screen-tracker.ts`, `agent-screen-stream.ts` | Viewer demand, capture generations, snapshots/diffs, history and delivery budgets |
| `events.ts`, `notifier.ts`, `notification-*` | Attention policy, recipient enrollment and private context |
| `pairing.ts`, `phone-link.ts`, `paired-requests.ts` | Pairing, fresh encrypted links and bounded request outcomes |
| `relay-client.ts`, `direct-peer.ts` | Outbound relay connection and native direct transport |
| `native/`, `service-*`, `systemd-*` | Controller bridge and platform-specific lifecycle |

Sources live in [`apps/agent/src`](../../apps/agent/src). macOS startup constructs
all three backends; Linux constructs only tmux. Backend discovery does not block
relay startup. Missing backends can reconnect and become available later.
Relay reconnect uses jittered backoff of roughly one to thirty seconds, with
protocol pings every 45 seconds and a ten-second pong timeout.

Relay loss retires relay-owned links and their viewer work. A committed secure-v2
direct route can survive relay interruption; losing that direct route requires
fresh relay bootstrap. Endpoint and capture generations fence late callbacks.
A newer authenticated agent connection supersedes its predecessor.

## Terminal backends

All three current macOS adapters support listing, screen capture, history, input
and session creation. Capabilities are advertised rather than inferred from the
terminal app hosting the shell.

| Behavior | iTerm2 | tmux | Herdr |
| --- | --- | --- | --- |
| Transport | Local native API/protobuf | Local UTF-8 `tmux -u -C` control client and commands | Local Unix socket with NDJSON RPC/events |
| Setup | Python API enabled and access approved | Running local tmux server/session | Running compatible local Herdr server |
| Prompt/exit status | Shell integration can report it | Quiet-output heuristic | No shell lifecycle/exit-code feed |
| Coding-agent state | No semantic feed | No semantic feed | `working`, `blocked`, `idle`, `done`, `unknown` |
| Focus on host | Supported | Unsupported | Supported |
| Absolute history numbering | Native | Synthesized | Synthesized |
| Change detection | Notifications | `%output` events | Revision-ordered pane updates and snapshot reconciliation |
| Cursor | Native feed | Native feed | Inferred |
| Terminal mouse | Unsupported | Unsupported | Atomic native clicks with a matching Herdr CLI/server, version 0.9.3 or newer |

Other terminal apps can expose their shells through tmux. Installing tmux does
not expose ordinary tabs that run outside it. The registry prefixes session IDs
with `iterm2:`, `tmux:` or `herdr:`, strips the prefix before dispatch and rejects
cross-backend window targets. Known multiplexer-host duplicates are suppressed;
this is not arbitrary process-tree discovery.

### Starting a terminal from the phone

An open session is not required. `hello.backends` describes connected adapters;
the optional `hello.launchableBackends` lists installed adapters that can be started
by an explicit `session.create` request. Older peers can omit that field. The relay
routes this metadata inside the encrypted connection and does not launch programs.

- iTerm2 starts through the fixed installed app bundle, in the background. Its Python
  API must already be enabled and access approved on the computer.
- tmux must be version 3.2 or newer. When its server is absent, Shellbell creates one
  detached session, attaches the control client and returns that session's pane.
- Herdr starts through the installed `herdr server` command. If there are no
  workspaces, session creation creates a workspace in the user's home directory and
  returns its initial terminal instead of creating an extra tab.

Startup is coalesced per backend, with at most eight waiting requests. Connection
readiness has a deadline. A removed launcher or replaced backend cannot complete an
old request against a new owner. Existing window and split targets retain their
normal validation; a lost target is not silently replaced by a new terminal.
Shellbell does not accept a remote executable path or arbitrary launch command.

### Adapter details

The iTerm2 client connects to its Unix socket through an explicit socket connector,
avoiding URL path encoding. Shell integration is optional for screen/input but
needed for reliable command/prompt events. Disconnect removes its health and
sessions; reconnect rebuilds state and rejects stale asynchronous results.

The tmux control client uses `ignore-size` so observation does not resize panes.
When a control request times out, the client closes and pending requests fail.
Periodic backend discovery attaches a fresh client to the running tmux session;
late replies from the retired client cannot be assigned to a new request.
UTF-8 mode is explicit even under a restricted service locale. Captured ANSI
contains literal escape bytes; control-output escaping is handled separately.
The adapter synthesizes scrollback numbering, with explicit reset/retention
handling at saturation or clear. History is not a permanent archive.

Herdr uses bounded requests and a separate event subscription. Its pane revision
orders metadata changes but does not reliably track terminal output. A screen
observer compares normalized viewport hashes: watched panes are checked at a
minimum 125 ms interval, other panes at a one-second minimum to retain quiet-session
notifications. Each pass reads at most 16 panes with at most four concurrent
requests. Unchanged screens produce no stream update; content and style changes
mark the pane dirty. Subscription handover preserves the comparison baseline;
connection loss stops observation and discards it. Late reads from a replaced
connection, pane or geometry are ignored. The observer stores hashes, not output.

Revision-ordered pane events reject older replayed updates; snapshots reconcile metadata and agent
state. Reads can be trimmed, so viewport rows are padded during conversion.
Recent history reads are bounded to 1,000 physical rows, including the visible
screen. Herdr clamps `pane.read` to that window and exposes no history cursor or
offset on this method, so requesting more rows cannot recover older output.
Busy-agent/deep-history requests can return unavailable rather than inventing
an end boundary.
Mouse clicks use a separate, bounded native CLI control connection. The CLI
is pinned to the JSON API instance through `HERDR_SOCKET_PATH`; a matching
version check gates advertisement. Before opening control, the adapter checks
the live identity and a fresh layout against the phone's grid. It sends an
ordered press/release, detaches immediately, and refuses takeover. It does not
resize the grid to the phone viewport, inject mouse escape sequences through
text input, or expose a desktop pointer. Click requests share paired-request
deduplication with keys and text.

Socket selection includes `HERDR_SOCKET_PATH` and the user's Herdr configuration.

Current contracts and sanitized fixtures are in the
[iTerm2](../../apps/agent/src/backends/iterm2),
[tmux](../../apps/agent/src/backends/tmux) and
[Herdr](../../apps/agent/src/backends/herdr) implementations and
[backend tests](../../apps/agent/test). New adapters need the
[extensibility work](extensibility.md), including shared failure/deadline tests.

## Screen, history and input correctness

A phone link views zero or one session. The tracker captures watched dirty sessions
and sends snapshots on subscription/resync, with changed rows or scroll updates
when appropriate. The local minimum update interval is 125 ms; the default global
budget is 40 frames/second. Budget-skipped work remains pending, with viewer/session
rotation for fairness. Refused sends retain demand and force a fresh snapshot;
removed or stopped sessions reject late capture results.

Negotiated `bounded-stream-v1` splits logical records into bounded transfers with
acknowledgements and deadlines. History carries a capture token, retention boundary,
request ownership and exact row widths/styles. Temporary backend unavailability
must not become false `end` or `truncated` history. Mobile cache limits, gaps and
source anchors are separate from backend scrollback. See
[stream records](../stream-history-records.md) and
[mobile presentation](mobile-terminal.md).

`input.line` appends Return, `input.text` sends text and `input.key` maps a named
key. Backend semantics differ: tmux splits newline-containing text into submissions.
There is no general bracketed-paste operation; raw multiline text is not a safe
multiline prompt composer contract.

Input, focus and session creation share a ledger per pairing across fresh
handshakes and relay replacements. It retains 256 completed outcomes and admits
256 unfinished operations. A duplicate ID joins its operation or receives the
saved acknowledgement; changing the payload under that ID cannot start new work.
At capacity a fresh request receives `busy` without reaching the backend.

Key/peer replacement, durable unpairing and service stop retire the ledger; a
failed unpair write leaves it intact. It holds acknowledgement metadata rather
than input text. Restart or completed-cache eviction can leave delivery uncertain.
The phone never automatically replays input with an unknown outcome. Success means
backend acceptance, not command success. View/history deduplication remains scoped
to its handshake and owner generation.

## Pairing and attention

A pairing invitation lasts five minutes. A gate limits relay admission while a
separate secret protects endpoint exchange. Human confirmation has a 60-second
timeout; CLI auto-accept bypasses that check and should not be used on shared screens.
Pairing closes on success, expiry or repeated bad codes. Records survive restart.

The service must recognize the local pairing and the endpoint must possess its
key; relay authentication alone is insufficient. Legacy transport derives fresh
connection keys from endpoint nonces and enforces authenticated sequence order.
Secure v2 adds durable downgrade prevention, fresh Noise keys, signed revocation
and verified direct route commit. See [connections](../how-shellbell-connects.md)
and [the v2 profile](direct-transport-wire-v2.md).

Defaults in [`config.ts`](../../apps/agent/src/config.ts): command completion after
at least 10,000 ms; quiet output after 30,000 ms with at least 1,500 ms activity;
one local ring per session per 60 seconds. Existing explicit settings are preserved.
iTerm2 can report actual completion, tmux quietness is a heuristic, and Herdr can
report blocked state. Known semantic states suppress the unknown-state quiet heuristic.
Push leases, opt-in, local/relay limits and provider/OS behavior can suppress alerts.

Configuration setters validate relay URL, name, accent and whole-millisecond
thresholds before publication. Running services use their startup snapshot;
saving configuration requires an explicit restart. `status.config` reports its
normalized revision so a controller can compare saved and applied settings.

## Host state and lifecycle

macOS defaults to `~/.shellbell`; an explicit `SHELLBELL_DIR` selects state.
Linux defaults to host-scoped state under the user's XDG state home and uses a
separate validated local runtime directory for sockets, PID files and guards.
Linux initialization/adoption is explicit; ordinary commands do not repair unsafe
or foreign-host state. Runtime recreation never implies new keys. See
[Linux operations](../../apps/linux/README.md).

| Local file | Purpose |
| --- | --- |
| `identity.json` | Long-lived identity keys |
| `pairings.json` | Peer identities, pairing keys and protocol state |
| `config.json` | Relay, name/accent and attention thresholds |
| Ownership/controller records | Consent, mode, revision and recoverable transitions |
| Socket, PID and guards | Private local process ownership |
| Log and rotations | Sanitized diagnostics, not a terminal transcript |

State is private to the OS user. Secret writes use validated bounded records and
atomic publication. Unix endpoint ownership uses a private guard and inode-aware
cleanup; ambiguous owners or unsafe files are refused. These mechanisms coordinate
cooperating processes on local filesystems, not hostile same-user writers.

Desktop service lifetime belongs to the controller's private pipe. Headless lifetime
belongs to launchd or systemd-user. Explicit conversion preserves keys and settings;
ordinary CLI startup cannot take over desktop-owned state. Stop, startup preference,
registration and verified readiness remain separate. See
[native lifecycle](native-controller.md), [local control](../local-control-v2.md)
and [installation](../install-agent.md).

## Diagnostics and shutdown

Read-only status/doctor distinguish identity, manager, control endpoint, relay,
backend health and terminal readiness. The ordered backend status contract is
shared with the native controller and currently includes exactly three names.
A reachable `/healthz` is not proof of authenticated terminal or push health.

Log calls use fixed safe error categories rather than raw exceptions, terminal
text or private payloads. Log admission requires a current-user-owned single-link
regular file, rejects symlinks/hardlinks and uses `0600`. Rotation retains the active
inode for inherited writers, copies at most the newest 1 MiB and retains five
archives. This is best-effort diagnostics, not lossless audit logging.

SIGINT/SIGTERM in service/start mode stop relay/tracking/detectors and close local
control with a five-second exit deadline. Installed headless supervision can restart
an exited service until explicitly stopped. Registry shutdown/failure-isolation
limitations remain in [extensibility](extensibility.md#failure-isolation-and-shutdown).

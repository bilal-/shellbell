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
| `pairing.ts`, `v2-phone-link.ts`, `paired-requests.ts` | Pairing, secure-v2 phone links and bounded request outcomes |
| `relay-client.ts`, `direct-peer.ts` | Outbound relay connection and native direct transport |
| `native/`, `service-*`, `systemd-*` | Controller bridge and platform-specific lifecycle |

Sources live in [`apps/agent/src`](../../apps/agent/src). macOS startup constructs
all three built-in backends; Linux constructs tmux. Both
can load explicitly configured local [terminal adapters](terminal-adapters.md).
Backend discovery does not block relay startup. Missing backends can reconnect
and become available later.
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
with an adapter ID such as `iterm2:`, `tmux:` or `herdr:`, strips the prefix before
dispatch and rejects cross-backend window targets. Known multiplexer-host duplicates are suppressed;
this is not arbitrary process-tree discovery.

### Starting a terminal from the phone

An open session is not required. `hello.backendCatalog` describes registered
adapters, capabilities, health and startup availability; the legacy
`hello.backends` and `hello.launchableBackends` lists retain built-in entries.
`hello.sessionLaunchTargets` adds available engine/desktop-app pairs. When an
engine's targets are all unavailable for a reason the user can fix,
`hello.sessionLaunchIssues` carries one plain sentence for it, which the phone shows
on that engine's disabled option. Herdr reports an old server, a `herdr` program the
service cannot find, or a program whose version differs from the running server; it
reports nothing when Herdr is not running. The relay routes this metadata inside the
encrypted connection and does not launch programs.

A phone-created session always opens in a terminal window on the computer, so a
phone cannot run a session the computer's user cannot see. The service enforces
this in its backend registry; it does not rely on the phone's choice.

- iTerm2 starts through the fixed installed app bundle, in the background. Its Python
  API must already be enabled and access approved on the computer. A new iTerm2 tab
  is itself a desktop window.
- tmux must be version 3.2 or newer. When its server is absent, Shellbell creates one
  session, attaches the control client and opens that session in a desktop window.
- Herdr starts through the installed `herdr server` command. A phone-created Herdr
  session is a new workspace in the user's home directory, opened in a desktop window.

A tmux or Herdr request that names no desktop app opens in iTerm2, then Ghostty.
With no available desktop app the request is refused with a message the phone
shows, before anything starts. If the window fails to open, the new tmux session
or Herdr workspace is closed again. Starting the app is not proof: a new tmux
session must gain an ordinary (non-control) client within 15 seconds, or it is
closed and the phone is told to unlock the computer and try again. On macOS that
client must run inside a desktop app, so a client attached over `ssh` does not
count; the same check guards splits and new windows in an existing session. A new Herdr
workspace waits the same way for a `herdr terminal attach` client inside a desktop app. Ghostty
starts in the foreground: an instance opened in the background never creates
its first window. Splits and new windows in an existing tmux
session require an attached ordinary tmux client; Herdr splits and plugin
sessions are refused. See
[launch choices and prerequisites](terminal-adapters.md#built-in-launch-choices).

Startup is coalesced per backend, with at most eight waiting requests. Connection
readiness has a deadline. A removed launcher or replaced backend cannot complete an
old request against a new owner. Existing window and split targets retain their
normal validation; a lost target is not silently replaced by a new terminal.
On macOS, tmux and Herdr open in a selected Ghostty or iTerm2 window. The
service creates an independent session and starts a fixed attach command; it
does not type into an existing shell. A Herdr target shows the selected terminal
rather than its dashboard and can occupy its exclusive mouse controller.
New independent windows can receive a bounded preferred cell grid
from the phone: iTerm2 uses session-only Columns/Rows profile overrides, and
Ghostty receives both initial window cell dimensions. A new detached tmux session
starts at the same grid before its desktop client attaches. Shellbell removes the
temporary tmux session default-size override after creation, preserving a
different value set by the user's creation hook; later windows keep their usual
defaults. Desktop window limits
and the attached client can adjust the result; existing windows, tabs and splits
are never resized by this hint. Without a hint, an iTerm2 window opens in the
background at the size of the window holding the focused iTerm2 session, or the
largest one, with the profile's size used when iTerm2 has no windows. Ghostty uses
the user's configuration. Shellbell does not accept a remote executable path or arbitrary launch command.
See [launch choices and prerequisites](terminal-adapters.md#built-in-launch-choices).

### Adapter details

iTerm2 access asks macOS only after a person's request: **Connect iTerm2** in
the Mac app (`terminals.connect`), `shellbell connect iterm2`, or a foreground
`shellbell start` in a terminal. Background attempts first check, without
prompting, that iTerm2 is open and its Python API is listening. The decision
is recorded in `iterm2-access.json`. The first start without that record decides
once: an install that already had a paired phone counts as approved, any other
does not, and a phone paired later does not change it. After iTerm2 refuses, or
a dialog goes unanswered, background attempts wait for the next request, and the
record keeps them waiting across restarts. Each request allows one question. A macOS refusal
(`-1743`) shows no dialog, so checks continue and notice when it is allowed in
System Settings. Each terminal reports a setup issue code (`terminals`, hello
`terminalSetup`) that the Mac app, `doctor` and the phone put into plain words.

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

### Private agent session identities

The Herdr adapter recognizes explicit `agent_session` reports from the known
Claude and Codex integrations. This optional metadata is present in Herdr 0.9.5's
API schema. Conversation proof requires Herdr 0.9.5 or newer; older and
unrecognized development versions remain unbound even if they return the field.
Missing metadata also leaves the pane unbound. Titles, agent display names and
working directories do not establish a transcript identity.

The internal `conversationReference` operation makes a cancelable `pane.get`
request and checks the native pane, terminal and current connection before
returning an opaque ownership generation. A changed identity observed by a fresh
probe, snapshot or ordered event ends that generation, as do disappearance and
reappearance or connection replacement. Identity-only changes need not advance
Herdr's pane revision or emit a pane update; callers must probe again before
delivering transcript data. Lifecycle hints
that could replace a pane suspend proof until a fresh snapshot settles. A late
response cannot undo a newer identity event or a verified reference. Ordinary
screen output does not change the conversation's ownership.

These references stay inside the computer adapter. They are not advertised in
session lists, notification context or relay messages. Receiving metadata alone
does not read files. A focused phone can request Conversation only after the
owner enables it; each read and delivery still needs fresh source proof.
The registry admits one identity probe per session, with a total in-flight cap
equal to the pairing limit. If a probe discovers a changed identity, its
invalidation event can make that registry request return no proof; a new request
then obtains the new ownership generation.

The separate transcript locator accepts exact UUIDs or explicit paths only in
the supported Claude `projects/<project>/<id>.jsonl` and Codex dated rollout
layouts (including legacy root-level rollouts). It does not read file contents.
Duplicate matches, compressed or unknown Codex variants, incomplete searches and
unsafe paths remain unbound; modification time never selects a winner. An
explicit native path can disambiguate multiple rollouts for the same thread.

Lookup requires owner consent, permits one scan per locator, and caps work at
eight roots, 512 directories and 16,384 enumerated entries. A two-second deadline
or cancellation returns promptly; the scan retains its permit until outstanding
filesystem operations settle and directory handles close. A large archive may
remain over the lookup limit, so callers must not retry that result continuously;
an explicit native path avoids enumeration. The runtime must share a locator
across consumers rather than create one per request.
An operation that never settles also keeps later lookups busy; callers must
respect that backpressure. Consent changes are checked at each asynchronous
boundary, and the owner controller must cancel active work when consent is revoked.

Observed directory or inode changes invalidate a lookup, including a configured
root appearing during the scan. This is not an atomic filesystem snapshot, and
directory timestamps may have coarse resolution. Explicit native file paths
must already be canonical. A candidate still requires fresh native identity
before and after lookup, transcript metadata validation, and the reader's safe
descriptor checks. Runtime collection requires the owner setting and a focused,
authenticated direct-route subscription.

The identity probe composes these operations for the descriptor reader: fresh
native proof, bounded candidate lookup, then another native proof with the same
reference and ownership generation. It copies the captured evidence and checks
consent and cancellation at each boundary. Every probe repeats lookup rather
than caching a filename for an ID that might now refer to multiple rollouts.
The reader supplies the probe's cancellation and deadline; other callers must
also bound it. Record metadata validation and the delivery generation gate remain
separate requirements.
Busy, over-limit or ambiguous lookup ends the current reader generation instead
of reusing an earlier path. Collection scheduling must serialize access or reopen
after backpressure settles. Each read validates twice. Each validation has a
two-second proof budget covering lookup and both native probes. Large ID-based
scans therefore cost more than an explicit native path.

Completed JSONL records have separate Claude and Codex format adapters. Each
declares the agent versions it has been checked against
(`src/conversation/transcript-formats.ts`), with an anonymised fixture per version in
`test/fixtures/transcripts` made by `pnpm --filter shellbell conversation:fixture`.
Tests replay every fixture and fail on any unsupported row. Records carry the
agent's version, and a version outside the tested range adds one status line to the
newest projection. To support a new agent release, add its fixture, fix what it
shows as unsupported and raise the range.

Antigravity CLI (`agy`) keeps each conversation in its own SQLite database under
`~/.gemini/antigravity-cli/conversations`, one protobuf row per step and no published
schema. Its adapter (`src/conversation/antigravity.ts`) reads only the fields its
fixture pins: the owner's text, the visible reply, announced tool calls, each tool run's
summary argument, output and failure text, API errors and background-task notices. The
model's private reasoning field is never read into a row. Herdr proves the binding
(`agent_session` from its `antigravity_cli` integration). Because the database changes
in place, the follower hands these sessions to `AntigravityReader`, which opens the file
read-only through Node's built-in SQLite (Node 22.13 or later; older runtimes keep the
Terminal view). It proves the binding before opening the file and once after every
read, and re-reads only when SQLite's `data_version` changes. A change costs one small
metadata query: a step's payload is fetched and decoded again only when its status,
size or last bytes changed, within the newest 2,000 steps and 16 MiB. Outside Herdr,
Antigravity is bound by the presence lock it holds, so an idle `agy` that has
released it shows Terminal until it takes the lock again.
There are no older pages; a longer conversation shows that earlier steps aren't loaded.
`pnpm --filter shellbell conversation:fixture:agy` makes an anonymised fixture.

Herdr reports which conversation a pane runs. tmux and iTerm2 don't, so for them the
proof comes from the agent's own foreground process on the terminal's tty
(`src/conversation/process-binding.ts`), not from a title or working folder alone. `ps`
lists the tty's foreground processes with their start times (UTC, C locale). Claude
Code is bound by its `<config>/sessions/<pid>.json`, whose pid and process start time
must both match, so a reused pid can't inherit an old session. Antigravity CLI is
bound by the single `presence/<conversation>.lock` it holds open (`lsof`, or
`/proc/<pid>/fd` on Linux). Two different conversations in one terminal's foreground
bind nothing. The owner is the tty, pid and start time, so a restarted agent is a new
owner. Codex and Gemini CLI keep no record of which process owns which session, so
outside Herdr they keep the Terminal view until Shellbell's hook provides one
(`agent-hook.ts`, records in `agent-sessions.ts`). The hook keeps only the session ID
and transcript path from its input and never stores the input, which for Gemini's
BeforeAgent event holds the prompt. Gemini needs BeforeAgent as well as SessionStart
because its in-app `/resume` switches session without a SessionStart. Gemini runs as
`node`, so a record must name the exact process (pid and start time) in the pane; tmux
and iTerm2 name the session's agent from Gemini's titles. Codex 0.166 and later run
every session inside one shared background process, so the hook runs there with no
terminal and records nothing. For a pane whose foreground process is Codex and has no
record, the session Codex names in the pane's own title is the proof
(`codex-threads.ts`): Codex's default title is its activity, the session's name and its
project. The name must match exactly one named session in `session_index.jsonl`, and
that session's first record must put it in a folder with that project name and, when
the pane reports a folder, in the pane's folder. Anything less certain, such as a
session not named yet, a custom title or two sessions with one name, keeps the
Terminal view. Gemini runs settings hooks
only in trusted folders, so an untrusted folder keeps the Terminal view. The
Mac app offers it when Shellbell first starts and lists it under Settings →
General → Coding agents; headless and Linux installs ask at the first `shellbell
start` or `shellbell service install|start` in a terminal, and `shellbell agents
setup` adds it later. All three use `agent-setup.ts`. A skipped agent is recorded
in `agent-setup.json` and not offered again. They
whitelist presentation fields, omit reasoning and internal context, represent
unknown content with a fixed placeholder, and bound text, tool previews and
serialized entries. A line over 128 KiB is never buffered whole. It is streamed
and kept only down to the fields its adapter reads, with long text replaced by a
fixed notice, so it classifies and links like a record that fit and older Claude
messages stay reachable through it. Invalid JSON, invalid UTF-8 or nesting deeper
than 512 levels still becomes a notice that the entry could not be read. A decoded record does not establish the active conversation.
Private session IDs, parent links, tool associations and source offsets remain
computer-side evidence. The Conversation transport assigns random opaque delivery
IDs within each generation rather than exposing that evidence. No arbitrary JSON, image payloads or source metadata
are copied into presentation entries.

Gemini CLI writes one JSONL file per session under
`~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl`: a header with the session
ID, then a line per message, written again whenever that message changes, plus
`$rewindTo` and `$set` lines. The locator finds a file by the first 8 characters of
the bound session ID; two matches fail closed, and the reader requires the header's
full ID. The projection keeps each message's newest version in its place, applies
rewinds and replaced message lists, and offers no older pages, since an older page
could hold a superseded version. Prompts show the text the owner typed, not the text
of attached files. Thoughts, token counts and the model are never read, and are left
out of the oversize-line outline. Gemini's records don't name their version, so its
format range in `transcript-formats.ts` is checked by the fixture only.

The bounded document projector selects Claude's latest main parent chain and
requires its current leaf's session ID to match the proven native identity.
Inherited ancestors may have older IDs. It recovers parallel response blocks and
tool results only through matching response and tool evidence, keeps subagent
content collapsed when its ancestry reaches the selected conversation, and
exposes missing ancestry explicitly. A compaction boundary links to its logical
parent, the last message before the compaction, so older pages continue past the
summary into the conversation it replaced; the summary row stays collapsed between
them. Only the boundary's own `logicalParentUuid` counts, and the selected leaf's
session ID still has to match. Codex requires its canonical first `session_meta`
record at byte zero; inherited later metadata cannot establish or change that
identity. A history base in another file and subagent history ordinal boundaries
are unsupported; the projector does not label those partial files complete. A
paginated file with no history base holds its whole conversation and reads like a
legacy file, except that it has no user-message events: there, a user record counts
as a typed prompt only when its retained source is the user and it carries an input
order, which harness context such as AGENTS.md does not. Legacy forks include their copied parent conversation as inherited
history. Legacy user-message events supply displayed user text because
user-role model-context records also carry internal harness instructions. Those
context records and inherited or delivered harness messages are omitted. Codex
inter-agent activity has a collapsed placeholder without interpreting its payload;
unrecognized subagent formats remain unsupported. Summaries remain grouped. Recognized legacy
rollback events invalidate the projection because their instruction-boundary
semantics cannot safely be reconstructed by counting displayed user messages.
The Terminal view remains the fallback for unsupported formats.

Each document retains at most 256 KiB of decoded records and 2,048 records. Its
presentation is capped at 2,000 entries and 256 KiB, with explicit notices for
unloaded, evicted or unlinked history. These are separate budgets, not a total
process-memory claim. The projector's `change` compares produced projections;
it does not describe the phone's applied baseline. Private selected-chain IDs
and record positions let delivery distinguish a changed branch from an advancing
source window. Native linking evidence never becomes a wire entry ID.
Subagent groups stay by their linked main ancestor, and framing notices stay by
source position. The projector validates one file generation only. It can mint a private page
anchor for a displayed record on the selected main chain, containing the record
range, decoded-record fingerprint and entry fingerprint. Claude cuts at a typed
user message with no tool results, or at the first block of an agent reply whose
parent ends a different reply: an earlier reply, or results whose calls all belong
to one. Records that show no row, such as the reply's own thinking, queued-command
attachments and hidden context, are passed over to find that parent. Either way, no later-written records may contribute to the displayed prefix,
and cuts inside a parallel response remain unavailable. When earlier rows can't be
loaded, the newest window and each older page start at their first cut, so paging
continues through busy turns. A Claude window or page with no cut, which large
records such as screenshots can cause, doubles its read up to 8 MiB until it holds
one.
Unplaced later main records also prevent a cut, including tool results whose
owner has left the retained window. Unsafe-cut evidence survives record eviction;
evicting an unprojected assistant/result record also invalidates earlier cuts. A
new follower window retires previously issued page capabilities. Synthetic groups and
recovered off-chain siblings cannot define this join. An anchored projection must
end at the same unchanged record; inherited Claude ancestors may then retain
their original session IDs. Neither a projection nor an anchor authorizes delivery.

The file follower composes descriptor proof, JSONL framing and projection. A
shared pool admits at most the pairing limit of file generations and runs one
operation at a time, so followers do not collide in the shared locator. It has no
unbounded request queue. Each poll reads at most one 64 KiB window and processes
at most 256 completed lines; remaining read bytes stay bounded and are cleared
on close. Initial reads start within the newest 256 KiB, widening as above. Codex first validates
its canonical header at byte zero before seeking that tail. Incomplete final
records wait for more bytes. A follower captures a fixed extent for each
projection, so a continuously writing agent cannot keep moving the completion
target. It can present that verified prefix with `caughtUp: false` while later
records are still arriving. Delivery must preserve that catching-up state; this
is not a claim that the prefix contains the latest branch or compaction change.
Subsequent projections replace or prune earlier rows when those changes are read.
`caughtUp: true` means no unread bytes at the last check; it does not publish a
buffered, unfinished JSONL record or mean that the agent has finished working.

While a follower has unread bytes, its stream asks for the next fair turn at
once instead of after the usual 200 ms pause, so a burst such as one large tool
output is read through and the conversation stays continuous. If growth leaves
more than 4 MiB unread after a poll's bounded processing, the follower resets to
a newer 64 KiB window, leaving room for continuing appends,
and increments a discontinuity counter. Delivery must surface that skipped
interval before presenting the replacement; it cannot silently treat the result
as continuous. Sustained growth faster than the bounded consumer can cause
repeated skips without a snapshot. The runtime must show that condition or fall
back to Terminal rather than leave an unexplained loading state.

A separate confirmation operation renews native identity and append-only
consistency checks: same descriptor/path, no truncation, and sampled 4 KiB head
and tail fences. These samples do not prove that every captured byte is unchanged;
an in-place edit outside the fences combined with growth may go undetected.
Later appends report
`caughtUp: false`; changed ownership, replacement or truncation stops delivery,
and processing newer records invalidates the previous revision. The delivery
owner must still fence consent, route and generation after
awaiting confirmation and immediately before sending. This does not establish an
older-history paging anchor or authorize a transport by itself.

Closing cancels logical ownership immediately. A ten-second operation deadline
also returns a stopped result, but neither cancellation nor timeout releases
resource admission while filesystem work remains pending. The reader exposes a
completion promise that waits for owned open/read/verification work and confirmed
descriptor closure. Unconfirmed close failures retain their slot; one stalled
operation can keep the shared work slot busy. Callers must respect that
backpressure rather than construct replacement pools or retry continuously.
Configuration access also reserves admission before calling owner-provided
getters. The coordinator shares this pool and its locator across all routes and retries.
Source helpers alone never authorize a delivery; the route owner applies consent,
source proof, generation and wire-budget checks.

### Session names

Every adapter fills the optional `project`, `agent` and (Herdr) `windowLabel` session fields
through one shared helper, `apps/agent/src/session-naming.ts`; `title` keeps its earlier value
for older phones and the phone's notification title cache.

- `project`: a manual name, else the folder name, upgraded to the Git top-level name for a local
  folder. Herdr uses the workspace label, which Herdr derives from the repository unless the user
  renamed it. A tmux window name is manual when it is not automatic-rename output: not the
  foreground command, a shell, an agent name or a version number. iTerm2 session names follow the
  terminal title, so none is treated as manual.
- `agent.kind`: Herdr's pane `agent`; otherwise a `claude` or `codex` foreground process, or a
  `node`, version-numbered or unknown foreground whose title starts with an agent status glyph
  (Braille spinner, quarter circle, Claude Code star, middle dot or asterisk). Shells and other
  programs are never agents.
- `agent.task`: Herdr's pane `label`, else its stripped terminal title; elsewhere the pane title or
  session name. The leading glyph run, Codex's trailing ` | <project>` and iTerm2's trailing
  ` (<job>)` are removed. Text that only repeats the agent's name is omitted.

All values are bounded single lines without control or bidi characters; path- or origin-like
text is omitted. Git runs only through the bounded, cached notification-context reader, never
for `ssh`, container or unknown foregrounds, and never delays a session list: the list is
republished once a lookup changes a name. Herdr republishes when a task label, workspace label
or agent changes, not only the legacy title.

Herdr sessions also carry `shownIn`, the macOS apps running a Herdr client of the watched server.
Herdr's API does not list its clients, so the adapter reads the process list every 10 seconds,
keeps `herdr`, `herdr --session <name>` and `herdr session attach <name>` clients whose default
socket is the watched one, and names each client's nearest `.app` ancestor. An explicit
`HERDR_SOCKET_PATH` in the client's own environment is not visible, so such clients are not
counted. The phone adds the names to the workspace heading, for example `HERDR · web · in Ghostty`.
tmux sessions carry `shownIn` too: `list-clients` reports each ordinary client's process, whose
nearest `.app` ancestor is named, with the process list read at most every 10 seconds. The
phone's session menu opens a new session in the app already showing the current one.
History capture retains the normalized visible rows. Herdr can end a recent
read at the cursor or last content row, shifting its entire range above a blank
viewport tail. The adapter checks the recent read's visible suffix and derives
its physical start from that captured end; it never pads older history or treats
the requested row count as proof of an offset. An entirely blank viewport cannot
anchor a recent read. Before/after native facts and observer invalidation still
fence the capture. Busy legacy reads
remain retryable and do not claim that history has ended. Legacy trimmed
reads also require matching visible-tail evidence; inconsistent short buffers
and cursors outside the native fetch window remain unavailable. Legacy paging
retains its existing relative coordinates; new phones use capture-bound streams.

Recent history reads are bounded to 1,000 native rows, with visible content
consuming part of that window. Herdr clamps `pane.read` and exposes no history cursor or
offset on this method, so requesting more rows cannot recover older output.
Busy-agent/deep-history requests can return unavailable rather than inventing
an end boundary. A fetch-window refusal carries optional protocol detail so
updated phones explain the terminal's read limit and stop retrying that capture.
Older peers retain the generic unavailable behavior. Disposable native Herdr
tests cover styled pagination, blank viewport tails, cursor positions and the
read cap using an isolated server, socket and configuration.
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
budget is 40 envelopes/second. Budget-skipped work remains pending, with viewer/session
rotation for fairness. Refused sends retain demand and force a fresh snapshot;
removed or stopped sessions reject late capture results.

Each service route lease can also own one lower-priority producer. It shares the
same 40-envelope/second budget: ready terminal producers drain first, then
background work uses the remaining tokens. Terminal readiness is checked again
after each background offer. Each priority class retains round-robin ordering;
continuous terminal demand can starve background work. This is scheduling policy,
not a measured input-latency guarantee.

A background producer registers with the scheduler only when explicitly woken
and unregisters when it returns false. Dormant producers do not multiply terminal
offers or keep a background-only route's timer running. Replacement,
route closure and service stop drop its callback; obsolete wake/close handles
cannot act on a successor. Producers must synchronously offer exactly one actual
envelope and independently enforce their source, consent and view fences.
Wake can call the producer synchronously. Registrations added during a pump
wait until the next pump; a wake during a refusing callback remains pending.
Retired leases return inert handles. Conversation uses this background lane;
it cannot bypass the shared budget or terminal-first scheduling.

### Conversation delivery

`ConversationCoordinator` shares one follower pool and locator across routes and
rotates bounded source work among focused subscriptions. Each direct route owns
one replaceable subscription. An authenticated Conversation request selects its
session independently of the terminal renderer, so a blocked renderer does not
prevent conversation recovery. A terminal subscription for a different session
retires it; raw/snapshot changes for the same session preserve it. Leaving, route replacement, revocation and service stop cancel its
reader and release held presentation data. Native conversation-change events
invalidate the source immediately. Unbound or unsupported stopped readers wait
for an identity change or an explicit refresh instead of continuously scanning.

The computer advertises `conversation-v1` and the separate owner consent flag.
Only local settings can change consent. Every opt-out path synchronously closes
readers and discards queued records, including stale apply requests and config
read failures. A clear message remains retryable while consent is off. The phone
discards records before acknowledging it; the computer waits for that exact
acknowledgement before another generation. A new subscription starts empty.
Repeated refresh requests coalesce behind the latest clear.

`AgentConversationStream` renews file/native proof before offering data to the
background scheduler and expires that permission after 200 ms on a monotonic clock. All post-await
source, route, view and consent checks still apply. The atomic batch payload is
at most 31,744 encoded bytes, reserving 1,024 bytes inside the 32 KiB received-frame
limit for encryption and route framing. It contains at most 64 entries. Random
wire IDs hide native session IDs, branch links and source offsets. Only supported
presentation fields cross the encrypted direct route; the relay receives no
Conversation records.

Missing identity proof retries every five seconds while the session is watched,
since a shared native lookup can be busy or time out. An unsupported transcript
format waits for a source change or manual refresh. A reader that cannot progress
for five seconds reports Checking; it keeps its physical admission until outstanding
work and descriptor cleanup actually finish.

The newest bounded page arrives first. Live range patches use the last applied revision and preserve both older phone
rows outside the source window and the unchanged tail after an edited group. A
leading insertion or removal is reflected when the applied history is complete;
an unloaded prefix remains demand-paged. One
batch remains outstanding until its applied acknowledgement, which reports the
actual retained oldest/newest IDs and count. Retransmission renews source proof.
A replacement branch or explicit source discontinuity uses the clear barrier;
skipped source intervals have a visible notice. Older-page requests first use the
proven retained projection, then a private anchor issued by that same follower.
A physical page reuses its opened descriptor, admission and identity checks.
Newly appended bytes must be parsed before paging; each step rechecks the private
cut against the current projection. It
reads one bounded backwards window ending at the anchor, projects that branch,
and verifies the unchanged join before returning earlier entries. Codex pages
reuse only that descriptor's verified canonical header. Each work step reads at
most 64 KiB or parses 256 lines; the whole window is at most 256 KiB. A gap outside
the window, unsupported join or overlapping loaded rows stops paging explicitly
without clearing the displayed conversation. Synthetic unlinked-activity notices
do not define page cuts, and discovered unlinked activity remains explicit even
when paging reaches the file start. No arbitrary older leaf is selected.
The source reserves one atomic page within its total 256 KiB plaintext queue;
older requests use the same fair background scheduling as live delivery. Applied
physical pages retain at most 4,096 private ancestor identities, including hidden
records, so a later rewrite cannot silently retain obsolete phone history. Further
paging stops explicitly when that evidence budget is full.

The phone keeps at most 2,000 entries or 4 MiB of encoded presentation records in
memory. Live or late older-page pressure evicts oldest rows with a visible notice;
it does not clear the entire conversation. A page whose original anchor was
locally evicted cannot join across that gap. Failed or unanswered refreshes retry
with bounded delays; stale subscription traffic cannot reopen a view.

Conversation has its own connection state and a plain selectable message list.
The terminal renderer remains mounted and sized underneath it for output,
secret-prompt facts and applied progress. Hidden xterm input is disabled and
blurred; the composer continues to send terminal input. Explicit Terminal,
Reading, search, selection and mouse choices stop Conversation collection. An
automatic consent/error fallback preserves the control owner long enough to
acknowledge clearing. Device checks must still establish scrolling behavior and
input latency; source tests are not that qualification.

### Raw tmux stream

A subscriber that asks for `mode: "vt"` on a backend reporting `vtStream` (tmux)
receives the pane's own output instead of snapshots, so the phone's xterm parses,
scrolls and keeps history itself. The service attaches one extra control client
to the pane's existing tmux session while that view is open, and it never creates a
session, window or pane. That client turns every other pane off. tmux queues a
pane's output and updates its grid in one step, so one command list (pane state,
history, visible and saved grids, and any half-written escape sequence) falls
exactly between two of the pane's output lines. This holds only while no other
pane's output is queued ahead of it, and the client retries when another pane got
in first.

`vt-state` carries those replies rebuilt as bytes, with the pane's columns and
rows. `vt` transfers then carry the pane's bytes, batched while a transfer is in
flight. Window names that shells send to tmux (`ESC k name ESC \`) are removed
first, as tmux removes them; xterm.js would print them as text. A phone more than 256 KiB behind gets a fresh `vt-state` once the screen
lane is free rather than a replay. The first seed carries up to 2,000 history
lines, and the service halves that until it fits one 512 KiB transfer. A resize
reseeds after layout changes settle. The seed cannot recreate state tmux does not
report: the current colours, character sets, the active screen's saved cursor, a
pending wrap at the right margin, or tabs written under different tab stops. The
next output that sets them repairs the screen. If the pane closes, the view ends
as `session-gone`. Any other failure reports `unsupported`, so the phone can
subscribe again for snapshots.

### Raw Herdr stream

Herdr reports `vtStream` but does not provide raw output with scrollback. The agent
builds a stream by reading the pane when `events.wait` reports output and probing
at least every two seconds. Output waits are capability-probed: Herdr 0.9.5
rejects the output match with
`unsupported_event_wait_match` even though its API schema declares it. A rejected
wait switches the source to a 200 ms poll without repeating the unsupported
request. A frame reads scroll facts, the visible rows, any newly scrolled rows,
and scroll facts again. Changed facts cause a retry. The phone receives rows that scrolled off
above its screen and otherwise receives changed screen rows. A seed includes up
to 1,000 rows, Herdr's read limit. When a recognized agent becomes idle, the
source reseeds to include its transcript. Herdr reports no cursor, so the cursor
follows the last text as it does in snapshots.

The raw source uses `pane.get` viewport rows, including when a cached layout
rectangle is stale. If no frame can settle for two seconds, it makes one
bottom-screen probe bounded to one second. A verified read switches existing
phones to snapshots; an unreadable pane reports `stalled`. Repeated read errors
use a two-second retry window starting at the first failure, then take the same
probe once a failed request settles; native requests retain their own timeouts. When the Mac pane is scrolled, snapshots use Herdr's plain-text `detection`
read of the live bottom buffer; `visible` would return the Mac viewport and
`recent` has no physical screen boundary. Snapshot views report `stalled` after
three seconds of consecutive failed Herdr captures once a first screen has
been accepted. A capture that succeeds clears that deadline.

### Bounded streams

Raw subscriptions can request `continuation-v1`, `source-status-v1`,
`checkpoint-v1` and `applied-v1` together. The computer accepts the complete set
only for a source implementing continuation seeds and probes, and admits
`stream.accepted` before any extended data. Each viewer negotiates separately.
The mobile app requests the set with its bounded native checkpoint and recovery
path; older phones retain their existing stream format. See
[mobile terminal presentation](mobile-terminal.md) for ownership and recovery.

Negotiated `vt-seed` records distinguish initial history, screen-only
discontinuities and full Herdr idle replacement. A subscription with retained
phone rows receives a screen-only reconnect seed. Resize, overflow and reconnect
do not claim a continuous join. The opaque seed capture ID fences applied
reports; it does not authorize native history paging. Cursor and alternate-screen
provenance travel with the seed: Herdr's cursor is guessed and its alternate
screen is unknown.

`stream.ack` releases delivery credits. Independently, `stream.applied` reports
bytes parsed into xterm and committed to the phone's memory checkpoint. The
computer rejects unnegotiated reports, future generations, a wrong capture,
regressive offsets and offsets beyond completely admitted transfers. Late reports
from an older generation are ignored. Neither receipt nor application establishes
source row continuity.

Native raw paging is separately negotiated with `native-history-v1`. The computer
binds the wire capture to private native evidence from the same checkpoint as the
seed and supplies the physical prefix's text proof. Only initial or explicit full
replacement seeds carry this proof. Requests require the matching generation,
capture, oldest boundary and an applied seed. One native read and one history
transfer use the existing shared delivery credits; aborted reads keep admission
until they settle. A completed page advances the source boundary only after its
receipt acknowledgement. An explicit `stream.refresh` with `history: true` creates
a replacement capture; resize and reconnect dividers do not stitch native rows.

The tmux reader currently requires a quiescent checkpoint: any output observed by
its control client, including output from other panes,
layout change, reseed or close retires its evidence, even below history saturation.
This conservative rule prevents reset-and-regrow from looking like a valid range.
Herdr evidence pins the native frame revision, geometry, terminal and agent status;
idle transcript frames are excluded. Herdr's bounded API fetch window is reported
as unavailable, separately from the native retention boundary. Neither backend
falls back to matching line text or counts when native evidence expires.

After two seconds without output, negotiated sources are probed with a two-second deadline and
at most one outstanding probe. A timed-out probe reports Paused; its eventual
success cannot revive the old heartbeat. Status uses one coalescing control slot,
independent of the four terminal transfer credits, while retaining the shared
wire admission budget. Quiescent means the source probe is caught up and the
terminal lane has drained; pending source or delivery work reports Catching up.
Unnegotiated viewers retain their existing records and source lifecycle.

Every terminal view uses bounded streams, which split logical records into bounded transfers with
acknowledgements and deadlines. History carries a capture token, retention boundary,
request ownership and exact row widths/styles. Temporary backend unavailability
must not become false `end` or `truncated` history. Mobile cache limits, gaps and
source anchors are separate from backend scrollback. See
[stream records](../stream-history-records.md) and
[mobile presentation](mobile-terminal.md).

`input.line` appends Return, `input.text` sends text and `input.key` maps a named
key. Backend semantics differ: tmux splits newline-containing text into submissions.
`input.terminal` preserves xterm bytes; `input.paste` uses an advertised native
paste operation. Plain multiline text is not a substitute for native paste.

Input operations are ordered per terminal across callers, including paste and
the following Return. The registry retains at most 256 operations and 1 MiB
of UTF-8 input across queues. Other terminals run independently within those
bounds. A failed operation cancels input already queued behind it; session
removal, backend replacement or disconnection also prevents queued writes.
Queued phone input also rechecks its authenticated handshake before execution.
No cancelled operation is replayed. Accepted writes wake the existing bounded
screen-capture loop with `input-accepted`, so echo need not wait for Herdr's
observer first. Only observed output changes count toward idle notifications.

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
key; relay authentication alone is insufficient. The service speaks only secure
v2: durable downgrade prevention, fresh Noise keys, signed revocation and a
verified direct route commit. See [connections](../how-shellbell-connects.md)
and [the v2 profile](direct-transport-wire-v2.md).

Defaults in [`config.ts`](../../apps/agent/src/config.ts): command completion after
at least 10,000 ms; quiet output after 30,000 ms with at least 1,500 ms activity;
one local ring per session per 60 seconds. Existing explicit settings are preserved.
iTerm2 can report actual completion, tmux quietness is a heuristic, and Herdr can
report blocked state. Known semantic states suppress the unknown-state quiet heuristic.
Push leases, opt-in, local/relay limits and provider/OS behavior can suppress alerts.

Configuration setters validate relay URL, name, accent, whole-millisecond
thresholds and owner conversation consent before publication. Services retain
a startup snapshot except for `showAgentConversations`, which is on unless false.
The Mac's **Full agent history on your phone** setting and
`shellbell config set conversations on|off` save that consent and request live
application through local control. The mutation accepts only the saved config's
revision, checks the exact running process and state directory, and reads the
saved value under the config writer's guard. A delayed enable cannot override
a newer saved disable. A persisted opt-out closes the live gate even when an
unrelated edit made the apply request stale; that request is still rejected.
Older or unreachable services cannot confirm live application. After saving,
the controller reports saved/applied state, using unknown if live readback fails.
An apply request also closes consent when the saved configuration cannot be safely
read or its guard is busy. There is no automatic retry of uncertain mutations.

`status.config` hashes the startup snapshot with only the applied consent
overlaid. Other settings still require an explicit restart, including when
saved in the same batch as consent. This control path does not itself start
transcript collection; the reader's source and direct-route checks remain
separate admission requirements.

## Host state and lifecycle

macOS defaults to `~/.shellbell`; an explicit `SHELLBELL_DIR` selects state.
Linux defaults to host-scoped state under the user's XDG state home and uses a
separate validated local runtime directory for sockets, PID files and configuration/control guards. Service ownership guards live beside their private
record. Credential admission accepts only their private, bounded owner-marker
shape, including the empty candidate stage; published guards are withdrawn
atomically before their marker is removed. Retired dead-owner guards retain a
private, nonempty marker fence so another stale reaper cannot rename a replacement
owner's live guard. These small fences are retained. Removing them requires proof that no concurrent
ownership contender remains; automatic pruning is not implemented. Credential
admission never treats them as new identity or permission.
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
backend health and terminal readiness. The backend status contract shared with
the native controller keeps three built-in rows in order, then sorted unique
plugin rows, with a 32-adapter bound.
A reachable `/healthz` is not proof of authenticated terminal or push health.

Log calls use fixed safe error categories rather than raw exceptions, terminal
text or private payloads. Log admission requires a current-user-owned single-link
regular file, rejects symlinks/hardlinks and uses `0600`. Rotation retains the active
inode for inherited writers, copies at most the newest 1 MiB and retains five
archives. This is best-effort diagnostics, not lossless audit logging.

SIGINT/SIGTERM in service/start mode stop relay/tracking/detectors and close local
control with a five-second exit deadline. Installed headless supervision can restart
an exited service until explicitly stopped. Registry shutdown detaches membership
and subscriptions before bounded cleanup;
listing has deadlines and rejects retired-member results. Trusted in-process
plugins cannot be sandboxed or synchronously interrupted; see
[adapter isolation](terminal-adapters.md#owner-enabled-local-plugins).

# Tabby local pane prototype

This opt-in experiment mirrors existing local panes through Shellbell's terminal
adapter interface. It targets Tabby 1.0.238's xterm frontend. The companion
registers terminal panes in each Tabby window, reads the active screen on request
and routes input to a specific live session. It advertises snapshot updates and
terminal input. Scrollback, native paste, remote session creation, SSH profiles
and agent conversation discovery are outside the prototype.

The [planned Connect Tabby flow](../../docs/architecture/terminal-adapters.md#connecting-tabby)
describes what owners see before installation and how they disconnect.

## Run the macOS smoke check

Use the repository's Node and pnpm versions, installed workspace dependencies,
a C compiler, Node development headers, Python 3 and a dedicated copy of Tabby
1.0.238. From the repository root run:

```sh
experiments/tabby/smoke.sh "/path/to/Tabby.app/Contents/MacOS/Tabby"
```

This opens a temporary Tabby profile. If Tabby asks to run the Python fixture,
allow it in the disposable window. The harness builds a small N-API helper,
stages the companion in that profile, and groups two disposable full-screen
processes into a split. Each displays a unique marker and accepts only test
input. They have the same title. The harness closes its own Tabby instance
and removes the stage on exit. It requires a graphical desktop.

The check covers the authenticated socket, version mismatch, a lost input
acknowledgment, real pane discovery through the agent plugin loader, styles,
cursor position, input to an unfocused pane, redraws, refusal of a closed
pane's ID, and the surviving pane keeping its ID and foreground program after
the adapter restarts. A second pass uses fresh identities and the agent integration
suite's paired phone client to decode the screen, send input and receive the
next screen. Its relay and direct transport are test implementations.

## Connection and limits

The adapter owns the listener and holds an OS file lock over its lifetime so a
second adapter cannot replace a live socket. Both participants require an
explicit private stage. The listener checks the peer UID and the two processes
authenticate with a fresh challenge and a private per-install key. Other programs
running as the same OS user are inside the trust boundary.

Each Tabby window keeps one random window ID for its lifetime, and each pane gets
a fresh random ID whenever its session starts. A phone view therefore survives a
restart of the Shellbell service, but never follows a pane into a new session.
Input sequence numbers are scoped to a connection. The renderer checks that the
pane still owns the original session immediately before sending input.

The companion reports each pane's shell process ID and working folder. The
adapter reads the shell's terminal foreground program with `ps` (at most once
a second) and reports it as the pane's hosted process. The service then names
the pane and its coding agent the same way it names tmux and iTerm2 panes. A lost acknowledgment ends the connection and reports
uncertain delivery. The companion reads the current xterm buffer, including the
alternate screen, without moving or resizing the desktop view. Screen reads run
in the renderer, are limited to 32,000 cells, and retain no scrollback. The
socket carries bounded frames; terminal data and input are excluded from bridge
logs. The adapter has no network listener.

The shipping setup flow, desktop typing latency under heavy output, packaged
Linux builds, and end-to-end use with a mobile device still need qualification.

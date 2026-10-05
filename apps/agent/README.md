# shellbell

Your terminal rings. You answer.: Mac agent for [Shellbell](https://github.com/bilal-/shellbell).

Public npm installation is not available yet. Use a source checkout, or a computer preview from [GitHub Releases](https://github.com/bilal-/shellbell/releases). See the [source-install operations guide](https://github.com/bilal-/shellbell/blob/main/docs/install-agent.md).

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm -F shellbell build
node apps/agent/dist/cli.js
```

Requires macOS and Node 22+. Mirrors iTerm2, tmux (so Ghostty, Warp, Terminal.app, Alacritty,
Kitty and WezTerm work too) and [Herdr](https://herdr.dev) coding-agent panes, implemented in this checkout.
iTerm2's Python API (Settings → General → Magic) is only required for the native iTerm2 backend;
tmux and Herdr require a running local server. Terminal payloads between your phone and this
agent are end-to-end encrypted; relay control and push metadata are not.

A foreground run is not a background installation; the per-user LaunchAgent does not prevent
sleep. Windows host services remain deferred. Linux state, tmux-only foreground
hosting and systemd user-service management are implemented in source, with real
Linux/platform qualification still pending. This package still declares macOS;
the commands above are not a qualified Linux package-install recipe. See the
[Linux source workflow](https://github.com/bilal-/shellbell/blob/main/docs/install-agent.md#linux-systemd-user-service-source-workflow-qualification-pending)
and [current qualification](https://github.com/bilal-/shellbell/blob/main/docs/before-first-release.md#qualification-status).

See the [service architecture](https://github.com/bilal-/shellbell/blob/main/docs/architecture/README.md)
for backend capabilities, trust boundaries and known limitations.

# Shellbell

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/svg/horizontal-on-dark.svg">
  <img src="brand/svg/horizontal-on-light.svg" alt="Shellbell" width="280">
</picture>

Your terminal rings. You answer.

Keep using your computer's shell from your phone. Leave a build, a deployment or
a coding agent running, walk away, then read its output and respond in the **same
session**. Your processes, working directory and shell stay on your computer.

[Documentation](docs/README.md) · [Self hosting](docs/self-hosting.md) · [Contributing](CONTRIBUTING.md) · [Privacy](PRIVACY.md) · [shellbell.dev](https://shellbell.dev)

## Continue where you left off

1. Run the computer service and pair your phone by scanning its temporary QR code
   and approving the phone on the computer.
2. Open an existing terminal session on your phone. Follow live output or scroll
   back through available history; switch to Reading mode for text.
3. Send a command, type into an interactive program, or use keys such as Escape,
   Tab, arrows and Ctrl+C. Input goes back to that session on your computer.
4. Receive a notification when a command finishes, a session goes quiet or a
   supported coding agent needs attention. Open it to return to the terminal.

The phone and computer can use different networks. Both connect outward to a
reachable relay, so the relay path needs no shared Wi-Fi, inbound computer port
or manual SSH tunnel. The computer must remain awake, online and running the
service. Notifications do not keep it awake or prove a quiet command has finished.

Screens, history, titles and input are end-to-end encrypted between paired
devices. The relay routes ciphertext and sees connection and routing metadata;
[Privacy](PRIVACY.md) explains the boundary. Pairing grants control of the sessions
that the computer's OS user exposes.

## Terminals and shells

| Integration | What you can continue from your phone |
| --- | --- |
| iTerm2 | Existing tabs and panes through its native local API |
| tmux | Existing tmux panes, including those opened in Ghostty, Warp, Terminal.app, Alacritty, Kitty or WezTerm |
| Herdr | Terminal panes and supported coding-agent state through its local API |

Shellbell works with the shell running inside a supported session, including
zsh, bash and fish. Other terminal apps need their shell to run **inside tmux**;
installing tmux alone does not expose ordinary tabs. These are the three built-in
backend integrations, not separate native adapters for every terminal app.

The macOS service includes all three backends. The Linux headless path currently
uses tmux. See [backend behavior and limits](docs/architecture/computer-agent.md#terminal-backends)
and [extension points](docs/architecture/extensibility.md).

Current source also offers new tmux or Herdr sessions in a selected Ghostty or
iTerm2 window, including cold startup, and owner-enabled local adapters. See
[terminal adapters](docs/architecture/terminal-adapters.md) for prerequisites and
qualification status; these changes are separate from the published preview.

## Connection and project status

Mobile connections negotiate a direct WebRTC data channel using encrypted relay
signaling. Terminal traffic waits for the verified direct connection; if it drops,
the terminal pauses while Shellbell retries. You can explicitly choose temporary
encrypted relay fallback. The app shows the committed route and connection progress.
Both WebSockets stay connected for coordination. Same-network Android/Mac tests
have passed; the owner reports Fold 7 Wi-Fi/cellular recovery and successful iPad
use through TestFlight. Wider device/network checks and independent security review
remain part of launch qualification. See [how connections work](docs/how-shellbell-connects.md).

Shellbell is a public preview. [GitHub Releases](https://github.com/bilal-/shellbell/releases) lists the available computer previews and mobile testing candidates. Each release names its architectures, channel and qualification limits. Mobile internal testing requires an invitation; public npm and app-store installation are not available yet. Visit [shellbell.dev](https://shellbell.dev) for downloads and setup.

The [release checklist](docs/before-first-release.md) distinguishes implementation
from qualified artifacts and devices. A Windows host service and Linux desktop
app are not shipped.

## Setup

The [signed Mac 0.2.0 preview (build 14)](https://github.com/bilal-/shellbell/releases/tag/computer-v0.2.0-beta.14)
is available for Apple silicon, with notarization and download checksums.

The [macOS headless 0.1.1 preview](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.1-beta.11)
is available as an npm-format tarball with checksums and installation notes.

- [macOS app and computer service](apps/macos/README.md)
- [Service installation and troubleshooting](docs/install-agent.md)
- [Linux headless archives](apps/linux/README.md)
- [Native Android and iOS builds](docs/local-mobile-releases.md)
- [Your own relay](docs/self-hosting.md)

Push delivery uses direct FCM on Android and APNs on iOS. Expo libraries remain
in the app, but Expo's push service and cloud build service are not required.
Building your own notification-enabled app requires matching app identities and
provider credentials.

For contributors, use Node 22.23.1 and pnpm 11.12.0 from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Native prerequisites and additional checks are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Your relay, your infrastructure

Run the relay in your own Cloudflare account or use the standalone Node/SQLite
container on a server with private durable local storage. Authentication,
pairing, revocation, queue limits and notification policy live in a shared core;
Cloudflare and Node provide adapters for sockets, storage and scheduling.

- [Cloudflare deployment](docs/self-hosting.md#deploy-to-your-cloudflare-account)
- [Docker deployment](docs/self-hosting.md#standalone-container) and [TLS with Caddy](docs/self-hosting.md#tls-for-your-server-with-caddy)
- [Organization operations](docs/organization-relay.md)
- [Other runtime and database adapters](docs/relay-adapters.md)
- [WebRTC and relay capacity](docs/architecture/relay-capacity.md)

A different stack can reuse the core or implement its protocol contracts. It
still needs runtime, storage and recovery qualification. The supplied SQLite
server uses one process and one writer; shared volumes and automatic migration
from Cloudflare are not supported.

Set **Relay address** in the Mac app or run
`shellbell config set relay wss://relay.example.com` on the computer, then restart
its service. New pairing QR codes carry that address. Existing mobile computer
records expose **Relay URL** in settings. Both endpoints must agree; an empty
replacement relay may require pairing again. See [device connection steps](docs/self-hosting.md#connect-your-devices).

## Maintainer

Shellbell is a solo project by [Bilal](https://bilal.sh). Contributions,
feedback and thoughtful connections are welcome. I may be available to help
pro bono with causes I believe in; [contact me through my website](https://bilal.sh).

Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Documentation, releases and licenses

The [documentation index](docs/README.md) covers setup, architecture and operations.
The [versioning strategy](docs/versioning.md) gives computer, relay and mobile
components their own release lines; Android and iOS share the mobile version.
[CHANGELOG.md](CHANGELOG.md) tracks shipped changes when releases are prepared.

The code is under the [MIT License](LICENSE). Retain
[third-party notices](THIRD_PARTY_NOTICES.md), including xterm.js credits.
The name and logo have a separate [trademark policy](TRADEMARK.md);
the [brand kit](brand/README.md) contains the visual assets.

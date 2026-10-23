# Shellbell changelog

Computer, mobile and relay have independent release lines. Package changelogs
come from Changesets; this overview records shipped channels and their limits.
See [versioning and release rules](docs/versioning.md).

## Unreleased

### Computer 0.10.0 — release preparation

- Add a shared macOS/Linux CLI installer with a bundled runtime. Existing npm
  installation remains supported.
- Let managed Apple silicon CLI installations run confirmed `shellbell update`
  upgrades while retaining prior runtimes, identities and pairings. Service
  activation remains an explicit operator action.
- Clarify that commands running in terminal sessions can trigger macOS privacy
  prompts attributed to the app that launched them.

## 2026-10-22 Mobile 1.0.0 internal testing

### Mobile 1.0.0 — Android 19 / iOS 16

[Internal release record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.0.0-beta.11.1)

- Reset the pre-launch mobile version to 1.0.0, preserving all earlier 1.1.0
  beta features and original build identities. Native build numbers keep increasing.
- Frame smaller terminal grids without moving them as output changes. Keep history
  scrolling in the margins, horizontal panning, selection and mouse targeting.
- Both store assignments are verified: Google Play internal testing and the
  internal TestFlight group. Retained AAB/IPA hashes match the release record;
  Android bundle checks and iOS app/notification-extension version and signature
  checks passed. Physical checks on these exact builds and public store promotion
  remain separate.

## 2026-10-22 Computer 0.9.0

### Computer 0.9.0 — Mac build 31, npm CLI and Linux

[Release downloads](https://github.com/bilal-/shellbell/releases/tag/shellbell%400.9.0)

- Add **Settings → General → Check for Updates** to the Mac app, with compatible
  official installer and release-note links. Checks and downloads are explicit.
- Add `shellbell update --check` and confirmed Linux archive updates. Downloads
  are size/hash verified, previous runtimes and pairings are retained, and service
  activation remains a separate operator action. npm and source installs retain
  their original installation method.

The Apple-silicon Mac app passed signing, notarization, stapling, Gatekeeper,
bundle integrity and native WebRTC loopback checks. Linux archives passed
Ubuntu 22.04/24.04 installation/removal, WebRTC, tmux/locale and two-user tests
(ARM64 native; x64 emulated). The packaged updater passed an isolated synthetic
newer-release installation; public downloads match the qualified files. npm
publishes the same verified CLI tarball. Exact signed UI/device flows, clean-machine
Mac installation and real operator service recovery remain separate qualification.

Existing 0.8.0 installations need one manual upgrade to gain the updater. No relay
update, wire migration or re-pairing is required. Mobile terminal framing ships on
the independent mobile release line. See the
[upgrade guidance](docs/install-agent.md#upgrade-revoke-and-uninstall).

## 2026-10-22 Mobile internal testing

### Mobile 1.1.0 — Android 17 / iOS 14

[Internal release record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.9.1)

- Keep bounded terminal history across compatible reconnects and renderer reloads, load proven older pages, and show gaps and retention limits. Touch flicks scroll with momentum.
- Read supported Claude Code and Codex conversations after the computer owner enables **Show agent conversations**. This setting defaults off; conversation content travels only over the paired encrypted direct connection.
- Group **+** by terminal engine, then choose the available desktop app and **Fit phone**, **Custom**, or **Computer default** sizing. Hosts can adjust requested dimensions; existing windows are unchanged.
- Make waiting actions follow the prompt, keep Enter and navigation accessible, and let Close restore terminal keys, including Shift + Left.
- Fix native startup and unlock overlays, and update the Expo SDK patch dependencies.

Delivered to Google Play internal testing and TestFlight internal testing with store assignments verified. Artifact hashes, signing checks, and source CI passed; physical-device and broader network qualification of these exact store builds remain separate. These features accompany computer 0.8.0. No public store promotion, relay update, or re-pairing is required.

## 2026-10-21 Computer 0.8.0

### Computer 0.8.0 — Mac build 30, CLI tarball and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/shellbell%400.8.0)

- Retain bounded terminal history on compatible phones across reconnects and renderer reloads, request proven older pages, and show gaps and retention limits explicitly.
- Read supported Claude Code and Codex conversations from verified Herdr sessions after enabling **Show agent conversations** on the computer. The setting defaults off and applies live; records travel only over the paired encrypted direct connection.
- Compatible phones group new sessions by engine, offer available desktop hosts, and request an initial terminal size. Hosts may adjust requested dimensions. Existing windows stay unchanged; Herdr opens a separate window rather than a tab in an existing workspace.
- Recover from transient Herdr reads within bounded deadlines and prioritize ready terminal traffic over background conversation work.

The Mac download is signed, notarized and stapled. Linux ARM64 and x64 archives
passed Ubuntu 22.04/24.04 container installation, native WebRTC, tmux and two-user
checks (ARM64 native; x64 emulated). The official owner-Mac upgrade preserved
identity, pairings and settings. Broader device/network, clean-machine Mac,
power-helper and physical Linux service qualification remain open. No Intel Mac
app is included.

No relay update, storage migration or re-pairing is required. New phone features
need the accompanying mobile 1.1.0 internal candidate; prior phones retain their
negotiated behavior. The macOS CLI is published to npm as `shellbell@0.8.0`; its
registry tarball matches this release's verified download. Follow the
[upgrade and recovery guidance](docs/install-agent.md#upgrade-revoke-and-uninstall).

## 2026-10-17 Computer 0.7.0

### Computer 0.7.0 — Mac build 28, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/shellbell%400.7.0)

The first computer release on the stable `shellbell@X.Y.Z` tag, and the first on
npm (`npm install -g shellbell`, macOS). A 0.x version already signals that
Shellbell is still settling, so it is no longer labelled a preview.

- **One-line Linux install:**
  `curl -fsSL https://github.com/bilal-/shellbell/releases/download/shellbell%400.7.0/install.sh | sh`
  installs the archive for your CPU after checking its checksum. There is no Mac
  one-line installer yet.
- **Live tmux and Herdr streams:** phones that ask for it receive the terminal's
  own output, so scrolling, history and full-screen programs behave as on the
  computer. Herdr keeps up to 1,000 lines of history and an agent's whole
  conversation. Other phones keep using snapshots.
- **Terminals section in the Mac app:** iTerm2, tmux and Herdr each show whether
  they are ready and what to do if not. macOS is asked about iTerm2 only when you
  choose Connect iTerm2, and Shellbell no longer reads Git in Desktop, Documents,
  Downloads, iCloud Drive or external drives.
- Phones learn which app (Ghostty, iTerm2) shows each tmux or Herdr session, so
  new sessions open there.
- The Mac app stays usable after it refuses a settings save, shows the right
  status after a CLI install or upgrade, and can restore a previous CLI setup
  again. tmux discovery no longer hangs if tmux quits during startup.

No Intel Mac app. Linux archives passed container checks on Ubuntu 24.04 (ARM64
native, x64 emulated); physical-host and systemd user-service checks remain open.
Phones already on mobile 1.1.0 keep working with snapshots; live streams need
mobile 1.1.0 Android 16 / iOS 13, delivered to internal testing on 2026-10-18.

## 2026-10-12 TURN-optional previews

### Relay 0.3.0

[Release record](https://github.com/bilal-/shellbell/releases/tag/relay-v0.3.0)

- **Withholds TURN for computers that turn it off:** none of that computer's
  phones get TURN servers, and any a phone holds are cleared before the computer
  is announced. Turning TURN back on gives online phones servers right away.
- A phone may have one pairing request waiting at a time, so the computer's
  answer always reaches the socket that asked.

### Computer 0.6.0 — Mac build 22, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.6.0-beta.22)

- **TURN is optional.** It stays on by default. Turn it off in the Mac app
  (Settings → General → **Allow TURN fallback**) or with
  `shellbell config set turn off`, and no terminal data passes through a TURN
  server. Needs relay 0.3.0; with an older relay the computer logs a warning.
  Phones on networks that block direct connections then cannot reach the
  computer.
- A pairing invitation closes once its five attempts are used, and an approval
  in progress survives a relay reconnect.
- iTerm2 connections that stop answering, including an unanswered macOS
  Automation prompt, time out and retry instead of hanging.
- Mac settings save even when the relay URL or a custom accent is unchanged.
- A failed write while creating the computer's identity no longer leaves a
  partial file that blocks later starts.

Mobile 1.1.0 (Android 15 / iOS 12) is unchanged and needs no update.

## 2026-10-12 previews

### Relay 0.2.0

[Release record](https://github.com/bilal-/shellbell/releases/tag/relay-v0.2.0)

- **TURN fallback:** the Cloudflare relay gives signed-in devices 24-hour TURN
  credentials, so networks that block direct connections can still reach the
  terminal. TURN forwards only the encrypted data channel.
- **No terminal data on the relay:** the relay carries sign-in, pairing,
  connection setup and notifications only.
- Sign-in is always answered, even when a TURN request is slow or never returns.

### Computer 0.5.0 — Mac build 21, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.5.0-beta.21)

- **Upgrade first:** the computer now speaks only secure v2. A phone app from
  before secure v2 must be updated before it can connect.
- Terminal data travels only on the direct connection, through TURN when needed.
- Fixes from a whole-repository review: pairing limits across reconnects,
  notification enrollment on failed saves, a single identity on concurrent first
  starts, tmux captures and iTerm2 reconnects.

### Mobile 1.1.0 — Android build 15 / iOS build 12

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.7.1)

- Tapping the terminal no longer opens the phone keyboard or lets autocorrect
  type into the shell; the compose bar and Live keys field take typing.
- Speak only secure v2; use the relay's TURN servers when a direct connection
  is blocked.
- Tab no longer retypes a draft that is still being sent, and a notification's
  pending session open no longer pulls you back after you move elsewhere.
- Expo SDK 57 patch releases.

CI verified both internal store assignments. Physical checks on these builds
remain open.

## 2026-10-11 previews

### Mobile 1.1.0 — Android build 14 / iOS build 11

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.5.1)

- Show a new session's terminal when its first update arrives before the
  computer reports the screen size. Previously this left the terminal blank
  with "Terminal renderer stopped responding" until Reload.
- Keep the terminal's own error message instead of replacing it with
  "stopped responding" after ten seconds.

CI verified both internal store assignments. Physical checks on these builds
remain open.

### Computer 0.4.0 — Mac build 19, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.4.0-beta.19)

- **Upgrade first:** phones must sign their pairing key, so phones need a 1.1.0
  build from this train to pair again. Existing pairings are kept.
- **Behaviour change:** a session created from a phone always opens in a terminal
  window on the computer (iTerm2, or Ghostty for tmux/Herdr when iTerm2 is
  unavailable). The computer refuses when no terminal app can show it.
- Name sessions by project, agent and task, and keep long session lists within
  one message. Report full-screen tmux programs so phones can switch to Live keys.
- Keep tmux connected through text that looks like control-mode lines, close a
  just-started tmux session the computer cannot attach to, and ignore forged pane
  listings.

The Apple silicon DMG is Developer ID signed, notarized and stapled; Gatekeeper
accepts it. The macOS CLI archive passed an isolated install/version check. Linux
ARM64 passed container qualification on Ubuntu 24.04 and 22.04, and x64 on 24.04
under emulation. Physical-host, systemd user-service and second-Mac lifecycle
qualification remain open. No Intel Mac app is included.

### Mobile 1.1.0 — Android build 13 / iOS build 10

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.4.1)

- Sign the pairing key for computer 0.4.0, and open phone-created sessions on the
  computer.
- Fix Live keys Backspace pairing, typed text sent before a line, alternate-screen
  switching when Live keys is unavailable, and loading older history from the top.

CI verified both internal store assignments. Physical checks on these builds remain
open, including fast Backspace in Live keys on Android.

### Relay 0.1.0

[Release and deployment record](https://github.com/bilal-/shellbell/releases/tag/relay-v0.1.0)

- Limit unauthenticated sockets per computer (32 kept, 503 at 64 on Cloudflare)
  and across the Node relay (1024, `--max-pending-connections`).
- Deliver pairing answers to the requesting socket, and check revocation proofs
  on unpair requests.

Post-deployment health and version checks passed; storage and pairings were
unchanged. The hosted `/ws/*` edge rate-limit rule is not yet configured.

### App agreements

- Add Terms of Use and first launch agreement in the mobile and Mac apps, with separate confirmation before using a new custom relay address. Store these choices locally and document them in the Privacy notice.

### Build tools

- Update build-time SVG rendering to Sharp 0.35.5 and pin older toolchain
  dependencies to its fix for [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

## 2026-10-09 previews

### Mobile 1.1.0 — Android build 10 / iOS build 7

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.3.1)

- Restore vertical history swipes across the full viewport after zooming.
- Keep history positions through stream recovery and explain native history limits
  without offering ineffective retries. Stop requests at the retained boundary.
- Clarify direct typing and draft focus, improve control consistency and hide
  terminal toolbars while the software keyboard is open.
- Add iOS 27 scene support and refresh store screenshots and metadata.

Source CI and all 72 Chromium/WebKit terminal browser checks passed. CI verified
both internal store assignments, and exact crash diagnostics are retained
privately. Physical checks on the new store builds remain open, including the
Fold 7 zoom/swipe regression, keyboard behavior, notifications and network recovery.
Installation requires an internal-testing invitation.

### Computer 0.3.0 — Mac build 16, CLI and Linux

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.3.0-beta.16)

- Keep Herdr history aligned across trimmed and busy reads, and recover bounded
  terminal streams without losing acknowledgement state.
- Serialize input-triggered captures without counting read-only work as typing.
- Add owner-enabled terminal adapters and desktop launch choices, while retaining
  built-in session creation for older phones.
- Reject legacy pairing requests that cannot produce a usable pairing code.

The Apple silicon DMG is Developer ID signed, notarized and stapled. Exact
artifact integrity, privacy, Gatekeeper and anonymous download checks passed.
The macOS CLI archive passed isolated install/version/help/uninstall checks.
Linux ARM64 and x64 archives passed 20 isolated qualification runs across Ubuntu
22.04 and 24.04; x64 used emulation. Physical devices, broader Mac lifecycle and
native x64 boot remain separate qualification work. No Intel Mac app is included.

### Relay 0.0.4

[Release and deployment record](https://github.com/bilal-/shellbell/releases/tag/relay-v0.0.4)

- Deploy the current shared relay core and Cloudflare adapter with encrypted
  routing, pairing/revocation policy, atomic notification budgets and bounded
  queues. Keep direct FCM/APNs delivery and current protocol contracts.
- Preserve the hosted Durable Object namespace, migration history, configured
  variables and push credentials. Post-deployment health/version checks passed.
- Publish the matching standalone Node adapter as source. Container-registry
  publication and operator volume, TLS/proxy and backup/restore qualification
  remain separate.

## 2026-10-07 preview

### Mobile 1.1.0 — Android build 9 / iOS build 6

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.1.0-beta.2.1)

- Use xterm.js for live input, loaded history, search, touch selection and
  styled copy. Support host-native paste and one-use Shift/Ctrl/Alt controls;
  hide the phone key bar when a physical keyboard is attached.
- Add optional Herdr mouse clicks with a compatible host and Herdr CLI/server
  0.9.3 or newer. Show terminal adapter names and available desktop launch choices.
- Preserve history positions, selected text and pending composed input through
  updates. Reject oversized input before sending partial text or Enter keys.
- Prevent scrolling from causing redundant terminal repaints. Send unpairing
  to the relay before closing the connection, including legacy pairings.

Mobile review finished clean after three rounds and two regression-tested fixes.
Source CI and both internal store assignments passed; exact crash diagnostics
are retained privately. Physical checks of these new builds remain open,
including keyboard attachment, touch selection, accessibility, notifications
and Wi-Fi/cellular recovery. Installation still requires a testing invitation.

### Computer 0.2.0 — Mac build 15

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.2.0-beta.15)

- Start every app launch with power controls off. Settings choices last for the
  current app session; Start at Login does not restore keep-awake protection.
- Recover interrupted closed-lid helper setup during an explicit enable action,
  after verifying sleep restoration and ownership. Report administrator approval,
  idle, display and closed-lid state separately, with actionable recovery errors.
- Recover desktop service ownership after an unexpected child exit and report
  another service using the endpoint accurately. Package the loader for explicitly
  enabled local terminal plugins.
- Retain native build-tool compatibility fixes used for signed app packaging.

The Apple silicon DMG is Developer ID signed, notarized and stapled. The owner
upgraded to this exact build with identities and pairings preserved and confirmed
closed-lid operation. Source CI, bundle integrity, metadata and anonymous download
checks passed. Broader battery/sleep-wake, administrator lifecycle, clean-machine,
offline Gatekeeper and minimum-OS checks remain open. Intel is not included.
Closed-lid protection requires a power adapter; battery keep-awake is for an open
lid. See the [live checklist](docs/before-first-release.md).

## 2026-10-05 previews

### Computer 0.1.1 — macOS headless service

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.1-beta.11)

- Fix legacy macOS headless service start/restart without a service-instance UUID
  while preserving desktop ownership checks and foreground startup serialization.
- Correct the packaged README's Linux operator-guide link.
- Publish the npm-format CLI archive, source manifest and checksums. Exact-archive
  isolated installation, CLI version/help, license/metadata audits and source CI
  passed. Apple silicon with Node 22.23.1 is verified; real headless OS-service
  login/logout/reboot, Intel and Linux qualification remain separate.
- Preserve existing identities, pairings and wire compatibility. The public Mac
  app remains computer 0.1.0 build 5; this release includes no new app installer.

### Computer 0.1.0 — Mac build 5

[Release and downloads](https://github.com/bilal-/shellbell/releases/tag/computer-v0.1.0-beta.5)

- Publish a signed, notarized Apple silicon Mac installer and a macOS headless CLI
  tarball from reviewed public source, with source metadata and SHA-256 checksums.
- Mirror iTerm2, tmux and Herdr sessions; offer installed backend startup from an
  empty workspace. Include the Herdr live-stream observer correction.
- Negotiate authenticated WebRTC, retain encrypted relay coordination and
  bounded retries, and avoid automatically replaying uncertain input.
- Keep desktop-owned and headless service lifecycles separate. Reserve native Mac
  build numbers and derive marketing versions from the bundled service.
- Signature, notarization, Gatekeeper, bundle integrity, metadata and disposable
  CLI installation checks passed. Physical install/lifecycle and the full
  device/network matrix remain separate. Intel installers and qualified Linux
  archives are not included; Linux's tmux source workflow remains available.

### Mobile 1.0.0 — Android build 8 / iOS build 5

[Internal testing record](https://github.com/bilal-/shellbell/releases/tag/mobile-v1.0.0-beta.1.1)

- Deliver both native apps through request-triggered CI, verify Google Play and
  TestFlight internal assignment, then automatically tag the tested source and
  attach a public release manifest. Resume partial tagging failures safely.
- Use direct WebRTC in normal connections. Show the committed route, pause the
  terminal during recovery, retry on Wi-Fi/cellular changes and offer explicit
  temporary encrypted relay fallback. Include the iOS ICE locator correction.
- Use native FCM/APNs tokens and encrypted private notification context. Retain
  the notification extension and verified internal-store upload configuration.
- Keep the keyboard open while using quick keys, preserve bottom terminal rows,
  account for system navigation, and retain unsent drafts while disconnected.
- Add a Settings gear, subtle branding and installed version details. Explain
  automatic scaling and disabled font controls; retain wrapped Reading mode,
  optional WebGL with DOM fallback, native link opening and per-computer relay
  settings. Remove donation links.
- Enable Android R8 optimization, obfuscation and unused-resource shrinking.
  Preserve exact mappings, JavaScript maps and native symbols privately.
- Earlier iPad builds were confirmed for direct Wi-Fi/5G handoff, Herdr streaming
  and visible notifications. Qualification of these exact new artifacts remains
  separate from store acceptance. Installation requires a testing invitation.

The repository is public. Ordinary source pushes run CI; internal mobile delivery
requires an explicit release request. Major upgrades require owner discussion
and approval. These previews represent no stable release, npm publication or
public store promotion. See the [release checklist](docs/before-first-release.md)
for remaining qualification.

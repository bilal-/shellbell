# Shellbell documentation

<picture><source media="(prefers-color-scheme: dark)" srcset="../brand/svg/mark-on-dark.svg"><img src="../brand/svg/mark-on-light.svg" alt="" width="18" height="18"></picture>

[Project](../README.md) · [Changelog](../CHANGELOG.md) · [shellbell.dev](https://shellbell.dev)

These guides describe the current implementation. The
[release checklist](before-first-release.md) owns qualification status and remaining
gates. Plans, development diaries and dated review logs do not belong in this folder.

## Setup and use

- [How the phone and computer connect](how-shellbell-connects.md)
- [macOS app](../apps/macos/README.md)
- [Computer service installation and troubleshooting](install-agent.md)
- [Linux headless archives](../apps/linux/README.md)
- [Native mobile builds and internal distribution](local-mobile-releases.md)
- [Requested mobile internal delivery](mobile-ci-releases.md)
- [Terminal rendering and text selection](mobile-terminal-renderer.md)
- [Private notifications](private-notifications.md)

## Relay hosting and operations

- [Self hosting: Cloudflare or Docker with TLS](self-hosting.md)
- [Organization relay operations](organization-relay.md)
- [Runtime and database adapters](relay-adapters.md)
- [Standalone Node runtime](../apps/relay-node/README.md)
- [WebSockets, WebRTC and capacity planning](architecture/relay-capacity.md)
- [Relay routing and retention](architecture/relay.md)
- [Runtime boundaries and conformance](architecture/relay-portability.md)
- [Durable storage, revocation and recovery](architecture/relay-storage.md)

## Architecture and contracts

- [Architecture overview](architecture/README.md)
- [Design decisions and security boundaries](architecture/design.md)
- [Extensibility and remaining architectural work](architecture/extensibility.md)
- [Computer service and terminal backends](architecture/computer-agent.md)
- [Native controller and lifecycle](architecture/native-controller.md)
- [Mobile terminal presentation](architecture/mobile-terminal.md)
- [Direct transport and recovery](architecture/direct-transport.md)
- [Secure v2 wire profile](architecture/direct-transport-wire-v2.md)
- [Generated wire reference](protocol.md)
- [Local control v2](local-control-v2.md)
- [Bounded stream and history records](stream-history-records.md)

## Development and releases

- [Contributing](../CONTRIBUTING.md) and [coding-agent instructions](../AGENTS.md)
- [Versions, changelogs and compatibility](versioning.md)
- [Release note template](release-notes-template.md)
- [Before first release](before-first-release.md)
- [Mobile device QA](../apps/mobile/QA.md)
- [macOS signing and notarization](macos-release-signing.md)
- [Power-helper qualification](macos-power-helper-qualification.md)
- [Bundled runtime integrity](runtime-integrity.md)

[PRIVACY.md](../PRIVACY.md) owns the data inventory;
[TERMS.md](../TERMS.md) links to the current Terms of Use;
[SECURITY.md](../SECURITY.md) owns private reporting.
Retain [LICENSE](../LICENSE), [TRADEMARK.md](../TRADEMARK.md) and
[third-party credits](../THIRD_PARTY_NOTICES.md) with redistributed builds.
The [brand guide](../brand/README.md) owns the visual assets.

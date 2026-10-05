# Security policy

## Reporting a vulnerability

Contact [Bilal through his website](https://bilal.sh) privately with the affected
component, version, impact and steps to reproduce. Avoid terminal contents,
pairing secrets, private keys or access tokens. Please do not open a public issue
with exploit details.

Shellbell is a solo project maintained by [Bilal](https://bilal.sh). Disclosure
timing and credit can be coordinated privately; there is no guaranteed response
or fix schedule. The contact route must be checked before public launch.

## Scope

The following first-party code is in scope:

- Shared protocol and cryptography in `packages/protocol`.
- Relay policy in `packages/relay-core`, Cloudflare adapters in `apps/relay` and Node adapters in `apps/relay-node`.
- Computer service and terminal integration in `apps/agent`.
- Mobile client and native notification handlers in `apps/mobile`.
- Mac controller, helper and packaging in `apps/macos`, and Linux packaging in `apps/linux`.

Reports about authentication, revocation, bounded resource use or privacy in a
self-hosted adapter are relevant. Hosting-account compromise and unrelated
operator infrastructure are outside the application's trust boundary. A
compromised computer OS account or unlocked, physically accessible phone is an
accepted endpoint trust boundary. Report dependency vulnerabilities upstream;
include a Shellbell-specific impact when reporting them here.

No public supported-version schedule has been announced yet. Current mobile source
negotiates secure-v2 WebRTC in normal connections and pauses terminal traffic until
the direct route is ready. Encrypted relay terminal fallback requires an explicit
user choice; relay coordination and direct retries remain active. Independent
security review and wider device/network qualification remain required before
public release. See [release readiness](docs/before-first-release.md) and
[version compatibility](docs/versioning.md).

## Threat model

[Design and security boundaries](docs/architecture/design.md#threat-boundary)
define endpoint trust, network/relay adversaries, replay, availability and resource
limits. [PRIVACY.md](PRIVACY.md) owns the relay and notification data inventory.
Self hosting changes the operator; it does not qualify an independent security audit.

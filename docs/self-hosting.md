# Self-hosting the Shellbell relay

## Choose, deploy, connect

Shellbell supplies a Cloudflare adapter and a single-process Node 22.23.1
adapter. The shared relay core owns protocol policy; platform adapters own
storage, sockets and wakeups. For another stack, use the [adapter contract](relay-adapters.md).
Organizations can follow the [deployment and rollout guide](organization-relay.md).

You can run your own relay and point both devices at it. Choose one path:

| Deployment | What you provide | Next steps |
| --- | --- | --- |
| [Your Cloudflare account](#deploy-to-your-cloudflare-account) | Authorized Workers/Durable Objects account; optional domain | Deploy the Worker, turn its HTTPS origin into a WSS origin, then [connect your devices](#connect-your-devices). |
| [Your server](#standalone-container) | Docker host, private local durable volume, domain and TLS proxy | Start the Node container on loopback, [add TLS with Caddy](#tls-for-your-server-with-caddy), then [connect your devices](#connect-your-devices). |

Neither choice requires the project's hosted relay. Hosting costs, quotas and
notification credentials remain yours; an open-source license does not promise
free hosting or access to the official app's provider credentials. The stock app
can use your relay for terminals; background push requires your own matching app
identity/build and provider credentials. Review the notification requirements
below before choosing a deployment.

### Get the source

Use a source checkout or fork you can access. Install Git, **Node 22.23.1** and
Corepack, then from a new checkout:

```sh
git clone https://github.com/bilal-/shellbell.git
cd shellbell
corepack enable
pnpm install --frozen-lockfile
```

Repository access may require your Git credentials; do not assume anonymous
downloads are available. The checkout pins pnpm 11.12.0. The own-server path also
needs Docker. Install the [computer service](install-agent.md) and a compatible
[native mobile build](local-mobile-releases.md) separately; Expo Go is unsupported.
Keep this checkout's root as the starting directory for the deployment commands.

## What is supported today?

The supplied relay runs on **Cloudflare Workers with SQLite-backed Durable Objects**.
You can deploy it in your own account, independently of the project's hosted relay.
The alternative [standalone Node relay](../apps/relay-node/README.md) runs on Node
22.23.1 with one process and one private local SQLite volume. Its non-root Docker
image and offline backup/restore have local synthetic qualification on arm64 and
emulated amd64. Public ingress, production volumes, device delivery and VPS sizing
remain operator work. See [portability](architecture/relay-portability.md).
Node uses native synchronous `node:sqlite`, experimental in 22.23.1 with an
expected warning. Keep the runtime/container digest pinned; upgrades require
restart, ownership and backup/restore checks on the target host. Multiple writers,
replicas sharing SQLite, network filesystems, other storage adapters and automatic
Cloudflare-to-Node data transfer are unsupported.
See [operation and capacity planning](architecture/relay-capacity.md) for connection
flow, traffic examples and the measurements needed before publishing VM sizing.

The relay does not run your terminal service. Install [computer agent](install-agent.md)
or [Linux headless archive](../apps/linux/README.md) separately. The computer and phone
both connect outbound to the configured relay over WebSocket. Normal mobile
connections negotiate WebRTC through encrypted relay signaling. Terminal traffic
waits for direct readiness; temporary relay terminal fallback requires an explicit
user choice.

## Standalone container

Build from a clean source checkout. The Docker build context is allowlisted and
the Dockerfile copies only the relay/core/protocol source and manifests, never
mobile credentials, local identities, archives or agent execution state. Its base
is the [official Node image](https://hub.docker.com/_/node), pinned to
`node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`.
Inspect the multi-architecture index with `docker buildx imagetools inspect`
when upgrading the pin, then repeat target-host qualification.

```sh
docker build -f apps/relay-node/Dockerfile -t shellbell-relay:local .
docker volume create shellbell-data
docker run -d --name shellbell-relay --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --mount type=volume,src=shellbell-data,dst=/var/lib/shellbell \
  -p 127.0.0.1:8787:8787 shellbell-relay:local
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/readyz
```

The image listens on all container interfaces, while this published port binds only
host loopback. Add your own authenticated administration, TLS/WSS reverse proxy,
upgrade/rate protection and monitoring before making it reachable. Do not expose
unencrypted WS to the internet. Mount private FCM/APNs credential files at runtime as described below; never
bake them into the image or put their values in a command line or report.

A fresh Docker named volume inherits UID/GID 1000 and mode `0700`. Bind mounts must
already have that owner/mode, canonical paths and trusted ancestors; incompatible
mounts are rejected. Do not loosen permissions or run as root to bypass a rejection.
Use one local volume and one owning process, with no replicas/network filesystem.
Back up the volume and test restoration on the actual host storage before relying
on its durability. `/healthz` alone is not a readiness or data-integrity check.

### TLS for your server with Caddy

Run [Caddy](https://caddyserver.com/docs/install) on the **same host** as the
loopback-published Node container. Point a domain you control at that server and
permit inbound TCP 80/443. Keep 8787 bound to loopback. Start with the supplied
[Caddyfile](examples/Caddyfile), replacing `relay.example.com` with your domain:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy handles WebSocket upgrades and preserves the request URI; no `/ws` rewrite
or special Upgrade-header rule is needed. Clients dial
`wss://relay.example.com/ws/<computer-fingerprint>`, so proxy that complete path
unchanged. See the official [reverse-proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
With a reachable public domain, Caddy manages certificates and HTTP-to-HTTPS
redirects; its certificate data directory must be writable and persistent. Follow
[automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https),
including correct A/AAAA records and reachable ports. Do not use Caddy's local
certificate issuer as a substitute for certificates trusted by the phone.

After editing a private copy, validate and run it with your host's Caddy:

```sh
caddy validate --config /path/to/Caddyfile --adapter caddyfile
caddy run --config /path/to/Caddyfile --adapter caddyfile
```

The foreground command keeps the proxy running; arrange your host's normal
service supervision for continuous operation. Do not proxy Caddy's admin port or
put a browser-login challenge in front of the relay WebSocket endpoint: the
clients authenticate using the Shellbell protocol. Upgrade abuse controls and
host monitoring still require operator configuration.

From outside the server, check `https://YOUR-RELAY-HOST/healthz` and `/readyz`, then
use the base URL **`wss://YOUR-RELAY-HOST`** in the device steps below. The supplied
example was validated with an isolated official Caddy 2.10.2 container with no
network access. That checks configuration syntax/provisioning only, not public
DNS, certificates, firewall reachability or end-to-end device delivery. See
[Caddy validation semantics](https://caddyserver.com/docs/command-line#caddy-validate).

### Stop, backup, restore, start

These example names must be new for each backup and restore; existing names are
refused. Keep the old container stopped and its original database intact.

```sh
docker stop --time 15 shellbell-relay
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --mount type=volume,src=shellbell-data,dst=/var/lib/shellbell \
  shellbell-relay:local backup --source /var/lib/shellbell --destination /var/lib/shellbell/archives/backup-01.sqlite
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --mount type=volume,src=shellbell-data,dst=/var/lib/shellbell \
  shellbell-relay:local restore --source /var/lib/shellbell/archives/backup-01.sqlite --destination /var/lib/shellbell/restored-01
docker run -d --name shellbell-restored-01 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --mount type=volume,src=shellbell-data,dst=/var/lib/shellbell \
  -p 127.0.0.1:8787:8787 shellbell-relay:local serve --data-dir /var/lib/shellbell/restored-01 --host 0.0.0.0
curl --fail http://127.0.0.1:8787/readyz
```

The backup command creates the private `archives` child when absent. A successful
backup uses SQLite's consistent backup API under exclusive ownership and includes
committed WAL content. Copy completed archives to a separate protected backup
system; an archive on the same volume does not protect against volume loss.
Restoration validates offline into a new directory, then startup performs recovery.
Require readiness, review sanitized diagnostics and check synthetic authentication,
revocation and reconnect before switching ingress. A restored relay resumes durable
jobs; keep the previous deployment stopped. To roll back, stop the restored owner
before deliberately starting the previous stopped container. Review any state changes
since the backup before choosing rollback. Nothing automatically overwrites, deletes,
resets budgets or bypasses ownership. See [storage and recovery](architecture/relay-storage.md)
and [operator details](../apps/relay-node/README.md#offline-backup-and-restore).

## Cloudflare prerequisites

- Access to this source checkout or a fork, Node 22 and pnpm 11.12.0.
- A Cloudflare account authorized to deploy Workers and SQLite Durable Objects.
- A compatible computer service and native mobile build.
- Matching app identities and private FCM/APNs credentials if background push is needed.

Check current [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and account quotas before deployment. No guaranteed free-tier capacity or concurrent
user count is implied.

## Deploy to your Cloudflare account

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm -F @shellbell/relay test
pnpm -F @shellbell/relay typecheck
cd apps/relay
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler deploy --config wrangler.jsonc --dry-run
pnpm exec wrangler deploy --config wrangler.jsonc
```

Confirm the account before the last command: it creates or updates the
`shellbell-relay` Worker in that account. Pick a different Worker name in your
private deployment configuration if that name already belongs to another service.
Record the deployed version and URL.

Use **`wrangler.jsonc`**, not `wrangler.hosted.jsonc`: the latter binds the
project's hosted domain and is not a self-hoster template. Keep private credentials
outside Git. See [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)
for environment-based CI credentials; never copy someone else's account settings.

The deployment prints an HTTPS URL. The client relay setting uses the corresponding
**`wss://`** URL. A custom domain must be configured separately; do not assume the
example domain or another account's domain is available.
For example, `https://shellbell-relay.YOUR-SUBDOMAIN.workers.dev` becomes
`wss://shellbell-relay.YOUR-SUBDOMAIN.workers.dev`. Continue with
[Connect your devices](#connect-your-devices). The pinned Wrangler command's
`--dry-run` bundles without deploying; the last command deploys to the account
you confirmed. See the official [deploy reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy).

## Notifications are a separate dependency

The current path is `computer service → relay → FCM (Android) or APNs (iOS) → phone`.
The phone separately registers its native token with its paired relay. The relay
and selected provider see the token, routing/event metadata, generic text and
encrypted notification box; neither receives plaintext private labels or
terminal content. See [the privacy inventory](../PRIVACY.md).

A stock Shellbell app can connect to a self-hosted relay for terminals, but its
background push is not promised: app-owner provider keys are not distributed.
For push, build your own app with matching Android package/Firebase project and
iOS bundle/topic/team, notification extension, app group and signed entitlements.
There is no shared push gateway. `expo-notifications` supplies on-device APIs;
no Expo account, project ID, access token or Push Service is required.

### Prepare app identity and private credentials

Use [local mobile releases](local-mobile-releases.md) to build the app. Android
needs its matching Firebase client JSON via `SHELLBELL_GOOGLE_SERVICES_FILE`;
that client file is distinct from the server's private service-account JSON.
Enable FCM HTTP v1 in the matching Firebase project and authorize the relay's
service account to send Firebase messages. iOS needs an APNs-enabled signed host
plus a matching signed notification extension; registration supplies the development or
production environment. The APNs topic is the host bundle ID, not the extension
ID. Keep provider keys outside source, images, mobile binaries, QR codes and logs.

For your Worker, from `apps/relay`, provision only the providers you operate using
the interactive secret prompts (never put values in command arguments):

```sh
pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT_JSON --config wrangler.jsonc
pnpm exec wrangler secret put APNS_PRIVATE_KEY --config wrangler.jsonc
pnpm exec wrangler secret put APNS_TEAM_ID --config wrangler.jsonc
pnpm exec wrangler secret put APNS_KEY_ID --config wrangler.jsonc
pnpm exec wrangler secret put APNS_TOPIC --config wrangler.jsonc
```

`FCM_SERVICE_ACCOUNT_JSON` is the full private service-account JSON;
`APNS_PRIVATE_KEY` is the full .p8 signing key. Team/key IDs and topic must match
that app. Setting secrets changes the selected Worker: check the account and
config first. Cloudflare APNs transport reachability has been probed, but authenticated and
physical iOS delivery remain in [the release checklist](before-first-release.md).

For the Node relay, mount owner-readable credential files read-only at runtime.
Set `SHELLBELL_FCM_SERVICE_ACCOUNT_FILE` to the JSON path and
`SHELLBELL_APNS_PRIVATE_KEY_FILE` to the .p8 path. Supply
`SHELLBELL_APNS_TEAM_ID`, `SHELLBELL_APNS_KEY_ID` and `SHELLBELL_APNS_TOPIC`
through private process configuration. Restart the process after changing files
or settings; they are read at startup. See [Node runtime configuration](../apps/relay-node/README.md).
APNs uses verified HTTP/2 in Node; no HTTP/1.1 fallback is used.

### Rotate and qualify

Create replacement keys through your authorized provider account, stage them
privately, update the matching Worker secrets or Node files/settings, and restart
or redeploy the intended runtime. Confirm sanitized configuration diagnostics and
test provider acceptance plus background/locked display on the exact app build.
Then revoke the old provider key and retire its private copies according to your
backup policy. OAuth/APNs authorization is cached in process; replacing a file
alone does not reload it. Do not rotate device pairing or notification encryption
keys merely because a provider credential changed.

Missing/malformed credentials disable the affected push provider without breaking
terminal connections. Readiness is not proof of push configuration or delivery.
Deploy the additive direct-provider relay before installing updated mobile apps.
Old Expo registrations remain ineligible until an updated app reconnects and
registers its native token; they are never sent to a direct provider. Pending old
receipt jobs are retired without resending. Provider acceptance deletes new jobs,
but does not prove display or exactly-once delivery.

Use the [notification device QA](../apps/mobile/QA.md#direct-fcmapns-notifications) for rich/generic fallback,
two-session replacement and tap routing, permission denial, token rotation,
unpairing and signed development/production iOS builds. Keep each release gate
open until observed. No production deployment, key creation or store upload is
implied by passing source tests.

## Connect your devices

Use the **base WSS origin only**: `wss://YOUR-RELAY-HOST`, optionally with a port.
Do not enter `https://`, a trailing slash, `/ws`, another path, query, fragment
or URL credentials. Both clients append `/ws/<computer-fingerprint>` themselves;
the pairing QR rejects non-WSS public URLs and extra paths. A phone must be able
to reach the public hostname; its `127.0.0.1` is not your server.

1. Decide whether you are moving an existing pairing or creating a new one. Editing the relay URL preserves local identities and keys. If the destination has the matching pairing metadata, update both endpoints and reconnect. If it is a fresh relay, first unpair the old computer record while the old deployment is reachable, completing **Finish unpairing** if shown; then pair again after the move. Offline retirement is best-effort. A new QR cannot silently replace an existing paired-computer record.
2. On the intended computer's OS account, save the endpoint:

```sh
shellbell config set relay wss://YOUR-RELAY-HOST
```

If the CLI is not installed globally, build it with `pnpm -F shellbell build`
and replace `shellbell` above/below with
`pnpm -F shellbell exec node dist/cli.js` from the checkout root. Use the same
state directory/account as the service; an isolated checkout test identity is
not the installed computer identity.

3. Apply the saved setting; configuration is not hot-reloaded. For a headless
   installed service run `shellbell service restart`. For foreground operation,
   stop that process and rerun `shellbell start`. For desktop-owned operation,
   use the menu's **Stop Service…**, then **Start Service**, or Settings'
   **Restart…**. The desktop app also offers **Relay address** in its settings. Do not install a competing headless service.
4. For a new pairing, run `shellbell pair` or the desktop **Pair Device…** action. On the phone,
   tap **Pair one** or the **+** button, scan the new QR, check the computer fingerprint and
   approve the matching phone fingerprint on the computer. A fresh QR carries
   the saved relay URL; the phone persists it with the new computer record and
   uses that URL for subsequent connections. You can also edit **Relay URL** in that computer's settings on the phone. Saving reconnects only that computer and preserves its local pairing keys. Both devices must use the same relay; a new relay without the existing pairing metadata may require pairing again. There is no automatic live-state migration between deployments.
5. Verify session discovery, screen/input and reconnect against the chosen
   endpoint; qualify push separately as described above. Explicitly retire any
   superseded enrollments. See the
[device-retirement procedure](local-mobile-releases.md#retire-a-previous-app-installation-without-duplicate-notifications).
Do not delete identities or copy a live database as a shortcut.

## Verify and operate

1. Request `https://YOUR-RELAY-HOST/healthz`; `ok` proves HTTP reachability only.
2. Pair a test phone with a test computer account; verify session discovery,
   encrypted screen updates, input and reconnect.
3. With notification permission and valid push configuration, test a meaningful
   background notification. Provider acceptance is not proof of display.
4. Verify revocation, restart recovery, quotas, retention and upgrade controls
   before describing the deployment as production-qualified.

Persisted metadata and private notification ciphertext are described in
[PRIVACY.md](../PRIVACY.md). The relay does not store terminal transcripts.
Short-lived notification recovery is bounded, not an offline terminal queue;
see [relay internals](architecture/relay.md).

Add upgrade/request abuse protection at the public entry point. Application frame
limits do not protect unauthenticated HTTP upgrade traffic. Check coverage for
**every reachable hostname**, including workers.dev aliases; a zone rule must not
be assumed to protect a different hostname. See
[Cloudflare routing](https://developers.cloudflare.com/workers/configuration/routing/).
Do not publish a universal WAF rule or capacity claim without checking your plan.

Keep Worker identity, Durable Object migrations and data lifecycle deliberate
during upgrades. Record the previous deployment, validate the source and dry run,
and preserve required remote variables/secrets. A code rollback does not necessarily
undo data migrations. Do not delete the namespace to repair an application error.

The extraction preserves Worker/class/binding/namespace identity, runtime date,
migration tag, existing rows and legacy socket attachments. Keep both wrangler
configurations aligned and preserve those identities during upgrade. Do not
recreate the namespace or introduce a destructive migration to install the core.
Local reconstruction does not prove live eviction timing/account configuration.
Node has a separate schema/ownership model; its backups are not Cloudflare import
files. The [storage recovery contract](architecture/relay-storage.md) defines lifecycle
and corruption-handling limits.

## Direct transport and infrastructure dependencies

Changing the relay URL changes WebSocket signaling and fallback routing. It does
not configure TURN or change the native STUN server. Normal mobile connections
negotiate secure-v2 direct transport. The current adapters use Cloudflare STUN for
address discovery and have no TURN configuration. A STUN endpoint change requires
native adapter work and a new build. Direct attempts retain encrypted relay signaling;
terminal fallback requires an explicit temporary user choice. See
[how Shellbell connects](how-shellbell-connects.md).

Hosting your own relay gives you control of its metadata, storage and operations.
Background notifications still depend on FCM/APNs and matching app identities.
Use [PRIVACY.md](../PRIVACY.md) to assess those dependencies. Direct transport
can reduce terminal bandwidth, but both devices keep relay WebSockets; use
[capacity planning](architecture/relay-capacity.md) rather than a promised user count.

## Local development

`pnpm -F @shellbell/relay dev` runs Wrangler's local development runtime.
It is a development environment, not a production standalone-hosting recipe.
For isolated local agent testing use a disposable state directory and the explicit
`--relay ws://127.0.0.1:8787` override. A phone's loopback address is the phone
itself, not the developer computer. Never expose an insecure development listener
to the public internet.

# Relay operation and capacity planning

## What WebRTC changes

Each online computer service and each phone-to-computer link opens an outbound
WebSocket to `/ws/<computer-fingerprint>`. The relay authenticates those links
and coordinates pairing, revocation and notification delivery. Normal mobile
connections use encrypted relay signaling to negotiate a secure-v2 WebRTC data
channel. Terminal updates, history and input wait for the verified direct route;
the relay never carries terminal data.

Direct transport does not close the WebSockets or remove authentication, pairing,
retention, control and push work. If WebRTC fails, terminal traffic pauses while
periodic retries use encrypted relay signaling. A relay configured with Cloudflare
TURN issues short-lived credentials so devices on blocking networks connect
through TURN instead. Cloudflare bills TURN per GB sent to devices, separately from
Worker and Durable Object usage; issuing credentials adds about one Cloudflare API
call per computer every eight hours. See [connection flow](../how-shellbell-connects.md).

The relay stores no terminal history. Direct FCM/APNs delivery uses bounded,
short-lived notification jobs. Cloudflare may hibernate a coordinator while
retaining its sockets; with terminal traffic off the relay, wakeups come from
sign-in, signaling, control and notifications, but the actual billing and
capacity effect must be measured. The Node adapter remains a single process with a private local
SQLite volume. See [relay internals](relay.md) and [privacy](../../PRIVACY.md).

## Measure connections and events, not registered people

Track these quantities separately:

- **A:** online computer WebSockets.
- **C:** connected phone-to-computer links, including multiple computers on one phone.
- Sign-ins and reconnects per hour, including reconnect storms after outages.
- WebRTC setup and retry signaling per link, including links whose direct attempts keep failing.
- Notification jobs, provider latency and provider outages.
- Authentication CPU and database latency.

Approximate socket count remains `A + C`, plus pairing and unauthenticated
connections. The relay carries no terminal bytes, so relay bandwidth scales with
signaling, control and notifications rather than with viewed terminals. A link
that cannot connect directly keeps retrying through relay signaling with bounded
backoff; reserve headroom for many simultaneous retries and reconnects.

## Producing defensible hosting guidance

A VPS is a virtual machine; a VPC is a network boundary. No VM size in this
repository has a validated user count. For an operator study, 1 vCPU/1 GiB,
2 vCPU/2 GiB and 4 vCPU/4 GiB are possible **benchmark configurations**, not
recommended capacity tiers. Record CPU model, shared/dedicated allocation, disk
latency, file-descriptor limits, TLS termination, runtime version and volume type.

Use synthetic encrypted payloads in an isolated deployment. Exercise quiet
sockets, incremental output, bursts, slow recipients, small-frame floods,
reconnect storms, prolonged direct-retry signaling and provider failures separately.
Publish socket counts, sustained throughput, p50/p95/p99 forwarding latency,
CPU, RSS, event-loop lag, queue bytes, database latency and recovery behavior.
Verify expiry and revocation under load. Choose an interactive latency target
and operating headroom before converting measurements into sizing advice.

Bounded queues constrain application buffering; they do not prove a total RSS
limit. Protocol correctness and production sizing need separate evidence.

## Benchmark the actual deployment

The standalone runner starts an isolated relay child with synthetic identities,
ciphertext and fresh temporary SQLite state. It does not use real terminals,
owner pairing state or push credentials. Use it to compare quiet sockets,
incremental output, bursts, small frames, slow readers and reconnects. Defaults
include `--repeat 2 --warmup 0.5`:

```sh
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario quiet --computers 10 --viewers 2 --duration 2
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario incremental --computers 2 --viewers 2 --fps 20 --bytes-per-second 262144 --duration 2
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario burst --computers 2 --viewers 2 --fps 24 --bytes-per-second 1048576 --duration 2
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario small-frame --computers 2 --viewers 2 --fps 1000 --duration 2
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario slow-client --computers 1 --viewers 2 --fps 25 --bytes-per-second 3276800 --duration 8
pnpm -F @shellbell/relay-node exec node --import tsx bench/run.mjs --scenario reconnect --computers 3 --viewers 2 --fps 20 --duration 3
```

Short loopback runs are smoke checks, not measured hosting capacity. Repeat with
representative duration and concurrency on the intended host/container, TLS proxy
and durable volume. Record hardware, architecture/emulation, runtime, limits and
network conditions with each result; do not reuse old measurements after relevant
code or deployment changes.

The reports distinguish offered and received traffic, forwarding latency, relay
and generator resources, application queue reservations, database operation time,
intentional policy closes and unexpected errors. Rate-limited offered traffic is
not sustained delivered throughput. A paused reader may not observe its close until
it resumes, so inspect server close requests too.

Inbound/outbound budgets are independent. Their combined peak can exceed one
budget's ceiling, and neither includes opaque WebSocket/kernel buffers or total
RSS. Sampled database call time includes driver work and is not isolated fsync or
disk latency. Event-loop timer delay is separate from forwarding latency.

Container pairing/restart/ownership checks do not establish container throughput,
WAN behavior or power-loss durability. Use [the Node runtime guide](../../apps/relay-node/README.md)
for container qualification and [the release checklist](../before-first-release.md)
for target-host gates. Keep benchmark output with deployment/release evidence,
not as dated logs in this architecture guide.

## Cloudflare is a different capacity model

The current deployment has no VM size to select: per-computer Durable Objects
coordinate independently, subject to platform and account limits. Cloudflare's
[hibernation behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/) must
be evaluated against measured requests, duration, storage and traffic patterns.
Neither a platform maximum nor a low bill establishes Shellbell's tested capacity.

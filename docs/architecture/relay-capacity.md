# Relay operation and capacity planning

## What WebRTC changes

Each online computer service and each phone-to-computer link opens an outbound
WebSocket to `/ws/<computer-fingerprint>`. The relay authenticates those links
and coordinates pairing, revocation and notification delivery. Normal mobile
connections use encrypted relay signaling to negotiate a secure-v2 WebRTC data
channel. Terminal updates, history and input wait for the verified direct route;
relay terminal traffic requires an explicit temporary user choice.

A successful direct connection saves relay terminal bandwidth. It does not close
the WebSockets or remove authentication, pairing, retention, control and push work.
If WebRTC fails, terminal traffic pauses while periodic retries use encrypted relay
signaling. Users can choose temporary encrypted relay terminal fallback; successful
direct recovery ends that exception. No TURN server is configured. See
[connection flow](../how-shellbell-connects.md).

The relay stores no terminal history. Direct FCM/APNs delivery uses bounded,
short-lived notification jobs, separate from terminal traffic. Cloudflare may
hibernate a coordinator while retaining its sockets; direct terminal traffic
can reduce forwarding wakeups, but the actual billing and capacity effect must
be measured. The Node adapter remains a single process with a private local
SQLite volume. See [relay internals](relay.md) and [privacy](../../PRIVACY.md).

## Measure connections and bytes, not registered people

Track these quantities separately:

- **A:** online computer WebSockets.
- **C:** connected phone-to-computer links, including multiple computers on one phone.
- **V:** active viewed terminal streams, including fan-out to several viewers.
- **Q:** average terminal bytes per second per viewed stream, with burst percentiles.
- **D:** fraction of terminal bytes carried directly, weighted by traffic rather than a count of devices.
- Frame rate, reconnect/authentication CPU, database latency, notification jobs and provider outages.

Approximate socket count remains `A + C`, plus pairing and unauthenticated
connections. Approximate phone-facing terminal egress is:

```text
Relay terminal bytes/second ≈ V × Q × (1 − D)
Relay terminal GiB ≈ total viewed hours × Q × 3600 × (1 − D) / 2^30
```

Count computer ingress, reverse input, control traffic, TLS/WebSocket overhead
and push-provider traffic separately. Several recipients can multiply egress
without multiplying a source stream's ingress. Measure `D` over bytes and time;
a direct connection carrying little traffic does not save as much as a busy one.

## Worked example: assumptions, not hosting guarantees

Assume **40 active views**, each continuously receiving **20 KiB/s**. Exclude
protocol overhead and all other relay work:

| Terminal bytes carried directly | Relay terminal egress | Relay terminal egress per hour |
| --- | ---: | ---: |
| 0% | 6.55 Mbit/s | 2.75 GiB |
| 50% | 3.28 Mbit/s | 1.37 GiB |
| 90% | 0.66 Mbit/s | 0.27 GiB |

These are arithmetic examples, not measured capacity. Direct transport can let
a bandwidth-bound relay support more active traffic, but it does not imply the
same multiplier for connected users, memory, authentication throughput or push
capacity. A busy direct stream that falls back can immediately add its full
traffic to the relay; reserve headroom for simultaneous fallback and reconnects.

## Producing defensible hosting guidance

A VPS is a virtual machine; a VPC is a network boundary. No VM size in this
repository has a validated user count. For an operator study, 1 vCPU/1 GiB,
2 vCPU/2 GiB and 4 vCPU/4 GiB are possible **benchmark configurations**, not
recommended capacity tiers. Record CPU model, shared/dedicated allocation, disk
latency, file-descriptor limits, TLS termination, runtime version and volume type.

Use synthetic encrypted payloads in an isolated deployment. Exercise quiet
sockets, incremental output, bursts, slow recipients, small-frame floods,
reconnect storms, direct-to-relay fallback and provider failures separately.
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

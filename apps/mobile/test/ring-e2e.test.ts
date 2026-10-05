import {
  fingerprint,
  generateIdentity,
  type Identity,
  type InnerMessageLoose,
  randomBytes,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventEngine } from "../../agent/src/events.js";
import { createLogger } from "../../agent/src/log.js";
import { Notifier } from "../../agent/src/notifier.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { ComputerConnection, type ConnectionOptions } from "../src/net/connection.js";
import type { Status } from "../src/store/connections.js";

const waitFor = (fn: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });

const mac = generateIdentity();
const phone = generateIdentity();
const macFp = fingerprint(mac.ed25519.pub);
const phoneFp = fingerprint(phone.ed25519.pub);
const kPair = randomBytes(32);
const PUSH_TOKEN = "ExponentPushToken[ring-e2e-fixed]";

/**
 * The agent side of the harness: the same RelayClient + PhoneLink wiring as
 * `connection.test.ts`'s `fakeAgent`, plus a real EventEngine (injected clock) and a real
 * Notifier wired exactly as `apps/agent/src/agent.ts:158-160` does --
 * `events.on("event", (ev) => phoneLink.send(ev))` and `events.on("ring", (r) => notifier.ring(r))`.
 */
async function fakeAgentWithEvents(
  relay: FakeRelay,
  mac: Identity,
  kPair: Uint8Array,
  phoneFp: string,
  now: () => number,
) {
  const fp = fingerprint(mac.ed25519.pub);
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity: mac,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  let link: PhoneLink | null = null;
  const events = new EventEngine({
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4_000,
    idleMinActiveMs: 1_500,
    now,
  });
  const notifier = new Notifier((m) => rc.sendCtrl(m), log);
  events.on("event", (ev) => {
    link?.send(ev);
  });
  events.on("ring", (r) => {
    notifier.ring(r);
  });
  rc.on("ctrl", (m) => {
    if (m.type !== "phone-connected") return;
    link = new PhoneLink({
      phoneFp,
      connId: m.connId,
      name: m.name,
      kPair,
      computerFp: fp,
      send: (e) => {
        rc.sendEnvelope(e);
      },
      log,
    });
  });
  rc.on("e2e", (env) => {
    if (env.v !== 1) throw new Error("unexpected v2 in legacy test");
    const current = link;
    if (!current) return;
    const was = current.handshaken;
    current.handleEnvelope(env);
    if (!was && current.handshaken) {
      current.send({
        type: "hello",
        agentVersion: "t",
        backends: [],
        computerName: "MBP",
        accent: "emerald",
      });
    }
  });
  rc.start();
  await waitFor(() => rc.online);
  return { rc, events };
}

function makeConn(relay: FakeRelay, over: Partial<ConnectionOptions> = {}) {
  const inner: InnerMessageLoose[] = [];
  const statuses: Status[] = [];
  const c = new ComputerConnection({
    computerFp: macFp,
    relayUrl: relay.url,
    identity: phone,
    phoneFp,
    phoneName: "iPhone",
    appVersion: "t",
    kPair,
    pushToken: async () => ({ token: PUSH_TOKEN, platform: "ios", enabled: true }),
    onInner: (m) => inner.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: WebSocket as never,
    backoffMinMs: 50,
    backoffMaxMs: 100,
    ...over,
  });
  return { c, inner, statuses };
}

describe("ring end-to-end (spec 8.8, 10.8, 11.3): FakeRelay + real Agent/EventEngine/Notifier + mobile ComputerConnection", () => {
  let relay: FakeRelay;
  let agent: Awaited<ReturnType<typeof fakeAgentWithEvents>>;
  let conn: ReturnType<typeof makeConn>;
  let t = 1_000_000;
  const now = () => t;

  beforeEach(async () => {
    t = 1_000_000;
    relay = new FakeRelay(macFp);
    await relay.start();
    agent = await fakeAgentWithEvents(relay, mac, kPair, phoneFp, now);
    conn = makeConn(relay);
    conn.c.connect();
    await waitFor(() => conn.inner.some((m) => m.type === "hello"));
  });

  afterEach(async () => {
    conn.c.close("user");
    agent.rc.stop();
    await relay.stop();
  });

  it("rings prompt and blocked over the real path, skips idle-dedupe and short commands, and gates lease/push-token", async () => {
    // Step 6 (spec 11.3, 10.8): the phone's own ctrl traffic, sent once on auth-ok. The lease is
    // what tells the relay this phone is connected so a ring here must be suppressed rather than
    // pushed -- the relay's actual push-gating logic is `apps/relay/test/push.test.ts`'s job, not
    // this test's.
    await waitFor(() =>
      relay.ctrlFromPhones.some((r) => r.fp === phoneFp && r.msg.type === "lease"),
    );
    const lease = relay.ctrlFromPhones.find((r) => r.fp === phoneFp && r.msg.type === "lease");
    expect(lease?.msg).toMatchObject({ type: "lease", ttlMs: 60_000 });
    await waitFor(() =>
      relay.ctrlFromPhones.some((r) => r.fp === phoneFp && r.msg.type === "push-token"),
    );
    const pushToken = relay.ctrlFromPhones.find(
      (r) => r.fp === phoneFp && r.msg.type === "push-token",
    );
    expect(pushToken?.msg).toMatchObject({
      type: "push-token",
      token: PUSH_TOKEN,
      enabled: true,
    });

    // Scenario: prompt -- a command >= notifyMinCommandMs rings.
    agent.events.onBackendEvent({
      type: "command-start",
      sessionId: "s-prompt",
      command: "make",
      at: now(),
    });
    t += 15_000;
    agent.events.onBackendEvent({
      type: "command-end",
      sessionId: "s-prompt",
      exitCode: 0,
      at: now(),
    });
    await waitFor(() => conn.inner.some((m) => m.type === "event" && m.sessionId === "s-prompt"));
    const promptEvent = conn.inner.find((m) => m.type === "event" && m.sessionId === "s-prompt");
    if (promptEvent?.type !== "event") throw new Error("test setup: no prompt event received");
    expect(promptEvent).toMatchObject({ kind: "prompt", exitCode: 0 });
    expect(promptEvent.durationMs).toBeGreaterThanOrEqual(15_000);
    await waitFor(() =>
      relay.ctrlFromAgent.some((m) => m.type === "notify" && m.sessionId === "s-prompt"),
    );
    expect(
      relay.ctrlFromAgent.find((m) => m.type === "notify" && m.sessionId === "s-prompt"),
    ).toMatchObject({ type: "notify", kind: "prompt", exitCode: 0 });

    // Scenario: idle -- >=1.5 s of activity then >=4 s of quiet rings once the 1 Hz sweep runs.
    agent.events.onBackendEvent({ type: "screen-changed", sessionId: "s-idle" });
    t += 2000;
    agent.events.onBackendEvent({ type: "screen-changed", sessionId: "s-idle" });
    t += 5000;
    agent.events.tick();
    await waitFor(() => conn.inner.some((m) => m.type === "event" && m.sessionId === "s-idle"));
    expect(conn.inner.find((m) => m.type === "event" && m.sessionId === "s-idle")).toMatchObject({
      type: "event",
      kind: "idle",
    });
    await waitFor(() =>
      relay.ctrlFromAgent.some((m) => m.type === "notify" && m.sessionId === "s-idle"),
    );
    expect(
      relay.ctrlFromAgent.find((m) => m.type === "notify" && m.sessionId === "s-idle"),
    ).toMatchObject({ type: "notify", kind: "idle" });

    // Scenario: blocked (04b, Herdr) -- the first agent-state a session ever sees never rings
    // (agent start / herdr reconnect adopts state silently, events.ts:137-139); the transition
    // into `blocked` does, so a prior non-null state (`working`) must be sent first.
    agent.events.onBackendEvent({
      type: "agent-state",
      sessionId: "s-blocked",
      state: "working",
      at: now(),
    });
    agent.events.onBackendEvent({
      type: "agent-state",
      sessionId: "s-blocked",
      state: "blocked",
      at: now(),
    });
    await waitFor(() => conn.inner.some((m) => m.type === "event" && m.sessionId === "s-blocked"));
    expect(conn.inner.find((m) => m.type === "event" && m.sessionId === "s-blocked")).toMatchObject(
      { type: "event", kind: "blocked" },
    );
    await waitFor(() =>
      relay.ctrlFromAgent.some((m) => m.type === "notify" && m.sessionId === "s-blocked"),
    );
    expect(
      relay.ctrlFromAgent.find((m) => m.type === "notify" && m.sessionId === "s-blocked"),
    ).toMatchObject({ type: "notify", kind: "blocked" });

    // Step 7 (spec 8.8): a command under notifyMinCommandMs (10_000) emits the `event` but never
    // rings -- no `notify` ctrl reaches the relay for this session.
    agent.events.onBackendEvent({
      type: "command-start",
      sessionId: "s-short",
      command: "ls",
      at: now(),
    });
    t += 2000;
    agent.events.onBackendEvent({
      type: "command-end",
      sessionId: "s-short",
      exitCode: 0,
      at: now(),
    });
    await waitFor(() => conn.inner.some((m) => m.type === "event" && m.sessionId === "s-short"));

    // M12: don't trust the negative assertion below on timing alone -- `notify` travels
    // agent->relay directly while `event` needs a second relay->phone hop, so checking
    // `relay.ctrlFromAgent` right after the phone sees the `event` could still race a wrongly
    // emitted `notify` that just hasn't landed yet. Give it an ordering barrier: run a second,
    // independent command that DOES cross notifyMinCommandMs and wait for *that* session's
    // `notify` to actually reach the relay first. The agent's event/ctrl pipeline is
    // single-threaded and processes backend events in the order they're delivered, so by the
    // time s-after-short's `notify` has arrived, any notify wrongly emitted for the earlier
    // s-short command would already be sitting in `relay.ctrlFromAgent` too.
    agent.events.onBackendEvent({
      type: "command-start",
      sessionId: "s-after-short",
      command: "sleep 15",
      at: now(),
    });
    t += 12_000;
    agent.events.onBackendEvent({
      type: "command-end",
      sessionId: "s-after-short",
      exitCode: 0,
      at: now(),
    });
    await waitFor(() =>
      relay.ctrlFromAgent.some((m) => m.type === "notify" && m.sessionId === "s-after-short"),
    );

    expect(relay.ctrlFromAgent.some((m) => m.type === "notify" && m.sessionId === "s-short")).toBe(
      false,
    );
  });
});

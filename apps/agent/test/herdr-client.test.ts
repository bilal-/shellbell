import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HerdrClient,
  HerdrError,
  herdrSocketPath,
  semverAtLeast,
} from "../src/backends/herdr/client.js";
import { BackendUnavailable } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let herdr: FakeHerdr;

beforeEach(async () => {
  herdr = new FakeHerdr();
  await herdr.start();
});
afterEach(async () => {
  await herdr.stop();
});

const client = (timeoutMs = 500) =>
  new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: timeoutMs });

describe("herdrSocketPath", () => {
  it("prefers HERDR_SOCKET_PATH, then HERDR_SESSION, then XDG, then ~/.config", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/tmp/x.sock" }, "/home/u")).toBe("/tmp/x.sock");
    expect(herdrSocketPath({ HERDR_SESSION: "work" }, "/home/u")).toBe(
      "/home/u/.config/herdr/sessions/work/herdr.sock",
    );
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg", HERDR_SESSION: "work" }, "/home/u")).toBe(
      "/cfg/herdr/sessions/work/herdr.sock",
    );
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/herdr/herdr.sock");
    expect(herdrSocketPath({}, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
  });
});

describe("semverAtLeast", () => {
  it("compares numerically and reports unparseable versions as null", () => {
    expect(semverAtLeast("0.8.2", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.2", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.10", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.10.0", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.1", [0, 7, 2])).toBe(false);
    expect(semverAtLeast("0.6.9", [0, 7, 2])).toBe(false);
    expect(semverAtLeast("1.0.0-rc.1", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("master", [0, 7, 2])).toBeNull();
  });
});

describe("HerdrClient.request", () => {
  it("uses one connection per request and never pipelines", async () => {
    const c = client();
    herdr.reply("pane.get", (p) => ({ type: "pane_info", pane: { pane_id: p.pane_id } }));
    const a = await c.request<{ type: string }>("ping", {});
    const b = await c.request<{ type: string; pane: { pane_id: string } }>("pane.get", {
      pane_id: "w1:p1",
    });
    expect(a.type).toBe("pong");
    expect(b.pane.pane_id).toBe("w1:p1");
    expect(herdr.connections).toBe(2);
    expect(herdr.ignoredLines).toEqual([]);
  });

  it("maps a herdr error response onto HerdrError with its code", async () => {
    herdr.fail("pane.read", "pane_not_found", "pane not found");
    await expect(client().request("pane.read", { pane_id: "w9:p9" })).rejects.toMatchObject({
      name: "HerdrError",
      code: "pane_not_found",
    });
  });

  it("accepts a response whose id does not echo ours, and rejects a missing result", async () => {
    // One request per connection means the id is decorative; a mismatch must not deadlock us.
    herdr.reply("pane.get", () => ({ type: "pane_info", pane: { pane_id: "w1:p1" } }));
    await expect(client().request("pane.get", {})).resolves.toMatchObject({ type: "pane_info" });
    herdr.reply("session.snapshot", () => undefined);
    await expect(client().request("session.snapshot", {})).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("times out a request the server never answers", async () => {
    herdr.silence("session.snapshot");
    const err = await client(120)
      .request("session.snapshot", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("timeout");
  });

  it("reports a missing socket as `unavailable`", async () => {
    const c = new HerdrClient({ log, socketPath: join(herdr.dir, "gone.sock") });
    await expect(c.request("ping", {})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("accepts a 2 MiB response line (responses get their own, larger byte cap)", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    herdr.reply("pane.read", () => ({ type: "pane_read", read: { text: big } }));
    // The subject here is the byte cap, not the deadline, so do not let `client()`'s 500 ms test
    // default be the binding constraint: moving 2 MiB through the socket and parsing it overruns
    // that on a loaded runner, which failed as a spurious `herdr timeout` (2026-09-15).
    const result = await client(10_000).request<{ read: { text: string } }>("pane.read", {});
    expect(result.read.text).toHaveLength(big.length);
  });
});

describe("HerdrClient.ping", () => {
  it("returns the pong for a supported version", async () => {
    const pong = await client().ping();
    expect(pong).toMatchObject({ version: "0.8.2", protocol: 20 });
  });

  it("refuses an old herdr by VERSION, not by protocol number", async () => {
    // protocol 22 with an old version must still be refused: `protocol` is herdr's binary
    // client/server generation, not a JSON-API compatibility floor.
    herdr.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 22 }));
    const err = await client()
      .ping()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).message).toMatch(/0\.6\.9/);
    expect((err as BackendUnavailable).hint).toMatch(/0\.7\.2/);
  });

  it("accepts an unparseable version and lets the feature probe decide", async () => {
    herdr.reply("ping", () => ({ type: "pong", version: "dev-master", protocol: 3 }));
    await expect(client().ping()).resolves.toMatchObject({ version: "dev-master" });
  });

  it("turns a missing socket into BackendUnavailable with the install hint", async () => {
    const c = new HerdrClient({ log, socketPath: join(herdr.dir, "gone.sock") });
    const err = await c.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).hint).toMatch(
      /curl -fsSL https:\/\/herdr\.dev\/install\.sh/,
    );
  });
});

describe("HerdrClient.subscribe", () => {
  it("resolves on the ack, streams bare event lines, and reports EOF", async () => {
    const events: string[] = [];
    const ends: string[] = [];
    const stream = await client().subscribe(
      [{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      {
        onEvent: (e) => events.push(`${e.event}:${String(e.data.pane_id ?? "")}`),
        onEnd: (reason) => ends.push(reason),
      },
    );
    await waitFor(() => herdr.streamCount === 1);
    herdr.pushEvent("pane_created", { pane_id: "w1:p4" });
    herdr.pushEvent("pane.agent_status_changed", { pane_id: "w1:p1", agent_status: "blocked" });
    // Not subscribed for this pane: the fake must not deliver it.
    expect(herdr.pushEvent("pane.agent_status_changed", { pane_id: "w9:p9" })).toBe(0);
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["pane_created:w1:p4", "pane.agent_status_changed:w1:p1"]);

    herdr.dropStreams();
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual(["eof"]);
    stream.close();
  });

  it("delivers an ack and an event that arrive in one chunk", async () => {
    // The ack and the first event really do share ONE TCP chunk here (`ackRider` makes the fake
    // emit them in a single `socket.write`). The event must not be lost, and it must reach
    // `onEvent` even though `pipeLines` runs it before the caller's `await` below resumes --
    // which is exactly why `subscribe`'s contract says the caller must arm its buffer first.
    const events: string[] = [];
    herdr.ackRider.push({ event: "pane_created", data: { pane_id: "w1:p9" } });
    const stream = await client().subscribe([{ type: "pane.created" }], {
      onEvent: (e) => events.push(e.event),
      onEnd: () => undefined,
    });
    await waitFor(() => events.length === 1);
    expect(events).toEqual(["pane_created"]);
    stream.close();
  });

  it("splits coalesced lines and reassembles a UTF-8 sequence torn across chunks", async () => {
    const events: string[] = [];
    const stream = await client().subscribe([{ type: "pane.updated" }], {
      onEvent: (e) => events.push(String(e.data.title ?? "")),
      onEnd: () => undefined,
    });
    await waitFor(() => herdr.streamCount === 1);
    // Two complete NDJSON lines in one buffer, split mid-way through the last multi-byte
    // character: `chunk.toString()` would corrupt it, `StringDecoder` must not.
    const bytes = Buffer.from(
      `${JSON.stringify({ event: "pane_updated", data: { title: "one" } })}\n` +
        `${JSON.stringify({ event: "pane_updated", data: { title: "漢字" } })}\n`,
      "utf8",
    );
    const cut = bytes.length - 4; // lands inside the final wide character's bytes
    herdr.pushBytes(bytes.subarray(0, cut));
    herdr.pushBytes(bytes.subarray(cut));
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["one", "漢字"]);
    stream.close();
  });

  it("reports `closed` when we close the stream ourselves", async () => {
    const ends: string[] = [];
    const stream = await client().subscribe([], {
      onEvent: () => undefined,
      onEnd: (reason) => ends.push(reason),
    });
    stream.close();
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual(["closed"]);
  });

  it("rejects immediately when the socket dies before the ack", async () => {
    // Regression: a pre-ack EOF used to hang for the full 5 s ack timeout.
    herdr.silence("events.subscribe");
    const c = client(5000);
    const started = Date.now();
    const p = c.subscribe([], { onEvent: () => undefined, onEnd: () => undefined });
    await waitFor(() => herdr.connections >= 1);
    // `silence` accepted the connection and never answered, so it was never registered as a
    // stream -- `dropStreams()` would miss it. `stop()` destroys EVERY accepted socket (see the
    // fake's `sockets` set), which is both what kills this connection and what stops `stop()`
    // itself from hanging on it. `afterEach`'s second `stop()` is a no-op.
    await herdr.stop();
    await expect(p).rejects.toMatchObject({ code: "closed" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects when the subscription is refused", async () => {
    herdr.fail("events.subscribe", "invalid_params", "unknown subscription type");
    await expect(
      client().subscribe([{ type: "pane.output_changed" }], {
        onEvent: () => undefined,
        onEnd: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("ends the stream with an error when a post-ack line exceeds the byte limit", async () => {
    const ends: string[] = [];
    const stream = await client(5000).subscribe([{ type: "pane.updated" }], {
      onEvent: () => undefined,
      onEnd: (reason) => ends.push(reason),
    });
    await waitFor(() => herdr.streamCount === 1);
    herdr.pushRaw("x".repeat(1_048_577)); // no newline: an unterminated, oversized line
    await waitFor(() => ends.length === 1, 3000);
    expect(ends).toEqual(["overflow"]);
    stream.close();
  });
});

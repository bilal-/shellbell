import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { decodeEnvelope } from "@shellbell/protocol";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.ts";
import { connect } from "../test/client.ts";
import { distribution, environment } from "./report.mjs";

function options() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "host",
        "computers",
        "viewers",
        "duration",
        "warmup",
        "bytes-per-second",
        "fps",
        "scenario",
        "repeat",
      ].map((key) => [key, { type: "string" }]),
    ),
  });
  const host = values.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host))
    throw new Error("Only literal loopback destinations are permitted");
  const number = (key, fallback, min, max, integer = true) => {
    const value = values[key] === undefined ? fallback : Number(values[key]);
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isSafeInteger(value))
    )
      throw new Error("Invalid synthetic load parameter");
    return value;
  };
  const scenario = values.scenario ?? "incremental";
  if (
    !["quiet", "incremental", "burst", "small-frame", "slow-client", "reconnect"].includes(scenario)
  )
    throw new Error("Unknown synthetic scenario");
  return {
    host,
    scenario,
    computers: number("computers", 1, 1, 100),
    viewers: number("viewers", 1, 1, 5),
    duration: number("duration", 2, 0.1, 600, false),
    warmup: number("warmup", 0.5, 0, 60, false),
    bytesPerSecond: number("bytes-per-second", 32768, 1, 67108864),
    fps: number("fps", 20, 1, 1000),
    repeat: number("repeat", 2, 1, 10),
  };
}
async function run(config) {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "shellbell-synthetic-bench-"));
  const child = fork(new URL("./server.mjs", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let serverDiagnostics = 0;
  child.stderr.on("data", () => {
    serverDiagnostics++;
  });
  const request = (message, expected) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Synthetic relay response timed out")),
        10000,
      );
      const onExit = () => finish(new Error("Synthetic relay exited"));
      const onMessage = (value) => {
        if (value.type === expected) finish(null, value);
        else if (value.type === "failed") finish(new Error("Synthetic relay failed"));
      };
      function finish(error, value) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        error ? reject(error) : resolve(value);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send(message);
    });
  const sockets = [],
    readers = [],
    groups = [],
    sent = new Map();
  let measuring = false,
    receivedBytes = 0,
    receivedFrames = 0,
    sentFrames = 0,
    sentBytes = 0,
    seq = 0,
    firstMeasuredSeq = 0,
    errors = 0,
    reconnects = 0,
    reconnectAttempts = 0,
    generatorQueuePeakBytes = 0;
  const delays = [],
    closes = {};
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    const { url } = await request({ type: "start", dataDir, host: config.host }, "ready");
    const api = createScenarioClient(async (fp) => {
      const conn = await connect(url, fp);
      sockets.push(conn);
      conn.ws.on("error", () => {
        if (measuring) errors++;
      });
      conn.closed.then(({ code }) => {
        if (measuring) closes[code] = (closes[code] ?? 0) + 1;
      });
      return conn;
    });
    function read(conn) {
      readers.push(
        (async () => {
          try {
            while (true) {
              const raw = await conn.nextRaw((config.duration + config.warmup + 15) * 1000);
              const envelope = decodeEnvelope(raw);
              if (envelope.t !== "e2e") continue;
              const start = sent.get(envelope.seq);
              sent.delete(envelope.seq);
              if (measuring && envelope.seq >= firstMeasuredSeq) {
                receivedFrames++;
                receivedBytes += raw.length;
                if (start !== undefined && delays.length < 100000)
                  delays.push(performance.now() - start);
              }
            }
          } catch {
            if (measuring && conn.ws.readyState === 1) errors++;
          }
        })(),
      );
    }
    for (let i = 0; i < config.computers; i++) {
      const computer = new TestDevice("synthetic-computer");
      const { agent } = await api.agentOnline(computer);
      const group = { computer, agent, viewers: [] };
      for (let j = 0; j < config.viewers; j++) {
        const phone = new TestDevice("synthetic-viewer");
        await api.pair(agent, computer, phone);
        const conn = await api.connect(computer.fp);
        if ((await api.authenticate(conn, phone, "phone")).type !== "auth-ok")
          throw new Error("Synthetic authentication failed");
        await agent.nextCtrl();
        group.viewers.push({ phone, conn });
        read(conn);
      }
      groups.push(group);
    }
    const payloadBytes = Math.min(
      65536,
      Math.max(
        1,
        Math.floor(config.bytesPerSecond / config.fps / config.computers / config.viewers),
      ),
    );
    async function phase(seconds, warmup = false) {
      const until = performance.now() + seconds * 1000;
      const scenario = warmup ? "incremental" : config.scenario;
      const period = warmup
        ? 1000 / Math.min(10, config.fps)
        : scenario === "burst"
          ? 250
          : 1000 / config.fps;
      let next = performance.now(),
        nextReconnect = next + 250;
      while (performance.now() < until) {
        if (scenario === "reconnect" && performance.now() >= nextReconnect) {
          for (const group of groups)
            for (const viewer of group.viewers) {
              viewer.conn.close();
              await viewer.conn.closed;
              await group.agent.nextCtrl();
              if (measuring) reconnectAttempts++;
              viewer.conn = await api.connect(group.computer.fp);
              if ((await api.authenticate(viewer.conn, viewer.phone, "phone")).type !== "auth-ok")
                throw new Error("Synthetic reconnect failed");
              await group.agent.nextCtrl();
              read(viewer.conn);
              if (measuring) reconnects++;
            }
          nextReconnect = performance.now() + 250;
        }
        if (scenario !== "quiet") {
          const count = scenario === "burst" ? Math.max(1, Math.round(config.fps / 4)) : 1;
          for (let n = 0; n < count; n++)
            for (const group of groups)
              for (const viewer of group.viewers) {
                if (group.agent.ws.readyState !== 1 || viewer.conn.ws.readyState !== 1) continue;
                const frame = {
                  v: 1,
                  t: "e2e",
                  from: group.computer.fp,
                  to: viewer.phone.fp,
                  seq: ++seq,
                  body: {
                    n: new Uint8Array(24),
                    c: new Uint8Array(config.scenario === "small-frame" ? 32 : payloadBytes),
                  },
                };
                if (measuring && sent.size < 100000) sent.set(seq, performance.now());
                group.agent.sendEnvelope(frame);
                if (measuring) {
                  sentFrames++;
                  sentBytes += frame.body.c.length;
                  generatorQueuePeakBytes = Math.max(
                    generatorQueuePeakBytes,
                    group.agent.ws.bufferedAmount,
                  );
                }
              }
        }
        next += period;
        await delay(Math.max(0, Math.min(until - performance.now(), next - performance.now())));
      }
    }
    await phase(config.warmup, true);
    await request({ type: "measure" }, "measuring");
    if (config.scenario === "slow-client")
      for (const group of groups) group.viewers[0].conn.ws.pause();
    lag.reset();
    const cpuStart = process.cpuUsage(),
      start = performance.now();
    let rssPeak = process.memoryUsage().rss;
    const sample = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 50);
    firstMeasuredSeq = seq + 1;
    measuring = true;
    try {
      await phase(config.duration);
    } finally {
      measuring = false;
      clearInterval(sample);
    }
    const elapsedMs = performance.now() - start,
      cpu = process.cpuUsage(cpuStart);
    const { metrics } = await request({ type: "metrics" }, "metrics");
    return {
      elapsedMs,
      offered: { frames: sentFrames, syntheticCiphertextBytes: sentBytes },
      received: {
        frames: receivedFrames,
        bytes: receivedBytes,
        bytesPerSecond: (receivedBytes * 1000) / elapsedMs,
      },
      forwardingMs: distribution(delays),
      errors,
      closes,
      reconnects,
      reconnectAttempts,
      undeliveredAtMeasurementEnd: sentFrames - receivedFrames,
      server: metrics,
      generator: {
        scope: "load generator process only",
        rssPeakBytes: Math.max(rssPeak, process.memoryUsage().rss),
        cpuMs: (cpu.user + cpu.system) / 1000,
        eventLoopLagMs: {
          p50: lag.percentile(50) / 1e6,
          p95: lag.percentile(95) / 1e6,
          p99: lag.percentile(99) / 1e6,
        },
        wsBufferedAmountPeakBytes: generatorQueuePeakBytes,
      },
      serverDiagnosticChunks: serverDiagnostics,
    };
  } finally {
    measuring = false;
    lag.disable();
    for (const conn of sockets) {
      conn.ws.resume();
      conn.ws.terminate();
    }
    await Promise.allSettled(readers);
    if (child.connected) child.send({ type: "stop" });
    if (child.exitCode === null)
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    rmSync(dataDir, { recursive: true });
  }
}
try {
  const config = options(),
    runs = [];
  for (let i = 0; i < config.repeat; i++) runs.push(await run(config));
  console.log(
    JSON.stringify(
      {
        version: 1,
        synthetic: true,
        environment: environment(),
        config,
        notes: [
          "Fresh disposable server per repetition; no external destination or provider traffic",
          "Warmup excluded; received bytes are complete e2e envelope bytes, offered bytes are synthetic ciphertext only",
          "Forwarding is generator send-to-receive wall time, including local TCP and scheduling; first 100000 received frames",
          "Slow clients pause reads throughout measurement; undelivered frames are not counted as throughput",
          "Benchmark instrumentation adds overhead; results are local observations, not VPS capacity claims",
        ],
        runs,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("Synthetic benchmark failed; check loopback-only options and local runtime");
  process.exitCode = 1;
}

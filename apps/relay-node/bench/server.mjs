// Benchmark-only instrumentation; no production endpoint, configuration flag or provider traffic.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { QueueBudget } from "@shellbell/relay-core";
import { WebSocket } from "ws";
import { distribution } from "./report.mjs";

let dbTimes = [],
  dbCount = 0,
  rssPeak = 0,
  peakBytes = 0,
  connectionPeakBytes = 0;
let active = false,
  queued = 0,
  cpuStart,
  timeStart;
let closeRequests = {};
const socketClose = WebSocket.prototype.close;
WebSocket.prototype.close = function (code, ...args) {
  if (active && this.readyState === WebSocket.OPEN)
    closeRequests[code ?? 1005] = (closeRequests[code ?? 1005] ?? 0) + 1;
  return socketClose.call(this, code, ...args);
};
const balances = new WeakMap();
const reserve = QueueBudget.prototype.reserve;
const release = QueueBudget.prototype.release;
QueueBudget.prototype.reserve = function (id, bytes) {
  const accepted = reserve.call(this, id, bytes);
  if (accepted) {
    let entries = balances.get(this);
    if (!entries) {
      entries = new Map();
      balances.set(this, entries);
    }
    const current = (entries.get(id) ?? 0) + bytes;
    entries.set(id, current);
    queued += bytes;
    if (active) {
      peakBytes = Math.max(peakBytes, queued);
      connectionPeakBytes = Math.max(connectionPeakBytes, current);
    }
  }
  return accepted;
};
QueueBudget.prototype.release = function (id, bytes) {
  const entries = balances.get(this);
  const current = entries?.get(id) ?? 0;
  const removed = Math.min(current, bytes);
  if (current === removed) entries?.delete(id);
  else entries?.set(id, current - removed);
  queued -= removed;
  return release.call(this, id, bytes);
};
function measured(action) {
  const start = performance.now();
  try {
    return action();
  } finally {
    if (active) {
      dbCount++;
      if (dbTimes.length < 100000) dbTimes.push(performance.now() - start);
    }
  }
}
const prepare = DatabaseSync.prototype.prepare;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (...args) {
  return measured(() => exec.apply(this, args));
};
DatabaseSync.prototype.prepare = function (...args) {
  const stmt = measured(() => prepare.apply(this, args));
  for (const name of ["run", "get", "all"]) {
    const original = stmt[name];
    stmt[name] = (...values) => measured(() => original.apply(stmt, values));
  }
  return stmt;
};
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const sample = setInterval(() => {
  if (active) rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}, 50);
const { startRelay } = await import("../src/server.ts");
let relay;
process.on("message", async (message) => {
  try {
    if (message.type === "start") {
      relay = await startRelay(
        { dataDir: message.dataDir, host: message.host, port: 0, shutdownMs: 500 },
        {
          provider: {
            send: async () => {
              throw new Error("Synthetic benchmark forbids provider delivery");
            },
            receipts: async () => {
              throw new Error("Synthetic benchmark forbids provider delivery");
            },
          },
        },
      );
      process.send({ type: "ready", url: relay.url });
    } else if (message.type === "measure") {
      closeRequests = {};
      dbTimes = [];
      dbCount = 0;
      peakBytes = queued;
      connectionPeakBytes = 0;
      rssPeak = process.memoryUsage().rss;
      cpuStart = process.cpuUsage();
      timeStart = performance.now();
      lag.reset();
      active = true;
      process.send({ type: "measuring" });
    } else if (message.type === "metrics") {
      active = false;
      const cpu = process.cpuUsage(cpuStart);
      process.send({
        type: "metrics",
        metrics: {
          scope: "relay child process only",
          closeRequests,
          rssPeakBytes: Math.max(rssPeak, process.memoryUsage().rss),
          cpuMs: (cpu.user + cpu.system) / 1000,
          elapsedMs: performance.now() - timeStart,
          eventLoopLagMs: {
            p50: lag.percentile(50) / 1e6,
            p95: lag.percentile(95) / 1e6,
            p99: lag.percentile(99) / 1e6,
          },
          queues: {
            scope:
              "application inbound and outbound reservations combined; excludes ws/kernel buffers",
            peakBytes,
            connectionPeakBytes,
          },
          database: {
            scope:
              "relay synchronous SQLite prepare/exec/run/get/all wall time including driver overhead; first 100000 operations",
            count: dbCount,
            milliseconds: distribution(dbTimes),
          },
        },
      });
    } else if (message.type === "stop") {
      await relay?.close();
      clearInterval(sample);
      lag.disable();
      process.disconnect();
    }
  } catch {
    process.send?.({ type: "failed" });
  }
});

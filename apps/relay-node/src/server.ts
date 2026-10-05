import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { FpSchema, FRAME_LIMITS } from "@shellbell/protocol";
import {
  createDirectNotificationProvider,
  createNotificationService,
  createRelayCore,
  InboundQueue,
  type NotificationProvider,
  QueueBudget,
  RELAY_VERSION,
  type RelayCore,
} from "@shellbell/relay-core";
import { type WebSocket, WebSocketServer } from "ws";
import { createApnsHttp2Transport } from "./apns-transport.js";
import { loadNodePushCredentials, type RelayNodeConfig, resolveConfig } from "./config.js";
import { bindNodeConnection } from "./connection.js";
import { RelayRuntimeLifecycle } from "./runtime-lifecycle.js";
import { createNodeScheduler } from "./scheduler.js";
import { openRelayDatabase } from "./storage/database.js";
import { createNodeTransport } from "./transport.js";

export type { RelayNodeConfig } from "./config.js";
export interface RunningRelay {
  url: string;
  close(): Promise<void>;
}
/** Embedded providers use the same durable claim/completion protocol as direct providers. */
export interface RelayNodeDependencies {
  provider?: NotificationProvider;
}
function requestPath(target: string | undefined): string | null {
  try {
    return new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}
export async function startRelay(
  config: RelayNodeConfig,
  dependencies: RelayNodeDependencies = {},
): Promise<RunningRelay> {
  const options = resolveConfig(config);
  const apnsTransport = dependencies.provider ? undefined : createApnsHttp2Transport();
  try {
    return await startConfiguredRelay(options, dependencies, apnsTransport);
  } catch (error) {
    apnsTransport?.close();
    throw error;
  }
}
async function startConfiguredRelay(
  options: ReturnType<typeof resolveConfig>,
  dependencies: RelayNodeDependencies,
  apnsTransport: ReturnType<typeof createApnsHttp2Transport> | undefined,
): Promise<RunningRelay> {
  const baseProvider =
    dependencies.provider ??
    createDirectNotificationProvider({
      ...(await loadNodePushCredentials(options, (provider, code) =>
        console.error("relay push unavailable", provider, code),
      )),
      apnsFetch: apnsTransport!.fetch,
    });
  const entries = new Map<
    string,
    { core: RelayCore; transport: ReturnType<typeof createNodeTransport>; work: number }
  >();
  const schedulers = new Map<string, ReturnType<typeof createNodeScheduler>>();
  const outbound = new QueueBudget(options.connectionQueueBytes, options.globalQueueBytes);
  // Includes a fixed handler credit, bounding even empty/tiny queued frames.
  const inbound = new InboundQueue(
    new QueueBudget(options.connectionQueueBytes, options.globalQueueBytes),
    256,
  );
  const rawSockets = new Set<Socket>();
  const sockets = new Set<WebSocket>();
  const lifecycle = new RelayRuntimeLifecycle({
    report: () => console.error("relay event", "runtime-failure"),
    probeStorage: () => {
      // Validate durable ownership and deadlines; recovery also exercises writes.
      database.computers();
      database.deadlines();
    },
    recoverComputer: async (fp) => {
      await lifecycle.observeStore(fp, database.notifications(fp)).recover(Date.now());
      await track(
        fp,
        () =>
          getEntry(fp).core.wakeup({
            deferDelivery: (work) => deferDelivery(fp, work),
          }),
        true,
      );
    },
    recovered: (fp) => evict(fp),
  });
  const database = openRelayDatabase(options.dataDir, {
    attentive: (fp, phone, now) =>
      entries
        .get(fp)
        ?.transport.sessions()
        .some((s) => s.state === "phone" && s.fp === phone && s.leaseUntil > now) ?? false,
  });
  let deadlines: Map<string, number>;
  try {
    deadlines = new Map(database.deadlines().map((row) => [row.computerFp, row.deadline]));
  } catch (error) {
    await database.close();
    throw error;
  }
  const provider: NotificationProvider = {
    send: (messages) => lifecycle.providerCall(() => baseProvider.send(messages)),
  };
  function evict(fp: string) {
    const entry = entries.get(fp);
    if (
      entry &&
      !lifecycle.hasStorageFailure(fp) &&
      entry.work === 0 &&
      entry.transport.sessions().length === 0
    ) {
      entries.delete(fp);
      if (!deadlines.has(fp)) {
        schedulers.get(fp)?.stop();
        schedulers.delete(fp);
      }
    }
  }
  function track(fp: string, action: () => Promise<void>, maintenance = false): Promise<void> {
    const entry = getEntry(fp);
    entry.work++;
    const task = Promise.resolve()
      .then(action)
      .catch((error) => {
        lifecycle.report();
        if (maintenance) {
          lifecycle.storageFailed(fp);
          throw error;
        }
      })
      .finally(() => {
        entry.work--;
        evict(fp);
      });
    return lifecycle.track(task);
  }
  function deferDelivery(fp: string, task: Promise<void>) {
    lifecycle.trackDelivery(task, () => track(fp, () => task));
  }
  function getEntry(fp: string) {
    const existing = entries.get(fp);
    if (existing) return existing;
    let scheduler = schedulers.get(fp);
    if (!scheduler) {
      scheduler = createNodeScheduler({
        read: () => deadlines.get(fp) ?? null,
        write: (deadline) => {
          try {
            database.setDeadline(fp, deadline);
          } catch (error) {
            lifecycle.storageFailed(fp);
            throw error;
          }
          if (deadline === null) deadlines.delete(fp);
          else deadlines.set(fp, deadline);
        },
        now: () => Date.now(),
        wakeup: () =>
          track(
            fp,
            () => getEntry(fp).core.wakeup({ deferDelivery: (task) => deferDelivery(fp, task) }),
            true,
          ),
        report: () => {
          lifecycle.storageFailed(fp);
          lifecycle.report();
        },
      });
      schedulers.set(fp, scheduler);
      if (lifecycle.stopping) scheduler.stop();
    }
    const transport = createNodeTransport(outbound, options.connectionQueueBytes, (id) => {
      if (lifecycle.closed) return;
      const task = core.close(id);
      void track(fp, () => task);
    });
    const notifications = createNotificationService({
      computerFp: fp,
      store: lifecycle.observeStore(fp, database.notifications(fp)),
      provider,
      now: () => Date.now(),
      randomId: randomUUID,
      schedule: () => core.reschedule(),
    });
    const core = createRelayCore({
      computerFp: fp,
      identity: lifecycle.observeStore(fp, database.identity(fp)),
      transport,
      scheduler,
      notifications,
      runtime: {
        now: () => Date.now(),
        randomBytes,
        randomId: randomUUID,
        report: () => lifecycle.report(),
      },
    });
    const entry = { core, transport, work: 0 };
    entries.set(fp, entry);
    return entry;
  }
  const server = createServer((request, response) => {
    const path = requestPath(request.url);
    if (path === null) {
      response.writeHead(400, { Connection: "close" });
      response.end("bad request");
      return;
    }
    let status = 404;
    let body = "not found";
    if (request.method === "GET") {
      if (path === "/") {
        status = 200;
        body = JSON.stringify({
          name: "shellbell-relay",
          version: RELAY_VERSION,
          docs: "https://github.com/bilal-/shellbell",
        });
        response.setHeader("content-type", "application/json");
      } else if (path === "/healthz") {
        status = 200;
        body = "ok";
      } else if (path === "/readyz") {
        status = lifecycle.ready ? 200 : 503;
        body = status === 200 ? "ready" : "not ready";
      } else if (/^\/ws\/[^/]+$/.test(path)) {
        status = FpSchema.safeParse(path.slice(4)).success ? 426 : 400;
        body = status === 426 ? "expected websocket" : "bad fingerprint";
      }
    }
    response.writeHead(status);
    response.end(body);
  });
  server.on("connection", (socket) => {
    rawSockets.add(socket);
    socket.on("close", () => rawSockets.delete(socket));
  });
  const websocket = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: FRAME_LIMITS.e2eFromAgent,
  });
  server.on("upgrade", (request, socket, head) => {
    const path = requestPath(request.url);
    if (path === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const match = /^\/ws\/([^/]+)$/.exec(path);
    const fp = match?.[1];
    const status = !lifecycle.ready
      ? 503
      : request.method !== "GET" || !match
        ? 404
        : !FpSchema.safeParse(fp).success
          ? 400
          : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) => {
      const computerFp = fp!;
      const entry = getEntry(computerFp);
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      bindNodeConnection(ws, {
        core: entry.core,
        transport: entry.transport,
        inbound,
        track: (action) => track(computerFp, action),
        isStopping: () => lifecycle.stopping,
        isClosed: () => lifecycle.closed,
      });
    });
  });
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      // Fence durable completion before transport teardown rejects in-flight sends.
      lifecycle.stop();
      apnsTransport?.close();
      for (const scheduler of schedulers.values()) scheduler.stop();
      const listenerClosed = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      for (const [fp, entry] of entries)
        for (const session of entry.transport.sessions()) {
          const task = entry.core.close(session.connId);
          void track(fp, () => task);
        }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.shutdownMs);
      });
      await Promise.race([Promise.all([lifecycle.drain(), listenerClosed]), deadline]);
      clearTimeout(timer);
      lifecycle.finish();
      for (const socket of sockets) socket.terminate();
      for (const socket of rawSockets) socket.destroy();
      await lifecycle.drain();
      await listenerClosed;
      websocket.close();
      await database.close();
    })());
  try {
    for (const fp of database.computers()) {
      // Repair interrupted claims before readiness, even without a deadline row.
      await database.notifications(fp).recover(Date.now());
      const entry = getEntry(fp);
      const recovery = entry.core.wakeup({ deferDelivery: (task) => deferDelivery(fp, task) });
      void track(fp, () => recovery);
      // Core transitions/retention recovery complete before listening; external
      // provider work may continue independently with its claim already durable.
      await recovery;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Startup delivery can fail in persistence while listener creation awaits.
    lifecycle.started();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return { url: `http://${host}:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

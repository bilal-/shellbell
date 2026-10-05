import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import {
  notice,
  tokenMessage,
} from "../../../packages/relay-core/test-support/notification-store-contract.js";
import { startRelay } from "../src/server.js";
import { openRelayDatabase } from "../src/storage/database.js";
import { connect } from "./client.js";
import { computerFixture, temporaryDirectory } from "./helpers.js";

it.each(["duplicate-sync", "mismatched-sync", "mismatched-add"] as const)(
  "rejects caller-origin %s without degrading readiness or other admissions",
  async (kind) => {
    const dataDir = temporaryDirectory();
    const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
    const connections: Awaited<ReturnType<typeof connect>>[] = [];
    try {
      const api = createScenarioClient(async (fp) => {
        const connection = await connect(relay.url, fp);
        connections.push(connection);
        return connection;
      });
      const host = new TestDevice("caller-rejection-host");
      const phone = new TestDevice("caller-rejection-phone");
      const other = new TestDevice("different-key");
      const { agent } = await api.agentOnline(host);
      const pairing = {
        phoneFp: phone.fp,
        ed25519Pub: kind === "duplicate-sync" ? phone.id.ed25519.pub : other.id.ed25519.pub,
        name: phone.name,
      };
      agent.sendCtrl(
        host.fp,
        kind === "mismatched-add"
          ? { type: "pairing-add", ...pairing }
          : {
              type: "pairings-sync",
              phones: kind === "duplicate-sync" ? [pairing, pairing] : [pairing],
            },
      );
      expect((await agent.closed).code).toBe(4400);
      expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
      expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
      const admitted = await api.agentOnline(new TestDevice("healthy-other-computer"));
      expect(admitted.agent).toBeDefined();
      const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
      try {
        expect(sql.prepare("SELECT COUNT(*) AS n FROM pairings").get()?.n).toBe(0);
      } finally {
        sql.close();
      }
    } finally {
      for (const connection of connections) connection.close();
      await Promise.all(connections.map((connection) => connection.closed));
      await relay.close();
      rmSync(dataDir, { recursive: true });
    }
  },
);

it("still degrades readiness for persisted ProtocolError during client handling", async () => {
  const dataDir = temporaryDirectory();
  const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const api = createScenarioClient((fp) => connect(relay.url, fp));
  const host = new TestDevice("corrupt-record-host");
  const { agent } = await api.agentOnline(host);
  try {
    const original = sql
      .prepare("SELECT first_seen FROM computer WHERE computer_fp = ?")
      .get(host.fp)!.first_seen;
    if (typeof original !== "number") throw new Error("Missing fixture computer timestamp");
    sql.prepare("UPDATE computer SET first_seen = -1 WHERE computer_fp = ?").run(host.fp);
    agent.sendCtrl(host.fp, { type: "pairing-close" });
    expect((await agent.closed).code).toBe(4400);
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
    await expect(connect(relay.url, new TestDevice("blocked-on-storage").fp)).rejects.toThrow(
      /503/,
    );
    sql.prepare("UPDATE computer SET first_seen = ? WHERE computer_fp = ?").run(original, host.fp);
    await vi.waitFor(async () => expect((await fetch(`${relay.url}/readyz`)).status).toBe(200), {
      timeout: 5000,
    });
  } finally {
    agent.close();
    await agent.closed;
    sql.close();
    await relay.close();
    diagnostic.mockRestore();
    rmSync(dataDir, { recursive: true });
  }
}, 10000);

it("does not overwrite degraded readiness when startup delivery fails in local persistence", async () => {
  const dataDir = temporaryDirectory();
  const record = { ...computerFixture(), firstSeen: Date.now(), lastSeen: Date.now() };
  const database = openRelayDatabase(dataDir, { attentive: () => false });
  await database.identity(record.fingerprint).registerComputer(record);
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  const phone = new TestDevice("startup-phone");
  sql
    .prepare(
      "INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, name, paired_at) VALUES (?, ?, ?, 'Phone', ?)",
    )
    .run(record.fingerprint, phone.fp, phone.id.ed25519.pub, Date.now());
  await database.notifications(record.fingerprint).register(phone.fp, tokenMessage, "generation");
  await database.notifications(record.fingerprint).enqueue(notice(), Date.now());
  await database.close();
  sql.exec(
    "CREATE TRIGGER fail_completion BEFORE DELETE ON push_jobs BEGIN SELECT RAISE(ABORT, 'synthetic completion storage failure'); END",
  );
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = await startRelay(
    { dataDir, port: 0, shutdownMs: 100 },
    {
      provider: {
        send: async (messages) => messages.map(() => ({ status: "accepted" })),
      },
    },
  );
  try {
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
  } finally {
    diagnostic.mockRestore();
    sql.close();
    await relay.close();
    rmSync(dataDir, { recursive: true });
  }
});

it("recovers timer maintenance after successful deadline removal without client traffic or restart", async () => {
  const dataDir = temporaryDirectory();
  const record = { ...computerFixture(), firstSeen: Date.now(), lastSeen: Date.now() };
  const database = openRelayDatabase(dataDir, { attentive: () => false });
  await database.identity(record.fingerprint).registerComputer(record);
  await database.identity(record.fingerprint).openWindow(new Uint8Array(32), Date.now() + 1200);
  await database.close();
  const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // The DELETE succeeds, then real maintenance hits a malformed stored row.
    sql.exec(
      "CREATE TRIGGER break_after_clear AFTER DELETE ON computer_deadlines BEGIN UPDATE computer SET first_seen = -1; END",
    );
    await vi.waitFor(
      () => expect(sql.prepare("SELECT first_seen FROM computer").get()?.first_seen).toBe(-1),
      { timeout: 4000 },
    );
    expect(diagnostic).toHaveBeenCalled();
    sql.exec("DROP TRIGGER break_after_clear");
    sql.prepare("UPDATE computer SET first_seen = ?").run(record.firstSeen);
    // A successful maintenance pass replaces the lost window deadline with retention.
    await vi.waitFor(
      () =>
        expect(
          Number(sql.prepare("SELECT deadline FROM computer_deadlines").get()?.deadline),
        ).toBeGreaterThan(Date.now() + 60_000),
      { timeout: 5000 },
    );
  } finally {
    diagnostic.mockRestore();
    sql.close();
    await relay.close();
    rmSync(dataDir, { recursive: true });
  }
}, 12000);

it("fails readiness and upgrade admission on runtime storage errors and recovers only after repair", async () => {
  const dataDir = temporaryDirectory();
  const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // Keep the actual server/core/repositories. Break an actual SQL read after startup.
    sql.exec("ALTER TABLE computer RENAME TO unavailable_computer");
    const connection = await connect(relay.url, new TestDevice("storage-failure").fp);
    await connection.nextCtrl();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
    await expect(connect(relay.url, new TestDevice("rejected").fp)).rejects.toThrow(/503/);
    sql.exec("ALTER TABLE unavailable_computer RENAME TO computer");
    sql.exec(
      "CREATE TRIGGER fail_recovery BEFORE INSERT ON computer_deadlines BEGIN SELECT RAISE(ABORT, 'synthetic maintenance failure'); END",
    );
    const failures = diagnostic.mock.calls.length;
    await vi.waitFor(() => expect(diagnostic.mock.calls.length).toBeGreaterThan(failures), {
      timeout: 5000,
    });
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(503);
    sql.exec("DROP TRIGGER fail_recovery");
    await vi.waitFor(async () => expect((await fetch(`${relay.url}/readyz`)).status).toBe(200), {
      timeout: 5000,
    });
    const accepted = await connect(relay.url, new TestDevice("recovered").fp);
    await accepted.nextCtrl();
    accepted.close();
    connection.close();
    await Promise.all([accepted.closed, connection.closed]);
  } finally {
    diagnostic.mockRestore();
    sql.close();
    await relay.close();
    rmSync(dataDir, { recursive: true });
  }
}, 12000);

it("does not poll storage while healthy and cancels recovery before ownership is released", async () => {
  const dataDir = temporaryDirectory();
  const relay = await startRelay({ dataDir, port: 0, shutdownMs: 100 });
  const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    reads.mockRestore();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clears = vi.spyOn(globalThis, "clearTimeout");
    sql.exec("ALTER TABLE computer RENAME TO unavailable_computer");
    const connection = await connect(relay.url, new TestDevice("shutdown-degraded").fp);
    await connection.nextCtrl();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
    sql.exec("ALTER TABLE unavailable_computer RENAME TO computer");
    connection.close();
    await connection.closed;
    await relay.close();
    // The WebSocket library can retain its own 30s close timer. Check the actual
    // degraded-recovery timer handles, without treating that as relay polling.
    const recoveryTimers = timers.mock.calls.flatMap((call, index) =>
      call[1] === 1000 ? [timers.mock.results[index]!.value] : [],
    );
    expect(recoveryTimers.length).toBeGreaterThan(0);
    for (const timer of recoveryTimers) expect(clears).toHaveBeenCalledWith(timer);
    timers.mockRestore();
    clears.mockRestore();
    const reopened = openRelayDatabase(dataDir, { attentive: () => false });
    await reopened.close();
    const afterClose = vi.spyOn(DatabaseSync.prototype, "prepare");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(afterClose).not.toHaveBeenCalled();
    afterClose.mockRestore();
  } finally {
    vi.useRealTimers();
    diagnostic.mockRestore();
    sql.close();
    await relay.close();
    rmSync(dataDir, { recursive: true });
  }
});

it("keeps readiness for malformed clients and provider failure", async () => {
  const dataDir = temporaryDirectory();
  const relay = await startRelay(
    { dataDir, port: 0, shutdownMs: 100 },
    {
      provider: {
        send: async () => {
          throw new Error("synthetic provider failure");
        },
      },
    },
  );
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const api = createScenarioClient(async (fp) => {
      const c = await connect(relay.url, fp);
      connections.push(c);
      return c;
    });
    const host = new TestDevice("provider-host"),
      phone = new TestDevice("provider-phone");
    const { agent } = await api.agentOnline(host);
    await api.pair(agent, host, phone);
    const p = await api.connect(host.fp);
    await api.authenticate(p, phone, "phone");
    await agent.nextCtrl();
    p.sendCtrl(phone.fp, {
      type: "push-token",
      token: "a".repeat(64),
      provider: "apns",
      environment: "production",
      platform: "ios",
      enabled: true,
    });
    // A subsequent authenticated message observes the committed registration.
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 0 });
    const sql = new DatabaseSync(join(dataDir, "relay.sqlite"));
    try {
      await vi.waitFor(() =>
        expect(sql.prepare("SELECT COUNT(*) AS n FROM push_registrations").get()?.n).toBe(1),
      );
    } finally {
      sql.close();
    }
    agent.sendCtrl(host.fp, { type: "notify", sessionId: "synthetic", kind: "idle" });
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
    const bad = await api.connect(host.fp);
    await bad.nextCtrl();
    bad.sendRaw(new Uint8Array([255]));
    await bad.closed;
    expect((await fetch(`${relay.url}/readyz`)).status).toBe(200);
  } finally {
    for (const connection of connections) connection.close();
    await Promise.all(connections.map((c) => c.closed));
    diagnostic.mockRestore();
    await relay.close();
    rmSync(dataDir, { recursive: true });
  }
}, 12000);

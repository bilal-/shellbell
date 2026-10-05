import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { loadConfig, paths } from "../src/config.js";
import { ControlServer, controlRequest } from "../src/control.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import {
  LOCAL_CONTROL_VERSION,
  LocalRuntimeSchema,
  type LocalStatus,
  LocalStatusSchema,
  serviceInstanceFromEnvironment,
} from "../src/local-status.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const validStatus: LocalStatus = {
  controlVersion: 1,
  process: {
    pid: 4242,
    agentVersion: "0.0.1-test",
    computerFp: "a".repeat(26),
    stateDir: "/tmp/shellbell-test-state",
    serviceInstance: "123e4567-e89b-42d3-a456-426614174000",
  },
  backends: [
    { name: "iterm2", connected: true },
    { name: "tmux", connected: false },
    { name: "herdr", connected: false },
  ],
  terminalReady: true,
  relayOnline: false,
  sessions: 0,
  phones: [{ phoneFp: "b".repeat(26), name: "iPhone", lastSeenAt: null }],
  connected: [{ phoneFp: "b".repeat(26), name: "iPhone", viewed: null }],
};

describe("LocalStatusSchema", () => {
  it("exports LocalRuntimeSchema as the standalone process-object contract", () => {
    expect(LocalRuntimeSchema.parse(validStatus.process)).toEqual(validStatus.process);
  });

  it("accepts the complete version 1 contract and future additive fields", () => {
    expect(LOCAL_CONTROL_VERSION).toBe(1);
    expect(LocalStatusSchema.safeParse({ ...validStatus, futureField: "allowed" }).success).toBe(
      true,
    );
  });

  it("rejects a legacy status payload without versioned runtime metadata", () => {
    expect(
      LocalStatusSchema.safeParse({
        relayOnline: true,
        sessions: 1,
        phones: [],
        connected: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["unknown version", { controlVersion: 2 }],
    ["zero pid", { process: { ...validStatus.process, pid: 0 } }],
    ["unsafe pid", { process: { ...validStatus.process, pid: Number.MAX_SAFE_INTEGER + 1 } }],
    ["empty version", { process: { ...validStatus.process, agentVersion: "" } }],
    ["bad fingerprint", { process: { ...validStatus.process, computerFp: "not-a-fp" } }],
    ["relative state path", { process: { ...validStatus.process, stateDir: "relative/state" } }],
    [
      "bad service instance",
      { process: { ...validStatus.process, serviceInstance: "not-a-uuid" } },
    ],
    ["negative sessions", { sessions: -1 }],
    ["unsafe sessions", { sessions: Number.MAX_SAFE_INTEGER + 1 }],
    ["bad phone fingerprint", { phones: [{ ...validStatus.phones[0], phoneFp: "bad" }] }],
  ])("rejects %s", (_name, replacement) => {
    expect(LocalStatusSchema.safeParse({ ...validStatus, ...replacement }).success).toBe(false);
  });

  it.each([
    ["a missing backend", validStatus.backends.slice(0, 2)],
    [
      "a duplicate backend",
      [
        { name: "iterm2", connected: true },
        { name: "tmux", connected: false },
        { name: "tmux", connected: false },
      ],
    ],
    ["the wrong backend order", [...validStatus.backends].reverse()],
  ])("rejects %s", (_name, backends) => {
    expect(LocalStatusSchema.safeParse({ ...validStatus, backends }).success).toBe(false);
  });

  it("requires terminalReady to equal current backend connectivity", () => {
    expect(LocalStatusSchema.safeParse({ ...validStatus, terminalReady: false }).success).toBe(
      false,
    );

    const offline = {
      ...validStatus,
      backends: validStatus.backends.map((backend) => ({ ...backend, connected: false })),
      terminalReady: false,
      relayOnline: true,
      sessions: 0,
    };
    expect(LocalStatusSchema.safeParse(offline).success).toBe(true);
  });

  it("keeps terminal readiness independent from relay connectivity and session count", () => {
    const parsed = LocalStatusSchema.parse({ ...validStatus, relayOnline: false, sessions: 0 });
    expect(parsed.terminalReady).toBe(true);
  });
});

describe("serviceInstanceFromEnvironment", () => {
  const instance = "123e4567-e89b-42d3-a456-426614174000";

  it("returns null for a missing service instance", () => {
    expect(serviceInstanceFromEnvironment(true, {})).toBeNull();
  });

  it("returns a valid service UUID", () => {
    expect(serviceInstanceFromEnvironment(true, { SHELLBELL_SERVICE_INSTANCE: instance })).toBe(
      instance,
    );
  });

  it("ignores an inherited value outside service mode", () => {
    expect(
      serviceInstanceFromEnvironment(false, { SHELLBELL_SERVICE_INSTANCE: "not-a-uuid" }),
    ).toBeNull();
  });

  it("rejects an invalid service UUID without disclosing its value", () => {
    const sentinel = "PRIVATE_SENTINEL";
    let error: unknown;
    try {
      serviceInstanceFromEnvironment(true, { SHELLBELL_SERVICE_INSTANCE: sentinel });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SHELLBELL_SERVICE_INSTANCE/);
    expect((error as Error).message).not.toContain(sentinel);
  });
});

describe("local status response", () => {
  it("builds canonical process metadata and live backend health without exposing private data", async () => {
    const realStateDir = mkdtempSync(join(tmpdir(), "sb-status-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "sb-status-link-"));
    const linkedStateDir = join(linkParent, "state");
    symlinkSync(realStateDir, linkedStateDir);
    const p = paths(linkedStateDir);
    // Settings admission rejects symlink roots; status still canonicalizes an observed alias.
    const config = loadConfig(paths(realStateDir));
    const { identity, fp } = loadOrCreateIdentity(p);
    const relay = new FakeRelay(fp);
    await relay.start();
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend();
    const terminalSentinel = "TERMINAL_CONTENT_PRIVATE_SENTINEL";
    backend.addSession("hidden", { lines: [terminalSentinel] });
    const listSessions = vi.spyOn(backend, "listSessions").mockResolvedValue([]);
    const connect = vi.spyOn(backend, "connect");
    registry.add(backend);
    const serviceInstance = "123e4567-e89b-42d3-a456-426614174000";
    const log = createLogger({ stdout: false });
    const agent = new Agent({
      paths: p,
      config,
      identity,
      fp,
      registry,
      log,
      confirm: async () => true,
      appVersion: "0.0.1-status-test",
      serviceInstance,
      relayUrlOverride: relay.url,
    });
    const control = new ControlServer(p.sock, agent, log);

    try {
      agent.start();
      await control.start();
      await waitFor(() => agent.relayOnline);
      await waitFor(() => listSessions.mock.calls.length > 0);
      listSessions.mockClear();

      const status = LocalStatusSchema.parse(await controlRequest(p.sock, "status"));
      expect(status).toMatchObject({
        controlVersion: 1,
        process: {
          pid: process.pid,
          agentVersion: "0.0.1-status-test",
          computerFp: fp,
          stateDir: realpathSync(realStateDir),
          serviceInstance,
        },
        backends: [
          { name: "iterm2", connected: true },
          { name: "tmux", connected: false },
          { name: "herdr", connected: false },
        ],
        terminalReady: true,
        relayOnline: true,
        sessions: 0,
      });
      expect(listSessions).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(JSON.stringify(status)).not.toContain(terminalSentinel);
      expect(JSON.stringify(status)).not.toContain(
        Buffer.from(identity.ed25519.priv).toString("base64"),
      );
      expect(JSON.stringify(relay.ctrlFromAgent)).not.toContain(realpathSync(realStateDir));
      expect(JSON.stringify(relay.ctrlFromAgent)).not.toContain(serviceInstance);

      backend.isConnected = false;
      const disconnected = LocalStatusSchema.parse(await controlRequest(p.sock, "status"));
      expect(disconnected.relayOnline).toBe(true);
      expect(disconnected.terminalReady).toBe(false);

      backend.isConnected = true;
      const reconnected = LocalStatusSchema.parse(await controlRequest(p.sock, "status"));
      expect(reconnected.terminalReady).toBe(true);
    } finally {
      await control.stop();
      agent.stop();
      await relay.stop();
    }
  });
});
